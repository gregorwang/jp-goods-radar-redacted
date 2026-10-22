import { describe, expect, it } from "vitest";
import type { NormalizedListing, SearchCandidateEvidence } from "@jpgr/core";
import { hasStoredSearchSnapshot, initialSearchResultPresentation } from "../apps/web/src/lib/search-run";

function evidence(relation: NonNullable<SearchCandidateEvidence["match"]>["relation"]): SearchCandidateEvidence {
  return {
    hits: [],
    fusedScore: 0,
    bestRank: 1,
    historical: false,
    liveVerified: true,
    match: {
      version: "product-match-v6",
      relation,
      score: 0,
      confidence: "low",
      matchedFields: [],
      conflicts: [],
      reasons: [],
    },
  };
}

function listing(sourceItemId: string): NormalizedListing {
  return {
    sourceId: "surugaya",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl: `https://www.suruga-ya.jp/product/detail/${sourceItemId}`,
    title: "测试商品",
    currency: "JPY",
    priceBasis: "listing_price",
    condition: "used",
    availability: "available",
  };
}

describe("search run restoration", () => {
  it("accepts both SQLite and PostgreSQL snapshot flags", () => {
    expect(hasStoredSearchSnapshot(1)).toBe(true);
    expect(hasStoredSearchSnapshot(true)).toBe(true);
    expect(hasStoredSearchSnapshot(0)).toBe(false);
    expect(hasStoredSearchSnapshot(false)).toBe(false);
    expect(hasStoredSearchSnapshot(undefined)).toBe(false);
  });

  it("keeps unconfirmed exact-search candidates in the curated review bucket", () => {
    expect(initialSearchResultPresentation("exact_product", [{
      listings: [listing("bundle")],
      candidateEvidence: { bundle: evidence("bundle") },
    }])).toEqual({
      resultScope: "curated",
      resultMatchBucket: "related",
      needsManualReview: true,
    });
  });

  it("keeps confirmed exact matches in the curated exact bucket", () => {
    expect(initialSearchResultPresentation("exact_product", [{
      listings: [listing("exact")],
      candidateEvidence: { exact: evidence("exact") },
    }])).toEqual({
      resultScope: "curated",
      resultMatchBucket: "exact",
      needsManualReview: false,
    });
  });
});
