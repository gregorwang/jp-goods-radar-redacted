import type { OperationalDatabase, OperationalPreparedStatement } from "@jpgr/db";

/**
 * 档案改动记录（radar_core.watch_profile_changes，2026-10-16）。
 * 每个保存入口把「改了哪项、从什么改成什么」写成给人看的文字，和改动本身放进同一个 batch，
 * 档案页底部原样列出。前后值相同的不记：重复点保存不该刷出一排「每天 → 每天」。
 */
export const PROFILE_CHANGE_FIELDS = {
  query: "关键词",
  include_terms: "必须包含",
  exclude_terms: "命中即排除",
  min_listing_price: "最低价",
  interval: "巡回频率",
  next_run_at: "下次巡回",
  source_enabled: "来源",
  profile_enabled: "整份档案",
  target_price: "目标价",
  product_target: "同款识别条件",
  notify_email: "邮件",
  notify_feishu: "飞书",
  digest_price_reference: "日报原价",
  digest_show_sales: "日报同款成交",
  rule_events: "提醒哪些变化",
  rule_target_price: "目标标价",
  rule_sources: "参与判断的来源",
  rule_enabled: "提醒策略",
  rule_suspect_policy: "邮件发到哪一档",
  rule_offer_tracking: "候选报价追踪",
  rule_quiet_hours: "静默时段",
} as const;

export type ProfileChangeField = keyof typeof PROFILE_CHANGE_FIELDS;

export interface ProfileChange {
  field: ProfileChangeField;
  before: string | null;
  after: string | null;
  sourceId?: string | null;
}

export function profileChangeStatements(
  db: OperationalDatabase,
  profileId: string,
  changes: readonly ProfileChange[],
  changedAt: string,
): OperationalPreparedStatement[] {
  return changes
    .filter((change) => change.before !== change.after)
    .map((change) => db.prepare(
      `INSERT INTO watch_profile_changes(id,watch_profile_id,source_id,field,before_value,after_value,changed_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), profileId, change.sourceId ?? null, change.field, change.before, change.after, changedAt));
}

const INTERVAL_LABELS: Record<number, string> = {
  30: "每 30 分钟", 60: "每小时", 180: "每 3 小时", 240: "每 4 小时", 360: "每 6 小时", 720: "每 12 小时", 1440: "每天",
};

export function intervalText(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  const value = Number(minutes);
  return INTERVAL_LABELS[value] ?? (value % 60 === 0 ? `每 ${value / 60} 小时` : `每 ${value} 分钟`);
}

/** 东京时间「10/16 17:00」。 */
export function tokyoMinuteText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(time));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}

export function yenText(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `¥${Number(value).toLocaleString("ja-JP")}`;
}

export function onOffText(value: boolean | number | string | null | undefined, on = "开", off = "关"): string {
  return Number(value) === 1 || value === true ? on : off;
}

/** 词组 JSON 或数组 → 「a、b」；空列表记成 NULL（页面显示「空」）。 */
export function termsText(value: string | readonly string[] | null | undefined): string | null {
  let terms: unknown = value;
  if (typeof value === "string") {
    try { terms = JSON.parse(value); } catch { terms = []; }
  }
  const list = Array.isArray(terms) ? terms.filter((term): term is string => typeof term === "string" && term.trim() !== "") : [];
  return list.length ? list.join("、") : null;
}

export const DIGEST_PRICE_REFERENCE_TEXT: Record<string, string> = {
  official_and_ai: "官方定価 + AI 预测",
  official_only: "只要官方定価",
  off: "不显示原价",
};
