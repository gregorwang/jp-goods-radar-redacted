import { describe, expect, it } from "vitest";
import {
  buildProductLifecycleIntelligence,
  relistTitleSimilarity,
  type ProductLifecycleListingInput,
} from "@jpgr/core";

function listing(input: Partial<ProductLifecycleListingInput> & Pick<ProductLifecycleListingInput, "membershipId" | "sourceItemId" | "title">): ProductLifecycleListingInput {
  return {
    sourceId: "mercari_jp",
    canonicalUrl: `https://jp.mercari.com/item/${input.sourceItemId}`,
    imageUrl: "https://static.mercdn.net/item/detail/orig/photos/shared.jpg?crop=1",
    sellerName: "同じ 出品者",
    sourceListedAt: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    currentPrice: 1_000,
    availability: "available",
    condition: "used",
    observations: [],
    ...input,
  };
}

describe("product lifecycle intelligence", () => {
  it("keeps listing timelines separate, preserves right censoring, and bounds relist ambiguity", () => {
    const result = buildProductLifecycleIntelligence([
      listing({
        membershipId: "pm_a",
        sourceItemId: "m-a",
        title: "雪ミク ふわふわ ぬいぐるみ 限定",
        sourceListedAt: "2026-01-01T00:00:00.000Z",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-05T00:00:00.000Z",
        availability: "sold_out",
        observations: [
          { evidenceId: "a1", evidenceKind: "search_observation", observedAt: "2026-01-01T00:00:00.000Z", price: 1_000, availability: "available", condition: "used" },
          { evidenceId: "a2", evidenceKind: "search_observation", observedAt: "2026-01-03T00:00:00.000Z", price: 900, availability: "available", condition: "used" },
          { evidenceId: "a3", evidenceKind: "operational_snapshot", observedAt: "2026-01-05T00:00:00.000Z", price: 900, availability: "sold_out", condition: "used" },
        ],
      }),
      listing({
        membershipId: "pm_b",
        sourceItemId: "m-b",
        title: "限定 雪ミク ふわふわぬいぐるみ",
        sourceListedAt: "2026-01-10T00:00:00.000Z",
        firstSeenAt: "2026-01-10T00:00:00.000Z",
        lastSeenAt: "2026-01-12T00:00:00.000Z",
        observations: [
          { evidenceId: "b1", evidenceKind: "search_observation", observedAt: "2026-01-10T00:00:00.000Z", price: 1_200, availability: "available", condition: "used" },
          { evidenceId: "b2", evidenceKind: "search_observation", observedAt: "2026-01-12T00:00:00.000Z", price: 1_200, availability: "available", condition: "used" },
        ],
      }),
      listing({
        membershipId: "pm_c",
        sourceItemId: "m-c",
        title: "雪ミク ぬいぐるみ 別出品",
        verifiedSaleCount: 1,
        sellerName: "別の出品者",
        imageUrl: "https://static.mercdn.net/item/detail/orig/photos/other.jpg",
        sourceListedAt: "2026-01-20T00:00:00.000Z",
        firstSeenAt: "2026-01-20T00:00:00.000Z",
        lastSeenAt: "2026-01-20T00:00:00.000Z",
        availability: "sold_out",
        observations: [
          { evidenceId: "c1", evidenceKind: "search_observation", observedAt: "2026-01-20T00:00:00.000Z", price: 800, availability: "sold_out", condition: "used" },
        ],
      }),
    ], Date.parse("2026-01-30T00:00:00.000Z"));

    expect(result.rawAppearanceCount).toBe(3);
    expect(result.candidateAdjustedAppearanceRange).toEqual({ min: 2, max: 3 });
    expect(result.relistCandidates).toHaveLength(1);
    expect(result.relistCandidates[0]).toMatchObject({
      status: "candidate",
      sourceItemIds: ["m-a", "m-b"],
      evidence: { sameSeller: true, sameImage: true },
    });
    expect(result.sourceDatedMedianGapDays).toBe(9.5);
    expect(result.sourceDatedNewOffers90d).toBe(3);
    expect(result.completedObservedActiveDurationCount).toBe(1);
    expect(result.rightCensoredActiveCount).toBe(1);

    const first = result.listings.find((item) => item.sourceItemId === "m-a");
    expect(first).toMatchObject({
      observedActiveDurationDays: 4,
      rightCensored: false,
      priceChangeCount: 1,
      statusChangeCount: 1,
      verifiedSale: false,
      verifiedSaleCount: 0,
    });
    expect(first?.timeline.map((point) => point.transition)).toEqual([
      "first_observation",
      "price_changed",
      "status_changed",
    ]);
    const second = result.listings.find((item) => item.sourceItemId === "m-b");
    expect(second).toMatchObject({ rightCensored: true, observedActiveAtLeastDays: 2, observationCount: 2 });
    expect(second?.timeline).toHaveLength(1);
    const third = result.listings.find((item) => item.sourceItemId === "m-c");
    expect(third).toMatchObject({ verifiedSale: true, verifiedSaleCount: 1 });
  });

  it("requires a strong title match in addition to seller and image", () => {
    expect(relistTitleSimilarity("雪ミク ふわふわ ぬいぐるみ 限定", "限定 雪ミク ふわふわぬいぐるみ"))
      .toBeGreaterThanOrEqual(0.72);
    expect(relistTitleSimilarity("雪ミク ぬいぐるみ", "エミリア フィギュア"))
      .toBeLessThan(0.72);
  });
});
