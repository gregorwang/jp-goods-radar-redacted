import type {
  ItemCondition,
  NormalizedListing,
  ProductDisplayFact,
  ProductFacts,
  VerifiedSaleEvidence,
} from "../../../core/src/index.js";
import { list, record, text } from "../http.js";

export type YahooAuctionsScope = "open" | "closed";

const AUCTION_ID_PATTERN = /^[A-Za-z0-9]{8,16}$/;

function boundedText(value: unknown, maximum = 500): string | undefined {
  const parsed = text(value);
  return parsed ? parsed.slice(0, maximum) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeImageUrl(value: unknown): string | undefined {
  const raw = boundedText(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const yahooImageHost = url.hostname === "yimg.jp" || url.hostname.endsWith(".yimg.jp")
      || url.hostname === "yahoo.co.jp" || url.hostname.endsWith(".yahoo.co.jp");
    return url.protocol === "https:" && yahooImageHost && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function conditionFromCode(value: unknown): ItemCondition {
  const raw = boundedText(value, 32);
  if (raw === "NEW") return "new";
  if (raw?.startsWith("USED")) return "used";
  return "unknown";
}

function conditionFromName(value: unknown): ItemCondition {
  const raw = boundedText(value, 200)?.normalize("NFKC");
  if (!raw) return "unknown";
  if (/NewCondition$/iu.test(raw)) return "new";
  if (/UsedCondition$/iu.test(raw)) return "used";
  if (/^(?:新品|未使用|新品[、・/]未使用)$/u.test(raw)) return "new";
  if (/中古|使用|傷|汚れ|状態/u.test(raw)) return "used";
  return "unknown";
}

function pathEntries(value: unknown): Array<{ id?: number; name?: string }> {
  return list(value).slice(0, 20).flatMap((entry) => {
    const row = record(entry);
    const id = nonNegativeInteger(row.id);
    const name = boundedText(row.name, 200);
    return id === undefined && !name ? [] : [{ ...(id === undefined ? {} : { id }), ...(name ? { name } : {}) }];
  });
}

function textFact(
  key: string,
  label: string,
  group: ProductDisplayFact["group"],
  value: string | number | undefined,
): ProductDisplayFact[] {
  if (value === undefined || value === "") return [];
  return [{ key, label, group, kind: "text", value: String(value).slice(0, 500) }];
}

function listFact(
  key: string,
  label: string,
  group: ProductDisplayFact["group"],
  values: readonly (string | undefined)[],
): ProductDisplayFact[] {
  const clean = [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.slice(0, 300)))].slice(0, 20);
  return clean.length ? [{ key, label, group, kind: "list", values: clean }] : [];
}

function categoryNames(row: Record<string, unknown>): string[] {
  const category = record(row.category);
  const path = pathEntries(row.categoryPath).map((entry) => entry.name).filter((value): value is string => Boolean(value));
  const name = boundedText(category.name, 200);
  return [...new Set([...path, ...(name ? [name] : [])])];
}

function closedAuctionSaleEvidence(input: {
  auctionId: string;
  currentPrice: number;
  bidCount?: number;
  endTime?: string;
}): VerifiedSaleEvidence | undefined {
  if (input.currentPrice <= 0 || input.bidCount === undefined || input.bidCount < 1 || !input.endTime) return undefined;
  const soldAt = Date.parse(input.endTime);
  if (!Number.isFinite(soldAt)) return undefined;
  return {
    evidenceVersion: "verified-sale-v1",
    kind: "closed_auction_with_bid",
    sourceSaleId: input.auctionId,
    soldPriceJpy: input.currentPrice,
    soldAt: new Date(soldAt).toISOString(),
    bidCount: input.bidCount,
    sourceStatus: "CLOSED",
  };
}

function searchFacts(
  row: Record<string, unknown>,
  auctionId: string,
  conditionRaw: string | undefined,
  imageUrl: string | undefined,
): ProductFacts {
  const category = record(row.category);
  const seller = record(row.seller);
  const categories = categoryNames(row);
  const buyNowPrice = nonNegativeInteger(row.buyNowPrice);
  const bidCount = nonNegativeInteger(row.bidCount);
  const watchCount = nonNegativeInteger(row.watchCount);
  const startTime = boundedText(row.startTime, 80);
  const endTime = boundedText(row.endTime, 80);
  const sellerRating = boundedText(seller.goodRating, 100);
  const sellerType = boundedText(seller.type, 100);
  const sellerIsStore = booleanValue(seller.isStore);
  const flags = [
    booleanValue(row.isFreeShipping) ? "包邮" : undefined,
    booleanValue(row.isFixedPrice) ? "固定价格" : undefined,
    booleanValue(row.isFleamarketItem) ? "跳蚤市场商品" : undefined,
    booleanValue(row.isShoppingItem) ? "Yahoo! Shopping 商品" : undefined,
    booleanValue(row.isAppraisal) ? "支持鉴定" : undefined,
    booleanValue(row.isNewArrival) ? "新上架" : undefined,
    booleanValue(row.isFeatured) ? "注目商品" : undefined,
  ];
  const displayFacts: ProductDisplayFact[] = [
    ...textFact("auction_id", "拍卖 ID", "identity", auctionId),
    ...textFact("condition_code", "来源品相代码", "catalog", conditionRaw),
    ...textFact("category_id", "分类 ID", "catalog", nonNegativeInteger(category.id)),
    ...listFact("category_path", "商品分类", "catalog", categories),
    ...textFact("buy_now_price", "即决价", "commerce", buyNowPrice === undefined ? undefined : `¥${buyNowPrice.toLocaleString("ja-JP")}`),
    ...textFact("bid_count", "出价数", "commerce", bidCount),
    ...textFact("watch_count", "关注数", "commerce", watchCount),
    ...textFact("auction_start", "开始时间", "commerce", startTime),
    ...textFact("auction_end", "结束时间", "commerce", endTime),
    ...textFact("seller_rating", "卖家好评", "seller", sellerRating),
    ...textFact("seller_type", "卖家类型", "seller", sellerType),
    ...textFact("seller_store", "卖家属性", "seller", sellerIsStore === undefined ? undefined : sellerIsStore ? "店铺" : "个人卖家"),
    ...listFact("auction_flags", "拍卖标记", "other", flags),
  ];
  return {
    identifiers: { sourceCatalogId: auctionId },
    ...(categories.length ? { categoryPath: categories } : {}),
    ...(imageUrl ? { imageUrls: [imageUrl] } : {}),
    ...(displayFacts.length ? { displayFacts } : {}),
    provenance: {
      identifiers: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 },
      ...(categories.length ? { categoryPath: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(imageUrl ? { imageUrls: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(displayFacts.length ? { displayFacts: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
    },
  };
}

export function normalizeYahooAuctionsSearchItem(
  value: unknown,
  scope: YahooAuctionsScope,
): NormalizedListing | undefined {
  const row = record(value);
  const auctionId = boundedText(row.auctionId, 16);
  const title = boundedText(row.title, 1_000);
  const currentPrice = nonNegativeInteger(row.price);
  if (!auctionId || !AUCTION_ID_PATTERN.test(auctionId) || !title || currentPrice === undefined) return undefined;

  const seller = record(row.seller);
  const sellerName = boundedText(seller.displayName, 200);
  const conditionRaw = boundedText(row.itemCondition, 32);
  const imageUrl = safeImageUrl(row.imageUrl);
  const buyNowPrice = nonNegativeInteger(row.buyNowPrice);
  const bidCount = nonNegativeInteger(row.bidCount);
  const watchCount = nonNegativeInteger(row.watchCount);
  const startTime = boundedText(row.startTime, 80);
  const endTime = boundedText(row.endTime, 80);
  const verifiedSaleEvidence = scope === "closed"
    ? closedAuctionSaleEvidence({ auctionId, currentPrice, bidCount, endTime })
    : undefined;
  return {
    sourceId: "yahoo_auctions_jp",
    sourceItemId: auctionId,
    identityScope: "listing",
    canonicalUrl: `https://auctions.yahoo.co.jp/jp/auction/${auctionId}`,
    title,
    ...(imageUrl ? { imageUrl } : {}),
    ...(sellerName ? { sellerName } : {}),
    currency: "JPY",
    currentPrice,
    // 在售拍卖的价格是当前出价，会随竞价上涨；已结束的拍卖才是成交价。
    priceBasis: scope === "closed" ? "listing_price" : "auction_current_bid",
    condition: conditionFromCode(conditionRaw),
    availability: scope === "closed" ? "sold_out" : "available",
    ...(startTime ? { sourceListedAt: startTime } : {}),
    facts: searchFacts(row, auctionId, conditionRaw, imageUrl),
    rawMetadata: {
      sourceStatus: scope === "closed" ? "CLOSED" : "OPEN",
      priceType: "current_or_final",
      ...(conditionRaw ? { conditionRaw } : {}),
      ...(buyNowPrice === undefined ? {} : { buyNowPrice }),
      ...(bidCount === undefined ? {} : { bidCount }),
      ...(watchCount === undefined ? {} : { watchCount }),
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(verifiedSaleEvidence ? { verifiedSaleEvidence } : {}),
    },
  };
}

function detailAvailability(row: Record<string, unknown>): NormalizedListing["availability"] {
  const status = boundedText(row.status, 100)?.toLowerCase();
  if (status && /closed|ended|finish|sold|outofstock|終了|落札/u.test(status)) return "sold_out";
  if (status && /open|selling|auction|instock|available|出品|開催/u.test(status)) return "available";
  const leftTime = nonNegativeInteger(row.leftTime);
  if (leftTime !== undefined) return leftTime > 0 ? "available" : "sold_out";
  const endTime = boundedText(row.endTime, 80);
  return endTime && Number.isFinite(Date.parse(endTime)) && Date.parse(endTime) <= Date.now() ? "sold_out" : "unknown";
}

function detailImages(row: Record<string, unknown>): string[] {
  return [...new Set(list(row.img).slice(0, 20).flatMap((value) => {
    const image = record(value);
    const url = safeImageUrl(image.image) ?? safeImageUrl(image.url) ?? safeImageUrl(image.thumbnail);
    return url ? [url] : [];
  }))];
}

function detailDescription(value: unknown): string | undefined {
  const parts = list(value).flatMap((part) => {
    if (typeof part !== "string") return [];
    const candidate = part.trim();
    return candidate ? [candidate.slice(0, 2_000)] : [];
  });
  const combined = parts.join("\n").trim();
  return combined ? combined.slice(0, 4_000) : undefined;
}

export function normalizeYahooAuctionsDetail(value: unknown, requestedId: string): NormalizedListing | undefined {
  const row = record(value);
  const auctionId = boundedText(row.auctionId, 16) ?? requestedId;
  const title = boundedText(row.title, 1_000);
  const currentPrice = nonNegativeInteger(row.price) ?? nonNegativeInteger(row.initPrice);
  if (!AUCTION_ID_PATTERN.test(auctionId) || !title || currentPrice === undefined) return undefined;

  const images = detailImages(row);
  const categoryPath = pathEntries(record(row.category).path).map((entry) => entry.name).filter((entry): entry is string => Boolean(entry));
  const brandPath = pathEntries(record(row.brand).path).map((entry) => entry.name).filter((entry): entry is string => Boolean(entry));
  const brand = brandPath.at(-1);
  const seller = record(row.seller);
  const sellerName = boundedText(seller.displayName, 200);
  const conditionName = boundedText(row.conditionName, 200);
  const status = boundedText(row.status, 100);
  const startTime = boundedText(row.startTime, 80);
  const endTime = boundedText(row.endTime, 80);
  const descriptionExcerpt = detailDescription(row.description);
  const initialPrice = nonNegativeInteger(row.initPrice);
  const buyNowPrice = nonNegativeInteger(row.buyNowPrice);
  const quantity = nonNegativeInteger(row.quantity);
  const bidCount = nonNegativeInteger(row.bids);
  const bidderCount = nonNegativeInteger(row.biddersNum);
  const watchCount = nonNegativeInteger(row.watchListNum);
  const leftTime = nonNegativeInteger(row.leftTime);
  const explicitClosedStatus = status !== undefined && /closed|ended|finish|sold|終了|落札/iu.test(status);
  const verifiedSaleEvidence = explicitClosedStatus
    ? closedAuctionSaleEvidence({ auctionId, currentPrice, bidCount, endTime })
    : undefined;
  const displayFacts: ProductDisplayFact[] = [
    ...textFact("auction_id", "拍卖 ID", "identity", auctionId),
    ...textFact("condition_name", "来源品相", "catalog", conditionName),
    ...listFact("category_path", "商品分类", "catalog", categoryPath),
    ...listFact("brand_path", "品牌路径", "catalog", brandPath),
    ...textFact("initial_price", "起拍价", "commerce", initialPrice === undefined ? undefined : `¥${initialPrice.toLocaleString("ja-JP")}`),
    ...textFact("buy_now_price", "即决价", "commerce", buyNowPrice === undefined ? undefined : `¥${buyNowPrice.toLocaleString("ja-JP")}`),
    ...textFact("quantity", "数量", "commerce", quantity),
    ...textFact("bid_count", "出价数", "commerce", bidCount),
    ...textFact("bidder_count", "竞拍人数", "commerce", bidderCount),
    ...textFact("watch_count", "关注数", "commerce", watchCount),
    ...textFact("auction_status", "拍卖状态", "commerce", status),
    ...textFact("auction_start", "开始时间", "commerce", startTime),
    ...textFact("auction_end", "结束时间", "commerce", endTime),
    ...textFact("left_time", "剩余秒数", "commerce", leftTime),
    ...textFact("shipping_paid_by", "运费承担", "shipping", boundedText(row.chargeForShipping, 200)),
    ...textFact("shipping_method", "配送方式", "shipping", boundedText(row.shipping, 300)),
    ...textFact("seller_rating", "卖家评价", "seller", boundedText(seller.rating ?? seller.goodRating, 100)),
    ...textFact("seller_location", "发货地区", "seller", boundedText(seller.location, 200)),
    ...textFact("seller_store", "卖家属性", "seller", booleanValue(seller.isStore) === undefined ? undefined : booleanValue(seller.isStore) ? "店铺" : "个人卖家"),
    ...listFact("auction_flags", "拍卖标记", "other", [
      booleanValue(row.isAutomaticExtension) ? "自动延长" : undefined,
      booleanValue(row.isEarlyClosing) ? "允许提前结束" : undefined,
      booleanValue(row.isPrivacyDeliveryAvailable) ? "匿名配送" : undefined,
      booleanValue(seller.isBestStore) ? "优良店铺" : undefined,
      booleanValue(seller.isEkycVerified) ? "身份已验证" : undefined,
      row.appraisal ? "支持鉴定" : undefined,
    ]),
  ];
  const facts: ProductFacts = {
    identifiers: { sourceCatalogId: auctionId },
    ...(brand ? { brand, tags: brandPath } : {}),
    ...(categoryPath.length ? { categoryPath } : {}),
    ...(images.length ? { imageUrls: images } : {}),
    ...(conditionName ? { sourceConditionLabel: conditionName } : {}),
    ...(displayFacts.length ? { displayFacts } : {}),
    provenance: {
      identifiers: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 },
      ...(brand ? { brand: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(categoryPath.length ? { categoryPath: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(images.length ? { imageUrls: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(conditionName ? { sourceConditionLabel: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
      ...(displayFacts.length ? { displayFacts: { method: "html", sourceLabel: "Yahoo!オークション公开网页", confidence: 1 } } : {}),
    },
  };
  return {
    sourceId: "yahoo_auctions_jp",
    sourceItemId: auctionId,
    identityScope: "listing",
    canonicalUrl: `https://auctions.yahoo.co.jp/jp/auction/${auctionId}`,
    title,
    ...(descriptionExcerpt ? { descriptionExcerpt } : {}),
    ...(images[0] ? { imageUrl: images[0] } : {}),
    ...(sellerName ? { sellerName } : {}),
    currency: "JPY",
    currentPrice,
    // 详情页同理：仍在进行中的拍卖给出的是当前出价而非可成交价。
    priceBasis: detailAvailability(row) === "sold_out" ? "listing_price" : "auction_current_bid",
    condition: conditionFromName(conditionName),
    availability: detailAvailability(row),
    ...(startTime ? { sourceListedAt: startTime } : {}),
    facts,
    rawMetadata: {
      priceType: "current_or_final",
      ...(status ? { sourceStatus: status } : {}),
      ...(initialPrice === undefined ? {} : { initialPrice }),
      ...(buyNowPrice === undefined ? {} : { buyNowPrice }),
      ...(bidCount === undefined ? {} : { bidCount }),
      ...(bidderCount === undefined ? {} : { bidderCount }),
      ...(watchCount === undefined ? {} : { watchCount }),
      ...(leftTime === undefined ? {} : { leftTimeSeconds: leftTime }),
      ...(endTime ? { endTime } : {}),
      ...(verifiedSaleEvidence ? { verifiedSaleEvidence } : {}),
    },
  };
}

export function isYahooAuctionId(value: string): boolean {
  return AUCTION_ID_PATTERN.test(value);
}
