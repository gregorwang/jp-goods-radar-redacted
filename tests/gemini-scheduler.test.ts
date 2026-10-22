import { describe, expect, it } from "vitest";
import {
  GEMINI_LISTING_OUTPUT_TOKEN_RESERVE,
  GEMINI_FREE_TIER_RPM_LIMIT,
  GEMINI_SCHEDULER_RPM_BUDGET,
  estimateGeminiInputTokens,
  parseGeminiRetryDelaySeconds,
  safeGeminiTransportError,
  takeGeminiTokenBudgetBatch,
} from "../packages/ai/src/gemini-scheduler";

describe("Gemini queue scheduling", () => {
  it("keeps a request-rate safety margin below the free-tier ceiling", () => {
    expect(GEMINI_SCHEDULER_RPM_BUDGET).toBeLessThan(GEMINI_FREE_TIER_RPM_LIMIT);
    expect(GEMINI_SCHEDULER_RPM_BUDGET).toBeGreaterThan(0);
  });

  it("splits by estimated input tokens instead of a fixed item count", () => {
    const tinyItems = Array.from({ length: 350 }, (_, index) => ({ index, title: "a" }));
    const tiny = takeGeminiTokenBudgetBatch(tinyItems, (items) => ({ items }), 10_000);
    expect(tiny.items.length).toBeGreaterThan(200);
    expect(tiny.estimatedInputTokens).toBeLessThanOrEqual(10_000);

    const largeItems = Array.from({ length: 10 }, (_, index) => ({ index, title: "長".repeat(4_000) }));
    const large = takeGeminiTokenBudgetBatch(largeItems, (items) => ({ items }), 5_000);
    expect(large.items).toHaveLength(1);
    expect(estimateGeminiInputTokens({ items: large.items })).toBeGreaterThan(5_000);
  });

  it("reserves output capacity so large listing batches make incremental progress", () => {
    const items = Array.from({ length: 84 }, (_, index) => ({ index, title: `商品 ${index}` }));
    const selected = takeGeminiTokenBudgetBatch(
      items,
      (candidate) => ({ items: candidate }),
      80_000,
      GEMINI_LISTING_OUTPUT_TOKEN_RESERVE,
    );

    expect(selected.items.length).toBeGreaterThan(1);
    expect(selected.items.length).toBeLessThan(items.length);
    expect(selected.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("uses the longest server retry hint from Retry-After and google.rpc.RetryInfo", () => {
    const headers = new Headers({ "Retry-After": "75" });
    const body = JSON.stringify({
      error: {
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "91.2s" }],
      },
    });
    expect(parseGeminiRetryDelaySeconds(headers, body)).toBe(92);
  });

  it("keeps a bounded upstream error while redacting credential-shaped data", () => {
    const detail = safeGeminiTransportError(JSON.stringify({
      error: { message: `quota failed for https://example.com/path api_key=${"x".repeat(48)}` },
    }));
    expect(detail).toContain("quota failed");
    expect(detail).toContain("[redacted-url]");
    expect(detail).not.toContain("x".repeat(48));
  });
});
