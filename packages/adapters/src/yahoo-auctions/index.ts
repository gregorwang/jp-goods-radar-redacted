import {
  searchAvailabilityMode,
  type ItemCondition,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SearchSort,
  type SourceAdapter,
} from "../../../core/src/index.js";
import { record, text } from "../http.js";
import { YahooAuctionsError } from "./errors.js";
import {
  isYahooAuctionId,
  normalizeYahooAuctionsDetail,
  normalizeYahooAuctionsSearchItem,
  type YahooAuctionsScope,
} from "./normalize.js";
import {
  parseYahooAuctionsClosedSearchHtml,
  parseYahooAuctionsDetailHtml,
  parseYahooAuctionsOpenSearchHtml,
} from "./parser.js";
import {
  fetchYahooAuctionsHtml,
  waitForYahooAuctionsDelay,
  yahooAuctionsSignal,
  YAHOO_AUCTIONS_CLOSED_SEARCH_URL,
  YAHOO_AUCTIONS_ORIGIN,
  YAHOO_AUCTIONS_SEARCH_URL,
} from "./request.js";

export { YahooAuctionsError } from "./errors.js";
export { isYahooAuctionId, normalizeYahooAuctionsDetail, normalizeYahooAuctionsSearchItem } from "./normalize.js";
export {
  parseYahooAuctionsClosedSearchHtml,
  parseYahooAuctionsDetailHtml,
  parseYahooAuctionsOpenSearchHtml,
} from "./parser.js";
export { YAHOO_AUCTIONS_CLOSED_SEARCH_URL, YAHOO_AUCTIONS_ORIGIN, YAHOO_AUCTIONS_SEARCH_URL } from "./request.js";

export const YAHOO_AUCTIONS_PARSER_VERSION = "yahoo-auctions-public-html-2026-07-19.2";
const EXPERIMENTAL_WARNING = "Yahoo!オークション实验来源只读取匿名公开 HTML，不调用 Yahoo 私有 JSON 接口；字段和可用性可能随页面变化。";
const CONDITION_CODES = ["NEW", "USED10", "USED20", "USED40", "USED60", "USED80", "USED"] as const;
const CONDITION_SET = new Set<string>(CONDITION_CODES);
const USED_CONDITION_CODES = CONDITION_CODES.filter((value) => value.startsWith("USED"));
const CONDITION_STATUS: Record<(typeof CONDITION_CODES)[number], number> = {
  NEW: 1,
  USED: 2,
  USED10: 3,
  USED20: 4,
  USED40: 5,
  USED60: 6,
  USED80: 7,
};
const SORT_MAP: Record<SearchSort, readonly [string, string] | undefined> = {
  relevance: undefined,
  newest: ["new", "d"],
  price_asc: ["tbids", "a"],
  price_desc: ["tbids", "d"],
  ending_soon: ["end", "a"],
  ending_late: ["end", "d"],
  bids_desc: ["bids", "a"],
};

export interface YahooAuctionsAdapterOptions {
  /** Test-only override. Production keeps anonymous upstream starts at least two seconds apart. */
  interRequestDelayMs?: number;
  /** Test-only override for bounded retry timing. */
  retryDelayMs?: number;
}

interface SearchPlan {
  scope: YahooAuctionsScope;
  url: URL;
  conditionHint?: "NEW" | "USED";
}

interface SearchConfiguration {
  plans: SearchPlan[];
  page: number;
  pageSize: number;
  minBidCount?: number;
  maxBidCount?: number;
  warnings: string[];
}

function configuredInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new YahooAuctionsError(
      `${name} 必须是 ${minimum}～${maximum} 的整数`,
      "yahoo_auctions_invalid_request",
      400,
    );
  }
  return parsed;
}

function booleanConfig(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new YahooAuctionsError(`${name} 必须是布尔值`, "yahoo_auctions_invalid_request", 400);
  }
  return value;
}

function categoryIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new YahooAuctionsError("Yahoo 拍卖分类最多允许 20 项", "yahoo_auctions_invalid_request", 400);
  }
  const parsed = new Set<number>();
  for (const entry of value) {
    const categoryId = requiredInteger(entry, "categoryIds", 0, Number.MAX_SAFE_INTEGER);
    if (categoryId === undefined) {
      throw new YahooAuctionsError("Yahoo 拍卖分类 ID 无效", "yahoo_auctions_invalid_request", 400);
    }
    parsed.add(categoryId);
  }
  return [...parsed];
}

function explicitConditionCodes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CONDITION_CODES.length) {
    throw new YahooAuctionsError("Yahoo 拍卖品相代码无效", "yahoo_auctions_invalid_request", 400);
  }
  const parsed = new Set<string>();
  for (const entry of value) {
    const condition = text(entry);
    if (!condition || !CONDITION_SET.has(condition)) {
      throw new YahooAuctionsError("Yahoo 拍卖品相包含未支持的代码", "yahoo_auctions_invalid_request", 400);
    }
    parsed.add(condition);
  }
  return [...parsed];
}

function normalizedConditionCodes(conditions: readonly ItemCondition[] | undefined): string[] | undefined {
  if (!conditions?.length || conditions.includes("unknown")) return undefined;
  const codes = new Set<string>();
  if (conditions.includes("new")) codes.add("NEW");
  if (conditions.some((condition) => condition === "used" || condition === "collectible" || condition === "refurbished")) {
    USED_CONDITION_CODES.forEach((code) => codes.add(code));
  }
  return codes.size ? [...codes] : undefined;
}

function conditionHint(codes: readonly string[] | undefined): "NEW" | "USED" | undefined {
  if (!codes?.length) return undefined;
  if (codes.every((code) => code === "NEW")) return "NEW";
  if (codes.every((code) => code.startsWith("USED"))) return "USED";
  return undefined;
}

function requestedPage(request: SearchRequest): number {
  const pageToken = request.sourceConfig?.pageToken;
  const value = pageToken ?? request.filters.page ?? 1;
  return requiredInteger(value, "page", 1, 15_001) ?? 1;
}

function searchUrl(
  request: SearchRequest,
  scope: YahooAuctionsScope,
  page: number,
  pageSize: number,
  parameters: {
    categories?: number[];
    conditions?: string[];
    minPrice?: number;
    maxPrice?: number;
    freeShipping?: boolean;
    buyNow?: boolean;
  },
): URL {
  const url = new URL(scope === "closed" ? YAHOO_AUCTIONS_CLOSED_SEARCH_URL : YAHOO_AUCTIONS_SEARCH_URL);
  url.searchParams.set("p", request.query.trim());
  url.searchParams.set("va", request.query.trim());
  url.searchParams.set("b", String((page - 1) * pageSize + 1));
  url.searchParams.set("n", String(pageSize));
  if (scope === "open") {
    url.searchParams.set("is_postage_mode", "1");
    url.searchParams.set("dest_pref_code", "13");
  }
  if (parameters.categories?.length) url.searchParams.set("auccat", parameters.categories.join(","));
  if (parameters.conditions?.length) {
    const statuses = parameters.conditions.flatMap((condition) => {
      const status = CONDITION_STATUS[condition as keyof typeof CONDITION_STATUS];
      return status === undefined ? [] : [status];
    });
    if (statuses.length) url.searchParams.set("istatus", [...new Set(statuses)].join(","));
  }
  if (parameters.minPrice !== undefined) url.searchParams.set("aucminprice", String(parameters.minPrice));
  if (parameters.maxPrice !== undefined) url.searchParams.set("aucmaxprice", String(parameters.maxPrice));
  if (parameters.freeShipping) url.searchParams.set("pstagefree", "1");
  if (parameters.buyNow) url.searchParams.set("fixed", "1");
  const requestedSort = request.filters.sort ?? (scope === "closed" ? "ending_late" : "relevance");
  const sort = SORT_MAP[scope === "closed" && requestedSort === "newest" ? "ending_late" : requestedSort];
  if (sort) {
    url.searchParams.set("s1", sort[0]);
    url.searchParams.set("o1", sort[1]);
  }
  return url;
}

