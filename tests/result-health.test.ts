import { describe, expect, it } from "vitest";
import { isUnexpectedEmptySearch } from "../apps/collector/src/result-health";

describe("isUnexpectedEmptySearch", () => {
  it("flags an unexplained keyword result collapse", () => {
    expect(isUnexpectedEmptySearch({
      bindingKind: "keyword",
      exactProduct: false,
      previousTypicalCount: 10,
      rawResultCount: 0,
    })).toBe(true);
  });

  it("accepts an empty exact-product result", () => {
    expect(isUnexpectedEmptySearch({
      bindingKind: "keyword",
      exactProduct: true,
      previousTypicalCount: 10,
      rawResultCount: 0,
    })).toBe(false);
  });

  it("accepts a source-verified empty keyword result", () => {
    expect(isUnexpectedEmptySearch({
      bindingKind: "keyword",
      exactProduct: false,
      previousTypicalCount: 10,
      rawResultCount: 0,
      collectionOutcome: "verified_empty",
    })).toBe(false);
  });
});
