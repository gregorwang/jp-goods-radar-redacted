export type AnalyticsRunStatus = "success" | "partial" | "empty" | "failed";
export type AnalyticsSourceStatus = "success" | "empty" | "failed" | "disabled" | "cooldown";
export type AnalyticsSourceHealthState =
  | "healthy"
  | "empty"
  | "suspected_degradation"
  | "failed"
  | "disabled"
  | "cooldown";
export type AnalyticsCursorTerminationReason = "exhausted" | "budget_reached" | "not_applicable" | "unknown";
export type AnalyticsQualityGrade = "A" | "B" | "C" | "D";

export interface AnalyticsMarketScopeDefinition {
  schemaVersion: "market-scope-v1";
  query: string;
  includeTerms: string[];
  excludeTerms: string[];
  sources: Array<{
    sourceId: string;
    sourceConfig: Record<string, unknown>;
  }>;
  semantic: {
    provider: string;
    model: string;
    promptVersion: string;
    ontologyVersion: string;
    queryRecipeVersion: string;
  };
}

export interface AnalyticsMarketScopeVersion {
  id: string;
  subscriptionKey: string;
  version: number;
  scopeHash: string;
  definition: AnalyticsMarketScopeDefinition;
  createdAt: string;
}

export interface AnalyticsSourceHealthEvidence {
  state: AnalyticsSourceHealthState;
  requestSucceeded: boolean;
  parseSucceeded: boolean;
  rawResultCount: number;
  normalizedResultCount: number;
  pageDepth: number;
  cursorTerminationReason: AnalyticsCursorTerminationReason;
  abnormalEmpty: boolean;
  fieldTotal: number;
  fieldComplete: number;
  captchaDetected: boolean;
  loginRequired: boolean;
  blockedDetected: boolean;
  freshnessSlaMinutes: number;
  responseContentHash?: string;
  responseBytes?: number;
  templateVersion?: string;
  httpStatus?: number;
}

export interface AnalyticsListing {
  sourceId: string;
  sourceItemId: string;
  identityScope: string;
  canonicalUrl: string;
  title: string;
  descriptionExcerpt?: string;
  imageUrl?: string;
  sellerName?: string;
  shopName?: string;
  productKey: string;
  productMatchMethod: "identifier" | "exact_title" | "listing_identity";
  currency: string;
  currentPrice?: number;
  originalPrice?: number;
  priceBasis: string;
  condition: string;
  availability: string;
  sourceListedAt?: string;
  sourceUpdatedAt?: string;
  facts?: object;
  rawMetadata?: Record<string, unknown>;
}

