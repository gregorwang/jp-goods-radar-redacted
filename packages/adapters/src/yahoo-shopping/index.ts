import {
  numericPageToken,
  searchAvailabilityMode,
  type SearchRequest,
  type SearchResult,
  type SourceAdapter,
} from "../../../core/src/index.js";
import { text } from "../http.js";
import { YahooExperimentalError } from "./errors.js";
import { normalizeYahooListings } from "./normalize.js";
import { parseYahooSearchHtml } from "./parser.js";
import {
  buildYahooBootstrapUrl,
  resolveYahooShoppingPageUrl,
  waitForYahooNextPage,
  YahooWebSession,
} from "./request.js";

export { YahooExperimentalError } from "./errors.js";
export { extractYahooNextData, parseYahooBootstrapHtml, parseYahooResultPage, parseYahooSearchHtml } from "./parser.js";
export { buildYahooBootstrapUrl, resolveYahooShoppingPageUrl } from "./request.js";

export const YAHOO_EXPERIMENTAL_PARSER_VERSION = "yahoo-shopping-next-data-html-2026-07-19.1";
const EXPERIMENTAL_WARNING = "Yahoo! Shopping 实验来源只读取匿名公开 HTML；字段和可用性可能随上游页面变化。";

export interface YahooShoppingAdapterOptions {
  /** Test-only override. Production keeps the protocol floor at 2 seconds. */
  pageDelayMs?: number;
}

function configuredInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function requestedPageCount(request: SearchRequest, maximum: number): number {
  const configured = request.sourceConfig?.pageCount ?? request.sourceConfig?.pages;
  const parsed = typeof configured === "number" ? configured : Number(configured);
  if (!Number.isInteger(parsed)) return 1;
  return Math.max(1, Math.min(parsed, maximum));
}

function requestedTargetPage(request: SearchRequest, maximum: number): number | undefined {
  if (request.sourceConfig?.pageToken === undefined) return undefined;
  return numericPageToken(request.sourceConfig.pageToken, 1, maximum);
}

function unsupportedWarnings(request: SearchRequest): string[] {
  const warnings = [EXPERIMENTAL_WARNING, "Yahoo 实验来源暂不提供稳定的新品/中古、已售出历史或精确库存状态。"];
  if (request.filters.conditions?.length) warnings.push("已保留 Yahoo 结果，但未应用新品/中古筛选。 ");
  if (request.filters.inStockOnly || searchAvailabilityMode(request.filters) === "purchasable") {
    warnings.push("Yahoo 搜索结果的库存状态未获稳定字段支持；最终可购状态以商品页为准。");
  }
  return warnings;
}

async function fetchSession(
  request: SearchRequest,
  context: Parameters<SourceAdapter["search"]>[1],
  pageCount: number,
  targetPage: number | undefined,
  maximumPages: number,
  pageDelayMs: number,
): Promise<SearchResult> {
  const bootstrapUrl = buildYahooBootstrapUrl(request);
  const session = new YahooWebSession(context.fetch, context.signal);
  const bootstrap = parseYahooSearchHtml(await session.bootstrap(bootstrapUrl), 1);
  const rawItems = targetPage === undefined || targetPage === 1 ? [...bootstrap.items] : [];
  const warnings = [...bootstrap.warnings];
  let nextUrl = bootstrap.nextUrl;
  let totalAvailable = bootstrap.totalAvailable;
  let fetchedThroughPage = 1;
  let referer = bootstrapUrl;
  const lastPageToFetch = targetPage ?? pageCount;

  for (let page = 2; page <= lastPageToFetch && nextUrl; page += 1) {
    await waitForYahooNextPage(pageDelayMs, context.signal);
    const pageUrl = resolveYahooShoppingPageUrl(nextUrl);
    const parsed = parseYahooSearchHtml(await session.page(pageUrl.href, referer), page);
    if (targetPage === undefined || page === targetPage) rawItems.push(...parsed.items);
    warnings.push(...parsed.warnings);
    nextUrl = parsed.nextUrl;
    totalAvailable = parsed.totalAvailable ?? totalAvailable;
    fetchedThroughPage = page;
    referer = pageUrl;
  }

  const normalized = normalizeYahooListings(rawItems);
  if (normalized.rejectedCount > 0) warnings.push(`Yahoo 有 ${normalized.rejectedCount} 个缺少安全核心字段的商品已被隔离。`);
  const logicalPagesFetched = targetPage === undefined ? fetchedThroughPage : 1;
  const hasMore = Boolean(nextUrl) && fetchedThroughPage >= lastPageToFetch && lastPageToFetch < maximumPages;
  if (nextUrl) warnings.push(`本次读取 ${targetPage === undefined ? `${fetchedThroughPage} 页` : `第 ${targetPage} 页`}，未宣称覆盖 Yahoo 全部库存。`);
  warnings.push(...unsupportedWarnings(request));

  return {
    sourceId: "yahoo_shopping",
    listings: normalized.listings,
    coverage: "rolling_window",
    ...(hasMore ? { nextCursor: String(lastPageToFetch + 1) } : {}),
    ...(totalAvailable !== undefined ? { totalAvailable } : {}),
    warnings: [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))],
    parserVersion: YAHOO_EXPERIMENTAL_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount: rawItems.length,
      normalizedResultCount: normalized.listings.length,
      pagesFetched: logicalPagesFetched,
      parserAcceptedCount: rawItems.length - normalized.rejectedCount,
      parserRejectedCount: normalized.rejectedCount,
    },
  };
}

export function createYahooShoppingAdapter(options: YahooShoppingAdapterOptions = {}): SourceAdapter {
  return {
    id: "yahoo_shopping",
    transport: "html_endpoint",
    parserVersion: YAHOO_EXPERIMENTAL_PARSER_VERSION,
    coverage: "rolling_window",
    capabilities: {
      keywordSearch: true,
      itemLookup: false,
      newestSort: false,
      priceFilter: true,
      conditionFilter: false,
      supportsUsed: false,
      supportsSoldOut: false,
      historySearchSupported: false,
    },
    fieldProfile: {
      required: ["sourceItemId", "canonicalUrl", "title", "currentPrice"],
      optional: ["imageUrl", "facts.identifiers.sku", "facts.brand"],
    },
    healthcheckQuery: "陶器",
    healthcheckSourceConfig: { categoryId: "0", pageCount: 1 },
    async search(request, context) {
      if (text(context.secrets.YAHOO_WEB_EXPERIMENTAL_ENABLED)?.toLowerCase() !== "true") {
        throw new YahooExperimentalError("Yahoo 实验来源功能开关未开启", "yahoo_experiment_disabled", 503);
      }
      const maximumPages = configuredInteger(context.secrets.YAHOO_WEB_EXPERIMENTAL_MAX_PAGES, 3, 1, 3);
      const pageCount = requestedPageCount(request, maximumPages);
      const targetPage = requestedTargetPage(request, maximumPages);
      const configuredDelay = configuredInteger(context.secrets.YAHOO_WEB_EXPERIMENTAL_DELAY_MS, 2_000, 2_000, 10_000);
      const pageDelayMs = options.pageDelayMs ?? configuredDelay;
      return fetchSession(request, context, pageCount, targetPage, maximumPages, pageDelayMs);
    },
  };
}

export const yahooShoppingAdapter = createYahooShoppingAdapter();
