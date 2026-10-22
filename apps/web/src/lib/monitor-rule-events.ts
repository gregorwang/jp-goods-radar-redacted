import type { MonitorEventType } from "@jpgr/core";

/**
 * Whether a rule must feed newly discovered comparable offers into the V2
 * event preparation pipeline. The pipeline owns the price gate, so target
 * rules need candidates even when the general new-offer event is disabled.
 */
export function monitorRuleNeedsNewListingCandidate(
  eventTypes: readonly MonitorEventType[],
): boolean {
  return eventTypes.some((eventType) => [
    "product.new_comparable_offer",
    "product.condition_match_seen",
    "product.complete_set_seen",
    "product.offer_below_target_listing_price",
    "product.offer_below_target_landed_cost",
  ].includes(eventType));
}
