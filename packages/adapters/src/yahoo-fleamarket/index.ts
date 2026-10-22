import {
  filterListings,
  numericPageToken,
  searchAvailabilityMode,
  type Availability,
  type ItemCondition,
  type NormalizedListing,
  type ProductDisplayFact,
  type ProductFacts,
  type SearchRequest,
  type SearchResult,
  type SourceAdapter,
} from "../../../core/src/index.js";
import { AdapterError, list, ParserStructureError, record, text, uniqueListings } from "../http.js";
import { fetchPublicHtml } from "../html.js";

export const YAHOO_FLEAMARKET_ORIGIN = "https://paypayfleamarket.yahoo.co.jp";
export const YAHOO_FLEAMARKET_PARSER_VERSION = "yahoo-fleamarket-next-data-2026-07-19.2";

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_PAGE = 100;
const PUBLIC_HTML_WARNING = "Yahoo!フリマ使用匿名公开网页，不是 Yahoo 官方公开 API；字段、分页与可用性可能随上游变化。";
const CURRENT_ONLY_WARNING = "Yahoo!フリマ公开搜索只提供当前可见商品，不声称覆盖已售出历史或完整库存。";
const BASE_HTML_POLICY = {
  label: "Yahoo!フリマ",
  allowedHosts: ["paypayfleamarket.yahoo.co.jp"] as const,
  allowedPath: (pathname: string) => /^\/search\/[^/]{1,800}$/u.test(pathname) || /^\/item\/[A-Za-z0-9_-]{1,100}$/u.test(pathname),
  isLoginPage: yahooFleamarketLoginPage,
  minBytes: 2_000,
  maxBytes: 1_500_000,
  timeoutMs: 15_000,
};
const SEARCH_HTML_POLICY = { ...BASE_HTML_POLICY, acceptedStatusCodes: [404] as const };
const ITEM_HTML_POLICY = BASE_HTML_POLICY;

interface ParsedSearchResult {
  items: unknown[];
  totalAvailable?: number;
  totalReturned?: number;
  offset?: number;
  /** The full query had no hits and the page was refilled by a "similar items" search. */
  vectorFallback?: boolean;
}

// A zero-hit query does not return an empty page: Yahoo!フリマ retries it as a
// semantic search and shows "similar" items (「高木さん からかいパーカー グレー Lサイズ」
// came back as 100 unrelated grey hoodies). The state flags it as
// retriedWithVectorSearch and the page shows this sentence; either one means
// the page is treated as zero results.
const VECTOR_FALLBACK_NOTICE = /一致する商品が見つからなかったため、検索キーワードに近い商品を表示/u;

