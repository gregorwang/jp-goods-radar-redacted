import type { Availability, ItemCondition, SourceId } from "./types.js";

const DAY_MS = 86_400_000;
const ACTIVE_AVAILABILITIES = new Set<Availability>(["available", "preorder", "backorder"]);
const UNAVAILABLE_AVAILABILITIES = new Set<Availability>(["sold_out", "unavailable"]);

export const PRODUCT_LIFECYCLE_METRIC_VERSION = "product-lifecycle-v1" as const;
export const RELIST_CANDIDATE_RULE_VERSION = "relist-candidate-v1" as const;
export const RELIST_TITLE_SIMILARITY_THRESHOLD = 0.72;

export interface ProductListingObservation {
  evidenceId: string;
  evidenceKind: "search_observation" | "operational_snapshot" | "listing_record";
  observedAt: string;
  price?: number;
  availability: Availability;
  condition: ItemCondition;
}

export interface ProductLifecycleListingInput {
  membershipId: string;
  sourceId: SourceId;
  sourceItemId: string;
  canonicalUrl: string;
  title: string;
  imageUrl?: string;
  sellerName?: string;
  sourceListedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  currentPrice?: number;
  availability: Availability;
  condition: ItemCondition;
  verifiedSaleCount?: number;
  observations: ProductListingObservation[];
}

export interface ProductLifecyclePoint extends ProductListingObservation {
  transition: "first_observation" | "price_changed" | "status_changed" | "price_and_status_changed";
}

export interface ProductListingLifecycle {
  membershipId: string;
  sourceId: SourceId;
  sourceItemId: string;
  canonicalUrl: string;
  title: string;
  sellerName?: string;
  sourceListedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  timeline: ProductLifecyclePoint[];
  firstObservedActiveAt?: string;
  firstUnavailableAt?: string;
  observedActiveDurationDays?: number;
  rightCensored: boolean;
  observedActiveAtLeastDays?: number;
  priceChangeCount: number;
  statusChangeCount: number;
  verifiedSale: boolean;
  verifiedSaleCount: number;
}

export interface RelistCandidateCluster {
  id: string;
  status: "candidate";
  sourceId: SourceId;
  sellerName: string;
  listingMembershipIds: string[];
  sourceItemIds: string[];
  evidence: {
    sameSeller: true;
    sameImage: true;
    minimumTitleSimilarity: number;
    ruleVersion: typeof RELIST_CANDIDATE_RULE_VERSION;
  };
}

export interface ProductLifecycleIntelligence {
  metricVersion: typeof PRODUCT_LIFECYCLE_METRIC_VERSION;
  relistRuleVersion: typeof RELIST_CANDIDATE_RULE_VERSION;
  asOf: string;
  observationLimitPerListing: 100;
  rawAppearanceCount: number;
  candidateAdjustedAppearanceRange: { min: number; max: number };
  sourceDatedListingCount: number;
  sourceUndatedListingCount: number;
  sourceDatedNewOffers90d: number;
  sourceDatedNewOffers365d: number;
  systemFirstSeenNewOffers90d: number;
  systemFirstSeenNewOffers365d: number;
  latestSourceAppearanceAt?: string;
  latestSystemFirstSeenAt?: string;
  sourceDatedMedianGapDays?: number;
  systemObservedMedianGapDays?: number;
  completedObservedActiveDurationCount: number;
  rightCensoredActiveCount: number;
  medianObservedActiveDurationDays?: number;
  relistCandidateListingCount: number;
  relistCandidateRatioPercent: number;
  relistCandidates: RelistCandidateCluster[];
  listings: ProductListingLifecycle[];
}

function validTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundedDays(milliseconds: number): number {
  return Math.round((Math.max(0, milliseconds) / DAY_MS) * 10) / 10;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function medianGapDays(values: readonly number[]): number | undefined {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  if (sorted.length < 3) return undefined;
  const gaps = sorted.slice(1).map((value, index) => roundedDays(value - (sorted[index] ?? value)));
  const value = median(gaps);
  return value === undefined ? undefined : Math.round(value * 10) / 10;
}

function normalizeObservation(input: ProductLifecycleListingInput): ProductListingObservation[] {
  const valid = input.observations
    .filter((item) => validTime(item.observedAt) !== undefined)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  if (valid.length === 0) {
    return [{
      evidenceId: `listing:${input.membershipId}`,
      evidenceKind: "listing_record",
      observedAt: input.lastSeenAt,
      ...(input.currentPrice === undefined ? {} : { price: input.currentPrice }),
      availability: input.availability,
      condition: input.condition,
    }];
  }
  const deduped = new Map<string, ProductListingObservation>();
  for (const item of valid.slice(-100)) {
    const key = [item.observedAt, item.price ?? "", item.availability, item.condition].join("|");
    const current = deduped.get(key);
    if (!current || current.evidenceKind === "search_observation") deduped.set(key, item);
  }
  return [...deduped.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function lifecycle(input: ProductLifecycleListingInput): ProductListingLifecycle {
  const observations = normalizeObservation(input);
  const timeline: ProductLifecyclePoint[] = [];
  let priceChangeCount = 0;
  let statusChangeCount = 0;
  observations.forEach((observation, index) => {
    const previous = observations[index - 1];
    if (!previous) {
      timeline.push({ ...observation, transition: "first_observation" });
      return;
    }
    const priceChanged = observation.price !== previous.price;
    const statusChanged = observation.availability !== previous.availability;
    if (priceChanged) priceChangeCount += 1;
    if (statusChanged) statusChangeCount += 1;
    if (!priceChanged && !statusChanged) return;
    timeline.push({
      ...observation,
      transition: priceChanged && statusChanged
        ? "price_and_status_changed"
        : priceChanged ? "price_changed" : "status_changed",
    });
  });
  const firstActive = observations.find((item) => ACTIVE_AVAILABILITIES.has(item.availability));
  const firstActiveTime = validTime(firstActive?.observedAt);
  const firstUnavailable = firstActiveTime === undefined ? undefined : observations.find((item) => {
    const time = validTime(item.observedAt);
    return time !== undefined && time >= firstActiveTime && UNAVAILABLE_AVAILABILITIES.has(item.availability);
  });
  const firstUnavailableTime = validTime(firstUnavailable?.observedAt);
  const last = observations.at(-1);
  const lastTime = validTime(last?.observedAt);
  const rightCensored = last !== undefined && ACTIVE_AVAILABILITIES.has(last.availability);
  const observedActiveDurationDays = firstActiveTime !== undefined && firstUnavailableTime !== undefined
    ? roundedDays(firstUnavailableTime - firstActiveTime)
    : undefined;
  const latestUnavailableIndex = rightCensored
    ? observations.reduce((latest, item, index) => UNAVAILABLE_AVAILABILITIES.has(item.availability) ? index : latest, -1)
    : -1;
  const currentActive = rightCensored
    ? observations.slice(latestUnavailableIndex + 1).find((item) => ACTIVE_AVAILABILITIES.has(item.availability))
    : undefined;
  const currentActiveTime = validTime(currentActive?.observedAt);
  const observedActiveAtLeastDays = rightCensored && currentActiveTime !== undefined && lastTime !== undefined
    ? roundedDays(lastTime - currentActiveTime)
    : undefined;
  const verifiedSaleCount = Number.isFinite(input.verifiedSaleCount)
    ? Math.max(0, Math.trunc(input.verifiedSaleCount ?? 0))
    : 0;
  return {
    membershipId: input.membershipId,
    sourceId: input.sourceId,
    sourceItemId: input.sourceItemId,
    canonicalUrl: input.canonicalUrl,
    title: input.title,
    ...(input.sellerName ? { sellerName: input.sellerName } : {}),
    ...(input.sourceListedAt ? { sourceListedAt: input.sourceListedAt } : {}),
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    observationCount: observations.length,
    timeline,
    ...(firstActive ? { firstObservedActiveAt: firstActive.observedAt } : {}),
    ...(firstUnavailable ? { firstUnavailableAt: firstUnavailable.observedAt } : {}),
    ...(observedActiveDurationDays === undefined ? {} : { observedActiveDurationDays }),
    rightCensored,
    ...(observedActiveAtLeastDays === undefined ? {} : { observedActiveAtLeastDays }),
    priceChangeCount,
    statusChangeCount,
    verifiedSale: verifiedSaleCount > 0,
    verifiedSaleCount,
  };
}

function normalizedIdentity(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").toLocaleLowerCase("ja").replace(/[\p{P}\p{S}\s]+/gu, "");
  return normalized ? normalized : undefined;
}

function normalizedImage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return undefined;
  }
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

export function relistTitleSimilarity(left: string, right: string): number {
  const leftSet = bigrams(normalizedIdentity(left) ?? "");
  const rightSet = bigrams(normalizedIdentity(right) ?? "");
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return Math.round((intersection / union) * 1_000) / 1_000;
}

function relistClusters(listings: readonly ProductLifecycleListingInput[]): RelistCandidateCluster[] {
  const parent = listings.map((_, index) => index);
  const similarities = new Map<string, number>();
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor] ?? cursor;
    while (parent[index] !== index) {
      const next = parent[index] ?? index;
      parent[index] = cursor;
      index = next;
    }
    return cursor;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < listings.length; left += 1) {
    for (let right = left + 1; right < listings.length; right += 1) {
      const first = listings[left];
      const second = listings[right];
      if (!first || !second || first.sourceId !== second.sourceId || first.sourceItemId === second.sourceItemId) continue;
      const seller = normalizedIdentity(first.sellerName);
      if (!seller || seller !== normalizedIdentity(second.sellerName)) continue;
      const image = normalizedImage(first.imageUrl);
      if (!image || image !== normalizedImage(second.imageUrl)) continue;
      const similarity = relistTitleSimilarity(first.title, second.title);
      if (similarity < RELIST_TITLE_SIMILARITY_THRESHOLD) continue;
      similarities.set(`${left}:${right}`, similarity);
      union(left, right);
    }
  }
  const groups = new Map<number, number[]>();
  listings.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });
  return [...groups.values()].filter((indexes) => indexes.length > 1).map((indexes) => {
    const members = indexes.map((index) => listings[index]).filter((item): item is ProductLifecycleListingInput => item !== undefined);
    const pairSimilarities: number[] = [];
    indexes.forEach((left, leftIndex) => indexes.slice(leftIndex + 1).forEach((right) => {
      const value = similarities.get(`${Math.min(left, right)}:${Math.max(left, right)}`);
      if (value !== undefined) pairSimilarities.push(value);
    }));
    const sourceId = members[0]?.sourceId ?? "mercari_jp";
    return {
      id: `relist:${sourceId}:${members.map((item) => item.sourceItemId).sort().join("+")}`,
      status: "candidate",
      sourceId,
      sellerName: members[0]?.sellerName ?? "",
      listingMembershipIds: members.map((item) => item.membershipId),
      sourceItemIds: members.map((item) => item.sourceItemId),
      evidence: {
        sameSeller: true,
        sameImage: true,
        minimumTitleSimilarity: Math.min(...pairSimilarities),
        ruleVersion: RELIST_CANDIDATE_RULE_VERSION,
      },
    };
  });
}

