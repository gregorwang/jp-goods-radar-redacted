import type { ItemCondition, NormalizedListing } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const tradingStatusPattern = /^(?:item_status_)?trading$/iu;

export const PRODUCT_PRICE_INTELLIGENCE_METRIC_VERSION = "product-price-intelligence-v2" as const;
export const PRODUCT_PRICE_INTELLIGENCE_TIME_ZONE = "Asia/Tokyo" as const;
export const PRODUCT_PRICE_INTELLIGENCE_WINDOW_DAYS = 730 as const;

export type PriceSampleConfidence = "insufficient" | "low" | "medium" | "high";
export type AppearanceDateCoverage = "none" | "partial" | "complete";
export type PriceComparisonWithheldReason =
  | "mixed_current_offer_conditions"
  | "mixed_current_offer_price_bases"
  | "mixed_source_sold_conditions"
  | "mixed_source_sold_price_bases"
  | "no_same_condition_history"
  | "no_same_price_basis_history"
  | "no_matching_comparison_bucket"
  | "insufficient_comparable_history";
export type PriceRecommendation =
  | "no_current_offer"
  | "current_price_missing"
  | "insufficient_history"
  | "mixed_comparability"
  | "wait_for_better_price"
  | "slightly_above_history"
  | "below_history"
  | "near_history";

export interface ProductPriceIntelligence {
  metricVersion: typeof PRODUCT_PRICE_INTELLIGENCE_METRIC_VERSION;
  asOf: string;
  window: {
    days: typeof PRODUCT_PRICE_INTELLIGENCE_WINDOW_DAYS;
    startsAt: string;
    endsAt: string;
    timeZone: typeof PRODUCT_PRICE_INTELLIGENCE_TIME_ZONE;
  };
  confirmedListingCount: number;
  confirmedActiveOfferCount: number;
  currentPricedOfferCount: number;
  currentLowestPrice?: number;
  sourceSoldStatusCount: number;
  sourceSoldStatusPriceSampleCount: number;
  comparablePriceSampleCount: number;
  comparisonExcludedPriceSampleCount: number;
  referencePriceMedian?: number;
  referencePriceLow?: number;
  referencePriceHigh?: number;
  /** Normalized listings do not contain transaction proof. */
  verifiedSaleCount: 0;
  priceReferenceBasis: "source_sold_status_last_visible_price";
  premiumToReferenceMedianPercent?: number;
  sourceListedWithinWindowCount: number;
  sourceDatedListingCount: number;
  sourceUndatedListingCount: number;
  sourceListedBeforeWindowCount: number;
  sourceListedAfterAsOfCount: number;
  sourceDateCoveragePercent: number;
  appearanceDateCoverage: AppearanceDateCoverage;
  conditions: ItemCondition[];
  mixedConditions: boolean;
  comparisonCondition?: ItemCondition;
  comparisonPriceBasis?: NormalizedListing["priceBasis"];
  comparisonWithheldReason?: PriceComparisonWithheldReason;
  sampleConfidence: PriceSampleConfidence;
  recommendation: PriceRecommendation;
}

interface PricedListing {
  condition: ItemCondition;
  price: number;
  priceBasis: NormalizedListing["priceBasis"];
}

function validJpyPrice(listing: NormalizedListing): number | undefined {
  return listing.currency === "JPY"
    && typeof listing.currentPrice === "number"
    && Number.isFinite(listing.currentPrice)
    && listing.currentPrice > 0
    ? listing.currentPrice
    : undefined;
}

function isTradingListing(listing: NormalizedListing): boolean {
  const status = listing.rawMetadata?.sourceStatus;
  return listing.sourceId === "mercari_jp"
    && typeof status === "string"
    && tradingStatusPattern.test(status.trim());
}

