import { describe, expect, it } from "vitest";
import { relevancePatchExpandsScope } from "../apps/web/src/lib/watch-profile-scope";

describe("keyword dossier relevance patches", () => {
  it("keeps the baseline when exclusions are only added", () => {
    expect(relevancePatchExpandsScope({
      currentIncludeTermsJson: "[]",
      currentExcludeTermsJson: JSON.stringify(["コスプレ|cosplay"]),
      nextIncludeTerms: [],
      nextExcludeTerms: ["コスプレ|cosplay|コスチューム", "仮装"],
    })).toBe(false);
  });

  it("resets the baseline when an exclusion is removed", () => {
    expect(relevancePatchExpandsScope({
      currentIncludeTermsJson: "[]",
      currentExcludeTermsJson: JSON.stringify(["コスプレ|cosplay", "仮装"]),
      nextExcludeTerms: ["コスプレ|cosplay"],
    })).toBe(true);
  });

  it("conservatively resets the baseline when include rules change", () => {
    expect(relevancePatchExpandsScope({
      currentIncludeTermsJson: JSON.stringify(["加藤恵"]),
      currentExcludeTermsJson: "[]",
      nextIncludeTerms: ["加藤恵", "冴えない彼女の育てかた"],
    })).toBe(true);
  });

  it("does not confuse changed include groups with the same flattened words", () => {
    expect(relevancePatchExpandsScope({
      currentIncludeTermsJson: JSON.stringify(["加藤恵|恵", "冴えカノ"]),
      currentExcludeTermsJson: "[]",
      nextIncludeTerms: ["加藤恵", "恵|冴えカノ"],
    })).toBe(true);
  });
});
