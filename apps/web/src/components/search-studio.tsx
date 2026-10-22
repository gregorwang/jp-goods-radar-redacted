"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  Fingerprint,
  Layers3,
  Languages,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { ItemCondition, NormalizedListing, ProductFingerprint, ProductSearchPlan, ProductTargetExtractionInput, SearchAvailabilityMode, SearchCandidateEvidence, SearchMode, SourceId } from "@jpgr/core";
import { assessProductMatch, buildProductPriceIntelligence, compareListingAvailability, compareProductSearchCandidates, fingerprintFromExtractedProductName, fingerprintFromListing, groupComparableListings, productFingerprintSupportsExactMatch, PRODUCT_MATCH_VERSION, PRODUCT_SEARCH_INTENT_VERSION } from "@jpgr/core";
import type { ListingEnrichment } from "@jpgr/validation";
import { apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import { EditorialSelect, type EditorialSelectOption } from "@/components/editorial-select";
import { MONITORING_INTERVAL_OPTIONS } from "@/components/monitoring-options";
import { isRakutenSource, RakutenCredit } from "@/components/rakuten-credit";
import { ProductPriceIntelligencePanel } from "@/components/product-price-intelligence";
import { initialSearchResultPresentation, searchRunStatus, sourceNames, type SearchHistoryItem, type SearchRunGroup as Group } from "@/lib/search-run";
import {
  enrichmentRequest,
  ListingResultCard,
  listingAvailabilityState,
  listingKey,
  shouldEnrich,
  type ListingAiState,
  type ListingWatchState,
  type ComparisonPosition,
} from "@/components/search-result-card";

const RESULT_PAGE_SIZE = 12;

async function extractProductTarget(canonicalName: string): Promise<ProductTargetExtractionInput | undefined> {
  type JobBody = { jobId: string; status: string; extraction: ProductTargetExtractionInput | null };
  try {
    const started = await apiFetch<JobBody>("/api/ai/product-target", {
      method: "POST",
      body: JSON.stringify({ canonicalName }),
    });
    if (started.extraction) return started.extraction;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 1_500); });
      const polled = await apiFetch<JobBody>(`/api/ai/product-target?jobId=${encodeURIComponent(started.jobId)}`);
      if (polled.extraction) return polled.extraction;
      if (polled.status === "failed") return undefined;
    }
  } catch {
    // AI is a recall improvement, never a prerequisite for running the search.
  }
  return undefined;
}

function mergedSearchTarget(
  canonicalName: string,
  manual: ProductFingerprint,
  extraction: ProductTargetExtractionInput,
): ProductFingerprint {
  const extracted = fingerprintFromExtractedProductName(canonicalName, extraction);
  return {
    ...extracted,
    ...(manual.referenceUrl ? { referenceUrl: manual.referenceUrl } : {}),
    ...(manual.workTitle ? { workTitle: manual.workTitle } : {}),
    characters: manual.characters.length > 0 ? manual.characters : extracted.characters,
    ...(manual.productType ? { productType: manual.productType } : {}),
    ...(manual.manufacturer ? { manufacturer: manual.manufacturer } : {}),
    ...(manual.series ? { series: manual.series } : {}),
    ...(manual.model ? { model: manual.model } : {}),
    ...(manual.jan ? { jan: manual.jan } : {}),
    ...(manual.size ? { size: manual.size } : {}),
    ...(manual.color ? { color: manual.color } : {}),
    edition: manual.edition.length > 0 ? manual.edition : extracted.edition,
    aliases: [...new Set([...manual.aliases, ...extracted.aliases])],
    recallQueries: [...new Set([...(manual.recallQueries ?? []), ...(extracted.recallQueries ?? [])])].slice(0, 4),
    requiredTermGroups: manual.requiredTermGroups ?? [],
    supportingTermGroups: manual.supportingTermGroups ?? [],
    excludedTerms: manual.excludedTerms,
  };
}

interface ExistingItemWatchRow {
  source_id: SourceId;
  source_item_id: string;
  watch_profile_id: string;
  binding_enabled: number;
  profile_enabled: number;
}

const sourceOptions = [
  { id: "rakuten_ichiba", label: "乐天市场", caption: "新品与店铺商品" },
  { id: "rakuten_books", label: "Rakuten Books", caption: "书籍、影像与音乐" },
  { id: "yahoo_shopping", label: "Yahoo! Shopping（实验）", caption: "公开 HTML 与有限分页" },
  { id: "yahoo_auctions_jp", label: "Yahoo!オークション（实验）", caption: "低频拍卖与成交窗口" },
  { id: "yahoo_fleamarket_jp", label: "Yahoo!フリマ", caption: "个人闲置与一口价商品" },
  { id: "mercari_jp", label: "Mercari", caption: "一口价、普通拍卖与 3 小时拍卖" },
  { id: "surugaya", label: "骏河屋", caption: "中古与收藏品" },
  { id: "amiami", label: "AmiAmi（あみあみ）", caption: "日文关键词、新品、预约与中古商品" },
  { id: "charaon", label: "CharaON", caption: "角色周边与预约商品" },
  { id: "cospa", label: "COSPA", caption: "官方服饰与角色商品" },
  { id: "animate", label: "Animate", caption: "通贩新品与预约商品" },
  { id: "amazon_jp", label: "Amazon Japan", caption: "日本亚马逊实时公开商品" },
] as const satisfies ReadonlyArray<{ id: SourceId; label: string; caption: string }>;

const hiddenSearchSourceIds = ["rakuten_books"] as const satisfies readonly SourceId[];

interface SourceState {
  id: SourceId;
  enabled: number;
  adapter_available: boolean;
  history_search_supported: boolean;
  health_status: string;
  monitoring_allowed: boolean;
  cooldown_until: string | null;
}

interface SearchInput {
  query: string;
  mode: SearchMode;
  target?: ProductFingerprint;
  searchSessionId?: string;
  sources: SourceId[];
  minPrice?: number;
  maxPrice?: number;
  conditions: ItemCondition[];
  availabilityMode: SearchAvailabilityMode;
  inStockOnly?: boolean;
  sourcePageTokens?: Partial<Record<SourceId, string>>;
}

interface SearchAiReview {
  selectionVersion: string;
  status: "staging" | "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed" | "not_needed" | "unavailable";
  jobId?: string;
  candidateKeys: string[];
  totalCandidates: number;
  directCandidates: number;
  reviewCandidates: number;
  queuedCandidates: number;
  manualOnlyCandidates: number;
  deterministicExcludedCandidates: number;
  skippedInvalidCandidates: number;
  model?: string;
  promptVersion?: string;
  completedItems: number;
  failedItems: number;
  totalItems: number;
  items?: Array<ListingEnrichment | null>;
  itemStatuses?: ListingJobItemStatus[];
  upstreamStatus?: number;
  error?: string;
}

interface SearchProductIdentity {
  productVariantId: string;
  canonicalProductId: string;
  comparisonProfileId: string;
  confirmedCount: number;
  rejectedCount: number;
  uncertainCount: number;
  projectedAt: string;
}

type ListingJobItemStatus = "queued" | "processing" | "waiting_rate_limit" | "completed" | "failed";

interface ListingJobResponse {
  jobId: string;
  status: "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed";
  items: Array<ListingEnrichment | null>;
  itemStatuses: ListingJobItemStatus[];
  model: string;
  taskPersisted: boolean;
}

function listingAiStatesFromReview(review: SearchAiReview | undefined): Record<string, ListingAiState> {
  if (!review) return {};
  const states: Record<string, ListingAiState> = {};
  review.candidateKeys.forEach((key, index) => {
    const enrichment = review.items?.[index] ?? undefined;
    const status = review.itemStatuses?.[index];
    states[key] = status === "completed" && enrichment
      ? { status: "ready", enrichment, scope: "listing" }
      : status === "failed" || review.status === "failed" || review.status === "unavailable"
        ? { status: "unavailable", scope: "listing" }
        : status === "waiting_rate_limit"
          ? { status: "waiting_rate_limit", scope: "listing" }
          : status === "processing"
            ? { status: "loading", scope: "listing" }
            : { status: "queued", scope: "listing" };
  });
  return states;
}

function listingAiStatesFromReviews(reviews: readonly SearchAiReview[]): Record<string, ListingAiState> {
  return Object.assign({}, ...reviews.map(listingAiStatesFromReview)) as Record<string, ListingAiState>;
}

function effectiveExactRelation(
  evidence: SearchCandidateEvidence | undefined,
  ai: ListingAiState | undefined,
  exactIdentitySupported: boolean,
) {
  const relation = evidence?.match?.relation ?? "uncertain";
  const relevance = ai?.enrichment?.relevance;
  if (relevance === "irrelevant") return "irrelevant" as const;
  if (relation === "probable_exact" && relevance === "relevant" && exactIdentitySupported) return "exact" as const;
  return relation;
}

/**
 * Which tab a candidate belongs to. The deterministic matcher can only prove
 * one SKU when the name carries a stable discriminator, so it leaves correct
 * listings at `related` whenever a seller wrote an abbreviated title. Gemini
 * has already judged those against the same target, and hiding a listing it
 * confirmed behind a second tab is what made a search look empty when the
 * wanted items were present. A positive model verdict therefore lands in the
 * confirmed lane alongside deterministic exact matches; the relation itself is
 * unchanged, so price intelligence and monitoring keep their stricter test.
 */
function resultMatchBucketOf(
  evidence: SearchCandidateEvidence | undefined,
  ai: ListingAiState | undefined,
  exactIdentitySupported: boolean,
): ResultMatchLane {
  const relation = effectiveExactRelation(evidence, ai, exactIdentitySupported);
  if (relation === "irrelevant") return "irrelevant";
  if (relation === "exact") return "exact";
  if (relation === "variant") return "variant";
  if (relation === "bundle") return "bundle";
  return ai?.enrichment?.relevance === "relevant" ? "exact" : "related";
}

function aiReviewConfirmsExact(
  groups: readonly Group[],
  plan: ProductSearchPlan | undefined,
  review: SearchAiReview | undefined,
): boolean {
  if (plan?.mode !== "exact_product") return false;
  const exactIdentitySupported = productFingerprintSupportsExactMatch(plan.target);
  const states = listingAiStatesFromReview(review);
  return groups.some((group) => group.listings.some((listing) => {
    // A restored snapshot may carry an assessment from an older matcher. Score
    // it again, exactly as the result lanes do, so the landing tab agrees with
    // the tab counts.
    const evidence = group.candidateEvidence?.[listing.sourceItemId];
    const match = plan.target && evidence && evidence.match?.version !== PRODUCT_MATCH_VERSION
      ? assessProductMatch(listing, plan.target, evidence.hits)
      : evidence?.match;
    return resultMatchBucketOf(
      evidence ? { ...evidence, ...(match ? { match } : {}) } : undefined,
      states[listingKey(listing)],
      exactIdentitySupported,
    ) === "exact";
  }));
}

function aiReviewsConfirmExact(
  groups: readonly Group[],
  plan: ProductSearchPlan | undefined,
  reviews: readonly SearchAiReview[],
): boolean {
  return reviews.some((review) => aiReviewConfirmsExact(groups, plan, review));
}

type SearchJobResponse =
  | { jobId: string; status: "queued" | "running"; plan?: ProductSearchPlan }
  | { jobId: string; status: "failed"; error: string }
  | {
      jobId: string;
      status: "completed";
      groups: Group[];
      historyId: string;
      sessionId: string;
      searchedAt: string;
      plan: ProductSearchPlan;
      ai?: SearchAiReview;
      productIdentity?: SearchProductIdentity;
    };

