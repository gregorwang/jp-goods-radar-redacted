import { isOneOffListingSource } from "./watch-semantics.js";

/** Feedback scheduling is exclusively for dedicated item price/stock watches. */
export type ItemScheduleMode = "adaptive" | "fixed";

/**
 * 一次性挂牌来源（Mercari / 雅虎フリマ / eBay）的退避天花板。
 *
 * 自适应退避的前提是"价格越久不变，越不需要看"。这句话只对商家目录型来源成立：
 * 那里漏掉一次补货，下次还有。对 C2C 一次性挂牌恰恰相反——"挂了三周没动"
 * 不是"没事发生"的证据，是"终局还没到"的状态，而终局只会来一次。
 * 稳定期越长，退避越深，偏偏售出最可能发生在盲区最大的时候。
 *
 * 2026-09-22 的实例：一条 27500 日元的绝版挂牌稳定三周，间隔退避到 45.8 小时，
 * 涨价到 33000 与随后的售出整段落在同一个盲区里，两件事都没能通知。
 * 省下的是每天约 33 次请求（占全站抓取量不到 5%），代价是一件买不回来的商品。
 */
const ONE_OFF_MAX_INTERVAL_MINUTES = 360;

export interface ItemScheduleScope {
  kind: string;
  monitoring_purpose: string;
  profile_dossier_kind?: string;
  source_id: string;
}

export interface ItemScheduleBinding extends ItemScheduleScope {
  schedule_interval_minutes: number;
  source_config_json: string;
  min_drop_amount?: number;
}

export interface ItemScheduleState {
  version: 1;
  intervalMinutes: number;
  stableMinutes: number;
  lastObservedAt: string | null;
  lastPrice: number | null;
  /** Last significant price, retained across small changes to measure drift. */
  referencePrice?: number | null;
  lastAvailability: string | null;
  holdUntil: string | null;
  reason: "baseline" | "stable" | "price_changed" | "signal" | "observing" | "incomplete" | "gap";
}

export function supportsAdaptiveItemSchedule(scope: ItemScheduleScope): boolean {
  return scope.kind === "item" && scope.monitoring_purpose === "item_price"
    && scope.profile_dossier_kind === "item" && scope.source_id !== "yahoo_auctions_jp";
}

export function adaptiveItemScheduleEnabled(binding: ItemScheduleBinding): boolean {
  return supportsAdaptiveItemSchedule(binding) && itemSchedulePolicy(binding).mode === "adaptive";
}

export function itemScheduleConfig(sourceConfigJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(sourceConfigJson);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function itemSchedulePolicy(binding: Pick<ItemScheduleBinding, "source_config_json">): {
  mode: ItemScheduleMode; maxIntervalMinutes: number; state?: unknown;
} {
  const config = itemScheduleConfig(binding.source_config_json);
  const value = config.itemSchedule;
  const policy = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    mode: policy.mode === "fixed" ? "fixed" : "adaptive",
    maxIntervalMinutes: typeof policy.maxIntervalMinutes === "number" && Number.isFinite(policy.maxIntervalMinutes)
      ? Math.max(1_440, Math.min(4_320, policy.maxIntervalMinutes)) : 4_320,
    state: policy.state,
  };
}

export function itemScheduleLimit(binding: ItemScheduleBinding): number {
  const configured = itemSchedulePolicy(binding).maxIntervalMinutes;
  // 用户显式设定的基础频率永远优先：这里只压退避的上限，不会把谁的监控调得更慢。
  const ceiling = isOneOffListingSource(binding.source_id)
    ? Math.min(configured, ONE_OFF_MAX_INTERVAL_MINUTES)
    : configured;
  return Math.max(binding.schedule_interval_minutes, ceiling);
}

export function readItemScheduleState(binding: ItemScheduleBinding): ItemScheduleState {
  const base: ItemScheduleState = {
    version: 1, intervalMinutes: binding.schedule_interval_minutes, stableMinutes: 0,
    lastObservedAt: null, lastPrice: null, referencePrice: null, lastAvailability: null, holdUntil: null, reason: "baseline",
  };
  try {
    const value = itemSchedulePolicy(binding).state;
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return base;
    const state = value as Record<string, unknown>;
    const timestamp = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
    const price = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    return {
      ...base,
      intervalMinutes: typeof state.intervalMinutes === "number" && Number.isFinite(state.intervalMinutes)
        ? Math.max(base.intervalMinutes, Math.min(itemScheduleLimit(binding), state.intervalMinutes)) : base.intervalMinutes,
      stableMinutes: typeof state.stableMinutes === "number" && Number.isFinite(state.stableMinutes)
        ? Math.max(0, Math.min(1_440, state.stableMinutes)) : 0,
      lastObservedAt: timestamp(state.lastObservedAt),
      lastPrice: price(state.lastPrice),
      referencePrice: price(state.referencePrice) ?? price(state.lastPrice),
      lastAvailability: typeof state.lastAvailability === "string" ? state.lastAvailability : null,
      holdUntil: timestamp(state.holdUntil),
      reason: ["baseline", "stable", "price_changed", "signal", "observing", "incomplete", "gap"].includes(String(state.reason))
        ? state.reason as ItemScheduleState["reason"] : "baseline",
    };
  } catch {
    return base;
  }
}

export function effectiveItemIntervalMinutes(binding: ItemScheduleBinding): number {
  return adaptiveItemScheduleEnabled(binding)
    ? readItemScheduleState(binding).intervalMinutes : binding.schedule_interval_minutes;
}