export function buildProductLifecycleIntelligence(
  inputs: readonly ProductLifecycleListingInput[],
  referenceTime = Date.now(),
): ProductLifecycleIntelligence {
  const asOfTime = Number.isFinite(referenceTime) ? referenceTime : Date.now();
  const deduped = [...new Map(inputs.map((item) => [`${item.sourceId}:${item.sourceItemId}`, item])).values()];
  const listings = deduped.map(lifecycle);
  const candidates = relistClusters(deduped);
  const candidateDuplicates = candidates.reduce((total, item) => total + item.sourceItemIds.length - 1, 0);
  const sourceDates = deduped.flatMap((item) => {
    const value = validTime(item.sourceListedAt);
    return value === undefined || value > asOfTime ? [] : [value];
  });
  const firstSeenDates = deduped.flatMap((item) => {
    const value = validTime(item.firstSeenAt);
    return value === undefined || value > asOfTime ? [] : [value];
  });
  const completedDurations = listings.flatMap((item) => (
    item.observedActiveDurationDays === undefined ? [] : [item.observedActiveDurationDays]
  ));
  const latestSource = sourceDates.length > 0 ? Math.max(...sourceDates) : undefined;
  const latestFirstSeen = firstSeenDates.length > 0 ? Math.max(...firstSeenDates) : undefined;
  const medianDuration = completedDurations.length >= 2 ? median(completedDurations) : undefined;
  const within = (value: number, days: number) => value >= asOfTime - days * DAY_MS && value <= asOfTime;
  return {
    metricVersion: PRODUCT_LIFECYCLE_METRIC_VERSION,
    relistRuleVersion: RELIST_CANDIDATE_RULE_VERSION,
    asOf: new Date(asOfTime).toISOString(),
    observationLimitPerListing: 100,
    rawAppearanceCount: deduped.length,
    candidateAdjustedAppearanceRange: {
      min: Math.max(0, deduped.length - candidateDuplicates),
      max: deduped.length,
    },
    sourceDatedListingCount: sourceDates.length,
    sourceUndatedListingCount: deduped.length - sourceDates.length,
    sourceDatedNewOffers90d: sourceDates.filter((value) => within(value, 90)).length,
    sourceDatedNewOffers365d: sourceDates.filter((value) => within(value, 365)).length,
    systemFirstSeenNewOffers90d: firstSeenDates.filter((value) => within(value, 90)).length,
    systemFirstSeenNewOffers365d: firstSeenDates.filter((value) => within(value, 365)).length,
    ...(latestSource === undefined ? {} : { latestSourceAppearanceAt: new Date(latestSource).toISOString() }),
    ...(latestFirstSeen === undefined ? {} : { latestSystemFirstSeenAt: new Date(latestFirstSeen).toISOString() }),
    ...(medianGapDays(sourceDates) === undefined ? {} : { sourceDatedMedianGapDays: medianGapDays(sourceDates) }),
    ...(medianGapDays(firstSeenDates) === undefined ? {} : { systemObservedMedianGapDays: medianGapDays(firstSeenDates) }),
    completedObservedActiveDurationCount: completedDurations.length,
    rightCensoredActiveCount: listings.filter((item) => item.rightCensored).length,
    ...(medianDuration === undefined ? {} : { medianObservedActiveDurationDays: Math.round(medianDuration * 10) / 10 }),
    relistCandidateListingCount: candidateDuplicates,
    relistCandidateRatioPercent: deduped.length === 0 ? 0 : Math.round((candidateDuplicates / deduped.length) * 100),
    relistCandidates: candidates,
    listings,
  };
}
