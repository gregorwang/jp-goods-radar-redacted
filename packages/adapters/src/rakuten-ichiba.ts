import {
  numericPageToken,
  searchAvailabilityMode,
  type NormalizedListing,
  type ProductDisplayFact,
  type SearchRequest,
  type SourceAdapter,
} from "../../core/src/index.js";
import { AdapterError, fetchJson, integer, list, ParserStructureError, record, requireArrayFieldAny, text, uniqueListings } from "./http.js";
import { fetchPublicHtml, itempropContent } from "./html.js";
import { rakutenRequestHeaders, withRakutenRateLimit } from "./rakuten-auth.js";

const RAKUTEN_ITEM_PARSER_VERSION = "2026-07-01.v2";
const RAKUTEN_ITEM_POLICY = {
  label: "Rakuten Ichiba 商品页",
  allowedHosts: ["item.rakuten.co.jp"],
  allowedPath: (pathname: string) => /^\/[^/]{1,100}\/[^/]{1,540}\/?$/u.test(pathname),
  minBytes: 10_000,
  maxBytes: 1_500_000,
  timeoutMs: 15_000,
} as const;

function firstImageUrl(value: unknown): string | undefined {
  for (const candidate of list(value)) {
    const direct = text(candidate);
    if (direct?.startsWith("https://")) return direct;
    const nested = text(record(candidate).imageUrl);
    if (nested?.startsWith("https://")) return nested;
  }
  return undefined;
}

function itemAvailability(value: unknown): NormalizedListing["availability"] {
  const availability = integer(value);
  if (availability === 1) return "available";
  if (availability === 0) return "sold_out";
  return "unknown";
}

function normalize(body: unknown): NormalizedListing[] {
  const entries = requireArrayFieldAny(body, ["items", "Items"]);
  const listings = entries.flatMap((entry): NormalizedListing[] => {
    const item = record(record(entry).Item ?? entry);
    const sourceItemId = text(item.itemCode);
    const canonicalUrl = text(item.itemUrl) ?? text(item.affiliateUrl);
    const title = text(item.itemName);
    if (!sourceItemId || !canonicalUrl || !title) return [];
    const jan = text(item.jan);
    const pointRate = integer(item.pointRate);
    const genreId = text(item.genreId);
    const displayFacts: ProductDisplayFact[] = [];
    if (pointRate !== undefined) {
      displayFacts.push({ key: "point_rate", label: "积分倍率", group: "commerce", kind: "text", value: `${pointRate} 倍` });
    }
    if (genreId) {
      displayFacts.push({ key: "genre_id", label: "乐天分类 ID", group: "catalog", kind: "text", value: genreId });
    }
    return [{
      sourceId: "rakuten_ichiba", sourceItemId, identityScope: "listing", canonicalUrl, title,
      descriptionExcerpt: text(item.itemCaption)?.slice(0, 280),
      imageUrl: firstImageUrl(item.mediumImageUrls) ?? firstImageUrl(item.smallImageUrls),
      shopName: text(item.shopName), currency: "JPY", currentPrice: integer(item.itemPrice),
      priceBasis: "listing_price", condition: "new", availability: itemAvailability(item.availability),
      sourceUpdatedAt: text(item.updateTimestamp), facts: {
        ...(jan ? { identifiers: { jan } } : {}),
        sourceConditionLabel: "新品",
        ...(displayFacts.length > 0 ? { displayFacts } : {}),
        provenance: {
          ...(jan ? { identifiers: { method: "official_api", sourceLabel: "Rakuten Ichiba API" } } : {}),
          sourceConditionLabel: { method: "official_api", sourceLabel: "Rakuten Ichiba API" },
          ...(displayFacts.length > 0 ? { displayFacts: { method: "official_api", sourceLabel: "Rakuten Ichiba API" } } : {}),
        },
      }, rawMetadata: {
        pointRate,
        genreId,
        sourceConditionLabel: "新品",
        identifiers: { jan },
      },
    }];
  });
  if (entries.length > 0 && listings.length === 0) throw new ParserStructureError("Rakuten Ichiba 商品字段结构失效");
  return uniqueListings(listings);
}

