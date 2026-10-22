/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_SCHEDULER_RPM_BUDGET, LISTING_ENRICHMENT_MODEL } from "@jpgr/ai";
import type { GeminiJob, NormalizedListing } from "@jpgr/core";
import worker from "../../apps/collector/src/index";
import { enqueueMarketGeminiJob, recoverGeminiJobs } from "../../apps/collector/src/gemini-jobs";
import { testDatabase } from "./postgres";

function listing(sourceItemId: string): NormalizedListing {
  return {
    sourceId: "mercari_jp",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl: `https://jp.mercari.com/item/${sourceItemId}`,
    title: `千反田える ${sourceItemId}`,
    currency: "JPY",
    currentPrice: 3_200,
    priceBasis: "listing_price",
    condition: "used",
    availability: "available",
  };
}

describe("Gemini market queue controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("claims overlapping market listings only once across differently shaped jobs", async () => {
    const firstSeenAt = new Date().toISOString();
    const common = {
      subscriptionKey: "market:profile-1:千反田",
      bindingId: "binding-market-1",
      watchRunId: "run-market-1",
      trigger: "analysis_backfill" as const,
      query: "千反田",
      includeTerms: [] as const,
      excludeTerms: [] as const,
    };
    const first = await enqueueMarketGeminiJob(env, {
      ...common,
      scanStartedAt: "2026-07-17T10:00:00.000Z",
      items: ["m-claim-a", "m-claim-b"].map((sourceItemId) => ({
        listing: listing(sourceItemId),
        kind: "new" as const,
        firstSeenRunId: common.watchRunId,
        firstSeenAt,
      })),
    });
    const second = await enqueueMarketGeminiJob(env, {
      ...common,
      watchRunId: "run-market-2",
      scanStartedAt: "2026-07-17T10:01:00.000Z",
      items: ["m-claim-b", "m-claim-c"].map((sourceItemId) => ({
        listing: listing(sourceItemId),
        kind: "new" as const,
        firstSeenRunId: "run-market-2",
        firstSeenAt,
      })),
    });

    expect(first.claimedItems).toBe(2);
    expect(second.claimedItems).toBe(1);
    const jobs = await testDatabase.prepare(
      "SELECT count(*) count,COALESCE(sum(total_items),0) items FROM gemini_jobs WHERE kind='listing_enrichment'",
    ).first<{ count: number; items: number }>();
    expect(jobs).toEqual({ count: 2, items: 3 });
    expect(await testDatabase.prepare(
      "SELECT count(*) count FROM market_listing_cleaning_claims",
    ).first<{ count: number }>()).toEqual({ count: 3 });
  });

  it("migrates queued historical backfills to the current listing model", async () => {
    const firstSeenAt = new Date().toISOString();
    const legacy = await enqueueMarketGeminiJob(env, {
      subscriptionKey: "market:profile-migration:千反田",
      bindingId: "binding-migration",
      watchRunId: "run-migration",
      trigger: "analysis_backfill",
      scanStartedAt: "2026-07-17T10:01:30.000Z",
      query: "千反田",
      includeTerms: [],
      excludeTerms: [],
      items: ["m-migration-a", "m-migration-b"].map((sourceItemId) => ({
        listing: listing(sourceItemId),
        kind: "new" as const,
        firstSeenRunId: "run-migration",
        firstSeenAt,
      })),
    });
    await testDatabase.prepare(
      `UPDATE gemini_jobs SET model='gemini-flash-latest',status='waiting_rate_limit',
         next_attempt_at='2099-01-01T00:00:00.000Z' WHERE id=?`,
    ).bind(legacy.jobId).run();

    expect(await recoverGeminiJobs(env)).toBe(1);

    const retired = await testDatabase.prepare(
      "SELECT status,completed_items,failed_items,last_error FROM gemini_jobs WHERE id=?",
    ).bind(legacy.jobId).first<{
      status: string;
      completed_items: number;
      failed_items: number;
      last_error: string | null;
    }>();
    expect(retired).toMatchObject({ status: "failed", completed_items: 0, failed_items: 2 });
    expect(retired?.last_error).toContain(LISTING_ENRICHMENT_MODEL.model);

    const replacement = await testDatabase.prepare(
      `SELECT id,status,model,total_items,result_json FROM gemini_jobs
       WHERE id<>? ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).bind(legacy.jobId).first<{
      id: string;
      status: string;
      model: string;
      total_items: number;
      result_json: string;
    }>();
    expect(replacement).toMatchObject({
      status: "queued",
      model: LISTING_ENRICHMENT_MODEL.model,
      total_items: 2,
    });
    if (!replacement) throw new Error("replacement job missing");
    expect(JSON.parse(replacement.result_json)).toMatchObject({ states: ["pending", "pending"] });
    expect(await testDatabase.prepare(
      "SELECT count(*) count FROM market_listing_cleaning_claims",
    ).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("migrates terminal historical cron cleaning without erasing its prior error", async () => {
    const firstSeenAt = new Date().toISOString();
    const legacy = await enqueueMarketGeminiJob(env, {
      subscriptionKey: "market:profile-terminal-migration:千反田",
      bindingId: "binding-terminal-migration",
      watchRunId: "run-terminal-migration",
      trigger: "cron",
      scanStartedAt: "2026-07-17T10:01:45.000Z",
      query: "千反田",
      includeTerms: [],
      excludeTerms: [],
      items: [{
        listing: listing("m-terminal-migration"),
        kind: "new",
        firstSeenRunId: "run-terminal-migration",
        firstSeenAt,
      }],
    });
    await testDatabase.prepare(
      `UPDATE gemini_jobs SET model='gemini-flash-latest',status='failed',failed_items=1,
         result_json=?,last_error='legacy quota failure',completed_at=? WHERE id=?`,
    ).bind(
      JSON.stringify({ items: [null], states: ["failed"], parseAttempts: [0] }),
      firstSeenAt,
      legacy.jobId,
    ).run();

    expect(await recoverGeminiJobs(env)).toBe(1);

    const retired = await testDatabase.prepare(
      "SELECT status,last_error FROM gemini_jobs WHERE id=?",
    ).bind(legacy.jobId).first<{ status: string; last_error: string | null }>();
    expect(retired?.status).toBe("failed");
    expect(retired?.last_error).toContain(LISTING_ENRICHMENT_MODEL.model);
    expect(retired?.last_error).toContain("legacy quota failure");
    expect(await testDatabase.prepare(
      "SELECT count(*) count FROM gemini_jobs WHERE id<>? AND model=? AND status='queued'",
    ).bind(legacy.jobId, LISTING_ENRICHMENT_MODEL.model).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await testDatabase.prepare(
      "SELECT count(*) count FROM market_listing_cleaning_claims",
    ).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("retires a legacy duplicate before it can call the provider", async () => {
    const firstSeenAt = new Date().toISOString();
    const owner = await enqueueMarketGeminiJob(env, {
      subscriptionKey: "market:profile-legacy:千反田",
      bindingId: "binding-legacy",
      watchRunId: "run-legacy",
      trigger: "analysis_backfill",
      scanStartedAt: "2026-07-17T10:02:00.000Z",
      query: "千反田",
      includeTerms: [],
      excludeTerms: [],
      items: [{
        listing: listing("m-legacy-duplicate"),
        kind: "new",
        firstSeenRunId: "run-legacy",
        firstSeenAt,
      }],
    });
    const duplicateJobId = crypto.randomUUID();
    await testDatabase.prepare(
      `INSERT INTO gemini_jobs(
         id,kind,status,dedupe_key,model,prompt_version,payload_json,result_json,
         total_items,completed_items,failed_items,binding_id,watch_run_id,trigger_type,
         scan_started_at,created_at,updated_at
       ) SELECT ?,kind,'queued',?,model,prompt_version,payload_json,result_json,
                total_items,0,0,binding_id,watch_run_id,trigger_type,
                scan_started_at,created_at,updated_at
         FROM gemini_jobs WHERE id=?`,
    ).bind(duplicateJobId, `legacy-duplicate-${duplicateJobId}`, owner.jobId).run();
    const upstream = vi.fn(async () => Response.json({ candidates: [] }));
    vi.stubGlobal("fetch", upstream);
    const batch = createMessageBatch<GeminiJob>("jp-goods-radar-gemini", [{
      id: "gemini-legacy-duplicate",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "gemini_job", jobId: duplicateJobId, queuedAt: new Date().toISOString() },
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, { ...env, GOOGLE_AI_API_KEY: "test-google-key" } as Env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["gemini-legacy-duplicate"]);
    expect(upstream).not.toHaveBeenCalled();
    const duplicate = await testDatabase.prepare(
      "SELECT status,last_error FROM gemini_jobs WHERE id=?",
    ).bind(duplicateJobId).first<{ status: string; last_error: string | null }>();
    expect(duplicate?.status).toBe("failed");
    expect(duplicate?.last_error).toContain("其他清洗任务接管");
    expect(await testDatabase.prepare(
      "SELECT job_id,status FROM market_listing_cleaning_claims",
    ).first<{ job_id: string; status: string }>()).toEqual({ job_id: owner.jobId, status: "active" });
  });

  it("caps listing provider batches so large structured responses finish within the lease", async () => {
    const creation = await worker.fetch(new Request("https://collector.test/internal/ai/jobs/listing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "千反田",
        items: Array.from({ length: 11 }, (_, index) => listing(`m-batch-cap-${index}`)),
      }),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(creation.status).toBe(202);
    const { jobId } = await creation.json<{ jobId: string }>();
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<{ text: string }> }>;
      };
      const prompt = request.contents[0]?.parts[0]?.text ?? "";
      expect(prompt).toContain('"maxItems":10');
      expect(prompt).not.toContain("m-batch-cap-10");
      const itemCount = 10;
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({
              items: Array.from({ length: itemCount }, (_, index) => ({
                index,
                relevance: "relevant",
                relevanceReason: null,
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
                includedItems: [],
                editionOrModel: null,
                extraInfo: {},
                evidence: [],
                confidence: "low",
              })),
            }) }],
          },
        }],
      });
    });
    vi.stubGlobal("fetch", upstream);
    const batch = createMessageBatch<GeminiJob>("jp-goods-radar-gemini", [{
      id: "gemini-batch-cap",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "gemini_job", jobId, queuedAt: new Date().toISOString() },
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, { ...env, GOOGLE_AI_API_KEY: "test-google-key" } as Env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["gemini-batch-cap"]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testDatabase.prepare(
      "SELECT status,completed_items,total_items FROM gemini_jobs WHERE id=?",
    ).bind(jobId).first()).toMatchObject({ status: "queued", completed_items: 10, total_items: 11 });
  });

  it("waits before fetch when the shared rolling-minute request budget is full", async () => {
    const creation = await worker.fetch(new Request("https://collector.test/internal/ai/jobs/listing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "千反田", items: [listing("m-rpm-limit")] }),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(creation.status).toBe(202);
    const { jobId } = await creation.json<{ jobId: string }>();
    const reservedAt = new Date().toISOString();
    await testDatabase.batch(Array.from({ length: GEMINI_SCHEDULER_RPM_BUDGET }, (_, index) => (
      testDatabase.prepare(
        "INSERT INTO gemini_request_reservations(id,job_id,reserved_at) VALUES(?,?,?)",
      ).bind(`request-${index}`, jobId, reservedAt)
    )));
    const upstream = vi.fn(async () => Response.json({ candidates: [] }));
    vi.stubGlobal("fetch", upstream);
    const batch = createMessageBatch<GeminiJob>("jp-goods-radar-gemini", [{
      id: "gemini-rpm-message",
      timestamp: new Date(),
      attempts: 1,
      body: { type: "gemini_job", jobId, queuedAt: new Date().toISOString() },
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, { ...env, GOOGLE_AI_API_KEY: "test-google-key" } as Env);
    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["gemini-rpm-message"]);
    expect(upstream).not.toHaveBeenCalled();
    const stored = await testDatabase.prepare(
      "SELECT status,next_attempt_at,last_error FROM gemini_jobs WHERE id=?",
    ).bind(jobId).first<{ status: string; next_attempt_at: string | null; last_error: string | null }>();
    expect(stored?.status).toBe("waiting_rate_limit");
    expect(stored?.next_attempt_at).not.toBeNull();
    expect(stored?.last_error).toContain("每分钟请求窗口");
  });

  it("shares one provider cooldown after a 429 instead of sending every queued job", async () => {
    const createJob = async (sourceItemId: string): Promise<string> => {
      const response = await worker.fetch(new Request("https://collector.test/internal/ai/jobs/listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "千反田", items: [listing(sourceItemId)] }),
      }) as Parameters<typeof worker.fetch>[0], env);
      return (await response.json<{ jobId: string }>()).jobId;
    };
    const firstJobId = await createJob("m-cooldown-a");
    const secondJobId = await createJob("m-cooldown-b");
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Free tier requests per minute exceeded" },
    }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }));
    vi.stubGlobal("fetch", upstream);
    const process = async (jobId: string, messageId: string) => {
      const batch = createMessageBatch<GeminiJob>("jp-goods-radar-gemini", [{
        id: messageId,
        timestamp: new Date(),
        attempts: 1,
        body: { type: "gemini_job", jobId, queuedAt: new Date().toISOString() },
      }]);
      const context = createExecutionContext();
      await worker.queue(batch, { ...env, GOOGLE_AI_API_KEY: "test-google-key" } as Env);
      expect((await getQueueResult(batch, context)).explicitAcks).toEqual([messageId]);
    };

    await process(firstJobId, "gemini-cooldown-first");
    await process(secondJobId, "gemini-cooldown-second");

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testDatabase.prepare(
      "SELECT upstream_status FROM gemini_provider_cooldowns WHERE provider='google-ai-studio'",
    ).first<{ upstream_status: number }>()).toEqual({ upstream_status: 429 });
    const second = await testDatabase.prepare(
      "SELECT status,last_error FROM gemini_jobs WHERE id=?",
    ).bind(secondJobId).first<{ status: string; last_error: string | null }>();
    expect(second?.status).toBe("waiting_rate_limit");
    expect(second?.last_error).toContain("429 冷却窗口");
  });
});
