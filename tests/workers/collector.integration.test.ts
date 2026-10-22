/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError, surugayaAdapter } from "@jpgr/adapters";
import worker from "../../apps/collector/src/index";
import { keywordBaselineResetStatements, RadarRepository, type WatchBindingRow } from "@jpgr/db";
import { testDatabase } from "./postgres";
import {
  evaluateListingEvents,
  type MonitorJob,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SourceAdapter,
} from "@jpgr/core";
import { sendResendEmail } from "@jpgr/email";
import { listingLibraryQuery } from "../../apps/web/src/lib/listing-library-query";
import { configuredMarketSubscriptions, parseMarketAnalyticsRun } from "../../apps/collector/src/analytics";
import { searchSurugayaDirect } from "../../apps/collector/src/surugaya-direct";
import { searchYahooAuctionsWithRuntime } from "../../apps/collector/src/yahoo-auctions-runtime";

async function seedBinding(id: string, sourceId = "rakuten_ichiba"): Promise<WatchBindingRow> {
  const now = new Date().toISOString();
  await testDatabase.prepare("INSERT INTO watch_profiles(id,name,enabled,created_at,updated_at) VALUES(?, ?, 1, ?, ?)")
    .bind(`profile-${id}`, `Profile ${id}`, now, now).run();
  await testDatabase.prepare(
    `INSERT INTO watch_bindings(id,watch_profile_id,source_id,kind,query,interval_minutes,next_run_at,
     source_config_json,created_at,updated_at) VALUES(?,?,?,'keyword','氷菓',60,?,'{}',?,?)`,
  ).bind(id, `profile-${id}`, sourceId, new Date(Date.now() - 60_000).toISOString(), now, now).run();
  return (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?").bind(id).first<WatchBindingRow>())!;
}

async function seedExactProductMonitorRule(
  binding: WatchBindingRow,
  eventTypes: readonly string[],
  targetListingPrice: number | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const variantId = `variant-${binding.id}`;
  await testDatabase.batch([
    testDatabase.prepare(
      "UPDATE watch_profiles SET dossier_kind='exact_product',product_variant_id=?,updated_at=? WHERE id=?",
    ).bind(variantId, now, binding.watch_profile_id),
    testDatabase.prepare(
      `INSERT INTO monitor_rules(
        id,rule_key,version,watch_profile_id,scope_type,scope_id,scope_identity_status,
        event_types_json,source_allow_json,source_deny_json,conditions_json,completeness_json,
        target_listing_price,target_landed_cost,delivery_mode,timezone,dedupe_window_minutes,
        cooldown_minutes,stale_source_policy,enabled,valid_from,created_at,created_by
       ) VALUES(?,?,1,?,'variant',?,'bound',?,'[]','[]','[]','[]',?,NULL,'digest',
         'Asia/Tokyo',1440,180,'annotate',1,?,?,'user')`,
    ).bind(
      `rule-${binding.id}-v1`,
      `watch_profile:${binding.watch_profile_id}`,
      binding.watch_profile_id,
      variantId,
      JSON.stringify(eventTypes),
      targetListingPrice,
      now,
      now,
    ),
  ]);
}

async function seedLandedCostProfile(): Promise<string> {
  const now = new Date().toISOString();
  const id = "cp_worker-test-v1";
  await testDatabase.prepare(
    `INSERT INTO cost_profiles(
      id,profile_key,version,name,exchange_rate_cny_per_100_jpy_milli,
      exchange_rate_buffer_bps,proxy_fixed_fee_jpy,proxy_percent_bps,
      domestic_shipping_min_jpy,domestic_shipping_max_jpy,international_route_label,
      first_weight_grams,first_weight_min_jpy,first_weight_max_jpy,
      continued_weight_grams,continued_weight_min_jpy,continued_weight_max_jpy,
      unknown_weight_min_grams,unknown_weight_max_grams,consolidation_share_bps,
      tax_enabled,tax_bps,cost_buffer_bps,valid_from,created_at,created_by
     ) VALUES(?, 'default',1,'Worker 测试成本',4800,0,0,0,0,0,'测试空运',
       500,1000,2000,100,0,0,100,500,10000,0,0,0,?,?,'user')`,
  ).bind(id, now, now).run();
  return id;
}

async function seedLandedCostTarget(
  binding: WatchBindingRow,
  costProfileId: string,
  targetLandedCostJpy: number,
): Promise<void> {
  await testDatabase.prepare(
    `INSERT INTO monitor_rule_landed_cost_targets(
      monitor_rule_id,cost_profile_id,target_landed_cost_jpy,threshold_policy,created_at
     ) VALUES(?,?,?,'estimate_upper_bound_at_or_below',?)`,
  ).bind(
    `rule-${binding.id}-v1`,
    costProfileId,
    targetLandedCostJpy,
    new Date().toISOString(),
  ).run();
}

function hourlyMaintenanceTime(): number {
  const now = new Date();
  now.setUTCMinutes(7, 0, 0);
  return now.getTime();
}

function yahooBootstrapFixture(): string {
  const nextData = {
    props: {
      initialState: {
        client: { crumb: "worker-fixture-crumb" },
        bff: {
          liveTest: { frontTest: { bucketId: "worker-fixture-bucket" } },
          searchResults: {
            items: {
              1: [
                {
                  type: "RESULT",
                  content: {
                    items: [{
                      itemId: "cloudflare-shop_item-1",
                      url: "https://store.shopping.yahoo.co.jp/cloudflare-shop/item-1.html",
                      name: "陶器 Cloudflare 直連商品",
                      price: 5_830,
                      actualPrice: 5_563,
                      image: { imageUrl: "https://item-shopping.c.yimg.jp/i/n/cloudflare-shop_item-1" },
                      store: { name: "Cloudflare テスト店" },
                      productCategory: 12345,
                      skuId: "cloudflare-sku-1",
                    }],
                  },
                },
                { type: "PAGER", content: { start: 1, end: 1, total: 1, totalPage: 1 } },
              ],
            },
          },
        },
      },
    },
    page: "/search/[...params]",
    query: {},
    buildId: "worker-fixture-build",
  };
  return `<!doctype html><html lang="ja"><head><title>Yahoo fixture</title></head><body><script type="application/json" id="__NEXT_DATA__">${JSON.stringify(nextData)}</script></body></html>`;
}

function amazonSearchFixture(): string {
  const item = `<div data-component-type="s-search-result" data-asin="B0GZ9NMHFJ">
    <h2><a href="/dp/B0GZ9NMHFJ"><span>雪ミク Cloudflare HTML 商品</span></a></h2>
    <img class="s-image" src="https://m.media-amazon.com/images/I/fixture.jpg">
    <span class="a-price"><span class="a-offscreen">￥4,980</span></span>
  </div>`;
  return `<!doctype html><html lang="ja"><head><title>Amazon.co.jp 検索結果</title></head>
    <body>${item}<span class="s-pagination-next" aria-disabled="true">次へ</span>
    <!--${"amazon-fixture-padding".repeat(180)}--></body></html>`;
}

function surugayaSearchFixture(): string {
  const item = `<div id="search_result"><div class="item_box"><div class="item">
    <div class="photo_box"><p class="thum"><a href="/product/detail/994909113"><img src="https://www.suruga-ya.jp/database/photo.php?shinaban=994909113&amp;size=m"></a></p></div>
    <div class="item_detail"><div class="title"><a href="/product/detail/994909113"><h3 class="product-name">千反田える Cloudflare 直連商品</h3></a></div><p class="condition background-kishu">中古</p></div>
    <div class="item_price"><p class="price_teika">中古：<span><strong>￥905</strong></span></p></div>
  </div></div></div>`;
  return `<!doctype html><html lang="ja"><head><title>千反田える | 中古・新品通販の駿河屋</title></head><body>${item}<!--${"fixture-padding".repeat(700)}--></body></html>`;
}

function soldOutSurugayaSearchFixture(): string {
  const item = `<div id="search_result"><div class="item_box"><div class="item">
    <div class="photo_box"><p class="thum"><a href="/product/detail/646170273"><img src="https://www.suruga-ya.jp/database/photo.php?shinaban=646170273&amp;size=m"></a></p></div>
    <div class="item_detail"><div class="title"><a href="/product/detail/646170273"><h3 class="product-name">エミリア F:NEX限定 ふわかわロリータぬいぐるみ</h3></a></div><p class="condition background-kishu">中古</p></div>
    <div class="item_price"><p class="price">品切れ</p></div>
  </div></div></div>`;
  return `<!doctype html><html lang="ja"><head><title>エミリア | 中古・新品通販の駿河屋</title></head><body>${item}<!--${"fixture-padding".repeat(700)}--></body></html>`;
}

function verifiedEmptySurugayaSearchFixture(): string {
  return `<!doctype html><html lang="ja"><head><title>検索結果 | 中古・新品通販の駿河屋</title></head><body>
    <main><h1>該当件数</h1><p>検索結果は０件です。条件を変更して下さい。</p></main>
    <!--${"verified-empty-padding".repeat(500)}--></body></html>`;
}

function soldOutSurugayaDetailFixture(): string {
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
    image: "https://www.suruga-ya.jp/database/photo.php?shinaban=646170273&size=m",
    offers: { "@type": "Offer", price: "38300", priceCurrency: "JPY", availability: "https://schema.org/OutOfStock" },
  };
  return `<!doctype html><html lang="ja"><head><title>中古ぬいぐるみ | 駿河屋</title>
    <script type="application/ld+json">${JSON.stringify(product)}</script></head><body><h1>${product.name}</h1>
    <table><tr><th>定価</th><td>11,000円</td></tr></table><p>品切れ</p><!--${"fixture-padding".repeat(700)}--></body></html>`;
}

function availableSurugayaDetailFixture(): string {
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "千反田える Cloudflare 直連商品",
    image: "https://www.suruga-ya.jp/database/photo.php?shinaban=994909113&size=m",
    offers: { "@type": "Offer", price: "905", priceCurrency: "JPY", availability: "https://schema.org/InStock" },
  };
  return `<!doctype html><html lang="ja"><head><title>中古キャラクターグッズ | 駿河屋</title>
    <script type="application/ld+json">${JSON.stringify(product)}</script></head><body><h1>${product.name}</h1>
    <table><tr><th>定価</th><td>2,200円</td></tr></table><!--${"fixture-padding".repeat(700)}--></body></html>`;
}

function charaonSearchFixture(): string {
  const item = `<section class="column4">
    <a href="/SHOP/AZMGS92.html"><img src="https://image1.shopserve.jp/charaon.jp/pic-labo/AZMGS92.jpg"></a>
    <h2><a href="/SHOP/AZMGS92.html" title="文豪ストレイドッグス 商品">文豪ストレイドッグス 商品</a></h2>
    <span class="selling_price">4,620円</span><p class="sps-itemList-stockDisp">○</p>
  </section>`;
  return `<!doctype html><html lang="ja"><head><title>商品一覧 | CharaON</title></head><body><div id="itemList">${item}</div><!--${"fixture-padding".repeat(200)}--></body></html>`;
}

