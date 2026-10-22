/**
 * `RadarRepository` 各组共用的模块级常量与纯函数，原样取自拆分前的
 * `repository.ts`（47–304 行）。这里只放不碰数据库的东西。
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

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1_000;
/** 同一段连续失败（自上次成功起）最多发几封来源错误提醒。 */
export const SOURCE_ERROR_REMINDERS_PER_STREAK = 3;
// 存疑候选照发但收在版面里：条数上限只控制渲染长度，未渲染的条数仍会明说。
export const MAX_KEYWORD_DIGEST_SUSPECTS = 24;
export const SQL_ID_CHUNK_SIZE = 50;
export const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000;
export const HERMES_SENDING_STALE_MS = 15 * 60 * 1_000;
/**
 * 投递失败必须有终点。没有这两条边界时，一条投不出去的通知会以 6 小时为间隔
 * 无限重投（生产中出现过 attempts=127 的记录），而取件是 `created_at ASC`，
 * 于是陈年失败长期占住每批 20 条的名额，把当天的新通知挤出窗口。
 */
export const HERMES_MAX_ATTEMPTS = 8;
/** 超过这个时长的通知已经没有投递价值，只保留为记录。 */
export const HERMES_MAX_EVENT_AGE_MS = 3 * 24 * 60 * 60 * 1_000;
export const MAX_DESCRIPTION_EXCERPT_CHARACTERS = 2_500;

export function boundedDescriptionExcerpt(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, MAX_DESCRIPTION_EXCERPT_CHARACTERS) : undefined;
}

export function storedEventType(
  type: EventCandidate["type"],
): Exclude<EventCandidate["type"], "price_rise" | "interest_rise" | "watch_completed" | "morning_digest" | "weekly_market_digest"> {
  // events.event_type 的 CHECK 只认老几种；真正的类型在 semantic_event_type，读的地方都用 COALESCE(semantic,event_type)。
  if (type === "price_rise" || type === "interest_rise") return "price_drop";
  if (type === "watch_completed" || type === "morning_digest" || type === "weekly_market_digest") return "daily_digest";
  return type;
}

export function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/**
 * 按来源轮转重排：先每个来源取第 1 条，再每个来源取第 2 条……
 * 调用方随后按上限截断时，就不会把某几个来源整体切掉。来源内部保持原有顺序。
 */
export function interleaveBySource<T extends { source_id: SourceId }>(items: readonly T[]): T[] {
  const bySource = new Map<SourceId, T[]>();
  for (const item of items) {
    const bucket = bySource.get(item.source_id);
    if (bucket) bucket.push(item);
    else bySource.set(item.source_id, [item]);
  }
  const buckets = [...bySource.values()];
  const depth = Math.max(0, ...buckets.map((bucket) => bucket.length));
  const ordered: T[] = [];
  for (let index = 0; index < depth; index += 1) {
    for (const bucket of buckets) {
      const item = bucket[index];
      if (item) ordered.push(item);
    }
  }
  return ordered;
}

/** 新品事件载荷里的发现口径；缺失或载荷损坏时按"无法判定"处理。 */
export function discoveryKindOf(payloadJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const kind = (parsed as { discoveryKind?: unknown }).discoveryKind;
    return typeof kind === "string" ? kind : undefined;
  } catch {
    return undefined;
  }
}

