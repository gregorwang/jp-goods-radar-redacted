import {
  filterListings,
  numericPageToken,
  searchAvailabilityMode,
  type Availability,
  type ItemCondition,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SourceAdapter,
} from "../../../core/src/index.js";
import { AdapterError, ParserStructureError, uniqueListings } from "../http.js";
import {
  decodeHtmlEntities,
  fetchPublicHtml,
  parseYenText,
  stripHtml,
} from "../html.js";

export const AMAZON_HTML_PARSER_VERSION = "amazon-html-v1";

const ASIN = /^[A-Z0-9]{10}$/u;
const AMAZON_COOKIE = "i18n-prefs=JPY; lc-acbjp=ja_JP";
const AMAZON_POLICY = {
  label: "Amazon Japan",
  allowedHosts: ["www.amazon.co.jp", "amazon.co.jp"] as const,
  allowedPath: (pathname: string) => pathname === "/s" || pathname === "/s/"
    || /^\/(?:[^/]{1,300}\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}\/?$/iu.test(pathname),
  minBytes: 2_000,
  maxBytes: 2_000_000,
  timeoutMs: 20_000,
};

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "iu"))?.[2];
  return value ? decodeHtmlEntities(value).trim() : undefined;
}

function amazonFetch(fetcher: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", AMAZON_COOKIE);
    return fetcher(input, { ...init, headers });
  }) as typeof fetch;
}

function asinFrom(value: string): string {
  const direct = value.trim().toUpperCase();
  if (ASIN.test(direct)) return direct;
  try {
    const url = new URL(value);
    if (!["amazon.co.jp", "www.amazon.co.jp"].includes(url.hostname)) throw new Error("wrong_host");
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/iu);
    if (match?.[1]) return match[1].toUpperCase();
  } catch {
    // The stable identifier error below is safe to expose.
  }
  throw new AdapterError("仅接受 Amazon Japan ASIN 或官方商品链接", "amazon_invalid_item_id");
}

function searchUrl(request: SearchRequest): URL {
  const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 20);
  const url = new URL("https://www.amazon.co.jp/s");
  url.searchParams.set("k", request.query);
  url.searchParams.set("language", "ja_JP");
  if (page > 1) url.searchParams.set("page", String(page));
  if (request.filters.sort === "newest") url.searchParams.set("s", "date-desc-rank");
  if (request.filters.sort === "price_asc") url.searchParams.set("s", "price-asc-rank");
  if (request.filters.sort === "price_desc") url.searchParams.set("s", "price-desc-rank");
  return url;
}

function amazonImage(block: string): string | undefined {
  for (const match of block.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    const classes = attribute(tag, "class")?.split(/\s+/u) ?? [];
    if (!classes.includes("s-image")) continue;
    const value = attribute(tag, "src");
    if (!value) continue;
    try {
      const url = new URL(value);
      const allowed = url.protocol === "https:"
        && (url.hostname.endsWith(".media-amazon.com")
          || url.hostname.endsWith(".ssl-images-amazon.com"));
      if (allowed) return url.href;
    } catch {
      // Ignore malformed optional image URLs.
    }
  }
  return undefined;
}

function jpyPrice(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = decodeHtmlEntities(value).normalize("NFKC");
  if (!/[¥￥]|円/u.test(normalized)) return undefined;
  const price = parseYenText(normalized);
  return price !== undefined && price > 0 ? price : undefined;
}

