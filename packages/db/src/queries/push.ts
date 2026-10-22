/**
 * 飞书 / App 推送这个渠道在通知登记簿（notice_deliveries，channel='feishu'）里的取件，
 * 以及「档案决定发到哪」的收尾：飞书没送到补邮件、送到了记成已发出、两个开关都关的作废。
 * 认领、发完、失败、记结果这几步和邮件共用（delivery.ts 的 *Notice 方法）；发送循环在
 * apps/collector/src/notice-delivery.ts，飞书卡片在 apps/collector/src/push-delivery.ts。
 *
 * 每个档案两个开关（watch_profiles.notify_email / notify_feishu，2026-10-14 起）：
 * - 开了飞书的档案，能发飞书的通知（关键词日报、精确同款上新、降价等商品变化）都推给推送服务；
 * - 只开飞书的，邮件不发（delivery.ts 的邮件取件按开关挑）；飞书没送到时 fallBackToEmail 补一行邮件，带原因；
 * - 两个都关的，通知直接作废（只巡回、不通知）。
 *
 * status='sent' 只说明推送服务收下了。飞书到底发没发出去，推送服务事后回报，记在 outcome。
 */
import { NOTICE_MAX_ATTEMPTS, NOTICE_MAX_EVENT_AGE_MS, NOTICE_SENDING_STALE_MS } from "../notice-policy";
import { DeliveryRepository } from "./delivery";

/** 推送服务收下这么久还没回报飞书结果，就当没送到。正常最多等 6 分钟凑一张卡，再加一分钟的查询间隔。 */
const FEISHU_OUTCOME_TIMEOUT_MS = 20 * 60 * 1_000;
/** 只开飞书的通知生成这么久，飞书还没收下（没推、卡住、推送服务一直拒收），就补发邮件。推送每分钟跑一次。 */
const FEISHU_PICKUP_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * 还没推过的通知只推这么近的：档案刚打开飞书时，不把它过去发过邮件的通知一股脑推到群里。
 * 只开飞书的通知超过 30 分钟没推出去就已经补了邮件（见上），所以 2 小时够用。
 */
const FEISHU_FRESH_WINDOW_MS = 2 * 60 * 60 * 1_000;
/** 推送服务连续拒收这么多次就不等重试了，直接补邮件（重试间隔 1 分钟、5 分钟）。 */
const FEISHU_FAILURES_BEFORE_EMAIL = 2;

/*
 * 下面几条 SQL 里反复出现的四段，改一处要把每条都改到（为了让 pnpm verify:sql 能预编译，SQL 只能整段写死，不能拼接）：
 * - 档案：COALESCE(e.watch_profile_id,b.watch_profile_id,日报载荷里的 profileId)。早期的关键词 / 精确同款日报只在载荷里写了档案。
 * - 能发飞书的：关键词日报（keyword_scan_summary / keyword_new_listing）、精确同款上新（exact_product_new_listing）、
 *   带商品的 price_drop / price_rise / target_price / restock / sold_out。推送服务按 kind 排版（collector 的 pushMessageFor）。
 *   delivery.ts 的邮件取件里也有这一段（只开飞书时，飞书发不了的照发邮件）。
 * - 档案开关管得着的：除了 source_error / weekly_market_digest / morning_digest / new_listing 以外的。来源故障、周报不属于单个档案，
 *   关键词逐件上新、早报本来就不单独发；这些照旧走邮件，两个开关都关也不动它们。
 * - 没被判掉的：和邮件队列同一条 watch_dismissed_candidates 条件。
 */

export interface PendingPushRow {
  event_id: string;
  event_key: string;
  event_created_at: string;
  /** 语义类型：daily_digest，或 price_drop / price_rise / target_price / restock / sold_out。 */
  event_type: string;
  profile_id: string;
  profile_name: string;
  payload_json: string;
  /** 商品变化通知才有（日报的商品在载荷里）。 */
  source_id: string | null;
  source_item_id: string | null;
  title: string | null;
  canonical_url: string | null;
  image_url: string | null;
  current_price: number | string | null;
  price_basis: string | null;
}

