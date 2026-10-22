/**
 * 首次建档回执的图片分组（docs/研究/图片去重-实测-20261008.md）。
 *
 * 回执发出后，把清单页那批商品交给 Modal 上的 apps/image-dedup，算完把每件属于哪一组写进
 * radar_core.listing_same_groups。完整清单页 /list/<事件编号> 有分组就按图片合并、没有就同名折叠，
 * 所以这里任何一步失败都只是"晚一点 / 不按图片合并"，绝不影响回执本身——它在回执发出之后才开始，
 * 和发信不共用任何一步。每天的日报不走这里（用户 2026-10-09 定：只有首次建档回执调用）。
 *
 * 状态在 listing_group_jobs（见迁移 20261009150000）：定时任务每两分钟推进一次——
 * 先收已经交出去的结果，再给新回执建任务、提交一封。一封千件约 5～10 分钟、$0.3～0.6。
 * 重跑一封：把它的行改成 queued、attempts 归零；新结果写入前旧分组一直有效。
 */
import type { RuntimeEnv as Env } from "./runtime-env";

type GroupingEnv = Env & { IMAGE_DEDUP_URL?: string; IMAGE_DEDUP_TOKEN?: string };

/** 存量少于这个数的回执不分组：没几件，同名折叠就够了，不值得冷启动三种模型。 */
const MIN_BASELINE_ITEMS = 30;
/** 自动接手的起点：这之前的回执要分组就手工插一行 queued。 */
const AUTO_SINCE = "2026-10-09T00:00:00.000Z";
/** 只看最近几天发出的回执，免得每两分钟去解析越来越多的旧载荷。 */
const AUTO_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const MAX_ATTEMPTS = 3;
/** 交给 Modal 后超过这么久还没结果，当它丢了，按失败重试（正常一封千件 10 分钟内）。 */
const STALE_RUNNING_MS = 90 * 60_000;
/** 版本号随 grouping.py 的判定参数走，写进 listing_same_groups.method。 */
const METHOD = "image_v3";
/**
 * 骏河屋的图从 Modal（美国机房）和 VPS（新加坡）下都是 403，Cloudflare 出口能下（现有采集就走这条），
 * 所以在这里下好、随请求带过去。其他平台 Modal 自己下（2026-10-09 实测全部 200）。
 */
const FETCH_HERE_SOURCES = new Set(["surugaya"]);
const FETCH_HERE_LIMIT = 300;
const SURUGAYA_USER_AGENT = "JP-Goods-Radar/1.0 (+personal low-frequency monitor)";

interface GroupingItem {
  url: string;
  imageUrl: string | null;
  title: string;
  sourceId: string;
  bundle: boolean;
}

