import {
  SEARCH_AVAILABILITY_MODES,
  type ItemCondition,
  type NormalizedListing,
  type SearchAvailabilityMode,
  type SearchFilters,
} from "./types.js";

const ITEM_CONDITIONS = new Set<ItemCondition>(["new", "used", "collectible", "refurbished", "unknown"]);

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function availabilityModeValue(value: unknown): SearchAvailabilityMode | undefined {
  return typeof value === "string" && SEARCH_AVAILABILITY_MODES.includes(value as SearchAvailabilityMode)
    ? value as SearchAvailabilityMode
    : undefined;
}

export function searchAvailabilityMode(filters: SearchFilters): SearchAvailabilityMode {
  return filters.availabilityMode ?? (filters.inStockOnly === true ? "purchasable" : "all");
}

function conditionsValue(value: unknown): ItemCondition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const conditions = value.filter((item): item is ItemCondition => typeof item === "string" && ITEM_CONDITIONS.has(item as ItemCondition));
  return conditions.length ? conditions : undefined;
}

export function searchFiltersFromConfig(
  config: Record<string, unknown>,
  defaults: SearchFilters = {},
): SearchFilters {
  const nested = config.filters && typeof config.filters === "object" && !Array.isArray(config.filters)
    ? config.filters as Record<string, unknown>
    : {};
  const value = { ...config, ...nested };
  return {
    ...defaults,
    minPrice: nonNegativeInteger(value.minPrice) ?? defaults.minPrice,
    maxPrice: nonNegativeInteger(value.maxPrice) ?? defaults.maxPrice,
    conditions: conditionsValue(value.conditions) ?? defaults.conditions,
    inStockOnly: booleanValue(value.inStockOnly) ?? defaults.inStockOnly,
    availabilityMode: availabilityModeValue(value.availabilityMode) ?? defaults.availabilityMode,
    page: nonNegativeInteger(value.page) ?? defaults.page,
    pageSize: nonNegativeInteger(value.pageSize) ?? defaults.pageSize,
  };
}

/**
 * Exact-product watch collection is an evidence crawl, not a shopping-view
 * query. Price, condition, and availability are decision/notification rules
 * applied after identity matching; pushing them upstream creates false
 * negatives and permanently loses market evidence.
 */
