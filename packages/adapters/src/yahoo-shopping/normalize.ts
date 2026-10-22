import type { NormalizedListing, ProductDisplayFact } from "../../../core/src/index.js";
import { integer, record, text, uniqueListings } from "../http.js";
import { stripHtml } from "../html.js";
import { YahooExperimentalError } from "./errors.js";

const PRODUCT_HOSTS = new Set(["store.shopping.yahoo.co.jp", "shopping.yahoo.co.jp"]);

function safeHttpsUrl(value: unknown, allowed: (hostname: string) => boolean): string | undefined {
  const source = text(value);
  if (!source || source.length > 2_048) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function limitedText(value: unknown, maximum: number): string | undefined {
  const parsed = text(value);
  return parsed && parsed.length <= maximum ? parsed : undefined;
}

function descriptionText(item: Record<string, unknown>): string | undefined {
  const value = text(item.description) ?? text(item.caption) ?? text(item.headline);
  if (!value) return undefined;
  const normalized = stripHtml(value).replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 2_500) : undefined;
}

function productUrl(value: unknown): string | undefined {
  return safeHttpsUrl(value, (hostname) => PRODUCT_HOSTS.has(hostname));
}

function imageUrl(value: unknown): string | undefined {
  return safeHttpsUrl(value, (hostname) => hostname === "yimg.jp" || hostname.endsWith(".yimg.jp"));
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function stringId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deliveryTexts(value: unknown): string[] {
  const items = record(value).texts;
  if (!Array.isArray(items)) return [];
  return items.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()) && entry.trim().length <= 500)
    .map((entry) => entry.trim()).slice(0, 12);
}

interface NormalizedRating {
  average?: number;
  count?: number;
  url?: string;
}

