import type { LandedCostProfile } from "@jpgr/core";
import type { CostProfileRow } from "./types";

export function costProfileFromRow(row: CostProfileRow): LandedCostProfile {
  return {
    id: row.id,
    profileKey: row.profile_key,
    version: row.version,
    name: row.name,
    exchangeRateCnyPer100JpyMilli: row.exchange_rate_cny_per_100_jpy_milli,
    exchangeRateBufferBps: row.exchange_rate_buffer_bps,
    proxyFixedFeeJpy: row.proxy_fixed_fee_jpy,
    proxyPercentBps: row.proxy_percent_bps,
    domesticShippingMinJpy: row.domestic_shipping_min_jpy,
    domesticShippingMaxJpy: row.domestic_shipping_max_jpy,
    internationalRouteLabel: row.international_route_label,
    firstWeightGrams: row.first_weight_grams,
    firstWeightMinJpy: row.first_weight_min_jpy,
    firstWeightMaxJpy: row.first_weight_max_jpy,
    continuedWeightGrams: row.continued_weight_grams,
    continuedWeightMinJpy: row.continued_weight_min_jpy,
    continuedWeightMaxJpy: row.continued_weight_max_jpy,
    unknownWeightMinGrams: row.unknown_weight_min_grams,
    unknownWeightMaxGrams: row.unknown_weight_max_grams,
    consolidationShareBps: row.consolidation_share_bps,
    taxEnabled: row.tax_enabled === 1,
    taxBps: row.tax_bps,
    costBufferBps: row.cost_buffer_bps,
    validFrom: row.valid_from,
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
