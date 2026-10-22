import { describe, expect, it } from "vitest";
import {
  marketSubscriptionKey,
  normalizeAnalyticsQuery,
  readAnalyticsOverview,
  readMarketAnalysisEvidence,
  readMarketCleaningCandidates,
  selectProductIdentityResolutionCandidate,
  type AnalyticsQueryClient,
  type ProductIdentityResolutionCandidate,
} from "../packages/analytics/src/index";
import type { QueryResultRow } from "pg";

const qualityFields = {
  scope_version_id: "market-scope:scope-1",
  scope_version: 1,
  quality_grade: "A",
  interpretable: true,
  warmup: false,
  expected_source_count: 2,
  successful_source_count: 2,
  failed_source_count: 0,
  stale_source_count: 0,
  coverage_rate: 1,
} as const;

describe("analytics repository", () => {
  it("reuses the most compatible existing variant when a fingerprint is corrected", () => {
    const candidates: ProductIdentityResolutionCandidate[] = [
      {
        canonical_product_id: "cp_bad",
        canonical_hash: "1".repeat(64),
        variant_id: "pv_bad",
        variant_hash: "2".repeat(64),
        identity_version: "product-identity-v1",
        canonical_name: "ぬいぐるみ エミリア F:NEX限定",
        target_fingerprint: {
          canonicalName: "ぬいぐるみ エミリア F:NEX限定",
          workTitle: "ぬいぐるみ",
          characters: ["F:NEX限定"],
          productType: "ぬいぐるみ",
        },
        updated_at: "2026-07-28T10:00:00.000Z",
        current_confirmed_count: 8,
      },
      {
        canonical_product_id: "cp_good",
        canonical_hash: "3".repeat(64),
        variant_id: "pv_good",
        variant_hash: "4".repeat(64),
        identity_version: "product-identity-v1",
        canonical_name: "ぬいぐるみ　エミリア F：NEX限定",
        target_fingerprint: {
          canonicalName: "ぬいぐるみ　エミリア F：NEX限定",
          workTitle: "Re:ゼロから始める異世界生活",
          characters: ["エミリア"],
          productType: "ぬいぐるみ",
        },
        updated_at: "2026-07-27T10:00:00.000Z",
        current_confirmed_count: 2,
      },
    ];
    expect(selectProductIdentityResolutionCandidate(candidates, {
      canonicalName: "ぬいぐるみ エミリア F:NEX限定",
      workTitle: "Re:ゼロから始める異世界生活",
      characters: ["エミリア"],
      productType: "ぬいぐるみ",
    })?.variant_id).toBe("pv_good");
  });

  it("normalizes Japanese market subscription identity without changing its meaning", () => {
    expect(normalizeAnalyticsQuery("  雪ミク　SNOW   MIKU  ")).toBe("雪ミク snow miku");
    expect(marketSubscriptionKey("profile-1", "  雪ミク　SNOW   MIKU  "))
      .toBe("market:profile-1:雪ミク snow miku");
  });

  it("maps scheduled market aggregates without mixing in manual searches", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const subscriptionKey = "market:profile-1:雪ミク";
    const client: AnalyticsQueryClient = {
      async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        if (sql.includes("latest_metrics")) return { rows: [{
          run_count: 3,
          subscription_count: 1,
          observed_listings: 8,
          visible_listings: 6,
          new_listings: 2,
          left_visible_window: 1,
        }] as Row[] };
        if (sql.includes("ORDER BY day ASC")) return { rows: [{
          day: "2026-07-13",
          source_id: "surugaya",
          subscription_key: subscriptionKey,
          subscription_name: "千反田市场",
          query: "雪ミク",
          visible_count: 6,
          new_count: 2,
          left_visible_window: 1,
          run_count: 2,
          source_count: 2,
          available_count: 4,
          sold_out_count: 2,
          priced_count: 5,
          min_price_jpy: 1_200,
          median_price_jpy: 3_200,
          average_price_jpy: 3_480,
          max_price_jpy: 6_800,
          ...qualityFields,
        }] as Row[] };
        if (sql.includes("WHERE latest.position=1")) return { rows: [{
          latest_day: "2026-07-13",
          source_id: "surugaya",
          subscription_key: subscriptionKey,
          subscription_name: "千反田市场",
          query: "雪ミク",
          visible_count: 6,
          previous_visible: 4,
          new_count: 2,
          left_visible_window: 1,
          run_count: 2,
          source_count: 2,
          available_count: 4,
          sold_out_count: 2,
          priced_count: 5,
          min_price_jpy: 1_200,
          median_price_jpy: 3_200,
          average_price_jpy: 3_480,
          max_price_jpy: 6_800,
          ...qualityFields,
        }] as Row[] };
        if (sql.includes("request_success_rate")) return { rows: [{
          subscription_key: subscriptionKey,
          source_id: "surugaya",
          run_count: 3,
          successful_runs: 2,
          result_count: 8,
          average_duration_ms: 640,
          request_success_rate: 1,
          parse_success_rate: 2 / 3,
          abnormal_empty_runs: 1,
          latest_state: "healthy",
          latest_observed_at: "2026-07-13T02:00:00.000Z",
          freshness_sla_minutes: 2_880,
          fresh: true,
        }] as Row[] };
        return { rows: [] as Row[] };
      },
    };

    const overview = await readAnalyticsOverview(client, { days: 30, subscriptionKey, sourceId: "surugaya" });
    expect(overview).toMatchObject({
      days: 30,
      subscriptionKey,
      sourceId: "surugaya",
      summary: {
        runCount: 3,
        subscriptionCount: 1,
        observedListings: 8,
        visibleListings: 6,
        newListings: 2,
        leftVisibleWindow: 1,
      },
      trends: [{ subscriptionKey, sourceId: "surugaya", visibleCount: 6, medianPrice: 3_200 }],
      subscriptions: [{ subscriptionKey, sourceId: "surugaya", visibleCount: 6 }],
      categories: [],
      sources: [{ subscriptionKey, sourceId: "surugaya", successfulRuns: 2 }],
    });
    expect(overview.subscriptions[0]).toMatchObject({
      subscriptionKey,
      visibleCount: 6,
      previousVisible: 4,
      latestDay: "2026-07-13",
    });
    expect(statements).toHaveLength(5);
    expect(statements.every(({ values }) => (
      values?.[0] === 30 && values?.[1] === subscriptionKey && values?.[2] === "surugaya"
    ))).toBe(true);
    const sql = statements.map((statement) => statement.sql).join("\n");
    expect(sql).toContain("origin='watch_keyword'");
    expect(sql).toContain("market_scope_daily_source_metrics");
    expect(sql).toContain("latest_scopes");
  });

  it("builds market evidence from complete cleaned daily facts instead of raw observations", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const subscriptionKey = "market:profile-1:千反田";
    const client: AnalyticsQueryClient = {
      async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        if (sql.includes("selected_runs")) return { rows: [{
          scope_version_id: "market-scope:test-v1",
          scope_version: 1,
          subscription_name: "千反田",
          query: "千反田",
          run_count: 2,
          successful_source_runs: 4,
          source_count: 2,
          evidence_started_at: "2026-07-14T02:00:00.000Z",
          evidence_ended_at: "2026-07-15T02:00:00.000Z",
          raw_new_listing_count: 12,
          cleaned_new_listing_count: 12,
          relevant_new_listing_count: 8,
          irrelevant_new_listing_count: 3,
          uncertain_new_listing_count: 1,
          pending_cleaning_count: 0,
        }] as Row[] };
        return { rows: [{
          day: "2026-07-15",
          source_id: "surugaya",
          quality_grade: "A",
          interpretable: true,
          warmup: false,
          expected_source_count: 1,
          successful_source_count: 1,
          failed_source_count: 0,
          stale_source_count: 0,
          coverage_rate: 1,
          latest_state: "healthy",
          visible_count: 1,
          raw_new_count: 12,
          cleaned_new_count: 12,
          relevant_new_count: 8,
          irrelevant_new_count: 3,
          uncertain_new_count: 1,
          left_visible_window: 0,
          run_count: 1,
          relevant_available_count: 7,
          relevant_sold_out_count: 1,
          relevant_priced_count: 8,
          relevant_min_price: 1_200,
          relevant_median_price: 3_950,
          relevant_average_price: 4_100,
          relevant_max_price: 8_800,
          category_counts: { "亚克力制品": 5, "布偶／玩偶": 3 },
          condition_counts: { used: 6, new: 2 },
          official_status_counts: { official: 7, unknown: 1 },
          confidence_counts: { high: 10, medium: 2 },
        }] as Row[] };
      },
    };

    const evidence = await readMarketAnalysisEvidence(client, {
      days: 30,
      subscriptionKey,
      cleaningProvider: "google-ai-studio",
      cleaningModel: "gemini-3.5-flash-lite",
      cleaningPromptVersion: "listing-semantics-v9",
    });
    expect(evidence).toMatchObject({
      subscriptionKey,
      subscriptionName: "千反田",
      scopeVersionId: "market-scope:test-v1",
      scopeVersion: 1,
      sourceId: null,
      coverage: {
        rawNewListingCount: 12,
        cleanedNewListingCount: 12,
        relevantNewListingCount: 8,
        pendingCleaningCount: 0,
        dailyFactCount: 1,
        truncated: false,
      },
      dailyBySource: [{
        metricRef: "2026-07-15:surugaya",
        qualityGrade: "A",
        interpretable: true,
        relevantMedianPrice: 3_950,
        categoryCounts: { "亚克力制品": 5, "布偶／玩偶": 3 },
      }],
    });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("SELECT id,version FROM radar_analytics.market_scope_versions");
    expect(statements[1]?.sql).not.toContain("listing_payload");
    expect(statements[1]?.sql).not.toContain("description_excerpt");
    expect(statements[1]?.sql).toContain("marketEventKind'='new'");
    expect(statements[1]?.sql).toContain("ai.created_at ASC");
    expect(statements.every(({ values }) => (
      values?.[0] === 30
      && values?.[1] === subscriptionKey
      && values?.[2] === ""
      && values?.[5] === "listing-semantics-v9"
    ))).toBe(true);
  });

  it("selects each historical market listing only while its versioned cleaning is missing", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const subscriptionKey = "market:profile-1:千反田";
    const client: AnalyticsQueryClient = {
      async query<Row extends QueryResultRow>(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        return { rows: [{
          first_seen_run_id: "run-1",
          first_seen_at: "2026-07-15T02:00:00.000Z",
          source_id: "surugaya",
          source_item_id: "item-1",
          identity_scope: "surugaya:item-1",
          canonical_url: "https://example.test/item-1",
          title: "千反田える アクリルスタンド",
          description_excerpt: "公式商品",
          image_url: null,
          seller_name: null,
          shop_name: "駿河屋",
          currency: "JPY",
          current_price_jpy: 2_480,
          original_price_jpy: null,
          price_basis: "item",
          item_condition: "used",
          availability: "available",
          source_listed_at: null,
          source_updated_at: null,
          facts: { official: true },
          raw_metadata: { category: "goods" },
        }] as Row[] };
      },
    };

    const candidates = await readMarketCleaningCandidates(client, {
      days: 7,
      subscriptionKey,
      sourceId: "surugaya",
      cleaningProvider: "google-ai-studio",
      cleaningModel: "gemini-3.5-flash-lite",
      cleaningPromptVersion: "listing-semantics-v9",
    });

    expect(candidates).toEqual([{
      firstSeenRunId: "run-1",
      firstSeenAt: "2026-07-15T02:00:00.000Z",
      listing: {
        sourceId: "surugaya",
        sourceItemId: "item-1",
        identityScope: "surugaya:item-1",
        canonicalUrl: "https://example.test/item-1",
        title: "千反田える アクリルスタンド",
        descriptionExcerpt: "公式商品",
        shopName: "駿河屋",
        currency: "JPY",
        currentPrice: 2_480,
        priceBasis: "item",
        condition: "used",
        availability: "available",
        facts: { official: true },
        rawMetadata: { category: "goods" },
      },
    }]);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("NOT EXISTS");
    expect(statements[0]?.sql).toContain("ai.metadata->>'marketSubscriptionKey'=$2");
    expect(statements[0]?.values).toEqual([
      7,
      subscriptionKey,
      "surugaya",
      "google-ai-studio",
      "gemini-3.5-flash-lite",
      "listing-semantics-v9",
    ]);
  });

});