/** 与清单页取同一批：有建档存量时只取存量（清单页只放这些）。 */
export function listingItemsForGrouping(payloadJson: string): GroupingItem[] {
  const payload = JSON.parse(payloadJson) as { items?: unknown };
  const raw = Array.isArray(payload.items) ? payload.items.map((value) => (value ?? {}) as Record<string, unknown>) : [];
  const hasBaseline = raw.some((item) => item.category === "baseline");
  const seen = new Set<string>();
  const items: GroupingItem[] = [];
  for (const item of raw) {
    if (hasBaseline && item.category !== "baseline") continue;
    if (typeof item.url !== "string" || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const enrichment = (item.enrichment ?? {}) as Record<string, unknown>;
    items.push({
      url: item.url,
      imageUrl: typeof item.imageUrl === "string" && item.imageUrl ? item.imageUrl : null,
      title: typeof item.title === "string" ? item.title : "",
      sourceId: typeof item.sourceId === "string" ? item.sourceId : "",
      bundle: enrichment.is_bundle === true,
    });
  }
  return items;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchImagesHere(items: readonly GroupingItem[]): Promise<Record<string, string>> {
  const targets = items.filter((item) => item.imageUrl && FETCH_HERE_SOURCES.has(item.sourceId)).slice(0, FETCH_HERE_LIMIT);
  const images: Record<string, string> = {};
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const item = targets[next++]!;
      try {
        const response = await fetch(item.imageUrl!, {
          headers: { "User-Agent": SURUGAYA_USER_AGENT },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) {
          await response.body?.cancel();
          continue;
        }
        images[item.url] = base64(new Uint8Array(await response.arrayBuffer()));
      } catch {
        // 下不到就不带，Modal 那边记成没图、这一件单独一张卡
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return images;
}

async function callService(env: GroupingEnv, path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, env.IMAGE_DEDUP_URL), {
    ...init,
    headers: { Authorization: `Bearer ${env.IMAGE_DEDUP_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
}

async function markFailed(env: Env, eventId: string, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE listing_group_jobs SET status='failed', error=?, updated_at=now() WHERE event_id=? AND status='running'",
  ).bind(error.slice(0, 500), eventId).run();
  console.error(JSON.stringify({ event: "listing_grouping_failed", eventId, error: error.slice(0, 300) }));
}

/** 收已经交给 Modal 的结果。 */
async function collectResults(env: GroupingEnv): Promise<void> {
  const running = await env.DB.prepare(
    "SELECT event_id,call_id,started_at FROM listing_group_jobs WHERE status='running' ORDER BY started_at LIMIT 3",
  ).all<{ event_id: string; call_id: string | null; started_at: string | null }>();
  for (const job of running.results) {
    const age = Date.now() - Date.parse(job.started_at ?? "");
    if (!job.call_id) {
      // 提交那一步中途被打断：过 5 分钟还没有 call_id 就当没交出去
      if (!(age < 5 * 60_000)) await markFailed(env, job.event_id, "submit_lost");
      continue;
    }
    const response = await callService(env, `result/${encodeURIComponent(job.call_id)}`);
    if (response.status === 202) {
      await response.body?.cancel();
      if (age > STALE_RUNNING_MS) await markFailed(env, job.event_id, "timeout");
      continue;
    }
    if (!response.ok) {
      // 接口本身出错（部署中、限流）：这一跳先不动，下一跳再问
      await response.body?.cancel();
      continue;
    }
    const body = await response.json() as {
      status: string;
      error?: string;
      groups?: { url: string; group: string }[];
      stats?: unknown;
    };
    if (body.status !== "done" || !body.groups?.length) {
      await markFailed(env, job.event_id, body.error ?? `unexpected_${body.status}`);
      continue;
    }
    const finishedAt = new Date().toISOString();
    // 删旧 + 写新 + 记完成在一个事务里：清单页要么看到整套旧分组，要么看到整套新分组。
    await env.DB.batch([
      env.DB.prepare("DELETE FROM listing_same_groups WHERE event_id=?").bind(job.event_id),
      env.DB.prepare(
        `INSERT INTO listing_same_groups(event_id,item_url,group_key,method)
         SELECT ?::text, g->>'url', g->>'group', ?::text FROM jsonb_array_elements(?::jsonb) g
         ON CONFLICT DO NOTHING`,
      ).bind(job.event_id, METHOD, JSON.stringify(body.groups)),
      env.DB.prepare(
        `UPDATE listing_group_jobs SET status='done', error=NULL, stats_json=?, finished_at=?, updated_at=now()
         WHERE event_id=? AND status='running'`,
      ).bind(JSON.stringify(body.stats ?? null), finishedAt, job.event_id),
    ]);
    console.log(JSON.stringify({ event: "listing_grouping_done", eventId: job.event_id, stats: body.stats }));
  }
}

/** 给新发出的回执建任务，再提交一封（每跳最多一封，回执本来就少）。 */
async function submitNext(env: GroupingEnv): Promise<void> {
  const since = new Date(Math.max(Date.parse(AUTO_SINCE), Date.now() - AUTO_LOOKBACK_MS)).toISOString();
  const fresh = await env.DB.prepare(
    `SELECT e.id FROM events e
     WHERE e.event_type='daily_digest' AND e.status='sent' AND e.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM listing_group_jobs j WHERE j.event_id=e.id)
       AND COALESCE((e.payload_json::jsonb->>'baselineTotal')::int, 0) >= ?
     ORDER BY e.created_at LIMIT 5`,
  ).bind(since, MIN_BASELINE_ITEMS).all<{ id: string }>();
  for (const event of fresh.results) {
    await env.DB.prepare(
      "INSERT INTO listing_group_jobs(event_id,status) VALUES(?,'queued') ON CONFLICT (event_id) DO NOTHING",
    ).bind(event.id).run();
  }
  // 失败的隔 15 分钟再交，最多 MAX_ATTEMPTS 次
  const next = await env.DB.prepare(
    `SELECT event_id FROM listing_group_jobs
     WHERE status='queued' OR (status='failed' AND attempts < ? AND updated_at < now() - interval '15 minutes')
     ORDER BY updated_at LIMIT 1`,
  ).bind(MAX_ATTEMPTS).first<{ event_id: string }>();
  if (!next) return;
  // 先占位再提交：重叠的两跳只有一跳能把它改成 running
  const claim = await env.DB.prepare(
    `UPDATE listing_group_jobs SET status='running', attempts=attempts+1, call_id=NULL, error=NULL, started_at=?, updated_at=now()
     WHERE event_id=? AND (status='queued' OR (status='failed' AND attempts < ?))`,
  ).bind(new Date().toISOString(), next.event_id, MAX_ATTEMPTS).run();
  if ((claim.meta?.changes ?? 0) !== 1) return;
  try {
    const event = await env.DB.prepare("SELECT payload_json FROM events WHERE id=?")
      .bind(next.event_id).first<{ payload_json: string }>();
    const items = event ? listingItemsForGrouping(event.payload_json) : [];
    if (items.length < 2) {
      await markFailed(env, next.event_id, "no_items");
      return;
    }
    const images = await fetchImagesHere(items);
    const response = await callService(env, "start", { method: "POST", body: JSON.stringify({ items, images }) });
    if (!response.ok) throw new Error(`start_http_${response.status}: ${(await response.text()).slice(0, 200)}`);
    const { callId } = await response.json() as { callId?: string };
    if (!callId) throw new Error("start_without_call_id");
    await env.DB.prepare("UPDATE listing_group_jobs SET call_id=?, updated_at=now() WHERE event_id=? AND status='running'")
      .bind(callId, next.event_id).run();
    console.log(JSON.stringify({
      event: "listing_grouping_submitted",
      eventId: next.event_id,
      items: items.length,
      imagesFetchedHere: Object.keys(images).length,
    }));
  } catch (error) {
    await markFailed(env, next.event_id, error instanceof Error ? error.message : "submit_failed");
  }
}

/** 花钱的开关（runtime_feature_flags，迁移 20261009190000 插成关着）。打开 / 关掉见 docs/成本/成本账本.md §5。 */
export const LISTING_IMAGE_GROUPING_FLAG = "listing_image_grouping_v1";

export async function advanceListingGrouping(env: Env): Promise<void> {
  const groupingEnv = env as GroupingEnv;
  if (!groupingEnv.IMAGE_DEDUP_URL || !groupingEnv.IMAGE_DEDUP_TOKEN) return;
  // 开关关着：不建任务、不收结果、不调 Modal，$0，清单页照旧同名折叠。打开后只自动接手最近 3 天内
  // 发出的回执（AUTO_LOOKBACK_MS），更早的要分组就照文件头的说明手工插一行 queued。
  const flag = await env.DB.prepare("SELECT enabled FROM runtime_feature_flags WHERE flag_key=?")
    .bind(LISTING_IMAGE_GROUPING_FLAG).first<{ enabled: number }>();
  if (Number(flag?.enabled ?? 0) !== 1) return;
  await collectResults(groupingEnv);
  await submitNext(groupingEnv);
}
