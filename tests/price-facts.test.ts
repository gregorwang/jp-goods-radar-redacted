import { describe, expect, it } from "vitest";
import {
  PRICE_FACT_SEMANTICS_VERSION,
  listingPriceFactRole,
} from "@jpgr/core";
import { productFactsSchema } from "../packages/validation/src";

describe("price fact semantics", () => {
  it("keeps acquisition asks, retail asks, and auction bids in separate roles", () => {
    expect(PRICE_FACT_SEMANTICS_VERSION).toBe("price-facts-v1");
    expect(listingPriceFactRole({
      sourceId: "mercari_jp",
      condition: "used",
      priceBasis: "listing_price",
    })).toBe("acquisition_ask");
    expect(listingPriceFactRole({
      sourceId: "yahoo_shopping",
      condition: "unknown",
      priceBasis: "listing_price",
    })).toBe("new_retail_ask");
    expect(listingPriceFactRole({
      sourceId: "amazon_jp",
      condition: "used",
      priceBasis: "catalog_price",
    })).toBe("acquisition_ask");
    expect(listingPriceFactRole({
      sourceId: "yahoo_auctions_jp",
      condition: "used",
      priceBasis: "auction_current_bid",
    })).toBe("auction_current_bid");
  });

  it("validates explicit reference semantics and rejects duplicate facts", () => {
    const reference = {
      kind: "official_list" as const,
      amountJpy: 11_000,
      currency: "JPY" as const,
      taxStatus: "unknown" as const,
      shippingStatus: "unknown" as const,
      sourceLabel: "骏河屋商品详情「定価」",
    };
    expect(productFactsSchema.safeParse({ priceReferences: [reference] }).success).toBe(true);
    expect(productFactsSchema.safeParse({ priceReferences: [reference, reference] }).success).toBe(false);
    expect(productFactsSchema.safeParse({
      priceReferences: [{ ...reference, amountJpy: 0 }],
    }).success).toBe(false);
  });
});