export interface KeywordRoundFactsRow {
  profile_name: string | null;
  next_run_at: string | null;
  new_items: number | string;
}

export interface ReturnedToEmail {
  eventId: string;
  /** 写进邮件开头的那句原因。 */
  reason: string;
}

export abstract class PushRepository extends DeliveryRepository {
  /**
   * 该推飞书的：开了飞书的档案里、能发飞书的那几种。没推过的只取 2 小时内的（FEISHU_FRESH_WINDOW_MS）；
   * 已经因为飞书没送到补了邮件的不再推，免得两边都发。
   */
  async pendingFeishuNotices(enabledAt: string, limit: number): Promise<PendingPushRow[]> {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - NOTICE_SENDING_STALE_MS).toISOString();
    const expiredBefore = new Date(Date.now() - NOTICE_MAX_EVENT_AGE_MS).toISOString();
    const result = await this.db.prepare(
      `SELECT e.id event_id,e.event_key,e.created_at event_created_at,
       COALESCE(e.semantic_event_type,e.event_type) event_type,p.id profile_id,p.name profile_name,e.payload_json,
       l.source_id,l.source_item_id,l.title,l.canonical_url,l.image_url,l.current_price,l.price_basis
       FROM events e
       LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN listings l ON l.id=e.listing_id
       JOIN watch_profiles p ON p.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
       LEFT JOIN notice_deliveries d ON d.event_id=e.id AND d.channel='feishu'
       WHERE e.created_at>=?
       AND e.created_at>=?
       AND e.status<>'suppressed'
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND p.notify_feishu=1
       AND (
  (CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'kind' END)
    IN ('keyword_scan_summary','keyword_new_listing','exact_product_new_listing')
  OR (e.event_type<>'daily_digest' AND e.listing_id IS NOT NULL
    AND COALESCE(e.semantic_event_type,e.event_type) IN ('price_drop','price_rise','target_price','restock','sold_out'))
)
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
  WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
    AND x.source_item_id=l.source_item_id
    AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND NOT EXISTS (SELECT 1 FROM notice_deliveries m
         WHERE m.event_id=e.id AND m.channel='email' AND m.fallback_reason IS NOT NULL)
       AND COALESCE(d.attempts,0)<?
       AND (
         (d.id IS NULL AND e.created_at>=?)
         OR (d.status IN ('pending','failed') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?))
         OR (d.status='sending' AND d.updated_at<=?)
       )
       ORDER BY e.created_at ASC LIMIT ?`,
    ).bind(
      enabledAt, expiredBefore, now, NOTICE_MAX_ATTEMPTS.feishu,
      new Date(Date.now() - FEISHU_FRESH_WINDOW_MS).toISOString(), now, staleBefore, limit,
    )
      .all<PendingPushRow>();
    return result.results;
  }

  /**
   * 两个开关都关的档案（只巡回、不通知）：它的通知直接作废，不发邮件也不推。
   * 只动档案开关管得着的那几种（见文件头）；来源故障、周报照发。
   */
  async suppressSilencedDossierNotices(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `UPDATE events SET status='suppressed',email_suppressed_at=COALESCE(email_suppressed_at,?)
       WHERE status IN ('pending','failed')
       AND id IN (
         SELECT e.id FROM events e
         LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
         JOIN watch_profiles p ON p.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
         WHERE e.status IN ('pending','failed')
         AND p.notify_email=0 AND p.notify_feishu=0
         AND COALESCE(e.semantic_event_type,e.event_type) NOT IN ('source_error','weekly_market_digest','morning_digest','new_listing')
       )`,
    ).bind(now).run();
    return Number(result.meta.changes ?? 0);
  }

  /**
   * 只开飞书的档案、飞书没送到的：补一行邮件（fallback_reason 写原因，邮件开头照登）。满足任一条就补：
   * - 推送总闸（owner_push_v1.enabled）关了（pushEnabled=false）；
   * - 飞书那一行放弃了（次数用完），或推送服务连续拒收 FEISHU_FAILURES_BEFORE_EMAIL 次；
   * - 推送服务回报飞书一个群、私聊都没收到（outcome='failed'）；
   * - 推送服务收下 FEISHU_OUTCOME_TIMEOUT_MS 还没回报结果；
   * - 通知生成 FEISHU_PICKUP_TIMEOUT_MS 了，推送服务还没收下（没推、卡住，或者这份根本不在飞书取件范围里）。
   *
   * 补了邮件的，飞书那一行记成 abandoned（returned_to_email），不再推；邮件那一行每份通知只有一行，
   * 所以每份最多补一次。正在推的（sending 且没超时）、已送到的、没东西可推的不动。只看 3 天内的。
   */
  async fallBackToEmail(pushEnabled: boolean): Promise<ReturnedToEmail[]> {
    const now = Date.now();
    const candidates = await this.db.prepare(
      `SELECT e.id event_id,d.id delivery_id,d.status,d.attempts,d.last_error,d.outcome_error
       FROM events e
       LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN listings l ON l.id=e.listing_id
       JOIN watch_profiles p ON p.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
       LEFT JOIN notice_deliveries d ON d.event_id=e.id AND d.channel='feishu'
       WHERE e.status IN ('pending','failed')
       AND e.email_suppressed_at IS NULL
       AND e.created_at>=?
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND p.notify_feishu=1 AND p.notify_email=0
       AND (
  (CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'kind' END)
    IN ('keyword_scan_summary','keyword_new_listing','exact_product_new_listing')
  OR (e.event_type<>'daily_digest' AND e.listing_id IS NOT NULL
    AND COALESCE(e.semantic_event_type,e.event_type) IN ('price_drop','price_rise','target_price','restock','sold_out'))
)
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
  WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
    AND x.source_item_id=l.source_item_id
    AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND NOT EXISTS (SELECT 1 FROM notice_deliveries m WHERE m.event_id=e.id AND m.channel='email')
       AND (d.id IS NULL OR NOT (d.status='sending' AND d.updated_at>?))
       AND (d.id IS NULL OR NOT (d.status='sent' AND d.outcome='delivered'))
       AND (d.id IS NULL OR d.status<>'skipped')
       AND (
         ?::bigint=0
         OR d.status='abandoned'
         OR (d.status='failed' AND d.attempts>=?)
         OR (d.status='sent' AND d.outcome='failed')
         OR (d.status='sent' AND d.outcome IS NULL AND d.sent_at<=?)
         OR (COALESCE(d.status,'')<>'sent' AND COALESCE(e.delivery_not_before,e.created_at)<=?)
       )
       ORDER BY e.created_at ASC LIMIT 50`,
    ).bind(
      new Date(now - NOTICE_MAX_EVENT_AGE_MS).toISOString(),
      new Date(now).toISOString(),
      new Date(now - NOTICE_SENDING_STALE_MS).toISOString(),
      pushEnabled ? 1 : 0,
      FEISHU_FAILURES_BEFORE_EMAIL,
      new Date(now - FEISHU_OUTCOME_TIMEOUT_MS).toISOString(),
      new Date(now - FEISHU_PICKUP_TIMEOUT_MS).toISOString(),
    ).all<{
      event_id: string;
      delivery_id: string | null;
      status: string | null;
      attempts: number | string | null;
      last_error: string | null;
      outcome_error: string | null;
    }>();
    if (candidates.results.length === 0) return [];
    const returned = candidates.results.map((row): ReturnedToEmail & { deliveryId: string | null } => {
      let reason: string;
      if (!pushEnabled) reason = "飞书推送整体关着";
      else if (row.status === "sent" && row.outcome_error) reason = row.outcome_error;
      else if (row.status === "sent") reason = "推送服务 20 分钟没回报飞书发没发出去";
      else if (row.status === "failed" || row.status === "abandoned") {
        reason = `推送服务没接收${row.last_error ? `（${row.last_error.slice(0, 120)}）` : ""}`;
      } else reason = "推送服务半小时没接手";
      return { eventId: row.event_id, deliveryId: row.delivery_id, reason };
    });
    const stamp = new Date(now).toISOString();
    await this.db.batch(returned.flatMap((row) => [
      this.db.prepare(
        `INSERT INTO notice_deliveries(id,event_id,channel,status,attempts,fallback_reason,created_at,updated_at)
         VALUES(?,?,'email','pending',0,?,?,?)
         ON CONFLICT (event_id,channel) DO NOTHING`,
      ).bind(crypto.randomUUID(), row.eventId, row.reason.slice(0, 300), stamp, stamp),
      ...(row.deliveryId ? [this.db.prepare(
        `UPDATE notice_deliveries
         SET status='abandoned',last_error='returned_to_email',outcome_error=COALESCE(outcome_error,?),next_attempt_at=NULL,updated_at=?
         WHERE id=? AND status<>'skipped'`,
      ).bind(row.reason.slice(0, 300), stamp, row.deliveryId)] : []),
    ]));
    return returned.map(({ eventId, reason }) => ({ eventId, reason }));
  }

  /**
   * 只开飞书的档案、飞书送到了（或没有可推的新货）：通知记成已发出。日报标注（web 的 digest-labels、
   * App 的标注页）按 events.status='sent' 认；不改的话邮件一停，这些就都没东西了。
   * 开了邮件的档案由邮件发完时自己改（delivery.ts 的 finishNotice），这里不碰，免得邮件还没发就被当成发完了。
   */
  async settleFeishuOnlyNotices(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `UPDATE events e SET status='sent',sent_at=COALESCE(e.sent_at,?)
       FROM notice_deliveries d
       WHERE d.event_id=e.id AND d.channel='feishu'
       AND ((d.status='sent' AND d.outcome='delivered') OR d.status='skipped')
       AND e.status IN ('pending','failed')
       AND NOT EXISTS (SELECT 1 FROM notice_deliveries m
         WHERE m.event_id=e.id AND m.channel='email' AND m.status IN ('pending','sending','failed'))
       AND EXISTS (SELECT 1 FROM watch_profiles p WHERE p.notify_email=0 AND p.id=COALESCE(e.watch_profile_id,
         (SELECT b.watch_profile_id FROM watch_bindings b WHERE b.id=e.watch_binding_id),
         CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END))`,
    ).bind(now).run();
    return Number(result.meta.changes ?? 0);
  }

  /**
   * 一轮巡回跑完后报给手机的几个数：档案名、这一轮的新货件数（日报里非建档存量的条目；
   * 没出日报就是 0）、这个档案下一次开跑的时间（所有启用绑定里最早的、晚于 now 的那个）。
   * 只报开了飞书的档案（没开的返回 null）。
   */
  async keywordRoundFacts(profileId: string, digestEventId: string | null, now: string): Promise<KeywordRoundFactsRow | null> {
    return this.db.prepare(
      `SELECT p.name profile_name,
       (SELECT MIN(b.next_run_at) FROM watch_bindings b
        WHERE b.watch_profile_id=p.id AND b.enabled=1 AND b.next_run_at>?) next_run_at,
       (SELECT count(*) FROM events e, jsonb_array_elements(e.payload_json::jsonb->'items') it
        WHERE e.id=? AND COALESCE(it->>'category','')<>'baseline') new_items
       FROM watch_profiles p WHERE p.id=? AND p.notify_feishu=1`,
    ).bind(now, digestEventId, profileId).first<KeywordRoundFactsRow>();
  }
}