// Conservatively exclude the existing Tokyo 00:00–05:00 quiet window even when
// the temporary overnight override is active. No failures or paused days count.
function monitoredMinutesBetween(start: number, end: number): number {
  const dayMs = 86_400_000;
  const offset = 9 * 3_600_000;
  let quiet = 0;
  for (let day = Math.floor((start + offset) / dayMs); day <= Math.floor((end + offset) / dayMs); day += 1) {
    const quietStart = day * dayMs - offset;
    quiet += Math.max(0, Math.min(end, quietStart + 5 * 3_600_000) - Math.max(start, quietStart));
  }
  return Math.max(0, (end - start - quiet) / 60_000);
}

export function advanceItemSchedule(input: {
  binding: ItemScheduleBinding;
  now: string;
  observation: { price: number | null; availability: string } | null;
  scheduled: boolean;
  significantSignal?: boolean;
}): ItemScheduleState | null {
  if (!adaptiveItemScheduleEnabled(input.binding)) return null;
  const state = readItemScheduleState(input.binding);
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || (state.lastObservedAt && now <= Date.parse(state.lastObservedAt))) return null;
  const observation = input.observation;
  const knownStock = observation && ["available", "preorder", "backorder", "sold_out", "unavailable"].includes(observation.availability);
  const price = observation && observation.price !== null && Number.isFinite(observation.price) && observation.price > 0
    ? observation.price : null;
  // An explicit out-of-stock state remains useful without a purchasable price.
  const complete = observation !== null && knownStock && (price !== null || ["sold_out", "unavailable"].includes(observation.availability));
  if (!complete || !observation) {
    return { ...state, stableMinutes: 0, lastObservedAt: null, reason: "incomplete" };
  }
  const previousAt = state.lastObservedAt ? Date.parse(state.lastObservedAt) : null;
  const stockChanged = state.lastAvailability !== null && state.lastAvailability !== observation.availability;
  const referencePrice = state.referencePrice ?? state.lastPrice;
  // Use the watch's own absolute sensitivity, capped by a 2% relative change.
  // Notification thresholds and target crossings are evaluated separately.
  const minAmount = typeof input.binding.min_drop_amount === "number"
    && Number.isFinite(input.binding.min_drop_amount) && input.binding.min_drop_amount >= 0
    ? input.binding.min_drop_amount : 100;
  const changeAmount = referencePrice !== null && price !== null ? Math.abs(price - referencePrice) : 0;
  const priceChanged = referencePrice !== null && changeAmount > 0
    && (changeAmount >= minAmount || changeAmount / referencePrice >= 0.02);
  const next: ItemScheduleState = {
    ...state, lastObservedAt: input.now, lastPrice: price, lastAvailability: observation.availability,
    referencePrice: referencePrice ?? price,
  };
  if (stockChanged || input.significantSignal) {
    return { ...next, referencePrice: price, intervalMinutes: input.binding.schedule_interval_minutes, stableMinutes: 0,
      holdUntil: new Date(now + 48 * 3_600_000).toISOString(), reason: "signal" };
  }
  if (priceChanged) {
    return { ...next, referencePrice: price, intervalMinutes: Math.max(input.binding.schedule_interval_minutes, Math.round(state.intervalMinutes / 2)),
      stableMinutes: 0, holdUntil: new Date(Math.max(now + 24 * 3_600_000, Date.parse(state.holdUntil ?? "") || 0)).toISOString(),
      reason: "price_changed" };
  }
  const holdUntil = Date.parse(state.holdUntil ?? "") || 0;
  if (now < holdUntil) return { ...next, stableMinutes: 0, reason: "observing" };
  next.holdUntil = null;
  if (previousAt === null) return { ...next, stableMinutes: 0, reason: "baseline" };
  // Queue delays get modest tolerance; a missed run or multi-day pause must not
  // cause a catch-up jump through multiple frequency reductions.
  const elapsed = (now - previousAt) / 60_000;
  if (elapsed > 4 * 1_440 || monitoredMinutesBetween(previousAt, now) > state.intervalMinutes * 1.15 + 10) {
    return { ...next, stableMinutes: 0, reason: "gap" };
  }
  if (!input.scheduled) return next;
  next.stableMinutes += monitoredMinutesBetween(Math.max(previousAt, holdUntil), now);
  if (next.stableMinutes >= 1_440) {
    next.intervalMinutes = Math.min(itemScheduleLimit(input.binding), Math.round(state.intervalMinutes * 1.25));
    next.stableMinutes = 0;
    next.reason = "stable";
  }
  return next;
}

export function itemScheduleDelayMinutes(binding: ItemScheduleBinding, random: number): number {
  const interval = effectiveItemIntervalMinutes(binding);
  if (!adaptiveItemScheduleEnabled(binding)) return interval;
  return Math.max(binding.schedule_interval_minutes, Math.min(itemScheduleLimit(binding),
    Math.round(interval * (0.9 + 0.2 * Math.max(0, Math.min(1, random))))));
}

export function itemScheduleReasonLabel(reason: ItemScheduleState["reason"]): string {
  return {
    baseline: "正在积累有效检查记录", stable: "价格与库存持续稳定，已逐渐延长间隔",
    price_changed: "观察到价格变化，已缩短间隔", signal: "出现降价或库存信号，已恢复基础频率",
    observing: "变化后的密切观察期", incomplete: "检查信息不完整，暂停累计稳定时间",
    gap: "检查曾中断，正在重新积累稳定记录",
  }[reason];
}