function splitItemCode(value: string): { shopCode: string; itemPath: string } {
  const separator = value.indexOf(":");
  const shopCode = separator > 0 ? value.slice(0, separator) : "";
  const itemPath = separator > 0 ? value.slice(separator + 1) : "";
  if (
    !/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/iu.test(shopCode)
    || !itemPath
    || itemPath.length > 180
    || /[\/\\:\u0000-\u0020\u007f]/u.test(itemPath)
  ) {
    throw new ParserStructureError("Rakuten 单品监控需要稳定 itemCode");
  }
  return { shopCode: shopCode.toLowerCase(), itemPath };
}

function itemPageUrl(value: string): URL {
  const { shopCode, itemPath } = splitItemCode(value);
  return new URL(`https://item.rakuten.co.jp/${encodeURIComponent(shopCode)}/${encodeURIComponent(itemPath)}/`);
}

function pageAvailability(value: string | undefined): NormalizedListing["availability"] {
  const label = value?.split("/").at(-1)?.toLowerCase();
  if (label === "instock") return "available";
  if (label === "outofstock" || label === "soldout") return "sold_out";
  if (label === "preorder") return "preorder";
  if (label === "backorder") return "backorder";
  if (label === "discontinued") return "unavailable";
  return "unknown";
}

export function parseRakutenItemHtml(
  html: string,
  requestedItemCode: string,
  canonicalUrl: URL,
): NormalizedListing {
  const sourceItemId = itempropContent(html, "sku");
  const title = itempropContent(html, "name");
  if (!sourceItemId || !title || sourceItemId.toLowerCase() !== requestedItemCode.toLowerCase()) {
    throw new ParserStructureError("Rakuten 商品页缺少匹配的稳定 ID 或标题");
  }
  const sourceAvailabilityLabel = itempropContent(html, "availability");
  const price = integer(itempropContent(html, "price"));
  const imageUrl = itempropContent(html, "image");
  return {
    sourceId: "rakuten_ichiba",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl: canonicalUrl.href,
    title,
    descriptionExcerpt: itempropContent(html, "description")?.slice(0, 280),
    imageUrl: imageUrl?.startsWith("https://") ? imageUrl : undefined,
    currency: "JPY",
    currentPrice: price,
    priceBasis: "listing_price",
    condition: "new",
    availability: pageAvailability(sourceAvailabilityLabel),
    facts: {
      identifiers: { sku: sourceItemId },
      sourceAvailabilityLabel,
      sourceConditionLabel: "新品",
      provenance: {
        identifiers: { method: "html", sourceLabel: "Rakuten 商品页" },
        sourceAvailabilityLabel: { method: "html", sourceLabel: "schema.org availability" },
        sourceConditionLabel: { method: "html", sourceLabel: "Rakuten 商品页" },
      },
    },
    rawMetadata: {
      sourceAvailabilityLabel: sourceAvailabilityLabel ?? null,
      sourceConditionLabel: "新品",
      inventorySource: "public_item_microdata",
      parserVersion: RAKUTEN_ITEM_PARSER_VERSION,
    },
  };
}

function shouldUseItemPageFallback(error: unknown): boolean {
  return error instanceof AdapterError
    && (
      error.code === "http_404"
      || (error.code === "http_400" && /itemCode is not valid/iu.test(error.message))
    );
}

