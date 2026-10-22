/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeminiJob, MonitorJob } from "@jpgr/core";
import worker from "../../apps/collector/src/index";
import {
  backfillExactWatchProductIdentityProjections,
  enqueueKeywordGeminiJob,
  enqueueProductSearchGeminiJob,
} from "../../apps/collector/src/gemini-jobs";
import { exactProductIdentityDecision } from "../../apps/collector/src/product-identity";
import { testDatabase } from "./postgres";

function searchHtml(items: unknown[], pagination?: { totalAvailable: number; totalReturned: number; offset: number }): string {
  const nextData = {
    props: { initialState: { searchState: { search: { result: {
      items,
      totalResultsAvailable: pagination?.totalAvailable ?? items.length,
      totalResultsReturned: pagination?.totalReturned ?? items.length,
      offset: pagination?.offset ?? 0,
    } } } } },
  };
  return `<!doctype html><html lang="ja"><head><title>Yahoo Fleamarket fixture</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script><!--${"fixture-padding".repeat(180)}--></body></html>`;
}

function itemHtml(item: unknown): string {
  const nextData = { props: { initialState: { itemsState: { items: { item } } } } };
  return `<!doctype html><html lang="ja"><head><title>Yahoo Fleamarket item</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script><!--${"fixture-padding".repeat(180)}--></body></html>`;
}

function upstreamItem(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title,
    price: 7_200,
    itemStatus: "OPEN",
    condition: { key: "good", name: "目立った傷や汚れなし" },
    ...overrides,
  };
}

