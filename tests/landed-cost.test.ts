import { describe, expect, it } from "vitest";
import {
  buildLandedCostEstimate,
  extractLandedCostListingFacts,
  landedCostMeetsTarget,
  landedCostThresholdPolicy,
  type LandedCostProfile,
} from "@jpgr/core";

const profile: LandedCostProfile = {
  id: "cp_test-v1",
  profileKey: "default",
  version: 1,
  name: "测试空运",
  exchangeRateCnyPer100JpyMilli: 4_800,
  exchangeRateBufferBps: 200,
  proxyFixedFeeJpy: 300,
  proxyPercentBps: 500,
  domesticShippingMinJpy: 0,
  domesticShippingMaxJpy: 500,
  internationalRouteLabel: "测试空运线",
  firstWeightGrams: 500,
  firstWeightMinJpy: 1_000,
  firstWeightMaxJpy: 1_500,
  continuedWeightGrams: 100,
  continuedWeightMinJpy: 200,
  continuedWeightMaxJpy: 300,
  unknownWeightMinGrams: 200,
  unknownWeightMaxGrams: 600,
  consolidationShareBps: 10_000,
  taxEnabled: false,
  taxBps: 0,
  costBufferBps: 1_000,
  validFrom: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-19T00:00:00.000Z",
  createdBy: "user",
};

describe("landed cost", () => {
  it("keeps an explicit range when weight and domestic shipping are unknown", () => {
    const estimate = buildLandedCostEstimate({
      currency: "JPY",
      listingPriceJpy: 3_800,
    }, profile);

    expect(estimate).toMatchObject({
      status: "estimated",
      precision: "range",
      weightSource: "cost_profile_range",
      weightRangeGrams: { min: 200, max: 600 },
      missingFacts: ["domestic_shipping", "weight"],
      components: {
        listingPriceJpy: { min: 3_800, max: 3_800 },
        domesticShippingJpy: { min: 0, max: 500 },
        proxyFeeJpy: { min: 490, max: 490 },
        internationalShippingJpy: { min: 1_000, max: 1_800 },
        taxJpy: { min: 0, max: 0 },
        costBufferJpy: { min: 529, max: 659 },
      },
      landedCostJpy: { min: 5_819, max: 7_249 },
      landedCostCnyFen: { min: 27_931, max: 35_492 },
    });
  });

  it("重量已知时按上界保守判定目标", () => {
    const estimate = buildLandedCostEstimate({
      currency: "JPY",
      listingPriceJpy: 3_800,
      weightGrams: 400,
      domesticShippingJpy: 500,
    }, profile);
    expect(estimate.missingFacts).toEqual([]);
    expect(landedCostThresholdPolicy(estimate)).toBe("estimate_upper_bound_at_or_below");
    const max = estimate.landedCostJpy!.max;
    expect(landedCostMeetsTarget(estimate, max - 1)).toBe(false);
    expect(landedCostMeetsTarget(estimate, max)).toBe(true);
  });

  it("重量未知时按区间中点判定，否则该功能在生产里永远无法触发", () => {
    // 搜索结果几乎都不带重量，上界会按 profile 未知区间的最重档计算：
    // 一件真实 150g 的挂件被按 600g 估价，用户设的目标价永远满足不了。
    const estimate = buildLandedCostEstimate({ currency: "JPY", listingPriceJpy: 3_800 }, profile);
    expect(estimate.missingFacts).toContain("weight");
    expect(landedCostThresholdPolicy(estimate)).toBe("estimate_midpoint_at_or_below");
    const { min, max } = estimate.landedCostJpy!;
    const midpoint = Math.round((min + max) / 2);
    expect(landedCostMeetsTarget(estimate, midpoint - 1)).toBe(false);
    expect(landedCostMeetsTarget(estimate, midpoint)).toBe(true);
    // 中点严格落在区间内，因此上界判定下会被拒的目标价现在可以触发。
    expect(midpoint).toBeGreaterThan(min);
    expect(midpoint).toBeLessThan(max);
  });

  it("does not estimate a non-JPY or missing listing price", () => {
    expect(buildLandedCostEstimate({ currency: "CNY", listingPriceJpy: 100 }, profile))
      .toMatchObject({ status: "unavailable", reason: "non_jpy_listing" });
    expect(buildLandedCostEstimate({ currency: "JPY" }, profile))
      .toMatchObject({ status: "unavailable", reason: "missing_listing_price" });
  });

  it("extracts only bounded structured shipping and weight facts", () => {
    expect(extractLandedCostListingFacts({
      facts: {
        specifications: [{ name: "商品重量", value: "0.25 kg" }],
        displayFacts: [{ key: "shipping", label: "送料", group: "shipping", kind: "text", value: "¥520" }],
      },
    })).toEqual({ domesticShippingJpy: 520, weightGrams: 250 });
  });
});