function plansForRequest(request: SearchRequest): SearchConfiguration {
  const query = request.query.trim();
  if (!query || query.length > 100) {
    throw new YahooAuctionsError("Yahoo!オークション搜索词长度必须为 1～100 字符", "yahoo_auctions_invalid_request", 400);
  }
  const page = requestedPage(request);
  const pageSize = requiredInteger(request.filters.pageSize ?? 20, "pageSize", 1, 50) ?? 20;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > 15_000) {
    throw new YahooAuctionsError("Yahoo!オークション分页超过上游 15000 偏移上限", "yahoo_auctions_invalid_request", 400);
  }
  const minPrice = requiredInteger(request.filters.minPrice, "minPrice", 0, Number.MAX_SAFE_INTEGER);
  const maxPrice = requiredInteger(request.filters.maxPrice, "maxPrice", 0, Number.MAX_SAFE_INTEGER);
  const minBidCount = requiredInteger(request.sourceConfig?.minBidCount, "minBidCount", 0, Number.MAX_SAFE_INTEGER);
  const maxBidCount = requiredInteger(request.sourceConfig?.maxBidCount, "maxBidCount", 0, Number.MAX_SAFE_INTEGER);
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new YahooAuctionsError("最低价不能高于最高价", "yahoo_auctions_invalid_request", 400);
  }
  if (minBidCount !== undefined && maxBidCount !== undefined && minBidCount > maxBidCount) {
    throw new YahooAuctionsError("最低出价数不能高于最高出价数", "yahoo_auctions_invalid_request", 400);
  }
  const conditions = explicitConditionCodes(request.sourceConfig?.auctionConditionCodes)
    ?? normalizedConditionCodes(request.filters.conditions);
  const parameters = {
    categories: categoryIds(request.sourceConfig?.categoryIds),
    conditions,
    minPrice,
    maxPrice,
    freeShipping: booleanConfig(request.sourceConfig?.freeShipping, "freeShipping"),
    buyNow: booleanConfig(request.sourceConfig?.buyNow, "buyNow"),
  };
  const mode = searchAvailabilityMode(request.filters);
  const scopes: YahooAuctionsScope[] = mode === "all" ? ["open", "closed"] : [mode === "sold_out" ? "closed" : "open"];
  const warnings = [
    ...(request.filters.sort === "newest" && scopes.includes("closed")
      ? ["Yahoo!オークション已结束页没有等价的新上架排序；本次使用最近结束顺序。"] : []),
    ...(minBidCount !== undefined || maxBidCount !== undefined
      ? ["Yahoo!オークション公开网页没有稳定的出价数查询参数；本次仅在当前页结果内应用出价数筛选。"] : []),
  ];
  return {
    page,
    pageSize,
    minBidCount,
    maxBidCount,
    warnings,
    plans: scopes.map((scope) => ({
      scope,
      url: searchUrl(request, scope, page, pageSize, parameters),
      ...(conditionHint(conditions) ? { conditionHint: conditionHint(conditions) } : {}),
    })),
  };
}