function boundedText(value: unknown, maximum = 500): string | undefined {
  const parsed = text(value);
  return parsed ? parsed.slice(0, maximum) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeDate(value: unknown): string | undefined {
  const parsed = boundedText(value, 80);
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : undefined;
}

function safeImageUrl(value: unknown): string | undefined {
  const raw = boundedText(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, YAHOO_FLEAMARKET_ORIGIN);
    const allowedHost = url.hostname === "yimg.jp" || url.hostname.endsWith(".yimg.jp")
      || url.hostname === "yahoo.co.jp" || url.hostname.endsWith(".yahoo.co.jp");
    return url.protocol === "https:" && allowedHost && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function nextData(html: string): Record<string, unknown> {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    const attributes = match[1] ?? "";
    if (!/\bid=["']__NEXT_DATA__["']/iu.test(attributes)) continue;
    try {
      const parsed = JSON.parse(match[2] ?? "null") as unknown;
      const data = record(parsed);
      if (Object.keys(data).length > 0) return data;
    } catch {
      throw new ParserStructureError("Yahoo!フリマ __NEXT_DATA__ 无法解析");
    }
  }
  throw new ParserStructureError("Yahoo!フリマ 页面缺少 __NEXT_DATA__");
}

function nestedRecord(root: unknown, path: readonly string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of path) current = record(current)[key];
  return record(current);
}

function yahooFleamarketLoginPage(html: string, finalUrl: URL): boolean {
  if (!/ログインしてください|login\s+required/iu.test(html)) return false;
  try {
    if (finalUrl.pathname.startsWith("/search/")) {
      const result = nestedRecord(nextData(html), ["props", "initialState", "searchState", "search", "result"]);
      return !Array.isArray(result.items);
    }
    if (finalUrl.pathname.startsWith("/item/")) {
      const item = nestedRecord(nextData(html), ["props", "initialState", "itemsState", "items", "item"]);
      return Object.keys(item).length === 0;
    }
  } catch {
    return true;
  }
  return true;
}

export function parseYahooFleamarketSearchHtml(html: string): ParsedSearchResult {
  const result = nestedRecord(nextData(html), ["props", "initialState", "searchState", "search", "result"]);
  if (!Array.isArray(result.items)) {
    throw new ParserStructureError("Yahoo!フリマ 搜索结构缺少 result.items");
  }
  if (record(result.metadata).retriedWithVectorSearch === true || VECTOR_FALLBACK_NOTICE.test(html)) {
    return { items: [], totalAvailable: 0, totalReturned: 0, vectorFallback: true };
  }
  return {
    items: result.items,
    totalAvailable: nonNegativeInteger(result.totalResultsAvailable),
    totalReturned: nonNegativeInteger(result.totalResultsReturned),
    offset: nonNegativeInteger(result.offset),
  };
}

export function parseYahooFleamarketItemHtml(html: string): Record<string, unknown> {
  const item = nestedRecord(nextData(html), ["props", "initialState", "itemsState", "items", "item"]);
  if (Object.keys(item).length === 0) {
    throw new ParserStructureError("Yahoo!フリマ 商品结构缺少 items.item");
  }
  return item;
}

function nameList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const names = values.flatMap((entry) => {
    const direct = boundedText(entry, 200);
    if (direct) return [direct];
    const row = record(entry);
    const name = boundedText(row.name ?? row.label ?? row.title, 200);
    const path = list(row.path).flatMap((part) => {
      const pathName = boundedText(record(part).name ?? part, 200);
      return pathName ? [pathName] : [];
    });
    return [...path, ...(name ? [name] : [])];
  });
  return [...new Set(names)].slice(0, 20);
}

function conditionParts(value: unknown): { condition: ItemCondition; label?: string } {
  const row = record(value);
  const key = boundedText(row.key, 100);
  const label = boundedText(row.name ?? row.label, 100) ?? boundedText(value, 100) ?? key;
  const normalized = (key ?? label)?.normalize("NFKC").toLowerCase();
  if (normalized && /^(?:new|unused)$/u.test(normalized)) return { condition: "new", ...(label ? { label } : {}) };
  if (normalized && /未使用/u.test(normalized)) return { condition: "new", ...(label ? { label } : {}) };
  if (normalized && /^(?:like_new|good|fair|poor|bad)$/u.test(normalized)) return { condition: "used", ...(label ? { label } : {}) };
  if (normalized && /used|使用|傷|汚れ/u.test(normalized)) return { condition: "used", ...(label ? { label } : {}) };
  return { condition: "unknown", ...(label ? { label } : {}) };
}

function availability(value: unknown): Availability {
  const raw = boundedText(value, 80)?.normalize("NFKC").toUpperCase();
  if (!raw) return "unknown";
  if (raw === "OPEN" || /SELLING|AVAILABLE|出品中/u.test(raw)) return "available";
  if (/SOLD|CLOSED|ENDED|売り切れ|購入済/u.test(raw)) return "sold_out";
  if (/STOP|SUSPEND|DELETE|UNAVAILABLE/u.test(raw)) return "unavailable";
  return "unknown";
}

function fact(key: string, label: string, group: ProductDisplayFact["group"], value: string | number | undefined): ProductDisplayFact[] {
  return value === undefined || value === "" ? [] : [{ key, label, group, kind: "text", value: String(value).slice(0, 500) }];
}

function listFact(key: string, label: string, group: ProductDisplayFact["group"], values: readonly string[]): ProductDisplayFact[] {
  return values.length ? [{ key, label, group, kind: "list", values: values.slice(0, 20) }] : [];
}

function imageUrls(row: Record<string, unknown>): string[] {
  const images = [
    safeImageUrl(row.thumbnailImageUrl),
    safeImageUrl(row.imageUrl),
    ...list(row.imageUrls).map(safeImageUrl),
    ...list(row.images).map((value) => {
      const image = record(value);
      return safeImageUrl(image.url ?? image.imageUrl ?? image.src ?? value);
    }),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(images)].slice(0, 30);
}

function itemId(row: Record<string, unknown>, requestedId?: string): string | undefined {
  const value = boundedText(row.id ?? row.itemId, 100) ?? requestedId;
  return value && ITEM_ID_PATTERN.test(value) ? value : undefined;
}

function normalizeItem(value: unknown, requestedId?: string): NormalizedListing | undefined {
  const row = record(value);
  const id = itemId(row, requestedId);
  const title = boundedText(row.title, 1_000);
  const price = nonNegativeInteger(row.price);
  if (!id || !title || price === undefined) return undefined;

  const categories = nameList(row.category);
  const brands = nameList(row.brand);
  const brand = brands.at(-1);
  const tags = nameList(row.hashtag ?? row.hashtags);
  const images = imageUrls(row);
  const condition = conditionParts(row.condition);
  const sourceStatus = boundedText(row.itemStatus ?? row.status, 80);
  const seller = record(row.seller);
  const sellerName = boundedText(seller.nickname ?? seller.name ?? seller.displayName, 300);
  const sourceListedAt = safeDate(row.openTime ?? row.createDate);
  const sourceUpdatedAt = safeDate(row.updateDate ?? row.updatedAt);
  const description = boundedText(row.description, 2_500);
  const likeCount = nonNegativeInteger(row.likeCount);
  const imageCount = nonNegativeInteger(row.imageCount);
  const displayFacts: ProductDisplayFact[] = [
    ...fact("fleamarket_id", "商品 ID", "identity", id),
    ...fact("source_condition", "来源品相", "catalog", condition.label),
    ...listFact("category_path", "商品分类", "catalog", categories),
    ...fact("source_status", "来源状态", "commerce", sourceStatus),
    ...fact("like_count", "收藏数", "commerce", likeCount),
    ...fact("image_count", "图片数", "other", imageCount),
  ];
  const facts: ProductFacts = {
    identifiers: { sourceCatalogId: id },
    ...(brand ? { brand } : {}),
    ...(categories.length ? { categoryPath: categories } : {}),
    ...(tags.length ? { tags } : {}),
    ...(images.length ? { imageUrls: images } : {}),
    ...(condition.label ? { sourceConditionLabel: condition.label } : {}),
    ...(sourceStatus ? { sourceAvailabilityLabel: sourceStatus } : {}),
    ...(displayFacts.length ? { displayFacts } : {}),
    provenance: {
      identifiers: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 },
      ...(brand ? { brand: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(categories.length ? { categoryPath: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(tags.length ? { tags: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(images.length ? { imageUrls: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(condition.label ? { sourceConditionLabel: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(sourceStatus ? { sourceAvailabilityLabel: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
      ...(displayFacts.length ? { displayFacts: { method: "html", sourceLabel: "Yahoo!フリマ公开网页", confidence: 1 } } : {}),
    },
  };
  return {
    sourceId: "yahoo_fleamarket_jp",
    sourceItemId: id,
    identityScope: "listing",
    canonicalUrl: `${YAHOO_FLEAMARKET_ORIGIN}/item/${encodeURIComponent(id)}`,
    title,
    ...(description ? { descriptionExcerpt: description } : {}),
    ...(images[0] ? { imageUrl: images[0] } : {}),
    ...(sellerName ? { sellerName } : {}),
    currency: "JPY",
    currentPrice: price,
    priceBasis: "listing_price",
    condition: condition.condition,
    availability: availability(sourceStatus),
    ...(sourceListedAt ? { sourceListedAt } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    facts,
    rawMetadata: {
      ...(sourceStatus ? { sourceStatus } : {}),
      ...(condition.label ? { conditionRaw: condition.label } : {}),
      ...(likeCount === undefined ? {} : { likeCount }),
      ...(imageCount === undefined ? {} : { imageCount }),
      ...(boundedText(row.sellerId, 100) ? { sellerId: boundedText(row.sellerId, 100) } : {}),
    },
  };
}

export function normalizeYahooFleamarketItem(value: unknown, requestedId?: string): NormalizedListing | undefined {
  return normalizeItem(value, requestedId);
}

function searchUrl(request: SearchRequest, page: number): URL {
  const query = request.query.trim();
  if (!query || Array.from(query).length > 200) {
    throw new ParserStructureError("Yahoo!フリマ 搜索词长度必须为 1～200 字符");
  }
  const url = new URL(`${YAHOO_FLEAMARKET_ORIGIN}/search/${encodeURIComponent(query)}`);
  url.searchParams.set("page", String(page));
  // 网页端「新着順」即 sort=openTime&order=desc（2026-09-13 实测上游回显 openTime/DESC）。
  if (request.filters.sort === "newest") {
    url.searchParams.set("sort", "openTime");
    url.searchParams.set("order", "desc");
  }
  return url;
}

function itemUrl(value: string): { id: string; url: URL } {
  const trimmed = value.trim();
  let id = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.origin !== YAHOO_FLEAMARKET_ORIGIN || url.username || url.password || url.port) {
      throw new ParserStructureError("Yahoo!フリマ 商品 URL 不在固定来源范围内");
    }
    id = url.pathname.match(/^\/item\/([A-Za-z0-9_-]{1,100})\/?$/u)?.[1] ?? "";
  } catch (error) {
    if (error instanceof ParserStructureError) throw error;
  }
  if (!ITEM_ID_PATTERN.test(id)) throw new ParserStructureError("Yahoo!フリマ 商品 ID 格式无效");
  return { id, url: new URL(`${YAHOO_FLEAMARKET_ORIGIN}/item/${encodeURIComponent(id)}`) };
}

export const yahooFleamarketAdapter: SourceAdapter = {
  id: "yahoo_fleamarket_jp",
  transport: "html_endpoint",
  parserVersion: YAHOO_FLEAMARKET_PARSER_VERSION,
  coverage: "rolling_window",
  capabilities: {
    keywordSearch: true,
    itemLookup: true,
    newestSort: false,
    priceFilter: true,
    conditionFilter: true,
    supportsUsed: true,
    supportsSoldOut: false,
    historySearchSupported: false,
    supportsMarketplace: true,
  },
  fieldProfile: {
    required: ["sourceItemId", "canonicalUrl", "title", "currentPrice"],
    optional: ["imageUrl", "facts.brand", "facts.imageUrls", "facts.displayFacts"],
  },
  healthcheckQuery: "リゼロ",
  async search(request, context): Promise<SearchResult> {
    const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, MAX_PAGE);
    const fetched = await fetchPublicHtml(context.fetch, searchUrl(request, page), SEARCH_HTML_POLICY, context.signal);
    const parsed = parseYahooFleamarketSearchHtml(fetched.html);
    if (fetched.status === 404 && parsed.items.length === 0 && parsed.totalAvailable !== 0) {
      throw new ParserStructureError("Yahoo!フリマ 404 空页面没有明确返回零条搜索结果");
    }
    const normalized = uniqueListings(parsed.items.flatMap((item) => {
      const listing = normalizeItem(item);
      return listing ? [listing] : [];
    }));
    const listings = filterListings(normalized, request.filters);
    const returned = parsed.totalReturned ?? parsed.items.length;
    const offset = parsed.offset ?? ((page - 1) * Math.max(returned, 1));
    const hasNext = page < MAX_PAGE && parsed.totalAvailable !== undefined
      && returned > 0 && offset + returned < parsed.totalAvailable;
    const mode = searchAvailabilityMode(request.filters);
    const warnings = [
      PUBLIC_HTML_WARNING,
      CURRENT_ONLY_WARNING,
      ...(request.filters.sort && request.filters.sort !== "relevance" && request.filters.sort !== "newest"
        ? ["Yahoo!フリマ公开搜索未使用未经验证的排序参数；本次保留上游默认顺序。"] : []),
      ...(mode === "sold_out" ? ["Yahoo!フリマ公开搜索不提供稳定的已售出历史，本次不会伪造已售结果。"] : []),
      ...(parsed.vectorFallback
        ? ["Yahoo!フリマ没有同时包含全部关键词的商品；已丢弃 Yahoo!フリマ 自动改用相近搜索后的替代结果。"] : []),
    ];
    return {
      sourceId: "yahoo_fleamarket_jp",
      listings,
      coverage: "rolling_window",
      ...(hasNext ? { nextCursor: String(page + 1) } : {}),
      ...(parsed.totalAvailable === undefined ? {} : { totalAvailable: parsed.totalAvailable }),
      warnings,
      parserVersion: YAHOO_FLEAMARKET_PARSER_VERSION,
      fetchedAt: new Date().toISOString(),
      requestEvidence: {
        availabilityMode: mode,
        requestedStatuses: mode === "sold_out" ? ["SOLD"] : ["OPEN"],
        rawResultCount: parsed.items.length,
        normalizedResultCount: listings.length,
        pagesFetched: 1,
        parserAcceptedCount: normalized.length,
        parserRejectedCount: Math.max(0, parsed.items.length - normalized.length),
      },
    };
  },
  async getItem(urlOrId, context): Promise<NormalizedListing> {
    const target = itemUrl(urlOrId);
    const fetched = await fetchPublicHtml(
      context.fetch,
      target.url,
      ITEM_HTML_POLICY,
      context.signal,
    ).catch((error: unknown) => {
      if (error instanceof AdapterError && error.code === "http_404") {
        throw new AdapterError(
          "Yahoo!フリマ 商品不存在或已下架",
          "yahoo_fleamarket_item_not_found",
          404,
          false,
        );
      }
      throw error;
    });
    const listing = normalizeItem(parseYahooFleamarketItemHtml(fetched.html), target.id);
    if (!listing) throw new ParserStructureError("Yahoo!フリマ 商品详情缺少必要字段");
    return listing;
  },
};
