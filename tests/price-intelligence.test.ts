import { describe, expect, it } from "vitest";
import { buildProductPriceIntelligence, type NormalizedListing } from "@jpgr/core";

function listing(
  id: string,
  availability: NormalizedListing["availability"],
  currentPrice: number,
  overrides: Partial<NormalizedListing> = {},
): NormalizedListing {
  return {
    sourceId: "mercari_jp",
    sourceItemId: id,
    identityScope: "listing",
    canonicalUrl: `https://jp.mercari.com/item/${id}`,
    title: "F:NEX 艾米莉亚 软萌洛丽塔玩偶",
    currency: "JPY",
    currentPrice,
    priceBasis: "listing_price",
    condition: "used",
    availability,
    ...overrides,
  };
}

describe("buildProductPriceIntelligence", () => {
  it("computes the documented two-sample median and current premium", () => {
    const referenceTime = Date.parse("2026-07-18T00:00:00.000Z");
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 1_200, { sourceListedAt: "2023-02-01T00:00:00.000Z" }),
      listing("m2", "sold_out", 1_322),
      listing("m3", "available", 3_800, { sourceListedAt: "2026-07-01T00:00:00.000Z" }),
    ], referenceTime);

    expect(result.metricVersion).toBe("product-price-intelligence-v2");
    expect(result.window).toMatchObject({ days: 730, timeZone: "Asia/Tokyo" });
    expect(result.sourceSoldStatusPriceSampleCount).toBe(2);
    expect(result.comparablePriceSampleCount).toBe(2);
    expect(result.referencePriceMedian).toBe(1_261);
    expect(result.currentLowestPrice).toBe(3_800);
    expect(result.premiumToReferenceMedianPercent).toBe(201);
    expect(result.sourceListedWithinWindowCount).toBe(1);
    expect(result.sourceDatedListingCount).toBe(2);
    expect(result.sourceUndatedListingCount).toBe(1);
    expect(result.sourceDateCoveragePercent).toBe(67);
    expect(result.verifiedSaleCount).toBe(0);
    expect(result.sampleConfidence).toBe("low");
    expect(result.recommendation).toBe("wait_for_better_price");
  });

  it("withholds current premium when every confirmed listing is sold", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 20_100),
      listing("m2", "sold_out", 22_200),
      listing("m3", "sold_out", 38_300),
    ]);

    expect(result.confirmedActiveOfferCount).toBe(0);
    expect(result.currentLowestPrice).toBeUndefined();
    expect(result.referencePriceMedian).toBe(22_200);
    expect(result.premiumToReferenceMedianPercent).toBeUndefined();
    expect(result.recommendation).toBe("no_current_offer");
  });

  it("does not treat a trading Mercari listing as a completed sold-price sample", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 20_100, { rawMetadata: { sourceStatus: "ITEM_STATUS_TRADING" } }),
      listing("m2", "sold_out", 22_200),
    ]);

    expect(result.sourceSoldStatusCount).toBe(1);
    expect(result.sourceSoldStatusPriceSampleCount).toBe(1);
    expect(result.referencePriceMedian).toBeUndefined();
    expect(result.sampleConfidence).toBe("insufficient");
  });

  it("withholds cross-condition medians instead of issuing a price verdict", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 20_000, { condition: "used" }),
      listing("m2", "sold_out", 24_000, { condition: "used" }),
      listing("m3", "available", 28_000, { condition: "new" }),
    ]);

    expect(result.mixedConditions).toBe(true);
    expect(result.comparisonCondition).toBe("new");
    expect(result.comparablePriceSampleCount).toBe(0);
    expect(result.comparisonExcludedPriceSampleCount).toBe(2);
    expect(result.comparisonWithheldReason).toBe("no_same_condition_history");
    expect(result.referencePriceMedian).toBeUndefined();
    expect(result.premiumToReferenceMedianPercent).toBeUndefined();
    expect(result.recommendation).toBe("mixed_comparability");
  });

  it("uses only the current offer condition when enough matching history exists", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 20_000, { condition: "used" }),
      listing("m2", "sold_out", 24_000, { condition: "used" }),
      listing("m3", "sold_out", 31_000, { condition: "new" }),
      listing("m4", "available", 28_000, { condition: "used" }),
    ]);

    expect(result.comparisonCondition).toBe("used");
    expect(result.comparablePriceSampleCount).toBe(2);
    expect(result.comparisonExcludedPriceSampleCount).toBe(1);
    expect(result.referencePriceMedian).toBe(22_000);
    expect(result.premiumToReferenceMedianPercent).toBe(27);
    expect(result.recommendation).toBe("slightly_above_history");
  });

  it("withholds comparisons across price bases", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "sold_out", 20_000, { priceBasis: "catalog_price" }),
      listing("m2", "sold_out", 24_000, { priceBasis: "catalog_price" }),
      listing("m3", "available", 28_000, { priceBasis: "listing_price" }),
    ]);

    expect(result.comparisonPriceBasis).toBe("listing_price");
    expect(result.comparablePriceSampleCount).toBe(0);
    expect(result.comparisonWithheldReason).toBe("no_same_price_basis_history");
    expect(result.referencePriceMedian).toBeUndefined();
    expect(result.recommendation).toBe("mixed_comparability");
  });

  it("counts backorder listings as active offers", () => {
    const result = buildProductPriceIntelligence([
      listing("m1", "backorder", 30_000),
    ]);

    expect(result.confirmedActiveOfferCount).toBe(1);
    expect(result.currentLowestPrice).toBe(30_000);
  });
});
