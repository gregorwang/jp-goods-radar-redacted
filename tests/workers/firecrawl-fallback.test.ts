/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createFirecrawlSurugayaFetch } from "../../apps/collector/src/firecrawl-fallback";
import { RadarRepository } from "@jpgr/db";
import { testDatabase } from "./postgres";

describe("Firecrawl Surugaya fallback budget", () => {
  it("fails closed before scraping when the provider billing-period budget is exhausted", async () => {
    const periodStart = "2026-07-23T00:23:31.852Z";
    const periodEnd = "2026-08-23T00:23:31.852Z";
    await testDatabase.prepare(
      `INSERT INTO managed_api_billing_usage(
        provider,period_started_at,period_ends_at,runtime_budget,runtime_calls,emergency_reserve,updated_at
       ) VALUES('firecrawl',?,?,900,900,100,CURRENT_TIMESTAMP::text)`,
    ).bind(periodStart, periodEnd).run();
    const providerFetcher = vi.fn(async () => {
      throw new Error("scrape must not run after the local budget is exhausted");
    }) as unknown as typeof fetch;
    const controlFetcher = vi.fn(async () => Response.json({
      success: true,
      data: {
        remainingCredits: 1000,
        planCredits: 1000,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      },
    })) as unknown as typeof fetch;
    const transport = createFirecrawlSurugayaFetch(
      { ...env, FIRECRAWL_API_KEY: "firecrawl-test-key" } as Env,
      providerFetcher,
      controlFetcher,
    );

    await expect(transport.fetch("https://www.suruga-ya.jp/search?search_word=test"))
      .rejects.toMatchObject({ code: "firecrawl_runtime_budget_exhausted", status: 429 });
    expect(controlFetcher).toHaveBeenCalledTimes(1);
    expect(providerFetcher).not.toHaveBeenCalled();
    const usage = await testDatabase.prepare(
      "SELECT runtime_calls FROM managed_api_billing_usage WHERE provider='firecrawl' AND period_started_at=?",
    ).bind(periodStart).first<{ runtime_calls: number }>();
    expect(usage?.runtime_calls).toBe(900);
  });

  it("rejects every target outside fixed public Surugaya search and detail endpoints", async () => {
    const providerFetcher = vi.fn() as unknown as typeof fetch;
    const controlFetcher = vi.fn() as unknown as typeof fetch;
    const transport = createFirecrawlSurugayaFetch(
      { ...env, FIRECRAWL_API_KEY: "firecrawl-test-key" } as Env,
      providerFetcher,
      controlFetcher,
    );

    await expect(transport.fetch("https://www.suruga-ya.jp/product/detail/123456789/extra"))
      .rejects.toMatchObject({ code: "firecrawl_url_rejected", status: 400 });
    await expect(transport.fetch("https://example.com/search"))
      .rejects.toMatchObject({ code: "firecrawl_url_rejected", status: 400 });
    expect(controlFetcher).not.toHaveBeenCalled();
    expect(providerFetcher).not.toHaveBeenCalled();
  });

  it("fetches an exact Surugaya product detail URL through the budgeted JP proxy", async () => {
    const periodStart = "2026-07-23T00:23:31.852Z";
    const periodEnd = "2026-08-23T00:23:31.852Z";
    const detailUrl = "https://www.suruga-ya.jp/product/detail/123456789";
    const detailHtml = `<html><body><h1>商品详情</h1><table><tr><th>定価</th><td>11,000円</td></tr></table></body></html>`;
    const providerFetcher = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { url: string };
      expect(body.url).toBe(detailUrl);
      return Response.json({
        success: true,
        data: {
          rawHtml: detailHtml,
          metadata: { sourceURL: detailUrl, statusCode: 200, cacheState: "miss" },
        },
      });
    }) as unknown as typeof fetch;
    const controlFetcher = vi.fn(async () => Response.json({
      success: true,
      data: {
        remainingCredits: 1000,
        planCredits: 1000,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      },
    })) as unknown as typeof fetch;
    const transport = createFirecrawlSurugayaFetch(
      { ...env, FIRECRAWL_API_KEY: "firecrawl-test-key" } as Env,
      providerFetcher,
      controlFetcher,
    );

    const response = await transport.fetch(detailUrl);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(detailHtml);
    expect(transport.stats).toMatchObject({
      requestCount: 1,
      localDailyRuntimeCalls: 1,
      cacheStates: ["miss"],
    });
  });

  it("enforces the JST daily ceiling in addition to the billing-period ceiling", async () => {
    const repository = new RadarRepository(testDatabase);
    const input = {
      provider: "firecrawl",
      periodStartedAt: "2026-07-01T00:00:00.000Z",
      periodEndsAt: "2026-08-01T00:00:00.000Z",
      runtimeBudget: 900,
      emergencyReserve: 100,
      dailyBudget: 30,
    };
    for (let index = 0; index < 30; index += 1) {
      await expect(repository.reserveManagedApiBillingCall(input)).resolves.not.toBeNull();
    }
    await expect(repository.reserveManagedApiBillingCall(input)).resolves.toBeNull();
    await expect(repository.latestManagedApiBillingUsage("firecrawl")).resolves.toMatchObject({
      runtimeCalls: 30,
      dailyBudget: 30,
      dailyRuntimeCalls: 30,
    });
  });
});
