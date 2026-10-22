const BPS_DENOMINATOR = 10_000;

export const LANDED_COST_METRIC_VERSION = "landed-cost-v1" as const;
export const LANDED_COST_THRESHOLD_POLICY = "estimate_upper_bound_at_or_below" as const;

export interface LandedCostProfile {
  id: string;
  profileKey: string;
  version: number;
  name: string;
  /** Thousandths of CNY for each 100 JPY. 4.750 CNY / 100 JPY is stored as 4750. */
  exchangeRateCnyPer100JpyMilli: number;
  exchangeRateBufferBps: number;
  proxyFixedFeeJpy: number;
  proxyPercentBps: number;
  domesticShippingMinJpy: number;
  domesticShippingMaxJpy: number;
  internationalRouteLabel: string;
  firstWeightGrams: number;
  firstWeightMinJpy: number;
  firstWeightMaxJpy: number;
  continuedWeightGrams: number;
  continuedWeightMinJpy: number;
  continuedWeightMaxJpy: number;
  unknownWeightMinGrams: number;
  unknownWeightMaxGrams: number;
  consolidationShareBps: number;
  taxEnabled: boolean;
  taxBps: number;
  costBufferBps: number;
  validFrom: string;
  validTo?: string;
  createdAt: string;
  createdBy: "user" | "system" | "migration";
}

export interface LandedCostRange {
  min: number;
  max: number;
}

export interface LandedCostListingFacts {
  domesticShippingJpy?: number;
  weightGrams?: number;
  weightRangeGrams?: LandedCostRange;
}

export interface LandedCostInput extends LandedCostListingFacts {
  listingPriceJpy?: number;
  currency: string;
}