describe("exact-product search integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 模型的自评 confidence 不再单独构成证据。说「我很有把握」但指不出原文的，
  // 和没说话是一回事（计划 §1.3：用模型 high confidence 代替证据是明令禁止的捷径）。
  it("requires cited evidence, not model self-confidence, before it settles anything", () => {
    const optimisticAi = {
      relevance: "relevant",
      confidence: "high",
      includedItems: ["目标商品"],
      missingParts: [],
      evidence: [],
    };
    for (const relation of ["related", "uncertain", "probable_exact"] as const) {
      const decision = exactProductIdentityDecision({ relation, output: optimisticAi });
      expect(decision.decision).toBe("uncertain");
      expect(decision.reasonCode).toBe("identity_evidence_missing");
    }

    // 指得出原文就能定案，并且早期的 related / uncertain 不再阻止提升。
    const citedAi = { ...optimisticAi, evidence: [{ field: "description", quote: "Fes. Fine A3プリモアート" }] };
    for (const relation of ["related", "uncertain", "probable_exact"] as const) {
      expect(exactProductIdentityDecision({ relation, output: citedAi }).decision).toBe("confirmed");
    }
  });

  // 2026-09-05 那条真品（卖家把作品名缩写成「冴えカノ♭」）就死在这一行：
  // related 且模型没表态时被无条件硬拒。模型不肯背书不是反证，是还没判。
  it("never rejects a candidate that nothing has actually disproved", () => {
    const notReviewed = exactProductIdentityDecision({ relation: "related" });
    expect(notReviewed.decision).toBe("uncertain");
    expect(notReviewed.processingStatus).toBe("pending_action");

    // 模型说「不是」但没给引用，同样不能定案。
    const unsupportedRejection = exactProductIdentityDecision({
      relation: "probable_exact",
      output: { relevance: "irrelevant", confidence: "high", evidence: [] },
    });
    expect(unsupportedRejection.decision).toBe("uncertain");

    // 程序能证明的冲突仍然直接定案，不需要等模型翻案。
    const conflicted = exactProductIdentityDecision({
      relation: "probable_exact",
      match: { conflicts: ["型号：N0065 ≠ N0066"] },
    });
    expect(conflicted.decision).toBe("rejected");
    expect(conflicted.reasonCode).toBe("deterministic_conflict");
  });

  // 模型输出坏掉是**技术失败**，不是一条业务结论。
  it("records an invalid model answer as a processing failure, not as an exclusion", () => {
    const broken = exactProductIdentityDecision({ relation: "probable_exact", aiItemStatus: "contract_error" });
    expect(broken.decision).toBe("uncertain");
    expect(broken.processingStatus).toBe("failed");
    expect(broken.reasonCode).toBe("model_output_invalid");
  });

  it("fans out bounded queries, ranks the GS Craft item first and persists hit evidence", async () => {
    const target = upstreamItem(
      "z589863828",
      "Re:ゼロから始める異世界生活 ラインハルト ぬいぐるみ リゼロ",
      {
        description: "GSクラフト ラインハルト・ヴァン・アストレア 未開封 全長18cm N0065 JAN 4589955576984",
        brand: { name: "GSクラフト" },
        category: { name: "ぬいぐるみ" },
      },
    );
    const gigo = upstreamItem("z600000001", "GiGO限定 ちょぴぬいぷち ラインハルト ぬいぐるみ");
    const broadItems = Array.from({ length: 29 }, (_, index) => upstreamItem(`z7000000${String(index).padStart(2, "0")}`, `ラインハルト 関連商品 ${index + 1}`));
    broadItems.push(target);
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/item/")) {
        const id = url.pathname.split("/").at(-1)!;
        const item = id === "z589863828" ? target : id === "z600000001" ? gigo : upstreamItem(id, `ラインハルト 関連商品 ${id}`);
        return new Response(itemHtml(item), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const decoded = decodeURIComponent(url.pathname.replace(/^\/search\//, ""));
      const items = decoded === "ラインハルト ぬいぐるみ" ? [gigo, ...broadItems] : [target];
      return new Response(searchHtml(items), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
    ).run();

    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "ラインハルト ぬいぐるみ",
        mode: "exact_product",
        sources: ["yahoo_fleamarket_jp"],
        availabilityMode: "all",
        target: {
          workTitle: "Re:ゼロから始める異世界生活",
          characters: ["ラインハルト", "ラインハルト・ヴァン・アストレア"],
          productType: "ぬいぐるみ",
          manufacturer: "GSクラフト",
          model: "N0065",
          jan: "4589955576984",
          size: "18cm",
          aliases: [],
          excludedTerms: ["GiGO", "ちょぴぬいぷち"],
        },
      }),
    }) as Parameters<typeof worker.fetch>[0], env);

    expect(response.status).toBe(200);
    const body = await response.json<{
      historyId: string;
      plan: { variants: unknown[] };
      groups: Array<{
        listings: Array<{ sourceItemId: string }>;
        candidateEvidence: Record<string, { match: { relation: string; score: number }; hits: unknown[] }>;
      }>;
    }>();
    expect(body.plan.variants.length).toBeLessThanOrEqual(5);
    expect(body.groups[0]?.listings[0]?.sourceItemId).toBe("z589863828");
    expect(body.groups[0]?.candidateEvidence.z589863828?.match.relation).toBe("exact");
    expect(body.groups[0]?.candidateEvidence.z600000001?.match.relation).toBe("variant");
    expect(body.groups[0]?.candidateEvidence.z589863828?.hits.length).toBeGreaterThanOrEqual(1);

    expect(await testDatabase.prepare(
      "SELECT search_mode,deep_search,target_json,plan_json FROM search_history WHERE id=?",
    ).bind(body.historyId).first()).toMatchObject({ search_mode: "exact_product", deep_search: 0 });
    const variants = await testDatabase.prepare("SELECT count(*) count FROM search_query_variants WHERE search_history_id=?").bind(body.historyId).first<{ count: number }>();
    const hits = await testDatabase.prepare("SELECT count(*) count FROM search_candidate_hits WHERE search_history_id=?").bind(body.historyId).first<{ count: number }>();
    const relation = await testDatabase.prepare(
      "SELECT relation,score,matcher_version FROM search_product_relations WHERE search_history_id=? AND source_item_id='z589863828'",
    ).bind(body.historyId).first<{ relation: string; score: number; matcher_version: string }>();
    expect(variants?.count).toBe(body.plan.variants.length);
    expect(hits?.count).toBeGreaterThan(body.groups[0]?.listings.length ?? 0);
    expect(relation).toMatchObject({ relation: "exact", matcher_version: "product-match-v6" });
  });

  it("keeps long Japanese exact-product searches off the broad listing-index path", async () => {
    const target = upstreamItem(
      "z-snow-miku-strap",
      "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      { category: { name: "ストラップ" } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return new Response(url.pathname.startsWith("/item/") ? itemHtml(target) : searchHtml([target]), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }));
    await testDatabase.batch([
      testDatabase.prepare(
        "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
      ),
      testDatabase.prepare(
        `INSERT INTO search_listing_index(
          source_id,source_item_id,title_normalized,search_text,listing_json,first_seen_at,last_seen_at,last_live_verified_at
         ) VALUES('yahoo_fleamarket_jp','legacy-index-row','legacy','legacy','{}',CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text,CURRENT_TIMESTAMP::text)`,
      ),
    ]);

    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
        mode: "exact_product",
        sources: ["yahoo_fleamarket_jp"],
        availabilityMode: "all",
      }),
    }) as Parameters<typeof worker.fetch>[0], env);

    expect(response.status).toBe(200);
    expect(await response.json<{ groups: Array<{ status: string; listings: Array<{ sourceItemId: string }> }> }>()).toMatchObject({
      groups: [{ status: "success", listings: [{ sourceItemId: "z-snow-miku-strap" }] }],
    });
  });

  it("continues a browser-started search in a durable per-source Workflow", async () => {
    const target = upstreamItem(
      "z589863830",
      "Re:ゼロから始める異世界生活 ふわかわロリータぬいぐるみ レム",
      { category: { name: "ぬいぐるみ" } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return new Response(url.pathname.startsWith("/item/") ? itemHtml(target) : searchHtml([target]), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }));
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
    ).run();
    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "Re:ゼロから始める異世界生活 ふわかわロリータぬいぐるみ レム",
        mode: "exact_product",
        execution: "workflow",
        sources: ["yahoo_fleamarket_jp"],
        availabilityMode: "all",
      }),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(response.status).toBe(202);
    const started = await response.json<{ jobId: string; status: string }>();
    const introspector = await introspectWorkflowInstance(env.PRODUCT_SEARCH_WORKFLOW, started.jobId);
    try {
      await introspector.waitForStatus("complete");
      expect(await introspector.getOutput()).toMatchObject({ taskId: started.jobId, historyId: started.jobId });
    } finally {
      await introspector.dispose();
    }

    expect(await testDatabase.prepare(
      `SELECT status,history_id,session_id,journal_ready_at,last_error,ai_job_id,ai_manifest_json,ai_error
       FROM product_search_workflow_tasks WHERE id=?`,
    ).bind(started.jobId).first()).toMatchObject({
      status: "completed",
      history_id: started.jobId,
      session_id: started.jobId,
      journal_ready_at: expect.any(String),
      last_error: null,
      ai_job_id: expect.any(String),
      ai_error: null,
    });
    const aiTask = await testDatabase.prepare(
      `SELECT ai_job_id,ai_manifest_json FROM product_search_workflow_tasks WHERE id=?`,
    ).bind(started.jobId).first<{ ai_job_id: string; ai_manifest_json: string }>();
    expect(JSON.parse(aiTask!.ai_manifest_json)).toMatchObject({
      version: "product-search-ai-review-v2",
      totalListings: 1,
      reviewCandidates: 1,
      queuedCandidates: 1,
      candidateKeys: ["yahoo_fleamarket_jp:z589863830"],
      settlementStatus: "failed",
      settledStates: ["failed"],
    });
    expect(await testDatabase.prepare(
      `SELECT kind,status,prompt_version,total_items FROM gemini_jobs WHERE id=?`,
    ).bind(aiTask!.ai_job_id).first()).toMatchObject({
      kind: "listing_enrichment",
      status: "failed",
      prompt_version: "product-search-relevance:v2",
      total_items: 1,
    });
    expect(await testDatabase.prepare(
      `SELECT source_id,group_json::jsonb ->> 'status' status
       FROM product_search_workflow_results WHERE task_id=?`,
    ).bind(started.jobId).first()).toMatchObject({ source_id: "yahoo_fleamarket_jp", status: "success" });
    expect((await testDatabase.prepare(
      `SELECT count(*) count FROM source_response_captures WHERE run_id=? AND source_id='yahoo_fleamarket_jp'`,
    ).bind(started.jobId).first<{ count: number }>())?.count).toBeGreaterThan(0);
    expect(await testDatabase.prepare(
      `SELECT search_mode,target_json,plan_json FROM search_history WHERE id=?`,
    ).bind(started.jobId).first()).toMatchObject({ search_mode: "exact_product" });
  });

  it("runs an exact-product radar through the persistent AI cleaning queue", async () => {
    const target = upstreamItem(
      "z589863828",
      "Re:ゼロから始める異世界生活 ラインハルト ぬいぐるみ リゼロ",
      {
        description: "GSクラフト ラインハルト・ヴァン・アストレア 未開封 全長18cm N0065",
        brand: { name: "GSクラフト" },
        category: { name: "ぬいぐるみ" },
      },
    );
    const ambiguousShorthand = upstreamItem(
      "z589863829",
      "リゼロ ラインハルト ぬいぐるみ",
      { category: { name: "ぬいぐるみ" } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "generativelanguage.googleapis.com") {
        return Response.json({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify({
                items: [0, 1].map((index) => ({
                  index,
                  relevance: index === 1 ? "relevant" : "irrelevant",
                  relevanceReason: index === 1
                    ? "测试中模拟 AI 把含多个商品的候选误判为同款"
                    : "测试中让 AI 拒绝确定性同款",
                  translatedTitle: null,
                  summary: null,
                  normalizedCategory: null,
                  marketCategory: "其他",
                  productType: null,
                  workTitle: null,
                  series: null,
                  characters: [],
                  officialStatus: "unknown",
                  normalizedCondition: "unknown",
                  conditionNotes: [],
                  defects: [],
                  missingParts: [],
                  includedItems: index === 1 ? ["目标ぬいぐるみ", "別商品"] : [],
                  editionOrModel: null,
                  extraInfo: {},
                  evidence: [],
                  confidence: index === 1 ? "high" : "low",
                })),
              }) }],
            },
          }],
        });
      }
      const item = url.pathname.endsWith("829") ? ambiguousShorthand : target;
      return new Response(url.pathname.startsWith("/item/") ? itemHtml(item) : searchHtml([target, ambiguousShorthand]), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }));
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
    ).run();
    const now = new Date().toISOString();
    await testDatabase.batch([
      testDatabase.prepare("INSERT INTO watch_profiles(id,name,dossier_kind,offer_tracking_policy,enabled,created_at,updated_at) VALUES('profile-exact','同款 · ラインハルト','exact_product','all_confirmed_offers',1,?,?)").bind(now, now),
      testDatabase.prepare(
        `INSERT INTO watch_bindings(
          id,watch_profile_id,source_id,kind,query,interval_minutes,next_run_at,source_config_json,
          monitoring_purpose,schedule_interval_minutes,notify_new_listing,created_at,updated_at
         ) VALUES('binding-exact','profile-exact','yahoo_fleamarket_jp','keyword','Re:ゼロから始める異世界生活 GSクラフト ぬいぐるみ ラインハルト',60,?,?,
          'keyword_new_listing',60,1,?,?)`,
      ).bind(now, JSON.stringify({
        searchMode: "exact_product",
        deepSearch: false,
        productTarget: {
          workTitle: "Re:ゼロから始める異世界生活",
          characters: ["ラインハルト"],
          productType: "ぬいぐるみ",
          manufacturer: "GSクラフト",
          model: "N0065",
          size: "18cm",
          aliases: [],
          excludedTerms: ["GiGO"],
        },
      }), now, now),
    ]);
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "exact-watch-message",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "run_binding", bindingId: "binding-exact", trigger: "manual", queuedAt: now },
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["exact-watch-message"]);
    const watchRun = await testDatabase.prepare(
      "SELECT id,status,result_count,error_code FROM watch_runs WHERE watch_binding_id='binding-exact'",
    ).first<{ id: string; status: string; result_count: number; error_code: string | null }>();
    expect(watchRun).toMatchObject({ status: "success", result_count: 2, error_code: null });
    expect(await testDatabase.prepare(
      "SELECT source_item_id,title FROM listings WHERE source_id='yahoo_fleamarket_jp'",
    ).first()).toBeNull();
    const queuedJob = await testDatabase.prepare(
      "SELECT id,kind,status,prompt_version,total_items,binding_id,payload_json FROM gemini_jobs WHERE binding_id='binding-exact'",
    ).first<{ id: string; kind: string; status: string; prompt_version: string; total_items: number; binding_id: string; payload_json: string }>();
    expect(queuedJob).toMatchObject({
      kind: "keyword_enrichment",
      status: "queued",
      prompt_version: "product-search-relevance:v2",
      total_items: 2,
      binding_id: "binding-exact",
    });
    expect(JSON.parse(queuedJob!.payload_json)).toMatchObject({
      relevanceContext: { targetLabel: expect.stringContaining("具体同款") },
      keyword: {
        searchMode: "exact_product",
        matcherVersion: "product-match-v6",
        matchRelations: expect.arrayContaining(["exact"]),
      },
    });
    expect(await testDatabase.prepare(
      "SELECT baseline_completed FROM watch_bindings WHERE id='binding-exact'",
    ).first()).toEqual({ baseline_completed: 0 });

    const geminiBatch = createMessageBatch<GeminiJob>("jp-goods-radar-gemini", [{
      id: "exact-watch-gemini-message",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "gemini_job", jobId: queuedJob!.id, queuedAt: new Date().toISOString() },
    }]);
    const geminiContext = createExecutionContext();
    await worker.queue(geminiBatch, { ...env, GOOGLE_AI_API_KEY: "test-google-key" } as Env);
    expect((await getQueueResult(geminiBatch, geminiContext)).explicitAcks).toEqual(["exact-watch-gemini-message"]);
    expect(await testDatabase.prepare(
      "SELECT status FROM gemini_jobs WHERE id=?",
    ).bind(queuedJob!.id).first()).toEqual({ status: "completed" });
    expect(await testDatabase.prepare(
      "SELECT baseline_completed FROM watch_bindings WHERE id='binding-exact'",
    ).first()).toEqual({ baseline_completed: 1 });
    expect(await testDatabase.prepare(
      `SELECT l.source_item_id,m.acceptance_reason,m.matcher_version,m.semantic_prompt_version,
              m.tracking_status,m.tracking_interval_minutes,m.tracking_baseline_completed
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id='binding-exact'`,
    ).all()).toMatchObject({
      results: [{
        source_item_id: "z589863828",
        acceptance_reason: "deterministic_exact",
        matcher_version: "product-match-v6",
        semantic_prompt_version: null,
        tracking_status: "active",
        tracking_interval_minutes: 60,
        tracking_baseline_completed: 1,
      }],
    });
    const identityProjection = await testDatabase.prepare(
      `SELECT workflow_task_id,search_history_id,membership_count,confirmed_count,
              rejected_count,uncertain_count,projection_json,analytics_outbox_id
       FROM product_identity_projection_versions WHERE workflow_task_id=?`,
    ).bind(`watch:${queuedJob!.id}`).first<{
      workflow_task_id: string;
      search_history_id: string;
      membership_count: number;
      confirmed_count: number;
      rejected_count: number;
      uncertain_count: number;
      projection_json: string;
      analytics_outbox_id: string;
    }>();
    expect(identityProjection).toMatchObject({
      workflow_task_id: `watch:${queuedJob!.id}`,
      search_history_id: watchRun!.id,
      membership_count: 2,
      confirmed_count: 1,
      rejected_count: 0,
      uncertain_count: 1,
    });
    expect(JSON.parse(identityProjection!.projection_json)).toMatchObject({
      projectedAt: expect.any(String),
      memberships: expect.arrayContaining([
        expect.objectContaining({
          sourceId: "yahoo_fleamarket_jp",
          sourceItemId: "z589863828",
          relation: "exact",
          decision: "confirmed",
          decisionSource: "workflow_matcher",
        }),
      ]),
    });
    const projectedVariantId = JSON.parse(identityProjection!.projection_json).productVariant.id as string;
    expect(await testDatabase.prepare(
      "SELECT product_variant_id,product_identity_search_history_id FROM watch_profiles WHERE id='profile-exact'",
    ).first()).toEqual({
      product_variant_id: projectedVariantId,
      product_identity_search_history_id: watchRun!.id,
    });
    expect(await testDatabase.prepare(
      "SELECT kind,reference_id,status FROM analytics_outbox WHERE id=?",
    ).bind(identityProjection!.analytics_outbox_id).first()).toMatchObject({
      kind: "product_identity",
      status: "queued",
    });
    await testDatabase.batch([
      testDatabase.prepare(
        "DELETE FROM product_identity_projection_versions WHERE workflow_task_id=?",
      ).bind(`watch:${queuedJob!.id}`),
      testDatabase.prepare(
        "DELETE FROM analytics_outbox WHERE id=?",
      ).bind(identityProjection!.analytics_outbox_id),
    ]);
    expect(await backfillExactWatchProductIdentityProjections(env, 10)).toEqual({
      scanned: 1,
      materialized: 1,
    });
    expect(await testDatabase.prepare(
      "SELECT confirmed_count,rejected_count,uncertain_count FROM product_identity_projection_versions WHERE workflow_task_id=?",
    ).bind(`watch:${queuedJob!.id}`).first()).toEqual({
      confirmed_count: 1,
      rejected_count: 0,
      uncertain_count: 1,
    });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM events").first()).toEqual({ count: 0 });
  });

  it("does not reject a rotated exact-product evidence corpus as keyword-window churn", async () => {
    const candidates = Array.from({ length: 30 }, (_, index) => upstreamItem(
      `z-exact-rotation-${String(index).padStart(2, "0")}`,
      `Re:ゼロから始める異世界生活 ラインハルト GSクラフト N0065 18cm ぬいぐるみ 候補${index + 1}`,
      {
        brand: { name: "GSクラフト" },
        category: { name: "ぬいぐるみ" },
      },
    ));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/item/")) {
        const id = url.pathname.split("/").at(-1)!;
        return new Response(itemHtml(candidates.find((item) => item.id === id) ?? candidates[0]), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(searchHtml(candidates), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }));
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
    ).run();
    const now = new Date().toISOString();
    const previous = new Date(Date.now() - 60_000).toISOString();
    await testDatabase.batch([
      testDatabase.prepare(
        "INSERT INTO watch_profiles(id,name,dossier_kind,enabled,created_at,updated_at) VALUES('profile-exact-rotation','同款 · ラインハルト证据换页','exact_product',1,?,?)",
      ).bind(now, now),
      testDatabase.prepare(
        `INSERT INTO watch_bindings(
          id,watch_profile_id,source_id,kind,query,interval_minutes,next_run_at,source_config_json,
          monitoring_purpose,schedule_interval_minutes,notify_new_listing,created_at,updated_at
         ) VALUES('binding-exact-rotation','profile-exact-rotation','yahoo_fleamarket_jp','keyword',
          'Re:ゼロから始める異世界生活 GSクラフト N0065 ラインハルト ぬいぐるみ',60,?,?,
          'keyword_new_listing',60,1,?,?)`,
      ).bind(now, JSON.stringify({
        searchMode: "exact_product",
        deepSearch: false,
        productTarget: {
          workTitle: "Re:ゼロから始める異世界生活",
          characters: ["ラインハルト"],
          productType: "ぬいぐるみ",
          manufacturer: "GSクラフト",
          model: "N0065",
          size: "18cm",
          aliases: [],
          excludedTerms: [],
        },
      }), now, now),
      testDatabase.prepare(
        `INSERT INTO watch_runs(
          id,watch_binding_id,trigger_type,status,started_at,finished_at,result_count,coverage
         ) VALUES('exact-rotation-previous','binding-exact-rotation','manual','success',?,?,30,'best_effort')`,
      ).bind(previous, previous),
    ]);
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "exact-rotation-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "binding-exact-rotation",
        trigger: "manual",
        queuedAt: now,
      },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["exact-rotation-message"]);
    expect(await testDatabase.prepare(
      `SELECT status,result_count,error_code FROM watch_runs
       WHERE watch_binding_id='binding-exact-rotation'
       ORDER BY started_at DESC LIMIT 1`,
    ).first()).toEqual({ status: "success", result_count: 30, error_code: null });
    expect(await testDatabase.prepare(
      "SELECT status,total_items FROM gemini_jobs WHERE binding_id='binding-exact-rotation'",
    ).first()).toEqual({ status: "queued", total_items: 30 });
  });

  it("queues only normalized bounded facts for product-search AI review", async () => {
    const result = await enqueueProductSearchGeminiJob(env, {
      query: "ぬいぐるみ エミリア 「Re：ゼロ」 F：NEX限定",
      target: {
        canonicalName: "ぬいぐるみ エミリア 「Re：ゼロ」 F：NEX限定",
        workTitle: "Re:ゼロ",
        characters: ["エミリア"],
        productType: "ぬいぐるみ",
        aliases: [],
        excludedTerms: [],
      },
      listings: [{
        sourceId: "yahoo_fleamarket_jp",
        sourceItemId: "z-ai-bounded",
        identityScope: "listing",
        canonicalUrl: "https://paypayfleamarket.yahoo.co.jp/item/z-ai-bounded",
        title: "F:NEX限定 Re:ゼロ エミリア ぬいぐるみ",
        currency: "JPY",
        currentPrice: 9_800,
        priceBasis: "listing_price",
        condition: "used",
        availability: "available",
        facts: {
          imageUrls: Array.from({ length: 46 }, (_, index) => `https://example.com/image-${index}.jpg`),
        },
        rawMetadata: { completeSourcePayload: "must-not-reach-gemini" },
      }],
    });

    expect(result).toMatchObject({
      jobId: expect.any(String),
      candidateKeys: ["yahoo_fleamarket_jp:z-ai-bounded"],
      skippedItems: 0,
    });
    const row = await testDatabase.prepare("SELECT payload_json FROM gemini_jobs WHERE id=?")
      .bind(result.jobId).first<{ payload_json: string }>();
    const payload = JSON.parse(row!.payload_json) as {
      items: Array<{ facts: { imageUrls: string[] }; rawMetadata?: unknown }>;
    };
    expect(payload.items[0]?.facts.imageUrls).toHaveLength(30);
    expect(payload.items[0]?.rawMetadata).toBeUndefined();
  });

  it("bounds keyword derivatives and skips an invalid derivative without failing collection", async () => {
    const now = new Date().toISOString();
    const baseListing = {
      sourceId: "yahoo_fleamarket_jp" as const,
      sourceItemId: "z-keyword-bounded",
      identityScope: "listing" as const,
      canonicalUrl: "https://paypayfleamarket.yahoo.co.jp/item/z-keyword-bounded",
      title: "F:NEX限定 Re:ゼロ エミリア ぬいぐるみ",
      currency: "JPY",
      currentPrice: 9_800,
      priceBasis: "listing_price" as const,
      condition: "used" as const,
      availability: "available" as const,
      facts: {
        imageUrls: Array.from({ length: 46 }, (_, index) => `https://example.com/keyword-image-${index}.jpg`),
      },
      rawMetadata: { completeSourcePayload: "must-stay-in-capture-journal" },
    };
    const result = await enqueueKeywordGeminiJob(env, {
      bindingId: "binding-keyword-bounded",
      watchRunId: "run-keyword-bounded",
      trigger: "manual",
      scanStartedAt: now,
      baselineCompleted: false,
      query: "エミリア ぬいぐるみ",
      listings: [baseListing, { ...baseListing, sourceItemId: "z-invalid", title: "x".repeat(1_001) }],
      includeTerms: [],
      excludeTerms: [],
      searchMode: "keyword",
    });

    expect(result).toEqual({ jobId: expect.any(String), queuedItems: 1, skippedItems: 1 });
    const row = await testDatabase.prepare("SELECT payload_json FROM gemini_jobs WHERE id=?")
      .bind(result.jobId).first<{ payload_json: string }>();
    const payload = JSON.parse(row!.payload_json) as {
      items: Array<{ facts: { imageUrls: string[] }; rawMetadata?: unknown }>;
      keyword: { listings: Array<{ facts: { imageUrls: string[] }; rawMetadata?: unknown }> };
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.facts.imageUrls).toHaveLength(30);
    expect(payload.items[0]?.rawMetadata).toBeUndefined();
    expect(payload.keyword.listings).toHaveLength(1);
    expect(payload.keyword.listings[0]?.facts.imageUrls).toHaveLength(30);
    expect(payload.keyword.listings[0]?.rawMetadata).toBeUndefined();
  });

  it("keeps source pagination inside one immutable search journal session", async () => {
    const first = upstreamItem("z589863828", "ラインハルト GSクラフト N0065 18cm ぬいぐるみ");
    const second = upstreamItem("z589863829", "ラインハルト GSクラフト N0065 18cm ぬいぐるみ 未開封");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/item/")) {
        return new Response(itemHtml(url.pathname.endsWith("829") ? second : first), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const page = Number(url.searchParams.get("page") ?? 1);
      return new Response(searchHtml(page === 2 ? [second] : [first], {
        totalAvailable: 2,
        totalReturned: 1,
        offset: page === 2 ? 1 : 0,
      }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }));
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='yahoo_fleamarket_jp'",
    ).run();
    const requestBody = {
      query: "ラインハルト ぬいぐるみ",
      mode: "exact_product",
      sources: ["yahoo_fleamarket_jp"],
      availabilityMode: "all",
      target: {
        characters: ["ラインハルト"],
        productType: "ぬいぐるみ",
        manufacturer: "GSクラフト",
        model: "N0065",
        size: "18cm",
        aliases: [],
        excludedTerms: [],
      },
    };
    const firstResponse = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json<{ historyId: string; sessionId: string; groups: Array<{ nextCursor?: string }> }>();
    expect(firstBody.sessionId).toBe(firstBody.historyId);
    expect(firstBody.groups[0]?.nextCursor).toBe("2");

    const nextResponse = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody,
        searchSessionId: firstBody.sessionId,
        sourcePageTokens: { yahoo_fleamarket_jp: "2" },
      }),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(nextResponse.status).toBe(200);
    const nextBody = await nextResponse.json<{ historyId: string; sessionId: string }>();
    expect(nextBody.historyId).not.toBe(firstBody.historyId);
    expect(nextBody.sessionId).toBe(firstBody.sessionId);

    const root = await testDatabase.prepare(
      "SELECT result_count,page_sequence,parent_history_id,session_id FROM search_history WHERE id=?",
    ).bind(firstBody.sessionId).first<{
      result_count: number;
      page_sequence: number;
      parent_history_id: string | null;
      session_id: string;
    }>();
    const child = await testDatabase.prepare(
      "SELECT page_sequence,parent_history_id,session_id FROM search_history WHERE id=?",
    ).bind(nextBody.historyId).first<{
      page_sequence: number;
      parent_history_id: string;
      session_id: string;
    }>();
    expect(root).toMatchObject({ result_count: 2, page_sequence: 1, parent_history_id: null, session_id: firstBody.sessionId });
    expect(child).toMatchObject({ page_sequence: 2, parent_history_id: firstBody.sessionId, session_id: firstBody.sessionId });
    expect((await testDatabase.prepare(
      "SELECT count(*) count FROM search_history WHERE session_id=?",
    ).bind(firstBody.sessionId).first<{ count: number }>())?.count).toBe(2);
  });
});