export function parsedStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parsedObject(value: string): Record<string, unknown> {
  try {
    return metadataRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function quietHoursNotBefore(
  detectedAt: string,
  start: string | null,
  end: string | null,
): string | null {
  if (!start || !end) return null;
  const startMinute = minuteOfDay(start);
  const endMinute = minuteOfDay(end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
  const detected = Date.parse(detectedAt);
  if (!Number.isFinite(detected)) return null;
  const tokyo = new Date(detected + TOKYO_OFFSET_MS);
  const currentMinute = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
  const overnight = startMinute > endMinute;
  const quiet = overnight
    ? currentMinute >= startMinute || currentMinute < endMinute
    : currentMinute >= startMinute && currentMinute < endMinute;
  if (!quiet) return null;
  const addDay = overnight && currentMinute >= startMinute ? 1 : 0;
  const endUtc = Date.UTC(
    tokyo.getUTCFullYear(),
    tokyo.getUTCMonth(),
    tokyo.getUTCDate() + addDay,
    Math.floor(endMinute / 60),
    endMinute % 60,
  ) - TOKYO_OFFSET_MS;
  return new Date(endUtc).toISOString();
}

export function listingCompleteness(productFactsJson: string): "complete" | "incomplete" | "unknown" {
  try {
    const facts: unknown = JSON.parse(productFactsJson);
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) return "unknown";
    const record = facts as Record<string, unknown>;
    if (Array.isArray(record.missingParts) && record.missingParts.length > 0) return "incomplete";
    return record.completeSet === true ? "complete" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 拍卖类来源的出价数、关注数、剩余秒数等展示字段每次轮询都在变。它们进入
 * content_hash 会让每一轮都判定为"内容已变化"，从而每轮为每件商品写一条
 * listing_snapshots 无界增长、把 changed_count 变成噪声，并不断刷新
 * listings.last_changed_at —— 而 last_changed_at 又参与 V2 监控事件 key 的哈希，
 * 连带破坏事件级去重。价格与库存本身由 state_hash 覆盖，不受此过滤影响。
 */
export const DAILY_COUNTER_COLUMNS = new Set(["queued_jobs", "search_calls", "detail_calls", "emails_sent", "emails_failed"]);

export const VOLATILE_DISPLAY_FACT_KEYS = new Set([
  "bid_count",
  "bidder_count",
  "watch_count",
  "left_time",
  "auction_status",
  "mercari.bid_count",
  "mercari.auction_state",
  "mercari.auction_end_at",
  "mercari.like_count",
  "mercari.comment_count",
  "mercari.seller_ratings",
  "mercari.seller_items",
]);

export function contentHashFacts(facts: NormalizedListing["facts"]): NormalizedListing["facts"] {
  if (!facts?.displayFacts) return facts;
  const { displayFacts, ...rest } = facts;
  const stable = displayFacts.filter((fact) => !VOLATILE_DISPLAY_FACT_KEYS.has(fact.key));
  return stable.length === displayFacts.length ? facts : { ...rest, displayFacts: stable };
}

/**
 * 全文件只承认一种"一天"：日本日历日（JST，UTC+9）。被监控的商品与上游站点都在日本，
 * 而仪表盘"今日"、汇总 key、每日邮件配额此前分别按港区 / 日本 / UTC 三种边界计算 ——
 * 配额在 JST 09:00 才重置，于是"昨天配额用尽"的汇总带着 JST 昨天的标签却要等 UTC
 * 跨日才发出，仪表盘的"今日邮件"也永远和配额计数对不上。
 */
export function japanDayStart(now: number): string {
  const local = new Date(now + JAPAN_OFFSET_MS);
  const utcStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - JAPAN_OFFSET_MS;
  return new Date(utcStart).toISOString();
}

export function japanDayKey(now = Date.now()): string {
  return new Date(now + JAPAN_OFFSET_MS).toISOString().slice(0, 10);
}

export function japanDay(value: string): string {
  const parsed = Date.parse(value);
  return japanDayKey(Number.isFinite(parsed) ? parsed : Date.now());
}

export interface MonitorListingRow {
  id: string;
  first_seen_at: string;
  last_changed_at: string;
  current_price: number | null;
  currency: string;
  item_condition: string;
  availability: string;
  price_basis: string | null;
  product_facts_json: string;
  source_health_status: string | null;
}

export interface MonitorLandedCostContext {
  target: MonitorRuleLandedCostTargetRow;
  profile: CostProfileRow;
}

/**
 * 以下三个判定只依赖 rule 与 binding，与单条候选事件无关。抽出来是为了让
 * insertEventBatch 的整批预取与 prepareMonitorEvent 的逐条判定共用同一份逻辑：
 * 两边一旦分叉，预取的行就会和实际用到的行对不上。
 */
export function monitorRuleScopeUsable(rule: MonitorRuleRow): boolean {
  return rule.scope_type !== "variant" || rule.scope_identity_status === "bound";
}

export function monitorRuleAcceptsSource(rule: MonitorRuleRow, sourceId: string): boolean {
  const sourceAllow = parsedStringArray(rule.source_allow_json);
  return rule.enabled === 1
    && (sourceAllow.length === 0 || sourceAllow.includes(sourceId))
    && !parsedStringArray(rule.source_deny_json).includes(sourceId);
}

export function isPriceTargetTrigger(eventType: string): boolean {
  return eventType === "new_listing" || eventType === "price_drop" || eventType === "target_price";
}

export function keywordBaselineResetStatements(db: OperationalDatabase, input: {
  profileId: string;
  bindingId?: string;
  resetAt: string;
}): OperationalPreparedStatement[] {
  const bindingScope = input.bindingId ? "id=?" : "watch_profile_id=?";
  const bindingScopeValue = input.bindingId ?? input.profileId;
  const eventScope = input.bindingId
    ? `((watch_binding_id=? AND event_type='new_listing')
       OR (watch_profile_id=? AND event_type='daily_digest'))`
    : `(watch_profile_id=? AND (event_type='daily_digest' OR (
       event_type='new_listing' AND EXISTS (
        SELECT 1 FROM watch_bindings b WHERE b.id=events.watch_binding_id AND b.kind='keyword'
       ))))`;
  const eventScopeValues = input.bindingId
    ? [input.bindingId, input.profileId]
    : [input.profileId];
  return [
    db.prepare(
      `UPDATE watch_bindings SET baseline_completed=0,next_run_at=?,updated_at=?
       WHERE ${bindingScope} AND kind='keyword'`,
    ).bind(input.resetAt, input.resetAt, bindingScopeValue),
    db.prepare(
      `UPDATE events SET status='suppressed' WHERE status IN ('pending','failed') AND ${eventScope}`,
    ).bind(...eventScopeValues),
  ];
}
