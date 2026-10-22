import { describe, expect, it } from "vitest";
import { stableStateHash, type SearchResult } from "../packages/core/src";
import type { WatchBindingRow } from "../packages/db/src";
import {
  marketAnalyticsFailureRun,
  marketAnalyticsRun,
} from "../apps/collector/src/analytics";
import { buildMarketScopeDefinition, marketScopeVersionId } from "../apps/collector/src/market-scope";

const binding: WatchBindingRow = {
  id: "binding-1",
  watch_profile_id: "profile-1",
  source_id: "surugaya",
  kind: "keyword",
  query: "雪ミク",
  search_url: null,
  target_url: null,
  source_config_json: "{}",
  source_item_id: null,
  interval_minutes: 60,
  schedule_interval_minutes: 1_440,
  monitoring_purpose: "keyword_market",
  next_run_at: "2026-07-20T00:00:00.000Z",
  baseline_completed: 1,
  notify_initial: 0,
  notify_new_listing: 0,
  notify_price_drop: 0,
  notify_restock: 0,
  notify_sold_out: 0,
  target_price: null,
  min_drop_amount: 1,
  enabled: 1,
  consecutive_failures: 0,
  cooldown_until: null,
  profile_name: "雪ミク行情",
};

describe("versioned market scope", () => {
  it("is stable across source order and excludes transient credentials", async () => {
    const first = buildMarketScopeDefinition({
      query: " 雪ミク　 ",
      includeTermsJson: '["初音ミク","雪ミク"]',
      excludeTermsJson: '["同人"]',
      bindings: [
        { source_id: "surugaya", source_config_json: '{"pages":2,"pageToken":"cursor","apiKey":"do-not-store","access_token":"also-secret","nested":{"PASSWORD":"never-store","categoryId":"42"}}' },
        { source_id: "mercari_jp", source_config_json: '{"conditions":["used"]}' },
      ],
    });
    const reordered = buildMarketScopeDefinition({
      query: "雪ミク",
      includeTermsJson: '["雪ミク","初音ミク"]',
      excludeTermsJson: '["同人"]',
      bindings: [
        { source_id: "mercari_jp", source_config_json: '{"conditions":["used"]}' },
        { source_id: "surugaya", source_config_json: '{"apiKey":"changed","pages":2,"pageToken":"different","ACCESS-TOKEN":"changed","nested":{"password":"changed","categoryId":"42"}}' },
      ],
    });

    expect(first.sources.find((source) => source.sourceId === "surugaya")?.sourceConfig)
      .toEqual({ nested: { categoryId: "42" }, pages: 2 });
    expect(await stableStateHash(first)).toBe(await stableStateHash(reordered));
  });

  it("binds the version primary key to the subscription identity", async () => {
    const scopeHash = "same-definition-hash";
    const first = await marketScopeVersionId("market:profile-1:雪ミク", scopeHash);
    const second = await marketScopeVersionId("market:profile-2:雪ミク", scopeHash);
    expect(first).toMatch(/^market-scope:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(await marketScopeVersionId("market:profile-1:雪ミク", scopeHash)).toBe(first);
  });

  it("changes identity when the comparable source window changes", async () => {
    const base = buildMarketScopeDefinition({
      query: "雪ミク",
      includeTermsJson: "[]",
      excludeTermsJson: "[]",
      bindings: [{ source_id: "surugaya", source_config_json: '{"pages":1}' }],
    });
    const changed = buildMarketScopeDefinition({
      query: "雪ミク",
      includeTermsJson: "[]",
      excludeTermsJson: "[]",
      bindings: [{ source_id: "surugaya", source_config_json: '{"pages":2}' }],
    });
    expect(await stableStateHash(base)).not.toBe(await stableStateHash(changed));
  });

  it("counts a source once and rejects ambiguous duplicate source configs", () => {
    const duplicate = buildMarketScopeDefinition({
      query: "雪ミク",
      includeTermsJson: "[]",
      excludeTermsJson: "[]",
      bindings: [
        { source_id: "surugaya", source_config_json: '{"pages":2}' },
        { source_id: "surugaya", source_config_json: '{"pages":2}' },
      ],
    });
    expect(duplicate.sources).toHaveLength(1);
    expect(() => buildMarketScopeDefinition({
      query: "雪ミク",
      includeTermsJson: "[]",
      excludeTermsJson: "[]",
      bindings: [
        { source_id: "surugaya", source_config_json: '{"pages":1}' },
        { source_id: "surugaya", source_config_json: '{"pages":2}' },
      ],
    })).toThrow("market_scope_conflicting_source_config:surugaya");
  });

  it("records an abnormal HTTP-success empty window as degradation, not a valid zero", () => {
    const run = marketAnalyticsFailureRun(binding, "run-1", {
      status: "failed",
      errorCode: "parser_structure_error",
      error: "结果从典型值 12 条骤降为 0 条",
      searchedAt: "2026-07-19T00:00:00.000Z",
      durationMs: 320,
      parserVersion: "surugaya-v5",
      coverage: "best_effort",
      abnormalEmpty: true,
    });
    expect(run.status).toBe("failed");
    expect(run.groups[0]).toMatchObject({
      status: "failed",
      listings: [],
      health: {
        state: "suspected_degradation",
        requestSucceeded: true,
        parseSucceeded: false,
        abnormalEmpty: true,
      },
    });
  });

  it("marks a bounded next cursor as budget coverage rather than full inventory", () => {
    const result: SearchResult = {
      sourceId: "surugaya",
      listings: [],
      coverage: "best_effort",
      nextCursor: "2",
      warnings: [],
      parserVersion: "surugaya-v5",
      fetchedAt: "2026-07-19T00:00:00.000Z",
      requestEvidence: {
        availabilityMode: "all",
        rawResultCount: 0,
        normalizedResultCount: 0,
        pagesFetched: 1,
      },
    };
    const run = marketAnalyticsRun(binding, "run-2", result, {}, 100);
    expect(run.groups[0]?.health).toMatchObject({
      state: "empty",
      cursorTerminationReason: "budget_reached",
      pageDepth: 1,
    });
  });
});
