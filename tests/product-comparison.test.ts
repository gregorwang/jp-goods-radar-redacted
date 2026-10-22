import { describe, expect, it } from "vitest";
import {
  compareListingAvailability,
  compareListingPrices,
  exactProductTitleKey,
  groupComparableListings,
  productIdentity,
  type NormalizedListing,
} from "@jpgr/core";

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    sourceId: "rakuten_ichiba",
    sourceItemId: "shop:item",
    identityScope: "listing",
    canonicalUrl: "https://item.rakuten.co.jp/shop/item/",
    title: "Re:ゼロから始める異世界生活 Vol.3",
    currency: "JPY",
    currentPrice: 4_000,
    priceBasis: "listing_price",
    condition: "new",
    availability: "available",
    ...overrides,
  };
}

describe("product comparison", () => {
  it("normalizes punctuation but preserves edition and volume words", () => {
    expect(exactProductTitleKey("Re:ゼロ Vol.3")).toBe(exactProductTitleKey("Ｒｅ：ゼロ　Ｖｏｌ．３"));
    expect(exactProductTitleKey("Re:ゼロ Vol.3")).not.toBe(exactProductTitleKey("Re:ゼロ Vol.5"));
  });

  it("prefers source identifiers over exact-title matching", () => {
    const item = listing({
      sourceId: "rakuten_books",
      sourceItemId: "9784041064839",
      identityScope: "catalog",
      rawMetadata: { identifiers: { isbn: "978-4-04-106483-9" } },
    });
    expect(productIdentity(item)).toEqual({ key: "isbn:9784041064839", method: "identifier" });
  });

  it("groups only deterministic matches and keeps different volumes apart", () => {
    const groups = groupComparableListings([
      listing({ sourceItemId: "left", title: "Re:ゼロから始める異世界生活 Vol.3", currentPrice: 5_000 }),
      listing({ sourceId: "mercari_jp", sourceItemId: "right", title: "Ｒｅ：ゼロから始める異世界生活 Ｖｏｌ．３", currentPrice: 3_000 }),
      listing({ sourceId: "surugaya", sourceItemId: "other", title: "Re:ゼロから始める異世界生活 Vol.5", currentPrice: 2_000 }),
    ]);
    expect(groups.map((group) => group.listings.length).sort()).toEqual([1, 2]);
    expect(groups.find((group) => group.listings.length === 2)?.listings.map((item) => item.currentPrice)).toEqual([3_000, 5_000]);
  });

  it("keeps new and used offers in separate comparison buckets", () => {
    const groups = groupComparableListings([
      listing({ sourceItemId: "new", condition: "new" }),
      listing({ sourceId: "mercari_jp", sourceItemId: "used", condition: "used" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.condition).sort()).toEqual(["new", "used"]);
  });

  it("puts unavailable and sold-out offers after comparable in-stock prices", () => {
    const values = [
      listing({ sourceItemId: "sold", currentPrice: 1_000, availability: "sold_out" }),
      listing({ sourceItemId: "unknown", currentPrice: undefined, availability: "available" }),
      listing({ sourceItemId: "live", currentPrice: 3_000, availability: "available" }),
    ].sort(compareListingPrices);
    expect(values.map((item) => item.sourceItemId)).toEqual(["live", "unknown", "sold"]);
    expect(compareListingAvailability(
      listing({ availability: "sold_out" }),
      listing({ availability: "available" }),
    )).toBeGreaterThan(0);
  });
});