function priceForClass(
  block: string,
  requiredClass: string,
  excludedClass?: string,
): { price?: number; label?: string } {
  for (const match of block.matchAll(/<span\b[^>]*class=(["'])(.*?)\1[^>]*>/giu)) {
    const classes = (match[2] ?? "").split(/\s+/u);
    if (!classes.includes(requiredClass) || (excludedClass && classes.includes(excludedClass))) continue;
    const start = match.index + match[0].length;
    const nearby = block.slice(start, start + 900);
    const label = stripHtml(
      nearby.match(/<span\b[^>]*class=(["'])[^"']*\ba-offscreen\b[^"']*\1[^>]*>([\s\S]*?)<\/span>/iu)?.[2]
      ?? "",
    );
    const price = jpyPrice(label);
    if (price !== undefined) return { price, label };
  }
  return {};
}

function conditionFromText(text: string): { condition: ItemCondition; label: string } {
  if (/中古品|中古|used/iu.test(text)) return { condition: "used", label: "中古品" };
  if (/整備済|renewed|refurbished/iu.test(text)) return { condition: "refurbished", label: "整備済み品" };
  if (/コレクター商品|collectible/iu.test(text)) return { condition: "collectible", label: "コレクター商品" };
  return { condition: "new", label: "新品の主オファー" };
}

function availabilityFromText(text: string, price: number | undefined): {
  availability: Availability;
  label?: string;
} {
  const label = text.match(/現在在庫切れ|一時的に在庫切れ|在庫切れ|現在お取り扱いできません/u)?.[0];
  if (label) return { availability: "unavailable", label };
  const preorder = text.match(/予約注文|予約受付中|発売予定/u)?.[0];
  if (preorder) return { availability: "preorder", label: preorder };
  return price === undefined
    ? { availability: "unknown" }
    : { availability: "available", label: "価格表示あり" };
}

function resultBlocks(html: string): Array<{ asin: string; block: string }> {
  const markers = [...html.matchAll(/<div\b[^>]*\bdata-component-type=(["'])s-search-result\1[^>]*>/giu)];
  const blocks: Array<{ asin: string; block: string }> = [];
  markers.forEach((marker, index) => {
    const asin = attribute(marker[0], "data-asin")?.toUpperCase();
    if (!asin || !ASIN.test(asin)) return;
    const start = marker.index;
    const end = markers[index + 1]?.index ?? html.length;
    blocks.push({ asin, block: html.slice(start, end) });
  });
  return blocks;
}

function hasNextPage(html: string): boolean {
  for (const match of html.matchAll(/<a\b[^>]*>/giu)) {
    const classes = attribute(match[0], "class")?.split(/\s+/u) ?? [];
    if (classes.includes("s-pagination-next") && attribute(match[0], "aria-disabled") !== "true") return true;
  }
  return false;
}

export function parseAmazonSearchHtml(html: string): {
  listings: NormalizedListing[];
  hasNextPage: boolean;
} {
  const listings: NormalizedListing[] = [];
  for (const { asin, block } of resultBlocks(html)) {
    const title = stripHtml(block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/iu)?.[1] ?? "");
    if (!title) continue;
    const current = priceForClass(block, "a-price", "a-text-price");
    const crossedOut = priceForClass(block, "a-text-price");
    const originalPrice = crossedOut.price !== undefined
      && current.price !== undefined
      && crossedOut.price > current.price
      ? crossedOut.price
      : undefined;
    const text = stripHtml(block);
    const condition = conditionFromText(text);
    const availability = availabilityFromText(text, current.price);
    const imageUrl = amazonImage(block);
    listings.push({
      sourceId: "amazon_jp",
      sourceItemId: asin,
      identityScope: "catalog",
      canonicalUrl: `https://www.amazon.co.jp/dp/${asin}`,
      title,
      imageUrl,
      shopName: "Amazon.co.jp",
      currency: "JPY",
      currentPrice: current.price,
      originalPrice,
      priceBasis: "catalog_price",
      condition: condition.condition,
      availability: availability.availability,
      facts: {
        identifiers: { asin },
        imageUrls: imageUrl ? [imageUrl] : undefined,
        ...(originalPrice === undefined ? {} : {
          priceReferences: [{
            kind: "source_compare_at",
            amountJpy: originalPrice,
            currency: "JPY",
            taxStatus: "unknown",
            shippingStatus: "unknown",
            sourceLabel: "Amazon Japan 划线参考价",
          }],
        }),
        sourceAvailabilityLabel: availability.label,
        sourceConditionLabel: condition.label,
        provenance: {
          identifiers: { method: "html", sourceLabel: "Amazon Japan 搜索结果" },
          imageUrls: { method: "html" },
          ...(originalPrice === undefined ? {} : {
            priceReferences: { method: "html", sourceLabel: "Amazon Japan 搜索结果" },
          }),
        },
      },
      rawMetadata: {
        parserVersion: AMAZON_HTML_PARSER_VERSION,
        priceText: current.label ?? null,
        originalPriceText: originalPrice === undefined ? null : crossedOut.label ?? null,
        sourceAvailabilityLabel: availability.label ?? null,
        sourceConditionLabel: condition.label,
      },
    });
  }
  const unique = uniqueListings(listings);
  // 2026-09 起 Amazon 的空结果页改成「検索クエリに一致する結果はありません」，
  // 漏认会把"搜不到"当成结构变化，天天报错并发失败邮件。
  const verifiedEmpty = /検索結果はありません|一致する(?:商品|結果)はありません|該当する商品がありません/u.test(html);
  if (unique.length === 0 && !verifiedEmpty) {
    if (/api-services-support@amazon|Enter the characters you see below|画像に表示されている文字を入力/iu.test(html)) {
      throw new AdapterError("Amazon Japan 出现 CAPTCHA", "captcha");
    }
    throw new ParserStructureError("Amazon Japan 商品列表结构发生变化");
  }
  return { listings: unique, hasNextPage: hasNextPage(html) };
}

async function fetchAmazonSearch(
  request: SearchRequest,
  context: Parameters<SourceAdapter["search"]>[1],
): Promise<{ parsed: ReturnType<typeof parseAmazonSearchHtml>; page: number }> {
  const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 20);
  const fetched = await fetchPublicHtml(
    amazonFetch(context.fetch),
    searchUrl(request),
    AMAZON_POLICY,
    context.signal,
  );
  return { parsed: parseAmazonSearchHtml(fetched.html), page };
}

async function searchAmazon(
  request: SearchRequest,
  context: Parameters<SourceAdapter["search"]>[1],
): Promise<SearchResult> {
  const { parsed, page } = await fetchAmazonSearch(request, context);
  const pageSize = Math.min(Math.max(request.filters.pageSize ?? parsed.listings.length, 1), 48);
  const listings = filterListings(parsed.listings, request.filters).slice(0, pageSize);
  return {
    sourceId: "amazon_jp",
    listings,
    coverage: "best_effort",
    ...(parsed.hasNextPage && page < 20 ? { nextCursor: String(page + 1) } : {}),
    warnings: ["结果来自 Amazon Japan 公开搜索 HTML；仅覆盖当前公开结果窗口，商品描述不会在搜索页补全"],
    parserVersion: AMAZON_HTML_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount: parsed.listings.length,
      normalizedResultCount: listings.length,
      pagesFetched: 1,
    },
  };
}

export const amazonJapanAdapter: SourceAdapter = {
  id: "amazon_jp",
  transport: "html_endpoint",
  parserVersion: AMAZON_HTML_PARSER_VERSION,
  coverage: "best_effort",
  healthcheckQuery: "雪ミク",
  capabilities: {
    keywordSearch: true,
    itemLookup: true,
    newestSort: true,
    priceFilter: true,
    conditionFilter: true,
    supportsUsed: true,
    supportsSoldOut: false,
    historySearchSupported: false,
  },
  fieldProfile: {
    required: ["sourceItemId", "canonicalUrl", "title"],
    optional: ["currentPrice", "imageUrl", "availability", "facts.identifiers.asin", "facts.imageUrls"],
  },
  search: searchAmazon,
  async getItem(value, context) {
    const asin = asinFrom(value);
    const { parsed } = await fetchAmazonSearch(
      { query: asin, filters: { page: 1, pageSize: 48, availabilityMode: "all" } },
      context,
    );
    const listing = parsed.listings.find((candidate) => candidate.sourceItemId === asin);
    if (!listing) {
      throw new AdapterError("Amazon Japan 搜索未返回指定 ASIN", "amazon_item_not_found", 404, false);
    }
    return listing;
  },
};
