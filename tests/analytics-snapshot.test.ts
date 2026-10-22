import { describe, expect, it } from "vitest";

import { normalizedSnapshotListings } from "../apps/collector/src/analytics";

function listingWithImages(imageUrls: unknown[]) {
  return {
    sourceId: "charaon",
    sourceItemId: "AZREZ43",
    identityScope: "catalog",
    canonicalUrl: "https://www.charaon.jp/SHOP/AZREZ43.html",
    title: "Re:ゼロ 商品",
    currency: "JPY",
    currentPrice: 1_000,
    priceBasis: "catalog_price",
    condition: "new",
    availability: "available",
    facts: { imageUrls },
  };
}

describe("analytics snapshot compatibility", () => {
  it("bounds legacy image evidence without mutating the source snapshot", () => {
    const imageUrls = Array.from(
      { length: 47 },
      (_, index) => `https://image1.shopserve.jp/charaon.jp/pic-labo/llimg/item-${index}.jpg`,
    );
    const source = listingWithImages(imageUrls);
    const [normalized] = normalizedSnapshotListings([source]);

    expect(normalized?.facts?.imageUrls).toHaveLength(30);
    expect(source.facts.imageUrls).toHaveLength(47);
  });

  it("continues to fail closed on invalid image evidence", () => {
    const imageUrls = Array.from(
      { length: 31 },
      (_, index) => index === 0 ? "http://insecure.example/item.jpg" : `https://example.com/item-${index}.jpg`,
    );
    expect(() => normalizedSnapshotListings([listingWithImages(imageUrls)]))
      .toThrow("analytics_listing_snapshot_invalid");
  });
});
