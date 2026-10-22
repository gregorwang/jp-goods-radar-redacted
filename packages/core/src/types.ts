export const SOURCE_IDS = [
  "rakuten_ichiba",
  "rakuten_books",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
  "amazon_jp",
  "ebay",
  "mercari_jp",
  "surugaya",
  "charaon",
  "cospa",
  "animate",
  "amiami",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];
export type SourceTransport = "official_api" | "internal_api" | "html_endpoint" | "managed_api" | "manual";
export type IdentityScope = "listing" | "catalog" | "offer";
export type ListingLifecycleKind = "one_off" | "replenishable" | "auction";
export type Coverage = "complete" | "rolling_window" | "best_effort" | "unknown";
/**
 * `mercari_service` 是历史名：它现在指 Vercel 东京适配服务；而新加坡 VPS 在当主路时（雅虎拍卖、
 * 乐天兜底、煤炉 primary 模式）沿用的也是它。`source_runner` 只用于"VPS 作为备路救回来"这一种
 * 结果记录（2026-10-08 煤炉兜底起），所以它只会出现在运行结果和分析表里，不会写进 source_registry
 * 那几列带 CHECK 约束的主路字段。
 */
export type SourceRequestRoute = "direct" | "mercari_service" | "vercel_service" | "managed_api" | "browser_run" | "source_runner";
export type MonitoringPurpose = "item_price" | "keyword_new_listing";
export const WATCH_DOSSIER_KINDS = ["item", "exact_product", "keyword"] as const;
export type WatchDossierKind = (typeof WATCH_DOSSIER_KINDS)[number];
export const OFFER_TRACKING_POLICIES = ["search_window", "all_confirmed_offers"] as const;
export type OfferTrackingPolicy = (typeof OFFER_TRACKING_POLICIES)[number];
/** 精确同款档案的送达门槛。判定档位描述系统怎么看一条候选，这个常量描述哪一档
 *  值得打扰人——两者永远不要焊死（AGENTS.md §4）。默认 `confirmed_only`。 */
