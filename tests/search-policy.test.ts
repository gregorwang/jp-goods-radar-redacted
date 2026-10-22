import { describe, expect, it } from "vitest";
import {
  assessKeywordWindow,
  canonicalJson,
  exactProductEvidenceFilters,
  filterListings,
  keywordQueryTermGroups,
  listingForDeterministicState,
  searchFiltersFromConfig,
  serviceSignatureMessage,
  validComparablePrice,
  type NormalizedListing,
} from "@jpgr/core";
import { exactProductSourceConfig } from "../apps/web/src/lib/exact-product-watch";

const listing = (overrides: Partial<NormalizedListing>): NormalizedListing => ({
  sourceId: "surugaya",
  sourceItemId: "1",
  identityScope: "listing",
  canonicalUrl: "https://www.suruga-ya.jp/product/detail/1",
  title: "氷菓 千反田える フィギュア",
  currency: "JPY",
  currentPrice: 4_800,
  priceBasis: "listing_price",
  condition: "used",
  availability: "available",
  ...overrides,
});

describe("search policy", () => {
  it("restores saved filters from both legacy root keys and nested filters", () => {
    expect(searchFiltersFromConfig({ minPrice: 1_000, filters: { maxPrice: 5_000, inStockOnly: true } }, { page: 1 }))
      .toEqual({ minPrice: 1_000, maxPrice: 5_000, inStockOnly: true, availabilityMode: undefined, page: 1, conditions: undefined, pageSize: undefined });
  });

  it("keeps exact-product evidence acquisition independent from shopping and alert filters", () => {
    expect(exactProductEvidenceFilters({
      minPrice: 1_000,
      maxPrice: 4_500,
      conditions: ["new"],
      inStockOnly: true,
      availabilityMode: "purchasable",
      page: 1,
      pageSize: 30,
      sort: "newest",
    })).toEqual({
      minPrice: undefined,
      maxPrice: undefined,
      conditions: undefined,
      inStockOnly: false,
      availabilityMode: "all",
      page: 1,
      pageSize: 30,
      sort: "newest",
    });
    expect(exactProductSourceConfig({
      pages: 1,
      maxPrice: 4_500,
      availabilityMode: "purchasable",
      inStockOnly: true,
      filters: { minPrice: 1_000, conditions: ["new"], pageSize: 30 },
    })).toEqual({
      pages: 1,
      filters: { pageSize: 30 },
      availabilityMode: "all",
      inStockOnly: false,
    });
  });

  it("enforces price, condition, stock, include and exclude terms after provider normalization", () => {
    const accepted = listing({ sourceItemId: "accepted" });
    const tooExpensive = listing({ sourceItemId: "expensive", currentPrice: 9_000 });
    const excluded = listing({ sourceItemId: "excluded", title: "氷菓 千反田える 非売品" });
    const sold = listing({ sourceItemId: "sold", availability: "sold_out" });
    expect(filterListings([accepted, tooExpensive, excluded, sold], {
      maxPrice: 5_000,
      conditions: ["used"],
      inStockOnly: true,
    }, ["千反田える"], ["非売品"]).map((item) => item.sourceItemId)).toEqual(["accepted"]);
  });

  it("keeps only sold records in explicit history mode", () => {
    const available = listing({ sourceItemId: "available" });
    const sold = listing({ sourceItemId: "sold", availability: "sold_out" });
    expect(filterListings([available, sold], { availabilityMode: "sold_out" }).map((item) => item.sourceItemId))
      .toEqual(["sold"]);
  });

  it("supports required include groups with aliases and normalizes Japanese punctuation", () => {
    const emilia = listing({
      sourceItemId: "emilia",
      title: "キャラカード エミリア Re：ゼロから始める異世界生活",
    });
    const wrongCharacter = listing({ sourceItemId: "rem", title: "レム Re:ゼロ アクリルカード" });
    const wrongEmilia = listing({ sourceItemId: "clarke", title: "Emilia Clarke 写真集 Re Zero" });
    expect(filterListings(
      [emilia, wrongCharacter, wrongEmilia],
      {},
      ["エミリア|EMILIA", "Re:ゼロ|リゼロ|Re Zero"],
      ["Emilia Clarke|エミリア・クラーク"],
    ).map((item) => item.sourceItemId)).toEqual(["emilia"]);
  });

  it("repairs spaced single-character Japanese keyword input", () => {
    expect(keywordQueryTermGroups("エ ミ リ ア")).toEqual(["エミリア"]);
    expect(keywordQueryTermGroups("Re:ゼロ エミリア")).toEqual(["re:ゼロ", "エミリア"]);
  });

  it("projects one deterministic state for the direct and the AI-finalized write path", () => {
    expect(validComparablePrice(4_800)).toBe(4_800);
    expect([0, -1, Number.NaN, 2_000_000_000].map(validComparablePrice)).toEqual([undefined, undefined, undefined, undefined]);

    const invalid = listingForDeterministicState(listing({ currentPrice: 0, originalPrice: 2_000_000_000 }));
    expect(invalid.currentPrice).toBeUndefined();
    expect(invalid.originalPrice).toBeUndefined();
    expect(invalid.rawMetadata).toMatchObject({ priceStatus: "invalid", rawCurrentPrice: 0, rawOriginalPrice: 2_000_000_000 });
    expect(listingForDeterministicState(listing({ currentPrice: undefined })).rawMetadata?.priceStatus).toBe("missing");

    // 同一件商品无论由直采还是 AI 定稿落库，投影必须逐字节一致，否则 stableStateHash 漂移会造出幻影 changed 事件。
    const projected = listingForDeterministicState(listing({}));
    expect(projected.rawMetadata?.priceStatus).toBe("valid");
    expect(canonicalJson(listingForDeterministicState(listing({})))).toBe(canonicalJson(projected));
  });

  it("allows a growing baseline but blocks a disjoint undated result window", () => {
    const known = new Set(Array.from({ length: 100 }, (_, index) => `known-${index}`));
    const growing = [
      ...Array.from({ length: 100 }, (_, index) => listing({ sourceItemId: `known-${index}` })),
      ...Array.from({ length: 20 }, (_, index) => listing({ sourceItemId: `new-${index}` })),
    ];
    expect(assessKeywordWindow({ listings: growing, knownSourceItemIds: known, previousTypicalCount: 100, intervalMinutes: 1_440 }))
      .toMatchObject({ status: "ok", knownOverlapCount: 100, newCandidateCount: 20 });

    const replaced = Array.from({ length: 30 }, (_, index) => listing({ sourceItemId: `replacement-${index}` }));
    expect(assessKeywordWindow({ listings: replaced, knownSourceItemIds: known, previousTypicalCount: 30, intervalMinutes: 1_440 }))
      .toMatchObject({ status: "anomalous", knownOverlapCount: 0, newCandidateCount: 30, verifiablyFreshCount: 0 });
  });

  it("does not reject an undated rolling window that is expected to turn over", () => {
    const known = new Set(Array.from({ length: 30 }, (_, index) => `known-${index}`));
    const replaced = Array.from({ length: 30 }, (_, index) => listing({ sourceItemId: `replacement-${index}` }));
    expect(assessKeywordWindow({
      listings: replaced,
      knownSourceItemIds: known,
      previousTypicalCount: 30,
      intervalMinutes: 1_440,
      coverage: "rolling_window",
    })).toMatchObject({ status: "ok", knownOverlapCount: 0, newCandidateCount: 30, verifiablyFreshCount: 0 });
  });
});

describe("service request canonicalization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: "值" }, list: [3, 1] }))
      .toBe('{"list":[3,1],"nested":{"a":"值","b":true},"z":1}');
  });

  it("binds the scope and timestamp into the signed message", () => {
    expect(serviceSignatureMessage("mercari.search.v1", "1720000000000", { query: "千反田える" }))
      .toBe('mercari.search.v1\n1720000000000\n{"query":"千反田える"}');
  });
});