export function exactProductEvidenceFilters(filters: SearchFilters): SearchFilters {
  return {
    ...filters,
    minPrice: undefined,
    maxPrice: undefined,
    conditions: undefined,
    inStockOnly: false,
    availabilityMode: "all",
  };
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function compactText(value: string): string {
  return normalizedText(value).replace(/[\s:・･._\-‐‑‒–—―]+/g, "");
}

function legacySlashAliases(value: string, exclusion: boolean): string[] | null {
  const parts = value.split(/[/／]/).map(normalizedText).filter(Boolean);
  if (parts.length < 2) return null;
  const compact = parts.map(compactText);
  const characters = compact.map((part) => Array.from(part));
  if (characters.some((part) => part.length < 2 || part.length > 20)) return null;
  // Preserve literal titles such as Fate/stay night and numeric model names.
  if (compact.some((part) => /[a-z0-9]/iu.test(part))) return null;
  // Legacy Japanese exclusion lists use slash-separated independent terms.
  if (exclusion) return parts;
  if (parts.length !== 2) return null;
  // A full name and its abbreviated form are aliases even at different lengths.
  if (compact[0]!.startsWith(compact[1]!) || compact[1]!.startsWith(compact[0]!)) return parts;
  if (characters[0]!.length !== characters[1]!.length) return null;
  const differences = characters[0]!.filter((character, index) => character !== characters[1]![index]).length;
  return differences > 0 && differences <= Math.max(1, Math.floor(characters[0]!.length / 4)) ? parts : null;
}

function normalizedTermGroups(values: readonly string[], exclusion = false): string[][] {
  return values
    .map((value) => value.split(/[|｜]/)
      .flatMap((alternative) => legacySlashAliases(alternative, exclusion) ?? [normalizedText(alternative)])
      .filter(Boolean))
    .filter((group) => group.length > 0);
}

function matchesTerm(searchable: string, compactSearchable: string, term: string): boolean {
  if (searchable.includes(term)) return true;
  const compactTerm = compactText(term);
  return compactTerm.length >= 2 && compactSearchable.includes(compactTerm);
}

/** 预先归一化过的一段商品文本，供 {@link keywordRuleTextMatches} 反复比对。 */
export interface KeywordRuleText {
  searchable: string;
  compact: string;
}

/**
 * 关键词档案的包含 / 排除词在采集侧怎么匹配，这里就怎么匹配。
 * AI 复核页预演"加一个排除词会挡掉谁、误伤谁"必须用和 filterListings 同一把尺子，
 * 否则页面上说"误伤 0 件"，采集时却挡掉了真品。
 */
export function keywordRuleText(value: string): KeywordRuleText {
  const searchable = normalizedText(value);
  return { searchable, compact: compactText(searchable) };
}

export function keywordRuleTextMatches(text: KeywordRuleText, term: string): boolean {
  return matchesTerm(text.searchable, text.compact, normalizedText(term));
}

/** 档案里填的词组展开成实际参与匹配的候选词（含 `|` 与旧式 `/` 别名）。 */
export function keywordRuleTermAlternatives(values: readonly string[], exclusion = false): string[] {
  return normalizedTermGroups(values, exclusion).flat();
}

/**
 * Produces the minimum relevance groups used when a keyword radar has no
 * explicit include rules. Space-separated one-character Japanese input such
 * as `エ ミ リ ア` is repaired into one phrase instead of four noisy tokens.
 */
export function keywordQueryTermGroups(query: string): string[] {
  const tokens = normalizedText(query).split(" ").filter(Boolean);
  if (
    tokens.length > 1
    && tokens.every((token) => Array.from(token).length === 1 && /[^\x00-\x7F]/.test(token))
  ) {
    return [tokens.join("")];
  }
  return tokens;
}

export function filterListings(
  listings: readonly NormalizedListing[],
  filters: SearchFilters,
  includeTerms: readonly string[] = [],
  excludeTerms: readonly string[] = [],
): NormalizedListing[] {
  const includes = normalizedTermGroups(includeTerms);
  const excludes = normalizedTermGroups(excludeTerms, true);
  const conditions = filters.conditions?.length ? new Set(filters.conditions) : undefined;
  const availabilityMode = searchAvailabilityMode(filters);

  return listings.filter((listing) => {
    if (filters.minPrice !== undefined && (listing.currentPrice === undefined || listing.currentPrice < filters.minPrice)) return false;
    if (filters.maxPrice !== undefined && (listing.currentPrice === undefined || listing.currentPrice > filters.maxPrice)) return false;
    if (conditions && !conditions.has(listing.condition)) return false;
    if (availabilityMode === "purchasable" && !["available", "preorder", "backorder"].includes(listing.availability)) return false;
    if (availabilityMode === "sold_out" && listing.availability !== "sold_out") return false;

    const searchable = normalizedText(`${listing.title} ${listing.descriptionExcerpt ?? ""} ${listing.shopName ?? ""} ${listing.sellerName ?? ""}`);
    const compactSearchable = compactText(searchable);
    if (includes.some((group) => !group.some((term) => matchesTerm(searchable, compactSearchable, term)))) return false;
    if (excludes.some((group) => group.some((term) => matchesTerm(searchable, compactSearchable, term)))) return false;
    return true;
  });
}

/**
 * 一件商品为什么没过关键词档案的包含 / 排除词（和 filterListings 同一把尺子）。过了返回 null。
 * 排除词命中时带上命中的那个词，以及它是不是出现在标题里——只在说明 / 店名里出现的命中最容易误伤，
 * 「被筛掉的」列表要把这两种分开给人看（2026-10-12 用户要的：排除了又怕漏，要能回头查）。
 */
export type KeywordRuleMiss =
  | { kind: "include_miss" }
  | { kind: "exclude_hit"; term: string; inTitle: boolean };

export function keywordRuleMiss(
  listing: Pick<NormalizedListing, "title" | "descriptionExcerpt" | "shopName" | "sellerName">,
  includeTerms: readonly string[],
  excludeTerms: readonly string[],
): KeywordRuleMiss | null {
  const includes = normalizedTermGroups(includeTerms);
  const excludes = normalizedTermGroups(excludeTerms, true);
  const searchable = normalizedText(`${listing.title} ${listing.descriptionExcerpt ?? ""} ${listing.shopName ?? ""} ${listing.sellerName ?? ""}`);
  const compactSearchable = compactText(searchable);
  if (includes.some((group) => !group.some((term) => matchesTerm(searchable, compactSearchable, term)))) {
    return { kind: "include_miss" };
  }
  const title = normalizedText(listing.title);
  const compactTitle = compactText(title);
  for (const group of excludes) {
    for (const term of group) {
      if (matchesTerm(searchable, compactSearchable, term)) {
        return { kind: "exclude_hit", term, inTitle: matchesTerm(title, compactTitle, term) };
      }
    }
  }
  return null;
}

/** 可比价：0、负数、非有限值与超出量级的异常值一律不参与状态哈希与价格事件。 */
export function validComparablePrice(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : undefined;
}

/**
 * 直采落库与 AI 定稿落库必须共用这一个投影再去算 stableStateHash。
 * 两条路径的实现一旦漂移，同一件商品会因为"由哪条路径写入"而得到不同状态哈希，
 * 从而产生幻影 changed 事件。
 */
export function listingForDeterministicState(listing: NormalizedListing): NormalizedListing {
  const currentPrice = validComparablePrice(listing.currentPrice);
  const originalPrice = validComparablePrice(listing.originalPrice);
  const priceStatus = listing.currentPrice === undefined ? "missing" : currentPrice === undefined ? "invalid" : "valid";
  return {
    ...listing,
    currentPrice,
    originalPrice,
    rawMetadata: {
      ...listing.rawMetadata,
      priceStatus,
      ...(listing.currentPrice !== undefined && currentPrice === undefined ? { rawCurrentPrice: listing.currentPrice } : {}),
      ...(listing.originalPrice !== undefined && originalPrice === undefined ? { rawOriginalPrice: listing.originalPrice } : {}),
    },
  };
}

export interface KeywordWindowAssessment {
  status: "ok" | "anomalous";
  currentCount: number;
  knownOverlapCount: number;
  newCandidateCount: number;
  verifiablyFreshCount: number;
  reason?: string;
}

/**
 * Fails closed when a mature result window is almost entirely replaced by
 * previously unseen IDs and the source cannot prove those IDs are recent.
 * A growing set such as 100 known + 20 unseen remains valid because overlap is
 * preserved; a disjoint 30 -> 30 window without source dates is anomalous.
 */
export function assessKeywordWindow(input: {
  listings: readonly NormalizedListing[];
  knownSourceItemIds: ReadonlySet<string>;
  previousTypicalCount: number;
  intervalMinutes: number;
  /**
   * Rolling windows are expected to replace IDs between polls.  They cannot
   * be treated like a complete, comparable snapshot when sourceListedAt is
   * absent (which is common for API adapters).
   */
  coverage?: "complete" | "rolling_window" | "best_effort" | "unknown";
  now?: number;
}): KeywordWindowAssessment {
  const now = input.now ?? Date.now();
  const newCandidates = input.listings.filter((listing) => !input.knownSourceItemIds.has(listing.sourceItemId));
  const knownOverlapCount = input.listings.length - newCandidates.length;
  const freshWindowMs = Math.max(36 * 60 * 60_000, input.intervalMinutes * 2 * 60_000);
  const earliestFreshTime = now - freshWindowMs;
  const verifiablyFreshCount = newCandidates.filter((listing) => {
    if (!listing.sourceListedAt) return false;
    const listedAt = Date.parse(listing.sourceListedAt);
    return Number.isFinite(listedAt) && listedAt >= earliestFreshTime && listedAt <= now + 60 * 60_000;
  }).length;
  const comparableCount = Math.min(input.previousTypicalCount, input.listings.length);
  const overlapRatio = comparableCount > 0 ? knownOverlapCount / comparableCount : 1;
  const replacementThreshold = Math.max(10, Math.ceil(input.listings.length * 0.6));
  const unverifiableCount = newCandidates.length - verifiablyFreshCount;
  const anomalous = input.coverage !== "rolling_window"
    && input.previousTypicalCount >= 5
    && input.listings.length >= 10
    && newCandidates.length >= replacementThreshold
    && overlapRatio < 0.4
    && unverifiableCount >= Math.ceil(newCandidates.length / 2);

  return {
    status: anomalous ? "anomalous" : "ok",
    currentCount: input.listings.length,
    knownOverlapCount,
    newCandidateCount: newCandidates.length,
    verifiablyFreshCount,
    ...(anomalous ? {
      reason: `结果窗口异常换血：本轮 ${input.listings.length} 件中仅 ${knownOverlapCount} 件与既有基线重合，${unverifiableCount} 件新增候选缺少可靠上架时间`,
    } : {}),
  };
}