export const SUSPECT_NOTICE_POLICIES = ["confirmed_only", "strong_suspects", "all_suspects"] as const;
export type SuspectNoticePolicy = (typeof SUSPECT_NOTICE_POLICIES)[number];
export const WATCH_LISTING_TRACKING_STATUSES = [
  "discovery_only",
  "anchor_known",
  "active",
  "unavailable_pending",
  "waiting_restock",
  "terminal",
  "dismissed",
  "purchased",
  "paused",
] as const;
export type WatchListingTrackingStatus = (typeof WATCH_LISTING_TRACKING_STATUSES)[number];
export const SEARCH_AVAILABILITY_MODES = ["purchasable", "all", "sold_out"] as const;
export type SearchAvailabilityMode = (typeof SEARCH_AVAILABILITY_MODES)[number];
export const SEARCH_SORTS = [
  "newest",
  "relevance",
  "price_asc",
  "price_desc",
  "ending_soon",
  "ending_late",
  "bids_desc",
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface SourceRouteFailureAttempt {
  attempt: number;
  code: string;
  status: number | null;
  message: string;
}

export interface SourceRouteFailureEvidence {
  code: string;
  status: number | null;
  retryable: boolean;
  message: string;
  attempts: SourceRouteFailureAttempt[];
}

export interface SourceRouteFailure {
  route: SourceRequestRoute;
  failure: SourceRouteFailureEvidence;
}

export type SearchRouteOutcome =
  | {
      kind: "primary_success";
      route: SourceRequestRoute;
    }
  | {
      kind: "fallback_success";
      primaryRoute: "direct";
      fallbackRoute: "mercari_service";
      primaryFailure: SourceRouteFailureEvidence;
      routeFailures: SourceRouteFailure[];
    }
  | {
      kind: "fallback_success";
      primaryRoute: "direct";
      fallbackRoute: "browser_run";
      primaryFailure: SourceRouteFailureEvidence;
      routeFailures: SourceRouteFailure[];
    }
  | {
      kind: "fallback_success";
      primaryRoute: "mercari_service";
      fallbackRoute: "source_runner";
      primaryFailure: SourceRouteFailureEvidence;
      routeFailures: SourceRouteFailure[];
    }
  | {
      kind: "fallback_success";
      primaryRoute: "direct" | "mercari_service";
      fallbackRoute: "managed_api";
      provider: "parse" | "firecrawl";
      cacheStatus: "hit" | "miss" | "mixed" | "unknown";
      searchQuery: string;
      queryNarrowed: boolean;
      primaryFailure: SourceRouteFailureEvidence;
      routeFailures: SourceRouteFailure[];
    };

export type ItemCondition = "new" | "used" | "collectible" | "refurbished" | "unknown";
export type Availability = "available" | "sold_out" | "unavailable" | "preorder" | "backorder" | "unknown";
export type EventType =
  | "new_listing"
  | "price_drop"
  | "price_rise"
  | "interest_rise"
  | "target_price"
  | "restock"
  | "sold_out"
  | "source_error"
  | "daily_digest"
  | "watch_completed"
  | "morning_digest"
  | "weekly_market_digest";

export interface ProductIdentifiers {
  jan?: string;
  isbn?: string;
  asin?: string;
  sku?: string;
  modelNumber?: string;
  sourceCatalogId?: string;
}

export interface ProductSpecification {
  name: string;
  value: string;
}

export const PRODUCT_DISPLAY_FACT_GROUPS = [
  "identity",
  "catalog",
  "commerce",
  "shipping",
  "seller",
  "other",
] as const;

export type ProductDisplayFactGroup = (typeof PRODUCT_DISPLAY_FACT_GROUPS)[number];

interface ProductDisplayFactBase {
  /** Stable within one listing so clients can render and de-duplicate facts predictably. */
  key: string;
  /** User-facing label already normalized by the source adapter. */
  label: string;
  group: ProductDisplayFactGroup;
}

/**
 * Bounded, presentation-safe source facts. Arbitrary diagnostics and upstream
 * payload fragments must stay in rawMetadata and are never rendered directly.
 */
export type ProductDisplayFact =
  | ProductDisplayFactBase & {
      kind: "text";
      value: string;
    }
  | ProductDisplayFactBase & {
      kind: "list";
      values: string[];
    };

export interface ProductVariant {
  name: string;
  value: string;
  availability?: Availability;
  priceJpy?: number;
}

export type ProductFactExtractionMethod = "official_api" | "internal_api" | "json_ld" | "html" | "managed_api";

export interface ProductFactProvenance {
  method: ProductFactExtractionMethod;
  sourceLabel?: string;
  confidence?: number;
}

export const PRICE_REFERENCE_KINDS = [
  "official_list",
  "source_compare_at",
] as const;

export const PRICE_TAX_STATUSES = [
  "included",
  "excluded",
  "unknown",
] as const;

export const PRICE_SHIPPING_STATUSES = [
  "included",
  "separate",
  "free",
  "unknown",
] as const;

export type PriceReferenceKind = (typeof PRICE_REFERENCE_KINDS)[number];
export type PriceTaxStatus = (typeof PRICE_TAX_STATUSES)[number];
export type PriceShippingStatus = (typeof PRICE_SHIPPING_STATUSES)[number];

/**
 * Source-declared context for the current listing price. Unknown is explicit:
 * downstream analysis must not silently assume that tax or shipping is included.
 */
export interface ListingPriceContext {
  taxStatus: PriceTaxStatus;
  shippingStatus: PriceShippingStatus;
}

/**
 * A reference price is not automatically the current acquisition price.
 * `official_list` requires an explicit source label such as 定価; crossed-out
 * marketplace prices remain `source_compare_at`.
 */
export interface PriceReferenceFact extends ListingPriceContext {
  kind: PriceReferenceKind;
  amountJpy: number;
  currency: "JPY";
  sourceLabel: string;
}

export const VERIFIED_SALE_EVIDENCE_VERSION = "verified-sale-v1" as const;
export const VERIFIED_SALE_EVIDENCE_KINDS = ["closed_auction_with_bid"] as const;

export interface VerifiedSaleEvidence {
  evidenceVersion: typeof VERIFIED_SALE_EVIDENCE_VERSION;
  kind: (typeof VERIFIED_SALE_EVIDENCE_KINDS)[number];
  sourceSaleId: string;
  soldPriceJpy: number;
  soldAt: string;
  bidCount: number;
  sourceStatus: "CLOSED";
}

/**
 * Source-independent product facts that are useful for identity, discovery and
 * monitoring. Source-specific diagnostics still belong in rawMetadata.
 */
export interface ProductFacts {
  identifiers?: ProductIdentifiers;
  brand?: string;
  manufacturer?: string;
  distributor?: string;
  workTitle?: string;
  series?: string;
  characters?: string[];
  categoryPath?: string[];
  tags?: string[];
  releaseDate?: string;
  preorderDeadline?: string;
  imageUrls?: string[];
  specifications?: ProductSpecification[];
  variants?: ProductVariant[];
  displayFacts?: ProductDisplayFact[];
  priceContext?: ListingPriceContext;
  priceReferences?: PriceReferenceFact[];
  sourceAvailabilityLabel?: string;
  sourceConditionLabel?: string;
  provenance?: Partial<Record<keyof Omit<ProductFacts, "provenance">, ProductFactProvenance>>;
}

export const LISTING_FIELD_NAMES = [
  "sourceItemId",
  "canonicalUrl",
  "title",
  "currentPrice",
  "imageUrl",
  "availability",
  "facts.identifiers.jan",
  "facts.identifiers.isbn",
  "facts.identifiers.asin",
  "facts.identifiers.sku",
  "facts.brand",
  "facts.manufacturer",
  "facts.workTitle",
  "facts.releaseDate",
  "facts.preorderDeadline",
  "facts.imageUrls",
  "facts.specifications",
  "facts.displayFacts",
] as const;

export type ListingFieldName = (typeof LISTING_FIELD_NAMES)[number];

export interface SourceFieldProfile {
  required: readonly ListingFieldName[];
  optional: readonly ListingFieldName[];
}

export interface SearchFilters {
  minPrice?: number;
  maxPrice?: number;
  conditions?: ItemCondition[];
  inStockOnly?: boolean;
  /** Explicit search intent. When omitted, legacy inStockOnly remains supported. */
  availabilityMode?: SearchAvailabilityMode;
  page?: number;
  pageSize?: number;
  sort?: SearchSort;
}

export interface SearchRequest {
  query: string;
  filters: SearchFilters;
  sourceConfig?: Record<string, unknown>;
}

export interface NormalizedListing {
  sourceId: SourceId;
  sourceItemId: string;
  identityScope: IdentityScope;
  canonicalUrl: string;
  title: string;
  descriptionExcerpt?: string;
  imageUrl?: string;
  sellerName?: string;
  shopName?: string;
  currency: "JPY" | string;
  currentPrice?: number;
  originalPrice?: number;
  /**
   * `auction_current_bid` 表示价格是进行中拍卖的当前出价，不是可成交的固定价。
   * 它会随竞价上涨，因此不能与一口价同池比较，也不能用来判定"达到目标价"。
   */
  priceBasis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid";
  condition: ItemCondition;
  availability: Availability;
  /** A date explicitly supplied by the source. It is never inferred by the radar. */
  sourceListedAt?: string;
  sourceUpdatedAt?: string;
  facts?: ProductFacts;
  rawMetadata?: Record<string, unknown>;
}

export interface SearchResult {
  sourceId: SourceId;
  listings: NormalizedListing[];
  coverage: Coverage;
  nextCursor?: string;
  totalAvailable?: number;
  warnings: string[];
  parserVersion: string;
  fetchedAt: string;
  requestEvidence?: {
    availabilityMode: SearchAvailabilityMode;
    requestedStatuses?: string[];
    rawResultCount: number;
    normalizedResultCount: number;
    pagesFetched: number;
    keywordRawResultCount?: number;
    liveDetailResultCount?: number;
    anchorCandidateCount?: number;
    parserAcceptedCount?: number;
    parserRejectedCount?: number;
    collectionOutcome?: "items" | "verified_empty";
  };
}

export interface SourceCapabilities {
  keywordSearch: boolean;
  itemLookup: boolean;
  newestSort: boolean;
  modificationTimeSort?: boolean;
  priceFilter: boolean;
  conditionFilter: boolean;
  supportsUsed: boolean;
  supportsSoldOut?: boolean;
  /** True only when the source has a real sold/transaction-history request path. */
  historySearchSupported: boolean;
  supportsMarketplace?: boolean;
}

export interface AdapterContext {
  signal?: AbortSignal;
  secrets: Partial<Record<string, string>>;
  fetch: typeof globalThis.fetch;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly transport: SourceTransport;
  readonly parserVersion: string;
  readonly coverage: Coverage;
  readonly capabilities: SourceCapabilities;
  readonly fieldProfile?: SourceFieldProfile;
  readonly healthcheckQuery?: string;
  readonly healthcheckSourceConfig?: Record<string, unknown>;
  search(request: SearchRequest, context: AdapterContext): Promise<SearchResult>;
  getItem?(urlOrId: string, context: AdapterContext): Promise<NormalizedListing>;
  /**
   * 单品详情能力可以细到单条商品：同一个来源里有些 ID 天生查不了（例如
   * Mercari Shops 商品不在 C2C 详情接口的服务范围内）。搜索仍能发现它们，
   * 但不该把它们排进每日详情复核 —— 那只会每天稳定失败一次。
   */
  canGetItem?(urlOrId: string): boolean;
}

export interface RunBindingJob {
  type: "run_binding";
  idempotencyKey?: string;
  bindingId: string;
  trigger: "cron" | "manual" | "retry" | "confirmation";
  queuedAt: string;
}

export interface ConfirmPriceDropJob {
  type: "confirm_price_drop";
  idempotencyKey?: string;
  bindingId: string;
  listingId: string;
  expectedOldPrice: number;
  candidateNewPrice: number;
  queuedAt: string;
}

export interface RunTrackedListingJob {
  type: "run_tracked_listing";
  idempotencyKey?: string;
  bindingId: string;
  listingId: string;
  trigger: "cron" | "manual" | "retry";
  queuedAt: string;
}

export interface IngestAnalyticsJob {
  type: "ingest_analytics";
  idempotencyKey?: string;
  outboxId: string;
  queuedAt: string;
}

export interface FinalizeKeywordDigestJob {
  type: "finalize_keyword_digest";
  idempotencyKey?: string;
  profileId: string;
  bindingIds: string[];
  /** Bindings that had not established a baseline when this scan was scheduled. */
  initialBaselineBindingIds?: string[];
  scanStartedAt: string;
  digestKey: string;
  finalizeAttempt: number;
  queuedAt: string;
}

/**
 * A bounded upstream response transported by an isolated adapter service.
 * Request headers and request bodies are intentionally not part of this type.
 */
export interface EmbeddedUpstreamResponseCapture {
  version: 1;
  requestUrl: string;
  responseUrl?: string;
  requestMethod: "GET" | "POST";
  responseStatus?: number;
  contentType?: string;
  rawPayload?: string;
  payloadBytes: number;
  contentHash: string;
  capturedAt: string;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

export interface GeminiJob {
  type: "gemini_job";
  idempotencyKey?: string;
  jobId: string;
  queuedAt: string;
}

export type MonitorJob =
  | RunBindingJob
  | RunTrackedListingJob
  | ConfirmPriceDropJob
  | IngestAnalyticsJob
  | FinalizeKeywordDigestJob;

export interface ListingState {
  price?: number;
  availability: Availability;
  stateHash?: string;
}

export interface EventCandidate {
  type: EventType;
  eventKey: string;
  payload: Record<string, unknown>;
}
