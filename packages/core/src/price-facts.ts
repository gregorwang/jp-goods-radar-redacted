import type { ItemCondition, SourceId } from "./types.js";

export const PRICE_FACT_SEMANTICS_VERSION = "price-facts-v1" as const;

export const PRICE_FACT_ROLES = [
  "acquisition_ask",
  "new_retail_ask",
  "auction_current_bid",
  "unclassified_ask",
  "source_sold_status_price",
  "official_list",
  "source_compare_at",
  "verified_sale",
] as const;

export type PriceFactRole = (typeof PRICE_FACT_ROLES)[number];

const NEW_RETAIL_ONLY_SOURCES = new Set<SourceId>([
  "rakuten_ichiba",
  "rakuten_books",
  "yahoo_shopping",
  "charaon",
  "cospa",
  "animate",
]);

/**
 * Assigns a market role without changing the source price itself. Amazon is
 * condition-sensitive; fixed-purpose retail sources are treated as new-retail
 * references unless an adapter explicitly reports a used condition.
 */
export function listingPriceFactRole(input: {
  sourceId: SourceId;
  condition: ItemCondition;
  priceBasis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid";
}): Extract<PriceFactRole, "acquisition_ask" | "new_retail_ask" | "auction_current_bid"> {
  if (input.priceBasis === "auction_current_bid") return "auction_current_bid";
  if (
    input.condition === "new"
    || (NEW_RETAIL_ONLY_SOURCES.has(input.sourceId) && input.condition !== "used")
  ) {
    return "new_retail_ask";
  }
  return "acquisition_ask";
}