describe("Collector workerd integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists a listing AI task before queue processing", async () => {
    const response = await worker.fetch(new Request("https://collector.test/internal/ai/jobs/listing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "千反田える",
        items: [{
          sourceId: "mercari_jp",
          sourceItemId: "m12345678901",
          identityScope: "listing",
          canonicalUrl: "https://jp.mercari.com/item/m12345678901",
          title: "氷菓 千反田える フィギュア",
          currency: "JPY",
          currentPrice: 4_800,
          priceBasis: "listing_price",
          condition: "used",
          availability: "available",
        }],
      }),
    }) as Parameters<typeof worker.fetch>[0], env);
    expect(response.status).toBe(202);
    const body = await response.json<{ jobId: string; status: string; taskPersisted: boolean }>();
    expect(body).toMatchObject({ status: "queued", taskPersisted: true });
    const stored = await testDatabase.prepare(
      "SELECT kind,status,total_items,payload_json FROM gemini_jobs WHERE id=?",
    ).bind(body.jobId).first<{ kind: string; status: string; total_items: number; payload_json: string }>();
    expect(stored).toMatchObject({ kind: "listing_enrichment", status: "queued", total_items: 1 });
    expect(stored?.payload_json).toContain("m12345678901");
  });

  it("starts with Amazon HTML collection enabled and exposes service health without optional credentials", async () => {
    const response = await worker.fetch(new Request("https://collector.test/") as Parameters<typeof worker.fetch>[0], env);
    expect(await response.json()).toMatchObject({ service: "jp-goods-radar-collector", status: "ok" });
    const databaseHealth = await worker.fetch(
      new Request("https://collector.test/internal/operational-db-health") as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(await databaseHealth.json()).toMatchObject({
      ok: true,
      backend: "postgres",
      source_count: 12,
    });
    const sourceStatus = await worker.fetch(new Request("https://collector.test/internal/source-status") as Parameters<typeof worker.fetch>[0], env);
    const sourceStatusBody = await sourceStatus.json<{ sources: Array<{ sourceId: string; historySearchSupported: boolean; credentialStatus: string }> }>();
    expect(sourceStatusBody.sources.find((source) => source.sourceId === "mercari_jp")?.historySearchSupported).toBe(true);
    expect(sourceStatusBody.sources.find((source) => source.sourceId === "surugaya")?.historySearchSupported).toBe(false);
    expect(sourceStatusBody.sources.find((source) => source.sourceId === "amazon_jp")?.credentialStatus).toBe("not_required");
    const amazon = await testDatabase.prepare("SELECT enabled,health_status FROM source_registry WHERE id='amazon_jp'").first<{ enabled: number; health_status: string }>();
    expect(amazon).toEqual({ enabled: 1, health_status: "unknown" });
  });

  it("tests Amazon Japan through Cloudflare public HTML without an API key", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      expect(url.origin).toBe("https://www.amazon.co.jp");
      expect(url.pathname).toBe("/s");
      expect(url.searchParams.get("k")).toBe("雪ミク");
      expect(url.searchParams.get("language")).toBe("ja_JP");
      expect(headers.get("Cookie")).toContain("i18n-prefs=JPY");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("Authorization")).toBeNull();
      return new Response(amazonSearchFixture(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/amazon_jp", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      {
        ...env,
        AMAZON_CLOUDFLARE_DIRECT_ENABLED: "true",
        AMAZON_HTML_MONITORING_ENABLED: "true",
        BROWSER_RUN_FALLBACK_ENABLED: "false",
      } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceId: "amazon_jp", ok: true, resultCount: 1, requestRoute: "direct" });
    const stored = await testDatabase.prepare("SELECT transport,credential_status,health_status,request_route FROM source_registry WHERE id='amazon_jp'")
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({ transport: "html_endpoint", credential_status: "not_required", health_status: "healthy", request_route: "direct" });
  });

  it("routes Yahoo through the signed fixed-purpose service without multiplying its internal retry", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    let fail = false;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).href).toBe("https://adapter.example/api/yahoo-search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ query: "氷菓", filters: { conditions: ["new"], inStockOnly: true } });
      expect(body).not.toHaveProperty("url");
      if (fail) return new Response("temporary upstream failure", { status: 502, headers: { "Content-Type": "text/plain" } });
      return Response.json({
        ok: true,
        data: {
          sourceId: "yahoo_shopping",
          listings: [{
            sourceId: "yahoo_shopping", sourceItemId: "fixture-shop_item-1", identityScope: "listing",
            canonicalUrl: "https://store.shopping.yahoo.co.jp/fixture-shop/item-1.html", title: "氷菓 Blu-ray",
            currency: "JPY", currentPrice: 5_563, priceBasis: "listing_price", condition: "unknown", availability: "unknown",
          }],
          coverage: "rolling_window", warnings: ["Yahoo 实验来源"], parserVersion: "yahoo-web-session-test",
          fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='yahoo_shopping'").run();
    const configuredEnv = {
      ...env,
      SOURCE_ADAPTER_URL: "https://adapter.example/",
      SOURCE_RUNNER_URL: "",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env;
    const previewRequest = () => new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "氷菓", sources: ["yahoo_shopping"], conditions: ["new"], inStockOnly: true }),
    }) as Parameters<typeof worker.fetch>[0];

    const success = await worker.fetch(previewRequest(), configuredEnv);
    expect(await success.json()).toMatchObject({
      groups: [{ sourceId: "yahoo_shopping", status: "success", requestRoute: "mercari_service", listings: [{ sourceItemId: "fixture-shop_item-1" }] }],
    });

    fail = true;
    const failed = await worker.fetch(previewRequest(), configuredEnv);
    expect(await failed.json()).toMatchObject({ groups: [{ sourceId: "yahoo_shopping", status: "failed" }] });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("runs Yahoo directly on Cloudflare without touching the Vercel fallback", async () => {
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://shopping.yahoo.co.jp");
      expect(url.pathname).toContain("/search/");
      return new Response(yahooBootstrapFixture(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "YAHOO_ANON=worker-fixture; Path=/; HttpOnly",
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='yahoo_shopping'").run();
    const directEnv = {
      ...env,
      YAHOO_CLOUDFLARE_DIRECT_ENABLED: "true",
      YAHOO_WEB_EXPERIMENTAL_ENABLED: "true",
      YAHOO_WEB_EXPERIMENTAL_MAX_PAGES: "1",
      YAHOO_WEB_EXPERIMENTAL_DELAY_MS: "2000",
    } as Env;

    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/yahoo_shopping", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      directEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sourceId: "yahoo_shopping",
      ok: true,
      resultCount: 1,
      requestRoute: "direct",
      routeOutcome: { kind: "primary_success", route: "direct" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testDatabase.prepare(
      "SELECT health_status,request_route,last_error_code FROM source_registry WHERE id='yahoo_shopping'",
    ).first()).toMatchObject({ health_status: "healthy", request_route: "direct", last_error_code: null });
  });

  it("falls Yahoo back to Vercel after a Cloudflare 403 and skips only the cooling direct route", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    let directCalls = 0;
    let serviceCalls = 0;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "shopping.yahoo.co.jp") {
        directCalls += 1;
        return new Response("forbidden", { status: 403 });
      }
      expect(url.href).toBe("https://adapter.example/api/yahoo-search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      serviceCalls += 1;
      return Response.json({
        ok: true,
        data: {
          sourceId: "yahoo_shopping",
          listings: [{
            sourceId: "yahoo_shopping", sourceItemId: `vercel-fallback-${serviceCalls}`, identityScope: "listing",
            canonicalUrl: `https://store.shopping.yahoo.co.jp/fallback/item-${serviceCalls}.html`, title: "陶器 Vercel 兜底商品",
            currency: "JPY", currentPrice: 5_563, priceBasis: "listing_price", condition: "unknown", availability: "unknown",
          }],
          coverage: "rolling_window", warnings: [], parserVersion: "yahoo-vercel-fixture", fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const configuredEnv = {
      ...env,
      SOURCE_ADAPTER_URL: "https://adapter.example/",
      SOURCE_RUNNER_URL: "",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      YAHOO_CLOUDFLARE_DIRECT_ENABLED: "true",
      YAHOO_WEB_EXPERIMENTAL_ENABLED: "true",
    } as Env;
    const request = () => new Request(
      "https://collector.test/internal/test-source/yahoo_shopping",
      { method: "POST" },
    ) as Parameters<typeof worker.fetch>[0];

    const first = await worker.fetch(request(), configuredEnv);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      requestRoute: "mercari_service",
      routeOutcome: {
        kind: "fallback_success",
        primaryRoute: "direct",
        fallbackRoute: "mercari_service",
        primaryFailure: { code: "yahoo_page_forbidden", status: 403 },
      },
    });
    const cooling = await testDatabase.prepare(
      "SELECT health_status,request_route,cooldown_route,cooldown_until,last_error_code FROM source_registry WHERE id='yahoo_shopping'",
    ).first<Record<string, unknown>>();
    expect(cooling).toMatchObject({
      health_status: "degraded",
      request_route: "direct",
      cooldown_route: "direct",
      last_error_code: "yahoo_page_forbidden",
    });
    expect(cooling?.cooldown_until).toBeTruthy();

    const second = await worker.fetch(request(), configuredEnv);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      ok: true,
      requestRoute: "mercari_service",
      routeOutcome: { primaryFailure: { code: "source_cooldown" } },
    });
    expect(directCalls).toBe(1);
    expect(serviceCalls).toBe(2);
  });

  it("reports both Yahoo routes when Cloudflare and Vercel fail", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "shopping.yahoo.co.jp") return new Response("forbidden", { status: 403 });
      return new Response("FUNCTION_INVOCATION_FAILED private platform body", {
        status: 502,
        headers: { "Content-Type": "text/plain", "X-Vercel-Id": "hnd1::yahoo-route-chain" },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/yahoo_shopping", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      {
        ...env,
        SOURCE_ADAPTER_URL: "https://adapter.example/",
        SOURCE_RUNNER_URL: "",
        MERCARI_ADAPTER_SIGNING_KEY: privateKey,
        YAHOO_CLOUDFLARE_DIRECT_ENABLED: "true",
        YAHOO_WEB_EXPERIMENTAL_ENABLED: "true",
      } as Env,
    );
    expect(response.status).toBe(502);
    const body = await response.json<{ error: string; routeFailures: Array<{ route: string; failure: { code: string; status: number } }> }>();
    expect(body.error).toContain("Cloudflare 直连");
    expect(body.error).toContain("隔离签名采集服务");
    expect(body.routeFailures).toMatchObject([
      { route: "direct", failure: { code: "yahoo_page_forbidden", status: 403 } },
      { route: "mercari_service", failure: { code: "yahoo_service_platform_invalid_response", status: 502 } },
    ]);
    expect(body.error).not.toContain("private platform body");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await testDatabase.prepare(
      "SELECT request_route,cooldown_route,last_http_status,last_error_code FROM source_registry WHERE id='yahoo_shopping'",
    ).first()).toMatchObject({
      request_route: "direct",
      cooldown_route: "direct",
      last_http_status: 403,
      last_error_code: "yahoo_page_forbidden",
    });
  });

  it("counts Dashboard activity from Japan midnight rather than UTC midnight", async () => {
    // 全站统一按 JST 划分"一天"：商品与来源都在日本，且邮件配额、汇总 key 与
    // 仪表盘计数必须用同一个日界，否则操作者看到的"今日已发"永远和配额对不上。
    const repository = new RadarRepository(testDatabase);
    const insert = (id: string, searchedAt: string) => testDatabase.prepare(
      `INSERT INTO search_history(id,query,sources_json,filters_json,status,result_count,source_summary_json,searched_at)
       VALUES(?,?,'["surugaya"]','{}','empty',0,'[]',?)`,
    ).bind(id, id, searchedAt);
    await testDatabase.batch([
      insert("before-jst-midnight", "2026-07-12T14:59:59.999Z"),
      insert("after-jst-midnight", "2026-07-12T15:00:00.000Z"),
    ]);
    const summary = await repository.dashboardSummary(Date.parse("2026-07-13T00:30:00.000Z"));
    expect(summary.todaySearches).toBe(1);
  });

  it("persists a source-level cooldown and suppresses repeated upstream tests after a 403", async () => {
    const upstream = vi.fn(async () => Response.json({}, { status: 403 }));
    vi.stubGlobal("fetch", upstream);
    const request = (): Parameters<typeof worker.fetch>[0] => new Request(
      "https://collector.test/internal/test-source/mercari_jp",
      { method: "POST" },
    ) as Parameters<typeof worker.fetch>[0];
    const started = Date.now();

    const first = await worker.fetch(request(), env);
    expect(first.status).toBe(502);
    const firstBody = await first.json<{ cooldownUntil: string; httpStatus: number }>();
    expect(firstBody.httpStatus).toBe(403);
    expect(Date.parse(firstBody.cooldownUntil) - started).toBeGreaterThanOrEqual(12 * 60 * 60 * 1_000 - 1_000);

    const stored = await testDatabase.prepare(
      "SELECT cooldown_until,last_http_status,last_error_code FROM source_registry WHERE id='mercari_jp'",
    ).first<{ cooldown_until: string; last_http_status: number; last_error_code: string }>();
    expect(stored?.last_http_status).toBe(403);
    expect(stored?.last_error_code).toBe("mercari_blocked");
    expect(stored?.cooldown_until).toBe(firstBody.cooldownUntil);

    const second = await worker.fetch(request(), env);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ sourceId: "mercari_jp", ok: false, cooldownUntil: firstBody.cooldownUntil });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("retries one transient Surugaya service 502 and records the real preview in search history", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    let attempts = 0;
    const attemptedAt: number[] = [];
    const signedAt: string[] = [];
    const independentFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      attemptedAt.push(Date.now());
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe("https://adapter.example/api/surugaya-search");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      signedAt.push(headers.get("X-JPGR-Timestamp") ?? "");
      if (attempts === 1) return new Response("upstream gateway error", {
        status: 502,
        headers: { "Content-Type": "text/plain", "X-Vercel-Id": "hnd1::temporary-502" },
      });
      return Response.json({
        ok: true,
        data: {
          sourceId: "surugaya",
          listings: [{ sourceId: "surugaya", sourceItemId: "123456789", identityScope: "listing",
            canonicalUrl: "https://www.suruga-ya.jp/product/detail/123456789", title: "千反田える",
            imageUrl: "https://www.suruga-ya.jp/database/photo.php?shinaban=123456789&size=m", currency: "JPY",
            currentPrice: 3200, priceBasis: "listing_price", condition: "used", availability: "available",
            rawMetadata: { pageBytes: 12000 } }],
          coverage: "rolling_window",
          warnings: [],
          parserVersion: "surugaya-html-v1",
          fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", independentFetch);
    const independentEnv = { ...env, SURUGAYA_ADAPTER_URL: "https://adapter.example/", MERCARI_ADAPTER_SIGNING_KEY: privateKey } as Env;
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/surugaya", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      independentEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceId: "surugaya", ok: true, resultCount: 1, requestRoute: "mercari_service" });
    const source = await testDatabase.prepare("SELECT request_route,health_status,last_success_at FROM source_registry WHERE id='surugaya'")
      .first<{ request_route: string; health_status: string; last_success_at: string | null }>();
    expect(source).toMatchObject({ request_route: "mercari_service", health_status: "healthy" });
    expect(source?.last_success_at).toBeTruthy();
    expect(independentFetch).toHaveBeenCalledTimes(2);
    expect((attemptedAt[1] ?? 0) - (attemptedAt[0] ?? 0)).toBeGreaterThanOrEqual(950);
    expect(signedAt[1]).not.toBe(signedAt[0]);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();

    const preview = await worker.fetch(
      new Request("https://collector.test/internal/search-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "千反田える", sources: ["surugaya"], conditions: ["used"], inStockOnly: true }),
      }) as Parameters<typeof worker.fetch>[0],
      independentEnv,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ query: "千反田える", groups: [{ sourceId: "surugaya", status: "success" }] });
    const history = await testDatabase.prepare(
      "SELECT id,query,status,result_count,sources_json,filters_json,source_summary_json FROM search_history",
    ).first<{ id: string; query: string; status: string; result_count: number; sources_json: string; filters_json: string; source_summary_json: string }>();
    expect(history).toMatchObject({ query: "千反田える", status: "success", result_count: 1 });
    expect(JSON.parse(history!.sources_json)).toEqual(["surugaya"]);
    expect(JSON.parse(history!.filters_json)).toMatchObject({ conditions: ["used"], inStockOnly: true });
    expect(JSON.parse(history!.source_summary_json)).toMatchObject([{ sourceId: "surugaya", status: "success", resultCount: 1 }]);
    const snapshot = await testDatabase.prepare(
      "SELECT source_id,group_json,captured_at FROM search_result_snapshots WHERE search_history_id=?",
    ).bind(history!.id).first<{ source_id: string; group_json: string; captured_at: string }>();
    expect(snapshot).toMatchObject({ source_id: "surugaya" });
    expect(snapshot?.captured_at).toBeTruthy();
    expect(JSON.parse(snapshot!.group_json)).toMatchObject({
      sourceId: "surugaya",
      status: "success",
      parserVersion: "surugaya-html-v1",
      listings: [{ sourceItemId: "123456789", currentPrice: 3200 }],
    });
    const outbox = await testDatabase.prepare(
      "SELECT kind,reference_id,status,attempts FROM analytics_outbox WHERE reference_id=?",
    ).bind(history!.id).first<{ kind: string; reference_id: string; status: string; attempts: number }>();
    expect(outbox).toEqual({ kind: "preview_search", reference_id: history!.id, status: "queued", attempts: 0 });
    expect(independentFetch).toHaveBeenCalledTimes(3);
  });

  it("accepts evidence-bound AI enrichments into the durable analytics outbox", async () => {
    const listing: NormalizedListing = {
      sourceId: "surugaya",
      sourceItemId: "646170273",
      identityScope: "listing",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/646170273",
      title: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
      descriptionExcerpt: "中古ぬいぐるみ。付属品は商品説明を確認してください。",
      imageUrl: "https://www.suruga-ya.jp/database/photo.php?shinaban=646170273&size=m",
      currency: "JPY",
      currentPrice: 38_300,
      originalPrice: 11_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "sold_out",
      facts: { categoryPath: ["ぬいぐるみ"], identifiers: { sku: "646170273" } },
      rawMetadata: { sourceConditionLabel: "中古" },
    };
    const batchId = "a".repeat(64);
    const inputHash = "b".repeat(64);
    const observedAt = new Date().toISOString();
    const output = {
      translatedTitle: "艾米莉亚 F:NEX 限定毛绒玩偶",
      summary: "来源标题确认这是艾米莉亚 F:NEX 限定款毛绒玩偶。",
      conditionNotes: ["来源标记为中古"],
      defects: [],
      missingParts: [],
      includedItems: [],
      editionOrModel: "F:NEX限定",
      evidence: [{ field: "title", quote: "エミリア F:NEX限定" }],
      confidence: "high",
    };
    const response = await worker.fetch(
      new Request("https://collector.test/internal/analytics/ai-enrichments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId,
          batch: {
            purpose: "listing_facts",
            provider: "google",
            model: "gemini-test",
            promptVersion: "listing-facts-v5",
            inputHash,
            input: { source: "synthetic-worker-test" },
            rawResponse: JSON.stringify({ items: [output] }),
            status: "parsed",
            metadata: { cacheStatus: "miss" },
            observedAt,
          },
          records: [{
            listing,
            purpose: "listing_facts",
            provider: "google",
            model: "gemini-test",
            promptVersion: "listing-facts-v5",
            inputHash,
            input: { ...listing, sourceConditionLabel: "中古", category: "ぬいぐるみ" },
            output,
            evidence: {
              quotes: output.evidence,
              source: { sourceId: listing.sourceId, sourceItemId: listing.sourceItemId, canonicalUrl: listing.canonicalUrl },
            },
            confidence: output.confidence,
            metadata: { cacheStatus: "miss" },
            observedAt,
          }],
        }),
      }) as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, queued: true, batchId });
    const outbox = await testDatabase.prepare(
      "SELECT kind,reference_id,status,payload_json FROM analytics_outbox WHERE kind='ai_enrichment'",
    ).first<{ kind: string; reference_id: string; status: string; payload_json: string }>();
    expect(outbox).toMatchObject({ kind: "ai_enrichment", reference_id: batchId, status: "queued" });
    expect(JSON.parse(outbox!.payload_json)).toMatchObject({
      batchId,
      records: [{ listing: { canonicalUrl: listing.canonicalUrl }, inputHash }],
    });
  });

  it("runs Surugaya directly on Cloudflare and keeps the signed Vercel route unused", async () => {
    const upstream = vi.fn(async function (this: unknown, input: string | URL | Request) {
      expect(this).toBeUndefined();
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("www.suruga-ya.jp");
      expect(url.pathname).toBe("/search");
      return new Response(surugayaSearchFixture(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);
    const directEnv = { ...env, SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env;
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/surugaya", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      directEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sourceId: "surugaya",
      ok: true,
      resultCount: 1,
      requestRoute: "direct",
      routeOutcome: { kind: "primary_success", route: "direct" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testDatabase.prepare(
      "SELECT health_status,request_route,last_error_code FROM source_registry WHERE id='surugaya'",
    ).first()).toMatchObject({ health_status: "healthy", request_route: "direct", last_error_code: null });
  });

  it("hydrates a sold-out Surugaya result with its archived detail price without marking it available", async () => {
    const query = "ぬいぐるみ　エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定";
    const requestedPaths: string[] = [];
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPaths.push(url.pathname);
      expect(url.hostname).toBe("www.suruga-ya.jp");
      return new Response(
        url.pathname === "/search" ? soldOutSurugayaSearchFixture() : soldOutSurugayaDetailFixture(),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();
    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, sources: ["surugaya"], availabilityMode: "all" }),
    }) as Parameters<typeof worker.fetch>[0], { ...env, SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groups: [{
        sourceId: "surugaya",
        status: "success",
        requestRoute: "direct",
        listings: [{
          sourceItemId: "646170273",
          currentPrice: 38_300,
          originalPrice: 11_000,
          availability: "sold_out",
          facts: {
            priceReferences: [{
              kind: "official_list",
              amountJpy: 11_000,
              sourceLabel: "骏河屋商品详情「定価」",
            }],
          },
          rawMetadata: {
            detailHydrated: true,
            priceHydratedFrom: "detail",
            referencePriceHydratedFrom: "detail",
            referenceListPrice: 11_000,
          },
        }],
        warnings: expect.arrayContaining([
          expect.stringContaining("取得 1 件商品的「定价」参考"),
          expect.stringContaining("补充 1 件售罄商品的最后标价"),
        ]),
      }],
    });
    expect(requestedPaths).toEqual(["/search", "/product/detail/646170273"]);
  });

  it("hydrates an exact Surugaya result with an explicit official list price once", async () => {
    const requestedPaths: string[] = [];
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPaths.push(url.pathname);
      return new Response(
        url.pathname === "/search" ? surugayaSearchFixture() : availableSurugayaDetailFixture(),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    });

    const result = await searchSurugayaDirect(surugayaAdapter, {
      query: "千反田える Cloudflare 直連商品",
      filters: { page: 1, pageSize: 5 },
      sourceConfig: { searchMode: "exact_product" },
    }, { fetch: upstream, secrets: {} });

    expect(result.listings).toMatchObject([{
      sourceItemId: "994909113",
      currentPrice: 905,
      originalPrice: 2_200,
      availability: "available",
      facts: {
        priceReferences: [{
          kind: "official_list",
          amountJpy: 2_200,
          sourceLabel: "骏河屋商品详情「定価」",
        }],
      },
      rawMetadata: {
        detailHydrated: true,
        referencePriceHydratedFrom: "detail",
        referenceListPrice: 2_200,
      },
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("取得 1 件商品的「定价」参考"),
    ]));
    expect(requestedPaths).toEqual(["/search", "/product/detail/994909113"]);
  });

  it("does not collect sold-out Surugaya reference evidence for an in-stock exact watch", async () => {
    await seedBinding("surugaya-exact-reference", "surugaya");
    const query = "エミリア F:NEX限定 ふわかわロリータぬいぐるみ";
    await testDatabase.batch([
      testDatabase.prepare(
        `UPDATE watch_bindings
         SET query=?,monitoring_purpose='keyword_new_listing',source_config_json=?
         WHERE id='surugaya-exact-reference'`,
      ).bind(query, JSON.stringify({
        pages: 1,
        searchMode: "exact_product",
        productTarget: {
          canonicalName: query,
          workTitle: "Re:ゼロから始める異世界生活",
          characters: ["エミリア"],
          productType: "ぬいぐるみ",
          aliases: [],
          excludedTerms: [],
        },
        availabilityMode: "purchasable",
        inStockOnly: true,
      })),
      testDatabase.prepare(
        "UPDATE source_registry SET enabled=1,health_status='healthy',request_route='direct' WHERE id='surugaya'",
      ),
    ]);
    const requestedPaths: string[] = [];
    const firecrawlTargets: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPaths.push(url.pathname);
      if (url.hostname === "api.firecrawl.dev" && url.pathname === "/v2/team/credit-usage") {
        return Response.json({
          success: true,
          data: {
            remainingCredits: 1000,
            planCredits: 1000,
            billingPeriodStart: "2026-07-23T00:23:31.852Z",
            billingPeriodEnd: "2026-08-23T00:23:31.852Z",
          },
        });
      }
      if (url.hostname === "api.firecrawl.dev" && url.pathname === "/v2/scrape") {
        const body = JSON.parse(String(init?.body)) as { url: string };
        firecrawlTargets.push(body.url);
        return Response.json({
          success: true,
          data: {
            rawHtml: soldOutSurugayaDetailFixture(),
            metadata: { sourceURL: body.url, statusCode: 200, cacheState: "miss" },
          },
        });
      }
      if (url.pathname === "/product/detail/646170273") {
        return new Response("forbidden", {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(
        url.searchParams.get("inStock") === "On"
          ? soldOutSurugayaSearchFixture()
          : verifiedEmptySurugayaSearchFixture(),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }));
    const now = new Date().toISOString();
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "surugaya-exact-reference-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "surugaya-exact-reference",
        trigger: "manual",
        queuedAt: now,
      },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, {
      ...env,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    } as Env);

    expect((await getQueueResult(batch, context)).explicitAcks)
      .toEqual(["surugaya-exact-reference-message"]);
    const latestRun = await testDatabase.prepare(
      `SELECT id,status,result_count,error_code FROM watch_runs
       WHERE watch_binding_id='surugaya-exact-reference' ORDER BY started_at DESC LIMIT 1`,
    ).first<{ id: string; status: string; result_count: number; error_code: string | null }>();
    expect(latestRun).toMatchObject({ status: "success", result_count: 0, error_code: null });
    const job = await testDatabase.prepare(
      `SELECT status,total_items,payload_json FROM gemini_jobs
       WHERE binding_id='surugaya-exact-reference'`,
    ).first<{ status: string; total_items: number; payload_json: string }>();
    expect(job).toBeNull();
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM watch_run_listing_observations WHERE watch_run_id=?",
    ).bind(latestRun!.id).first()).toEqual({ count: 0 });
    expect(requestedPaths.filter((value) => value === "/product/detail/646170273")).toHaveLength(0);
    expect(firecrawlTargets).toEqual([]);
  });

  it("does not rewrite or send a Surugaya search 404 to the Vercel fallback", async () => {
    const query = "ぬいぐるみ　エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定";
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const requestedWords: string[] = [];
    const requestedStockModes: Array<{ ck: string | null; inStock: string | null }> = [];
    let serviceCalls = 0;
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "www.suruga-ya.jp") {
        requestedWords.push(url.searchParams.get("search_word") ?? "");
        requestedStockModes.push({ ck: url.searchParams.get("ck"), inStock: url.searchParams.get("inStock") });
        return new Response("not found", { status: 404 });
      }
      serviceCalls += 1;
      return Response.json({ ok: false, error: "Vercel fallback must not be called" }, { status: 500 });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();
    const configuredEnv = {
      ...env,
      SURUGAYA_ADAPTER_URL: "https://adapter.example/",
      SOURCE_RUNNER_URL: "",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
    } as Env;
    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, sources: ["surugaya"], availabilityMode: "all" }),
    }) as Parameters<typeof worker.fetch>[0], configuredEnv);
    const body = await response.json<{ groups: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.groups).toMatchObject([{
      sourceId: "surugaya",
      status: "failed",
      listings: [],
      errorCode: "surugaya_exact_query_not_found",
      requestRoute: "direct",
    }]);
    expect(requestedWords).toEqual([query]);
    expect(requestedStockModes).toEqual([{ ck: "true", inStock: "On" }]);
    expect(serviceCalls).toBe(0);
  });

  it("keeps a scheduled Surugaya watch healthy when Browser Run verifies an empty result", async () => {
    await seedBinding("surugaya-verified-empty", "surugaya");
    const historicalAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await testDatabase.prepare(
      `INSERT INTO watch_runs(
         id,watch_binding_id,trigger_type,status,started_at,finished_at,result_count,new_count,changed_count,coverage
       ) VALUES('historical-surugaya-nonempty','surugaya-verified-empty','cron','success',?,?,10,0,0,'rolling_window')`,
    ).bind(historicalAt, historicalAt).run();
    const directFetch = vi.fn(async () => new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", directFetch);
    const quickAction = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: verifiedEmptySurugayaSearchFixture(),
      meta: { status: 404, title: "検索結果 | 駿河屋" },
    }), { headers: { "Content-Type": "application/json" } }));
    const configuredEnv = {
      ...env,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
      BROWSER_RUN_FALLBACK_ENABLED: "true",
      BROWSER: { quickAction },
    } as unknown as Env;
    const now = new Date().toISOString();
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "surugaya-verified-empty-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "surugaya-verified-empty",
        trigger: "manual",
        queuedAt: now,
      },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, configuredEnv);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["surugaya-verified-empty-message"]);
    expect(await testDatabase.prepare(
      `SELECT status,result_count,error_code FROM watch_runs
       WHERE watch_binding_id='surugaya-verified-empty' ORDER BY started_at DESC LIMIT 1`,
    ).first()).toEqual({ status: "success", result_count: 0, error_code: null });
    expect(await testDatabase.prepare(
      "SELECT baseline_completed,consecutive_failures,last_error_code FROM watch_bindings WHERE id='surugaya-verified-empty'",
    ).first()).toEqual({ baseline_completed: 1, consecutive_failures: 0, last_error_code: null });
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledTimes(1);
  });

  it("uses the signed Vercel service after a Cloudflare Surugaya 403 and during cooldown", async () => {
    const query = "ぬいぐるみ　エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定";
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    let directCalls = 0;
    let vercelCalls = 0;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "www.suruga-ya.jp") {
        directCalls += 1;
        return new Response("forbidden", { status: 403 });
      }
      vercelCalls += 1;
      expect(url.href).toBe("https://adapter.example/api/surugaya-search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      expect(new Headers(init?.headers).get("X-JPGR-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
      return Response.json({
        ok: true,
        data: {
          sourceId: "surugaya",
          listings: [{
            sourceId: "surugaya", sourceItemId: "646170273", identityScope: "listing",
            canonicalUrl: "https://www.suruga-ya.jp/product/detail/646170273",
            title: "エミリア ふわかわロリータぬいぐるみ", currency: "JPY",
            currentPrice: 5_980, priceBasis: "listing_price", condition: "used", availability: "available",
          }],
          coverage: "rolling_window", warnings: [], parserVersion: "surugaya-html-v2", fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();
    const configuredEnv = {
      ...env,
      SURUGAYA_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
    } as Env;
    const request = () => new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, sources: ["surugaya"], availabilityMode: "all" }),
    }) as Parameters<typeof worker.fetch>[0];

    const first = await worker.fetch(request(), configuredEnv);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      groups: [{
        sourceId: "surugaya",
        status: "success",
        requestRoute: "mercari_service",
        listings: [{
          sourceItemId: "646170273",
          canonicalUrl: "https://www.suruga-ya.jp/product/detail/646170273",
        }],
        routeOutcome: {
          kind: "fallback_success",
          primaryRoute: "direct",
          fallbackRoute: "mercari_service",
          primaryFailure: { code: "surugaya_blocked", status: 403 },
        },
      }],
    });
    expect(directCalls).toBe(1);
    expect(vercelCalls).toBe(1);
    const firstState = await testDatabase.prepare(
      "SELECT health_status,request_route,cooldown_until,cooldown_route,last_error_code FROM source_registry WHERE id='surugaya'",
    ).first<Record<string, unknown>>();
    expect(firstState).toMatchObject({
      health_status: "degraded",
      request_route: "direct",
      cooldown_route: "direct",
      last_error_code: "surugaya_blocked",
    });

    const second = await worker.fetch(request(), configuredEnv);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      groups: [{
        sourceId: "surugaya",
        status: "success",
        requestRoute: "mercari_service",
        listings: [{ sourceItemId: "646170273" }],
        routeOutcome: {
          kind: "fallback_success",
          fallbackRoute: "mercari_service",
          primaryFailure: { code: "source_cooldown", status: 403 },
        },
      }],
    });
    expect(directCalls).toBe(1);
    expect(vercelCalls).toBe(2);
    const secondState = await testDatabase.prepare(
      "SELECT cooldown_until,last_error_code FROM source_registry WHERE id='surugaya'",
    ).first<Record<string, unknown>>();
    expect(secondState?.cooldown_until).toBe(firstState?.cooldown_until);
    expect(secondState?.last_error_code).toBe("surugaya_blocked");
  });

  it("preserves the original Surugaya direct cooldown when the Vercel fallback fails", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const cooldownUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    let vercelCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      vercelCalls += 1;
      return new Response("FUNCTION_INVOCATION_FAILED", { status: 502, headers: { "Content-Type": "text/plain" } });
    }));
    await testDatabase.prepare(
      `UPDATE source_registry SET enabled=1,health_status='degraded',cooldown_until=?,cooldown_route='direct',
       last_http_status=403,last_error_code='surugaya_blocked',last_error_message='骏河屋已阻止当前请求'
       WHERE id='surugaya'`,
    ).bind(cooldownUntil).run();
    const configuredEnv = {
      ...env,
      SURUGAYA_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
    } as Env;

    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "エミリア", sources: ["surugaya"], availabilityMode: "all" }),
    }) as Parameters<typeof worker.fetch>[0], configuredEnv);
    const body = await response.json<{ groups: Array<{ status: string; errorCode?: string; error?: string }> }>();

    expect(body.groups[0]).toMatchObject({ status: "failed", errorCode: "surugaya_all_routes_failed" });
    expect(body.groups[0]?.error).toContain("隔离签名采集服务");
    expect(vercelCalls).toBe(2);
    expect(await testDatabase.prepare(
      "SELECT cooldown_until,last_error_code,last_error_message FROM source_registry WHERE id='surugaya'",
    ).first()).toMatchObject({
      cooldown_until: cooldownUntil,
      last_error_code: "surugaya_blocked",
      last_error_message: "骏河屋已阻止当前请求",
    });
  }, 10_000);

  it("keeps search filters out of strict Surugaya source config for scheduled bindings", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const serviceFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe("https://adapter.example/api/surugaya-search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        filters: Record<string, unknown>;
        sourceConfig?: Record<string, unknown>;
      };
      expect(body.query).toBe("氷菓");
      expect(body.filters).toMatchObject({
        availabilityMode: "purchasable",
        inStockOnly: true,
        page: 1,
        pageSize: 30,
        sort: "newest",
      });
      expect(body.sourceConfig).toEqual({ pages: 2 });
      return Response.json({
        ok: true,
        data: {
          sourceId: "surugaya",
          listings: [],
          coverage: "rolling_window",
          warnings: [],
          parserVersion: "surugaya-html-v2",
          fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", serviceFetch);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();
    await seedBinding("surugaya-filter-boundary", "surugaya");
    await testDatabase.prepare("UPDATE watch_bindings SET source_config_json=? WHERE id='surugaya-filter-boundary'")
      .bind(JSON.stringify({ pages: 2, availabilityMode: "purchasable", inStockOnly: true })).run();

    const configuredEnv = {
      ...env,
      SURUGAYA_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env;
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "surugaya-filter-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "surugaya-filter-boundary",
        trigger: "manual",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, configuredEnv);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["surugaya-filter-message"]);
    expect(serviceFetch).toHaveBeenCalledTimes(1);
    const run = await testDatabase.prepare(
      "SELECT status,error_code,error_message FROM watch_runs WHERE watch_binding_id='surugaya-filter-boundary'",
    ).first<{ status: string; error_code: string | null; error_message: string | null }>();
    expect(run).toEqual({ status: "success", error_code: null, error_message: null });
  });

  it("stages raw market evidence and queues cleaning only for first-seen market listings", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const listing: NormalizedListing = {
      sourceId: "mercari_jp",
      sourceItemId: "m-market-1",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m-market-1",
      title: "千反田える アクリルスタンド",
      imageUrl: "https://static.mercdn.net/item/detail/orig/photos/m-market-1_1.jpg",
      currency: "JPY",
      currentPrice: 3_200,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
      facts: { workTitle: "氷菓", characters: ["千反田える"], categoryPath: ["アクリルスタンド"] },
      rawMetadata: { upstreamPayload: "retained-for-reanalysis" },
    };
    let marketFetchCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      marketFetchCount += 1;
      return Response.json({
        ok: true,
        data: {
          sourceId: "mercari_jp",
          listings: marketFetchCount <= 2
            ? [{ ...listing, currentPrice: marketFetchCount === 1 ? 3_200 : 3_000 }]
            : [],
          coverage: "rolling_window",
          warnings: [],
          parserVersion: "mercari-internal-v1",
          fetchedAt: "2026-07-13T15:00:00.000Z",
        },
      });
    }));
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='mercari_jp'").run();
    await seedBinding("market-run", "mercari_jp");
    await testDatabase.prepare(
      `UPDATE watch_bindings
       SET monitoring_purpose='keyword_market',schedule_interval_minutes=180,
           notify_new_listing=0,notify_price_drop=0,notify_restock=0,notify_sold_out=0
       WHERE id='market-run'`,
    ).run();
    await seedBinding("ordinary-keyword-run", "yahoo_shopping");
    expect(await configuredMarketSubscriptions(testDatabase)).toEqual([{
      key: "market:profile-market-run:氷菓",
      profileId: "profile-market-run",
      name: "Profile market-run",
      query: "氷菓",
      enabled: true,
      sources: ["mercari_jp"],
      nextRunAt: expect.any(String),
      lastSuccessAt: null,
      scopeVersion: {
        id: expect.stringMatching(/^market-scope:/),
        version: 1,
        scopeHash: expect.any(String),
        createdAt: expect.any(String),
      },
      schedule: {
        kind: "interval",
        intervalMinutes: 180,
        timeZone: "Asia/Tokyo",
      },
    }]);
    expect(await testDatabase.prepare(
      "SELECT subscription_key,version FROM market_scope_versions WHERE subscription_key=?",
    ).bind("market:profile-market-run:氷菓").first()).toEqual({
      subscription_key: "market:profile-market-run:氷菓",
      version: 1,
    });
    const configuredEnv = {
      ...env,
      MERCARI_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env;
    const job: MonitorJob = {
      type: "run_binding",
      bindingId: "market-run",
      trigger: "manual",
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "market-message",
      timestamp: new Date(),
      attempts: 1,
      body: job,
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, configuredEnv);
    const queueResult = await getQueueResult(batch, ctx);
    expect(queueResult.explicitAcks).toEqual(["market-message"]);

    const marketRun = await testDatabase.prepare(
      "SELECT id,status,result_count,new_count,changed_count FROM watch_runs WHERE watch_binding_id='market-run'",
    ).first<{ id: string; status: string; result_count: number; new_count: number; changed_count: number }>();
    expect(marketRun).toMatchObject({ status: "success", result_count: 1, new_count: 1, changed_count: 1 });

    const outbox = await testDatabase.prepare(
      "SELECT kind,reference_id,payload_json,status FROM analytics_outbox WHERE kind='watch_market'",
    ).first<{ kind: string; reference_id: string; payload_json: string; status: string }>();
    expect(outbox).toMatchObject({ kind: "watch_market", reference_id: marketRun!.id, status: "queued" });
    const payload = JSON.parse(outbox!.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      origin: "watch_keyword",
      subscriptionKey: "market:profile-market-run:氷菓",
      subscriptionName: "Profile market-run",
      bindingId: "market-run",
      scopeVersion: {
        id: expect.stringMatching(/^market-scope:/),
        version: 1,
      },
      filters: { monitoringPurpose: "keyword_market", scheduleIntervalMinutes: 180 },
      resultCount: 1,
      groups: [{ listings: [{ title: listing.title, currentPrice: 3_200, facts: { categoryPath: ["アクリルスタンド"] } }] }],
    });
    expect(outbox!.payload_json).toContain("retained-for-reanalysis");
    expect(outbox!.payload_json).toContain("static.mercdn.net");
    expect(parseMarketAnalyticsRun(outbox!.payload_json)).toMatchObject({
      origin: "watch_keyword",
      subscriptionKey: "market:profile-market-run:氷菓",
      groups: [{ listings: [{
        sourceItemId: "m-market-1",
        productMatchMethod: expect.any(String),
        currentPrice: 3_200,
      }] }],
    });

    const operationalCounts = await testDatabase.batch([
      testDatabase.prepare("SELECT count(*) count FROM listings WHERE source_id='mercari_jp' AND source_item_id='m-market-1'"),
      testDatabase.prepare("SELECT count(*) count FROM listing_snapshots WHERE listing_id IN (SELECT id FROM listings WHERE source_id='mercari_jp' AND source_item_id='m-market-1')"),
      testDatabase.prepare("SELECT count(*) count FROM watch_listing_matches WHERE watch_binding_id='market-run'"),
      testDatabase.prepare("SELECT count(*) count FROM events WHERE watch_binding_id='market-run'"),
    ]);
    expect(operationalCounts.map((result) => Number((result.results[0] as { count: number }).count))).toEqual([1, 1, 1, 0]);
    expect(await testDatabase.prepare(
      "SELECT state,request_succeeded,parse_succeeded,normalized_result_count FROM source_health_snapshots WHERE watch_run_id=?",
    ).bind(marketRun!.id).first()).toEqual({
      state: "healthy",
      request_succeeded: 1,
      parse_succeeded: 1,
      normalized_result_count: 1,
    });
    const cleaningJob = await testDatabase.prepare(
      "SELECT kind,status,total_items,payload_json FROM gemini_jobs WHERE binding_id='market-run'",
    ).first<{ kind: string; status: string; total_items: number; payload_json: string }>();
    expect(cleaningJob).toMatchObject({ kind: "listing_enrichment", status: "queued", total_items: 1 });
    expect(JSON.parse(cleaningJob!.payload_json)).toMatchObject({
      query: "氷菓",
      market: {
        subscriptionKey: "market:profile-market-run:氷菓",
        scopeVersionId: expect.stringMatching(/^market-scope:/),
        bindingId: "market-run",
        events: [{ kind: "new", firstSeenRunId: marketRun!.id }],
      },
      items: [{ sourceItemId: "m-market-1" }],
    });

    const repeatBatch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "market-repeat-message",
      timestamp: new Date(),
      attempts: 1,
      body: { ...job, queuedAt: new Date().toISOString() },
    }]);
    const repeatCtx = createExecutionContext();
    await worker.queue(repeatBatch, configuredEnv);
    expect((await getQueueResult(repeatBatch, repeatCtx)).explicitAcks).toEqual(["market-repeat-message"]);
    const repeatedRun = await testDatabase.prepare(
      `SELECT status,new_count,changed_count FROM watch_runs
       WHERE watch_binding_id='market-run' ORDER BY started_at DESC LIMIT 1`,
    ).first<{ status: string; new_count: number; changed_count: number }>();
    expect(repeatedRun).toEqual({ status: "success", new_count: 0, changed_count: 1 });
    const cleaningJobCount = await testDatabase.prepare(
      "SELECT count(*) count FROM gemini_jobs WHERE binding_id='market-run'",
    ).first<{ count: number }>();
    expect(Number(cleaningJobCount?.count)).toBe(1);

    await testDatabase.prepare(
      "UPDATE watch_runs SET result_count=12 WHERE watch_binding_id='market-run' AND status='success'",
    ).run();
    const emptyBatch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "market-abnormal-empty-message",
      timestamp: new Date(),
      attempts: 1,
      body: { ...job, queuedAt: new Date().toISOString() },
    }]);
    await worker.queue(emptyBatch, configuredEnv);
    const abnormalRun = await testDatabase.prepare(
      `SELECT id,status,result_count,error_code FROM watch_runs
       WHERE watch_binding_id='market-run' ORDER BY started_at DESC LIMIT 1`,
    ).first<{ id: string; status: string; result_count: number; error_code: string }>();
    expect(abnormalRun).toMatchObject({ status: "failed", result_count: 0, error_code: "parser_structure_error" });
    expect(await testDatabase.prepare(
      "SELECT state,request_succeeded,parse_succeeded,abnormal_empty FROM source_health_snapshots WHERE watch_run_id=?",
    ).bind(abnormalRun!.id).first()).toEqual({
      state: "suspected_degradation",
      request_succeeded: 1,
      parse_succeeded: 0,
      abnormal_empty: 1,
    });
    const abnormalOutbox = await testDatabase.prepare(
      "SELECT payload_json FROM analytics_outbox WHERE kind='watch_market' AND reference_id=?",
    ).bind(abnormalRun!.id).first<{ payload_json: string }>();
    expect(JSON.parse(abnormalOutbox!.payload_json)).toMatchObject({
      status: "failed",
      resultCount: 0,
      groups: [{
        status: "failed",
        errorCode: "parser_structure_error",
        health: { state: "suspected_degradation", abnormalEmpty: true },
      }],
    });
  });

  it("returns only source products owned by a single-item dossier in the product library", async () => {
    const repository = new RadarRepository(testDatabase);
    const marketSeed = await seedBinding("library-market", "yahoo_shopping");
    await testDatabase.prepare(
      "UPDATE watch_bindings SET monitoring_purpose='keyword_market',notify_new_listing=0 WHERE id=?",
    ).bind(marketSeed.id).run();
    const marketBinding = (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?")
      .bind(marketSeed.id).first<WatchBindingRow>())!;
    await repository.persistListing(marketBinding, {
      sourceId: "yahoo_shopping",
      sourceItemId: "market-only-item",
      identityScope: "listing",
      canonicalUrl: "https://store.shopping.yahoo.co.jp/shop/market-only-item.html",
      title: "千反田 行情样本",
      currency: "JPY",
      currentPrice: 2_400,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });

    const itemSeed = await seedBinding("library-item", "yahoo_shopping");
    await testDatabase.prepare(
      `UPDATE watch_bindings
       SET kind='item',query=NULL,target_url='https://store.shopping.yahoo.co.jp/shop/item-dossier.html',
           source_item_id='item-dossier',monitoring_purpose='item_price',enabled=0,notify_new_listing=0
       WHERE id=?`,
    ).bind(itemSeed.id).run();
    const itemBinding = (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?")
      .bind(itemSeed.id).first<WatchBindingRow>())!;
    const itemStored = await repository.persistListing(itemBinding, {
      sourceId: "yahoo_shopping",
      sourceItemId: "item-dossier",
      identityScope: "listing",
      canonicalUrl: "https://store.shopping.yahoo.co.jp/shop/item-dossier.html",
      title: "明确建立的单品档案",
      currency: "JPY",
      currentPrice: 4_800,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });

    const { sql, values } = listingLibraryQuery({ source: null, query: null });
    const rows = values.length
      ? await testDatabase.prepare(sql).bind(...values).all<{ id: string; watch_binding_id: string; watch_enabled: number }>()
      : await testDatabase.prepare(sql).all<{ id: string; watch_binding_id: string; watch_enabled: number }>();
    expect(rows.results.map((row) => ({
      id: row.id,
      watch_binding_id: row.watch_binding_id,
      watch_enabled: row.watch_enabled,
    }))).toEqual([{ id: itemStored.listingId, watch_binding_id: "library-item", watch_enabled: 0 }]);
  });

  it("pins a live sold Mercari detail as a candidate and returns it through manual history search without events", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const listing: NormalizedListing = {
      sourceId: "mercari_jp",
      sourceItemId: "m43570223189",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m43570223189",
      title: "HAC オリジナル 雪ミク機 ネックストラップ 青",
      currency: "JPY",
      currentPrice: 1_222,
      priceBasis: "listing_price",
      condition: "used",
      availability: "sold_out",
      rawMetadata: { sourceStatus: "sold_out" },
    };
    let searchRequest: Record<string, unknown> | undefined;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      if (url.pathname === "/api/item") return Response.json({ ok: true, data: listing });
      expect(url.pathname).toBe("/api/search");
      searchRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        data: {
          sourceId: "mercari_jp",
          listings: [listing],
          coverage: "rolling_window",
          warnings: ["1 个历史候选已用本次 Mercari 详情响应实时复核；本地候选索引未提供价格或状态"],
          parserVersion: "mercari-internal-v1",
          fetchedAt: new Date().toISOString(),
          requestEvidence: {
            availabilityMode: "sold_out",
            requestedStatuses: ["STATUS_SOLD_OUT", "STATUS_TRADING"],
            rawResultCount: 1,
            keywordRawResultCount: 0,
            liveDetailResultCount: 1,
            anchorCandidateCount: 1,
            normalizedResultCount: 1,
            pagesFetched: 1,
          },
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='mercari_jp'").run();
    const configuredEnv = {
      ...env,
      MERCARI_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env;

    const detail = await worker.fetch(
      new Request("https://collector.test/internal/listing-detail-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "mercari_jp",
          sourceItemId: listing.sourceItemId,
          targetUrl: listing.canonicalUrl,
        }),
      }) as Parameters<typeof worker.fetch>[0],
      configuredEnv,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ listing: { sourceItemId: listing.sourceItemId, availability: "sold_out" } });
    expect(await testDatabase.prepare(
      "SELECT source_item_id,title_hint,pinned FROM source_history_anchors WHERE source_id='mercari_jp'",
    ).first()).toMatchObject({ source_item_id: listing.sourceItemId, title_hint: listing.title, pinned: 1 });

    const preview = await worker.fetch(
      new Request("https://collector.test/internal/search-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
          sources: ["mercari_jp", "surugaya"],
          conditions: ["used"],
          availabilityMode: "sold_out",
        }),
      }) as Parameters<typeof worker.fetch>[0],
      configuredEnv,
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{
      groups: Array<{ sourceId: string; status: string; errorCode?: string; listings: NormalizedListing[] }>;
    }>();
    expect(previewBody.groups).toMatchObject([
      { sourceId: "mercari_jp", status: "success", listings: [{ sourceItemId: listing.sourceItemId, availability: "sold_out" }] },
      { sourceId: "surugaya", status: "failed", errorCode: "history_search_unsupported", listings: [] },
    ]);
    expect(searchRequest).toMatchObject({
      query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      filters: { availabilityMode: "sold_out", pageSize: 120 },
      sourceConfig: { historyItemIds: [listing.sourceItemId] },
    });
    const snapshot = await testDatabase.prepare("SELECT group_json FROM search_result_snapshots WHERE source_id='mercari_jp'")
      .first<{ group_json: string }>();
    expect(JSON.parse(snapshot!.group_json)).toMatchObject({
      requestEvidence: {
        requestedStatuses: ["STATUS_SOLD_OUT", "STATUS_TRADING"],
        keywordRawResultCount: 0,
        liveDetailResultCount: 1,
      },
      listings: [{ sourceItemId: listing.sourceItemId, currentPrice: 1_222, availability: "sold_out" }],
    });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM events").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("merges current Mercari results with bounded live history candidates in all mode without notification side effects", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const currentListing: NormalizedListing = {
      sourceId: "mercari_jp",
      sourceItemId: "m27930309484",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m27930309484",
      title: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      currency: "JPY",
      currentPrice: 3_800,
      priceBasis: "listing_price",
      condition: "new",
      availability: "available",
      rawMetadata: { sourceStatus: "ITEM_STATUS_ON_SALE" },
    };
    const historyListings: NormalizedListing[] = [{
      sourceId: "mercari_jp",
      sourceItemId: "m43570223189",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m43570223189",
      title: "HAC オリジナル 雪ミク機 ネックストラップ 青",
      currency: "JPY",
      currentPrice: 1_222,
      priceBasis: "listing_price",
      condition: "unknown",
      availability: "sold_out",
      rawMetadata: { sourceStatus: "sold_out" },
    }, {
      sourceId: "mercari_jp",
      sourceItemId: "m90671490011",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m90671490011",
      title: "JAL（HACオリジナル） 雪ミク機 ネックストラップ（青）",
      currency: "JPY",
      currentPrice: 1_300,
      priceBasis: "listing_price",
      condition: "unknown",
      availability: "sold_out",
      rawMetadata: { sourceStatus: "sold_out" },
    }];
    const verifiedAt = new Date().toISOString();
    await testDatabase.batch(historyListings.map((listing) => testDatabase.prepare(
      `INSERT INTO source_history_anchors(
        source_id,source_item_id,title_hint,pinned,first_verified_at,last_verified_at
       ) VALUES(?,?,?,1,?,?)`,
    ).bind(listing.sourceId, listing.sourceItemId, listing.title, verifiedAt, verifiedAt)));
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='mercari_jp'").run();

    let searchRequest: Record<string, unknown> | undefined;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      searchRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const sourceConfig = searchRequest.sourceConfig as Record<string, unknown> | undefined;
      const candidateIds = Array.isArray(sourceConfig?.historyItemIds) ? sourceConfig.historyItemIds : [];
      const refreshedListings = historyListings.filter((listing) => candidateIds.includes(listing.sourceItemId));
      const listings = [currentListing, ...refreshedListings];
      return Response.json({
        ok: true,
        data: {
          sourceId: "mercari_jp",
          listings,
          coverage: "rolling_window",
          warnings: refreshedListings.length
            ? [`${refreshedListings.length} 个历史候选已用本次 Mercari 详情响应实时复核；本地候选索引未提供价格或状态`]
            : [],
          parserVersion: "mercari-internal-v1",
          fetchedAt: new Date().toISOString(),
          totalAvailable: 1,
          requestEvidence: {
            availabilityMode: "all",
            requestedStatuses: ["STATUS_ON_SALE", "STATUS_SOLD_OUT", "STATUS_TRADING"],
            rawResultCount: listings.length,
            keywordRawResultCount: 1,
            liveDetailResultCount: refreshedListings.length,
            anchorCandidateCount: candidateIds.length,
            normalizedResultCount: listings.length,
            pagesFetched: 1,
          },
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const configuredEnv = {
      ...env,
      MERCARI_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env;

    const preview = await worker.fetch(
      new Request("https://collector.test/internal/search-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
          sources: ["mercari_jp"],
          conditions: [],
          availabilityMode: "all",
        }),
      }) as Parameters<typeof worker.fetch>[0],
      configuredEnv,
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{
      historyId: string;
      groups: Array<{ sourceId: string; status: string; listings: NormalizedListing[] }>;
    }>();
    expect(previewBody.groups).toMatchObject([{
      sourceId: "mercari_jp",
      status: "success",
      listings: [
        { sourceItemId: "m27930309484", availability: "available" },
        { sourceItemId: "m43570223189", availability: "sold_out" },
        { sourceItemId: "m90671490011", availability: "sold_out" },
      ],
    }]);
    expect(searchRequest).toMatchObject({
      filters: { availabilityMode: "all", pageSize: 30, sort: "newest" },
      sourceConfig: { historyItemIds: ["m43570223189", "m90671490011"] },
    });
    const history = await testDatabase.prepare(
      "SELECT filters_json,result_count FROM search_history WHERE id=?",
    ).bind(previewBody.historyId).first<{ filters_json: string; result_count: number }>();
    expect(history?.result_count).toBe(3);
    expect(JSON.parse(history!.filters_json)).toMatchObject({ availabilityMode: "all", conditions: [] });
    const snapshot = await testDatabase.prepare(
      "SELECT group_json FROM search_result_snapshots WHERE search_history_id=? AND source_id='mercari_jp'",
    ).bind(previewBody.historyId).first<{ group_json: string }>();
    expect(JSON.parse(snapshot!.group_json)).toMatchObject({
      requestEvidence: {
        keywordRawResultCount: 1,
        liveDetailResultCount: 2,
        anchorCandidateCount: 2,
        normalizedResultCount: 3,
      },
    });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM events").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM notice_deliveries WHERE channel='email'").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("uses one budgeted Firecrawl Basic JP search fallback without fetching product details", async () => {
    const calls: string[] = [];
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.origin}${url.pathname}`);
      if (url.hostname === "www.suruga-ya.jp") {
        expect(url.pathname).toBe("/search");
        return new Response("forbidden", { status: 403, headers: { "Content-Type": "text/html" } });
      }
      if (url.hostname === "api.firecrawl.dev" && url.pathname === "/v2/team/credit-usage") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer firecrawl-test-key");
        return Response.json({
          success: true,
          data: {
            remainingCredits: 1000,
            planCredits: 1000,
            billingPeriodStart: "2026-07-23T00:23:31.852Z",
            billingPeriodEnd: "2026-08-23T00:23:31.852Z",
          },
        });
      }
      if (url.hostname === "api.firecrawl.dev" && url.pathname === "/v2/scrape") {
        const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(requestBody).toMatchObject({
          formats: ["rawHtml"],
          proxy: "basic",
          location: { country: "JP", languages: ["ja"] },
          maxAge: 300000,
          storeInCache: true,
        });
        expect(String(requestBody.url)).toContain("https://www.suruga-ya.jp/search?");
        return Response.json({
          success: true,
          data: {
            rawHtml: soldOutSurugayaSearchFixture(),
            metadata: { sourceURL: requestBody.url, statusCode: 200, cacheState: "miss" },
          },
        });
      }
      throw new Error(`unexpected provider URL ${url.origin}${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='surugaya'").run();
    const response = await worker.fetch(new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "エミリア", sources: ["surugaya"], inStockOnly: false }),
    }) as Parameters<typeof worker.fetch>[0], {
      ...env,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
      BROWSER_RUN_FALLBACK_ENABLED: "false",
      FIRECRAWL_API_KEY: "firecrawl-test-key",
      SURUGAYA_ADAPTER_URL: "",
      MERCARI_ADAPTER_SIGNING_KEY: "",
    } as Env);
    const body = await response.json<{ groups: Array<{
      status: string;
      requestRoute: string;
      listings: NormalizedListing[];
      warnings: string[];
      routeOutcome: Record<string, unknown>;
    }> }>();
    expect(body.groups[0]).toMatchObject({
      status: "success",
      requestRoute: "managed_api",
      listings: [{ sourceItemId: "646170273", availability: "sold_out" }],
      routeOutcome: {
        kind: "fallback_success",
        primaryRoute: "direct",
        fallbackRoute: "managed_api",
        provider: "firecrawl",
        cacheStatus: "miss",
      },
    });
    expect(body.groups[0]?.warnings.join(" ")).toContain("不执行托管商品详情补抓");
    expect(calls).toEqual([
      "GET https://www.suruga-ya.jp/search",
      "GET https://api.firecrawl.dev/v2/team/credit-usage",
      "POST https://api.firecrawl.dev/v2/scrape",
    ]);
    const usage = await testDatabase.prepare(
      "SELECT period_started_at,period_ends_at,runtime_budget,runtime_calls,emergency_reserve FROM managed_api_billing_usage WHERE provider='firecrawl'",
    ).first<Record<string, unknown>>();
    expect(usage).toMatchObject({
      period_started_at: "2026-07-23T00:23:31.852Z",
      period_ends_at: "2026-08-23T00:23:31.852Z",
      runtime_budget: 900,
      runtime_calls: 1,
      emergency_reserve: 100,
    });
    const captures = await testDatabase.prepare(
      "SELECT request_url,payload_kind,raw_payload,payload_bytes,content_hash FROM source_response_captures WHERE source_id='surugaya' ORDER BY ordinal",
    ).all<{
      request_url: string;
      payload_kind: string;
      raw_payload: string | null;
      payload_bytes: number;
      content_hash: string;
    }>();
    expect(captures.results.map((capture) => new URL(capture.request_url).pathname)).toEqual(["/search", "/v2/scrape"]);
    expect(captures.results[1]).toMatchObject({
      payload_kind: "html",
      raw_payload: null,
    });
    expect(captures.results[1]?.payload_bytes).toBeGreaterThan(0);
    expect(captures.results[1]?.content_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(captures.results.some((capture) => capture.raw_payload?.includes("firecrawl-test-key"))).toBe(false);
  });

  it("rejects a standalone Surugaya probe because real collection now supplies health evidence", async () => {
    const response = await worker.fetch(
      new Request("https://collector.test/internal/start-probe/surugaya", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "surugaya_probe_retired" });
  });

  it("retries one JSON-formatted platform 502 without retrying beyond the bound", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const timestamps: string[] = [];
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      timestamps.push(new Headers(init?.headers).get("X-JPGR-Timestamp") ?? "");
      if (timestamps.length === 1) {
        return Response.json({ ok: false, error: { code: "FUNCTION_INVOCATION_FAILED", message: "temporary platform error" } }, { status: 502 });
      }
      return Response.json({
        ok: true,
        data: {
          sourceId: "surugaya",
          listings: [{
            sourceId: "surugaya", sourceItemId: "retry-json-502", identityScope: "listing",
            canonicalUrl: "https://www.suruga-ya.jp/product/detail/retry-json-502", title: "氷菓",
            currency: "JPY", currentPrice: 1_000, priceBasis: "listing_price", condition: "used", availability: "available",
          }],
          coverage: "rolling_window", warnings: [], parserVersion: "surugaya-html-v2", fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/surugaya", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      { ...env, SURUGAYA_ADAPTER_URL: "https://adapter.example/", MERCARI_ADAPTER_SIGNING_KEY: privateKey } as Env,
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(timestamps[1]).not.toBe(timestamps[0]);
  });

  it("routes CharaON through the signed fixed-purpose service", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const independentFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe("https://adapter.example/api/source-search");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ sourceId: "charaon", request: { query: "文豪" } });
      return Response.json({
        ok: true,
        data: {
          sourceId: "charaon",
          listings: [{
            sourceId: "charaon", sourceItemId: "AZMGS92", identityScope: "catalog",
            canonicalUrl: "https://www.charaon.jp/SHOP/AZMGS92.html", title: "文豪ストレイドッグス 商品",
            imageUrl: "https://image1.shopserve.jp/charaon.jp/pic-labo/AZMGS92.jpg", currency: "JPY",
            currentPrice: 4620, priceBasis: "catalog_price", condition: "new", availability: "available",
            facts: { identifiers: { sku: "AZMGS92" }, brand: "CharaON", imageUrls: ["https://image1.shopserve.jp/charaon.jp/pic-labo/AZMGS92.jpg"] },
          }],
          coverage: "rolling_window", warnings: [], parserVersion: "charaon-html-v1", fetchedAt: new Date().toISOString(),
        },
      });
    });
    vi.stubGlobal("fetch", independentFetch);
    const fixedEnv = {
      ...env,
      SOURCE_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      FIXED_HTML_CLOUDFLARE_DIRECT_ENABLED: "false",
    } as Env;
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/charaon", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      fixedEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceId: "charaon", ok: true, resultCount: 1, requestRoute: "mercari_service" });
    const source = await testDatabase.prepare(
      "SELECT credential_status,health_status,request_route,last_signature_success_at FROM source_registry WHERE id='charaon'",
    ).first<Record<string, unknown>>();
    expect(source).toMatchObject({ credential_status: "not_required", health_status: "healthy", request_route: "mercari_service" });
    expect(source?.last_signature_success_at).toBeTruthy();

    const status = await worker.fetch(
      new Request("https://collector.test/internal/source-status") as Parameters<typeof worker.fetch>[0],
      fixedEnv,
    );
    expect(await status.json()).toMatchObject({
      sourceService: { configured: true, requestRoute: "mercari_service", sources: ["charaon", "cospa", "animate"] },
    });
    expect(independentFetch).toHaveBeenCalledTimes(1);
  });

  it("runs CharaON directly on Cloudflare when the fixed HTML migration is enabled", async () => {
    const upstream = vi.fn(async function (this: unknown, input: string | URL | Request) {
      expect(this).toBeUndefined();
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("www.charaon.jp");
      expect(url.pathname).toBe("/SHOP/list.php");
      return new Response(charaonSearchFixture(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);
    const directEnv = { ...env, FIXED_HTML_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env;
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/charaon", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      directEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sourceId: "charaon",
      ok: true,
      resultCount: 1,
      requestRoute: "direct",
      routeOutcome: { kind: "primary_success", route: "direct" },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testDatabase.prepare(
      "SELECT health_status,request_route,last_error_code FROM source_registry WHERE id='charaon'",
    ).first()).toMatchObject({ health_status: "healthy", request_route: "direct", last_error_code: null });
  });

  it("classifies repeated non-JSON service 502s without storing the response body", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    const upstream = vi.fn(async () => new Response("FUNCTION_INVOCATION_FAILED sensitive gateway body", {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Vercel-Id": "hnd1::failed-502" },
    }));
    vi.stubGlobal("fetch", upstream);
    const independentEnv = {
      ...env,
      SURUGAYA_ADAPTER_URL: "https://adapter.example/",
      SOURCE_RUNNER_URL: "",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
      FIRECRAWL_API_KEY: "",
    } as Env;
    const response = await worker.fetch(
      new Request("https://collector.test/internal/test-source/surugaya", { method: "POST" }) as Parameters<typeof worker.fetch>[0],
      independentEnv,
    );
    expect(response.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(2);
    const stored = await testDatabase.prepare(
      "SELECT last_http_status,last_error_code,last_error_message FROM source_registry WHERE id='surugaya'",
    ).first<{ last_http_status: number; last_error_code: string; last_error_message: string }>();
    expect(stored).toMatchObject({
      last_http_status: 502,
      last_error_code: "surugaya_service_platform_invalid_response",
    });
    expect(stored?.last_error_message).toContain("text/html");
    expect(stored?.last_error_message).toContain("hnd1::failed-502");
    expect(stored?.last_error_message).toContain("FUNCTION_INVOCATION_FAILED");
    expect(stored?.last_error_message).not.toContain("sensitive gateway body");
  });

  it("loads one fixed-source item detail on demand without creating a watch", async () => {
    await testDatabase.prepare("UPDATE source_registry SET enabled=1,health_status='healthy' WHERE id='rakuten_books'").run();
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toContain("/BooksTotal/Search/");
      expect(url.searchParams.get("isbnjan")).toBe("9784041064839");
      return Response.json({ items: [{
        isbn: "9784041064839",
        itemUrl: "https://books.rakuten.co.jp/rb/1/",
        title: "氷菓",
        itemPrice: 748,
        availability: "1",
        salesDate: "2026-03-01",
        author: "米澤穂信",
      }] });
    });
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(
      new Request("https://collector.test/internal/listing-detail-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "rakuten_books",
          sourceItemId: "9784041064839",
          targetUrl: "https://books.rakuten.co.jp/rb/1/",
        }),
      }) as Parameters<typeof worker.fetch>[0],
      { ...env, RAKUTEN_APPLICATION_ID: "app", RAKUTEN_ACCESS_KEY: "access" } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      listing: {
        sourceItemId: "9784041064839",
        sourceListedAt: "2026-03-01",
        rawMetadata: { author: "米澤穂信", identifiers: { isbn: "9784041064839" } },
      },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const watches = await testDatabase.prepare("SELECT COUNT(*) count FROM watch_bindings").first<{ count: number }>();
    expect(watches?.count).toBe(0);
  });

  it("manually triggers Cron, reserves due bindings and publishes to the local Queue", async () => {
    for (let index = 0; index < 81; index += 1) await seedBinding(`cron-${index}`, index % 2 ? "yahoo_shopping" : "rakuten_ichiba");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: hourlyMaintenanceTime(), cron: "* * * * *" }), {
      ...env,
      RAKUTEN_PRIVATE_MONITORING_ENABLED: "false",
      RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED: "true",
      RAKUTEN_BOOKS_PRIVATE_MONITORING_ENABLED: "false",
    } as Env, ctx);
    await waitOnExecutionContext(ctx);
    const due = await testDatabase.prepare("SELECT COUNT(*) count FROM watch_bindings WHERE next_run_at > ?").bind(new Date().toISOString()).first<{ count: number }>();
    const counters = await testDatabase.prepare("SELECT queued_jobs FROM daily_counters").first<{ queued_jobs: number }>();
    expect(due?.count).toBe(80);
    expect(counters?.queued_jobs).toBe(80);
    const heartbeat = await testDatabase.prepare("SELECT due_bindings,enqueued_jobs FROM cron_heartbeats").first<{ due_bindings: number; enqueued_jobs: number }>();
    expect(heartbeat).toEqual({ due_bindings: 80, enqueued_jobs: 80 });
  }, 15_000);

  it("keeps Tokyo 00:00-05:00 Cron collection quiet unless tonight is explicitly enabled", async () => {
    const binding = await seedBinding("overnight-quiet", "mercari_jp");
    const originalNextRunAt = binding.next_run_at;
    const quietScheduledTime = Date.UTC(2026, 7, 21, 16, 8, 0); // Tokyo 01:08

    const quietContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: quietScheduledTime, cron: "* * * * *" }),
      env,
      quietContext,
    );
    await waitOnExecutionContext(quietContext);
    const quietBinding = await testDatabase.prepare(
      "SELECT next_run_at FROM watch_bindings WHERE id='overnight-quiet'",
    ).first<{ next_run_at: string }>();
    expect(quietBinding?.next_run_at).toBe(originalNextRunAt);

    const expiresAt = new Date(quietScheduledTime + 4 * 60 * 60_000).toISOString();
    await testDatabase.prepare(
      `INSERT INTO runtime_feature_flags(flag_key,enabled,config_json,updated_at)
       VALUES('overnight_collection_override_v1',1,?,?)`,
    ).bind(JSON.stringify({ schemaVersion: 1, expiresAt }), new Date().toISOString()).run();

    const enabledContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: quietScheduledTime, cron: "* * * * *" }),
      env,
      enabledContext,
    );
    await waitOnExecutionContext(enabledContext);
    const enabledBinding = await testDatabase.prepare(
      "SELECT next_run_at FROM watch_bindings WHERE id='overnight-quiet'",
    ).first<{ next_run_at: string }>();
    expect(enabledBinding?.next_run_at).not.toBe(originalNextRunAt);
  });

  it("prunes only durable raw captures after three days and keeps failed evidence for fourteen days", async () => {
    const now = new Date().toISOString();
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await testDatabase.batch([
      testDatabase.prepare(
        `INSERT INTO analytics_outbox(
          id,kind,reference_id,payload_json,status,processed_at,created_at,updated_at
         ) VALUES(?, 'watch_market', ?, ?, 'succeeded', ?, ?, ?)`,
      ).bind("retention-outbox-old", "retention-run-old", '{"archived":true}', daysAgo(4), daysAgo(4), now),
      testDatabase.prepare(
        `INSERT INTO analytics_outbox(
          id,kind,reference_id,payload_json,status,processed_at,created_at,updated_at
         ) VALUES(?, 'watch_market', ?, ?, 'succeeded', ?, ?, ?)`,
      ).bind("retention-outbox-recent", "retention-run-recent", '{"recent":true}', daysAgo(2), daysAgo(2), now),
      testDatabase.prepare(
        `INSERT INTO analytics_outbox(
          id,kind,reference_id,payload_json,status,created_at,updated_at
         ) VALUES(?, 'watch_market', ?, ?, 'failed', ?, ?)`,
      ).bind("retention-outbox-failed", "retention-run-failed", '{"retry":true}', daysAgo(4), now),
      testDatabase.prepare(
        `INSERT INTO analytics_outbox(
          id,kind,reference_id,payload_json,status,created_at,updated_at
         ) VALUES(?, 'watch_market', ?, ?, 'failed', ?, ?)`,
      ).bind("retention-outbox-expired", "retention-run-expired", '{"expired":true}', daysAgo(15), now),
    ]);
    const capture = (
      id: string,
      runId: string,
      capturedAt: string,
    ) => testDatabase.prepare(
      `INSERT INTO source_response_captures(
        id,run_id,source_id,ordinal,request_url,request_method,payload_kind,
        raw_payload,payload_bytes,content_hash,captured_at
       ) VALUES(?,?, 'retention-test',1,'https://example.test/raw','GET','json','{}',2,?,?)`,
    ).bind(id, runId, `hash-${id}`, capturedAt);
    await testDatabase.batch([
      capture("retention-capture-old", "retention-run-old", daysAgo(4)),
      capture("retention-capture-recent", "retention-run-recent", daysAgo(2)),
      capture("retention-capture-failed", "retention-run-failed", daysAgo(4)),
      capture("retention-capture-expired", "retention-run-expired", daysAgo(15)),
      capture("retention-capture-missing", "retention-run-missing", daysAgo(4)),
    ]);

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: hourlyMaintenanceTime(), cron: "* * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const captures = await testDatabase.prepare(
      "SELECT id FROM source_response_captures WHERE source_id='retention-test' ORDER BY id",
    ).all<{ id: string }>();
    expect(captures.results.map(({ id }) => id)).toEqual([
      "retention-capture-failed",
      "retention-capture-missing",
      "retention-capture-recent",
    ]);
    const outboxes = await testDatabase.prepare(
      `SELECT id,payload_json FROM analytics_outbox
       WHERE id IN ('retention-outbox-old','retention-outbox-recent') ORDER BY id`,
    ).all<{ id: string; payload_json: string | null }>();
    expect(outboxes.results).toEqual([
      { id: "retention-outbox-old", payload_json: null },
      { id: "retention-outbox-recent", payload_json: '{"recent":true}' },
    ]);
  });

  it("queues a 30-minute watch on a non-hourly minute without running hourly maintenance", async () => {
    await seedBinding("half-hour", "yahoo_shopping");
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await testDatabase.prepare(
      "UPDATE watch_bindings SET schedule_interval_minutes=30,next_run_at=? WHERE id='half-hour'",
    ).bind(dueAt).run();
    const scheduled = new Date();
    scheduled.setUTCMinutes(8, 0, 0);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: scheduled.getTime(), cron: "* * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const binding = await testDatabase.prepare(
      "SELECT next_run_at,schedule_interval_minutes FROM watch_bindings WHERE id='half-hour'",
    ).first<{ next_run_at: string; schedule_interval_minutes: number }>();
    expect(binding?.schedule_interval_minutes).toBe(30);
    expect(Date.parse(binding!.next_run_at)).toBeGreaterThan(Date.now());
    expect(Date.parse(binding!.next_run_at) - Date.parse(dueAt)).toBe(30 * 60_000);
    const heartbeats = await testDatabase.prepare("SELECT COUNT(*) count FROM cron_heartbeats").first<{ count: number }>();
    expect(heartbeats?.count).toBe(0);
  });

  it("delivers a retried pending email on the hourly Collector run even without active watches", async () => {
    await testDatabase.prepare(
      `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
       VALUES('retry-event','source_error:test:retry','source_error',?,'pending',?)`,
    ).bind(JSON.stringify({ sourceId: "surugaya", code: "temporary", message: "暂时失败" }), new Date().toISOString()).run();
    const resend = vi.fn(async () => Response.json({ id: "email_retry_1" }));
    vi.stubGlobal("fetch", resend);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: hourlyMaintenanceTime(), cron: "* * * * *" }), {
      ...env,
      RAKUTEN_APPLICATION_ID: "",
      RAKUTEN_ACCESS_KEY: "",
      YAHOO_CLIENT_ID: "",
      RESEND_API_KEY: "test",
      ALERT_EMAIL_FROM: "Radar <alerts@radar.test>",
      ALERT_EMAIL_TO: "owner@radar.test",
    } as Env, ctx);
    await waitOnExecutionContext(ctx);
    const event = await testDatabase.prepare("SELECT status FROM events WHERE id='retry-event'").first<{ status: string }>();
    expect(event?.status).toBe("sent");
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("starts an experimental source independently and applies the 48-hour thresholds", async () => {
    const repository = new RadarRepository(testDatabase);
    await repository.startSourceProbe("mercari_jp");
    const binding = await seedBinding("probe-mercari", "mercari_jp");
    const oldStart = new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString();
    await testDatabase.prepare(
      `UPDATE source_probe_windows SET started_at=?,total_runs=47,successful_runs=45,field_total=282,field_complete=282 WHERE source_id='mercari_jp'`,
    ).bind(oldStart).run();
    const run = await repository.createRun(binding.id, "manual");
    await repository.finishRun(run, { status: "success", coverage: "best_effort", resultCount: 1, newCount: 0, changedCount: 0,
      fieldTotal: 6, fieldComplete: 6 });
    const probe = await testDatabase.prepare(
      "SELECT status,total_runs,successful_runs,decision_reason FROM source_probe_windows WHERE source_id='mercari_jp'",
    ).first<{ status: string; total_runs: number; successful_runs: number; decision_reason: string }>();
    expect(probe).toMatchObject({ status: "passed", total_runs: 48, successful_runs: 46 });
    expect(probe?.decision_reason).toContain("全部指标通过");
    const final = await testDatabase.prepare("SELECT status FROM verification_checks WHERE scope='final' AND check_key='mercari_jp'").first<{ status: string }>();
    expect(final?.status).toBe("passed");
  });

  it("archives a failed route window before restarting a genuine 48-hour window", async () => {
    const repository = new RadarRepository(testDatabase);
    const first = await repository.startSourceProbe("surugaya");
    await repository.recordSourceProbeObservation("surugaya", {
      status: "blocked", coverage: "rolling_window", resultCount: 0, newCount: 0, changedCount: 0,
      httpStatus: 403, errorCode: "surugaya_blocked", errorMessage: "骏河屋已阻止当前请求",
    });
    await testDatabase.prepare("UPDATE source_registry SET request_route='mercari_service' WHERE id='surugaya'").run();
    const restarted = await repository.restartSourceProbeForRouteChange("surugaya");

    expect(restarted).toMatchObject({ previousRequestRoute: "direct", requestRoute: "mercari_service" });
    expect(restarted.startedAt).not.toBe(first.startedAt);
    const [history, current, observation] = await Promise.all([
      testDatabase.prepare(
        "SELECT status,request_route,started_at,total_runs,successful_runs,archive_reason,next_request_route FROM source_probe_window_history WHERE source_id='surugaya'",
      ).first<Record<string, unknown>>(),
      testDatabase.prepare(
        "SELECT status,request_route,started_at,total_runs,successful_runs FROM source_probe_windows WHERE source_id='surugaya'",
      ).first<Record<string, unknown>>(),
      testDatabase.prepare(
        "SELECT window_started_at,http_status,error_code FROM source_probe_observations WHERE source_id='surugaya'",
      ).first<Record<string, unknown>>(),
    ]);
    expect(history).toMatchObject({ status: "running", request_route: "direct", started_at: first.startedAt, total_runs: 1,
      successful_runs: 0, archive_reason: "request_route_changed", next_request_route: "mercari_service" });
    expect(current).toMatchObject({ status: "running", request_route: "mercari_service", started_at: restarted.startedAt,
      total_runs: 0, successful_runs: 0 });
    expect(observation).toMatchObject({ window_started_at: first.startedAt, http_status: 403, error_code: "surugaya_blocked" });
    await expect(repository.restartSourceProbeForRouteChange("surugaya")).rejects.toThrow("probe_request_route_unchanged");
  });

  it("marks HTML isolation only after both official sources succeed after an experimental failure", async () => {
    const repository = new RadarRepository(testDatabase);
    await repository.startSourceProbe("surugaya");
    await repository.recordSourceProbeObservation("surugaya", {
      status: "blocked", coverage: "rolling_window", resultCount: 0, newCount: 0, changedCount: 0,
      httpStatus: 403, errorCode: "surugaya_blocked", errorMessage: "blocked",
    });
    expect(await repository.markHtmlIsolationIfProven()).toBe(false);

    const afterFailure = new Date(Date.now() + 1_000).toISOString();
    await testDatabase.prepare(
      "UPDATE source_registry SET health_status='healthy',last_success_at=? WHERE id IN ('rakuten_ichiba','rakuten_books')",
    ).bind(afterFailure).run();
    expect(await repository.markHtmlIsolationIfProven()).toBe(true);
    const check = await testDatabase.prepare(
      "SELECT status,evidence_json FROM verification_checks WHERE scope='final' AND check_key='html_isolation'",
    ).first<{ status: string; evidence_json: string }>();
    expect(check?.status).toBe("passed");
    expect(JSON.parse(check!.evidence_json)).toMatchObject({
      experimentalFailure: { sourceId: "surugaya", status: "blocked" },
      result: "official_sources_succeeded_after_experimental_source_failure",
    });
  });

  it("does not run a retired Surugaya probe during hourly maintenance", async () => {
    const repository = new RadarRepository(testDatabase);
    await repository.startSourceProbe("surugaya");
    await testDatabase.prepare("UPDATE source_registry SET enabled=1 WHERE id='surugaya'").run();
    const sourceBefore = await testDatabase.prepare(
      "SELECT enabled,health_status,last_http_status,last_error_code,last_error_message FROM source_registry WHERE id='surugaya'",
    ).first<Record<string, unknown>>();
    const upstream = vi.fn(async () => {
      throw new Error("retired Surugaya probe must not request an upstream");
    });
    vi.stubGlobal("fetch", upstream);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: hourlyMaintenanceTime(), cron: "* * * * *" }), {
      ...env,
      RAKUTEN_APPLICATION_ID: "",
      RAKUTEN_ACCESS_KEY: "",
    } as Env, ctx);
    await waitOnExecutionContext(ctx);

    const [probe, source, rakuten] = await Promise.all([
      testDatabase.prepare("SELECT status,total_runs,successful_runs FROM source_probe_windows WHERE source_id='surugaya'")
        .first<{ status: string; total_runs: number; successful_runs: number }>(),
      testDatabase.prepare("SELECT enabled,health_status,last_http_status,last_error_code,last_error_message FROM source_registry WHERE id='surugaya'")
        .first<{ enabled: number; health_status: string; last_http_status: number | null; last_error_code: string | null; last_error_message: string | null }>(),
      testDatabase.prepare("SELECT health_status FROM source_registry WHERE id='rakuten_ichiba'").first<{ health_status: string }>(),
    ]);
    expect(upstream).not.toHaveBeenCalled();
    expect(probe).toEqual({ status: "running", total_runs: 0, successful_runs: 0 });
    expect(source).toEqual(sourceBefore);
    expect(rakuten?.health_status).toBe("unknown");
  });

  it("runs every documented official API P0 check with isolated live evidence", async () => {
    await testDatabase.prepare(
      "UPDATE verification_checks SET status='passed',verified_at=CURRENT_TIMESTAMP::text WHERE scope='p0' AND check_key LIKE 'resend_%'",
    ).run();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.toString());
      if (url.pathname.includes("IchibaItem/Search")) {
        const requested = url.searchParams.get("itemCode");
        const prefix = url.searchParams.get("keyword")?.includes("エミリア") ? "emilia" : "chitanda";
        const items = requested
          ? [{ itemCode: requested, itemUrl: "https://item.rakuten.co.jp/shop/detail/", itemName: "詳細", itemPrice: 5000,
              availability: 1, mediumImageUrls: [{ imageUrl: "https://img.example/detail.jpg" }] }]
          : Array.from({ length: 30 }, (_, index) => ({ itemCode: `shop:${prefix}-${index}`, itemUrl: `https://item.rakuten.co.jp/shop/${prefix}-${index}/`,
              itemName: `${prefix} ${index}`, itemPrice: 5000 + index, availability: 1,
              mediumImageUrls: [{ imageUrl: `https://img.example/${prefix}-${index}.jpg` }] }));
        return Response.json({ items });
      }
      if (url.pathname.includes("BooksTotal/Search")) {
        const prefix = url.searchParams.get("keyword")?.includes("Re:") ? "978404000001" : "978404000002";
        return Response.json({ items: Array.from({ length: 3 }, (_, index) => ({
          jan: `${prefix}${index}`, itemUrl: `https://books.rakuten.co.jp/rb/${prefix}${index}/`, title: `Blu-ray ${index}`,
          itemPrice: 7000 + index, availability: "1", salesDate: `2026-0${3 - index}-01`, largeImageUrl: `https://img.example/book-${index}.jpg`,
        })) });
      }
      if (url.pathname === "/v2/entities:search") {
        return Response.json({ meta: { nextPageToken: "v1:1", numFound: "30" }, items: Array.from({ length: 30 }, (_, index) => ({
          id: `m${String(10000000000 + index)}`, status: "ITEM_STATUS_ON_SALE", name: `千反田える ${index}`, price: String(3000 + index),
          created: String(1783000000 - index), updated: String(1783000000 - index), itemType: "ITEM_TYPE_MERCARI", itemConditionId: "2",
          thumbnails: [`https://static.mercdn.net/thumb/item/webp/m${index}.jpg`],
        })) });
      }
      if (url.pathname === "/items/get") {
        const id = url.searchParams.get("id") ?? "m10000000000";
        return Response.json({ result: "OK", data: { id, status: "on_sale", name: "千反田える 詳細", price: 3000,
          created: 1783000000, updated: 1783000000, photos: ["https://static.mercdn.net/item/detail/test.jpg"],
          item_condition: { id: "2" }, seller: { name: "test" } }, meta: {} });
      }
      if (url.pathname === "/search") {
        const items = Array.from({ length: 30 }, (_, index) => `<div class="item"><p class="thum"><a href="/product/detail/${900000000 + index}"><img src="https://www.suruga-ya.jp/database/photo.php?shinaban=${900000000 + index}&size=m"></a></p><div class="item_detail"><div class="title"><a href="/product/detail/${900000000 + index}"><h3 class="product-name">千反田える ${index}</h3></a></div><p class="condition background-kishu">フィギュア</p></div><div class="item_price"><p class="price_teika"><strong>￥${2000 + index}</strong></p></div></div>`).join("");
        return new Response(`<html><head><title>千反田える | 中古・新品通販の駿河屋</title></head><body><div id="search_result"><div class="item_box">${items}</div></div>${"x".repeat(9000)}</body></html>`, { status: 200 });
      }
      if (url.pathname.startsWith("/product/detail/")) {
        const id = url.pathname.split("/").pop() ?? "900000000";
        return new Response(`<html><head><title>商品 | 駿河屋</title><script type="application/ld+json">{"@type":"Product","name":"千反田える 詳細","image":"https://www.suruga-ya.jp/database/photo.php?shinaban=${id}&size=m","offers":{"price":"2000","availability":"https://schema.org/InStock"}}</script></head><body>${"x".repeat(9000)}</body></html>`, { status: 200 });
      }
      if (url.pathname.includes("/V3/itemSearch")) {
        const start = Number(url.searchParams.get("start") ?? 1);
        const condition = url.searchParams.get("condition") ?? "new";
        return Response.json({ hits: Array.from({ length: 50 }, (_, index) => ({
          code: `store_${start + index}`, url: `https://store.shopping.yahoo.co.jp/store/${start + index}.html`,
          name: `${condition === "used" ? "中古" : "新品"} ${start + index}`, condition, inStock: true,
          price: 5000 + index, exImage: { url: `https://img.example/yahoo-${start + index}.jpg` }, seller: { name: "store" },
          isCrossBorderAgency: index % 2 === 0,
        })) });
      }
      if (url.pathname.includes("/V1/json/itemLookup")) {
        const code = url.searchParams.get("itemcode") ?? "store_1";
        return Response.json({ ResultSet: { Result: { Hit: { "0": { Code: code, Name: "中古 商品",
          Url: "http://store.shopping.yahoo.co.jp/store/1.html", Price: { _value: "5000", _attributes: { currency: "JPY" } },
          Availability: "instock", ExImage: { Url: "https://img.example/yahoo-detail.jpg" }, Store: { Name: "store" } } } } } });
      }
      throw new Error(`unexpected provider URL ${url.origin}${url.pathname}`);
    }));
    const qualificationEnv = { ...env, RAKUTEN_APPLICATION_ID: "app-test", RAKUTEN_ACCESS_KEY: "access-test",
      RAKUTEN_AFFILIATE_ID: "", RAKUTEN_APPLICATION_URL: "https://eru.example.com/", YAHOO_CLIENT_ID: "yahoo-test" } as Env;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: hourlyMaintenanceTime(), cron: "* * * * *" }), qualificationEnv, ctx);
    await waitOnExecutionContext(ctx);
    const [p0, finalSources, run] = await Promise.all([
      testDatabase.prepare(
        `SELECT COUNT(*) count FROM verification_checks WHERE scope='p0' AND status='passed'
         AND check_key IN ('rakuten_app','rakuten_ichiba_chitanda','rakuten_ichiba_emilia','rakuten_ichiba_30',
          'rakuten_ichiba_fields','rakuten_ichiba_429','rakuten_books_hyouka','rakuten_books_emilia','rakuten_books_fields')`,
      ).first<{ count: number }>(),
      testDatabase.prepare("SELECT COUNT(*) count FROM verification_checks WHERE scope='final' AND check_key IN ('rakuten_ichiba','rakuten_books') AND status='passed'").first<{ count: number }>(),
      testDatabase.prepare("SELECT status,triggered_by,results_json FROM p0_qualification_runs").first<{ status: string; triggered_by: string; results_json: string }>(),
    ]);
    expect(p0?.count).toBe(9);
    expect(finalSources?.count).toBe(2);
    expect(run?.status).toBe("passed");
    expect(run?.triggered_by).toBe("system");
    expect(run?.results_json).not.toContain("app-test");
    expect(run?.results_json).not.toContain("access-test");
    expect(run?.results_json).not.toContain("yahoo-test");
    expect(calls.some((value) => new URL(value).pathname === "/v2/entities:search")).toBe(false);
    expect(calls.some((value) => new URL(value).pathname === "/search")).toBe(false);
  }, 10_000);

  it("fails an HTML probe closed and disables the source when CAPTCHA is observed", async () => {
    const repository = new RadarRepository(testDatabase);
    await testDatabase.prepare("UPDATE verification_checks SET status='passed',verified_at=CURRENT_TIMESTAMP::text WHERE scope='p0'").run();
    await repository.startSourceProbe("surugaya");
    const binding = await seedBinding("probe-surugaya", "surugaya");
    await testDatabase.prepare("UPDATE source_registry SET enabled=1 WHERE id='surugaya'").run();
    await testDatabase.prepare(
      `UPDATE source_probe_windows SET started_at=?,total_runs=47,successful_runs=47,field_total=282,field_complete=282 WHERE source_id='surugaya'`,
    ).bind(new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString()).run();
    const run = await repository.createRun(binding.id, "manual");
    await repository.finishRun(run, { status: "blocked", coverage: "best_effort", resultCount: 0, newCount: 0, changedCount: 0,
      captchaDetected: true });
    const [probe, source] = await Promise.all([
      testDatabase.prepare("SELECT status,decision_reason FROM source_probe_windows WHERE source_id='surugaya'").first<{ status: string; decision_reason: string }>(),
      testDatabase.prepare("SELECT enabled,last_error_code FROM source_registry WHERE id='surugaya'").first<{ enabled: number; last_error_code: string }>(),
    ]);
    expect(probe?.status).toBe("failed");
    expect(probe?.decision_reason).toContain("CAPTCHA");
    expect(source).toEqual({ enabled: 0, last_error_code: "probe_no_go" });
  });

  it("records a gap-free 48-hour Cron window as acceptance evidence", async () => {
    const repository = new RadarRepository(testDatabase);
    const now = Date.now();
    for (let hour = 48; hour >= 1; hour -= 1) {
      const observedAt = new Date(now - hour * 60 * 60 * 1_000).toISOString();
      await testDatabase.prepare("INSERT INTO cron_heartbeats(id,scheduled_at,observed_at) VALUES(?,?,?)")
        .bind(`heartbeat-${hour}`, observedAt, observedAt).run();
    }
    await repository.recordCronHeartbeat(new Date(now).toISOString(), 0, 0);
    const check = await testDatabase.prepare(
      "SELECT status,evidence_json FROM verification_checks WHERE scope='final' AND check_key='continuous_48h'",
    ).first<{ status: string; evidence_json: string }>();
    expect(check?.status).toBe("passed");
    expect(JSON.parse(check!.evidence_json)).toMatchObject({ heartbeatCount: 49, maxGapMinutes: 60 });
  });

  it("reserves the final notification only when all v4 checks pass and never after it is sent", async () => {
    const repository = new RadarRepository(testDatabase);
    expect(await repository.reserveCompletionNotification()).toBeNull();
    await testDatabase.prepare("UPDATE verification_checks SET status='passed',verified_at=CURRENT_TIMESTAMP::text WHERE scope='final'").run();
    const reservation = await repository.reserveCompletionNotification();
    expect(reservation?.checks).toHaveLength(26);
    expect(await repository.reserveCompletionNotification()).toBeNull();
    await repository.finishCompletionNotification(reservation!.key, "email_final_1");
    expect(await repository.reserveCompletionNotification()).toBeNull();
    const notification = await testDatabase.prepare("SELECT status,attempts,resend_email_id FROM completion_notifications")
      .first<{ status: string; attempts: number; resend_email_id: string }>();
    expect(notification).toEqual({ status: "sent", attempts: 1, resend_email_id: "email_final_1" });
  });

  it("acks permanent source-configuration failures instead of exhausting Queue retries", async () => {
    await seedBinding("queue-permanent", "yahoo_shopping");
    const job: MonitorJob = { type: "run_binding", bindingId: "queue-permanent", trigger: "manual", queuedAt: new Date().toISOString() };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{ id: "message-1", timestamp: new Date(), attempts: 1, body: job }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, { ...env, YAHOO_WEB_EXPERIMENTAL_ENABLED: "false" } as Env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    const run = await testDatabase.prepare("SELECT status,error_code FROM watch_runs WHERE watch_binding_id='queue-permanent'").first<{ status: string; error_code: string }>();
    expect(run).toEqual({ status: "failed", error_code: "yahoo_experiment_disabled" });
  });

  it("keeps business-repair waits retryable without incrementing failure counters", async () => {
    const repository = new RadarRepository(testDatabase);
    const initial = await seedBinding("queue-business-repair", "yahoo_shopping");
    await repository.reserveBinding(initial);
    const binding = (await repository.getBinding(initial.id))!;
    const run = await repository.createRun(binding.id, "cron");
    const before = Date.now();

    await repository.markRunAwaitingBusinessRepair(
      binding,
      run,
      "新加坡采集服务正在自动修复业务故障",
      120,
    );

    const [waitingRun, waitingBinding, source] = await Promise.all([
      testDatabase.prepare(
        "SELECT status,error_code,finished_at FROM watch_runs WHERE id=?",
      ).bind(run.id).first<{ status: string; error_code: string; finished_at: string | null }>(),
      testDatabase.prepare(
        `SELECT consecutive_failures,cooldown_until,last_error_code,next_run_at
         FROM watch_bindings WHERE id=?`,
      ).bind(binding.id).first<{
        consecutive_failures: number;
        cooldown_until: string | null;
        last_error_code: string | null;
        next_run_at: string;
      }>(),
      testDatabase.prepare(
        `SELECT health_status,consecutive_failures,last_error_code
         FROM source_registry WHERE id='yahoo_shopping'`,
      ).first<{
        health_status: string;
        consecutive_failures: number;
        last_error_code: string | null;
      }>(),
    ]);
    expect(waitingRun).toEqual({
      status: "running",
      error_code: "source_runner_repair_pending",
      finished_at: null,
    });
    expect(waitingBinding).toMatchObject({
      consecutive_failures: 0,
      cooldown_until: null,
      last_error_code: "source_runner_repair_pending",
    });
    expect(Date.parse(waitingBinding!.next_run_at)).toBeGreaterThanOrEqual(before + 115_000);
    expect(Date.parse(waitingBinding!.next_run_at)).toBeLessThanOrEqual(Date.now() + 125_000);
    expect(source).toEqual({
      health_status: "degraded",
      consecutive_failures: 0,
      last_error_code: "source_runner_repair_pending",
    });

    await repository.closeSupersededBusinessRepairRuns(binding.id);
    const superseded = await testDatabase.prepare(
      "SELECT status,error_code,finished_at FROM watch_runs WHERE id=?",
    ).bind(run.id).first<{ status: string; error_code: string; finished_at: string | null }>();
    expect(superseded?.status).toBe("skipped");
    expect(superseded?.error_code).toBe("source_runner_repair_superseded");
    expect(superseded?.finished_at).not.toBeNull();
  });

  it("acks a Source Runner repair handoff and schedules a fresh production run", async () => {
    await seedBinding("queue-business-repair-e2e", "yahoo_shopping");
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const privateKey = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    ).toString("base64url");
    let calls = 0;
    const upstream = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("runner.example");
      if (calls === 1) {
        expect(url.pathname).toBe("/source-runner/v1/jobs");
        return Response.json({
          ok: true,
          data: {
            jobId: "736b7607-9989-4472-8da6-35ee8e6bb528",
            status: "queued",
          },
        }, { status: 202 });
      }
      expect(url.pathname).toBe("/source-runner/v1/jobs/status");
      return Response.json({
        ok: true,
        data: {
          jobId: "736b7607-9989-4472-8da6-35ee8e6bb528",
          status: "failed",
          error: {
            code: "yahoo_shopping_parser_changed",
            message: "上游结构发生变化",
            upstreamStatus: 502,
            retryable: true,
            retryAfterSeconds: 120,
            repairStatus: "pending",
            repairIncidentId: "jpgr-business-worker-test",
            repairOriginalCode: "yahoo_shopping_parser_changed",
          },
        },
      });
    });
    vi.stubGlobal("fetch", upstream);
    const job: MonitorJob = {
      type: "run_binding",
      bindingId: "queue-business-repair-e2e",
      trigger: "manual",
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "queue-business-repair-message",
      timestamp: new Date(),
      attempts: 1,
      body: job,
    }]);
    const context = createExecutionContext();
    const before = Date.now();

    await worker.queue(batch, {
      ...env,
      SOURCE_RUNNER_URL: "https://runner.example/source-runner/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["queue-business-repair-message"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);
    const [run, binding, source] = await Promise.all([
      testDatabase.prepare(
        `SELECT status,error_code,finished_at FROM watch_runs
         WHERE watch_binding_id='queue-business-repair-e2e'
         ORDER BY started_at DESC LIMIT 1`,
      ).first<{ status: string; error_code: string; finished_at: string | null }>(),
      testDatabase.prepare(
        `SELECT consecutive_failures,cooldown_until,last_error_code,next_run_at
         FROM watch_bindings WHERE id='queue-business-repair-e2e'`,
      ).first<{
        consecutive_failures: number;
        cooldown_until: string | null;
        last_error_code: string | null;
        next_run_at: string;
      }>(),
      testDatabase.prepare(
        `SELECT consecutive_failures,last_error_code
         FROM source_registry WHERE id='yahoo_shopping'`,
      ).first<{ consecutive_failures: number; last_error_code: string | null }>(),
    ]);
    expect(run).toEqual({
      status: "running",
      error_code: "source_runner_repair_pending",
      finished_at: null,
    });
    expect(binding).toMatchObject({
      consecutive_failures: 0,
      cooldown_until: null,
      last_error_code: "source_runner_repair_pending",
    });
    expect(Date.parse(binding!.next_run_at)).toBeGreaterThanOrEqual(before + 115_000);
    expect(source).toEqual({
      consecutive_failures: 0,
      last_error_code: "source_runner_repair_pending",
    });
  });

  it("retries a full Yahoo Auctions local queue without marking the source or probe failed", async () => {
    await seedBinding("queue-yahoo-admission", "yahoo_auctions_jp");
    const now = new Date();
    await testDatabase.batch([
      testDatabase.prepare(
        `UPDATE source_probe_windows SET status='running',started_at=?,planned_end_at=?,total_runs=0,successful_runs=0
         WHERE source_id='yahoo_auctions_jp'`,
      ).bind(now.toISOString(), new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString()),
      testDatabase.prepare(
        "UPDATE experimental_source_runtime SET next_request_at=? WHERE source_id='yahoo_auctions_jp'",
      ).bind(new Date(now.getTime() + 2 * 60_000).toISOString()),
    ]);
    const upstream = vi.fn(async () => {
      throw new Error("local admission must happen before an upstream request");
    });
    vi.stubGlobal("fetch", upstream);
    const job: MonitorJob = {
      type: "run_binding",
      bindingId: "queue-yahoo-admission",
      trigger: "manual",
      queuedAt: now.toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "queue-yahoo-admission-message",
      timestamp: now,
      attempts: 1,
      body: job,
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, {
      ...env,
      YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true",
      YAHOO_AUCTIONS_RATE_INTERVAL_MS: "2000",
    } as Env);
    const queueResult = await getQueueResult(batch, ctx);
    expect(queueResult.explicitAcks).toEqual([]);
    expect(queueResult.retryMessages).toHaveLength(1);
    expect(upstream).not.toHaveBeenCalled();

    const [run, binding, source, probe] = await Promise.all([
      testDatabase.prepare(
        "SELECT status,error_code FROM watch_runs WHERE watch_binding_id='queue-yahoo-admission'",
      ).first<{ status: string; error_code: string }>(),
      testDatabase.prepare(
        "SELECT consecutive_failures,cooldown_until FROM watch_bindings WHERE id='queue-yahoo-admission'",
      ).first<{ consecutive_failures: number; cooldown_until: string | null }>(),
      testDatabase.prepare(
        "SELECT consecutive_failures,cooldown_until,last_error_code FROM source_registry WHERE id='yahoo_auctions_jp'",
      ).first<{ consecutive_failures: number; cooldown_until: string | null; last_error_code: string | null }>(),
      testDatabase.prepare(
        "SELECT total_runs,successful_runs FROM source_probe_windows WHERE source_id='yahoo_auctions_jp'",
      ).first<{ total_runs: number; successful_runs: number }>(),
    ]);
    expect(run).toEqual({ status: "skipped", error_code: "yahoo_auctions_local_rate_limited" });
    expect(binding).toEqual({ consecutive_failures: 0, cooldown_until: null });
    expect(source).toEqual({ consecutive_failures: 0, cooldown_until: null, last_error_code: null });
    expect(probe).toEqual({ total_runs: 0, successful_runs: 0 });
  });

  it("collects a bounded two-page Mercari market window in one workerd Queue run", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64url");
    await seedBinding("market-pagination", "mercari_jp");
    await testDatabase.prepare(
      `UPDATE watch_bindings
       SET monitoring_purpose='keyword_market',source_config_json='{"pages":2}',notify_new_listing=0
       WHERE id='market-pagination'`,
    ).run();

    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).href).toBe("https://adapter.example/api/search");
      expect(new Headers(init?.headers).get("X-JPGR-Signature")).toMatch(/^[a-f0-9]{128}$/);
      const body = JSON.parse(String(init?.body)) as { sourceConfig?: { pageToken?: string; pages?: number } };
      const page = body.sourceConfig?.pageToken === "cursor-2" ? 2 : 1;
      expect(body.sourceConfig?.pages).toBe(1);
      return Response.json({
        ok: true,
        data: {
          sourceId: "mercari_jp",
          listings: [{
            sourceId: "mercari_jp",
            sourceItemId: `m-market-${page}`,
            identityScope: "listing",
            canonicalUrl: `https://jp.mercari.com/item/m-market-${page}`,
            title: `氷菓 市場サンプル ${page}`,
            currency: "JPY",
            currentPrice: 1_000 + page,
            priceBasis: "listing_price",
            condition: "used",
            availability: "available",
          }],
          coverage: "rolling_window",
          warnings: [],
          parserVersion: "mercari-market-pagination-test",
          fetchedAt: new Date().toISOString(),
          ...(page === 1 ? { nextCursor: "cursor-2" } : {}),
          requestEvidence: {
            availabilityMode: "purchasable",
            rawResultCount: 1,
            normalizedResultCount: 1,
            pagesFetched: 1,
          },
        },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const job: MonitorJob = {
      type: "run_binding",
      bindingId: "market-pagination",
      trigger: "manual",
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "market-pagination-message",
      timestamp: new Date(),
      attempts: 1,
      body: job,
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, {
      ...env,
      MERCARI_ADAPTER_URL: "https://adapter.example/",
      MERCARI_ADAPTER_SIGNING_KEY: privateKey,
    } as Env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["market-pagination-message"]);
    expect(upstream).toHaveBeenCalledTimes(2);
    const requestBodies = upstream.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { sourceConfig?: { pageToken?: string } });
    expect(requestBodies.map((body) => body.sourceConfig?.pageToken ?? null)).toEqual([null, "cursor-2"]);

    const [run, listingCount, eventCount, analyticsOutbox] = await Promise.all([
      testDatabase.prepare("SELECT status,result_count FROM watch_runs WHERE watch_binding_id='market-pagination'")
        .first<{ status: string; result_count: number }>(),
      testDatabase.prepare("SELECT COUNT(*) count FROM listings WHERE source_id='mercari_jp'").first<{ count: number }>(),
      testDatabase.prepare("SELECT COUNT(*) count FROM events").first<{ count: number }>(),
      testDatabase.prepare(
        `SELECT ao.status,ao.payload_json
         FROM analytics_outbox ao
         JOIN watch_runs wr ON wr.id=ao.reference_id
         WHERE ao.kind='watch_market' AND wr.watch_binding_id='market-pagination'
         ORDER BY ao.created_at DESC LIMIT 1`,
      )
        .first<{ status: string; payload_json: string }>(),
    ]);
    expect(run).toEqual({ status: "success", result_count: 2 });
    expect(listingCount?.count).toBe(2);
    expect(eventCount?.count).toBe(0);
    expect(analyticsOutbox?.status).toBe("queued");
    expect(JSON.parse(analyticsOutbox!.payload_json)).toMatchObject({
      resultCount: 2,
      groups: [{ listings: [{ sourceItemId: "m-market-1" }, { sourceItemId: "m-market-2" }] }],
    });
  });

  it("skips legacy analytics history without snapshots instead of retrying forever", async () => {
    const now = new Date().toISOString();
    await testDatabase.batch([
      testDatabase.prepare(
        `INSERT INTO search_history(id,query,sources_json,filters_json,status,result_count,source_summary_json,searched_at)
         VALUES('legacy-history','旧记录','["surugaya"]','{}','empty',0,'[]',?)`,
      ).bind(now),
      testDatabase.prepare(
        `INSERT INTO analytics_outbox(id,kind,reference_id,status,created_at,updated_at)
         VALUES('legacy-outbox','preview_search','legacy-history','queued',?,?)`,
      ).bind(now, now),
    ]);
    const job: MonitorJob = { type: "ingest_analytics", outboxId: "legacy-outbox", queuedAt: now };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{ id: "legacy-message", timestamp: new Date(), attempts: 1, body: job }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["legacy-message"]);
    const outbox = await testDatabase.prepare("SELECT status,last_error FROM analytics_outbox WHERE id='legacy-outbox'")
      .first<{ status: string; last_error: string }>();
    expect(outbox).toEqual({ status: "skipped", last_error: "snapshot_not_available" });
  });

  it("enables Rakuten Ichiba monitoring independently while Rakuten Books remains paused", async () => {
    await seedBinding("rakuten-ichiba-enabled", "rakuten_ichiba");
    await seedBinding("rakuten-books-disabled", "rakuten_books");
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toContain("/IchibaItem/Search/");
      return Response.json({ Items: [{
        itemCode: "shop:123",
        itemUrl: "https://item.rakuten.co.jp/shop/123/",
        itemName: "氷菓",
        itemPrice: 4_980,
        availability: 1,
      }] });
    });
    vi.stubGlobal("fetch", upstream);
    const policyEnv = {
      ...env,
      RAKUTEN_APPLICATION_ID: "app-test",
      RAKUTEN_ACCESS_KEY: "access-test",
      RAKUTEN_PRIVATE_MONITORING_ENABLED: "false",
      RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED: "true",
      RAKUTEN_BOOKS_PRIVATE_MONITORING_ENABLED: "false",
    } as Env;
    const queuedAt = new Date().toISOString();
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [
      { id: "message-ichiba", timestamp: new Date(), attempts: 1, body: {
        type: "run_binding", bindingId: "rakuten-ichiba-enabled", trigger: "manual", queuedAt,
      } },
      { id: "message-books", timestamp: new Date(), attempts: 1, body: {
        type: "run_binding", bindingId: "rakuten-books-disabled", trigger: "manual", queuedAt,
      } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, policyEnv);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["message-ichiba", "message-books"]);
    const runs = await testDatabase.prepare(
      `SELECT watch_binding_id,status,error_code FROM watch_runs
       WHERE watch_binding_id IN ('rakuten-ichiba-enabled','rakuten-books-disabled') ORDER BY watch_binding_id`,
    ).all<{ watch_binding_id: string; status: string; error_code: string | null }>();
    expect(runs.results).toEqual([
      { watch_binding_id: "rakuten-books-disabled", status: "skipped", error_code: "rakuten_private_monitoring_disabled" },
      { watch_binding_id: "rakuten-ichiba-enabled", status: "success", error_code: null },
    ]);
    expect(upstream).toHaveBeenCalledTimes(1);
    const status = await worker.fetch(new Request("https://collector.test/internal/source-status") as Parameters<typeof worker.fetch>[0], policyEnv);
    expect(await status.json()).toMatchObject({
      rakuten: {
        privateMonitoringEnabled: false,
        privateMonitoringBySource: { rakuten_ichiba: true, rakuten_books: false },
      },
    });
  });

  it("persists watched-entity context before keyword results can create radar events", async () => {
    await seedBinding("keyword-ai-context", "rakuten_ichiba");
    await testDatabase.batch([
      testDatabase.prepare(
        `UPDATE watch_profiles SET name=?,description=?,include_terms_json=?,exclude_terms_json=? WHERE id=?`,
      ).bind(
        "爱蜜莉雅",
        "《Re:ゼロから始める異世界生活》的艾米莉亚角色商品",
        JSON.stringify(["エミリア|Emilia|爱蜜莉雅"]),
        JSON.stringify(["Emilia Clarke|エミリア・クラーク"]),
        "profile-keyword-ai-context",
      ),
      testDatabase.prepare("UPDATE watch_bindings SET query='エミリア',baseline_completed=1 WHERE id='keyword-ai-context'"),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ Items: [{
      itemCode: "rakuten-books:emilia-rose",
      itemUrl: "https://item.rakuten.co.jp/rakuten-books/emilia-rose/",
      itemName: "Pornstar 【電子書籍】[ Emilia Rose ]",
      itemPrice: 1_187,
      availability: 1,
    }] })));
    const configuredEnv = {
      ...env,
      RAKUTEN_APPLICATION_ID: "app-test",
      RAKUTEN_ACCESS_KEY: "access-test",
      RAKUTEN_PRIVATE_MONITORING_ENABLED: "false",
      RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED: "true",
      RAKUTEN_BOOKS_PRIVATE_MONITORING_ENABLED: "false",
    } as Env;
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "keyword-ai-context-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "keyword-ai-context",
        trigger: "cron",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, configuredEnv);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["keyword-ai-context-message"]);

    const stored = await testDatabase.prepare(
      "SELECT kind,status,prompt_version,payload_json FROM gemini_jobs WHERE binding_id='keyword-ai-context'",
    ).first<{ kind: string; status: string; prompt_version: string; payload_json: string }>();
    expect(stored).toMatchObject({
      kind: "keyword_enrichment",
      status: "queued",
      prompt_version: "keyword-relevance:v4",
    });
    expect(JSON.parse(stored!.payload_json)).toMatchObject({
      query: "エミリア",
      relevanceContext: {
        targetLabel: "爱蜜莉雅",
        targetDescription: "《Re:ゼロから始める異世界生活》的艾米莉亚角色商品",
        includeTerms: ["エミリア|Emilia|爱蜜莉雅"],
        excludeTerms: ["Emilia Clarke|エミリア・クラーク"],
      },
      keyword: { bindingId: "keyword-ai-context", baselineCompleted: true },
    });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM events").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM listings").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("applies additive dossier exclusions without resetting the keyword baseline", async () => {
    const seeded = await seedBinding("keyword-profile-patch", "rakuten_ichiba");
    await testDatabase.batch([
      testDatabase.prepare(
        "UPDATE watch_profiles SET name='加藤惠',exclude_terms_json=? WHERE id=?",
      ).bind(
        JSON.stringify(["コスプレ|cosplay|コスチューム|仮装"]),
        seeded.watch_profile_id,
      ),
      testDatabase.prepare(
        "UPDATE watch_bindings SET query='加藤恵',baseline_completed=1 WHERE id=?",
      ).bind(seeded.id),
    ]);
    const binding = (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?")
      .bind(seeded.id).first<WatchBindingRow>())!;
    const repository = new RadarRepository(testDatabase);
    const priorCosplay: NormalizedListing = {
      sourceId: "rakuten_ichiba",
      sourceItemId: "shop:kato-cosplay",
      identityScope: "catalog",
      canonicalUrl: "https://item.rakuten.co.jp/shop/kato-cosplay/",
      title: "加藤恵 コスプレ用衣装",
      currency: "JPY",
      currentPrice: 15_900,
      priceBasis: "listing_price",
      condition: "new",
      availability: "available",
      rawMetadata: {},
    };
    const stored = await repository.persistListing(binding, priorCosplay, { linkToWatch: false });
    await repository.acceptListingMatch({
      bindingId: binding.id,
      listingId: stored.listingId,
      acceptanceReason: "keyword_relevant",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ Items: [
      {
        itemCode: "shop:kato-cosplay",
        itemUrl: "https://item.rakuten.co.jp/shop/kato-cosplay/",
        itemName: "加藤恵 コスプレ用衣装",
        itemPrice: 15_900,
        availability: 1,
      },
      {
        itemCode: "shop:kato-stand",
        itemUrl: "https://item.rakuten.co.jp/shop/kato-stand/",
        itemName: "加藤恵 アクリルスタンド",
        itemPrice: 2_200,
        availability: 1,
      },
    ] })));
    const configuredEnv = {
      ...env,
      RAKUTEN_APPLICATION_ID: "app-test",
      RAKUTEN_ACCESS_KEY: "access-test",
      RAKUTEN_PRIVATE_MONITORING_ENABLED: "false",
      RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED: "true",
    } as Env;
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "keyword-profile-patch-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: binding.id,
        trigger: "cron",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, configuredEnv);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["keyword-profile-patch-message"]);
    expect(await testDatabase.prepare(
      "SELECT baseline_completed FROM watch_bindings WHERE id=?",
    ).bind(binding.id).first()).toEqual({ baseline_completed: 1 });
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM watch_listing_matches WHERE watch_binding_id=?",
    ).bind(binding.id).first()).toEqual({ count: 0 });
    expect(await testDatabase.prepare(
      `SELECT decision_status,decision_reason FROM watch_run_listing_observations
       WHERE watch_binding_id=? AND source_item_id='shop:kato-cosplay'`,
    ).bind(binding.id).first()).toEqual({
      decision_status: "rejected",
      decision_reason: "命中当前关键词档案的包含/排除补丁",
    });
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM watch_run_listing_observations WHERE watch_binding_id=?",
    ).bind(binding.id).first()).toEqual({ count: 2 });
    const job = await testDatabase.prepare(
      "SELECT payload_json FROM gemini_jobs WHERE binding_id=?",
    ).bind(binding.id).first<{ payload_json: string }>();
    expect(JSON.parse(job!.payload_json).keyword.listings.map((listing: { sourceItemId: string }) => listing.sourceItemId))
      .toEqual(["shop:kato-stand"]);
  });

  it("keeps a successful source run healthy when every semantic derivative item is rejected", async () => {
    await seedBinding("derivative-rejected", "rakuten_ichiba");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ Items: [{
      itemCode: "shop:oversized-title",
      itemUrl: "https://item.rakuten.co.jp/shop/oversized-title/",
      itemName: "長".repeat(1_001),
      itemPrice: 1_200,
      availability: 1,
    }] })));
    const configuredEnv = {
      ...env,
      RAKUTEN_APPLICATION_ID: "app-test",
      RAKUTEN_ACCESS_KEY: "access-test",
      RAKUTEN_PRIVATE_MONITORING_ENABLED: "false",
      RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED: "true",
    } as Env;
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "derivative-rejected-message",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_binding",
        bindingId: "derivative-rejected",
        trigger: "manual",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, configuredEnv);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["derivative-rejected-message"]);
    expect(await testDatabase.prepare(
      "SELECT status,result_count,error_code FROM watch_runs WHERE watch_binding_id='derivative-rejected'",
    ).first()).toEqual({ status: "success", result_count: 1, error_code: null });
    expect(await testDatabase.prepare(
      "SELECT baseline_completed,consecutive_failures,last_error_code FROM watch_bindings WHERE id='derivative-rejected'",
    ).first()).toEqual({ baseline_completed: 1, consecutive_failures: 0, last_error_code: null });
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM gemini_jobs WHERE binding_id='derivative-rejected'",
    ).first()).toEqual({ count: 0 });
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM source_response_captures WHERE source_id='rakuten_ichiba'",
    ).first<{ count: number }>())?.count).toBeGreaterThan(0);
  });

  it("uses Retry-After cooldown and auto-disables parser failures", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("backoff");
    const started = Date.now();
    await repository.failBinding(binding, "http_429", "rate limited", 429, 120);
    const limited = await testDatabase.prepare("SELECT cooldown_until FROM watch_bindings WHERE id='backoff'").first<{ cooldown_until: string }>();
    expect(Date.parse(limited!.cooldown_until) - started).toBeGreaterThanOrEqual(119_000);
    expect(Date.parse(limited!.cooldown_until) - started).toBeLessThan(181_000);

    const latest = (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id='backoff'").first<WatchBindingRow>())!;
    await repository.failBinding(latest, "parser_structure_error", "schema changed");
    const broken = await testDatabase.prepare("SELECT enabled,last_error_code FROM watch_bindings WHERE id='backoff'").first<{ enabled: number; last_error_code: string }>();
    const source = await testDatabase.prepare("SELECT enabled,health_status FROM source_registry WHERE id='rakuten_ichiba'").first<{ enabled: number; health_status: string }>();
    expect(broken).toEqual({ enabled: 0, last_error_code: "parser_structure_error" });
    expect(source).toEqual({ enabled: 0, health_status: "broken" });

    const blockedBinding = await seedBinding("blocked-403", "yahoo_shopping");
    const before403 = Date.now();
    await repository.failBinding(blockedBinding, "http_403", "forbidden", 403);
    const blocked = await testDatabase.prepare("SELECT cooldown_until FROM watch_bindings WHERE id='blocked-403'").first<{ cooldown_until: string }>();
    expect(Date.parse(blocked!.cooldown_until) - before403).toBeGreaterThanOrEqual(12 * 60 * 60 * 1_000 - 1_000);
  });

  it("deduplicates source-failure alerts per binding and includes the monitored target", async () => {
    const repository = new RadarRepository(testDatabase);
    await seedBinding("alert-binding-a", "surugaya");
    await seedBinding("alert-binding-b", "surugaya");

    for (const bindingId of ["alert-binding-a", "alert-binding-b"]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const binding = await repository.getBinding(bindingId);
        expect(binding).not.toBeNull();
        await repository.failBinding(binding!, "http_502", "temporary upstream failure", 502);
      }
    }

    const events = await testDatabase.prepare(
      "SELECT event_key,watch_binding_id,payload_json FROM events WHERE event_type='source_error' ORDER BY watch_binding_id",
    ).all<{ event_key: string; watch_binding_id: string; payload_json: string }>();
    expect(events.results).toHaveLength(2);
    expect(events.results.map((event) => event.event_key)).toEqual([
      expect.stringContaining("source_error:alert-binding-a:"),
      expect.stringContaining("source_error:alert-binding-b:"),
    ]);
    expect(events.results.map((event) => JSON.parse(event.payload_json))).toMatchObject([
      { bindingId: "alert-binding-a", profileName: "Profile alert-binding-a", monitorTarget: "氷菓" },
      { bindingId: "alert-binding-b", profileName: "Profile alert-binding-b", monitorTarget: "氷菓" },
    ]);
  });

  it("persists baseline and snapshots while keeping price events idempotent", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("events");
    const base: NormalizedListing = { sourceId: "rakuten_ichiba", sourceItemId: "shop:item", identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/shop/item/", title: "氷菓", currency: "JPY", currentPrice: 5000,
      priceBasis: "listing_price", condition: "new", availability: "available",
      facts: { identifiers: { jan: "4980000000001" }, brand: "KADOKAWA", manufacturer: "角川",
        releaseDate: "2026-09-18", specifications: [{ name: "尺寸", value: "A4" }] } };
    const initial = await repository.persistListing(binding, base);
    expect(await testDatabase.prepare(
      "SELECT price_basis FROM listing_snapshots WHERE listing_id=? ORDER BY observed_at DESC LIMIT 1",
    ).bind(initial.listingId).first()).toEqual({ price_basis: "listing_price" });
    expect(evaluateListingEvents({ bindingId: binding.id, listingId: initial.listingId, current: { price: 5000, availability: "available" },
      baselineCompleted: false, notifyInitial: false, notifyPriceDrop: true, notifyRestock: true, notifySoldOut: false, minDropAmount: 100 })).toEqual([]);
    await repository.completeBinding(binding);

    const unchanged = await repository.persistListing(binding, base);
    expect(unchanged.changed).toBe(false);
    const richer = await repository.persistListing(binding, {
      ...base,
      facts: { ...base.facts, specifications: [{ name: "尺寸", value: "A4" }, { name: "材质", value: "纸" }] },
    });
    expect(richer.changed).toBe(true);
    const richRow = await testDatabase.prepare(
      "SELECT jan,brand,manufacturer,release_date,product_facts_json,content_hash FROM listings WHERE id=?",
    ).bind(richer.listingId).first<Record<string, unknown>>();
    expect(richRow).toMatchObject({ jan: "4980000000001", brand: "KADOKAWA", manufacturer: "角川", release_date: "2026-09-18" });
    expect(JSON.parse(String(richRow?.product_facts_json))).toMatchObject({ specifications: [{ name: "尺寸", value: "A4" }, { name: "材质", value: "纸" }] });
    expect(richRow?.content_hash).toBeTruthy();
    const dropped = await repository.persistListing(binding, { ...base, currentPrice: 4200 });
    const unconfirmed = evaluateListingEvents({ bindingId: binding.id, listingId: dropped.listingId,
      previous: { price: 5000, availability: "available" }, current: { price: 4200, availability: "available" },
      baselineCompleted: true, notifyInitial: false, notifyPriceDrop: true, notifyRestock: true, notifySoldOut: false, minDropAmount: 100 });
    expect(unconfirmed).toEqual([]);
    const confirmed = evaluateListingEvents({ bindingId: binding.id, listingId: dropped.listingId,
      previous: { price: 5000, availability: "available" }, current: { price: 4200, availability: "available" },
      baselineCompleted: true, notifyInitial: false, notifyPriceDrop: true, notifyRestock: true, notifySoldOut: false,
      minDropAmount: 100, priceDropConfirmed: true });
    expect(await repository.insertEvents(binding, dropped.listingId, confirmed)).toBe(1);
    expect(await repository.insertEvents(binding, dropped.listingId, confirmed)).toBe(0);
    await repository.persistListing(binding, { ...base, currentPrice: 4600 });
    const counts = await testDatabase.batch([
      testDatabase.prepare("SELECT COUNT(*) count FROM listing_snapshots"),
      testDatabase.prepare("SELECT COUNT(*) count FROM events WHERE event_type='price_drop'"),
    ]);
    expect((counts[0]?.results[0] as { count: number }).count).toBe(4);
    expect((counts[1]?.results[0] as { count: number }).count).toBe(1);
  });

  it("retains per-run listing audit even when no change event is created", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("run-listing-audit");
    const run = await repository.createRun(binding.id, "cron");
    const listing = {
      sourceId: "rakuten_ichiba",
      sourceItemId: "shop:audit-item",
      canonicalUrl: "https://item.rakuten.co.jp/shop/audit-item/",
      title: "監査対象商品",
      currency: "JPY",
      currentPrice: 4_500,
      condition: "new",
      availability: "available",
    };
    await repository.recordRunListingObservations([{
      runId: run.id,
      bindingId: binding.id,
      sourceId: listing.sourceId,
      sourceItemId: listing.sourceItemId,
      canonicalUrl: listing.canonicalUrl,
      title: listing.title,
      currentPrice: listing.currentPrice,
      currency: listing.currency,
      priceBasis: "listing_price",
      availability: listing.availability,
      itemCondition: listing.condition,
      ordinal: 1,
      observedAt: new Date().toISOString(),
      decisionStatus: "pending",
      decisionReason: "等待同款判定",
      matchRelation: "probable_exact",
      purchasable: true,
    }]);
    await repository.finishRun(run, {
      status: "success",
      coverage: "rolling_window",
      resultCount: 1,
      newCount: 0,
      changedCount: 0,
    });

    expect(await testDatabase.prepare(
      `SELECT observation.decision_status,observation.decision_reason,observation.match_relation,
              observation.is_purchasable,observation.title,observation.price_basis
       FROM watch_run_listing_observations observation
       WHERE observation.watch_run_id=?`,
    ).bind(run.id).first()).toEqual({
      decision_status: "pending",
      decision_reason: "等待同款判定",
      match_relation: "probable_exact",
      is_purchasable: 1,
      title: "監査対象商品",
      price_basis: "listing_price",
    });
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE watch_binding_id=?",
    ).bind(binding.id).first()).toEqual({ count: 0 });
  });

  it("retains a bounded Description when a later observation has no description", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("description-evidence");
    const base: NormalizedListing = {
      sourceId: "rakuten_ichiba",
      sourceItemId: "shop:description-evidence",
      identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/shop/description-evidence/",
      title: "商品説明テスト",
      descriptionExcerpt: `  ${"説".repeat(2_600)}  `,
      currency: "JPY",
      currentPrice: 5_000,
      priceBasis: "listing_price",
      condition: "new",
      availability: "available",
    };

    const initial = await repository.persistListing(binding, base);
    const withoutDescription = await repository.persistListing(binding, {
      ...base,
      descriptionExcerpt: undefined,
    });
    const row = await testDatabase.prepare(
      "SELECT description_excerpt FROM listings WHERE id=?",
    ).bind(initial.listingId).first<{ description_excerpt: string }>();

    expect(withoutDescription.changed).toBe(false);
    expect(row?.description_excerpt).toHaveLength(2_500);
    expect(row?.description_excerpt).toBe("説".repeat(2_500));
  });

  it("dual-writes one legacy discovery into versioned monitor facts and stays idempotent", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("monitor-v2");
    await seedExactProductMonitorRule(binding, [
      "product.new_comparable_offer",
      "product.offer_below_target_listing_price",
    ], 3_800);
    const persisted = await repository.persistListing(binding, {
      sourceId: binding.source_id,
      sourceItemId: "monitor-v2-item",
      identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/shop/monitor-v2-item/",
      title: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
      currency: "JPY",
      currentPrice: 3_600,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });
    const events = evaluateListingEvents({
      bindingId: binding.id,
      listingId: persisted.listingId,
      current: { price: 3_600, availability: "available" },
      isNewMatch: persisted.isNewMatch,
      baselineCompleted: true,
      notifyInitial: false,
      notifyNewListing: true,
      notifyPriceDrop: false,
      notifyRestock: false,
      notifySoldOut: false,
      minDropAmount: 100,
    });

    expect(events.map((event) => event.type)).toEqual(["new_listing"]);
    expect(await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }])).toBe(1);
    expect(await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }])).toBe(0);

    const legacy = await testDatabase.prepare(
      "SELECT id,status FROM events WHERE watch_binding_id=? AND event_type='new_listing'",
    ).bind(binding.id).all<{ id: string; status: string }>();
    const facts = await testDatabase.prepare(
      `SELECT event_type,rule_version,product_variant_id,evidence_hash,
              notification_eligibility,legacy_event_id
       FROM monitor_events WHERE watch_binding_id=? ORDER BY event_type`,
    ).bind(binding.id).all<{
      event_type: string;
      rule_version: number;
      product_variant_id: string;
      evidence_hash: string;
      notification_eligibility: string;
      legacy_event_id: string;
    }>();
    expect(legacy.results).toHaveLength(1);
    expect(legacy.results[0]?.status).toBe("pending");
    expect(facts.results.map((fact) => fact.event_type)).toEqual([
      "product.new_comparable_offer",
      "product.offer_below_target_listing_price",
    ]);
    expect(facts.results.every((fact) => (
      fact.rule_version === 1
      && fact.product_variant_id === `variant-${binding.id}`
      && fact.evidence_hash.length === 64
      && fact.notification_eligibility === "digest"
      && fact.legacy_event_id === legacy.results[0]?.id
    ))).toBe(true);
  });

  it("重量未知时按落地成本区间中点判定目标，而不是按最重档的上界", async () => {
    const repository = new RadarRepository(testDatabase);
    const costProfileId = await seedLandedCostProfile();

    async function observe(id: string, target: number) {
      const binding = await seedBinding(id);
      await seedExactProductMonitorRule(binding, [
        "product.new_comparable_offer",
        "product.offer_below_target_landed_cost",
      ]);
      await seedLandedCostTarget(binding, costProfileId, target);
      const persisted = await repository.persistListing(binding, {
        sourceId: binding.source_id,
        sourceItemId: `${id}-item`,
        identityScope: "listing",
        canonicalUrl: `https://item.rakuten.co.jp/shop/${id}-item/`,
        title: `目标到手价测试 ${id}`,
        currency: "JPY",
        currentPrice: 3_600,
        priceBasis: "listing_price",
        condition: "used",
        availability: "available",
      });
      const events = evaluateListingEvents({
        bindingId: binding.id,
        listingId: persisted.listingId,
        current: { price: 3_600, availability: "available" },
        isNewMatch: persisted.isNewMatch,
        baselineCompleted: true,
        notifyInitial: false,
        notifyNewListing: true,
        notifyPriceDrop: false,
        notifyRestock: false,
        notifySoldOut: false,
        minDropAmount: 100,
      });
      await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }]);
      return testDatabase.prepare(
        "SELECT event_type,payload_json FROM monitor_events WHERE watch_binding_id=? ORDER BY event_type",
      ).bind(binding.id).all<{ event_type: string; payload_json: string }>();
    }

    // 该商品没有重量字段（搜索结果的常态），落地成本区间为 4,600–5,600，中点 5,100。
    // 目标价低于中点仍然不触发。
    const belowMidpoint = await observe("landed-below-mid", 5_099);
    expect(belowMidpoint.results.map((row) => row.event_type)).toEqual([
      "product.new_comparable_offer",
    ]);

    // 目标价达到中点即触发。按旧的上界策略，这里要等到目标价 ≥ 5,600 才会通知——
    // 也就是必须按 profile 未知重量区间的最重档计价，实际使用中几乎永远不触发。
    const atMidpoint = await observe("landed-at-mid", 5_100);
    expect(atMidpoint.results.map((row) => row.event_type)).toEqual([
      "product.new_comparable_offer",
      "product.offer_below_target_landed_cost",
    ]);
    const payload = JSON.parse(atMidpoint.results[1]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      targetLandedCostJpy: 5_100,
      thresholdPolicy: "estimate_midpoint_at_or_below",
      costProfileId,
      costProfileVersion: 1,
      landedCostJpy: { min: 4_600, max: 5_600 },
      missingFacts: ["domestic_shipping", "weight"],
      weightSource: "cost_profile_range",
    });
  });

  it("keeps the legacy event path available when the V2 runtime flag is disabled", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("monitor-v2-off");
    await seedExactProductMonitorRule(binding, ["product.new_comparable_offer"]);
    await testDatabase.prepare(
      "UPDATE runtime_feature_flags SET enabled=0,updated_at=CURRENT_TIMESTAMP::text WHERE flag_key='monitor_rules_v2'",
    ).run();
    const persisted = await repository.persistListing(binding, {
      sourceId: binding.source_id,
      sourceItemId: "monitor-v2-off-item",
      identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/shop/monitor-v2-off-item/",
      title: "V2 回退验证商品",
      currency: "JPY",
      currentPrice: 4_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });
    const events = evaluateListingEvents({
      bindingId: binding.id,
      listingId: persisted.listingId,
      current: { price: 4_000, availability: "available" },
      isNewMatch: persisted.isNewMatch,
      baselineCompleted: true,
      notifyInitial: false,
      notifyNewListing: true,
      notifyPriceDrop: false,
      notifyRestock: false,
      notifySoldOut: false,
      minDropAmount: 100,
    });

    expect(await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }])).toBe(1);
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE watch_binding_id=?",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(1);
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM monitor_events WHERE watch_binding_id=?",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(0);
  });

  it("does not turn a pending identity placeholder into a product variant fact", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("monitor-v2-pending");
    await seedExactProductMonitorRule(binding, ["product.new_comparable_offer"]);
    await testDatabase.prepare(
      "UPDATE monitor_rules SET scope_id=?,scope_identity_status='pending' WHERE watch_profile_id=?",
    ).bind(binding.watch_profile_id, binding.watch_profile_id).run();
    const persisted = await repository.persistListing(binding, {
      sourceId: binding.source_id,
      sourceItemId: "monitor-v2-pending-item",
      identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/shop/monitor-v2-pending-item/",
      title: "稳定身份待确认商品",
      currency: "JPY",
      currentPrice: 4_200,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });
    const events = evaluateListingEvents({
      bindingId: binding.id,
      listingId: persisted.listingId,
      current: { price: 4_200, availability: "available" },
      isNewMatch: persisted.isNewMatch,
      baselineCompleted: true,
      notifyInitial: false,
      notifyNewListing: true,
      notifyPriceDrop: false,
      notifyRestock: false,
      notifySoldOut: false,
      minDropAmount: 100,
    });

    expect(await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }])).toBe(1);
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE watch_binding_id=? AND status='pending'",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(1);
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM monitor_events WHERE watch_binding_id=?",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(0);
  });

  it("independently follows an accepted exact-product listing and confirms its price drop", async () => {
    const repository = new RadarRepository(testDatabase);
    const seeded = await seedBinding("exact-listing-price", "surugaya");
    await seedExactProductMonitorRule(seeded, ["listing.price_changed"]);
    await testDatabase.prepare(
      `UPDATE watch_bindings SET notify_price_drop=1,notify_restock=1,notify_sold_out=1,
       min_drop_amount=100 WHERE id=?`,
    ).bind(seeded.id).run();
    const binding = (await repository.getBinding(seeded.id))!;
    const initial = await repository.persistListing(binding, {
      sourceId: "surugaya",
      sourceItemId: "994909113",
      identityScope: "catalog",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/994909113",
      title: "千反田える 追踪基线商品",
      currency: "JPY",
      currentPrice: 5_000,
      priceBasis: "catalog_price",
      condition: "used",
      availability: "available",
    }, { linkToWatch: false });
    await repository.acceptListingMatch({
      bindingId: binding.id,
      listingId: initial.listingId,
      acceptanceReason: "deterministic_exact",
    });
    await repository.activateExactProductListingTracking(binding, initial.listingId, true);
    // 父级同款发现可以先看到一个新价格并更新全局 listing；详情子任务仍须
    // 用自己的 5,000 円基线判断，不能把父任务写入的 3,000 円当作旧价。
    await testDatabase.prepare(
      "UPDATE listings SET current_price=3000,state_hash='parent-discovery-state' WHERE id=?",
    ).bind(initial.listingId).run();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(availableSurugayaDetailFixture(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));
    const trackedBatch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "exact-listing-price-run",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_tracked_listing",
        bindingId: binding.id,
        listingId: initial.listingId,
        trigger: "manual",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const trackedContext = createExecutionContext();
    await worker.queue(trackedBatch, { ...env, SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env);
    expect((await getQueueResult(trackedBatch, trackedContext)).explicitAcks).toEqual(["exact-listing-price-run"]);

    expect(await testDatabase.prepare(
      `SELECT l.current_price,m.tracking_status,m.tracking_last_price,m.tracking_last_success_at
       FROM listings l JOIN watch_listing_matches m ON m.listing_id=l.id
       WHERE m.watch_binding_id=? AND m.listing_id=?`,
    ).bind(binding.id, initial.listingId).first()).toMatchObject({
      current_price: 905,
      tracking_status: "active",
      tracking_last_price: 905,
      tracking_last_success_at: expect.any(String),
    });
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE watch_binding_id=? AND event_type='price_drop'",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(0);

    const confirmationBatch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "exact-listing-price-confirm",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "confirm_price_drop",
        bindingId: binding.id,
        listingId: initial.listingId,
        expectedOldPrice: 5_000,
        candidateNewPrice: 905,
        queuedAt: new Date().toISOString(),
      },
    }]);
    const confirmationContext = createExecutionContext();
    await worker.queue(confirmationBatch, { ...env, SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env);
    expect((await getQueueResult(confirmationBatch, confirmationContext)).explicitAcks)
      .toEqual(["exact-listing-price-confirm"]);
    expect(await testDatabase.prepare(
      `SELECT event_type,status,payload_json FROM events
       WHERE watch_binding_id=? AND event_type='price_drop'`,
    ).bind(binding.id).first<{ event_type: string; status: string; payload_json: string }>()).toMatchObject({
      event_type: "price_drop",
      status: "pending",
      payload_json: expect.stringContaining('"oldPrice":5000'),
    });
    expect(await testDatabase.prepare(
      `SELECT event_type,notification_eligibility FROM monitor_events
       WHERE watch_binding_id=? AND event_type='listing.price_changed'`,
    ).bind(binding.id).first()).toEqual({
      event_type: "listing.price_changed",
      notification_eligibility: "instant",
    });
  });

  it("ends a sold one-off child but keeps a sold catalog child waiting for restock", async () => {
    const repository = new RadarRepository(testDatabase);
    const seeded = await seedBinding("exact-listing-sold", "surugaya");
    await seedExactProductMonitorRule(seeded, ["listing.availability_changed"]);
    await testDatabase.prepare(
      "UPDATE watch_bindings SET notify_restock=1,notify_sold_out=1 WHERE id=?",
    ).bind(seeded.id).run();
    const binding = (await repository.getBinding(seeded.id))!;
    const initial = await repository.persistListing(binding, {
      sourceId: "surugaya",
      sourceItemId: "646170273",
      identityScope: "catalog",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/646170273",
      title: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
      currency: "JPY",
      currentPrice: 38_300,
      priceBasis: "catalog_price",
      condition: "used",
      availability: "available",
    }, { linkToWatch: false });
    await repository.acceptListingMatch({
      bindingId: binding.id,
      listingId: initial.listingId,
      acceptanceReason: "deterministic_exact",
    });
    await repository.activateExactProductListingTracking(binding, initial.listingId, true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(soldOutSurugayaDetailFixture(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "exact-listing-sold-run",
      timestamp: new Date(),
      attempts: 1,
      body: {
        type: "run_tracked_listing",
        bindingId: binding.id,
        listingId: initial.listingId,
        trigger: "manual",
        queuedAt: new Date().toISOString(),
      },
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, { ...env, SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env);
    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["exact-listing-sold-run"]);
    expect(await testDatabase.prepare(
      `SELECT tracking_status,tracking_next_run_at FROM watch_listing_matches
       WHERE watch_binding_id=? AND listing_id=?`,
    ).bind(binding.id, initial.listingId).first()).toMatchObject({
      tracking_status: "waiting_restock",
      tracking_next_run_at: expect.any(String),
    });
    expect(await testDatabase.prepare(
      `SELECT event_type,status,payload_json FROM events
       WHERE watch_binding_id=? AND event_type='sold_out'`,
    ).bind(binding.id).first()).toMatchObject({
      event_type: "sold_out",
      status: "pending",
      payload_json: expect.stringContaining('"currentAvailability":"sold_out"'),
    });
    expect(await testDatabase.prepare(
      `SELECT notification_eligibility FROM monitor_events
       WHERE watch_binding_id=? AND event_type='listing.availability_changed'`,
    ).bind(binding.id).first()).toEqual({ notification_eligibility: "instant" });

    const oneOffSeed = await seedBinding("exact-listing-one-off", "mercari_jp");
    await seedExactProductMonitorRule(oneOffSeed, ["listing.availability_changed"]);
    const oneOffBinding = (await repository.getBinding(oneOffSeed.id))!;
    const oneOffListing = await repository.persistListing(oneOffBinding, {
      sourceId: "mercari_jp",
      sourceItemId: "m12345678901",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m12345678901",
      title: "一次性挂牌状态机测试",
      currency: "JPY",
      currentPrice: 18_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    }, { linkToWatch: false });
    await repository.acceptListingMatch({
      bindingId: oneOffBinding.id,
      listingId: oneOffListing.listingId,
      acceptanceReason: "deterministic_exact",
    });
    await repository.activateExactProductListingTracking(oneOffBinding, oneOffListing.listingId, true);
    const oneOffTracked = (await repository.getTrackedListing(oneOffBinding.id, oneOffListing.listingId))!;
    await repository.completeTrackedListing(oneOffTracked, {
      price: 18_000,
      availability: "sold_out",
      stateHash: "sold-state",
    });
    expect(await testDatabase.prepare(
      `SELECT tracking_status,tracking_next_run_at,tracking_terminal_reason
       FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?`,
    ).bind(oneOffBinding.id, oneOffListing.listingId).first()).toEqual({
      tracking_status: "terminal",
      tracking_next_run_at: null,
      tracking_terminal_reason: "confirmed_sold_out",
    });
  });

  it("requires two missing detail observations before notifying that a listing was taken down", async () => {
    const repository = new RadarRepository(testDatabase);
    const seeded = await seedBinding("exact-listing-missing", "surugaya");
    await seedExactProductMonitorRule(seeded, ["listing.availability_changed"]);
    await testDatabase.prepare(
      "UPDATE watch_bindings SET notify_restock=1,notify_sold_out=1 WHERE id=?",
    ).bind(seeded.id).run();
    const binding = (await repository.getBinding(seeded.id))!;
    const initial = await repository.persistListing(binding, {
      sourceId: "surugaya",
      sourceItemId: "missing-994909113",
      identityScope: "catalog",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/994909113",
      title: "连续缺失确认测试商品",
      currency: "JPY",
      currentPrice: 5_000,
      priceBasis: "catalog_price",
      condition: "used",
      availability: "available",
    }, { linkToWatch: false });
    await repository.acceptListingMatch({
      bindingId: binding.id,
      listingId: initial.listingId,
      acceptanceReason: "deterministic_exact",
    });
    await repository.activateExactProductListingTracking(binding, initial.listingId, true);
    // 搜索页先标成售罄也不能吞掉详情子任务从 available 出发的下架事件。
    await testDatabase.prepare(
      "UPDATE listings SET availability='sold_out',state_hash='parent-sold-state' WHERE id=?",
    ).bind(initial.listingId).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));
    const configuredEnv = {
      ...env,
      SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true",
      SURUGAYA_ADAPTER_URL: "",
      FIRECRAWL_API_KEY: "",
      BROWSER_RUN_FALLBACK_ENABLED: "false",
    } as Env;
    const runMissing = async (id: string) => {
      const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
        id,
        timestamp: new Date(),
        attempts: 1,
        body: {
          type: "run_tracked_listing",
          bindingId: binding.id,
          listingId: initial.listingId,
          trigger: "manual",
          queuedAt: new Date().toISOString(),
        },
      }]);
      const context = createExecutionContext();
      await worker.queue(batch, configuredEnv);
      expect((await getQueueResult(batch, context)).explicitAcks).toEqual([id]);
    };

    await runMissing("exact-listing-missing-first");
    expect(await testDatabase.prepare(
      `SELECT m.tracking_status,m.tracking_missing_observations,l.availability
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id=? AND m.listing_id=?`,
    ).bind(binding.id, initial.listingId).first()).toEqual({
      tracking_status: "unavailable_pending",
      tracking_missing_observations: 1,
      availability: "sold_out",
    });
    expect((await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE watch_binding_id=? AND event_type='sold_out'",
    ).bind(binding.id).first<{ count: number }>())?.count).toBe(0);

    await runMissing("exact-listing-missing-second");
    expect(await testDatabase.prepare(
      `SELECT m.tracking_status,m.tracking_missing_observations,l.availability
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id=? AND m.listing_id=?`,
    ).bind(binding.id, initial.listingId).first()).toEqual({
      tracking_status: "waiting_restock",
      tracking_missing_observations: 2,
      availability: "unavailable",
    });
    expect(await testDatabase.prepare(
      `SELECT event_type,payload_json FROM events
       WHERE watch_binding_id=? AND event_type='sold_out'`,
    ).bind(binding.id).first()).toMatchObject({
      event_type: "sold_out",
      payload_json: expect.stringContaining('"inference":"confirmed_missing"'),
    });
  });

  it("treats an existing global listing as new for a different keyword binding", async () => {
    const repository = new RadarRepository(testDatabase);
    const firstBinding = await seedBinding("keyword-first", "yahoo_shopping");
    const secondBinding = await seedBinding("keyword-second", "yahoo_shopping");
    const listing: NormalizedListing = {
      sourceId: "yahoo_shopping",
      sourceItemId: "shop_shared-item",
      identityScope: "listing",
      canonicalUrl: "https://store.shopping.yahoo.co.jp/shop/shared-item.html",
      title: "雪ミク 共通商品",
      currency: "JPY",
      currentPrice: 2_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    };
    const first = await repository.persistListing(firstBinding, listing);
    expect(first.isNew).toBe(true);
    expect(first.isNewMatch).toBe(true);
    await repository.completeBinding(secondBinding);
    const second = await repository.persistListing(secondBinding, listing);
    expect(second.isNew).toBe(false);
    expect(second.isNewMatch).toBe(true);
    const events = evaluateListingEvents({
      bindingId: secondBinding.id,
      listingId: second.listingId,
      previous: { price: 2_000, availability: "available" },
      current: { price: 2_000, availability: "available" },
      isNewMatch: second.isNewMatch,
      baselineCompleted: true,
      notifyInitial: false,
      notifyNewListing: true,
      notifyPriceDrop: false,
      notifyRestock: false,
      notifySoldOut: false,
      minDropAmount: 100,
    });
    expect(events.map((event) => event.type)).toEqual(["new_listing"]);
    expect((await repository.persistListing(secondBinding, listing)).isNewMatch).toBe(false);
  });

  it("hard-stops Parse runtime fallback at 40 calls while preserving the emergency reserve", async () => {
    const repository = new RadarRepository(testDatabase);
    for (let index = 0; index < 40; index += 1) expect(await repository.reserveManagedApiCall("parse")).toBe(true);
    expect(await repository.reserveManagedApiCall("parse")).toBe(false);
    expect(await repository.managedApiUsage("parse")).toMatchObject({
      runtimeBudget: 40,
      runtimeCalls: 40,
      emergencyReserve: 20,
    });
    await repository.managedApiCachePut("parse", "charaon:detail:AZMGS92", "{\"ok\":true}", new Date(Date.now() + 60_000).toISOString());
    expect(await repository.managedApiCacheGet("parse", "charaon:detail:AZMGS92")).toBe("{\"ok\":true}");
  });

  it("creates one idempotent digest and suppresses excess events", async () => {
    const repository = new RadarRepository(testDatabase);
    const now = new Date().toISOString();
    for (let index = 0; index < 3; index += 1) {
      await testDatabase.prepare("INSERT INTO events(id,event_key,event_type,payload_json,status,created_at) VALUES(?,?, 'source_error','{}','pending',?)")
        .bind(`event-${index}`, `source_error:test:${index}`, now).run();
    }
    await repository.prepareDailyDigest();
    await repository.prepareDailyDigest();
    // 折叠只在邮件侧标记 email_suppressed_at；events.status 保持 pending，Hermes 通道不受影响。
    const emailSuppressed = await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE email_suppressed_at IS NOT NULL AND event_type<>'daily_digest'",
    ).first<{ count: number }>();
    const hermesVisible = await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE status='pending' AND event_type<>'daily_digest'",
    ).first<{ count: number }>();
    const digests = await testDatabase.prepare("SELECT payload_json,status FROM events WHERE event_type='daily_digest'").all<{ payload_json: string; status: string }>();
    expect(emailSuppressed?.count).toBe(3);
    expect(hermesVisible?.count).toBe(3);
    expect(digests.results).toHaveLength(1);
    expect(JSON.parse(digests.results[0]!.payload_json)).toMatchObject({ total: 3 });
    expect(digests.results[0]!.status).toBe("pending");
  });

  it("retires only one-off item watches after seven terminal days and emits one completion event", async () => {
    const repository = new RadarRepository(testDatabase);
    const oldTerminalAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const fixtures = [
      { id: "terminal-mercari", sourceId: "mercari_jp" as const, shouldRetire: true },
      { id: "terminal-surugaya", sourceId: "surugaya" as const, shouldRetire: false },
    ];
    for (const fixture of fixtures) {
      const seeded = await seedBinding(fixture.id, fixture.sourceId);
      await testDatabase.prepare(
        `UPDATE watch_bindings SET kind='item',query=NULL,source_item_id=?,target_url=? WHERE id=?`,
      ).bind(`${fixture.id}-item`, `https://example.test/${fixture.id}`, seeded.id).run();
      const binding = (await testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?")
        .bind(seeded.id).first<WatchBindingRow>())!;
      const persisted = await repository.persistListing(binding, {
        sourceId: fixture.sourceId,
        sourceItemId: `${fixture.id}-item`,
        identityScope: "listing",
        canonicalUrl: `https://example.test/${fixture.id}`,
        title: `${fixture.id} 已售商品`,
        currency: "JPY",
        currentPrice: 3_800,
        priceBasis: "listing_price",
        condition: "used",
        availability: "sold_out",
      });
      await testDatabase.prepare("UPDATE listings SET last_changed_at=? WHERE id=?")
        .bind(oldTerminalAt, persisted.listingId).run();
    }

    expect(await repository.retireTerminalItemWatches(7)).toBe(1);
    expect(await repository.retireTerminalItemWatches(7)).toBe(0);
    const bindings = await testDatabase.prepare(
      "SELECT id,enabled FROM watch_bindings WHERE id IN ('terminal-mercari','terminal-surugaya') ORDER BY id",
    ).all<{ id: string; enabled: number }>();
    expect(bindings.results).toEqual([
      { id: "terminal-mercari", enabled: 0 },
      { id: "terminal-surugaya", enabled: 1 },
    ]);
    const completion = await testDatabase.prepare(
      `SELECT COALESCE(semantic_event_type,event_type) event_type,payload_json
       FROM events WHERE semantic_event_type='watch_completed'`,
    ).all<{ event_type: string; payload_json: string }>();
    expect(completion.results).toHaveLength(1);
    expect(completion.results[0]?.event_type).toBe("watch_completed");
    expect(JSON.parse(completion.results[0]!.payload_json)).toMatchObject({
      sourceId: "mercari_jp",
      terminalAvailability: "sold_out",
      terminalDays: 7,
    });
  });

  it("adds the profile lifecycle median to a restock event payload", async () => {
    const repository = new RadarRepository(testDatabase);
    const firstSeed = await seedBinding("lifecycle-first", "surugaya");
    const secondSeed = await seedBinding("lifecycle-second", "surugaya");
    await testDatabase.batch([
      testDatabase.prepare("UPDATE watch_bindings SET kind='item',query=NULL WHERE id=?").bind(firstSeed.id),
      testDatabase.prepare(
        "UPDATE watch_bindings SET watch_profile_id=?,kind='item',query=NULL WHERE id=?",
      ).bind(firstSeed.watch_profile_id, secondSeed.id),
    ]);
    const [firstBinding, secondBinding] = await Promise.all([
      testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?").bind(firstSeed.id).first<WatchBindingRow>(),
      testDatabase.prepare("SELECT * FROM watch_bindings WHERE id=?").bind(secondSeed.id).first<WatchBindingRow>(),
    ]);
    const first = await repository.persistListing(firstBinding!, {
      sourceId: "surugaya",
      sourceItemId: "lifecycle-a",
      identityScope: "listing",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/lifecycle-a",
      title: "生命周期 A",
      currency: "JPY",
      currentPrice: 4_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });
    const second = await repository.persistListing(secondBinding!, {
      sourceId: "surugaya",
      sourceItemId: "lifecycle-b",
      identityScope: "listing",
      canonicalUrl: "https://www.suruga-ya.jp/product/detail/lifecycle-b",
      title: "生命周期 B",
      currency: "JPY",
      currentPrice: 5_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "sold_out",
    });
    const snapshot = (
      id: string,
      listingId: string,
      bindingId: string,
      availability: "available" | "sold_out",
      observedAt: string,
    ) => testDatabase.prepare(
      `INSERT INTO listing_snapshots(
         id,listing_id,watch_binding_id,price,currency,availability,item_condition,state_hash,observed_at
       ) VALUES(?,?,?,?, 'JPY',?,'used',?,?)`,
    ).bind(id, listingId, bindingId, 4_000, availability, `${listingId}:${availability}`, observedAt);
    await testDatabase.batch([
      testDatabase.prepare("DELETE FROM listing_snapshots WHERE listing_id IN (?,?)").bind(first.listingId, second.listingId),
      snapshot("lifecycle-a-1", first.listingId, firstBinding!.id, "available", "2026-07-01T00:00:00.000Z"),
      snapshot("lifecycle-a-2", first.listingId, firstBinding!.id, "sold_out", "2026-07-05T00:00:00.000Z"),
      snapshot("lifecycle-a-3", first.listingId, firstBinding!.id, "available", "2026-07-10T00:00:00.000Z"),
      snapshot("lifecycle-b-1", second.listingId, secondBinding!.id, "available", "2026-07-02T00:00:00.000Z"),
      snapshot("lifecycle-b-2", second.listingId, secondBinding!.id, "sold_out", "2026-07-08T00:00:00.000Z"),
    ]);

    expect(await repository.insertEventBatch(firstBinding!, [{
      listingId: first.listingId,
      events: [{
        type: "restock",
        eventKey: "restock:lifecycle:first",
        payload: { previousAvailability: "sold_out", currentAvailability: "available" },
      }],
    }])).toBe(1);
    const event = await testDatabase.prepare(
      "SELECT payload_json FROM events WHERE event_key='restock:lifecycle:first'",
    ).first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      previousAvailability: "sold_out",
      currentAvailability: "available",
      medianObservedActiveDurationDays: 5,
    });
  });

  it("does not create or deliver the retired morning digest", async () => {
    const scheduledTime = Date.UTC(2026, 6, 27, 0, 0, 0);
    await testDatabase.batch([
      testDatabase.prepare(
        `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
         VALUES('morning-source','morning:source','source_error','{}','pending','2026-07-26T01:00:00.000Z')`,
      ),
      testDatabase.prepare(
        `INSERT INTO events(id,event_key,event_type,semantic_event_type,payload_json,status,created_at)
         VALUES('morning-rise','morning:rise','price_drop','price_rise','{}','pending','2026-07-26T02:00:00.000Z')`,
      ),
      testDatabase.prepare(
        `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
         VALUES('morning-old','morning:old','source_error','{}','pending','2026-07-25T14:59:59.000Z')`,
      ),
      testDatabase.prepare(
        `INSERT INTO events(id,event_key,event_type,semantic_event_type,payload_json,status,created_at)
         VALUES(
           'legacy-morning-digest','morning_digest:legacy','daily_digest','morning_digest',
           '{"kind":"morning_digest","day":"2026-07-25","total":1}','pending',
           '2026-07-26T00:00:00.000Z'
         )`,
      ),
    ]);
    for (let index = 0; index < 2; index += 1) {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime, cron: "* * * * *" }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    }

    const repository = new RadarRepository(testDatabase);
    const digests = await testDatabase.prepare(
      `SELECT event_key,status FROM events WHERE semantic_event_type='morning_digest'`,
    ).all<{ event_key: string; status: string }>();
    expect(digests.results).toHaveLength(1);
    expect(digests.results[0]?.event_key).toBe("morning_digest:legacy");
    expect((await repository.pendingEmails(20)).map((row) => row.event_type))
      .not.toContain("morning_digest");
    expect((await repository.pendingHermesNotices("1970-01-01T00:00:00.000Z", 20))
      .map((row) => row.event_type)).not.toContain("morning_digest");

    expect(await repository.suppressRetiredMorningDigests()).toBe(1);
    expect(await repository.suppressRetiredMorningDigests()).toBe(0);
    const retired = await testDatabase.prepare(
      "SELECT status,email_suppressed_at FROM events WHERE id='legacy-morning-digest'",
    ).first<{ status: string; email_suppressed_at: string | null }>();
    expect(retired?.status).toBe("suppressed");
    expect(retired?.email_suppressed_at).toBeTruthy();
  });

  it("combines one keyword scan across sources into one deliverable digest", async () => {
    const repository = new RadarRepository(testDatabase);
    const firstSeed = await seedBinding("keyword-digest-yahoo", "yahoo_shopping");
    const secondSeed = await seedBinding("keyword-digest-rakuten", "rakuten_ichiba");
    await testDatabase.batch([
      testDatabase.prepare(
        `UPDATE watch_bindings SET watch_profile_id=?,monitoring_purpose='keyword_new_listing',
         baseline_completed=1,notify_new_listing=1 WHERE id=?`,
      ).bind(firstSeed.watch_profile_id, firstSeed.id),
      testDatabase.prepare(
        `UPDATE watch_bindings SET watch_profile_id=?,monitoring_purpose='keyword_new_listing',
         baseline_completed=1,notify_new_listing=1 WHERE id=?`,
      ).bind(firstSeed.watch_profile_id, secondSeed.id),
    ]);
    const bindings = await testDatabase.prepare(
      "SELECT * FROM watch_bindings WHERE id IN (?,?) ORDER BY source_id",
    ).bind(firstSeed.id, secondSeed.id).all<WatchBindingRow>();
    expect(bindings.results).toHaveLength(2);
    const scanStartedAt = new Date(Date.now() - 60_000).toISOString();

    for (const [index, binding] of bindings.results.entries()) {
      const persisted = await repository.persistListing(binding, {
        sourceId: binding.source_id,
        sourceItemId: `digest-item-${index}`,
        identityScope: "listing",
        canonicalUrl: `https://example.test/${binding.source_id}/digest-item-${index}`,
        title: `Re:ゼロ エミリア 新商品 ${index + 1}`,
        imageUrl: `https://images.example.test/emilia-${index + 1}.jpg`,
        currency: "JPY",
        currentPrice: 680 + index * 100,
        priceBasis: "listing_price",
        condition: "used",
        availability: "available",
      });
      const events = evaluateListingEvents({
        bindingId: binding.id,
        listingId: persisted.listingId,
        current: { price: 680 + index * 100, availability: "available" },
        isNewMatch: persisted.isNewMatch,
        baselineCompleted: true,
        notifyInitial: false,
        notifyNewListing: true,
        notifyPriceDrop: false,
        notifyRestock: false,
        notifySoldOut: false,
        minDropAmount: 100,
      });
      expect(await repository.insertEventBatch(binding, [{ listingId: persisted.listingId, events }])).toBe(1);
      const run = await repository.createRun(binding.id, "cron");
      await repository.finishRun(run, {
        status: binding.source_id === "rakuten_ichiba" ? "skipped" : "success",
        coverage: "rolling_window",
        resultCount: 1,
        newCount: 1,
        changedCount: 1,
        ...(binding.source_id === "rakuten_ichiba" ? {
          errorCode: "suspected_source_degradation",
          errorMessage: "fixture safety rejection",
        } : {}),
      });
    }

    expect(await repository.pendingEmailCount()).toBe(0);
    const job: MonitorJob = {
      type: "finalize_keyword_digest",
      profileId: firstSeed.watch_profile_id,
      bindingIds: bindings.results.map((binding) => binding.id),
      scanStartedAt,
      digestKey: "keyword_digest:test:cross-source",
      finalizeAttempt: 1,
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "keyword-digest-message",
      timestamp: new Date(),
      attempts: 1,
      body: job,
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const queueResult = await getQueueResult(batch, ctx);
    expect(queueResult.explicitAcks).toEqual(["keyword-digest-message"]);

    const rawEvents = await testDatabase.prepare(
      "SELECT status FROM events WHERE event_type='new_listing' ORDER BY created_at",
    ).all<{ status: string }>();
    const digests = await testDatabase.prepare(
      "SELECT payload_json,status FROM events WHERE event_key='keyword_digest:test:cross-source'",
    ).all<{ payload_json: string; status: string }>();
    expect(rawEvents.results.map((event) => event.status)).toEqual(["suppressed", "suppressed"]);
    expect(digests.results).toHaveLength(1);
    expect(digests.results[0]!.status).toBe("pending");
    expect(JSON.parse(digests.results[0]!.payload_json)).toMatchObject({
      kind: "keyword_scan_summary",
      total: 2,
      sourceCounts: expect.arrayContaining([
        { sourceId: "rakuten_ichiba", count: 1 },
        { sourceId: "yahoo_shopping", count: 1 },
      ]),
      failedSources: ["rakuten_ichiba"],
      sourceIssues: [{
        sourceId: "rakuten_ichiba",
        status: "skipped",
        errorCode: "suspected_source_degradation",
      }],
      items: expect.arrayContaining([
        expect.objectContaining({ sourceId: "rakuten_ichiba", price: 680 }),
        expect.objectContaining({ sourceId: "yahoo_shopping", price: 780 }),
      ]),
    });
    expect(await repository.pendingEmailCount()).toBe(1);
    const notified = await testDatabase.prepare(
      "SELECT COUNT(*) count FROM watch_listing_matches WHERE new_listing_notified_at IS NOT NULL",
    ).first<{ count: number }>();
    expect(notified?.count).toBe(2);

    await repository.prepareKeywordDigest({
      profileId: firstSeed.watch_profile_id,
      bindingIds: bindings.results.map((binding) => binding.id),
      scanStartedAt,
      scanFinishedAt: new Date().toISOString(),
      digestKey: "keyword_digest:test:cross-source",
      failedSources: [],
    });
    const digestCount = await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE event_key='keyword_digest:test:cross-source'",
    ).first<{ count: number }>();
    expect(digestCount?.count).toBe(1);

    const resetAt = new Date().toISOString();
    await testDatabase.batch(keywordBaselineResetStatements(testDatabase, {
      profileId: firstSeed.watch_profile_id,
      resetAt,
    }));
    const resetBindings = await testDatabase.prepare(
      "SELECT baseline_completed,next_run_at FROM watch_bindings WHERE watch_profile_id=? ORDER BY id",
    ).bind(firstSeed.watch_profile_id).all<{ baseline_completed: number; next_run_at: string }>();
    expect(resetBindings.results).toHaveLength(2);
    expect(resetBindings.results.every((binding) => binding.baseline_completed === 0 && binding.next_run_at === resetAt)).toBe(true);
    const resetDigest = await testDatabase.prepare(
      "SELECT status FROM events WHERE event_key='keyword_digest:test:cross-source'",
    ).first<{ status: string }>();
    expect(resetDigest?.status).toBe("suppressed");
    expect(await repository.pendingEmailCount()).toBe(0);
  });

  it("creates one completion digest for an initial keyword baseline without new-listing events", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("keyword-initial-baseline", "mercari_jp");
    await testDatabase.prepare(
      `UPDATE watch_bindings SET monitoring_purpose='keyword_new_listing',baseline_completed=0,
       notify_new_listing=1 WHERE id=?`,
    ).bind(binding.id).run();
    const current = (await repository.getBinding(binding.id))!;
    const scanStartedAt = new Date(Date.now() - 60_000).toISOString();
    await repository.persistListing(current, {
      sourceId: "mercari_jp",
      sourceItemId: "initial-kato-megumi",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/initial-kato-megumi",
      title: "加藤恵 アクリルスタンド",
      currency: "JPY",
      currentPrice: 1_200,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    });

    const digestId = await repository.prepareKeywordDigest({
      profileId: binding.watch_profile_id,
      bindingIds: [binding.id],
      initialBaselineBindingIds: [binding.id],
      scanStartedAt,
      scanFinishedAt: new Date().toISOString(),
      digestKey: "keyword_digest:test:initial-baseline",
      failedSources: [],
    });

    expect(digestId).toBeTruthy();
    const digest = await testDatabase.prepare(
      "SELECT payload_json FROM events WHERE event_key='keyword_digest:test:initial-baseline'",
    ).first<{ payload_json: string }>();
    expect(JSON.parse(digest!.payload_json)).toMatchObject({
      kind: "keyword_scan_summary",
      total: 1,
      baselineTotal: 1,
      newTotal: 0,
      items: [expect.objectContaining({ sourceId: "mercari_jp", title: "加藤恵 アクリルスタンド" })],
    });
    expect(await testDatabase.prepare(
      "SELECT COUNT(*) count FROM events WHERE event_type='new_listing'",
    ).first<{ count: number }>()).toMatchObject({ count: 0 });
    expect(await repository.pendingEmailCount()).toBe(1);
  });

  it("keeps mixed source baselines and recovered keyword evidence separate", async () => {
    const repository = new RadarRepository(testDatabase);
    const existing = await seedBinding("mixed-existing", "mercari_jp");
    const added = await seedBinding("mixed-added", "rakuten_ichiba");
    await testDatabase.prepare("UPDATE watch_bindings SET watch_profile_id=? WHERE id=?")
      .bind(existing.watch_profile_id, added.id).run();
    const previousRun = await repository.createRun(existing.id, "cron");
    const previousAt = new Date(Date.now() - 60_000).toISOString();
    await testDatabase.prepare("UPDATE watch_runs SET started_at=?,status='success',result_count=0 WHERE id=?")
      .bind(previousAt, previousRun.id).run();
    const listing: NormalizedListing = {
      sourceId: "mercari_jp", sourceItemId: "recovered-item", identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/recovered-item", title: "加藤恵",
      currency: "JPY", currentPrice: 1000, priceBasis: "listing_price", condition: "used", availability: "available",
    };
    await repository.recordRunListingObservations([{
      runId: previousRun.id, bindingId: existing.id, sourceId: listing.sourceId, sourceItemId: listing.sourceItemId,
      canonicalUrl: listing.canonicalUrl, title: listing.title, currency: "JPY", priceBasis: "listing_price",
      availability: "available", itemCondition: "used", ordinal: 1, observedAt: previousAt,
      decisionStatus: "rejected", purchasable: true,
    }]);
    const scanStartedAt = new Date().toISOString();
    const currentRun = await repository.createRun(existing.id, "cron");
    const recovered = await repository.persistListing(existing, listing, { linkToWatch: false });
    const acceptance = await repository.acceptListingMatch({
      bindingId: existing.id, listingId: recovered.listingId, acceptanceReason: "keyword_relevant", currentRunId: currentRun.id,
    });
    expect(acceptance).toEqual({ isNewMatch: true, recoveredMatch: true });
    const fresh = await repository.persistListing(existing, { ...listing, sourceItemId: "fresh", canonicalUrl: "https://jp.mercari.com/item/fresh" });
    await repository.persistListing(added, { ...listing, sourceId: "rakuten_ichiba", sourceItemId: "baseline", canonicalUrl: "https://item.rakuten.co.jp/test/baseline" });
    for (const [stored, isRecovered] of [[recovered, true], [fresh, false]] as const) {
      await repository.insertEventBatch(existing, [{ listingId: stored.listingId, events: evaluateListingEvents({
        bindingId: existing.id, listingId: stored.listingId, current: { price: 1000, availability: "available" },
        isNewMatch: true, recoveredMatch: isRecovered, baselineCompleted: true, notifyInitial: false,
        notifyPriceDrop: false, notifyRestock: false, notifySoldOut: false, minDropAmount: 1,
      }) }]);
    }
    const digestId = await repository.prepareKeywordDigest({
      profileId: existing.watch_profile_id, bindingIds: [existing.id, added.id], initialBaselineBindingIds: [added.id],
      scanStartedAt, scanFinishedAt: new Date().toISOString(), digestKey: "mixed-keyword-digest", failedSources: [],
    });
    const digest = await testDatabase.prepare("SELECT payload_json FROM events WHERE id=?").bind(digestId).first<{ payload_json: string }>();
    expect(JSON.parse(digest!.payload_json)).toMatchObject({
      kind: "keyword_scan_summary", total: 3, newTotal: 1, recoveredTotal: 1, baselineTotal: 1,
      baselineSourceIds: ["rakuten_ichiba"], items: expect.arrayContaining([
        expect.objectContaining({ category: "recovered" }), expect.objectContaining({ category: "new" }),
        expect.objectContaining({ category: "baseline" }),
      ]),
    });
    expect(await repository.acceptListingMatch({
      bindingId: existing.id, listingId: recovered.listingId, acceptanceReason: "keyword_relevant", currentRunId: currentRun.id,
    })).toEqual({ isNewMatch: false, recoveredMatch: false });
  });

  it("defers a temporarily missing item without leaving source-failure state", async () => {
    const repository = new RadarRepository(testDatabase);
    const binding = await seedBinding("rakuten-missing-item", "rakuten_ichiba");
    await testDatabase.prepare(
      `UPDATE watch_bindings SET kind='item',consecutive_failures=6,last_error_code='http_404',
       last_error_message='missing' WHERE id=?`,
    ).bind(binding.id).run();
    const before = Date.now();
    const nextRunAt = await repository.deferTemporarilyUnavailableItem(binding.id, 24);
    const deferred = await testDatabase.prepare(
      `SELECT next_run_at,consecutive_failures,last_error_code,last_error_message
       FROM watch_bindings WHERE id=?`,
    ).bind(binding.id).first<{
      next_run_at: string;
      consecutive_failures: number;
      last_error_code: string | null;
      last_error_message: string | null;
    }>();

    expect(deferred).toMatchObject({
      next_run_at: nextRunAt,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_message: null,
    });
    expect(Date.parse(nextRunAt) - before).toBeGreaterThanOrEqual(23 * 60 * 60 * 1_000);
  });

  it("uses a fake Resend endpoint with the production idempotency header", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ id: "email_workerd_1" });
    }));
    const id = await sendResendEmail({ apiKey: "test", from: "Radar <alerts@example.com>", to: "owner@example.com",
      subject: "Digest", html: "<p>Digest</p>", text: "Digest", idempotencyKey: "daily_digest/2026-07-12" });
    expect(id).toBe("email_workerd_1");
    expect(request?.headers.get("Idempotency-Key")).toBe("daily_digest/2026-07-12");
  });

  it("runs Yahoo Auctions through direct public HTML once and reuses its short normalized cache", async () => {
    const initial = await testDatabase.prepare(
      "SELECT enabled,health_status,request_route FROM source_registry WHERE id='yahoo_auctions_jp'",
    ).first<{ enabled: number; health_status: string; request_route: string }>();
    expect(initial).toEqual({ enabled: 1, health_status: "unknown", request_route: "direct" });
    const sourceStatus = await worker.fetch(
      new Request("https://collector.test/internal/source-status") as Parameters<typeof worker.fetch>[0],
      env,
    );
    expect(await sourceStatus.json()).toMatchObject({
      sources: expect.arrayContaining([{
        sourceId: "yahoo_auctions_jp",
        adapterAvailable: true,
        historySearchSupported: true,
        credentialStatus: "not_required",
        requestRoute: "direct",
      }]),
      yahooAuctions: { experimentalEnabled: true, requestRoute: "direct" },
    });

    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin + url.pathname).toBe("https://auctions.yahoo.co.jp/search/search");
      expect(url.searchParams.get("p")).toBe("ポケモンカード");
      expect(url.searchParams.get("istatus")).toBe("3,4,5,6,7,2");
      expect(init?.method).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(init?.body).toBeUndefined();
      return new Response(`<!doctype html><html><body>${"fixture ".repeat(300)}
        <li class="Tab__item Tab__item--current"><span class="Tab__subText">1件</span></li>
        <ul class="Products__items"><li class="Product">
          <div class="Product__bonus" data-auction-id="x1234567890" data-auction-endtime="1784471983"
            data-auction-buynowprice="5200" data-auction-categoryidpath="1,2084317608" data-auction-price="3888"></div>
          <h3 class="Product__title"><a class="Product__titleLink" data-auction-id="x1234567890"
            data-auction-category="2084317608" data-auction-title="合成测试用 ポケモンカード"
            data-auction-img="https://auc-pctr.c.yimg.jp/synthetic/item.jpg" data-auction-price="3888"
            data-auction-isfreeshipping="" data-auction-isflea=""
            data-cl-params="st:1784130604;etc:p=3888,b=3,w=12,x=1;"
            href="https://auctions.yahoo.co.jp/jp/auction/x1234567890">合成测试用 ポケモンカード</a></h3>
          <dl><div><dd class="Product__bid">3</dd></div></dl>
        </li></ul>
      </body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);
    await testDatabase.prepare(
      "UPDATE source_registry SET enabled=1,health_status='healthy',last_error_code=NULL,last_error_message=NULL WHERE id='yahoo_auctions_jp'",
    ).run();
    const configuredEnv = {
      ...env,
      YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true",
      YAHOO_AUCTIONS_TIMEOUT_MS: "5000",
      YAHOO_AUCTIONS_RATE_INTERVAL_MS: "2000",
      YAHOO_AUCTIONS_SEARCH_CACHE_SECONDS: "45",
      YAHOO_AUCTIONS_DETAIL_CACHE_SECONDS: "30",
    } as Env;
    const previewRequest = () => new Request("https://collector.test/internal/search-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "ポケモンカード",
        sources: ["yahoo_auctions_jp"],
        conditions: ["used"],
        availabilityMode: "purchasable",
      }),
    }) as Parameters<typeof worker.fetch>[0];

    const first = await worker.fetch(previewRequest(), configuredEnv);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      query: "ポケモンカード",
      groups: [{
        sourceId: "yahoo_auctions_jp",
        status: "success",
        requestRoute: "direct",
        listings: [{ sourceItemId: "x1234567890", currentPrice: 3_888, condition: "used", availability: "available" }],
      }],
    });
    const second = await worker.fetch(previewRequest(), configuredEnv);
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ groups: Array<{ warnings: string[] }> }>();
    expect(secondBody.groups[0]?.warnings.join(" ")).toContain("短时标准化缓存");
    expect(upstream).toHaveBeenCalledTimes(1);

    const history = await testDatabase.prepare(
      "SELECT query,status,result_count,sources_json FROM search_history ORDER BY searched_at",
    ).all<{ query: string; status: string; result_count: number; sources_json: string }>();
    expect(history.results).toHaveLength(2);
    expect(history.results[0]).toMatchObject({ query: "ポケモンカード", status: "success", result_count: 1 });
    expect(JSON.parse(history.results[0]!.sources_json)).toEqual(["yahoo_auctions_jp"]);
    const snapshots = await testDatabase.prepare(
      "SELECT group_json FROM search_result_snapshots WHERE source_id='yahoo_auctions_jp'",
    ).all<{ group_json: string }>();
    expect(snapshots.results).toHaveLength(2);
    expect(snapshots.results.every((row) => !row.group_json.includes("must-not-reach-the-search-snapshot"))).toBe(true);
  });

  it("opens the Yahoo Auctions local circuit after five bounded failures", async () => {
    const configuredEnv = { ...env, YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true" } as Env;
    const search = vi.fn(async () => {
      throw new AdapterError("synthetic upstream outage", "yahoo_auctions_upstream_unavailable", 503, true);
    });
    const adapter: SourceAdapter = {
      id: "yahoo_auctions_jp",
      transport: "internal_api",
      parserVersion: "synthetic-circuit-test",
      coverage: "best_effort",
      capabilities: {
        keywordSearch: true,
        itemLookup: false,
        newestSort: false,
        priceFilter: false,
        conditionFilter: false,
        supportsUsed: true,
        historySearchSupported: false,
      },
      search,
    };
    const request = { query: "circuit-fixture", filters: { availabilityMode: "purchasable" as const } };
    const context = { fetch, secrets: { YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true" } };

    for (let failure = 0; failure < 5; failure += 1) {
      await testDatabase.prepare(
        "UPDATE experimental_source_runtime SET next_request_at=NULL WHERE source_id='yahoo_auctions_jp'",
      ).run();
      await expect(searchYahooAuctionsWithRuntime(configuredEnv, adapter, request, context))
        .rejects.toMatchObject({ code: "yahoo_auctions_upstream_unavailable" });
    }
    const state = await testDatabase.prepare(
      "SELECT failure_count,circuit_until FROM experimental_source_runtime WHERE source_id='yahoo_auctions_jp'",
    ).first<{ failure_count: number; circuit_until: string | null }>();
    expect(state?.failure_count).toBe(5);
    expect(Date.parse(state?.circuit_until ?? "")).toBeGreaterThan(Date.now());
    await expect(searchYahooAuctionsWithRuntime(configuredEnv, adapter, request, context))
      .rejects.toMatchObject({ code: "yahoo_auctions_circuit_open", retryable: true });
    expect(search).toHaveBeenCalledTimes(5);
  });

  it("reserves Yahoo Auctions slots for three concurrent callers without a local rate failure", async () => {
    const configuredEnv = {
      ...env,
      YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true",
      YAHOO_AUCTIONS_RATE_INTERVAL_MS: "2000",
      YAHOO_AUCTIONS_SEARCH_CACHE_SECONDS: "45",
    } as Env;
    const starts: number[] = [];
    const search = vi.fn(async (request: SearchRequest): Promise<SearchResult> => {
      starts.push(Date.now());
      return {
        sourceId: "yahoo_auctions_jp",
        listings: [],
        coverage: "best_effort",
        warnings: [`completed ${request.query}`],
        parserVersion: "synthetic-slot-reservation-test",
        fetchedAt: new Date().toISOString(),
      };
    });
    const adapter: SourceAdapter = {
      id: "yahoo_auctions_jp",
      transport: "html_endpoint",
      parserVersion: "synthetic-slot-reservation-test",
      coverage: "best_effort",
      capabilities: {
        keywordSearch: true,
        itemLookup: false,
        newestSort: false,
        priceFilter: false,
        conditionFilter: false,
        supportsUsed: true,
        historySearchSupported: true,
      },
      search,
    };
    const context = { fetch, secrets: { YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true" } };
    const results = await Promise.all(["slot-one", "slot-two", "slot-three"].map((query) => (
      searchYahooAuctionsWithRuntime(
        configuredEnv,
        adapter,
        { query, filters: { availabilityMode: "purchasable" } },
        context,
      )
    )));

    expect(results).toHaveLength(3);
    expect(search).toHaveBeenCalledTimes(3);
    const orderedStarts = [...starts].sort((left, right) => left - right);
    expect(orderedStarts[1]! - orderedStarts[0]!).toBeGreaterThanOrEqual(1_500);
    expect(orderedStarts[2]! - orderedStarts[1]!).toBeGreaterThanOrEqual(1_500);
    const state = await testDatabase.prepare(
      "SELECT failure_count,circuit_until FROM experimental_source_runtime WHERE source_id='yahoo_auctions_jp'",
    ).first<{ failure_count: number; circuit_until: string | null }>();
    expect(state).toEqual({ failure_count: 0, circuit_until: null });
  });
});
