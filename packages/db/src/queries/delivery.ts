/**
 * 投递：通知登记簿（radar_core.notice_deliveries）。
 *
 * 一份通知在每个渠道（邮件 / 飞书 / 微信）一行。认领、发完、失败、放弃、记结果这几步所有渠道共用
 * （下面的 *Notice 方法）；各渠道只有「哪些通知该我发」那条取件 SQL 不一样：邮件的和微信的在本文件，
 * 飞书的在 push.ts。发送循环在 apps/collector/src/notice-delivery.ts。
 */
/**
 * 本文件是 `RadarRepository` 的一部分。
 *
 * 拆分方式：各组按继承链串起来（见 `packages/db/src/repository.ts` 顶部说明），
 * 因此方法体与原文件逐字相同，`this.db` 与跨方法调用都照旧可用。
 * 新增方法时若要调用别组的方法，那一组必须排在本组**之前**，否则 typecheck 会报错。
 */
import type { Availability, EventCandidate, ListingState, MonitorEventType, NormalizedListing, SourceId, StrongReminderPolicy } from "@jpgr/core";
import {
  buildLandedCostEstimate,
  advanceItemSchedule,
  adaptiveItemScheduleEnabled,
  itemScheduleConfig,
  itemSchedulePolicy,
  itemScheduleDelayMinutes,
  effectiveItemIntervalMinutes,
  buildProductLifecycleIntelligence,
  canonicalMonitorEventType,
  evaluateProbeWindow,
  extractLandedCostListingFacts,
  isOneOffListingSource,
  landedCostMeetsTarget,
  landedCostThresholdPolicy,
  PROBE_WINDOW_MS,
  stableStateHash,
  strongReminderDeliveryTimes,
} from "@jpgr/core";
import type {
  ConfirmationListingRow,
  CostProfileRow,
  DashboardSummary,
  ExistingListingRow,
  HermesDeliveryClaim,
  MonitorEventInsertDecision,
  MonitorRuleRow,
  MonitorRuleLandedCostTargetRow,
  P0QualificationRunRow,
  PendingEmailRow,
  WeeklyExactReport,
  ProbeWindowRow,
  StoredListingDetail,
  VerificationCheckRow,
  TrackedListingRow,
  WatchBindingRow,
  WatchRunResult,
} from "../types";
import { costProfileFromRow } from "../cost-profiles";
import type {
  OperationalDatabase,
  OperationalPreparedStatement,
  OperationalResult,
} from "../database";
import {
  metadataRecord,
  stringValue,
  JAPAN_OFFSET_MS,
  MAX_KEYWORD_DIGEST_SUSPECTS,
  SQL_ID_CHUNK_SIZE,
  TOKYO_OFFSET_MS,
  HERMES_SENDING_STALE_MS,
  HERMES_MAX_ATTEMPTS,
  HERMES_MAX_EVENT_AGE_MS,
  MAX_DESCRIPTION_EXCERPT_CHARACTERS,
  boundedDescriptionExcerpt,
  storedEventType,
  chunks,
  interleaveBySource,
  discoveryKindOf,
  parsedStringArray,
  parsedObject,
  minuteOfDay,
  quietHoursNotBefore,
  listingCompleteness,
  DAILY_COUNTER_COLUMNS,
  VOLATILE_DISPLAY_FACT_KEYS,
  contentHashFacts,
  japanDayStart,
  japanDayKey,
  japanDay,
  monitorRuleScopeUsable,
  monitorRuleAcceptsSource,
  isPriceTargetTrigger,
  keywordBaselineResetStatements,
} from "./shared";
import type {
  MonitorListingRow,
  MonitorLandedCostContext,
} from "./shared";
import { DigestRepository } from "./digests";
import type { NoticeAwaitingOutcomeRow, NoticeChannel, NoticeClaim } from "../types";
import { NOTICE_MAX_ATTEMPTS, NOTICE_MAX_EVENT_AGE_MS, NOTICE_SENDING_STALE_MS } from "../notice-policy";