function bidCount(listing: NormalizedListing): number | undefined {
  const value = listing.rawMetadata?.bidCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function matchesBidRange(listing: NormalizedListing, minimum?: number, maximum?: number): boolean {
  if (minimum === undefined && maximum === undefined) return true;
  const value = bidCount(listing);
  if (value === undefined) return false;
  return (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum);
}

function auctionIdFromInput(value: string): string {
  const trimmed = value.trim();
  if (isYahooAuctionId(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new YahooAuctionsError("Yahoo!オークション商品 ID 或链接无效", "yahoo_auctions_invalid_item_id", 400);
  }
  if (url.origin !== YAHOO_AUCTIONS_ORIGIN || url.username || url.password || url.port || url.search || url.hash) {
    throw new YahooAuctionsError("Yahoo!オークション商品链接不在固定来源域名", "yahoo_auctions_invalid_item_id", 400);
  }
  const match = url.pathname.match(/^\/jp\/auction\/([A-Za-z0-9]{8,16})\/?$/u);
  if (!match?.[1]) {
    throw new YahooAuctionsError("Yahoo!オークション商品链接格式无效", "yahoo_auctions_invalid_item_id", 400);
  }
  return match[1];
}

export function createYahooAuctionsAdapter(options: YahooAuctionsAdapterOptions = {}): SourceAdapter {
  return {
    id: "yahoo_auctions_jp",
    transport: "html_endpoint",
    parserVersion: YAHOO_AUCTIONS_PARSER_VERSION,
    coverage: "best_effort",
    capabilities: {
      keywordSearch: true,
      itemLookup: true,
      newestSort: true,
      priceFilter: true,
      conditionFilter: true,
      supportsUsed: true,
      supportsSoldOut: true,
      historySearchSupported: true,
      supportsMarketplace: true,
    },
    fieldProfile: {
      required: ["sourceItemId", "canonicalUrl", "title", "currentPrice"],
      optional: ["imageUrl", "facts.imageUrls", "facts.displayFacts"],
    },
    healthcheckQuery: "ポケモンカード",
    healthcheckSourceConfig: { page: 1 },
    async search(request, context): Promise<SearchResult> {
      if (text(context.secrets.YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED)?.toLowerCase() !== "true") {
        throw new YahooAuctionsError(
          "Yahoo!オークション实验来源功能开关未开启",
          "yahoo_auctions_experiment_disabled",
          503,
        );
      }
      const timeoutMs = configuredInteger(context.secrets.YAHOO_AUCTIONS_TIMEOUT_MS, 15_000, 5_000, 20_000);
      const configuredDelay = configuredInteger(context.secrets.YAHOO_AUCTIONS_RATE_INTERVAL_MS, 2_000, 2_000, 10_000);
      const interRequestDelayMs = options.interRequestDelayMs ?? configuredDelay;
      const retryDelayMs = options.retryDelayMs ?? configuredDelay;
      const signal = yahooAuctionsSignal(context.signal, timeoutMs);
      const configuration = plansForRequest(request);
      const listings: SearchResult["listings"] = [];
      const totals: number[] = [];
      const scopeCounts: number[] = [];
      let rawResultCount = 0;
      let rejectedCount = 0;

      for (let index = 0; index < configuration.plans.length; index += 1) {
        if (index > 0) await waitForYahooAuctionsDelay(interRequestDelayMs, signal);
        const plan = configuration.plans[index]!;
        const fetched = await fetchYahooAuctionsHtml(context.fetch, plan.url, signal, "search", retryDelayMs);
        const parsed = plan.scope === "closed"
          ? parseYahooAuctionsClosedSearchHtml(fetched.html)
          : parseYahooAuctionsOpenSearchHtml(fetched.html);
        if (fetched.status === 404 && parsed.items.length === 0 && parsed.totalAvailable !== 0) {
          throw new YahooAuctionsError(
            "Yahoo!オークション 404 空页面没有明确返回零条结果",
            "yahoo_auctions_bad_response",
            502,
            false,
          );
        }
        if (parsed.partialKeywordFallback) {
          configuration.warnings.push(
            "Yahoo!オークション没有同时包含全部关键词的商品；已丢弃 Yahoo 自动删减关键词后的替代结果。",
          );
        }
        rawResultCount += parsed.items.length;
        scopeCounts.push(parsed.items.length);
        for (const row of parsed.items) {
          const sourceRow = record(row);
          const normalized = normalizeYahooAuctionsSearchItem(
            plan.conditionHint && sourceRow.itemCondition === undefined
              ? { ...sourceRow, itemCondition: plan.conditionHint }
              : sourceRow,
            plan.scope,
          );
          if (normalized && matchesBidRange(normalized, configuration.minBidCount, configuration.maxBidCount)) listings.push(normalized);
          else rejectedCount += 1;
        }
        if (parsed.totalAvailable !== undefined) totals.push(parsed.totalAvailable);
      }

      if (rawResultCount > 0 && listings.length === 0 && configuration.minBidCount === undefined && configuration.maxBidCount === undefined) {
        throw new YahooAuctionsError(
          "Yahoo!オークション结果全部缺少安全核心字段",
          "yahoo_auctions_bad_response",
          502,
          false,
        );
      }
      if (rejectedCount > 0) configuration.warnings.push(`Yahoo!オークション有 ${rejectedCount} 件未通过当前页安全字段或出价数筛选。`);
      configuration.warnings.push(EXPERIMENTAL_WARNING, "结果为有界分页，不代表 Yahoo!オークション完整库存；在售价格可能随出价变化。");
      const hasLocalBidFilter = configuration.minBidCount !== undefined || configuration.maxBidCount !== undefined;
      const totalAvailable = !hasLocalBidFilter && totals.length === configuration.plans.length
        ? totals.reduce((sum, value) => sum + value, 0)
        : undefined;
      const offset = (configuration.page - 1) * configuration.pageSize;
      const hasMore = totals.length === configuration.plans.length
        ? totals.some((total) => offset + configuration.pageSize < total)
        : scopeCounts.some((count) => count >= configuration.pageSize);
      return {
        sourceId: "yahoo_auctions_jp",
        listings,
        coverage: "best_effort",
        ...(hasMore ? { nextCursor: String(configuration.page + 1) } : {}),
        ...(totalAvailable === undefined ? {} : { totalAvailable }),
        warnings: [...new Set(configuration.warnings.map((warning) => warning.trim()).filter(Boolean))],
        parserVersion: YAHOO_AUCTIONS_PARSER_VERSION,
        fetchedAt: new Date().toISOString(),
        requestEvidence: {
          availabilityMode: searchAvailabilityMode(request.filters),
          requestedStatuses: configuration.plans.map((plan) => plan.scope === "closed" ? "CLOSED" : "OPEN"),
          rawResultCount,
          normalizedResultCount: listings.length,
          pagesFetched: configuration.plans.length,
          parserAcceptedCount: listings.length,
          parserRejectedCount: rejectedCount,
        },
      };
    },
    async getItem(urlOrId, context) {
      if (text(context.secrets.YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED)?.toLowerCase() !== "true") {
        throw new YahooAuctionsError(
          "Yahoo!オークション实验来源功能开关未开启",
          "yahoo_auctions_experiment_disabled",
          503,
        );
      }
      const auctionId = auctionIdFromInput(urlOrId);
      const timeoutMs = configuredInteger(context.secrets.YAHOO_AUCTIONS_TIMEOUT_MS, 15_000, 5_000, 20_000);
      const configuredDelay = configuredInteger(context.secrets.YAHOO_AUCTIONS_RATE_INTERVAL_MS, 2_000, 2_000, 10_000);
      const signal = yahooAuctionsSignal(context.signal, timeoutMs);
      const fetched = await fetchYahooAuctionsHtml(
        context.fetch,
        new URL(`/jp/auction/${auctionId}`, YAHOO_AUCTIONS_ORIGIN),
        signal,
        "detail",
        options.retryDelayMs ?? configuredDelay,
      );
      const listing = normalizeYahooAuctionsDetail(parseYahooAuctionsDetailHtml(fetched.html, auctionId), auctionId);
      if (!listing || listing.sourceItemId !== auctionId) {
        throw new YahooAuctionsError(
          "Yahoo!オークション详情响应缺少安全核心字段",
          "yahoo_auctions_bad_response",
          502,
          false,
        );
      }
      return listing;
    },
  };
}

export const yahooAuctionsAdapter = createYahooAuctionsAdapter();