export async function getRakutenIchibaItemFromApi(
  urlOrId: string,
  context: Parameters<NonNullable<SourceAdapter["getItem"]>>[1],
): Promise<NormalizedListing> {
  const { applicationId, accessKey } = credentials(context);
  itemPageUrl(urlOrId);
  const url = new URL("https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701");
  url.searchParams.set("applicationId", applicationId);
  url.searchParams.set("itemCode", urlOrId);
  url.searchParams.set("hits", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  // The official API defaults availability to 1 (in-stock only). Item
  // monitoring must retrieve sold-out SKUs too or a normal stockout becomes
  // indistinguishable from a deleted item.
  url.searchParams.set("availability", "0");
  const affiliate = affiliateId(context);
  if (affiliate) url.searchParams.set("affiliateId", affiliate);
  const listing = normalize(await withRakutenRateLimit(() => fetchJson(context.fetch, url, {
    signal: context.signal,
    headers: rakutenRequestHeaders(context, accessKey),
  })))[0];
  if (!listing) throw new ParserStructureError("Rakuten 商品不存在或已不可见");
  return listing;
}

export async function getRakutenIchibaItemFromPage(
  urlOrId: string,
  context: Parameters<NonNullable<SourceAdapter["getItem"]>>[1],
): Promise<NormalizedListing> {
  const canonicalUrl = itemPageUrl(urlOrId);
  const fetched = await fetchPublicHtml(context.fetch, canonicalUrl, RAKUTEN_ITEM_POLICY, context.signal);
  return parseRakutenItemHtml(fetched.html, urlOrId, fetched.finalUrl);
}

function credentials(context: Parameters<SourceAdapter["search"]>[1]): { applicationId: string; accessKey: string } {
  const applicationId = context.secrets.RAKUTEN_APPLICATION_ID;
  const accessKey = context.secrets.RAKUTEN_ACCESS_KEY;
  if (!applicationId || !accessKey) throw new AdapterError("Rakuten Ichiba 凭据未配置", "credentials_missing");
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

export const rakutenIchibaAdapter: SourceAdapter = {
  id: "rakuten_ichiba",
  transport: "official_api",
  parserVersion: RAKUTEN_ITEM_PARSER_VERSION,
  coverage: "rolling_window",
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: true, priceFilter: true, conditionFilter: false, supportsUsed: false, supportsSoldOut: true, historySearchSupported: false },
  async search(request, context) {
    const { applicationId, accessKey } = credentials(context);
    const hits = Math.max(1, Math.min(request.filters.pageSize ?? 30, 30));
    const page = requestedPage(request);

    const url = new URL("https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701");
    url.searchParams.set("applicationId", applicationId);
    url.searchParams.set("keyword", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatVersion", "2");
    url.searchParams.set("field", "0");
    url.searchParams.set("orFlag", request.sourceConfig?.matchMode === "any" ? "1" : "0");
    url.searchParams.set("imageFlag", request.sourceConfig?.imageOnly === true ? "1" : "0");
    url.searchParams.set("hits", String(hits));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", request.filters.sort === "newest" ? "-updateTimestamp" : "standard");
    if (request.filters.minPrice !== undefined) url.searchParams.set("minPrice", String(request.filters.minPrice));
    if (request.filters.maxPrice !== undefined) url.searchParams.set("maxPrice", String(request.filters.maxPrice));
    url.searchParams.set("availability", request.filters.inStockOnly ? "1" : "0");
    const affiliate = affiliateId(context);
    if (affiliate) url.searchParams.set("affiliateId", affiliate);

    const body = await withRakutenRateLimit(() => fetchJson(context.fetch, url, { signal: context.signal, headers: rakutenRequestHeaders(context, accessKey) }));
    const listings = normalize(body);
    const totalAvailable = integer(record(body).count);
    const totalPages = pageCount(body, totalAvailable, hits);
    const hasMore = totalPages !== undefined ? page < totalPages : listings.length >= hits && page < 100;
    return {
      sourceId: "rakuten_ichiba",
      listings,
      coverage: "rolling_window",
      ...(hasMore ? { nextCursor: String(page + 1) } : {}),
      ...(totalAvailable === undefined ? {} : { totalAvailable }),
      warnings: [
        "Rakuten Ichiba 使用广义字段匹配；多个关键词默认仍按 AND 组合，可显式选择任意词匹配。",
        ...(hasMore ? ["结果为有界分页，当前响应不代表 Rakuten Ichiba 完整库存。"] : []),
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
    try {
      return await getRakutenIchibaItemFromApi(urlOrId, context);
    } catch (error) {
      if (!shouldUseItemPageFallback(error)) throw error;
      try {
        return await getRakutenIchibaItemFromPage(urlOrId, context);
      } catch (pageError) {
        const failure = pageError instanceof AdapterError ? pageError : undefined;
        throw new AdapterError(
          `Rakuten API 未收录该 itemCode；商品页兜底失败：${pageError instanceof Error ? pageError.message.slice(0, 300) : "未知错误"}`,
          "rakuten_item_page_fallback_failed",
          failure?.status,
          failure?.retryable ?? false,
          failure?.retryAfterSeconds,
        );
      }
    }
  },
};
