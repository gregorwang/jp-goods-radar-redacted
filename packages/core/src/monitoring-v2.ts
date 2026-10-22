import type { EventType } from "./types.js";

export const MONITOR_EVENT_TYPES = [
  "listing.price_changed",
  "listing.availability_changed",
  "product.new_comparable_offer",
  "product.offer_below_target_listing_price",
  "product.offer_below_target_landed_cost",
  "product.condition_match_seen",
  "product.complete_set_seen",
] as const;

export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];

export const MONITOR_SCOPE_TYPES = ["listing", "variant", "market"] as const;
export type MonitorScopeType = (typeof MONITOR_SCOPE_TYPES)[number];

export const MONITOR_DELIVERY_MODES = ["instant", "digest"] as const;
export type MonitorDeliveryMode = (typeof MONITOR_DELIVERY_MODES)[number];

export const MONITOR_STALE_SOURCE_POLICIES = ["include", "annotate", "exclude"] as const;
export type MonitorStaleSourcePolicy = (typeof MONITOR_STALE_SOURCE_POLICIES)[number];

export const PRODUCT_COMPLETENESS_FILTERS = ["complete", "incomplete", "unknown"] as const;
export type ProductCompletenessFilter = (typeof PRODUCT_COMPLETENESS_FILTERS)[number];

export function monitorRuleKey(watchProfileId: string): string {
  return `watch_profile:${watchProfileId}`;
}

export function canonicalMonitorEventType(
  legacyType: EventType,
): MonitorEventType | undefined {
  switch (legacyType) {
    case "new_listing":
      return "product.new_comparable_offer";
    case "price_drop":
    case "price_rise":
      return "listing.price_changed";
    case "target_price":
      return "product.offer_below_target_listing_price";
    case "restock":
    case "sold_out":
      return "listing.availability_changed";
    // 热度只走旧通知路径（见 packages/db insertEventBatch）：监控规则 V2 没有对应的事实类型。
    case "interest_rise":
    case "source_error":
    case "daily_digest":
    case "watch_completed":
    case "morning_digest":
      return undefined;
  }
}