/** Read-only historical evidence returned by the product-search recall lane. */
export interface AnalyticsHistoricalListing {
  sourceId: string;
  sourceItemId: string;
  identityScope: string;
  canonicalUrl: string;
  title: string;
  descriptionExcerpt?: string;
  imageUrl?: string;
  sellerName?: string;
  shopName?: string;
  currency: string;
  currentPrice?: number;
  originalPrice?: number;
  priceBasis: string;
  condition: string;
  availability: string;
  facts: Record<string, unknown>;
  rawMetadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AnalyticsSourceGroup {
  sourceId: string;
  status: AnalyticsSourceStatus;
  listings: AnalyticsListing[];
  coverage?: string;
  parserVersion?: string;
  requestRoute?: string;
  durationMs?: number;
  warnings?: string[];
  requestEvidence?: object;
  routeOutcome?: object;
  fieldCoverage?: object;
  nextCursor?: string;
  totalAvailable?: number;
  errorCode?: string;
  error?: string;
  retryAt?: string;
  health?: AnalyticsSourceHealthEvidence;
  /** Versioned target-dependent evidence; source listing fields remain authoritative. */
  candidateEvidence?: Record<string, Record<string, unknown>>;
}

export type AnalyticsSourcePayloadKind = "json" | "html" | "text" | "binary" | "empty" | "unreadable";

/**
 * A source HTTP response captured before an adapter parses or filters it.
 * Request credentials and headers are deliberately excluded.
 */
export interface AnalyticsSourceCapture {
  id: string;
  sourceId: string;
  ordinal: number;
  requestUrl: string;
  responseUrl?: string;
  requestMethod: string;
  responseStatus?: number;
  contentType?: string;
  payloadKind: AnalyticsSourcePayloadKind;
  rawPayload?: string;
  payloadBytes: number;
  contentHash: string;
  capturedAt: string;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

export interface OperationalListingSnapshot {
  id: string;
  watchBindingId?: string;
  price?: number;
  originalPrice?: number;
  priceBasis?: AnalyticsListing["priceBasis"];
  currency: string;
  availability: string;
  condition: string;
  stateHash?: string;
  observedAt: string;
  contentHash?: string;
  facts?: object;
}

export interface OperationalListingBundle {
  listing: Omit<AnalyticsListing, "productKey" | "productMatchMethod">;
  observedAt: string;
  snapshots: OperationalListingSnapshot[];
}

export interface AnalyticsAiEnrichmentRecord {
  listing: Omit<AnalyticsListing, "productKey" | "productMatchMethod">;
  purpose: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  input: object;
  output: object;
  evidence: object;
  confidence: "high" | "medium" | "low";
  metadata: object;
  observedAt: string;
}

export interface AnalyticsAiProcessingBatch {
  batchId: string;
  batch: {
    purpose: string;
    provider: string;
    model: string;
    promptVersion: string;
    inputHash: string;
    input: Record<string, unknown>;
    rawResponse: string;
    status: "parsed" | "partial" | "unparsed";
    metadata: Record<string, unknown>;
    observedAt: string;
  };
  records: AnalyticsAiEnrichmentRecord[];
}

export interface AnalyticsAiLookup {
  sourceId: string;
  sourceItemId: string;
  inputHash: string;
}

export interface AnalyticsAiLookupResult extends AnalyticsAiLookup {
  output: Record<string, unknown>;
  createdAt: string;
}

export interface ProductIdentityProjection {
  projectionId: string;
  projectionHash: string;
  workflowTaskId: string;
  searchHistoryId: string;
  identityVersion: string;
  membershipVersion: string;
  projectedAt: string;
  canonicalProduct: {
    id: string;
    identityHash: string;
    identityVersion: string;
    canonicalName: string;
    workTitle?: string;
    characterNames: string[];
    productType?: string;
    manufacturer?: string;
    series?: string;
    targetFingerprint: Record<string, unknown>;
  };
  productVariant: {
    id: string;
    canonicalProductId: string;
    identityHash: string;
    identityVersion: string;
    variantName: string;
    model?: string;
    jan?: string;
    size?: string;
    attributes: Record<string, unknown>;
    targetFingerprint: Record<string, unknown>;
  };
  comparisonProfile: {
    id: string;
    profileVersion: number;
    ruleVersion: string;
    name: string;
    conditionPolicy: "strict_same_condition" | "broad_public_asking_price";
    allowedConditions: string[];
    allowedCompleteness: string[];
    allowedPriceBases: string[];
    allowedOfficialStatuses: string[];
  };
  memberships: Array<{
    id: string;
    sourceId: string;
    sourceItemId: string;
    decision: "confirmed" | "rejected" | "uncertain";
    decisionSource: "workflow_matcher" | "workflow_ai" | "human";
    relation: "exact" | "probable_exact" | "variant" | "bundle" | "related" | "irrelevant" | "uncertain";
    confidence: "high" | "medium" | "low";
    evidence: Record<string, unknown>;
  }>;
}

export interface AnalyticsSearchRun {
  id: string;
  origin: "manual_search" | "watch_keyword" | "watch_item";
  query: string;
  queryKey: string;
  filters: Record<string, unknown>;
  status: AnalyticsRunStatus;
  resultCount: number;
  searchedAt: string;
  groups: AnalyticsSourceGroup[];
  captures?: AnalyticsSourceCapture[];
  subscriptionKey?: string;
  subscriptionName?: string;
  bindingId?: string;
  scopeVersion?: AnalyticsMarketScopeVersion;
}

export interface AnalyticsSummary {
  runCount: number;
  subscriptionCount: number;
  observedListings: number;
  visibleListings: number;
  newListings: number;
  leftVisibleWindow: number;
}

export interface AnalyticsTrendPoint {
  day: string;
  sourceId: string | null;
  subscriptionKey: string;
  subscriptionName: string;
  query: string;
  visibleCount: number;
  newCount: number;
  leftVisibleWindow: number;
  runCount: number;
  sourceCount: number;
  availableCount: number;
  soldOutCount: number;
  pricedCount: number;
  minPrice: number | null;
  medianPrice: number | null;
  averagePrice: number | null;
  maxPrice: number | null;
  scopeVersionId: string;
  scopeVersion: number;
  qualityGrade: AnalyticsQualityGrade;
  interpretable: boolean;
  warmup: boolean;
  expectedSourceCount: number;
  successfulSourceCount: number;
  failedSourceCount: number;
  staleSourceCount: number;
  coverageRate: number;
}

export interface AnalyticsSubscriptionSnapshot extends Omit<AnalyticsTrendPoint, "day"> {
  latestDay: string;
  previousVisible: number | null;
}

export interface AnalyticsCategorySnapshot {
  subscriptionKey: string;
  category: string;
  count: number;
}

export interface AnalyticsSourceMetric {
  subscriptionKey: string;
  sourceId: string;
  runCount: number;
  successfulRuns: number;
  resultCount: number;
  averageDurationMs: number | null;
  requestSuccessRate: number;
  parseSuccessRate: number;
  abnormalEmptyRuns: number;
  latestState: AnalyticsSourceHealthState | "unknown";
  latestObservedAt: string | null;
  freshnessSlaMinutes: number | null;
  fresh: boolean;
}

export interface AnalyticsDiscoveryListing {
  sourceId: string;
  sourceItemId: string;
  title: string;
  canonicalUrl: string;
  imageUrl: string | null;
  currentPrice: number | null;
  condition: string;
  availability: string;
  firstSeenAt: string;
  relevance: "relevant" | "uncertain";
  confidence: "high" | "medium" | "low";
  category: string | null;
  officialStatus: string | null;
}

export interface AnalyticsOverview {
  generatedAt: string;
  days: number;
  subscriptionKey: string | null;
  sourceId: string | null;
  summary: AnalyticsSummary;
  trends: AnalyticsTrendPoint[];
  subscriptions: AnalyticsSubscriptionSnapshot[];
  categories: AnalyticsCategorySnapshot[];
  sources: AnalyticsSourceMetric[];
  discoveries: AnalyticsDiscoveryListing[];
}

export interface MarketAnalysisDailyMetric {
  metricRef: string;
  day: string;
  sourceId: string;
  /** Optional only so reports saved before market-scope-v1 remain readable. New evidence always sets these fields. */
  qualityGrade?: AnalyticsQualityGrade;
  interpretable?: boolean;
  warmup?: boolean;
  expectedSourceCount?: number;
  successfulSourceCount?: number;
  failedSourceCount?: number;
  staleSourceCount?: number;
  coverageRate?: number;
  latestState?: AnalyticsSourceHealthState;
  visibleCount: number;
  rawNewCount: number;
  cleanedNewCount: number;
  relevantNewCount: number;
  irrelevantNewCount: number;
  uncertainNewCount: number;
  leftVisibleWindow: number;
  runCount: number;
  relevantAvailableCount: number;
  relevantSoldOutCount: number;
  relevantPricedCount: number;
  relevantMinPrice: number | null;
  relevantMedianPrice: number | null;
  relevantAveragePrice: number | null;
  relevantMaxPrice: number | null;
  categoryCounts: Record<string, number>;
  conditionCounts: Record<string, number>;
  officialStatusCounts: Record<string, number>;
  confidenceCounts: Record<string, number>;
}

export interface MarketAnalysisEvidence {
  subscriptionKey: string;
  subscriptionName: string;
  query: string;
  /** Optional only for backwards-compatible reads of reports generated before versioned market scopes. */
  scopeVersionId?: string;
  scopeVersion?: number;
  days: number;
  sourceId: string | null;
  evidenceStartedAt: string;
  evidenceEndedAt: string;
  coverage: {
    runCount: number;
    successfulSourceRuns: number;
    sourceCount: number;
    rawNewListingCount: number;
    cleanedNewListingCount: number;
    relevantNewListingCount: number;
    irrelevantNewListingCount: number;
    uncertainNewListingCount: number;
    pendingCleaningCount: number;
    dailyFactCount: number;
    cleaningProvider: string;
    cleaningModel: string;
    cleaningPromptVersion: string;
    truncated: boolean;
  };
  dailyBySource: MarketAnalysisDailyMetric[];
}

export interface MarketCleaningCandidate {
  firstSeenRunId: string;
  firstSeenAt: string;
  listing: Omit<AnalyticsListing, "productKey" | "productMatchMethod">;
}

