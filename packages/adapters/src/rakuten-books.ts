import {
  filterListings,
  numericPageToken,
  searchAvailabilityMode,
  type NormalizedListing,
  type ProductDisplayFact,
  type SearchRequest,
  type SourceAdapter,
} from "../../core/src/index.js";
import { AdapterError, fetchJson, integer, list, ParserStructureError, record, requireArrayFieldAny, text, uniqueListings } from "./http.js";
import { rakutenRequestHeaders, withRakutenRateLimit } from "./rakuten-auth.js";

function availability(value: unknown): NormalizedListing["availability"] {
  const code = String(value ?? "");
  if (["1", "2", "3"].includes(code)) return "available";
  if (code === "5") return "preorder";
  if (["4", "6"].includes(code)) return "backorder";
  return "unknown";
}

function normalize(body: unknown): NormalizedListing[] {
  const entries = requireArrayFieldAny(body, ["items", "Items"]);
  const listings = entries.flatMap((entry): NormalizedListing[] => {
    const item = record(record(entry).Item ?? entry);
    const sourceItemId = text(item.jan) ?? text(item.isbn) ?? text(item.itemCode);
    const canonicalUrl = text(item.itemUrl) ?? text(item.affiliateUrl); const title = text(item.title);
    if (!sourceItemId || !canonicalUrl || !title) return [];
    const jan = text(item.jan);
    const isbn = text(item.isbn);
    const author = text(item.author);
    const publisherName = text(item.publisherName);
    const descriptionExcerpt = (
      text(item.itemCaption)
      ?? text(item.contents)
      ?? text(item.subTitle)
    )?.replace(/\s+/gu, " ").trim().slice(0, 2_500);
    const displayFacts: ProductDisplayFact[] = [];
    if (author) displayFacts.push({ key: "author", label: "作者", group: "catalog", kind: "text", value: author });
    if (publisherName) {
      displayFacts.push({ key: "publisher", label: "出版社", group: "catalog", kind: "text", value: publisherName });
    }
    return [{ sourceId: "rakuten_books", sourceItemId, identityScope: "catalog", canonicalUrl, title,
      ...(descriptionExcerpt ? { descriptionExcerpt } : {}),
      imageUrl: text(item.largeImageUrl) ?? text(item.mediumImageUrl), shopName: "Rakuten Books", currency: "JPY",
      currentPrice: integer(item.itemPrice), priceBasis: "catalog_price", condition: "new",
      availability: availability(item.availability), facts: {
        ...(jan || isbn ? { identifiers: { ...(jan ? { jan } : {}), ...(isbn ? { isbn } : {}) } } : {}),
        sourceConditionLabel: "新品",
        ...(displayFacts.length > 0 ? { displayFacts } : {}),
        provenance: {
          ...(jan || isbn ? { identifiers: { method: "official_api", sourceLabel: "Rakuten Books API" } } : {}),
          sourceConditionLabel: { method: "official_api", sourceLabel: "Rakuten Books API" },
          ...(displayFacts.length > 0 ? { displayFacts: { method: "official_api", sourceLabel: "Rakuten Books API" } } : {}),
        },
      },
      sourceListedAt: text(item.salesDate), rawMetadata: {
        author,
        publisherName,
        sourceConditionLabel: "新品",
        identifiers: { jan, isbn },
      } }];
  });
  if (entries.length > 0 && listings.length === 0) throw new ParserStructureError("Rakuten Books 商品字段结构失效");
  return uniqueListings(listings);
}

function credentials(context: Parameters<SourceAdapter["search"]>[1]): { applicationId: string; accessKey: string } {
  const applicationId = context.secrets.RAKUTEN_APPLICATION_ID; const accessKey = context.secrets.RAKUTEN_ACCESS_KEY;
  if (!applicationId || !accessKey) throw new AdapterError("Rakuten Books 凭据未配置", "credentials_missing");
  return { applicationId, accessKey };
}

