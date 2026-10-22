import { record } from "../http.js";
import { decodeHtmlEntities, jsonLdObjects, stripHtml } from "../html.js";
import { YahooAuctionsError } from "./errors.js";

export interface YahooAuctionsParsedSearch {
  items: unknown[];
  totalAvailable?: number;
  /** Yahoo found nothing for the full query and filled the page with a looser search. */
  partialKeywordFallback?: boolean;
}

// Yahoo never answers a zero-hit query with an empty page: it silently drops
// some keywords, searches again, and says so in this sentence. Those items do
// not contain the full query (a target like 「小木曽雪菜 ぬいぐるみ」 comes back as
// generic ぬいぐるみ), so the page is treated as zero results. The open page
// also returns HTTP 404 here, but the closed page returns 200, so only this
// sentence is shared by both.
const PARTIAL_KEYWORD_FALLBACK_PATTERN = /キーワードの一部を利用した結果/u;

function badResponse(message: string): never {
  throw new YahooAuctionsError(message, "yahoo_auctions_bad_response", 502, false);
}

function boundedText(value: unknown, maximum = 2_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  const normalized = typeof value === "string" ? value.normalize("NFKC").replace(/,/g, "") : value;
  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (key && value !== undefined) attributes[key] = decodeHtmlEntities(value).trim();
  }
  return attributes;
}

function hasClass(tag: string, className: string): boolean {
  return (parseAttributes(tag).class ?? "").split(/\s+/u).includes(className);
}

function openingTagWithClass(html: string, tagName: string, className: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "giu");
  for (const match of html.matchAll(pattern)) {
    if (hasClass(match[0], className)) return match[0];
  }
  return undefined;
}

function productCards(html: string): string[] {
  const cards: string[] = [];
  for (const match of html.matchAll(/<li\b[^>]*>/giu)) {
    if (!hasClass(match[0], "Product") || match.index === undefined) continue;
    const start = match.index;
    const tokenPattern = /<li\b[^>]*>|<\/li\s*>/giu;
    tokenPattern.lastIndex = start + match[0].length;
    let depth = 1;
    let token: RegExpExecArray | null;
    while ((token = tokenPattern.exec(html)) !== null) {
      depth += /^<li\b/iu.test(token[0]) ? 1 : -1;
      if (depth === 0) {
        cards.push(html.slice(start, tokenPattern.lastIndex));
        break;
      }
    }
  }
  return cards;
}

function unixSeconds(value: string | undefined): string | undefined {
  const seconds = nonNegativeInteger(value);
  if (seconds === undefined || seconds > 32_503_680_000) return undefined;
  return new Date(seconds * 1_000).toISOString();
}

function booleanAttribute(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (["1", "true"].includes(value.toLowerCase())) return true;
  if (["0", "false"].includes(value.toLowerCase())) return false;
  return undefined;
}

function categoryPath(value: string | undefined): Array<{ id: number }> {
  if (!value) return [];
  return value.split(",").slice(0, 20).flatMap((entry) => {
    const id = nonNegativeInteger(entry);
    return id === undefined ? [] : [{ id }];
  });
}