type CompletedSearchResponse = Extract<SearchJobResponse, { status: "completed" }>;
type LegacyCompletedSearchResponse = Omit<CompletedSearchResponse, "jobId" | "status">;

// signal 让页面卸载后停止轮询：原先离开 /search 会留下一个 2.5 秒一次、最长 5 分钟
// 的后台循环，持续打自己的 API。
async function durableSearch(input: SearchInput, signal: AbortSignal): Promise<CompletedSearchResponse> {
  const started = await apiFetch<SearchJobResponse | LegacyCompletedSearchResponse>("/api/search/preview", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  // Keep rolling deployments and stored browser sessions compatible with the
  // former synchronous endpoint while production moves to durable Workflows.
  if (!("status" in started)) {
    return { ...started, jobId: started.historyId, status: "completed" };
  }
  if (started.status === "failed") throw new Error(started.error);
  if (started.status === "completed") return started;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const current = await apiFetch<SearchJobResponse>(
        `/api/search/preview?jobId=${encodeURIComponent(started.jobId)}`,
        { signal },
      );
      if (current.status === "completed") return current;
      if (current.status === "failed") throw new Error(current.error);
    } catch (error) {
      if (error instanceof Error && !/Failed to fetch|network|fetch failed|search_job_not_found/i.test(error.message)) throw error;
    }
  }
  throw new Error("搜索仍在后台继续执行；完成后会自动出现在搜索记录中。");
}

type ResultView = "all" | "compare";
type ResultScope = "curated" | "manual";
type ResultSort = "relevance" | "price_asc" | "price_desc" | "newest" | "source";
type ResultMatchBucket = "all" | "exact" | "variant" | "bundle" | "related";
type ResultMatchLane = Exclude<ResultMatchBucket, "all"> | "irrelevant";
type ResultAvailability = "all" | "purchasable" | "trading" | "sold_out" | "unavailable";
type ResultCondition = "all" | ItemCondition;
type HistoryItemVerification =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listing: NormalizedListing };

const resultSortOptions = ["relevance", "price_asc", "price_desc", "newest", "source"] as const satisfies readonly ResultSort[];
const resultScopeOptions = ["curated", "manual"] as const satisfies readonly ResultScope[];
const resultAvailabilityOptions = ["all", "purchasable", "trading", "sold_out", "unavailable"] as const satisfies readonly ResultAvailability[];
const resultConditionOptions = ["all", "new", "used", "collectible", "refurbished", "unknown"] as const satisfies readonly ResultCondition[];
const searchAvailabilityModes = ["purchasable", "all", "sold_out"] as const satisfies readonly SearchAvailabilityMode[];

const requestModeOptions = [
  { value: "purchasable", label: "当前可购买", code: "on_sale_only" },
  { value: "all", label: "当前＋历史参考", code: "current_and_history" },
  { value: "sold_out", label: "已售出 / 交易中", code: "sold_history" },
] as const satisfies readonly EditorialSelectOption[];

const scopeFilterOptions = [
  { value: "curated", label: "整理后结果", code: "curated_results" },
  { value: "manual", label: "完整人工检索池", code: "manual_review_pool" },
] as const satisfies readonly EditorialSelectOption[];

const availabilityFilterOptions = [
  { value: "all", label: "全部状态", code: "all_statuses" },
  { value: "purchasable", label: "当前可购买", code: "available_now" },
  { value: "trading", label: "交易中", code: "trading" },
  { value: "sold_out", label: "已售出", code: "sold_out" },
  { value: "unavailable", label: "当前不可购买", code: "unavailable" },
] as const satisfies readonly EditorialSelectOption[];

const conditionFilterOptions = [
  { value: "all", label: "全部品相", code: "all_conditions" },
  { value: "new", label: "新品", code: "new" },
  { value: "used", label: "中古", code: "used" },
  { value: "collectible", label: "收藏品", code: "collectible" },
  { value: "unknown", label: "品相未确认", code: "unknown" },
] as const satisfies readonly EditorialSelectOption[];

const sortFilterOptions = [
  { value: "relevance", label: "目标匹配 · 来源相关度", code: "target_relevance" },
  { value: "price_asc", label: "在售优先 · 价格从低到高", code: "price_low_to_high" },
  { value: "price_desc", label: "在售优先 · 价格从高到低", code: "price_high_to_low" },
  { value: "newest", label: "来源日期从新到旧", code: "newest_first" },
  { value: "source", label: "按来源顺序", code: "source_order" },
] as const satisfies readonly EditorialSelectOption[];

const emptyProductFingerprint = (): ProductFingerprint => ({
  characters: [],
  edition: [],
  aliases: [],
  excludedTerms: [],
});

function commaSeparatedTerms(value: string): string[] {
  return [...new Set(value.split(/[、,，\n]/).map((term) => term.trim()).filter(Boolean))].slice(0, 12);
}

function includesOption<const T extends string>(options: readonly T[], value: string): value is T {
  return options.some((option) => option === value);
}

function isSourceId(value: string): value is SourceId {
  return sourceOptions.some((source) => source.id === value);
}

function isSearchSourceVisible(sourceId: SourceId): boolean {
  return !hiddenSearchSourceIds.some((hiddenSourceId) => hiddenSourceId === sourceId);
}

function mercariHistoryItemId(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^m\d{8,}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "jp.mercari.com" || url.username || url.password || url.port) return undefined;
    return url.pathname.match(/^\/item\/(m\d{8,})\/?$/i)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function requestedConditions(value: readonly ItemCondition[]): ItemCondition[] {
  return value.includes("new") && value.includes("used") ? [] : [...value];
}

function sourceAvailability(source: SourceState | undefined): { label: string; tone: "good" | "warn" | "bad" } {
  if (!source) return { label: "读取状态中", tone: "warn" };
  if (!source.enabled || !source.adapter_available) return { label: "暂未开放", tone: "bad" };
  if (source.cooldown_until && Date.parse(source.cooldown_until) > Date.now()) return { label: "暂时休息", tone: "warn" };
  if (source.health_status === "healthy") return { label: "可搜索", tone: "good" };
  return { label: "可尝试，近期不稳", tone: "warn" };
}

function sortTimestamp(item: NormalizedListing): number {
  const value = item.sourceListedAt ?? item.sourceUpdatedAt;
  return value ? Date.parse(value) || 0 : 0;
}

function listingPrice(item: NormalizedListing): number | undefined {
  return typeof item.currentPrice === "number" && Number.isFinite(item.currentPrice) && item.currentPrice > 0
    ? item.currentPrice
    : undefined;
}

function compareResultPrices(left: NormalizedListing, right: NormalizedListing, direction: "asc" | "desc" = "asc"): number {
  const availability = compareListingAvailability(left, right);
  if (availability !== 0) return availability;
  const leftPrice = listingPrice(left);
  const rightPrice = listingPrice(right);
  if (leftPrice === undefined && rightPrice !== undefined) return 1;
  if (leftPrice !== undefined && rightPrice === undefined) return -1;
  if (leftPrice === undefined || rightPrice === undefined) return 0;
  return direction === "asc" ? leftPrice - rightPrice : rightPrice - leftPrice;
}

function resultSort(
  mode: ResultSort,
  sourceOrder: ReadonlyMap<SourceId, number>,
): (left: NormalizedListing, right: NormalizedListing) => number {
  if (mode === "relevance") return (left, right) =>
    (sourceOrder.get(left.sourceId) ?? 99) - (sourceOrder.get(right.sourceId) ?? 99);
  if (mode === "price_asc") return compareResultPrices;
  if (mode === "price_desc") return (left, right) => compareResultPrices(left, right, "desc");
  if (mode === "newest") return (left, right) => compareListingAvailability(left, right)
    || sortTimestamp(right) - sortTimestamp(left)
    || compareResultPrices(left, right);
  return (left, right) => compareListingAvailability(left, right)
    || (sourceOrder.get(left.sourceId) ?? 99) - (sourceOrder.get(right.sourceId) ?? 99)
    || compareResultPrices(left, right);
}