/*
 * 邮件取件（pendingEmails / pendingEmailCount）和超量汇总（digests.ts 的 prepareDailyDigest）里反复出现的「档案要不要邮件」：
 * 还没有邮件那一行的通知，满足任一条就该发邮件——
 *   不属于任何档案；或者是档案开关管不着的那几种（来源故障、周报、早报、逐件上新）；或者档案开了邮件；
 *   或者档案只开了飞书、但这种通知飞书没有卡片（建档回执、单品盯完了……）。
 * 只开飞书、飞书能发的，等飞书没送到时由 push.ts 的 fallBackToEmail 补一行邮件（带原因）；两个都关的作废。
 * 改一处要把每条都改到（为了让 pnpm verify:sql 能预编译，SQL 只能整段写死，不能拼接）。
 */

export abstract class DeliveryRepository extends DigestRepository {
  async emailsSentToday(): Promise<number> {
    const row = await this.db.prepare("SELECT emails_sent FROM daily_counters WHERE day_utc = ?")
      .bind(japanDayKey()).first<{ emails_sent: number }>();
    return row?.emails_sent ?? 0;
  }

  /** 该发邮件的通知：还没有邮件那一行且档案要邮件的（见上面），加上邮件那一行到点重试的。 */
  async pendingEmails(limit: number): Promise<PendingEmailRow[]> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `SELECT e.id event_id,e.event_key,COALESCE(e.semantic_event_type,e.event_type) event_type,
       e.created_at event_created_at,e.payload_json,
       COALESCE(l.source_id,b.source_id) source_id,l.source_item_id,l.identity_scope,l.canonical_url,l.title,l.description_excerpt,l.image_url,
       l.seller_name,l.shop_name,l.currency,l.current_price,l.original_price,l.price_basis,l.item_condition,l.availability,
       COALESCE(b.enabled,1) binding_enabled,COALESCE(p.enabled,1) profile_enabled,
       d.fallback_reason
       FROM events e LEFT JOIN listings l ON l.id=e.listing_id LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN watch_profiles p ON p.id=e.watch_profile_id
       LEFT JOIN watch_profiles rp ON rp.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
       LEFT JOIN notice_deliveries d ON d.event_id=e.id AND d.channel='email'
       WHERE e.status IN ('pending','failed')
       AND COALESCE(e.semantic_event_type,e.event_type) <> 'morning_digest'
       AND e.email_suppressed_at IS NULL
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND (e.event_type <> 'new_listing' OR COALESCE(b.monitoring_purpose,'') <> 'keyword_new_listing')
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
        WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
          AND x.source_item_id=l.source_item_id
          AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND COALESCE(d.attempts,0)<?
       AND (
         (d.id IS NULL AND (
  rp.id IS NULL
  OR COALESCE(e.semantic_event_type,e.event_type) IN ('source_error','weekly_market_digest','morning_digest','new_listing')
  OR rp.notify_email=1
  OR (rp.notify_feishu=1 AND NOT COALESCE(
    (CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'kind' END)
      IN ('keyword_scan_summary','keyword_new_listing','exact_product_new_listing')
    OR (e.event_type<>'daily_digest' AND e.listing_id IS NOT NULL
      AND COALESCE(e.semantic_event_type,e.event_type) IN ('price_drop','price_rise','target_price','restock','sold_out')),
    false))
))
         OR (d.status IN ('pending','failed') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?))
         OR (d.status='sending' AND d.updated_at<=?)
       )
       ORDER BY CASE COALESCE(e.semantic_event_type,e.event_type)
         WHEN 'target_price' THEN 0
         WHEN 'price_drop' THEN 1
         WHEN 'price_rise' THEN 2
         WHEN 'restock' THEN 3
         WHEN 'source_error' THEN 4
         WHEN 'sold_out' THEN 5
         ELSE 6 END,
         e.created_at ASC LIMIT ?`,
    ).bind(
      now, NOTICE_MAX_ATTEMPTS.email, now,
      new Date(Date.now() - NOTICE_SENDING_STALE_MS).toISOString(), limit,
    ).all<PendingEmailRow>();
    return result.results;
  }

  async getConfirmationListing(id: string): Promise<ConfirmationListingRow | null> {
    return this.db.prepare(
      "SELECT id,source_id,source_item_id,current_price,availability,description_excerpt,state_hash,content_hash FROM listings WHERE id=?",
    ).bind(id).first<ConfirmationListingRow>();
  }

  /** 和 pendingEmails 同一个条件，只数个数（超量时决定要不要合成汇总）。 */
  async pendingEmailCount(): Promise<number> {
    const now = new Date().toISOString();
    const row = await this.db.prepare(
      `SELECT COUNT(*) count FROM events e LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN listings l ON l.id=e.listing_id
       LEFT JOIN watch_profiles rp ON rp.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
       LEFT JOIN notice_deliveries d ON d.event_id=e.id AND d.channel='email'
       WHERE e.status IN ('pending','failed')
       AND COALESCE(e.semantic_event_type,e.event_type) <> 'morning_digest'
       AND e.email_suppressed_at IS NULL
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND (e.event_type <> 'new_listing' OR COALESCE(b.monitoring_purpose,'') <> 'keyword_new_listing')
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
        WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
          AND x.source_item_id=l.source_item_id
          AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND COALESCE(d.attempts,0)<?
       AND (
         (d.id IS NULL AND (
  rp.id IS NULL
  OR COALESCE(e.semantic_event_type,e.event_type) IN ('source_error','weekly_market_digest','morning_digest','new_listing')
  OR rp.notify_email=1
  OR (rp.notify_feishu=1 AND NOT COALESCE(
    (CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'kind' END)
      IN ('keyword_scan_summary','keyword_new_listing','exact_product_new_listing')
    OR (e.event_type<>'daily_digest' AND e.listing_id IS NOT NULL
      AND COALESCE(e.semantic_event_type,e.event_type) IN ('price_drop','price_rise','target_price','restock','sold_out')),
    false))
))
         OR (d.status IN ('pending','failed') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?))
         OR (d.status='sending' AND d.updated_at<=?)
       )`,
    ).bind(
      now, NOTICE_MAX_ATTEMPTS.email, now, new Date(Date.now() - NOTICE_SENDING_STALE_MS).toISOString(),
    ).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  /**
   * 渠道第一次启用的时间（notification_channels）。飞书、微信只投这之后生成的通知，
   * 免得一开通就把陈年通知全推一遍。channelKey 沿用表里已有的名字：owner_push（飞书）、hermes_weixin（微信）。
   */
  async ensureNoticeChannelEnabledAt(channelKey: string, enabledAt: string): Promise<string> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO notification_channels(channel,enabled_at,created_at,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT DO NOTHING`,
    ).bind(channelKey, enabledAt, now, now).run();
    const channel = await this.db.prepare(
      "SELECT enabled_at FROM notification_channels WHERE channel=?",
    ).bind(channelKey).first<{ enabled_at: string }>();
    if (!channel) throw new Error(`通知渠道 ${channelKey} 的启用时间保存失败`);
    return channel.enabled_at;
  }

  /**
   * 认领这份通知在这个渠道的那一行：没有就新建，有就只认到点重试的、或卡在 sending 太久的。
   * 已作废的通知（events.status='suppressed'）不认领。认领不到返回 null（别人在发、已发完、已放弃）。
   */
  async claimNotice(channel: NoticeChannel, eventId: string): Promise<NoticeClaim | null> {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - NOTICE_SENDING_STALE_MS).toISOString();
    const inserted = await this.db.prepare(
      `INSERT INTO notice_deliveries(id,event_id,channel,status,attempts,created_at,updated_at)
       SELECT ?,e.id,?,'sending',1,?,? FROM events e
       WHERE e.id=? AND e.status<>'suppressed'
       ON CONFLICT (event_id,channel) DO NOTHING`,
    ).bind(crypto.randomUUID(), channel, now, now, eventId).run();
    if (!inserted.meta.changes) {
      const claimed = await this.db.prepare(
        `UPDATE notice_deliveries
         SET status='sending',attempts=attempts+1,last_http_status=NULL,last_error=NULL,
             next_attempt_at=NULL,updated_at=?
         WHERE event_id=? AND channel=?
           AND EXISTS(SELECT 1 FROM events e WHERE e.id=notice_deliveries.event_id AND e.status<>'suppressed')
           AND (
             (status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
             OR (status='sending' AND updated_at<=?)
           )`,
      ).bind(now, eventId, channel, now, staleBefore).run();
      if (!claimed.meta.changes) return null;
    }
    const delivery = await this.db.prepare(
      "SELECT id,attempts FROM notice_deliveries WHERE event_id=? AND channel=?",
    ).bind(eventId, channel).first<{ id: string; attempts: number | string }>();
    return delivery ? { id: delivery.id, attempts: Number(delivery.attempts) } : null;
  }

  /**
   * 渠道收下了。confirmed=true 表示收下即到（邮件、微信）；false 表示到没到要等渠道事后回报（飞书，见 recordNoticeOutcome）。
   * eventFollows=true 时通知本身也记成已发出（邮件：事件台、日报标注都按 events.status='sent' 认）。
   */
  async finishNotice(
    claim: NoticeClaim,
    input: { eventId: string; remoteId: string | null; httpStatus: number | null; confirmed: boolean; eventFollows: boolean },
  ): Promise<void> {
    const now = new Date().toISOString();
    const finish = input.confirmed
      ? this.db.prepare(
        `UPDATE notice_deliveries
         SET status='sent',remote_id=?,last_http_status=?,last_error=NULL,next_attempt_at=NULL,
             outcome='delivered',outcome_at=?,sent_at=?,updated_at=?
         WHERE id=? AND status='sending' AND attempts=?`,
      ).bind(input.remoteId, input.httpStatus, now, now, now, claim.id, claim.attempts)
      : this.db.prepare(
        `UPDATE notice_deliveries
         SET status='sent',remote_id=?,last_http_status=?,last_error=NULL,next_attempt_at=NULL,sent_at=?,updated_at=?
         WHERE id=? AND status='sending' AND attempts=?`,
      ).bind(input.remoteId, input.httpStatus, now, now, claim.id, claim.attempts);
    await this.db.batch(input.eventFollows
      ? [finish, this.db.prepare("UPDATE events SET status='sent',sent_at=? WHERE id=?").bind(now, input.eventId)]
      : [finish]);
  }

  /** 这次没发成，到 nextAttemptAt 再试。eventFollows 同 finishNotice：邮件失败时通知记成 failed，并计数。 */
  async failNotice(
    claim: NoticeClaim,
    input: { eventId: string; message: string; httpStatus: number | null; nextAttemptAt: string; eventFollows: boolean },
  ): Promise<void> {
    const now = new Date().toISOString();
    const fail = this.db.prepare(
      `UPDATE notice_deliveries
       SET status='failed',last_http_status=?,last_error=?,next_attempt_at=?,updated_at=?
       WHERE id=? AND status='sending' AND attempts=?`,
    ).bind(input.httpStatus, input.message.slice(0, 500), input.nextAttemptAt, now, claim.id, claim.attempts);
    await this.db.batch(input.eventFollows ? [fail, this.eventFailedStatement(input.eventId)] : [fail]);
    if (input.eventFollows) await this.incrementCounter("emails_failed");
  }

  /** 不再发了（次数用完、渲染不出来）。原因写进 last_error。eventFollows 同 failNotice。 */
  async abandonNotice(
    claim: NoticeClaim,
    input: { eventId: string; reason: string; httpStatus: number | null; eventFollows: boolean },
  ): Promise<void> {
    const now = new Date().toISOString();
    const abandon = this.db.prepare(
      `UPDATE notice_deliveries
       SET status='abandoned',last_http_status=?,last_error=?,next_attempt_at=NULL,updated_at=?
       WHERE id=? AND status='sending' AND attempts=?`,
    ).bind(input.httpStatus, input.reason.slice(0, 500), now, claim.id, claim.attempts);
    await this.db.batch(input.eventFollows ? [abandon, this.eventFailedStatement(input.eventId)] : [abandon]);
    if (input.eventFollows) await this.incrementCounter("emails_failed");
  }

  /** 没东西可发（日报里只有建档存量）：记成 skipped，不再取出来。 */
  async skipNotice(claim: NoticeClaim, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE notice_deliveries
       SET status='skipped',last_error=?,next_attempt_at=NULL,updated_at=?
       WHERE id=? AND status='sending' AND attempts=?`,
    ).bind(reason.slice(0, 500), now, claim.id, claim.attempts).run();
  }

  private eventFailedStatement(eventId: string): OperationalPreparedStatement {
    return this.db.prepare("UPDATE events SET status='failed' WHERE id=? AND status IN ('pending','failed','sending')").bind(eventId);
  }

  /**
   * 邮件渲染不出来的通知：打上 email_suppressed_at，移出邮件队列。
   * 否则它会按 created_at 永远排在前面，挡住后面所有邮件。别的渠道有自己的那一行，不受影响。
   */
  async markEmailUnrenderable(eventId: string): Promise<void> {
    await this.db.prepare("UPDATE events SET email_suppressed_at=? WHERE id=? AND email_suppressed_at IS NULL")
      .bind(new Date().toISOString(), eventId).run();
  }

  /** 渠道收下了、到没到还没回报的（一天以内）。 */
  async noticesAwaitingOutcome(channel: NoticeChannel, limit: number): Promise<NoticeAwaitingOutcomeRow[]> {
    const result = await this.db.prepare(
      `SELECT id delivery_id,event_id,remote_id FROM notice_deliveries
       WHERE channel=? AND status='sent' AND outcome IS NULL AND remote_id IS NOT NULL AND sent_at>=?
       ORDER BY sent_at ASC LIMIT ?`,
    ).bind(channel, new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), limit).all<NoticeAwaitingOutcomeRow>();
    return result.results;
  }

  async recordNoticeOutcome(deliveryId: string, outcome: "delivered" | "failed", error: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE notice_deliveries SET outcome=?,outcome_error=?,outcome_at=?,updated_at=?
       WHERE id=? AND outcome IS NULL`,
    ).bind(outcome, error === null ? null : error.slice(0, 300), now, now, deliveryId).run();
  }

  /**
   * 微信（Hermes）该发的：渠道启用之后、3 天以内的通知，除了早报、关键词逐件上新和只发邮件的重复提醒。
   * 微信通道 2026-08 起停用（HERMES_NOTIFICATIONS_ENABLED=false），这条只在重新打开时才会跑。
   */
  async pendingHermesNotices(enabledAt: string, limit: number): Promise<PendingEmailRow[]> {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - NOTICE_SENDING_STALE_MS).toISOString();
    const expiredBefore = new Date(Date.now() - NOTICE_MAX_EVENT_AGE_MS).toISOString();
    const result = await this.db.prepare(
      `SELECT e.id event_id,e.event_key,COALESCE(e.semantic_event_type,e.event_type) event_type,
       e.created_at event_created_at,e.payload_json,
       COALESCE(l.source_id,b.source_id) source_id,l.source_item_id,l.identity_scope,l.canonical_url,l.title,l.description_excerpt,l.image_url,
       l.seller_name,l.shop_name,l.currency,l.current_price,l.original_price,l.price_basis,l.item_condition,l.availability,
       COALESCE(b.enabled,1) binding_enabled,COALESCE(p.enabled,1) profile_enabled
       FROM events e
       LEFT JOIN listings l ON l.id=e.listing_id
       LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN watch_profiles p ON p.id=e.watch_profile_id
       LEFT JOIN notice_deliveries h ON h.event_id=e.id AND h.channel='hermes'
       WHERE e.created_at>=?
       AND COALESCE(e.semantic_event_type,e.event_type)<>'morning_digest'
       AND e.status<>'suppressed'
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND (e.event_type<>'new_listing' OR COALESCE(b.monitoring_purpose,'')<>'keyword_new_listing')
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
        WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
          AND x.source_item_id=l.source_item_id
          AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND e.payload_json NOT LIKE '%\"emailOnlyRepeat\":true%'
       AND e.created_at>=?
       AND COALESCE(h.attempts,0)<?
       AND (
         h.id IS NULL
         OR (h.status IN ('pending','failed') AND (h.next_attempt_at IS NULL OR h.next_attempt_at<=?))
         OR (h.status='sending' AND h.updated_at<=?)
       )
       ORDER BY e.created_at ASC LIMIT ?`,
    ).bind(enabledAt, now, expiredBefore, NOTICE_MAX_ATTEMPTS.hermes, now, staleBefore, limit).all<PendingEmailRow>();
    return result.results;
  }
}