function affiliateId(context: Parameters<SourceAdapter["search"]>[1]): string | undefined {
  if (context.secrets.RAKUTEN_AFFILIATE_MODE !== "true") return undefined;
  return context.secrets.RAKUTEN_AFFILIATE_ID || undefined;
}

function requestedPage(request: SearchRequest): number {
  return numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 100);
}

function pageCount(body: unknown, totalAvailable: number | undefined, hits: number): number | undefined {
  const explicit = integer(record(body).pageCount);
  if (explicit !== undefined) return Math.max(0, Math.min(explicit, 100));
  if (totalAvailable === undefined || hits < 1) return undefined;
  return Math.min(100, Math.ceil(totalAvailable / hits));
}

export const rakutenBooksAdapter: SourceAdapter = {
  id: "rakuten_books",
  transport: "official_api",
  parserVersion: "2017-04-04.v1",
  coverage: "rolling_window",
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: true, priceFilter: true, conditionFilter: false, supportsUsed: false, historySearchSupported: false },
  async search(request, context) {
    const { applicationId, accessKey } = credentials(context);
    const hits = Math.max(1, Math.min(request.filters.pageSize ?? 30, 30));
    const page = requestedPage(request);

    const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404");
    url.searchParams.set("applicationId", applicationId);
    url.searchParams.set("keyword", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatVersion", "2");
    url.searchParams.set("field", "0");
    url.searchParams.set("orFlag", request.sourceConfig?.matchMode === "any" ? "1" : "0");
    url.searchParams.set("hits", String(hits));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", request.filters.sort === "newest" ? "-releaseDate" : "standard");
    url.searchParams.set("outOfStockFlag", request.filters.inStockOnly ? "0" : "1");
    if (request.filters.inStockOnly) url.searchParams.set("availability", "1");
    const affiliate = affiliateId(context);
    if (affiliate) url.searchParams.set("affiliateId", affiliate);

    const body = await withRakutenRateLimit(() => fetchJson(context.fetch, url, { signal: context.signal, headers: rakutenRequestHeaders(context, accessKey) }));
    const listings = filterListings(normalize(body), request.filters);
    const totalAvailable = integer(record(body).count);
    const totalPages = pageCount(body, totalAvailable, hits);
    const hasMore = totalPages !== undefined ? page < totalPages : listings.length >= hits && page < 100;
    return {
      sourceId: "rakuten_books",
      listings,
      coverage: "rolling_window",
      ...(hasMore ? { nextCursor: String(page + 1) } : {}),
      ...(totalAvailable === undefined ? {} : { totalAvailable }),
      warnings: [
        "Rakuten Books 使用广义字段匹配；多个关键词默认仍按 AND 组合，可显式选择任意词匹配。",
        ...(hasMore ? ["结果为有界分页，当前响应不代表 Rakuten Books 完整库存。"] : []),
      ],
      parserVersion: this.parserVersion,
      fetchedAt: new Date().toISOString(),
      requestEvidence: {
        availabilityMode: searchAvailabilityMode(request.filters),
        rawResultCount: list(record(body).items ?? record(body).Items).length,
        normalizedResultCount: listings.length,
        pagesFetched: 1,
      },
    };
  },
  async getItem(urlOrId, context) {
    const { applicationId, accessKey } = credentials(context);
    if (!/^\d{13}$/.test(urlOrId)) throw new Error("Rakuten Books 单品监控需要 13 位 ISBN/JAN");
    const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404");
    url.searchParams.set("applicationId", applicationId);
    url.searchParams.set("isbnjan", urlOrId); url.searchParams.set("hits", "1");
    url.searchParams.set("format", "json"); url.searchParams.set("formatVersion", "2");
    const affiliate = affiliateId(context);
    if (affiliate) url.searchParams.set("affiliateId", affiliate);
    const listing = normalize(await withRakutenRateLimit(() => fetchJson(context.fetch, url, { signal: context.signal, headers: rakutenRequestHeaders(context, accessKey) })))[0];
    if (!listing) throw new Error("Rakuten Books 商品不存在或已不可见");
    return listing;
  },
};