function normalizedReview(value: unknown): NormalizedRating | undefined {
  const review = record(value);
  const average = finiteNumber(review.average);
  const count = nonNegativeInteger(review.count);
  const url = productUrl(review.url);
  if (average === undefined && count === undefined && !url) return undefined;
  return {
    ...(average !== undefined ? { average } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizedStoreReview(store: Record<string, unknown>): NormalizedRating | undefined {
  const review = record(store.storeReview);
  const average = finiteNumber(review.average);
  const count = nonNegativeInteger(review.count);
  if (average === undefined && count === undefined) return undefined;
  return {
    ...(average !== undefined ? { average } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

function ratingText(rating: NormalizedRating): string | undefined {
  const parts: string[] = [];
  if (rating.average !== undefined) parts.push(`平均 ${rating.average}`);
  if (rating.count !== undefined) parts.push(`${rating.count} 件评价`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function normalizeYahooListing(item: Record<string, unknown>): NormalizedListing | undefined {
  const sourceItemId = limitedText(item.itemId, 300);
  const title = limitedText(item.name, 1_000);
  const canonicalUrl = productUrl(item.url);
  const basePrice = nonNegativeInteger(item.price);
  const payablePrice = nonNegativeInteger(item.actualPrice) ?? basePrice;
  if (!sourceItemId || !title || !canonicalUrl || payablePrice === undefined) return undefined;

  const image = record(item.image);
  const store = record(item.store);
  const brand = record(item.brand);
  const primaryImage = imageUrl(image.imageUrl) ?? imageUrl(image.url);
  const sellerUrl = productUrl(store.url);
  const brandUrl = productUrl(brand.url);
  const skuId = limitedText(item.skuId, 160);
  const brandName = limitedText(brand.name, 200);
  const brandId = stringId(item.brandId);
  const categoryId = stringId(item.productCategory);
  const delivery = deliveryTexts(item.delivery);
  const review = normalizedReview(item.review);
  const sellerReview = normalizedStoreReview(store);
  // Yahoo uses 0 as a sentinel when no compare-at price is available. A
  // price reference is evidence only when it is a real positive yen amount;
  // keeping the sentinel would invalidate the entire normalized search result.
  const parsedOriginalPrice = nonNegativeInteger(item.originalPrice);
  const originalPrice = parsedOriginalPrice !== undefined && parsedOriginalPrice > 0
    ? parsedOriginalPrice
    : undefined;
  const discountRate = nonNegativeInteger(item.discountRate);
  const shippingCode = nonNegativeInteger(item.shippingCode);
  const sellerId = limitedText(item.storeId, 300);
  const sellerName = limitedText(store.name, 300);
  const descriptionExcerpt = descriptionText(item);
  const displayFacts: ProductDisplayFact[] = [];
  if (delivery.length > 0) {
    displayFacts.push({ key: "delivery", label: "配送信息", group: "shipping", kind: "list", values: delivery });
  }
  if (discountRate !== undefined) {
    displayFacts.push({ key: "discount_rate", label: "折扣率", group: "commerce", kind: "text", value: `${discountRate}%` });
  }
  const productReviewText = review ? ratingText(review) : undefined;
  if (productReviewText) {
    displayFacts.push({ key: "product_review", label: "商品评价", group: "commerce", kind: "text", value: productReviewText });
  }
  const sellerReviewText = sellerReview ? ratingText(sellerReview) : undefined;
  if (sellerReviewText) {
    displayFacts.push({ key: "seller_review", label: "店铺评价", group: "seller", kind: "text", value: sellerReviewText });
  }
  if (store.isBestStore === true || store.isBestStore === false) {
    displayFacts.push({
      key: "seller_best_store",
      label: "Yahoo 优良店铺",
      group: "seller",
      kind: "text",
      value: store.isBestStore ? "是" : "否",
    });
  }
  if (categoryId) {
    displayFacts.push({ key: "category_id", label: "Yahoo 分类 ID", group: "catalog", kind: "text", value: categoryId });
  }
  if (shippingCode !== undefined) {
    displayFacts.push({
      key: "shipping_code",
      label: "Yahoo 配送代码",
      group: "shipping",
      kind: "text",
      value: String(shippingCode),
    });
  }

  return {
    sourceId: "yahoo_shopping",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl,
    title,
    ...(descriptionExcerpt ? { descriptionExcerpt } : {}),
    ...(primaryImage ? { imageUrl: primaryImage } : {}),
    ...(sellerName ? { shopName: sellerName } : {}),
    currency: "JPY",
    currentPrice: payablePrice,
    ...(originalPrice !== undefined ? { originalPrice } : {}),
    priceBasis: "listing_price",
    condition: "unknown",
    availability: "unknown",
    facts: {
      ...(skuId ? { identifiers: { sku: skuId } } : {}),
      ...(brandName ? { brand: brandName } : {}),
      ...(displayFacts.length > 0 ? { displayFacts } : {}),
      ...(originalPrice === undefined ? {} : {
        priceReferences: [{
          kind: "source_compare_at",
          amountJpy: originalPrice,
          currency: "JPY",
          taxStatus: "unknown",
          shippingStatus: "unknown",
          sourceLabel: "Yahoo! Shopping 原价字段",
        }],
      }),
      provenance: {
        ...(skuId ? { identifiers: { method: "html", sourceLabel: "Yahoo! Shopping 公开网页", confidence: 1 } } : {}),
        ...(brandName ? { brand: { method: "html", sourceLabel: "Yahoo! Shopping 公开网页", confidence: 1 } } : {}),
        ...(displayFacts.length > 0
          ? { displayFacts: { method: "html", sourceLabel: "Yahoo! Shopping 公开网页", confidence: 1 } }
          : {}),
        ...(originalPrice === undefined
          ? {}
          : { priceReferences: { method: "html", sourceLabel: "Yahoo! Shopping 公开网页", confidence: 1 } }),
      },
    },
    rawMetadata: {
      provider: "yahoo-shopping-web",
      experimental: true,
      ...(basePrice !== undefined ? { basePrice } : {}),
      ...(payablePrice !== basePrice ? { payablePrice } : {}),
      ...(discountRate !== undefined ? { discountRate } : {}),
      ...(sellerId ? { sellerId } : {}),
      ...(sellerUrl ? { sellerUrl } : {}),
      ...(store.isBestStore === true || store.isBestStore === false ? { sellerIsBestStore: store.isBestStore } : {}),
      ...(sellerReview ? { sellerReview } : {}),
      ...(review ? { review } : {}),
      ...(brandId ? { brandId } : {}),
      ...(brandUrl ? { brandUrl } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(shippingCode !== undefined ? { shippingCode } : {}),
      ...(delivery.length > 0 ? { deliveryTexts: delivery } : {}),
      ...(skuId ? { skuId } : {}),
    },
  };
}

export function normalizeYahooListings(items: readonly Record<string, unknown>[]): {
  listings: NormalizedListing[];
  rejectedCount: number;
} {
  const normalized = items.flatMap((item): NormalizedListing[] => {
    const listing = normalizeYahooListing(item);
    return listing ? [listing] : [];
  });
  if (items.length > 0 && normalized.length === 0) {
    throw new YahooExperimentalError("Yahoo 商品核心字段结构已变化", "yahoo_schema_changed", 502);
  }
  const listings = uniqueListings(normalized);
  return { listings, rejectedCount: items.length - normalized.length };
}