export function SearchStudio({
  initialHistoryId,
  initialSeedQuery,
  initialReferenceUrl,
}: {
  initialHistoryId?: string;
  initialSeedQuery?: string;
  initialReferenceUrl?: string;
}) {
  const [query, setQuery] = useState(initialSeedQuery ?? "");
  const [searchMode, setSearchMode] = useState<SearchMode>("exact_product");
  const [productTarget, setProductTarget] = useState<ProductFingerprint>(() => ({
    ...emptyProductFingerprint(),
    ...(initialSeedQuery ? { canonicalName: initialSeedQuery } : {}),
    ...(initialReferenceUrl ? { referenceUrl: initialReferenceUrl } : {}),
  }));
  const [activePlan, setActivePlan] = useState<ProductSearchPlan>();
  const [sources, setSources] = useState<SourceId[]>([]);
  const [sourceStates, setSourceStates] = useState<SourceState[]>([]);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [conditions, setConditions] = useState<ItemCondition[]>(["new", "used"]);
  const [availabilityMode, setAvailabilityMode] = useState<SearchAvailabilityMode>("all");
  const [groups, setGroups] = useState<Group[]>([]);
  const [resultQuery, setResultQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resultView, setResultView] = useState<ResultView>("all");
  const [resultScope, setResultScope] = useState<ResultScope>("curated");
  const [resultSortMode, setResultSortMode] = useState<ResultSort>("relevance");
  const [resultMatchBucket, setResultMatchBucket] = useState<ResultMatchBucket>("all");
  const [resultSource, setResultSource] = useState<"all" | SourceId>("all");
  const [resultAvailability, setResultAvailability] = useState<ResultAvailability>("all");
  const [resultCondition, setResultCondition] = useState<ResultCondition>("all");
  const [resultPage, setResultPage] = useState(1);
  const [manualResultPage, setManualResultPage] = useState(1);
  const [activeSnapshot, setActiveSnapshot] = useState<string>();
  const [activeHistoryId, setActiveHistoryId] = useState<string>();
  const [activeProductIdentity, setActiveProductIdentity] = useState<SearchProductIdentity>();
  const [aiStates, setAiStates] = useState<Record<string, ListingAiState>>({});
  const [aiReviews, setAiReviews] = useState<SearchAiReview[]>([]);
  const [itemWatchStates, setItemWatchStates] = useState<Record<string, ListingWatchState>>({});
  const [itemWatchProfiles, setItemWatchProfiles] = useState<Record<string, string>>({});
  const [savedWatchInterval, setSavedWatchInterval] = useState("1440");
  const [savedWatchNextRun, setSavedWatchNextRun] = useState("");
  const [watchComposerOpen, setWatchComposerOpen] = useState(false);
  const [watchSaving, setWatchSaving] = useState(false);
  const [savedWatchProfileId, setSavedWatchProfileId] = useState<string>();
  const [loadingIntent, setLoadingIntent] = useState<"search" | "snapshot" | null>(null);
  const [pendingSearchInput, setPendingSearchInput] = useState<SearchInput>();
  const [activeSearchInput, setActiveSearchInput] = useState<SearchInput>();
  const [loadingMoreSource, setLoadingMoreSource] = useState<SourceId>();
  const [historyItemInput, setHistoryItemInput] = useState("");
  const [historyItemVerification, setHistoryItemVerification] = useState<HistoryItemVerification>({ status: "idle" });
  const aiGenerationRef = useRef(0);
  const aiRequestedKeysRef = useRef(new Set<string>());
  const aiRequestedJobIdsRef = useRef(new Set<string>());
  const aiPollTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  // 卸载时中止在途的搜索轮询；每次新搜索也会取消上一次。
  const searchAbortRef = useRef<AbortController | null>(null);

  function resetAiGeneration() {
    aiGenerationRef.current += 1;
    aiRequestedKeysRef.current.clear();
    aiRequestedJobIdsRef.current.clear();
    for (const timer of aiPollTimersRef.current) clearTimeout(timer);
    aiPollTimersRef.current.clear();
  }

  function appendAiReview(review: SearchAiReview | undefined) {
    if (!review) return;
    setAiReviews((current) => {
      const identity = review.jobId ?? `${review.selectionVersion}:${review.candidateKeys.join("|")}`;
      const withoutCurrent = current.filter((item) => (item.jobId ?? `${item.selectionVersion}:${item.candidateKeys.join("|")}`) !== identity);
      return [...withoutCurrent, review];
    });
  }

  function updateProductTarget<K extends keyof ProductFingerprint>(key: K, value: ProductFingerprint[K]) {
    setProductTarget((current) => ({ ...current, [key]: value }));
  }

  function changeSearchMode(mode: SearchMode) {
    setSearchMode(mode);
    setResultSortMode("relevance");
    setResultMatchBucket("all");
  }
  function toggleSource(id: SourceId) {
    setSources((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  }

  function toggleCondition(condition: ItemCondition) {
    setConditions((value) => value.includes(condition) ? value.filter((item) => item !== condition) : [...value, condition]);
  }

  async function runSearch(input: SearchInput) {
    const requestInput = { ...input, conditions: requestedConditions(input.conditions) };
    setLoadingIntent("search");
    setPendingSearchInput(requestInput);
    setWatchComposerOpen(false);
    setError("");
    setNotice("");
    try {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const result = await durableSearch(requestInput, controller.signal);
      const presentation = initialSearchResultPresentation(requestInput.mode, result.groups);
      const aiConfirmedExact = aiReviewConfirmsExact(result.groups, result.plan, result.ai);
      setGroups(result.groups);
      setActivePlan(result.plan);
      setSavedWatchProfileId(undefined);
      setActiveSearchInput(requestInput);
      setResultQuery(requestInput.query);
      setActiveSnapshot(undefined);
      setActiveHistoryId(result.sessionId ?? result.historyId);
      setActiveProductIdentity(result.productIdentity);
      setResultSource("all");
      setResultAvailability("all");
      setResultCondition("all");
      setResultSortMode("relevance");
      setResultMatchBucket(aiConfirmedExact ? "exact" : presentation.resultMatchBucket);
      setResultScope(presentation.resultScope);
      setResultPage(1);
      setManualResultPage(1);
      resetAiGeneration();
      setAiStates(listingAiStatesFromReview(result.ai));
      setAiReviews(result.ai ? [result.ai] : []);
      if (presentation.needsManualReview && !aiConfirmedExact) {
        setNotice("本次没有足够证据确认同款；已先展示相关 / 待复核候选，完整来源结果仍保留在人工检索池。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "搜索失败");
    } finally {
      setLoadingIntent(null);
      setPendingSearchInput(undefined);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const canonicalName = query.trim();
    let effectiveTarget: ProductFingerprint | undefined = searchMode === "exact_product"
      ? { ...productTarget, canonicalName }
      : undefined;
    if (searchMode === "exact_product") {
      setLoadingIntent("search");
      setNotice("正在理解商品身份并生成二手卖家可能使用的短查询…");
      const extraction = await extractProductTarget(canonicalName);
      if (extraction) effectiveTarget = mergedSearchTarget(canonicalName, productTarget, extraction);
    }
    await runSearch({
      query,
      mode: searchMode,
      ...(effectiveTarget ? { target: effectiveTarget } : {}),
      sources,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      conditions,
      availabilityMode,
      inStockOnly: availabilityMode === "purchasable",
    });
  }

  async function restoreSearch(historyId: string) {
    setLoadingIntent("snapshot");
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{
        history: SearchHistoryItem;
        groups: Group[];
        ai?: SearchAiReview;
        aiReviews?: SearchAiReview[];
        productIdentity?: SearchProductIdentity;
      }>(`/api/search/preview?historyId=${encodeURIComponent(historyId)}`);
      const restoredMode = result.history.mode ?? "keyword";
      const presentation = initialSearchResultPresentation(restoredMode, result.groups);
      const restoredAiReviews = result.aiReviews ?? (result.ai ? [result.ai] : []);
      const aiConfirmedExact = aiReviewsConfirmExact(result.groups, result.history.plan ?? undefined, restoredAiReviews);
      const nextConditions: ItemCondition[] = result.history.filters.conditions?.length
        ? result.history.filters.conditions
        : ["new", "used"];
      const restoredSources = result.history.sources.filter(isSearchSourceVisible);
      setQuery(result.history.query);
      setSearchMode(restoredMode);
      setProductTarget(result.history.target ?? emptyProductFingerprint());
      setSources(restoredSources);
      setMinPrice(result.history.filters.minPrice === null || result.history.filters.minPrice === undefined ? "" : String(result.history.filters.minPrice));
      setMaxPrice(result.history.filters.maxPrice === null || result.history.filters.maxPrice === undefined ? "" : String(result.history.filters.maxPrice));
      setConditions(nextConditions);
      setAvailabilityMode(result.history.filters.availabilityMode ?? (result.history.filters.inStockOnly ? "purchasable" : "all"));
      setGroups(result.groups);
      setActivePlan(result.history.plan ?? undefined);
      setSavedWatchProfileId(undefined);
      setActiveSearchInput({
        query: result.history.query,
        mode: result.history.mode ?? "keyword",
        ...(result.history.target ? { target: result.history.target } : {}),
        sources: restoredSources,
        minPrice: result.history.filters.minPrice ?? undefined,
        maxPrice: result.history.filters.maxPrice ?? undefined,
        conditions: nextConditions,
        availabilityMode: result.history.filters.availabilityMode ?? (result.history.filters.inStockOnly ? "purchasable" : "all"),
        inStockOnly: result.history.filters.inStockOnly,
      });
      setResultQuery(result.history.query);
      setActiveSnapshot(result.history.id);
      setActiveHistoryId(result.history.id);
      setActiveProductIdentity(result.productIdentity);
      setResultSource("all");
      setResultAvailability("all");
      setResultCondition("all");
      setResultSortMode("relevance");
      setResultMatchBucket(aiConfirmedExact ? "exact" : presentation.resultMatchBucket);
      setResultScope(presentation.resultScope);
      setResultPage(1);
      setManualResultPage(1);
      resetAiGeneration();
      setAiStates(listingAiStatesFromReviews(restoredAiReviews));
      setAiReviews(restoredAiReviews);
      setNotice(presentation.needsManualReview && !aiConfirmedExact
        ? `本次没有足够证据确认同款；已先展示相关 / 待复核候选。已恢复 ${tokyoFull(result.history.searchedAt)} 的 ${result.history.resultCount} 件搜索结果，没有重新访问来源。`
        : `已恢复 ${tokyoFull(result.history.searchedAt)} 的 ${result.history.resultCount} 件搜索结果，没有重新访问来源。`);
      requestAnimationFrame(() => document.getElementById("search-results")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "历史结果读取失败");
    } finally {
      setLoadingIntent(null);
    }
  }

  const restoreInitialHistory = useEffectEvent((historyId: string) => {
    void restoreSearch(historyId);
  });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      apiFetch<{ items: SourceState[] }>("/api/sources", { signal: controller.signal }),
      apiFetch<{ items: ExistingItemWatchRow[] }>("/api/item-watches", { signal: controller.signal }),
    ])
      .then(([sourceBody, itemWatchBody]) => {
        setSourceStates(sourceBody.items);
        const healthy = sourceBody.items.filter((source) => isSearchSourceVisible(source.id) && source.enabled && source.adapter_available && source.health_status === "healthy").map((source) => source.id);
        const available = sourceBody.items.filter((source) => isSearchSourceVisible(source.id) && source.enabled && source.adapter_available).map((source) => source.id);
        const preferred = healthy.length > 0 ? healthy : available;
        if (preferred.length > 0) setSources(preferred);
        setItemWatchStates(Object.fromEntries(itemWatchBody.items.map((watch) => [
          `${watch.source_id}:${watch.source_item_id}`,
          watch.binding_enabled === 1 && watch.profile_enabled === 1 ? "saved" : "paused",
        ])));
        setItemWatchProfiles(Object.fromEntries(itemWatchBody.items.map((watch) => [
          `${watch.source_id}:${watch.source_item_id}`,
          watch.watch_profile_id,
        ])));
        if (initialHistoryId) restoreInitialHistory(initialHistoryId);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [initialHistoryId]);

  async function createWatchDossier() {
    if (watchSaving) return;
    const savedMode = activePlan?.mode ?? searchMode;
    const savedQuery = activePlan?.originalQuery ?? activeSearchInput?.query ?? query;
    const savedTarget = activePlan?.target ?? activeSearchInput?.target ?? productTarget;
    const savedSources = activeSearchInput?.sources ?? sources;
    const savedMinPrice = activeSearchInput?.minPrice ?? (minPrice ? Number(minPrice) : undefined);
    const savedMaxPrice = activeSearchInput?.maxPrice ?? (maxPrice ? Number(maxPrice) : undefined);
    const savedConditions = activeSearchInput?.conditions ?? conditions;
    const savedAvailabilityMode = activeSearchInput?.availabilityMode ?? availabilityMode;
    const exactIdentity = savedMode === "exact_product" && activeProductIdentity && activeHistoryId
      ? {
          productVariantId: activeProductIdentity.productVariantId,
          productIdentitySearchHistoryId: activeHistoryId,
        }
      : undefined;
    if (savedMode === "exact_product" && !exactIdentity) {
      setError("本次结果还没有形成稳定商品身份，暂时不能建立精确同款监控。");
      return;
    }
    const knownOffers = savedMode === "exact_product"
      ? groups.flatMap((group) => group.listings.flatMap((listing) => {
          const key = listingKey(listing);
          if (!itemWatchProfiles[key]) return [];
          const evidence = group.candidateEvidence?.[listing.sourceItemId];
          const match = evidence?.match?.version === PRODUCT_MATCH_VERSION
            ? evidence.match
            : assessProductMatch(listing, savedTarget, evidence?.hits);
          const relation = effectiveExactRelation(
            evidence ? { ...evidence, match } : {
              match,
              hits: [],
              fusedScore: 0,
              bestRank: Number.MAX_SAFE_INTEGER,
              historical: false,
              liveVerified: false,
            },
            aiStates[key],
            productFingerprintSupportsExactMatch(savedTarget),
          );
          return relation === "exact"
            ? [{ source: listing.sourceId, sourceItemId: listing.sourceItemId }]
            : [];
        }))
      : [];
    const uniqueKnownOffers = [...new Map(
      knownOffers.map((offer) => [`${offer.source}:${offer.sourceItemId}`, offer] as const),
    ).values()];
    setWatchSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ id: string; pausedBindings: number }>("/api/watch-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: savedQuery.slice(0, 120),
          dossierKind: savedMode === "exact_product" ? "exact_product" : "keyword",
          ...exactIdentity,
          offerTrackingPolicy: savedMode === "exact_product" ? "all_confirmed_offers" : undefined,
          knownOffers: uniqueKnownOffers,
          defaultMaxPrice: savedMaxPrice,
          includeTerms: [],
          excludeTerms: [],
          bindings: savedSources.map((source) => ({
            source,
            kind: "keyword",
            monitoringPurpose: "keyword_new_listing",
            query: savedQuery,
            intervalMinutes: Number(savedWatchInterval),
            nextRunAt: savedWatchNextRun ? new Date(savedWatchNextRun).toISOString() : undefined,
            sourceConfig: {
              pages: savedMode === "exact_product" ? 1 : 2,
              ...(savedMode === "exact_product" ? {
                searchMode: "exact_product",
                productTarget: savedTarget,
                matchVersion: PRODUCT_MATCH_VERSION,
                intentKind: activePlan?.intentKind ?? "named_product",
                intentVersion: activePlan?.intentVersion ?? PRODUCT_SEARCH_INTENT_VERSION,
                deepSearch: false,
                // A saved target price and the preview's shopping filters are
                // notification/view rules. Exact-product watches collect the
                // complete identity evidence window first.
                availabilityMode: "all",
                inStockOnly: false,
              } : {
                minPrice: savedMinPrice,
                maxPrice: savedMaxPrice,
                conditions: savedConditions,
                availabilityMode: "purchasable",
                inStockOnly: true,
              }),
            },
          })),
        }),
      });
      const historyNote = savedAvailabilityMode === "sold_out" ? "历史筛选不会进入监控；档案只巡回当前可购买商品。" : "";
      setNotice(result.pausedBindings > 0
        ? `关注档案已建立；其中 ${result.pausedBindings} 个来源暂时只保留条件，不会定时运行。${historyNote}`
        : savedMode === "exact_product"
          ? `精确同款关注档案已建立：${uniqueKnownOffers.length > 0 ? `${uniqueKnownOffers.length} 条已有单品关注已作为已知报价去重；` : ""}新确认同款会按相同周期持续检查价格，低于目标价时触发提醒。${historyNote}`
          : `关键词上新关注档案已建立，每 ${savedWatchInterval} 分钟巡回；第一次只建立基线。${historyNote}`,
      );
      setSavedWatchProfileId(result.id);
      setWatchComposerOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setWatchSaving(false);
    }
  }

  function openWatchComposer() {
    if (activePlan?.mode === "exact_product" && (!activeProductIdentity || !activeHistoryId)) {
      setError("本次结果还没有形成稳定商品身份，暂时不能建立精确同款监控。");
      return;
    }
    setWatchComposerOpen(true);
    requestAnimationFrame(() => document.getElementById("search-watch-composer")?.scrollIntoView({ block: "center" }));
  }

  function changeAvailabilityMode(value: string) {
    if (!includesOption(searchAvailabilityModes, value)) return;
    setAvailabilityMode(value);
    if (value === "sold_out") {
      const mercari = sourceStates.find((source) => source.id === "mercari_jp");
      setSources(mercari?.enabled && mercari.adapter_available ? ["mercari_jp"] : []);
    }
  }

  async function verifyKnownHistoryItem() {
    const sourceItemId = mercariHistoryItemId(historyItemInput);
    if (!sourceItemId) {
      setHistoryItemVerification({ status: "error", message: "请输入 m 开头的 Mercari 商品 ID，或完整的 jp.mercari.com/item/… 链接。" });
      return;
    }
    setHistoryItemVerification({ status: "loading" });
    try {
      const result = await apiFetch<{ listing: NormalizedListing }>("/api/search/item-preview", {
        method: "POST",
        body: JSON.stringify({
          source: "mercari_jp",
          sourceItemId,
          targetUrl: `https://jp.mercari.com/item/${sourceItemId}`,
        }),
      });
      if (result.listing.sourceId !== "mercari_jp" || result.listing.sourceItemId.toLowerCase() !== sourceItemId) {
        throw new Error("Mercari 返回的商品标识与输入不一致");
      }
      const availabilityState = listingAvailabilityState(result.listing);
      if (availabilityState !== "sold_out" && availabilityState !== "trading") {
        setHistoryItemVerification({ status: "error", message: "这条商品当前不是已售出 / 交易中状态，没有加入历史候选。" });
        return;
      }
      setHistoryItemVerification({ status: "ready", listing: result.listing });
    } catch (reason) {
      setHistoryItemVerification({ status: "error", message: reason instanceof Error ? reason.message : "历史商品实时核验失败" });
    }
  }

  async function loadNextSourcePage(group: Group) {
    if (!group.nextCursor || !activeSearchInput || !activeHistoryId || loadingMoreSource) return;
    setLoadingMoreSource(group.sourceId);
    setError("");
    try {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const result = await durableSearch({
        ...activeSearchInput,
        searchSessionId: activeHistoryId,
        sources: [group.sourceId],
        sourcePageTokens: { [group.sourceId]: group.nextCursor },
      }, controller.signal);
      const next = result.groups[0];
      if (!next) throw new Error("来源没有返回下一页");
      setGroups((currentGroups) => currentGroups.map((current) => {
        if (current.sourceId !== group.sourceId) return current;
        const seen = new Set<string>();
        const listings = [...current.listings, ...next.listings].filter((item) => {
          const key = `${item.sourceId}:${item.sourceItemId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const warnings = [...new Set([...(current.warnings ?? []), ...(next.warnings ?? [])])];
        const requestEvidence = current.requestEvidence && next.requestEvidence
          ? {
              ...next.requestEvidence,
              rawResultCount: current.requestEvidence.rawResultCount + next.requestEvidence.rawResultCount,
              normalizedResultCount: listings.length,
              pagesFetched: current.requestEvidence.pagesFetched + next.requestEvidence.pagesFetched,
              keywordRawResultCount: (current.requestEvidence.keywordRawResultCount ?? 0)
                + (next.requestEvidence.keywordRawResultCount ?? 0),
              liveDetailResultCount: (current.requestEvidence.liveDetailResultCount ?? 0)
                + (next.requestEvidence.liveDetailResultCount ?? 0),
              anchorCandidateCount: (current.requestEvidence.anchorCandidateCount ?? 0)
                + (next.requestEvidence.anchorCandidateCount ?? 0),
            }
          : next.requestEvidence ?? current.requestEvidence;
        return {
          ...next,
          status: listings.length > 0 ? "success" : next.status,
          listings,
          warnings,
          requestEvidence,
          candidateEvidence: { ...(current.candidateEvidence ?? {}), ...(next.candidateEvidence ?? {}) },
        };
      }));
      appendAiReview(result.ai);
      if (result.productIdentity) setActiveProductIdentity(result.productIdentity);
      setActiveSnapshot(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下一页读取失败");
    } finally {
      setLoadingMoreSource(undefined);
    }
  }

  async function watchItem(item: NormalizedListing) {
    if (item.sourceId === "yahoo_shopping") {
      setNotice("Yahoo 实验来源当前只支持关键词搜索与关键词关注，尚不提供稳定的单品回查。");
      return;
    }
    const key = listingKey(item);
    setNotice("");
    setItemWatchStates((states) => ({ ...states, [key]: "saving" }));
    try {
      const result = await apiFetch<{ paused: boolean; alreadyWatching: boolean; profileId: string }>("/api/item-watches", {
        method: "POST",
        body: JSON.stringify({
          name: item.title.slice(0, 120),
          source: item.sourceId,
          sourceItemId: item.sourceItemId,
          targetUrl: item.canonicalUrl,
          identityScope: item.identityScope,
          availability: listingAvailabilityState(item),
          monitoringPurpose: "item_price",
          intervalMinutes: 180,
          minDropAmount: 100,
        }),
      });
      setItemWatchStates((states) => ({ ...states, [key]: result.paused ? "paused" : "saved" }));
      setItemWatchProfiles((profiles) => ({ ...profiles, [key]: result.profileId }));
      setNotice(result.alreadyWatching
        ? "这个来源商品 ID 已经有关注，未重复创建。可进入关注档案修改频率与提醒条件。"
        : result.paused
          ? "商品关注已保存；该来源恢复后开始巡回。默认每 3 小时，可在关注档案精确修改。"
          : "商品关注已建立；默认每 3 小时巡回，第一次只记录价格与库存基线。",
      );
    } catch (reason) {
      setItemWatchStates((states) => ({ ...states, [key]: "idle" }));
      const message = reason instanceof Error ? reason.message : "保存失败";
      setNotice(message === "terminal_listing_requires_product_radar"
        ? "这件来源商品已经售出或交易中，不能建立单品降价监控；请改用同款上新雷达。"
        : message);
    }
  }

  function findSimilar(item: NormalizedListing) {
    const fingerprint = fingerprintFromListing(item);
    const anchorQuery = [fingerprint.characters[0], fingerprint.productType, fingerprint.workTitle]
      .filter(Boolean).join(" ").trim();
    setSearchMode("exact_product");
    setProductTarget(fingerprint);
    setQuery((anchorQuery || item.title).slice(0, 200));
    setResultSortMode("relevance");
    setResultMatchBucket("all");
    setNotice(`已把 ${sourceNames[item.sourceId]} · ${item.sourceItemId} 设为同款锚点。可补充缺失的厂商、型号或尺寸后重新搜索。`);
    requestAnimationFrame(() => document.getElementById("search-mode-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const listings = useMemo(() => groups.flatMap((group) => group.listings), [groups]);
  const exactResultMode = activePlan?.mode === "exact_product";
  const exactIdentitySupported = exactResultMode && productFingerprintSupportsExactMatch(activePlan?.target);
  const candidateEvidenceByKey = useMemo(() => new Map<string, SearchCandidateEvidence>(groups.flatMap((group) =>
    group.listings.flatMap((listing) => {
      const evidence = group.candidateEvidence?.[listing.sourceItemId];
      if (!evidence) return [];
      const match = exactResultMode && activePlan?.target && evidence.match?.version !== PRODUCT_MATCH_VERSION
        ? assessProductMatch(listing, activePlan.target, evidence.hits)
        : evidence.match;
      return [[`${group.sourceId}:${listing.sourceItemId}`, { ...evidence, ...(match ? { match } : {}) }] as const];
    }),
  )), [activePlan, exactResultMode, groups]);
  const loading = loadingIntent !== null;
  const searching = loadingIntent === "search";
  const unavailableGroups = groups.filter((group) => group.status === "failed" || group.status === "disabled" || group.status === "cooldown");
  const sourceOrder = useMemo(() => new Map(groups.map((group, index) => [group.sourceId, index])), [groups]);
  const sortedListings = useMemo(
    () => [...listings].sort((left, right) => resultSortMode === "relevance" && exactResultMode
      ? compareProductSearchCandidates(candidateEvidenceByKey.get(listingKey(left)), candidateEvidenceByKey.get(listingKey(right)))
      : resultSort(resultSortMode, sourceOrder)(left, right)),
    [candidateEvidenceByKey, exactResultMode, listings, resultSortMode, sourceOrder],
  );
  const workflowAiCandidateKeys = useMemo(
    () => new Set(aiReviews.flatMap((review) => review.candidateKeys)),
    [aiReviews],
  );
  const manualPoolListings = useMemo(() => sortedListings.filter((item) => {
    if (resultSource !== "all" && item.sourceId !== resultSource) return false;
    if (resultCondition !== "all" && item.condition !== resultCondition) return false;
    if (resultAvailability === "purchasable" && !["available", "preorder", "backorder"].includes(item.availability)) return false;
    const availabilityState = listingAvailabilityState(item);
    if (resultAvailability === "trading" && availabilityState !== "trading") return false;
    if (resultAvailability === "sold_out" && availabilityState !== "sold_out") return false;
    if (resultAvailability === "unavailable" && availabilityState !== "unavailable") return false;
    return true;
  }), [resultAvailability, resultCondition, resultSource, sortedListings]);
  const confirmedExactListings = useMemo(() => exactResultMode
    ? manualPoolListings.filter((item) => {
        const key = listingKey(item);
        return effectiveExactRelation(candidateEvidenceByKey.get(key), aiStates[key], exactIdentitySupported) === "exact";
      })
    : [], [aiStates, candidateEvidenceByKey, exactIdentitySupported, exactResultMode, manualPoolListings]);
  const priceIntelligence = useMemo(
    () => confirmedExactListings.length > 0 ? buildProductPriceIntelligence(confirmedExactListings) : undefined,
    [confirmedExactListings],
  );
  const filteredListings = useMemo(() => manualPoolListings.filter((item) => {
    const key = listingKey(item);
    const evidence = candidateEvidenceByKey.get(key);
    if (exactResultMode) {
      // The default exact lane contains deterministic exact matches plus items
      // Gemini has positively confirmed. Candidates still awaiting a verdict,
      // or left unreviewed because the AI job was capped, stay in the related
      // lane and in the complete manual list.
      const lane = resultMatchBucketOf(evidence, aiStates[key], exactIdentitySupported);
      if (lane === "irrelevant") return false;
      if (resultMatchBucket !== "all" && lane !== resultMatchBucket) return false;
    } else {
      if (aiReviews.length > 0 && !workflowAiCandidateKeys.has(key)) return false;
      if (aiStates[key]?.enrichment?.relevance === "irrelevant") return false;
    }
    return true;
  }), [aiReviews.length, aiStates, candidateEvidenceByKey, exactIdentitySupported, exactResultMode, manualPoolListings, resultMatchBucket, workflowAiCandidateKeys]);
  const resultPageCount = Math.max(1, Math.ceil(filteredListings.length / RESULT_PAGE_SIZE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const pagedListings = useMemo(
    () => filteredListings.slice((currentResultPage - 1) * RESULT_PAGE_SIZE, currentResultPage * RESULT_PAGE_SIZE),
    [currentResultPage, filteredListings],
  );
  const manualResultPageCount = Math.max(1, Math.ceil(manualPoolListings.length / RESULT_PAGE_SIZE));
  const currentManualResultPage = Math.min(manualResultPage, manualResultPageCount);
  const manualPagedListings = useMemo(
    () => manualPoolListings.slice((currentManualResultPage - 1) * RESULT_PAGE_SIZE, currentManualResultPage * RESULT_PAGE_SIZE),
    [currentManualResultPage, manualPoolListings],
  );
  const soldReferenceCount = useMemo(
    () => listings.filter((item) => ["trading", "sold_out", "unavailable"].includes(listingAvailabilityState(item))).length,
    [listings],
  );
  const comparisonGroups = useMemo(() => groupComparableListings(filteredListings), [filteredListings]);
  const repeatedGroups = useMemo(
    () => {
      if (exactResultMode) {
        const exactListings = filteredListings.filter((item) => effectiveExactRelation(
          candidateEvidenceByKey.get(listingKey(item)),
          aiStates[listingKey(item)],
          exactIdentitySupported,
        ) === "exact");
        const byCondition = new Map<NormalizedListing["condition"], NormalizedListing[]>();
        for (const listing of exactListings) {
          const group = byCondition.get(listing.condition);
          if (group) group.push(listing);
          else byCondition.set(listing.condition, [listing]);
        }
        return [...byCondition].filter(([, listings]) => listings.length > 1)
          .map(([condition, listings]) => ({
            identity: { key: `exact-search-target:${condition}`, method: "identifier" as const },
            condition,
            listings: [...listings].sort(compareResultPrices),
          }));
      }
      return comparisonGroups.filter((group) => group.listings.length > 1)
        .sort((left, right) => right.listings.length - left.listings.length || compareResultPrices(left.listings[0]!, right.listings[0]!));
    },
    [aiStates, candidateEvidenceByKey, comparisonGroups, exactIdentitySupported, exactResultMode, filteredListings],
  );
  const repeatedKeys = useMemo(
    () => new Set(repeatedGroups.flatMap((group) => group.listings.map(listingKey))),
    [repeatedGroups],
  );
  const singleListings = useMemo(
    () => filteredListings.filter((item) => !repeatedKeys.has(listingKey(item))),
    [filteredListings, repeatedKeys],
  );
  const comparisonPositions = useMemo(() => {
    const positions = new Map<string, ComparisonPosition>();
    for (const group of repeatedGroups) {
      group.listings.forEach((item, index) => positions.set(listingKey(item), {
        position: index + 1,
        total: group.listings.length,
        method: group.identity.method,
      }));
    }
    return positions;
  }, [repeatedGroups]);
  const aiCandidates = useMemo(
    () => listings.filter((item) => exactResultMode
      ? workflowAiCandidateKeys.has(listingKey(item))
      : aiReviews.length > 0
        ? workflowAiCandidateKeys.has(listingKey(item))
        : shouldEnrich(item)),
    [aiReviews.length, exactResultMode, listings, workflowAiCandidateKeys],
  );
  const aiBatchStatus = useMemo<"idle" | "loading" | "ready" | "partial" | "unavailable">(() => {
    if (aiCandidates.length === 0) {
      return exactResultMode && aiReviews.some((review) => review.status === "unavailable" || review.status === "failed")
        ? "unavailable"
        : "idle";
    }
    const statuses = aiCandidates.map((item) => aiStates[listingKey(item)]?.status);
    if (statuses.every((status) => status === "ready")) return "ready";
    if (statuses.every((status) => status === "unavailable")) return "unavailable";
    if (statuses.every((status) => status === "ready" || status === "unavailable")) return "partial";
    return "loading";
  }, [aiCandidates, aiReviews, aiStates, exactResultMode]);
  const hiddenIrrelevantCount = useMemo(
    () => exactResultMode
      ? listings.filter((item) => candidateEvidenceByKey.get(listingKey(item))?.match?.relation === "irrelevant"
        || aiStates[listingKey(item)]?.enrichment?.relevance === "irrelevant").length
      : listings.filter((item) => aiStates[listingKey(item)]?.enrichment?.relevance === "irrelevant").length,
    [aiStates, candidateEvidenceByKey, exactResultMode, listings],
  );
  const matchBucketCounts = useMemo(() => {
    const counts = { exact: 0, variant: 0, bundle: 0, related: 0 };
    for (const item of listings) {
      const key = listingKey(item);
      const lane = resultMatchBucketOf(candidateEvidenceByKey.get(key), aiStates[key], exactIdentitySupported);
      if (lane !== "irrelevant") counts[lane] += 1;
    }
    return counts;
  }, [aiStates, candidateEvidenceByKey, exactIdentitySupported, listings]);
  const aiReadyCount = useMemo(
    () => aiCandidates.filter((item) => aiStates[listingKey(item)]?.status === "ready").length,
    [aiCandidates, aiStates],
  );
  const sourceFilterOptions = useMemo<readonly EditorialSelectOption[]>(() => [
    { value: "all", label: `全部来源 · ${listings.length} 件`, code: "all_sources" },
    ...groups.map((group) => ({
      value: group.sourceId,
      label: `${sourceNames[group.sourceId]} · ${group.listings.length} 件`,
      code: group.status === "failed" || group.status === "cooldown" ? "unavailable" : group.sourceId,
    })),
  ], [groups, listings.length]);

  useEffect(() => () => {
    aiGenerationRef.current += 1;
    for (const timer of aiPollTimersRef.current) clearTimeout(timer);
    aiPollTimersRef.current.clear();
    searchAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!exactResultMode) return;
    const generation = aiGenerationRef.current;
    for (const review of aiReviews) {
      const identity = review.jobId ?? `unavailable:${review.selectionVersion}:${review.candidateKeys.join("|")}`;
      if (aiRequestedJobIdsRef.current.has(identity)) continue;
      aiRequestedJobIdsRef.current.add(identity);
      const candidateKeys = review.candidateKeys;
      if (["completed", "partial", "failed"].includes(review.status) && review.itemStatuses) {
        queueMicrotask(() => {
          if (generation !== aiGenerationRef.current) return;
          setAiStates((value) => ({ ...value, ...listingAiStatesFromReview(review) }));
        });
        continue;
      }
      if (!review.jobId) {
        queueMicrotask(() => {
          if (generation !== aiGenerationRef.current) return;
          setAiStates((value) => {
            const next = { ...value };
            for (const key of candidateKeys) next[key] = { status: "unavailable", scope: "listing" };
            return next;
          });
        });
        continue;
      }

      queueMicrotask(() => {
        if (generation !== aiGenerationRef.current) return;
        setAiStates((value) => {
          const next = { ...value };
          for (const key of candidateKeys) {
            if (next[key]?.status !== "ready") next[key] = { status: "queued", scope: "listing" };
          }
          return next;
        });
      });

      const applyJob = (job: ListingJobResponse) => {
        if (generation !== aiGenerationRef.current) return;
        setAiStates((value) => {
          const next = { ...value };
          candidateKeys.forEach((key, index) => {
            const enrichment = job.items[index] ?? undefined;
            const status = job.itemStatuses[index] ?? "queued";
            next[key] = status === "completed" && enrichment
              ? { status: "ready", enrichment, scope: "listing" }
              : status === "failed"
                ? { status: "unavailable", scope: "listing" }
                : status === "waiting_rate_limit"
                  ? { status: "waiting_rate_limit", scope: "listing" }
                  : status === "processing"
                    ? { status: "loading", scope: "listing" }
                    : { status: "queued", scope: "listing" };
          });
          return next;
        });
      };

      const poll = async (jobId: string) => {
        if (generation !== aiGenerationRef.current) return;
        try {
          const job = await apiFetch<ListingJobResponse>(
            `/api/ai/listing-enrichment?jobId=${encodeURIComponent(jobId)}`,
          );
          applyJob(job);
          if (["completed", "partial", "failed"].includes(job.status)) {
            if (activeHistoryId) {
              const timer = setTimeout(() => {
                aiPollTimersRef.current.delete(timer);
                void apiFetch<{ productIdentity?: SearchProductIdentity }>(
                  `/api/search/preview?productIdentityHistoryId=${encodeURIComponent(activeHistoryId)}`,
                ).then((result) => {
                  if (generation === aiGenerationRef.current && result.productIdentity) {
                    setActiveProductIdentity(result.productIdentity);
                  }
                }).catch(() => undefined);
              }, 1_000);
              aiPollTimersRef.current.add(timer);
            }
            return;
          }
        } catch {
          // The Workflow-linked queue remains the retry owner if this poll fails.
        }
        if (generation === aiGenerationRef.current) {
          const timer = setTimeout(() => {
            aiPollTimersRef.current.delete(timer);
            void poll(jobId);
          }, 2_500);
          aiPollTimersRef.current.add(timer);
        }
      };

      void poll(review.jobId);
    }
  }, [activeHistoryId, aiReviews, exactResultMode]);

  useEffect(() => {
    if (exactResultMode) return;
    if (aiReviews.length > 0) return;
    const pendingCandidates = aiCandidates.filter((item) => !aiRequestedKeysRef.current.has(listingKey(item)));
    if (pendingCandidates.length === 0) return;
    const generation = aiGenerationRef.current;
    for (const item of pendingCandidates) aiRequestedKeysRef.current.add(listingKey(item));

    const applyJob = (job: ListingJobResponse) => {
      if (generation !== aiGenerationRef.current) return;
      setAiStates((value) => {
        const next = { ...value };
        pendingCandidates.forEach((item, index) => {
          const enrichment = job.items[index] ?? undefined;
          const status = job.itemStatuses[index] ?? "queued";
          next[listingKey(item)] = status === "completed" && enrichment
            ? { status: "ready", enrichment, scope: "listing" }
            : status === "failed"
              ? { status: "unavailable", scope: "listing" }
              : status === "waiting_rate_limit"
                ? { status: "waiting_rate_limit", scope: "listing" }
                : status === "processing"
                  ? { status: "loading", scope: "listing" }
                  : { status: "queued", scope: "listing" };
        });
        return next;
      });
    };

    const poll = async (jobId: string) => {
      if (generation !== aiGenerationRef.current) return;
      try {
        const job = await apiFetch<ListingJobResponse>(
          `/api/ai/listing-enrichment?jobId=${encodeURIComponent(jobId)}`,
        );
        applyJob(job);
        if (["completed", "partial", "failed"].includes(job.status)) return;
      } catch {
        // The durable task continues even if one browser poll fails.
      }
      if (generation === aiGenerationRef.current) {
        const timer = setTimeout(() => {
          aiPollTimersRef.current.delete(timer);
          void poll(jobId);
        }, 2_500);
        aiPollTimersRef.current.add(timer);
      }
    };

    const runSequence = async () => {
      setAiStates((value) => {
        const next = { ...value };
        for (const item of pendingCandidates) next[listingKey(item)] = { status: "queued", scope: "listing" };
        return next;
      });
      try {
        const job = await apiFetch<ListingJobResponse>("/api/ai/listing-enrichment", {
          method: "POST",
          body: JSON.stringify({ query: resultQuery, items: pendingCandidates.map(enrichmentRequest) }),
        });
        if (!job.taskPersisted || job.model !== "gemini-3.5-flash-lite") throw new Error("unexpected_ai_route");
        applyJob(job);
        if (!["completed", "partial", "failed"].includes(job.status)) await poll(job.jobId);
      } catch {
        if (generation !== aiGenerationRef.current) return;
        setAiStates((value) => {
          const next = { ...value };
          for (const item of pendingCandidates) next[listingKey(item)] = { status: "unavailable", scope: "listing" };
          return next;
        });
      }
    };

    void runSequence();
  }, [aiCandidates, aiReviews.length, exactResultMode, resultQuery]);

  function renderListing(item: NormalizedListing) {
    const key = listingKey(item);
    return (
      <ListingResultCard
        key={key}
        item={item}
        ai={aiStates[key]}
        showAi={!exactResultMode || workflowAiCandidateKeys.has(key)}
        searchEvidence={candidateEvidenceByKey.get(key)}
        comparison={comparisonPositions.get(key)}
        watchState={itemWatchStates[key] ?? "idle"}
        watchProfileId={itemWatchProfiles[key]}
        watchDisabledReason={item.sourceId === "yahoo_shopping" ? "实验接口尚无稳定单品回查能力" : undefined}
        onFindSimilar={exactResultMode ? undefined : () => findSimilar(item)}
        onWatch={() => void watchItem(item)}
      />
    );
  }

  function renderRawListing(item: NormalizedListing) {
    const key = listingKey(item);
    return (
      <ListingResultCard
        key={`raw:${key}`}
        item={item}
        showAi={false}
        watchState={itemWatchStates[key] ?? "idle"}
        watchProfileId={itemWatchProfiles[key]}
        watchDisabledReason={item.sourceId === "yahoo_shopping" ? "实验接口尚无稳定单品回查能力" : undefined}
        onFindSimilar={exactResultMode ? undefined : () => findSimilar(item)}
        onWatch={() => void watchItem(item)}
      />
    );
  }

  return (
    <div className="search-studio reveal reveal-delay-1">
      <form className="search-controls" onSubmit={submit}>
        <section className="search-mode-panel" id="search-mode-panel" aria-labelledby="search-mode-title">
          <header>
            <div><p className="eyebrow">SEARCH INTENT</p><h2 id="search-mode-title">输入一个具体日文商品名，就能跨来源找同款</h2></div>
            <span>{searchMode === "keyword" ? "宽召回 · 适合探索角色或品类" : "商品名自动拆解 · 精确召回后再清洗"}</span>
          </header>
          <div className="search-mode-options" role="group" aria-label="搜索方式">
            <button type="button" aria-pressed={searchMode === "keyword"} onClick={() => changeSearchMode("keyword")}>
              <Search size={19} aria-hidden="true" /><span><strong>宽泛关键词</strong><small>探索角色、作品或品类，结果会更宽</small></span>
            </button>
            <button type="button" aria-pressed={searchMode === "exact_product"} onClick={() => changeSearchMode("exact_product")}>
              <Fingerprint size={19} aria-hidden="true" /><span><strong>按商品名找同款</strong><small>只需具体日文名；系统自动生成有限查询并筛掉无关商品</small></span>
            </button>
          </div>
        </section>

        <div className="search-command">
          <Search size={23} strokeWidth={1.4} aria-hidden="true" />
          <label htmlFor="query">{searchMode === "exact_product" ? "具体日文商品名" : "想找什么？"}</label>
          <input id="query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder={searchMode === "exact_product" ? "例如：Re:ゼロから始める異世界生活 ふわかわロリータぬいぐるみ レム" : "输入日文关键词，例如：氷菓 Blu-ray"} />
        </div>

        {searchMode === "exact_product" && (
          <section className="product-fingerprint-editor" aria-labelledby="product-fingerprint-title">
            <header>
              <div><p className="eyebrow">AUTOMATIC PRODUCT INTENT</p><h3 id="product-fingerprint-title"><Crosshair size={18} aria-hidden="true" />系统会先理解商品名</h3></div>
              <p>正常情况下只填上面的完整日文名。系统保留原名，自动生成少量高信息查询；只有你确定某个字段时才需要手动校正。召回条数偏少时，优先补「补充召回词」。</p>
            </header>
            <details className="product-fingerprint-advanced">
              <summary>补充召回词与高级校正</summary>
              <div className="product-fingerprint-grid">
              <div className="field wide"><label htmlFor="target-recall">补充召回词（逗号分隔，最多 4 条）</label><input id="target-recall" className="text-input" value={(productTarget.recallQueries ?? []).join("、")} onChange={(event) => updateProductTarget("recallQueries", commaSeparatedTerms(event.target.value).slice(0, 4))} placeholder="カードキャプターさくら イヤホン、ccs gaacal イヤホン" /><small className="field-hint">完整商品名会原样发给来源，但卖家常写简称。这里的短词会作为额外查询一起发出，直接决定能召回多少条。</small></div>
              <div className="field wide"><label htmlFor="target-reference">锚点商品链接</label><input id="target-reference" className="text-input" value={productTarget.referenceUrl ?? ""} onChange={(event) => updateProductTarget("referenceUrl", event.target.value || undefined)} placeholder="已接入来源的完整商品链接" /></div>
              <div className="field"><label htmlFor="target-work">作品</label><input id="target-work" className="text-input" value={productTarget.workTitle ?? ""} onChange={(event) => updateProductTarget("workTitle", event.target.value || undefined)} placeholder="Re:ゼロから始める異世界生活" /></div>
              <div className="field"><label htmlFor="target-characters">角色（逗号分隔）</label><input id="target-characters" className="text-input" value={productTarget.characters.join("、")} onChange={(event) => updateProductTarget("characters", commaSeparatedTerms(event.target.value).slice(0, 8))} placeholder="ラインハルト" /></div>
              <div className="field"><label htmlFor="target-type">商品类型</label><input id="target-type" className="text-input" value={productTarget.productType ?? ""} onChange={(event) => updateProductTarget("productType", event.target.value || undefined)} placeholder="ぬいぐるみ" /></div>
              <div className="field"><label htmlFor="target-maker">厂商 / 品牌</label><input id="target-maker" className="text-input" value={productTarget.manufacturer ?? ""} onChange={(event) => updateProductTarget("manufacturer", event.target.value || undefined)} placeholder="GSクラフト" /></div>
              <div className="field"><label htmlFor="target-series">系列</label><input id="target-series" className="text-input" value={productTarget.series ?? ""} onChange={(event) => updateProductTarget("series", event.target.value || undefined)} placeholder="系列名 / 商品线" /></div>
              <div className="field"><label htmlFor="target-model">型号 / SKU</label><input id="target-model" className="text-input" value={productTarget.model ?? ""} onChange={(event) => updateProductTarget("model", event.target.value || undefined)} placeholder="N0065" /></div>
              <div className="field"><label htmlFor="target-jan">JAN</label><input id="target-jan" className="text-input" inputMode="numeric" value={productTarget.jan ?? ""} onChange={(event) => updateProductTarget("jan", event.target.value.replace(/\D/g, "") || undefined)} placeholder="4589955576984" /></div>
              <div className="field"><label htmlFor="target-size">尺寸</label><input id="target-size" className="text-input" value={productTarget.size ?? ""} onChange={(event) => updateProductTarget("size", event.target.value || undefined)} placeholder="18cm" /></div>
              <div className="field"><label htmlFor="target-color">颜色</label><input id="target-color" className="text-input" value={productTarget.color ?? ""} onChange={(event) => updateProductTarget("color", event.target.value || undefined)} placeholder="グレー" /></div>
              <div className="field"><label htmlFor="target-aliases">别名 / 标准标题（逗号分隔）</label><input id="target-aliases" className="text-input" value={productTarget.aliases.join("、")} onChange={(event) => updateProductTarget("aliases", commaSeparatedTerms(event.target.value))} placeholder="完整角色名、旧称" /></div>
              <div className="field"><label htmlFor="target-exclusions">明确排除（逗号分隔）</label><input id="target-exclusions" className="text-input" value={productTarget.excludedTerms.join("、")} onChange={(event) => updateProductTarget("excludedTerms", commaSeparatedTerms(event.target.value))} placeholder="GiGO、ちびぐるみ、プライズ" /></div>
              </div>
            </details>
          </section>
        )}

        <fieldset className="source-selector">
          <legend>选择搜索范围</legend>
          {sourceOptions.filter((source) => isSearchSourceVisible(source.id)).map((source) => {
            const state = sourceStates.find((item) => item.id === source.id);
            const historySupported = state?.history_search_supported ?? source.id === "mercari_jp";
            const historyUnsupported = availabilityMode === "sold_out" && !historySupported;
            const availability = historyUnsupported
              ? { label: "不支持成交历史", tone: "bad" as const }
              : sourceAvailability(state);
            const disabled = historyUnsupported || Boolean(state && (!state.enabled || !state.adapter_available));
            return (
              <div className="source-option" key={source.id} data-selected={sources.includes(source.id)} data-disabled={disabled}>
                <label>
                  <input type="checkbox" checked={sources.includes(source.id)} disabled={disabled} onChange={() => toggleSource(source.id)} />
                  <span><strong>{source.label}</strong><small>{source.caption}</small></span>
                  <em className={`source-state ${availability.tone}`}>{availability.label}</em>
                </label>
                {isRakutenSource(source.id) && <RakutenCredit />}
              </div>
            );
          })}
        </fieldset>

        <div className="filter-deck">
          <p><SlidersHorizontal size={15} aria-hidden="true" />筛选条件</p>
          <div className="search-request-mode">
            <EditorialSelect index="00" label="请求范围" caption="Request mode" value={availabilityMode} options={requestModeOptions} onValueChange={changeAvailabilityMode} />
          </div>
          <div className="field"><label htmlFor="min-price">最低价 / ¥</label><input id="min-price" className="text-input" inputMode="numeric" value={minPrice} onChange={(event) => setMinPrice(event.target.value.replace(/\D/g, ""))} placeholder="不限" /></div>
          <div className="field"><label htmlFor="max-price">最高价 / ¥</label><input id="max-price" className="text-input" inputMode="numeric" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value.replace(/\D/g, ""))} placeholder="不限" /></div>
          <div className="filter-toggles">
            <label><input type="checkbox" checked={conditions.includes("new")} onChange={() => toggleCondition("new")} />新品</label>
            <label><input type="checkbox" checked={conditions.includes("used")} onChange={() => toggleCondition("used")} />中古</label>
          </div>
          <p className="request-mode-note">{availabilityMode === "sold_out"
            ? "本次只请求已声明支持成交历史的来源；历史结果不会作为新品监控。"
            : availabilityMode === "purchasable"
              ? "只请求仍可购买、预约或等待补货的商品。"
              : searchMode === "exact_product"
                ? "先请求各来源的当前结果；仍未找到同款时，再查本地历史索引并尝试实时打开详情。未复核历史候选不会被当作当前有货。"
                : "请求各来源的当前关键词结果；覆盖范围取决于来源自身的搜索窗口。"}</p>
          {sources.includes("yahoo_shopping") && <p className="request-mode-note"><strong>Yahoo! Shopping（实验）</strong> 直接读取公开搜索 HTML 与同域下一页，最多三页有限窗口；不调用私有分页接口，不使用账号登录、验证码或代理轮换。该来源目前<strong>不支持品相与仅看有货筛选</strong>，勾选这些条件时 Yahoo! Shopping 结果仍按公开页面原样返回；也不支持单品与成交历史查询。</p>}
          {sources.includes("yahoo_auctions_jp") && <p className="request-mode-note"><strong>Yahoo!オークション（实验）</strong> 只读取固定公开 HTML：在售商品卡片、已结束页面状态与详情 JSON-LD；受低频、短缓存和熔断保护，来源冷却或结构变化不会影响其他来源。</p>}
          {sources.includes("yahoo_fleamarket_jp") && <p className="request-mode-note"><strong>Yahoo!フリマ</strong> 读取固定公开搜索与商品页，价格和品相筛选在采集后执行；普通连接失败时才启用 Browser Run，且不处理登录、验证码或已售出历史。</p>}
        </div>

        {availabilityMode === "sold_out" && sources.includes("mercari_jp") && (
          <section className="history-item-verifier" aria-labelledby="history-item-verifier-title">
            <div className="history-item-verifier-copy">
              <p className="eyebrow">KNOWN HISTORY</p>
              <h3 id="history-item-verifier-title">核验一条已知的老成交记录</h3>
              <p>较早商品可能已离开 Mercari 的关键词滚动索引。输入官方商品 ID 或链接后，本次会实时读取详情；本地只保留候选 ID 与标题，之后的搜索仍须重新取得价格和状态。</p>
            </div>
            <div className="history-item-verifier-action">
              <label htmlFor="history-item-id">Mercari 商品 ID / 官方链接</label>
              <div>
                <input id="history-item-id" className="text-input" value={historyItemInput} onChange={(event) => {
                  setHistoryItemInput(event.target.value);
                  if (historyItemVerification.status !== "idle") setHistoryItemVerification({ status: "idle" });
                }} placeholder="m43570223189 或 https://jp.mercari.com/item/…" />
                <button type="button" disabled={historyItemVerification.status === "loading"} onClick={() => void verifyKnownHistoryItem()}>
                  <Eye size={15} aria-hidden="true" />{historyItemVerification.status === "loading" ? "正在实时核验…" : "实时核验"}
                </button>
              </div>
              {historyItemVerification.status === "error" && <p className="history-item-verifier-result error-copy">{historyItemVerification.message}</p>}
              {historyItemVerification.status === "ready" && (
                <p className="history-item-verifier-result" data-status="ready">
                  <strong>已确认 · {listingAvailabilityState(historyItemVerification.listing) === "trading" ? "交易中" : "已售出"}</strong>
                  <span>{historyItemVerification.listing.title}</span>
                  <span>{historyItemVerification.listing.currentPrice === undefined ? "价格未返回" : `¥${historyItemVerification.listing.currentPrice.toLocaleString("ja-JP")}`} · {historyItemVerification.listing.sourceItemId}</span>
                </p>
              )}
            </div>
          </section>
        )}

        {error && <p className="form-error search-feedback">{error}</p>}
        {notice && <p className="form-note search-feedback">{notice}</p>}
        <div className="search-actions">
          <button className="primary-button" disabled={loading || !query.trim() || sources.length === 0} aria-busy={searching}>{searching ? "正在检索…" : loadingIntent === "snapshot" ? "正在读取历史…" : "开始搜索"}</button>
        </div>
        {searching && pendingSearchInput && (
          <section className="search-progress" role="status">
            <div className="search-progress-radar" aria-hidden="true"><span /><span /><i /></div>
            <div className="search-progress-copy">
              <p className="eyebrow">LIVE SEARCH</p>
              <h3>正在检索「{pendingSearchInput.query}」</h3>
              <p>后台搜索任务正在检索 {pendingSearchInput.sources.length} 个来源；关闭页面也不会中断</p>
            </div>
            <ul aria-label="本次搜索来源">
              {pendingSearchInput.sources.map((source) => <li key={source}>{sourceNames[source]}</li>)}
            </ul>
          </section>
        )}
        {watchComposerOpen && (
          <section className="search-watch-composer" id="search-watch-composer" aria-labelledby="search-watch-composer-title">
            <header><p className="eyebrow">CREATE WATCH DOSSIER</p><h3 id="search-watch-composer-title">{(activePlan?.mode ?? searchMode) === "exact_product" ? "建立精确同款关注档案" : "建立关键词关注档案"}</h3></header>
            <div className="search-watch-settings" aria-label="关键词关注设置">
              {(activePlan?.mode ?? searchMode) === "keyword" && <div className="schedule-fixed-purpose"><span>关注目的</span><strong>关键词上新</strong><small>首次建立基线，之后只通知新增商品</small></div>}
              {(activePlan?.mode ?? searchMode) === "exact_product" && <div className="schedule-fixed-purpose"><span>事件目标</span><strong>出现新的确认同款报价</strong><small>不是等待当前已售链接降价</small></div>}
              <EditorialSelect index="W2" label="检查频率" caption="Collection cadence" value={savedWatchInterval} options={MONITORING_INTERVAL_OPTIONS} onValueChange={setSavedWatchInterval} />
              <div className="field search-watch-next-run">
                <label htmlFor="search-watch-next-run">首次巡回（可选）</label>
                <input id="search-watch-next-run" className="text-input" type="datetime-local" value={savedWatchNextRun} onChange={(event) => setSavedWatchNextRun(event.target.value)} />
                <small>留空则保存后尽快执行首次巡回；以后按上面的频率检查。</small>
              </div>
              <p>{(activePlan?.mode ?? searchMode) === "exact_product" ? "规则绑定本次搜索确认的稳定商品版本；已有单品关注会作为已知报价去重，新确认同款会持续独立检查价格。创建后可继续设置目标标价、品相、去重与冷却。" : "建立关键词结果基线后，每轮把跨来源新增商品合并为一封邮件。"}</p>
            </div>
            <footer>
              <button className="ghost-button" type="button" disabled={watchSaving} onClick={() => setWatchComposerOpen(false)}>取消</button>
              <button className="primary-button" type="button" disabled={watchSaving} aria-busy={watchSaving} onClick={() => void createWatchDossier()}><BookmarkPlus size={15} aria-hidden="true" />{watchSaving ? "正在创建…" : (activePlan?.mode ?? searchMode) === "exact_product" ? "创建精确同款关注档案" : "创建关键词关注档案"}</button>
            </footer>
          </section>
        )}
      </form>

      <section className="search-results" id="search-results" aria-live="polite" aria-busy={loading}>
        <header className="results-heading">
          <div><p className="eyebrow">SEARCH RESULTS</p><h2>{groups.length > 0 ? exactResultMode ? `本次同款搜索召回 ${listings.length} 件来源候选` : `找到 ${listings.length} 件商品` : "等待一次检索"}</h2></div>
          <div className="results-heading-meta">
            {(activeSnapshot || groups.length > 0) && <span>{activeSnapshot ? "正在查看历史结果快照 · 未重新访问来源" : `${groups.length} 个来源已回应`}</span>}
            {groups.length > 0 && <span data-ai-status={aiBatchStatus}><Languages size={13} aria-hidden="true" />{
              exactResultMode
                ? aiBatchStatus === "loading"
                  ? `同款规则初筛完成 · Gemini 裁决 ${aiReadyCount}/${aiCandidates.length}`
                  : aiBatchStatus === "ready"
                    ? `Gemini 已裁决 ${aiReadyCount} 件歧义候选`
                    : aiBatchStatus === "partial"
                      ? `历史结果的 AI 裁决不完整 · ${aiReadyCount}/${aiCandidates.length}`
                      : aiBatchStatus === "unavailable"
                        ? "历史结果的 AI 裁决失败 · 不可作为精确搜索结论"
                        : "同款规则初筛完成 · 无需调用 Gemini"
                : aiBatchStatus === "loading"
                  ? `Gemini 清洗中 ${aiReadyCount}/${aiCandidates.length}`
                  : aiBatchStatus === "ready"
                    ? `Gemini 已清洗 ${aiReadyCount} 件`
                    : aiBatchStatus === "partial"
                      ? `Gemini 已清洗 ${aiReadyCount}/${aiCandidates.length} 件`
                      : aiBatchStatus === "unavailable"
                        ? "来源结果已保留 · Gemini 本次未完成"
                        : "等待 AI 清洗"
            }</span>}
          </div>
        </header>

        {groups.length > 0 && (
          <div className="source-result-strip">
            {groups.map((group) => {
              const status = searchRunStatus(group);
              return <span className={`status-pill ${status.tone}`} title={group.warnings?.join("；") || group.error} key={group.sourceId}><strong>{sourceNames[group.sourceId]}</strong>{status.label}{group.durationMs === undefined ? "" : ` · ${(group.durationMs / 1_000).toFixed(1)}s`}</span>;
            })}
          </div>
        )}

        {activeHistoryId && groups.length > 0 && (
          <div className="search-run-linkbar">
            <span>{unavailableGroups.length > 0 ? `${unavailableGroups.length} 个来源需要排查` : "查询计划、覆盖证据和原始响应已归档"}</span>
            <Link href={`/search/history/${activeHistoryId}` as Route}>查看本次运行记录</Link>
          </div>
        )}

        {groups.some((group) => group.nextCursor) && !activeSnapshot && (
          <div className="history-page-actions">
            {groups.filter((group) => group.nextCursor).map((group) => (
              <button type="button" key={group.sourceId} disabled={Boolean(loadingMoreSource)} onClick={() => void loadNextSourcePage(group)}>
                {loadingMoreSource === group.sourceId ? "正在读取下一页…" : `继续读取 ${sourceNames[group.sourceId]} 下一页`}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {listings.length > 0 ? (
          <div className="result-workbench">
            <div className="results-toolbar">
              <div className="result-toolbar-topline">
                <div className="result-view-switch" role="group" aria-label="结果呈现方式">
                  <button type="button" aria-pressed={resultView === "all"} onClick={() => setResultView("all")}><ArrowDownUp size={15} aria-hidden="true" />商品清单</button>
                  {resultScope === "curated" && <button type="button" aria-pressed={resultView === "compare"} onClick={() => setResultView("compare")}><Layers3 size={15} aria-hidden="true" />{exactResultMode ? "目标同款比价" : "同款比价"} <span>{repeatedGroups.length}</span></button>}
                </div>
                {savedWatchProfileId ? (
                  <Link className="create-watch-dossier-action" href={`/watches/${savedWatchProfileId}` as Route}><ArrowUpRight size={15} aria-hidden="true" />打开关注档案</Link>
                ) : (
                  <button
                    className="create-watch-dossier-action"
                    type="button"
                    disabled={exactResultMode && (!activeProductIdentity || !activeHistoryId)}
                    aria-expanded={watchComposerOpen}
                    aria-controls="search-watch-composer"
                    onClick={openWatchComposer}
                  >
                    <BookmarkPlus size={15} aria-hidden="true" />
                    {exactResultMode
                      ? activeProductIdentity && activeHistoryId
                        ? "建立精确同款监控"
                        : "等待确认商品身份"
                      : "建立关键词雷达"}
                  </button>
                )}
              </div>
              {exactResultMode && resultScope === "curated" && (
                <div className="match-bucket-switch" role="group" aria-label="同款关系分组">
                  {([
                    ["all", "全部分组", listings.length],
                    ["exact", "确认同款", matchBucketCounts.exact],
                    ["variant", "其他版本", matchBucketCounts.variant],
                    ["bundle", "套装", matchBucketCounts.bundle],
                    ["related", "相关 / 人工复核", matchBucketCounts.related],
                  ] as const).map(([value, label, count]) => (
                    <button key={value} type="button" aria-pressed={resultMatchBucket === value} onClick={() => { setResultMatchBucket(value); setResultPage(1); }}><span>{label}</span><strong>{count}</strong></button>
                  ))}
                </div>
              )}
              <div className="result-filter-grid">
                <EditorialSelect index="00" label="查看范围" caption="Result scope" value={resultScope} options={scopeFilterOptions} onValueChange={(value) => {
                  if (includesOption(resultScopeOptions, value)) {
                    setResultScope(value);
                    setResultView("all");
                    setResultPage(1);
                    setManualResultPage(1);
                  }
                }} />
                <EditorialSelect index="01" label="来源" caption="Source" value={resultSource} options={sourceFilterOptions} onValueChange={(value) => {
                  setResultPage(1);
                  setManualResultPage(1);
                  if (value === "all" || isSourceId(value)) setResultSource(value);
                }} />
                <EditorialSelect index="02" label="本次结果状态" caption="Returned results" value={resultAvailability} options={availabilityFilterOptions} onValueChange={(value) => {
                  if (includesOption(resultAvailabilityOptions, value)) {
                    setResultAvailability(value);
                    setResultPage(1);
                    setManualResultPage(1);
                  }
                }} />
                <EditorialSelect index="03" label="品相" caption="Condition" value={resultCondition} options={conditionFilterOptions} onValueChange={(value) => {
                  if (includesOption(resultConditionOptions, value)) {
                    setResultCondition(value);
                    setResultPage(1);
                    setManualResultPage(1);
                  }
                }} />
                <EditorialSelect index="04" label="排序" caption="Order" value={resultSortMode} options={sortFilterOptions} onValueChange={(value) => {
                  if (includesOption(resultSortOptions, value)) {
                    setResultSortMode(value);
                    setResultPage(1);
                    setManualResultPage(1);
                  }
                }} />
              </div>
              <div className="result-filter-summary">
                <p>{(resultAvailability === "sold_out" || resultAvailability === "trading") && (resultScope === "manual" ? manualPoolListings.length : filteredListings.length) === 0
                  ? `本次已返回结果中没有${resultAvailability === "trading" ? "交易中" : "已售出"}商品。请在上方把请求范围切换为“已售出 / 交易中”后重新搜索；这里的筛选不会重新访问来源。`
                  : resultScope === "manual"
                    ? `完整人工检索池保留本次 ${listings.length} 件来源商品，当前筛选命中 ${manualPoolListings.length} 件；这里不采用 AI 相关性隐藏，但仍遵守来源、状态、品相与排序筛选。`
                  : exactResultMode
                    ? `本次完整保留 ${listings.length} 件来源商品；默认只显示 ${filteredListings.length} 件确认同款。当前分流：确认同款 ${matchBucketCounts.exact}、其他版本 ${matchBucketCounts.variant}、套装 ${matchBucketCounts.bundle}、相关或人工复核 ${matchBucketCounts.related}${hiddenIrrelevantCount > 0 ? `，另有 ${hiddenIrrelevantCount} 件已排除` : ""}。Gemini 只裁决本次同款搜索选出的少量歧义候选，不会改写来源证据。`
                    : `本次来源共返回 ${listings.length} 件，整理后结果显示 ${filteredListings.length} 件；其中 ${soldReferenceCount} 件为交易中、已售出或当前不可购买参考${hiddenIrrelevantCount > 0 ? `，Gemini 暂不推荐展示 ${hiddenIrrelevantCount} 件语义无关结果` : ""}。可切换到“完整人工检索池”逐件核对。`}</p>
                {(resultSource !== "all" || resultAvailability !== "all" || resultCondition !== "all") && <button type="button" onClick={() => { setResultSource("all"); setResultAvailability("all"); setResultCondition("all"); setResultPage(1); setManualResultPage(1); }}>清除筛选</button>}
              </div>
            </div>

            {resultScope === "curated" ? <section className="curated-result-section" aria-labelledby="curated-result-title">
              <header className="result-section-heading">
                <div><p className="eyebrow">CURATED RESULTS</p><h3 id="curated-result-title">{exactResultMode ? "本次搜索确认的同款" : aiBatchStatus === "loading" ? "正在整理的候选商品" : "AI 整理后的候选商品"}</h3></div>
                <span>{filteredListings.length} / {listings.length} 件</span>
              </header>

              {exactResultMode && priceIntelligence && (
                <ProductPriceIntelligencePanel
                  intelligence={priceIntelligence}
                />
              )}

              {filteredListings.length === 0 ? (
                <div className="curated-result-empty">
                  <Languages size={22} aria-hidden="true" />
                  <div><strong>上方筛选或{exactResultMode ? "确认同款分组" : " AI 整理"}后暂时没有候选</strong><p>来源返回的全部商品没有被删除；可切换到“完整人工检索池”继续核对。</p></div>
                </div>
              ) : resultView === "all" ? (
                <>
                  <div className="result-product-list">{pagedListings.map(renderListing)}</div>
                  {resultPageCount > 1 && (
                    <nav className="result-pagination" aria-label="整理后搜索结果分页">
                      <button type="button" disabled={currentResultPage === 1} onClick={() => setResultPage(Math.max(1, currentResultPage - 1))}><ChevronLeft size={16} aria-hidden="true" />上一页</button>
                      <span>第 {currentResultPage} / {resultPageCount} 页</span>
                      <button type="button" disabled={currentResultPage === resultPageCount} onClick={() => setResultPage(Math.min(resultPageCount, currentResultPage + 1))}>下一页<ChevronRight size={16} aria-hidden="true" /></button>
                    </nav>
                  )}
                </>
              ) : repeatedGroups.length > 0 ? (
                <div className="comparison-stack">
                  {repeatedGroups.map((group, index) => (
                    <section className="comparison-group" key={group.identity.key}>
                      <header>
                        <div><p className="eyebrow">COMPARE {String(index + 1).padStart(2, "0")}</p><h3>{group.listings[0]?.title}</h3></div>
                        <span>{group.listings.length} 个报价 · {exactResultMode ? "目标商品关系为同款" : group.identity.method === "identifier" ? "强标识匹配" : "标题严格一致"}</span>
                      </header>
                      <div className="result-product-list">{group.listings.map(renderListing)}</div>
                    </section>
                  ))}
                  {singleListings.length > 0 && (
                    <section className="comparison-singles">
                      <header><div><p className="eyebrow">UNMATCHED</p><h3>其余商品</h3></div><span>{singleListings.length} 件没有可安全合并的同款</span></header>
                      <p>这些商品不会被 AI 或模糊标题强行并组，仍按当前排序完整展示。</p>
                      <div className="result-product-list">{singleListings.map(renderListing)}</div>
                    </section>
                  )}
                </div>
              ) : (
                <div className="comparison-empty">
                  <Layers3 size={24} aria-hidden="true" />
                  <div><h3>本次没有可安全合并的同款</h3><p>只有 ISBN / JAN 等强标识，或规范化后标题完全一致时才进入比价；不会为了凑结果做模糊合并。</p></div>
                  <div className="result-product-list">{filteredListings.map(renderListing)}</div>
                </div>
              )}
            </section> : <section className="curated-result-section manual-pool-section" aria-labelledby="manual-pool-title">
              <header className="result-section-heading">
                <div><p className="eyebrow">MANUAL REVIEW POOL</p><h3 id="manual-pool-title">完整人工检索池</h3></div>
                <span>{manualPoolListings.length} / {listings.length} 件</span>
              </header>
              <p className="manual-pool-note">按来源事实展示本次返回的完整商品列表，不采用 AI 相关性隐藏；共同筛选已生效，每页最多 {RESULT_PAGE_SIZE} 件。</p>
              {manualPoolListings.length === 0 ? (
                <div className="curated-result-empty">
                  <Languages size={22} aria-hidden="true" />
                  <div><strong>当前筛选在人工检索池中没有商品</strong><p>清除来源、状态或品相筛选即可回到完整来源结果。</p></div>
                </div>
              ) : <>
                <div className="result-product-list">{manualPagedListings.map(renderRawListing)}</div>
                {manualResultPageCount > 1 && (
                  <nav className="result-pagination" aria-label="人工检索池分页">
                    <button type="button" disabled={currentManualResultPage === 1} onClick={() => setManualResultPage(Math.max(1, currentManualResultPage - 1))}><ChevronLeft size={16} aria-hidden="true" />上一页</button>
                    <span>第 {currentManualResultPage} / {manualResultPageCount} 页</span>
                    <button type="button" disabled={currentManualResultPage === manualResultPageCount} onClick={() => setManualResultPage(Math.min(manualResultPageCount, currentManualResultPage + 1))}>下一页<ChevronRight size={16} aria-hidden="true" /></button>
                  </nav>
                )}
              </>}
            </section>}
          </div>
        ) : (
          <div className="empty-state search-empty">
            <div><div className="empty-orbit" /><h3>{searching ? "正在捕捉商品信号" : loadingIntent === "snapshot" ? "正在读取历史结果" : unavailableGroups.length > 0 ? "有来源这次没有回应" : groups.length > 0 ? "没有匹配到商品" : "从一个具体念头开始"}</h3><p>{searching ? "本次选中的来源正在独立返回结果。" : loadingIntent === "snapshot" ? "正在恢复当时保存的结果，不会重新访问来源。" : unavailableGroups.length > 0 ? "可从本次运行记录查看失败原因与原始响应，稍后再按相同条件搜索。" : groups.length > 0 ? "试试更短的日文关键词，或放宽价格与库存条件。" : "日文角色名、作品名或商品类别通常更准确。"}</p></div>
          </div>
        )}
      </section>
    </div>
  );
}