function sourceListedTime(listing: NormalizedListing): number | undefined {
  const rawCreatedAt = listing.rawMetadata?.createdAt;
  const value = listing.sourceListedAt
    ?? (typeof rawCreatedAt === "string" ? rawCreatedAt : undefined);
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function median(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  const left = values[middle - 1];
  const right = values[middle];
  return left === undefined || right === undefined ? undefined : Math.round((left + right) / 2);
}

function sampleConfidence(sampleCount: number): PriceSampleConfidence {
  if (sampleCount < 2) return "insufficient";
  if (sampleCount === 2) return "low";
  if (sampleCount <= 5) return "medium";
  return "high";
}

function singleCondition(listings: readonly { condition: ItemCondition }[]): ItemCondition | undefined {
  const values = [...new Set(listings.map((listing) => listing.condition))];
  return values.length === 1 ? values[0] : undefined;
}

function singlePriceBasis(
  listings: readonly { priceBasis: NormalizedListing["priceBasis"] }[],
): NormalizedListing["priceBasis"] | undefined {
  const values = [...new Set(listings.map((listing) => listing.priceBasis))];
  return values.length === 1 ? values[0] : undefined;
}

function comparisonWithheldReason(input: {
  activeOffers: readonly { condition: ItemCondition; priceBasis: NormalizedListing["priceBasis"] }[];
  soldSamples: readonly PricedListing[];
  comparableSampleCount: number;
  comparisonCondition?: ItemCondition;
  comparisonPriceBasis?: NormalizedListing["priceBasis"];
}): PriceComparisonWithheldReason | undefined {
  if (new Set(input.activeOffers.map((listing) => listing.condition)).size > 1) {
    return "mixed_current_offer_conditions";
  }
  if (new Set(input.activeOffers.map((listing) => listing.priceBasis)).size > 1) {
    return "mixed_current_offer_price_bases";
  }
  if (input.activeOffers.length === 0
    && input.comparisonCondition === undefined
    && new Set(input.soldSamples.map((listing) => listing.condition)).size > 1) {
    return "mixed_source_sold_conditions";
  }
  if (input.activeOffers.length === 0
    && input.comparisonPriceBasis === undefined
    && new Set(input.soldSamples.map((listing) => listing.priceBasis)).size > 1) {
    return "mixed_source_sold_price_bases";
  }
  if (input.comparableSampleCount === 0 && input.comparisonCondition !== undefined) {
    if (!input.soldSamples.some((sample) => sample.condition === input.comparisonCondition)) {
      return "no_same_condition_history";
    }
    if (input.comparisonPriceBasis !== undefined
      && !input.soldSamples.some((sample) => sample.priceBasis === input.comparisonPriceBasis)) {
      return "no_same_price_basis_history";
    }
    if (input.comparisonPriceBasis !== undefined) return "no_matching_comparison_bucket";
  }
  return input.comparableSampleCount < 2 ? "insufficient_comparable_history" : undefined;
}

function recommendation(input: {
  activeOfferCount: number;
  currentLowestPrice?: number;
  referencePriceMedian?: number;
  premiumPercent?: number;
  comparisonWithheldReason?: PriceComparisonWithheldReason;
}): PriceRecommendation {
  if (input.activeOfferCount === 0) return "no_current_offer";
  if (input.currentLowestPrice === undefined) return "current_price_missing";
  if (input.comparisonWithheldReason !== undefined
    && input.comparisonWithheldReason !== "insufficient_comparable_history") return "mixed_comparability";
  if (input.referencePriceMedian === undefined || input.premiumPercent === undefined) return "insufficient_history";
  if (input.premiumPercent >= 50) return "wait_for_better_price";
  if (input.premiumPercent >= 20) return "slightly_above_history";
  if (input.premiumPercent <= -15) return "below_history";
  return "near_history";
}

export function buildProductPriceIntelligence(
  listings: readonly NormalizedListing[],
  referenceTime = Date.now(),
): ProductPriceIntelligence {
  const asOfTime = Number.isFinite(referenceTime) ? referenceTime : Date.now();
  const windowStartTime = asOfTime - PRODUCT_PRICE_INTELLIGENCE_WINDOW_DAYS * DAY_MS;
  const activeOffers = listings.filter((listing) => listing.availability === "available"
    || listing.availability === "preorder"
    || listing.availability === "backorder");
  const currentPricedOffers = activeOffers.flatMap<PricedListing>((listing) => {
    const price = validJpyPrice(listing);
    return price === undefined ? [] : [{ condition: listing.condition, price, priceBasis: listing.priceBasis }];
  }).sort((left, right) => left.price - right.price);
  const sourceSoldStatusListings = listings.filter((listing) => listing.availability === "sold_out" && !isTradingListing(listing));
  const soldPriceSamples = sourceSoldStatusListings.flatMap<PricedListing>((listing) => {
    const price = validJpyPrice(listing);
    return price === undefined ? [] : [{ condition: listing.condition, price, priceBasis: listing.priceBasis }];
  }).sort((left, right) => left.price - right.price);

  const comparisonCondition = singleCondition(activeOffers) ?? (activeOffers.length === 0 ? singleCondition(soldPriceSamples) : undefined);
  const comparisonPriceBasis = singlePriceBasis(activeOffers)
    ?? (activeOffers.length === 0 ? singlePriceBasis(soldPriceSamples) : undefined);
  const comparableSamples = comparisonCondition === undefined || comparisonPriceBasis === undefined
    ? []
    : soldPriceSamples.filter((sample) => sample.condition === comparisonCondition
      && sample.priceBasis === comparisonPriceBasis);
  const comparablePrices = comparableSamples.map((sample) => sample.price);
  const excludedSampleCount = soldPriceSamples.length - comparableSamples.length;
  const withheldReason = comparisonWithheldReason({
    activeOffers,
    soldSamples: soldPriceSamples,
    comparableSampleCount: comparableSamples.length,
    comparisonCondition,
    comparisonPriceBasis,
  });
  const referencePriceMedian = withheldReason === undefined ? median(comparablePrices) : undefined;
  const currentLowestPrice = currentPricedOffers[0]?.price;
  const premiumPercent = referencePriceMedian !== undefined && currentLowestPrice !== undefined
    ? Math.round((currentLowestPrice / referencePriceMedian - 1) * 100)
    : undefined;

  const sourceListedTimes = listings.flatMap((listing) => {
    const timestamp = sourceListedTime(listing);
    return timestamp === undefined ? [] : [timestamp];
  });
  const sourceUndatedListingCount = listings.length - sourceListedTimes.length;
  const sourceDateCoveragePercent = listings.length === 0
    ? 0
    : Math.round((sourceListedTimes.length / listings.length) * 100);
  const appearanceDateCoverage: AppearanceDateCoverage = sourceListedTimes.length === 0
    ? "none"
    : sourceUndatedListingCount === 0 ? "complete" : "partial";
  const conditions = [...new Set(listings.map((listing) => listing.condition))].sort();

  return {
    metricVersion: PRODUCT_PRICE_INTELLIGENCE_METRIC_VERSION,
    asOf: new Date(asOfTime).toISOString(),
    window: {
      days: PRODUCT_PRICE_INTELLIGENCE_WINDOW_DAYS,
      startsAt: new Date(windowStartTime).toISOString(),
      endsAt: new Date(asOfTime).toISOString(),
      timeZone: PRODUCT_PRICE_INTELLIGENCE_TIME_ZONE,
    },
    confirmedListingCount: listings.length,
    confirmedActiveOfferCount: activeOffers.length,
    currentPricedOfferCount: currentPricedOffers.length,
    ...(currentLowestPrice === undefined ? {} : { currentLowestPrice }),
    sourceSoldStatusCount: sourceSoldStatusListings.length,
    sourceSoldStatusPriceSampleCount: soldPriceSamples.length,
    comparablePriceSampleCount: comparableSamples.length,
    comparisonExcludedPriceSampleCount: excludedSampleCount,
    ...(referencePriceMedian === undefined ? {} : { referencePriceMedian }),
    ...(comparablePrices[0] === undefined ? {} : { referencePriceLow: comparablePrices[0] }),
    ...(comparablePrices.at(-1) === undefined ? {} : { referencePriceHigh: comparablePrices.at(-1) }),
    verifiedSaleCount: 0,
    priceReferenceBasis: "source_sold_status_last_visible_price",
    ...(premiumPercent === undefined ? {} : { premiumToReferenceMedianPercent: premiumPercent }),
    sourceListedWithinWindowCount: sourceListedTimes.filter((timestamp) => timestamp >= windowStartTime && timestamp <= asOfTime).length,
    sourceDatedListingCount: sourceListedTimes.length,
    sourceUndatedListingCount,
    sourceListedBeforeWindowCount: sourceListedTimes.filter((timestamp) => timestamp < windowStartTime).length,
    sourceListedAfterAsOfCount: sourceListedTimes.filter((timestamp) => timestamp > asOfTime).length,
    sourceDateCoveragePercent,
    appearanceDateCoverage,
    conditions,
    mixedConditions: conditions.length > 1,
    ...(comparisonCondition === undefined ? {} : { comparisonCondition }),
    ...(comparisonPriceBasis === undefined ? {} : { comparisonPriceBasis }),
    ...(withheldReason === undefined ? {} : { comparisonWithheldReason: withheldReason }),
    sampleConfidence: sampleConfidence(comparableSamples.length),
    recommendation: recommendation({
      activeOfferCount: activeOffers.length,
      currentLowestPrice,
      referencePriceMedian,
      premiumPercent,
      comparisonWithheldReason: withheldReason,
    }),
  };
}
