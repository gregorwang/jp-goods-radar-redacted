/**
 * 每次挂牌都对应唯一实物的 C2C / 拍卖来源：售出即终局，不可能再补货，
 * 因此这类商品处于终局状态时建单品监控没有意义。
 * 商家目录型来源（骏河屋中古、乐天店铺 SKU、Animate 通贩等）会对同一商品重新上架，
 * "售罄 → 补货"正是本项目承诺的核心场景之一，必须允许建监控。
 */
const ONE_OFF_LISTING_SOURCES = new Set(["mercari_jp", "yahoo_auctions_jp", "yahoo_fleamarket_jp", "ebay"]);

export function listingLifecycleKind(input: {
  sourceId: string;
  identityScope: string;
}): import("./types.js").ListingLifecycleKind {
  if (input.sourceId === "yahoo_auctions_jp") return "auction";
  if (input.identityScope === "catalog" || !isOneOffListingSource(input.sourceId)) return "replenishable";
  return "one_off";
}

export function trackedListingIntervalMinutes(sourceId: string): number {
  return isOneOffListingSource(sourceId) ? 60 : 180;
}

export function isOneOffListingSource(sourceId: string): boolean {
  return ONE_OFF_LISTING_SOURCES.has(sourceId);
}

/**
 * A sold or in-transaction one-off listing/offer cannot produce a future price
 * drop. Catalog records remain monitorable because they can be replenished.
 * Keep this rule shared by UI and mutation endpoints so a hidden button is not
 * the only protection against creating a meaningless item-price watch.
 */
export function isTerminalItemWatchAvailability(value: string): value is "sold_out" | "trading" {
  return value === "sold_out" || value === "trading";
}

export function canCreateItemPriceWatch(availability: string, identityScope: string, sourceId: string): boolean {
  if (identityScope === "catalog") return true;
  if (!isTerminalItemWatchAvailability(availability)) return true;
  return !isOneOffListingSource(sourceId);
}

/**
 * 终局状态的商家商品只有补货语义可言：此时没有可比的在售价格，
 * 降价与售罄通知都不成立，默认只开补货。
 */
export function restockOnlyItemWatch(availability: string, sourceId: string): boolean {
  return isTerminalItemWatchAvailability(availability) && !isOneOffListingSource(sourceId);
}
