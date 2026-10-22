import type { SourceRouteFailure, SourceRouteFailureEvidence } from "@jpgr/core";

/**
 * 煤炉两条路的健康状态与提醒（2026-10-08，见 docs/进行中/煤炉兜底-交接-20261006.md 第 10 节）。
 *
 * 主路是 Vercel 东京适配服务（route `mercari_service`），备路是新加坡 VPS（`source_runner`）。
 * 状态只挂在主路上：`source_registry.cooldown_route='mercari_service'` 表示"主路出过故障、还没确认
 * 恢复"，`cooldown_until` 是这段时间内不再先试主路、直接走备路的截止时间。备路不单独冷却——它是
 * 最后一条路，冷却它等于主动放弃；两条都失败时交给档案自己的失败退避（failBinding）。
 *
 * 这里是煤炉来源级冷却的唯一写入方：failBinding / completeBinding 对煤炉不再碰 cooldown_until，
 * 否则一次备路救回来的成功就会把主路冷却清掉，下一个任务又先去撞主路。
 *
 * 三封提醒都只发管理员（ALERT_EMAIL_TO），每段故障各一封，不按档案、不按运行次数：
 * - primary_down：主路刚出故障、备路兜住了。由"把主路标成故障"的那条 UPDATE 是否真的改了行来去重，
 *   并发的多个任务里只有一个能拿到。
 * - primary_recovered：故障期间主路第一次重新成功。同样由清除状态那条 UPDATE 去重。
 * - all_down：两条路都失败。直到任意一条路再成功（source_registry.last_success_at 前进）之前只发一次。
 */

const SOURCE_ID = "mercari_jp";
const PRIMARY_ROUTE = "mercari_service";
// 403 是煤炉明确拦了这个出口，12 小时与适配器给的 retryAfter 一致；其余（超时、5xx、平台故障）
// 多半是暂时的，半小时后再让主路试一次。
const BLOCKED_COOLDOWN_MS = 12 * 60 * 60_000;
const TRANSIENT_COOLDOWN_MS = 30 * 60_000;

export type MercariRouteAlertKind = "primary_down" | "primary_recovered" | "all_down";

export interface MercariPrimaryState {
  /** 主路故障尚未确认恢复（冷却可能已到期，到期后先试一次主路）。 */
  outageOpen: boolean;
  /** 主路仍在冷却期内时，用作"本次跳过主路"的证据。 */
  coolingFailure?: SourceRouteFailureEvidence;
}

type AlertDelivery = (env: Env) => Promise<void>;
let alertDelivery: AlertDelivery | undefined;

/**
 * 入口（index.ts）在模块加载时注册投递函数。提醒要"立刻"发：写进事件表后马上投递一次，
 * 不等每小时的例行投递；任何入口（定时采集、手动搜索、单品跟踪）触发的都一样。
 */
export function registerRouteAlertDelivery(delivery: AlertDelivery): void {
  alertDelivery = delivery;
}

export async function readMercariPrimaryState(env: Env): Promise<MercariPrimaryState> {
  const row = await env.DB.prepare(
    `SELECT cooldown_until,cooldown_route,last_http_status,last_error_code,last_error_message
     FROM source_registry WHERE id=?`,
  ).bind(SOURCE_ID).first<{
    cooldown_until: string | null;
    cooldown_route: string | null;
    last_http_status: number | null;
    last_error_code: string | null;
    last_error_message: string | null;
  }>();
  if (!row || row.cooldown_route !== PRIMARY_ROUTE) return { outageOpen: false };
  if (!row.cooldown_until || Date.parse(row.cooldown_until) <= Date.now()) return { outageOpen: true };
  const lastFailure = row.last_error_message ? `；上次失败：${row.last_error_message.slice(0, 300)}` : "";
  const message = `煤炉东京主路（Vercel）冷却至 ${row.cooldown_until}，本次直接走新加坡 VPS${lastFailure}`;
  return {
    outageOpen: true,
    coolingFailure: {
      code: "source_cooldown",
      status: row.last_http_status,
      retryable: true,
      message,
      attempts: [{ attempt: 1, code: row.last_error_code ?? "source_cooldown", status: row.last_http_status, message }],
    },
  };
}

