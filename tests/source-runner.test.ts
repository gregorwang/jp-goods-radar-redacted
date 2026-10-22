import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceSignatureMessage, type SearchResult } from "../packages/core/src";
import { describe, expect, it, vi } from "vitest";
import { AdaptiveSourceTransport, type PageRenderer } from "../apps/source-runner/src/adaptive-fetch";
import { SignatureReplayGuard, verifyRunnerRequest } from "../apps/source-runner/src/auth";
import { BusinessRepairStore, executeWithBusinessRepair } from "../apps/source-runner/src/business-repair";
import type { RunnerExecutionOutcome } from "../apps/source-runner/src/execution";
import { parseGoldenSuite, runGoldenRegression } from "../apps/source-runner/src/golden-regression";
import { PooledJobQueue } from "../apps/source-runner/src/job-queue";
import { createJobBodySchema, type CreateJobBody } from "../apps/source-runner/src/schemas";
import { isAllowedSourceRunnerUrl } from "../apps/source-runner/src/source-policy";
import { itemWithConfiguredRoute, mercariSourceRunnerMode, sourceRequestRoute } from "../apps/collector/src/source-execution";
import { itemWithSourceRunner, searchWithSourceRunner } from "../apps/collector/src/source-runner-client";
import { rakutenIchibaAdapter } from "../packages/adapters/src/rakuten-ichiba";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signingFixture(scope: string, timestamp: string, body: unknown): Promise<{
  headers: Headers;
  publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(serviceSignatureMessage(scope, timestamp, body)),
  );
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
  return {
    headers: new Headers({
      "X-JPGR-Timestamp": timestamp,
      "X-JPGR-Signature": hex(signature),
    }),
    publicKey,
  };
}

async function privateSigningKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
    .toString("base64url");
}

function searchResult(sourceId: "yahoo_shopping"): SearchResult {
  return {
    sourceId,
    listings: [],
    coverage: "rolling_window",
    warnings: [],
    parserVersion: "test",
    fetchedAt: new Date().toISOString(),
  };
}