export interface LandedCostEstimate {
  metricVersion: typeof LANDED_COST_METRIC_VERSION;
  status: "estimated" | "unavailable";
  costProfile: {
    id: string;
    version: number;
    name: string;
    internationalRouteLabel: string;
  };
  reason?: "missing_listing_price" | "non_jpy_listing";
  precision?: "point" | "range";
  weightSource?: "listing_fact" | "listing_fact_range" | "cost_profile_range";
  weightRangeGrams?: LandedCostRange;
  missingFacts: Array<"domestic_shipping" | "weight">;
  components?: {
    listingPriceJpy: LandedCostRange;
    domesticShippingJpy: LandedCostRange;
    proxyFeeJpy: LandedCostRange;
    internationalShippingJpy: LandedCostRange;
    taxJpy: LandedCostRange;
    costBufferJpy: LandedCostRange;
  };
  landedCostJpy?: LandedCostRange;
  landedCostCnyFen?: LandedCostRange;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function directInteger(records: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  for (const item of records) {
    for (const key of keys) {
      const value = safeInteger(item[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function parseWeight(value: string): number | undefined {
  const normalized = value.normalize("NFKC").replace(/,/gu, "").trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(kg|キログラム|g|グラム)(?![a-z])/iu);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const grams = /^(?:kg|キログラム)$/iu.test(match[2] ?? "") ? amount * 1_000 : amount;
  return Number.isSafeInteger(Math.round(grams)) && grams <= 100_000 ? Math.round(grams) : undefined;
}

function parseJpy(value: string): number | undefined {
  const normalized = value.normalize("NFKC").replace(/,/gu, "").trim();
  if (/^(?:無料|送料無料|送料込み|0\s*円)$/u.test(normalized)) return 0;
  const match = normalized.match(/(?:¥|￥)?\s*(\d+)\s*円?/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

/**
 * Reads only bounded, known cost facts. It never guesses from arbitrary prose.
 * Source adapters can add direct numeric facts later without changing the
 * landed-cost calculator or its historical profile versions.
 */
export function extractLandedCostListingFacts(input: {
  facts?: unknown;
  rawMetadata?: unknown;
}): LandedCostListingFacts {
  const facts = record(input.facts);
  const raw = record(input.rawMetadata);
  const shipping = record(facts.shipping);
  const rawShipping = record(raw.shipping);
  const records = [shipping, rawShipping, facts, raw];
  const domesticShippingJpy = directInteger(records, [
    "domesticShippingJpy",
    "shippingFeeJpy",
    "shippingCostJpy",
  ]);
  const weightGrams = directInteger(records, ["weightGrams", "shippingWeightGrams", "itemWeightGrams"]);
  if (domesticShippingJpy !== undefined || weightGrams !== undefined) {
    return {
      ...(domesticShippingJpy === undefined ? {} : { domesticShippingJpy }),
      ...(weightGrams === undefined ? {} : { weightGrams }),
    };
  }

  const specifications = Array.isArray(facts.specifications) ? facts.specifications.slice(0, 50) : [];
  const displayFacts = Array.isArray(facts.displayFacts) ? facts.displayFacts.slice(0, 50) : [];
  let specificationWeight: number | undefined;
  let displayShipping: number | undefined;
  for (const candidate of specifications) {
    const item = record(candidate);
    if (typeof item.name !== "string" || typeof item.value !== "string") continue;
    if (/(?:重量|重さ|weight)/iu.test(item.name)) specificationWeight = parseWeight(item.value);
  }
  for (const candidate of displayFacts) {
    const item = record(candidate);
    const label = typeof item.label === "string" ? item.label : "";
    const value = typeof item.value === "string" ? item.value : "";
    if (/(?:送料|国内配送|shipping)/iu.test(label)) displayShipping = parseJpy(value);
    if (specificationWeight === undefined && /(?:重量|重さ|weight)/iu.test(label)) {
      specificationWeight = parseWeight(value);
    }
  }
  return {
    ...(displayShipping === undefined ? {} : { domesticShippingJpy: displayShipping }),
    ...(specificationWeight === undefined ? {} : { weightGrams: specificationWeight }),
  };
}

function normalizedRange(min: number, max: number): LandedCostRange {
  const safeMin = Math.max(0, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.ceil(max));
  return { min: safeMin, max: safeMax };
}

function percentRange(base: LandedCostRange, bps: number): LandedCostRange {
  if (bps <= 0) return { min: 0, max: 0 };
  return normalizedRange(
    (base.min * bps) / BPS_DENOMINATOR,
    (base.max * bps) / BPS_DENOMINATOR,
  );
}

function sumRanges(...ranges: readonly LandedCostRange[]): LandedCostRange {
  return ranges.reduce<LandedCostRange>((sum, value) => ({
    min: sum.min + value.min,
    max: sum.max + value.max,
  }), { min: 0, max: 0 });
}

function internationalFee(weightGrams: number, profile: LandedCostProfile, edge: "min" | "max"): number {
  const extra = Math.max(0, weightGrams - profile.firstWeightGrams);
  const continuedUnits = Math.ceil(extra / profile.continuedWeightGrams);
  const first = edge === "min" ? profile.firstWeightMinJpy : profile.firstWeightMaxJpy;
  const continued = edge === "min" ? profile.continuedWeightMinJpy : profile.continuedWeightMaxJpy;
  return first + continuedUnits * continued;
}

export function buildLandedCostEstimate(
  input: LandedCostInput,
  profile: LandedCostProfile,
): LandedCostEstimate {
  const base = {
    metricVersion: LANDED_COST_METRIC_VERSION,
    costProfile: {
      id: profile.id,
      version: profile.version,
      name: profile.name,
      internationalRouteLabel: profile.internationalRouteLabel,
    },
  } as const;
  if (input.currency !== "JPY") {
    return { ...base, status: "unavailable", reason: "non_jpy_listing", missingFacts: [] };
  }
  if (input.listingPriceJpy === undefined || !Number.isSafeInteger(input.listingPriceJpy) || input.listingPriceJpy <= 0) {
    return { ...base, status: "unavailable", reason: "missing_listing_price", missingFacts: [] };
  }

  const missingFacts: LandedCostEstimate["missingFacts"] = [];
  const listingPriceJpy = { min: input.listingPriceJpy, max: input.listingPriceJpy };
  const domesticShippingJpy = input.domesticShippingJpy === undefined
    ? normalizedRange(profile.domesticShippingMinJpy, profile.domesticShippingMaxJpy)
    : { min: input.domesticShippingJpy, max: input.domesticShippingJpy };
  if (input.domesticShippingJpy === undefined) missingFacts.push("domestic_shipping");

  const weightRangeGrams = input.weightGrams !== undefined
    ? { min: input.weightGrams, max: input.weightGrams }
    : input.weightRangeGrams !== undefined
      ? normalizedRange(input.weightRangeGrams.min, input.weightRangeGrams.max)
      : normalizedRange(profile.unknownWeightMinGrams, profile.unknownWeightMaxGrams);
  const weightSource = input.weightGrams !== undefined
    ? "listing_fact" as const
    : input.weightRangeGrams !== undefined ? "listing_fact_range" as const : "cost_profile_range" as const;
  if (weightSource === "cost_profile_range") missingFacts.push("weight");

  const proportionalProxy = percentRange(listingPriceJpy, profile.proxyPercentBps);
  const proxyFeeJpy = sumRanges(
    { min: profile.proxyFixedFeeJpy, max: profile.proxyFixedFeeJpy },
    proportionalProxy,
  );
  const rawInternational = normalizedRange(
    internationalFee(weightRangeGrams.min, profile, "min"),
    internationalFee(weightRangeGrams.max, profile, "max"),
  );
  const internationalShippingJpy = percentRange(rawInternational, profile.consolidationShareBps);
  const taxable = sumRanges(listingPriceJpy, domesticShippingJpy, proxyFeeJpy, internationalShippingJpy);
  const taxJpy = profile.taxEnabled ? percentRange(taxable, profile.taxBps) : { min: 0, max: 0 };
  const beforeBuffer = sumRanges(taxable, taxJpy);
  const costBufferJpy = percentRange(beforeBuffer, profile.costBufferBps);
  const landedCostJpy = sumRanges(beforeBuffer, costBufferJpy);
  const landedCostCnyFen = normalizedRange(
    (landedCostJpy.min * profile.exchangeRateCnyPer100JpyMilli) / 1_000,
    (landedCostJpy.max * profile.exchangeRateCnyPer100JpyMilli
      * (BPS_DENOMINATOR + profile.exchangeRateBufferBps)) / (1_000 * BPS_DENOMINATOR),
  );

  return {
    ...base,
    status: "estimated",
    precision: landedCostJpy.min === landedCostJpy.max ? "point" : "range",
    weightSource,
    weightRangeGrams,
    missingFacts,
    components: {
      listingPriceJpy,
      domesticShippingJpy,
      proxyFeeJpy,
      internationalShippingJpy,
      taxJpy,
      costBufferJpy,
    },
    landedCostJpy,
    landedCostCnyFen,
  };
}

/**
 * 判定阈值取哪一端。上界最保守，但绝大多数来源的搜索结果都没有重量字段，
 * 此时重量退化为 cost profile 的未知区间，上界按最重档算 —— 一件真实 150g 的挂件
 * 会被按 2000g 估价，用户设的目标价永远无法满足，功能看起来像坏的。
 * 因此重量缺失时改用区间中点，并在通知里标注估算依据（payload 已含 missingFacts /
 * weightSource / landedCostJpy 区间）。
 */
export function landedCostThresholdPolicy(estimate: LandedCostEstimate): "estimate_upper_bound_at_or_below" | "estimate_midpoint_at_or_below" {
  return estimate.missingFacts.includes("weight") ? "estimate_midpoint_at_or_below" : LANDED_COST_THRESHOLD_POLICY;
}

export function landedCostMeetsTarget(
  estimate: LandedCostEstimate,
  targetLandedCostJpy: number,
): boolean {
  if (estimate.status !== "estimated" || estimate.landedCostJpy === undefined) return false;
  const { min, max } = estimate.landedCostJpy;
  const threshold = landedCostThresholdPolicy(estimate) === "estimate_midpoint_at_or_below"
    ? Math.round((min + max) / 2)
    : max;
  return threshold <= targetLandedCostJpy;
}