/** 主路刚失败：挂上冷却。返回 true 表示这次失败开启了一段新故障（由调用方决定发哪封提醒）。 */
export async function markMercariPrimaryFailed(env: Env, failure: SourceRouteFailureEvidence): Promise<{ opened: boolean; cooldownUntil: string }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cooldownUntil = new Date(now.getTime() + (failure.status === 403 ? BLOCKED_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS)).toISOString();
  const message = failure.message.slice(0, 500);
  const opened = await env.DB.prepare(
    `UPDATE source_registry SET cooldown_route=?,cooldown_until=?,health_status='degraded',last_failure_at=?,
     last_http_status=?,last_error_code=?,last_error_message=?,
     last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,updated_at=?
     WHERE id=? AND cooldown_route IS DISTINCT FROM ?`,
  ).bind(PRIMARY_ROUTE, cooldownUntil, nowIso, failure.status, failure.code, message,
    failure.status, nowIso, nowIso, SOURCE_ID, PRIMARY_ROUTE).run();
  if (Number(opened.meta.changes ?? 0) > 0) return { opened: true, cooldownUntil };
  // 故障已经开着（冷却到期后主路又失败了一次）：只续冷却、更新最近一次的失败原因，不再提醒。
  await env.DB.prepare(
    `UPDATE source_registry SET cooldown_until=?,last_failure_at=?,last_http_status=?,last_error_code=?,
     last_error_message=?,last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,updated_at=?
     WHERE id=? AND cooldown_route=?`,
  ).bind(cooldownUntil, nowIso, failure.status, failure.code, message,
    failure.status, nowIso, nowIso, SOURCE_ID, PRIMARY_ROUTE).run();
  return { opened: false, cooldownUntil };
}

/** 故障期间主路重新成功：清掉主路状态。返回 true 表示由这一次成功结束了故障。 */
export async function markMercariPrimaryRecovered(env: Env): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE source_registry SET cooldown_route=NULL,cooldown_until=NULL,health_status='healthy',
     last_success_at=?,request_route=?,updated_at=? WHERE id=? AND cooldown_route=?`,
  ).bind(nowIso, PRIMARY_ROUTE, nowIso, SOURCE_ID, PRIMARY_ROUTE).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function queueMercariRouteAlert(
  env: Env,
  kind: MercariRouteAlertKind,
  detail: { message: string; code: string; routeFailures?: readonly SourceRouteFailure[]; cooldownUntil?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const payload = JSON.stringify({
    sourceId: SOURCE_ID,
    profileName: "煤炉采集路线",
    routeAlert: kind,
    code: detail.code,
    message: detail.message.slice(0, 1_500),
    failures: 0,
    disabled: false,
    ...(detail.cooldownUntil ? { cooldownUntil: detail.cooldownUntil } : {}),
    ...(detail.routeFailures ? {
      routeFailures: detail.routeFailures.map(({ route, failure }) => ({
        route,
        code: failure.code,
        status: failure.status,
        message: failure.message.slice(0, 500),
      })),
    } : {}),
  });
  // 分钟粒度的 event_key：同一分钟里并发失败的任务撞到唯一索引，只留一条。
  const eventKey = `source_route:${SOURCE_ID}:${kind}:${now.slice(0, 16)}`;
  const inserted = kind === "all_down"
    ? await env.DB.prepare(
      `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
       SELECT ?,?,'source_error',?,'pending',?
       WHERE NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.event_type='source_error' AND e.event_key LIKE ?
           AND e.created_at>COALESCE((SELECT s.last_success_at FROM source_registry s WHERE s.id=?),'')
       )
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), eventKey, payload, now, `source_route:${SOURCE_ID}:all_down:%`, SOURCE_ID).run()
    : await env.DB.prepare(
      `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
       VALUES(?,?,'source_error',?,'pending',?)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), eventKey, payload, now).run();
  if (Number(inserted.meta.changes ?? 0) === 0 || !alertDelivery) return;
  try {
    await alertDelivery(env);
  } catch (error) {
    // 投递失败不能把这次采集改成失败；事件留在 pending，每小时的例行投递会再发。
    console.error(JSON.stringify({
      event: "mercari_route_alert_delivery_failed",
      kind,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
}

import type { RuntimeEnv as Env } from "./runtime-env";