describe("Singapore source runner boundary", () => {
  it("accepts a valid signature once and rejects its replay", async () => {
    const now = Date.now();
    const timestamp = String(now);
    const body = { sourceId: "surugaya", operation: "search", request: { query: "千反田える", filters: {} } };
    const fixture = await signingFixture("source-runner.job.create.v1", timestamp, body);
    const guard = new SignatureReplayGuard();

    await expect(verifyRunnerRequest(
      fixture.headers,
      "source-runner.job.create.v1",
      body,
      guard,
      now,
      fixture.publicKey,
    )).resolves.toMatchObject({ ok: true });
    await expect(verifyRunnerRequest(
      fixture.headers,
      "source-runner.job.create.v1",
      body,
      guard,
      now,
      fixture.publicKey,
    )).resolves.toEqual({ ok: false, code: "request_replayed" });
  });

  it("keeps the task schema strict and never accepts an arbitrary URL", () => {
    expect(createJobBodySchema.safeParse({
      sourceId: "mercari_jp",
      operation: "search",
      request: {
        query: "千反田える",
        filters: { page: 1, pageSize: 20 },
        sourceConfig: { historyItemIds: ["m12345678901"] },
      },
    }).success).toBe(true);
    expect(createJobBodySchema.safeParse({
      sourceId: "mercari_jp",
      operation: "item",
      urlOrId: "https://example.com/item/m12345678901",
    }).success).toBe(false);
    expect(createJobBodySchema.safeParse({
      sourceId: "yahoo_shopping",
      operation: "search",
      request: { query: "陶器", filters: { page: 1, pageSize: 20 } },
    }).success).toBe(true);
    expect(createJobBodySchema.safeParse({
      sourceId: "yahoo_fleamarket_jp",
      operation: "item",
      urlOrId: "https://example.com/item/z123456",
    }).success).toBe(false);
    expect(createJobBodySchema.safeParse({
      sourceId: "surugaya",
      operation: "search",
      request: { query: "千反田える", filters: {}, arbitraryUrl: "https://example.com" },
    }).success).toBe(false);
    expect(createJobBodySchema.safeParse({
      sourceId: "rakuten_ichiba",
      operation: "item",
      urlOrId: "gscraft:n0066",
    }).success).toBe(true);
    expect(createJobBodySchema.safeParse({
      sourceId: "rakuten_ichiba",
      operation: "item",
      urlOrId: "https://example.com/gscraft/n0066/",
    }).success).toBe(false);
    expect(isAllowedSourceRunnerUrl(
      "rakuten_ichiba",
      "https://item.rakuten.co.jp/gscraft/n0066/",
    )).toBe(true);
    expect(isAllowedSourceRunnerUrl(
      "rakuten_ichiba",
      "https://item.rakuten.co.jp/gscraft/n0066/extra/",
    )).toBe(false);
    expect(isAllowedSourceRunnerUrl(
      "mercari_jp",
      "https://api.mercari.jp/v2/entities:search",
    )).toBe(true);
    expect(isAllowedSourceRunnerUrl(
      "mercari_jp",
      "https://jp.mercari.com/item/m12345678901",
    )).toBe(false);
  });

  it("allows Mercari DPoP API POSTs without ever launching Playwright", async () => {
    const baseFetch = vi.fn(async (request: Request) => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const rendererFactory = vi.fn<() => Promise<PageRenderer>>();
    const transport = new AdaptiveSourceTransport("mercari_jp", undefined, { baseFetch, rendererFactory });

    const response = await transport.fetch("https://api.mercari.jp/v2/entities:search", {
      method: "POST",
      headers: { "Content-Type": "application/json", DPoP: "bounded-test-proof" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledOnce();
    expect(rendererFactory).not.toHaveBeenCalled();
    expect(transport.captures).toHaveLength(1);
    expect(transport.captures[0]?.requestMethod).toBe("POST");
    await transport.close();
  });

  it("runs every source golden task and fails closed on a regression", async () => {
    const cases = parseGoldenSuite({
      schema: 1,
      sources: {
        mercari_jp: [{
          name: "mercari-smoke",
          task: {
            sourceId: "mercari_jp",
            operation: "search",
            request: { query: "千反田える", filters: {} },
          },
          expect: { minResultCount: 1, parserVersionPrefix: "mercari-" },
        }],
        surugaya: [{
          name: "surugaya-smoke",
          task: {
            sourceId: "surugaya",
            operation: "search",
            request: { query: "千反田える", filters: {} },
          },
          expect: { minResultCount: 1, parserVersionPrefix: "surugaya-" },
        }],
        yahoo_shopping: [{
          name: "shopping-smoke",
          task: {
            sourceId: "yahoo_shopping",
            operation: "search",
            request: { query: "陶器", filters: {} },
          },
          expect: { minResultCount: 1 },
        }],
        yahoo_auctions_jp: [{
          name: "auctions-smoke",
          task: {
            sourceId: "yahoo_auctions_jp",
            operation: "search",
            request: { query: "ポケモンカード", filters: {} },
          },
          expect: { minResultCount: 1 },
        }],
        yahoo_fleamarket_jp: [{
          name: "fleamarket-smoke",
          task: {
            sourceId: "yahoo_fleamarket_jp",
            operation: "search",
            request: { query: "リゼロ", filters: {} },
          },
          expect: { minResultCount: 1 },
        }],
      },
    }, "surugaya");
    const executor = vi.fn(async (): Promise<RunnerExecutionOutcome> => ({
      ok: true,
      result: {
        sourceId: "surugaya",
        listings: [],
        coverage: "rolling_window",
        warnings: [],
        parserVersion: "surugaya-html-test",
        fetchedAt: new Date().toISOString(),
      },
      captures: [],
    }));

    const result = await runGoldenRegression("surugaya", cases, executor);

    expect(result).toMatchObject({
      ok: false,
      caseCount: 1,
      passed: 0,
      failed: 1,
      error: "golden_regression_failed",
    });
    expect(result.cases[0]?.error?.code).toBe("golden_result_count_below_minimum");
  });

  it("does not launch Playwright when Singapore HTTP succeeds", async () => {
    const baseFetch = vi.fn(async () => new Response("<!doctype html><html><body>ok</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const rendererFactory = vi.fn<() => Promise<PageRenderer>>();
    const transport = new AdaptiveSourceTransport("yahoo_fleamarket_jp", undefined, { baseFetch, rendererFactory });

    const response = await transport.fetch("https://paypayfleamarket.yahoo.co.jp/search/test?page=1");

    expect(response.status).toBe(200);
    expect(rendererFactory).not.toHaveBeenCalled();
    expect(transport.captures).toHaveLength(1);
    await transport.close();
  });

  it("starts one anonymous renderer only after an allowlisted 403", async () => {
    const baseFetch = vi.fn(async () => new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const renderer: PageRenderer = {
      render: vi.fn(async (url) => ({
        status: 200,
        url: url.href,
        headers: { "content-type": "text/html" },
        html: "<!doctype html><html><body>rendered</body></html>",
      })),
      close: vi.fn(async () => undefined),
    };
    const rendererFactory = vi.fn(async () => renderer);
    const transport = new AdaptiveSourceTransport("surugaya", undefined, { baseFetch, rendererFactory });

    const response = await transport.fetch("https://www.suruga-ya.jp/search?search_word=test");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-jpgr-source-runner-transport")).toBe("playwright");
    expect(rendererFactory).toHaveBeenCalledTimes(1);
    expect(transport.captures).toHaveLength(2);
    await expect(transport.fetch("https://example.com/search"))
      .rejects.toThrow("source_runner_url_rejected");
    expect(baseFetch).toHaveBeenCalledTimes(1);
    await transport.close();
    expect(renderer.close).toHaveBeenCalledTimes(1);
  });

  it("runs the http pool concurrently without letting a saturated heavy pool block it", async () => {
    const httpTask = createJobBodySchema.parse({
      sourceId: "yahoo_shopping",
      operation: "search",
      request: { query: "陶器", filters: {} },
    });
    // AmiAmi 是唯一走 Python 子进程的来源，独占 heavy 池。
    const heavyTask = createJobBodySchema.parse({
      sourceId: "amiami",
      operation: "search",
      request: { query: "千反田える", filters: { pageSize: 3, availabilityMode: "all" } },
    });
    const running = { heavy: 0, http: 0 };
    const peak = { heavy: 0, http: 0 };
    const executor = vi.fn(async (task: CreateJobBody): Promise<RunnerExecutionOutcome> => {
      const pool = task.sourceId === "amiami" ? "heavy" : "http";
      running[pool] += 1;
      peak[pool] = Math.max(peak[pool], running[pool]);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running[pool] -= 1;
      return { ok: true, result: searchResult("yahoo_shopping"), captures: [] };
    });
    const queue = new PooledJobQueue(executor, {
      pools: { heavy: { concurrency: 1, queueDepth: 4 }, http: { concurrency: 3, queueDepth: 8 } },
    });

    // 先塞满 heavy 池，再排 http：串行时代这些 http 任务会被 AmiAmi 全部挡住。
    const heavy = [queue.enqueue(heavyTask), queue.enqueue(heavyTask)];
    const http = [queue.enqueue(httpTask), queue.enqueue(httpTask), queue.enqueue(httpTask)];

    expect([...heavy, ...http].every((result) => result.ok)).toBe(true);
    await expect(queue.onIdle(4_000)).resolves.toBe(true);
    expect(peak.heavy).toBe(1);
    expect(peak.http).toBe(3);
    expect(executor).toHaveBeenCalledTimes(5);
    for (const result of [...heavy, ...http]) {
      if (result.ok) expect(queue.get(result.job.jobId)?.status).toBe("succeeded");
    }
  });

  it("rejects only the saturated pool with queue_full", () => {
    const heavyTask = createJobBodySchema.parse({
      sourceId: "amiami",
      operation: "search",
      request: { query: "千反田える", filters: { pageSize: 3, availabilityMode: "all" } },
    });
    const httpTask = createJobBodySchema.parse({
      sourceId: "yahoo_shopping",
      operation: "search",
      request: { query: "陶器", filters: {} },
    });
    const queue = new PooledJobQueue(
      () => new Promise(() => undefined),
      { pools: { heavy: { concurrency: 1, queueDepth: 1 }, http: { concurrency: 1, queueDepth: 2 } } },
    );

    expect(queue.enqueue(heavyTask).ok).toBe(true);
    const overflow = queue.enqueue(heavyTask);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("queue_full");
    // heavy 满了，http 照常收——这正是分池要买到的东西。
    expect(queue.enqueue(httpTask).ok).toBe(true);
  });

  it("selects the signed runner before legacy direct routes when configured", () => {
    const env = {
      SOURCE_RUNNER_URL: "https://runner.example.com/source-runner/",
      MERCARI_ADAPTER_SIGNING_KEY: "configured",
      YAHOO_FLEAMARKET_CLOUDFLARE_DIRECT_ENABLED: "true",
    } as unknown as Env;
    expect(sourceRequestRoute("yahoo_fleamarket_jp", env)).toBe("mercari_service");
    expect(sourceRequestRoute("yahoo_auctions_jp", env)).toBe("mercari_service");
    expect(sourceRequestRoute("yahoo_shopping", env)).toBe("mercari_service");
    expect(sourceRequestRoute("surugaya", env)).toBe("direct");
    expect(sourceRequestRoute("rakuten_ichiba", env)).toBe("direct");
    expect(mercariSourceRunnerMode({
      ...env,
      MERCARI_SOURCE_RUNNER_MODE: "shadow",
    } as unknown as Env)).toBe("shadow");
  });

  it("uses the signed VPS runner only when Rakuten API and direct page lookup cannot resolve inventory", async () => {
    const signingKey = await privateSigningKey();
    const jobId = "e52e22b7-a0d3-4f40-b33c-9ef81e14ea20";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === "openapi.rakuten.co.jp") {
        return Response.json({
          error: "wrong_parameter",
          error_description: "itemCode is not valid",
        }, { status: 400 });
      }
      if (url.hostname === "item.rakuten.co.jp") {
        return new Response("<html>short response</html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      }
      if (url.pathname.endsWith("/v1/jobs")) {
        return Response.json({ ok: true, data: { jobId, status: "queued" } }, { status: 202 });
      }
      return Response.json({
        ok: true,
        data: {
          jobId,
          status: "succeeded",
          result: {
            sourceId: "rakuten_ichiba",
            sourceItemId: "gscraft:n0066",
            identityScope: "listing",
            canonicalUrl: "https://item.rakuten.co.jp/gscraft/n0066/",
            title: "ユリウス ぬいぐるみ：GSクラフト",
            currency: "JPY",
            currentPrice: 3850,
            priceBasis: "listing_price",
            condition: "new",
            availability: "sold_out",
          },
        },
      });
    }) as unknown as typeof fetch;
    const env = {
      SOURCE_RUNNER_URL: "https://runner.example.com/source-runner/",
      MERCARI_ADAPTER_SIGNING_KEY: signingKey,
    } as unknown as Env;

    const listing = await itemWithConfiguredRoute(
      env,
      rakutenIchibaAdapter,
      "gscraft:n0066",
      {
        fetch: fetcher,
        secrets: {
          RAKUTEN_APPLICATION_ID: "app",
          RAKUTEN_ACCESS_KEY: "access",
          RAKUTEN_APPLICATION_URL: "https://eru.example.com/",
        },
      },
    );

    expect(listing).toMatchObject({
      sourceItemId: "gscraft:n0066",
      availability: "sold_out",
      currentPrice: 3850,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not convert a missing item into a business-repair wait", async () => {
    const signingKey = await privateSigningKey();
    const jobId = "e52e22b7-a0d3-4f40-b33c-9ef81e14ea20";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/jobs")) {
        return Response.json({ ok: true, data: { jobId, status: "queued" } }, { status: 202 });
      }
      return Response.json({
        ok: true,
        data: {
          jobId,
          status: "failed",
          error: {
            code: "http_404",
            message: "商品不存在",
            upstreamStatus: 404,
            retryable: false,
            repairStatus: "pending",
            repairIncidentId: "should-not-repair",
          },
        },
      });
    }) as unknown as typeof fetch;
    const env = {
      SOURCE_RUNNER_URL: "https://runner.example.com/source-runner/",
      MERCARI_ADAPTER_SIGNING_KEY: signingKey,
    } as unknown as Env;

    await expect(itemWithSourceRunner(env, "rakuten_ichiba", "gscraft:n0066", {
      fetch: fetcher,
    })).rejects.toMatchObject({ code: "http_404", status: 404, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("persists one deduplicated repair incident with the exact failed task", async () => {
    const root = await mkdtemp(join(tmpdir(), "jpgr-business-repair-"));
    try {
      const store = new BusinessRepairStore(root);
      const task = createJobBodySchema.parse({
        sourceId: "yahoo_shopping",
        operation: "search",
        request: { query: "陶器", filters: { page: 1, pageSize: 20 } },
      });
      const failure: RunnerExecutionOutcome = {
        ok: false,
        error: {
          code: "yahoo_shopping_parser_changed",
          message: "上游结构发生变化 request 0123456789abcdef",
          upstreamStatus: 502,
          retryable: true,
          retryAfterSeconds: null,
        },
        captures: [],
      };

      const first = await store.recordFailure(task, failure);
      const second = await store.recordFailure(task, failure);
      const files = await readdir(join(root, "incoming"));

      expect(files).toHaveLength(1);
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      if (!first.ok && !second.ok) {
        expect(first.error).toMatchObject({
          repairStatus: "pending",
          repairOriginalCode: "yahoo_shopping_parser_changed",
        });
        expect(second.error.repairIncidentId).toBe(first.error.repairIncidentId);
      }
      const incident = JSON.parse(
        await readFile(join(root, "incoming", files[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(incident).toMatchObject({
        kind: "source_runner_business_failure",
        sourceId: "yahoo_shopping",
        task,
        policy: {
          repairScope: "vps_source_runner_only",
          cloudflareEditsAllowed: false,
          animateEditsAllowed: false,
          productionResultMustBeReplayed: true,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open a source-wide repair gate for a missing historical item", async () => {
    const root = await mkdtemp(join(tmpdir(), "jpgr-business-item-missing-"));
    try {
      const store = new BusinessRepairStore(root);
      const task = createJobBodySchema.parse({
        sourceId: "yahoo_auctions_jp",
        operation: "item",
        urlOrId: "https://auctions.yahoo.co.jp/jp/auction/z626903812",
      });
      const failure: RunnerExecutionOutcome = {
        ok: false,
        error: {
          code: "yahoo_auctions_item_not_found",
          message: "历史拍卖详情已经下架",
          upstreamStatus: 404,
          retryable: false,
          retryAfterSeconds: null,
        },
        captures: [],
      };

      const outcome = await store.recordFailure(task, failure);

      expect(outcome).toEqual(failure);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open a repair gate for a generic item 404", async () => {
    const root = await mkdtemp(join(tmpdir(), "jpgr-business-item-http-404-"));
    try {
      const store = new BusinessRepairStore(root);
      const task = createJobBodySchema.parse({
        sourceId: "rakuten_ichiba",
        operation: "item",
        urlOrId: "gscraft:n0066",
      });
      const failure: RunnerExecutionOutcome = {
        ok: false,
        error: {
          code: "http_404",
          message: "商品不存在",
          upstreamStatus: 404,
          retryable: false,
          retryAfterSeconds: null,
        },
        captures: [],
      };

      await expect(store.recordFailure(task, failure)).resolves.toEqual(failure);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a legacy source-wide HTTP 404 gate created by an item lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "jpgr-business-legacy-item-http-404-"));
    try {
      const task = createJobBodySchema.parse({
        sourceId: "rakuten_ichiba",
        operation: "item",
        urlOrId: "gscraft:n0066",
      });
      await mkdir(join(root, "gates"), { recursive: true });
      await writeFile(join(root, "gates", "rakuten_ichiba.json"), JSON.stringify({
        schema: 1,
        sourceId: "rakuten_ichiba",
        status: "pending",
        incidentId: "legacy-item-404",
        originalCode: "http_404",
      }));
      const executor = vi.fn(async (): Promise<RunnerExecutionOutcome> => ({
        ok: true,
        result: {
          sourceId: "rakuten_ichiba",
          sourceItemId: "gscraft:n0066",
          identityScope: "listing",
          canonicalUrl: "https://item.rakuten.co.jp/gscraft/n0066/",
          title: "商品",
          currency: "JPY",
          priceBasis: "listing_price",
          condition: "unknown",
          availability: "available",
          parserVersion: "test",
        },
        captures: [],
      }));

      await expect(executeWithBusinessRepair(
        new BusinessRepairStore(root),
        task,
        executor,
      )).resolves.toMatchObject({ ok: true });
      expect(executor).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("short-circuits new work while the source-specific repair gate is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "jpgr-business-gate-"));
    try {
      const task = createJobBodySchema.parse({
        sourceId: "yahoo_auctions_jp",
        operation: "search",
        request: { query: "高木さん", filters: {} },
      });
      await mkdir(join(root, "gates"), { recursive: true });
      await writeFile(join(root, "gates", "yahoo_auctions_jp.json"), JSON.stringify({
        schema: 1,
        sourceId: "yahoo_auctions_jp",
        status: "repairing",
        incidentId: "jpgr-business-test",
      }));
      const executor = vi.fn(async (): Promise<RunnerExecutionOutcome> => ({
        ok: true,
        result: {
          sourceId: "yahoo_auctions_jp",
          listings: [],
          coverage: "first_page",
          warnings: [],
          parserVersion: "test",
          fetchedAt: new Date().toISOString(),
        },
        captures: [],
      }));

      const outcome = await executeWithBusinessRepair(
        new BusinessRepairStore(root),
        task,
        executor,
      );

      expect(executor).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          code: "source_runner_repair_pending",
          repairStatus: "repairing",
          repairIncidentId: "jpgr-business-test",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a runner repair state to a durable retryable Collector error", async () => {
    const signingKey = await privateSigningKey();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          ok: true,
          data: {
            jobId: "b5442588-ff3b-4f36-9e6b-89a5679e4adc",
            status: "queued",
          },
        }, { status: 202 });
      }
      return Response.json({
        ok: true,
        data: {
          jobId: "b5442588-ff3b-4f36-9e6b-89a5679e4adc",
          status: "failed",
          error: {
            code: "yahoo_shopping_parser_changed",
            message: "上游结构发生变化",
            upstreamStatus: 502,
            retryable: true,
            retryAfterSeconds: 120,
            repairStatus: "pending",
            repairIncidentId: "jpgr-business-test",
            repairOriginalCode: "yahoo_shopping_parser_changed",
          },
        },
      });
    }) as unknown as typeof fetch;
    const env = {
      SOURCE_RUNNER_URL: "https://runner.example.com/source-runner/",
      MERCARI_ADAPTER_SIGNING_KEY: signingKey,
    } as unknown as Env;

    await expect(searchWithSourceRunner(
      env,
      "yahoo_shopping",
      { query: "陶器", filters: {} },
      { fetch: fetcher, secrets: {} },
    )).rejects.toMatchObject({
      code: "source_runner_repair_pending",
      status: 503,
      retryable: true,
      retryAfterSeconds: 120,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