function classText(html: string, tagName: string, className: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}\\s*>`, "giu");
  for (const match of html.matchAll(pattern)) {
    if (hasClass(`<${tagName}${match[1] ?? ""}>`, className)) return stripHtml(match[2] ?? "");
  }
  return undefined;
}

function parseOpenCard(card: string): Record<string, unknown> {
  const titleTag = openingTagWithClass(card, "a", "Product__titleLink")
    ?? openingTagWithClass(card, "a", "Product__imageLink");
  const titleAttributes = titleTag ? parseAttributes(titleTag) : {};
  const bonusTag = openingTagWithClass(card, "div", "Product__bonus");
  const bonusAttributes = bonusTag ? parseAttributes(bonusTag) : {};
  const auctionId = boundedText(titleAttributes["data-auction-id"] ?? bonusAttributes["data-auction-id"], 16);
  const price = nonNegativeInteger(titleAttributes["data-auction-price"] ?? bonusAttributes["data-auction-price"]);
  const buyNowPrice = nonNegativeInteger(bonusAttributes["data-auction-buynowprice"]);
  const bidCount = nonNegativeInteger(classText(card, "dd", "Product__bid"));
  const eventMetadata = titleAttributes["data-cl-params"] ?? "";
  const startTime = unixSeconds(/(?:^|;)st:(\d{1,12})(?:;|$)/u.exec(eventMetadata)?.[1]);
  const watchCount = nonNegativeInteger(/(?:^|,)w=(\d+)(?:,|$)/u.exec(eventMetadata)?.[1]);
  const categoryId = nonNegativeInteger(titleAttributes["data-auction-category"]);
  const categories = categoryPath(bonusAttributes["data-auction-categoryidpath"]);
  return {
    ...(auctionId ? { auctionId } : {}),
    ...(boundedText(titleAttributes["data-auction-title"], 1_000) ? { title: boundedText(titleAttributes["data-auction-title"], 1_000) } : {}),
    ...(price === undefined ? {} : { price }),
    ...(boundedText(titleAttributes["data-auction-img"]) ? { imageUrl: boundedText(titleAttributes["data-auction-img"]) } : {}),
    ...(buyNowPrice === undefined || buyNowPrice === 0 ? {} : { buyNowPrice }),
    ...(bidCount === undefined ? {} : { bidCount }),
    ...(watchCount === undefined ? {} : { watchCount }),
    ...(startTime ? { startTime } : {}),
    ...(unixSeconds(bonusAttributes["data-auction-endtime"]) ? { endTime: unixSeconds(bonusAttributes["data-auction-endtime"]) } : {}),
    ...(categoryId === undefined ? {} : { category: { id: categoryId } }),
    ...(categories.length ? { categoryPath: categories } : {}),
    ...(booleanAttribute(titleAttributes["data-auction-isfreeshipping"]) === undefined
      ? {} : { isFreeShipping: booleanAttribute(titleAttributes["data-auction-isfreeshipping"]) }),
    ...(booleanAttribute(titleAttributes["data-auction-isflea"]) === undefined
      ? {} : { isFleamarketItem: booleanAttribute(titleAttributes["data-auction-isflea"]) }),
    ...(booleanAttribute(bonusAttributes["data-auction-isshoppingitem"]) === undefined
      ? {} : { isShoppingItem: booleanAttribute(bonusAttributes["data-auction-isshoppingitem"]) }),
  };
}

function openSearchTotal(html: string): number | undefined {
  const match = /<li\b[^>]*class=["'][^"']*Tab__item--current[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*class=["'][^"']*Tab__subText[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu.exec(html);
  return nonNegativeInteger(stripHtml(match?.[1] ?? "").replace(/[^0-9]/g, ""));
}

export function parseYahooAuctionsOpenSearchHtml(html: string): YahooAuctionsParsedSearch {
  if (PARTIAL_KEYWORD_FALLBACK_PATTERN.test(html)) return { items: [], totalAvailable: 0, partialKeywordFallback: true };
  const cards = productCards(html);
  // Since 2026-10-14 the open page is the same Next.js page as the closed one:
  // no Product cards, the listing lives in __NEXT_DATA__.
  if (cards.length === 0 && /\bid=["']__NEXT_DATA__["']/iu.test(html)) {
    const parsed = nextDataListing(html, "在售页");
    return {
      ...parsed,
      // The card page never reported a zero buy-now price; keep it that way.
      items: parsed.items.map((item) => {
        const row = record(item);
        if (row.buyNowPrice !== 0) return item;
        const { buyNowPrice: _zero, ...rest } = row;
        return rest;
      }),
    };
  }
  const totalAvailable = openSearchTotal(html);
  if (cards.length === 0) {
    const explicitEmpty = totalAvailable === 0
      && /class=["'][^"']*Empty__title[^"']*["'][^>]*>[\s\S]*?(?:見つかりません|一致する商品)/iu.test(html);
    if (!explicitEmpty) badResponse("Yahoo!オークション在售页缺少商品卡片与明确空结果标记");
    return { items: [], totalAvailable: 0 };
  }
  if (totalAvailable === 0) badResponse("Yahoo!オークション在售页商品数与卡片结构矛盾");
  return {
    items: cards.map(parseOpenCard),
    ...(totalAvailable === undefined ? {} : { totalAvailable }),
  };
}

function nextData(html: string, page: string): Record<string, unknown> {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    if (!/\bid=["']__NEXT_DATA__["']/iu.test(match[1] ?? "")) continue;
    try {
      const parsed = record(JSON.parse(match[2] ?? "null") as unknown);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      badResponse(`Yahoo!オークション${page} __NEXT_DATA__ 无法解析`);
    }
  }
  return badResponse(`Yahoo!オークション${page}缺少 __NEXT_DATA__`);
}

function nestedRecord(root: unknown, path: readonly string[]): Record<string, unknown> {
  let current = root;
  for (const key of path) current = record(current)[key];
  return record(current);
}

function nextDataListing(html: string, page: string): YahooAuctionsParsedSearch {
  const root = nextData(html, page);
  const paths = [
    ["props", "initialState", "search", "items", "listing"],
    ["props", "pageProps", "initialState", "search", "items", "listing"],
  ] as const;
  for (const path of paths) {
    const listing = nestedRecord(root, path);
    if (!Array.isArray(listing.items)) continue;
    // The Next.js open page no longer prints 「キーワードの一部を利用した結果」.
    // A non-empty wandQuery (weak AND over the keywords) is the same signal and
    // is present on both pages.
    const wandQuery = record(listing.metadata).wandQuery;
    if (typeof wandQuery === "string" && wandQuery.trim()) {
      return { items: [], totalAvailable: 0, partialKeywordFallback: true };
    }
    const totalAvailable = nonNegativeInteger(listing.totalResultsAvailable);
    return {
      items: listing.items,
      ...(totalAvailable === undefined ? {} : { totalAvailable }),
    };
  }
  return badResponse(`Yahoo!オークション${page}缺少 listing.items`);
}

export function parseYahooAuctionsClosedSearchHtml(html: string): YahooAuctionsParsedSearch {
  if (PARTIAL_KEYWORD_FALLBACK_PATTERN.test(html)) return { items: [], totalAvailable: 0, partialKeywordFallback: true };
  return nextDataListing(html, "已结束页");
}

function schemaType(value: unknown, expected: string): boolean {
  return typeof value === "string"
    ? value === expected || value.endsWith(`/${expected}`)
    : Array.isArray(value) && value.some((entry) => schemaType(entry, expected));
}

export function parseYahooAuctionsDetailHtml(html: string, requestedId: string): Record<string, unknown> {
  const objects = jsonLdObjects(html);
  const product = objects.find((candidate) => schemaType(candidate["@type"], "Product"));
  if (!product) return badResponse("Yahoo!オークション详情页缺少 Product JSON-LD");
  const offerValue = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const offer = record(offerValue);
  const breadcrumb = objects.find((candidate) => schemaType(candidate["@type"], "BreadcrumbList"));
  const categories = Array.isArray(breadcrumb?.itemListElement)
    ? breadcrumb.itemListElement.flatMap((value) => {
        const name = boundedText(record(record(value).item).name, 200);
        return name ? [{ name }] : [];
      })
    : [];
  const imageValues = Array.isArray(product.image) ? product.image : [product.image];
  const images = imageValues.flatMap((value) => {
    const direct = boundedText(value);
    const row = record(value);
    const url = direct ?? boundedText(row.url ?? row.contentUrl);
    return url ? [{ url }] : [];
  });
  const price = nonNegativeInteger(offer.price);
  const description = boundedText(product.description, 4_000);
  return {
    auctionId: requestedId,
    ...(boundedText(product.name, 1_000) ? { title: boundedText(product.name, 1_000) } : {}),
    ...(price === undefined ? {} : { price }),
    ...(description ? { description: [description] } : {}),
    ...(images.length ? { img: images } : {}),
    ...(categories.length ? { category: { path: categories } } : {}),
    ...(boundedText(offer.itemCondition, 200) ? { conditionName: boundedText(offer.itemCondition, 200) } : {}),
    ...(boundedText(offer.availability, 200) ? { status: boundedText(offer.availability, 200) } : {}),
    ...(boundedText(offer.priceValidUntil, 80) ? { endTime: boundedText(offer.priceValidUntil, 80) } : {}),
  };
}
