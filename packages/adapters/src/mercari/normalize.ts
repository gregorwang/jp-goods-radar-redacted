import { formatJpy, type NormalizedListing, type ProductDisplayFact } from "../../../core/src/index.js";
import { list, record, text } from "../http.js";
import { MercariSchemaChangedError } from "./errors.js";

export type MercariSaleMode = "fixed_price" | "auction" | "flash_auction";
export type MercariAuctionState = "scheduled" | "no_bid" | "ongoing" | "winner_period" | "ended" | "unknown";

function nonNegativeSafeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function unixSeconds(value: unknown): string | undefined {
  const seconds = nonNegativeSafeInteger(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const timestamp = new Date(seconds * 1_000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function availability(value: unknown): NormalizedListing["availability"] {
  const status = text(value)?.toLowerCase();
  if (status === "item_status_on_sale" || status === "on_sale") return "available";
  if (status === "item_status_sold_out" || status === "item_status_trading" || status === "sold_out" || status === "trading") return "sold_out";
  return "unknown";
}

function condition(value: unknown): NormalizedListing["condition"] {
  const id = text(value) ?? text(record(value).id);
  if (id === "1") return "new";
  return id ? "used" : "unknown";
}

const conditionLabels: Record<string, string> = {
  "1": "新品、未使用",
  "2": "未使用に近い",
  "3": "目立った傷や汚れなし",
  "4": "やや傷や汚れあり",
  "5": "傷や汚れあり",
  "6": "全体的に状態が悪い",
};

function sourceCondition(value: unknown): { id?: string; label?: string } {
  const nested = record(value);
  const id = text(value) ?? text(nested.id);
  return {
    id,
    label: text(nested.name) ?? (id ? conditionLabels[id] : undefined),
  };
}

function firstImage(item: Record<string, unknown>): string | undefined {
  const candidates = [...list(item.photos), ...list(item.thumbnails)];
  for (const value of candidates) {
    const candidate = text(value) ?? text(record(value).uri);
    if (candidate?.startsWith("https://")) return candidate;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function auctionData(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return objectValue(item.auction_info) ?? objectValue(item.auction);
}

export function mercariCanonicalUrl(sourceItemId: string, itemType: string | undefined): string {
  const path = itemType === "ITEM_TYPE_BEYOND" ? "shops/product" : "item";
  return `https://jp.mercari.com/${path}/${encodeURIComponent(sourceItemId)}`;
}

function saleMode(auction: Record<string, unknown> | undefined, typeRaw: string | undefined): MercariSaleMode {
  if (!auction) return "fixed_price";
  if (typeRaw === "AUCTION_TYPE_FLASH") return "flash_auction";
  return "auction";
}

function auctionState(value: string | undefined): MercariAuctionState {
  switch (value) {
    case "STATE_SCHEDULED": return "scheduled";
    case "STATE_NO_BID": return "no_bid";
    case "STATE_ONGOING": return "ongoing";
    case "STATE_WINNER_PERIOD": return "winner_period";
    case "STATE_END": return "ended";
    default: return "unknown";
  }
}

const saleModeLabels: Record<MercariSaleMode, string> = {
  fixed_price: "普通一口价出品",
  auction: "普通拍卖",
  flash_auction: "3 小时拍卖",
};

const auctionStateLabels: Record<Exclude<MercariAuctionState, "unknown">, string> = {
  scheduled: "尚未开始",
  no_bid: "暂无出价",
  ongoing: "竞拍中",
  winner_period: "中标确认期",
  ended: "已结束",
};

function auctionDisplayFacts(input: {
  saleMode: MercariSaleMode;
  startingPrice?: number;
  bidCount?: number;
  state?: MercariAuctionState;
  startAt?: string;
  endAt?: string;
}): ProductDisplayFact[] {
  const facts: ProductDisplayFact[] = [{
    key: "mercari.sale_mode",
    label: "销售形式",
    group: "commerce",
    kind: "text",
    value: saleModeLabels[input.saleMode],
  }];
  if (input.saleMode === "fixed_price") return facts;
  facts.push({
    key: "mercari.price_type",
    label: "价格性质",
    group: "commerce",
    kind: "text",
    value: "当前最高出价",
  });
  if (input.startingPrice !== undefined) {
    facts.push({
      key: "mercari.starting_price",
      label: "起拍价",
      group: "commerce",
      kind: "text",
      value: formatJpy(input.startingPrice),
    });
  }
  if (input.bidCount !== undefined) {
    facts.push({
      key: "mercari.bid_count",
      label: "出价次数",
      group: "commerce",
      kind: "text",
      value: `${input.bidCount} 次`,
    });
  }
  if (input.state && input.state !== "unknown") {
    facts.push({
      key: "mercari.auction_state",
      label: "拍卖状态",
      group: "commerce",
      kind: "text",
      value: auctionStateLabels[input.state],
    });
  }
  if (input.startAt) {
    facts.push({
      key: "mercari.auction_start_at",
      label: "拍卖开始时间",
      group: "commerce",
      kind: "text",
      value: input.startAt,
    });
  }
  if (input.endAt) {
    facts.push({
      key: "mercari.auction_end_at",
      label: "拍卖结束时间",
      group: "commerce",
      kind: "text",
      value: input.endAt,
    });
  }
  return facts;
}

/**
 * 详情页的热度和卖家统计。这几个数一直在变（卖家每卖一件评价数就涨），key 都登记在
 * packages/db 的 VOLATILE_DISPLAY_FACT_KEYS 里，不参与内容指纹，免得每次巡回都改写一遍商品。
 */
function interestAndSellerFacts(input: {
  likeCount?: number;
  commentCount?: number;
  seller: Record<string, unknown>;
}): ProductDisplayFact[] {
  const facts: ProductDisplayFact[] = [];
  const add = (key: string, label: string, group: ProductDisplayFact["group"], value: string | undefined) => {
    if (value) facts.push({ key, label, group, kind: "text", value });
  };
  add("mercari.like_count", "いいね", "commerce", input.likeCount === undefined ? undefined : `${input.likeCount} 人`);
  add("mercari.comment_count", "评论", "commerce", input.commentCount === undefined ? undefined : `${input.commentCount} 条`);
  const ratings = record(input.seller.ratings);
  const good = nonNegativeSafeInteger(ratings.good);
  const normal = nonNegativeSafeInteger(ratings.normal);
  const bad = nonNegativeSafeInteger(ratings.bad);
  if (good !== undefined || bad !== undefined) {
    add("mercari.seller_ratings", "卖家评价", "seller",
      [`好评 ${good ?? 0}`, normal ? `普通 ${normal}` : undefined, `差评 ${bad ?? 0}`].filter(Boolean).join(" · "));
  }
  const sellItems = nonNegativeSafeInteger(input.seller.num_sell_items);
  add("mercari.seller_items", "卖家出品", "seller", sellItems === undefined ? undefined : `${sellItems} 件`);
  const since = unixSeconds(input.seller.created);
  add("mercari.seller_since", "卖家注册", "seller", since ? `${since.slice(0, 4)} 年` : undefined);
  if (input.seller.quick_shipper === true) add("mercari.seller_quick", "卖家发货", "seller", "发货快");
  return facts;
}

export function normalizeMercariListing(value: unknown): NormalizedListing {
  const item = record(value);
  const sourceItemId = text(item.id);
  const title = text(item.name) ?? text(item.title);
  if (!sourceItemId || !title) throw new MercariSchemaChangedError("Mercari 商品缺少稳定 ID 或标题");

  const seller = record(item.seller);
  const auction = auctionData(item);
  const auctionTypeRaw = auction ? text(auction.auction_type) ?? text(auction.auctionType) : undefined;
  const auctionStateRaw = auction ? text(auction.state) : undefined;
  const normalizedSaleMode = saleMode(auction, auctionTypeRaw);
  const normalizedAuctionState = auction ? auctionState(auctionStateRaw) : undefined;
  const highestBid = auction
    ? nonNegativeSafeInteger(auction.highestBid) ?? nonNegativeSafeInteger(auction.highest_bid)
    : undefined;
  const startingPrice = auction
    ? nonNegativeSafeInteger(auction.initialPrice) ?? nonNegativeSafeInteger(auction.initial_price)
    : undefined;
  // STATE_NO_BID 的最高出价是 0，而 `0 ?? x` 仍然是 0：必须把 0 当作缺失，
  // 否则下游会因价格无效而丢弃这条商品。
  const price = (highestBid !== undefined && highestBid > 0 ? highestBid : undefined)
    ?? startingPrice
    ?? nonNegativeSafeInteger(item.price);
  const bidCount = auction
    ? nonNegativeSafeInteger(auction.totalBid) ?? nonNegativeSafeInteger(auction.total_bids)
    : undefined;
  const auctionStartAt = auction
    ? unixSeconds(auction.start_time) ?? isoTime(auction.startTime)
    : undefined;
  const auctionEndAt = auction
    ? isoTime(auction.bidDeadline) ?? unixSeconds(auction.expected_end_time)
    : undefined;
  const itemCondition = item.itemConditionId ?? item.item_condition;
  const rawCondition = sourceCondition(itemCondition);
  const sourceStatus = text(item.status);
  const itemType = text(item.itemType);
  const displayFacts = auctionDisplayFacts({
    saleMode: normalizedSaleMode,
    startingPrice,
    bidCount,
    state: normalizedAuctionState,
    startAt: auctionStartAt,
    endAt: auctionEndAt,
  });
  // 点赞、评论、卖家统计只在 /items/get 详情里有（搜索结果只带 isLiked），搜索来的商品这些都是 undefined。
  const likeCount = nonNegativeSafeInteger(item.num_likes);
  const commentCount = nonNegativeSafeInteger(item.num_comments);
  displayFacts.push(...interestAndSellerFacts({ likeCount, commentCount, seller }));

  return {
    sourceId: "mercari_jp",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl: mercariCanonicalUrl(sourceItemId, itemType),
    title,
    descriptionExcerpt: text(item.description)?.slice(0, 1_500),
    imageUrl: firstImage(item),
    sellerName: text(seller.name),
    currency: "JPY",
    currentPrice: price,
    priceBasis: "listing_price",
    condition: condition(itemCondition),
    availability: availability(item.status),
    sourceListedAt: unixSeconds(item.created),
    sourceUpdatedAt: unixSeconds(item.updated),
    facts: {
      displayFacts,
      ...(rawCondition.label ? { sourceConditionLabel: rawCondition.label } : {}),
      ...(sourceStatus ? { sourceAvailabilityLabel: sourceStatus } : {}),
      provenance: {
        displayFacts: { method: "internal_api", sourceLabel: "Mercari JP experimental web API" },
        ...(rawCondition.label ? { sourceConditionLabel: { method: "internal_api", sourceLabel: "Mercari JP experimental web API" } } : {}),
        ...(sourceStatus ? { sourceAvailabilityLabel: { method: "internal_api", sourceLabel: "Mercari JP experimental web API" } } : {}),
      },
    },
    rawMetadata: {
      createdAt: unixSeconds(item.created),
      itemType,
      sourceConditionId: rawCondition.id,
      sourceConditionLabel: rawCondition.label,
      sourceStatus,
      saleMode: normalizedSaleMode,
      priceType: auction ? "current_bid" : "fixed",
      ...(likeCount !== undefined ? { likeCount } : {}),
      ...(commentCount !== undefined ? { commentCount } : {}),
      ...(startingPrice !== undefined ? { startingPrice } : {}),
      ...(bidCount !== undefined ? { bidCount } : {}),
      ...(normalizedAuctionState ? { auctionState: normalizedAuctionState } : {}),
      ...(auctionTypeRaw ? { auctionTypeRaw } : {}),
      ...(auctionStateRaw ? { auctionStateRaw } : {}),
      ...(auctionStartAt ? { auctionStartAt } : {}),
      ...(auctionEndAt ? { auctionEndAt, endTime: auctionEndAt } : {}),
      parserVersion: "mercari-internal-v2",
    },
  };
}
