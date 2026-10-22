import { filterListings, numericPageToken, searchAvailabilityMode, type AdapterContext, type NormalizedListing, type SearchRequest, type SearchResult } from "../../../core/src/index.js";
import { uniqueListings } from "../http.js";
import { classifySurugayaSearchHtml, parseSurugayaResponse } from "./parser.js";
import { fetchSurugayaHtml } from "./request.js";
import { SURUGAYA_PARSER_VERSION } from "./selectors.js";

export interface SurugayaSearchInput {
  keyword: string;
  category?: string;
  includeMarketplace?: boolean;
  sort?: "modificationTime:descending" | "price:ascending" | "price:descending";
  page?: number;
  pages?: number;
  onlyInStock?: boolean;
}

function searchInput(request: SearchRequest): SurugayaSearchInput {
  const config = request.sourceConfig ?? {};
  const cursorPage = numericPageToken(config.pageToken, request.filters.page ?? 1, 2);
  return {
    keyword: request.query,
    category: typeof config.category === "string" ? config.category : "",
    includeMarketplace: config.includeMarketplace === true,
    sort: request.filters.sort === "price_asc" ? "price:ascending" : request.filters.sort === "price_desc" ? "price:descending" : "modificationTime:descending",
    page: cursorPage,
    pages: config.pageToken === undefined && typeof config.pages === "number" ? config.pages : 1,
    onlyInStock: searchAvailabilityMode(request.filters) === "purchasable",
  };
}

function searchUrl(input: SurugayaSearchInput, page: number): URL {
  const url = new URL("https://www.suruga-ya.jp/search");
  url.searchParams.set("category", input.category ?? "");
  url.searchParams.set("search_word", input.keyword);
  url.searchParams.set("is_marketplace", input.includeMarketplace ? "1" : "0");
  url.searchParams.set("rankBy", input.sort ?? "modificationTime:descending");
  url.searchParams.set("page", String(page));
  if (!input.onlyInStock) {
    url.searchParams.set("ck", "true");
    url.searchParams.set("inStock", "On");
  }
  return url;
}

export async function searchSurugaya(request: SearchRequest, context: AdapterContext): Promise<SearchResult> {
  const input = searchInput(request);
  const pageCount = Math.max(1, Math.min(input.pages ?? 1, 2));
  const firstPage = Math.max(1, input.page ?? 1);
  const groups: NormalizedListing[][] = [];
  const pageClassifications: ReturnType<typeof classifySurugayaSearchHtml>[] = [];
  const warnings = [pageCount === 1
    ? "最近修改排序不等同于首次上架；默认只读取一页有限滚动窗口"
    : "最近修改排序不等同于首次上架；本次按显式配置读取前两页有限滚动窗口"];
  if (!input.onlyInStock) warnings.push("已按骏河屋官方品切れ开关包含无库存商品");

  for (let offset = 0; offset < pageCount; offset += 1) {
    const fetched = await fetchSurugayaHtml(context.fetch, searchUrl(input, firstPage + offset), context.signal);
    pageClassifications.push(classifySurugayaSearchHtml(fetched.html));
    const pageListings = await parseSurugayaResponse(fetched.response, fetched.html);
    for (const listing of pageListings) listing.rawMetadata = { ...listing.rawMetadata, pageBytes: fetched.byteLength, containerCount: pageListings.length };
    groups.push(pageListings);
  }
  let listings = uniqueListings(groups.flat());
  if (input.onlyInStock) listings = listings.filter((item) => item.availability === "available");
  listings = filterListings(listings, request.filters);
  const rawResultCount = groups.reduce((total, group) => total + group.length, 0);
  const collectionOutcome = rawResultCount > 0
    ? "items" as const
    : pageClassifications.length > 0 && pageClassifications.every((value) => value.kind === "verified_empty")
      ? "verified_empty" as const
      : undefined;
  if (collectionOutcome === "verified_empty") {
    warnings.push("骏河屋页面明确返回 0 件；本轮记为已验证空结果，而非来源故障");
  }
  const lastPage = firstPage + groups.length - 1;
  const hasMore = rawResultCount > 0 && lastPage < 2;
  return {
    sourceId: "surugaya",
    listings,
    coverage: "rolling_window",
    ...(hasMore ? { nextCursor: String(lastPage + 1) } : {}),
    warnings,
    parserVersion: SURUGAYA_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount,
      normalizedResultCount: listings.length,
      pagesFetched: groups.length,
      ...(collectionOutcome ? { collectionOutcome } : {}),
    },
  };
}
