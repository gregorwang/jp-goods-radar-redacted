import { describe, expect, it, vi } from "vitest";
import { yahooFleamarketAdapter } from "../packages/adapters/src/yahoo-fleamarket";
import { surugayaAdapter } from "../packages/adapters/src/surugaya";
import { amazonJapanAdapter } from "../packages/adapters/src/amazon";
import {
  browserRunFallbackConfigured,
  createBrowserRunFetch,
} from "../apps/collector/src/browser-run-fallback";
import {
  itemWithConfiguredRoute,
  searchWithConfiguredRoute,
  type SourceRouteSession,
} from "../apps/collector/src/source-execution";

function fleaSearchHtml(): string {
  const nextData = {
    props: {
      initialState: {
        searchState: {
          search: {
            result: {
              totalResultsAvailable: 1,
              totalResultsReturned: 1,
              offset: 0,
              items: [{
                id: "z589863828",
                title: "Browser Run 合成测试商品",
                price: 7_200,
                itemStatus: "OPEN",
                condition: "used",
              }],
            },
          },
        },
      },
    },
  };
  return `<!doctype html><html><body><main>${"fixture ".repeat(300)}</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

function amazonSearchHtml(): string {
  return `<!doctype html><html lang="ja"><head><title>Amazon.co.jp 検索結果</title></head><body>
    <div data-component-type="s-search-result" data-asin="B0GZ9NMHFJ">
      <h2><span>雪ミク Browser Run 商品</span></h2>
      <span class="a-price"><span class="a-offscreen">￥4,980</span></span>
    </div><!--${"amazon-browser-padding".repeat(180)}--></body></html>`;
}

function surugayaVerifiedEmptyHtml(): string {
  return `<!doctype html><html lang="ja"><head><title>検索結果 | 中古・新品通販の駿河屋</title></head><body>
    <main><h1>該当件数</h1><p>検索結果は０件です。条件を変更して下さい。</p></main>
    <!--${"verified-empty-padding".repeat(500)}--></body></html>`;
}

function envWithBrowser(quickAction: ReturnType<typeof vi.fn>): Env {
  return {
    BROWSER_RUN_FALLBACK_ENABLED: "true",
    YAHOO_FLEAMARKET_CLOUDFLARE_DIRECT_ENABLED: "true",
    BROWSER: { quickAction },
  } as unknown as Env;
}

describe("Cloudflare Browser Run bounded fallback", () => {
  it("renders only a fixed allowlisted URL and unwraps the content response", async () => {
    const quickAction = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: fleaSearchHtml(),
      meta: { status: 200, title: "fixture" },
    }), { status: 200, headers: { "Content-Type": "application/json", "X-Browser-Ms-Used": "123" } }));
    const env = envWithBrowser(quickAction);
    expect(browserRunFallbackConfigured("yahoo_fleamarket_jp", env)).toBe(true);

    const fetcher = createBrowserRunFetch(env, "yahoo_fleamarket_jp");
    const response = await fetcher("https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AA%E3%82%BC%E3%83%AD?page=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-jpgr-browser-run")).toBe("1");
    expect(await response.text()).toContain("__NEXT_DATA__");
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({
      url: "https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AA%E3%82%BC%E3%83%AD?page=1",
      rejectResourceTypes: ["image", "media", "font", "stylesheet"],
    }));

    await expect(fetcher("https://example.com/search/test"))
      .rejects.toMatchObject({ code: "browser_run_url_rejected", status: 400 });
    expect(quickAction).toHaveBeenCalledTimes(1);
  });

  it("uses Browser Run only after direct Yahoo! Fleamarket failure and records route evidence", async () => {
    const directFetch = vi.fn(async () => new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const browserFetch = vi.fn(async () => new Response(fleaSearchHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const env = envWithBrowser(vi.fn());

    const result = await searchWithConfiguredRoute(
      env,
      yahooFleamarketAdapter,
      { query: "リゼロ", filters: { availabilityMode: "all" } },
      { fetch: directFetch, secrets: {} },
      { browserFetch },
    );

    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      requestRoute: "browser_run",
      routeOutcome: {
        kind: "fallback_success",
        primaryRoute: "direct",
        fallbackRoute: "browser_run",
        primaryFailure: { status: 403, code: "http_403" },
      },
      listings: [{ sourceId: "yahoo_fleamarket_jp", sourceItemId: "z589863828" }],
    });
  });

  it("sets Amazon Japan locale cookies and restricts Browser Run to search pages", async () => {
    const quickAction = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: amazonSearchHtml(),
      meta: { status: 200, title: "Amazon fixture" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const env = envWithBrowser(quickAction);
    const fetcher = createBrowserRunFetch(env, "amazon_jp");
    const response = await fetcher("https://www.amazon.co.jp/s?k=%E9%9B%AA%E3%83%9F%E3%82%AF&language=ja_JP");

    expect(response.status).toBe(200);
    expect(quickAction).toHaveBeenCalledWith("content", expect.objectContaining({
      url: "https://www.amazon.co.jp/s?k=%E9%9B%AA%E3%83%9F%E3%82%AF&language=ja_JP",
      cookies: expect.arrayContaining([
        { name: "i18n-prefs", value: "JPY", url: "https://www.amazon.co.jp/" },
        { name: "lc-acbjp", value: "ja_JP", url: "https://www.amazon.co.jp/" },
      ]),
      setExtraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9" },
    }));
    await expect(fetcher("https://www.amazon.co.jp/dp/B0GZ9NMHFJ"))
      .rejects.toMatchObject({ code: "browser_run_url_rejected", status: 400 });
  });

  it("uses Browser Run only after direct Amazon Japan failure", async () => {
    const directFetch = vi.fn(async () => new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const browserFetch = vi.fn(async () => new Response(amazonSearchHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;

    const result = await searchWithConfiguredRoute(
      { AMAZON_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env,
      amazonJapanAdapter,
      { query: "雪ミク", filters: { availabilityMode: "all" } },
      { fetch: directFetch, secrets: {} },
      { browserFetch },
    );

    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      requestRoute: "browser_run",
      routeOutcome: {
        kind: "fallback_success",
        primaryRoute: "direct",
        fallbackRoute: "browser_run",
        primaryFailure: { status: 403, code: "http_403" },
      },
      listings: [{ sourceId: "amazon_jp", sourceItemId: "B0GZ9NMHFJ", currentPrice: 4_980 }],
    });
  });

  it("keeps Amazon item monitoring active through Browser Run while direct collection cools down", async () => {
    const directFetch = vi.fn() as unknown as typeof fetch;
    const browserFetch = vi.fn(async () => new Response(amazonSearchHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
    const item = await itemWithConfiguredRoute(
      { AMAZON_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env,
      amazonJapanAdapter,
      "B0GZ9NMHFJ",
      { fetch: directFetch, secrets: {} },
      {
        browserFetch,
        skippedPrimaryFailure: {
          code: "source_cooldown",
          status: 403,
          retryable: false,
          message: "Cloudflare 直连临时冷却",
          attempts: [{ attempt: 0, code: "http_403", status: 403, message: "Cloudflare 直连临时冷却" }],
        },
      },
    );

    expect(directFetch).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(item).toMatchObject({ sourceItemId: "B0GZ9NMHFJ", currentPrice: 4_980 });
  });

  it("treats an explicit Surugaya zero-result 404 as success and opens the direct-route breaker", async () => {
    const directFetch = vi.fn(async () => new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;
    const browserFetch = vi.fn(async () => new Response(surugayaVerifiedEmptyHtml(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
    const routeSession: SourceRouteSession = {};
    const surugayaEnv = { SURUGAYA_CLOUDFLARE_DIRECT_ENABLED: "true" } as Env;

    const first = await searchWithConfiguredRoute(
      surugayaEnv,
      surugayaAdapter,
      { query: "エミリア F:NEX", filters: { availabilityMode: "all" } },
      { fetch: directFetch, secrets: {} },
      { browserFetch, routeSession },
    );
    const second = await searchWithConfiguredRoute(
      surugayaEnv,
      surugayaAdapter,
      { query: "エミリア ぬいぐるみ", filters: { availabilityMode: "all" } },
      { fetch: directFetch, secrets: {} },
      { browserFetch, routeSession },
    );

    expect(first).toMatchObject({
      listings: [],
      requestRoute: "browser_run",
      requestEvidence: { collectionOutcome: "verified_empty" },
      routeOutcome: { kind: "fallback_success", primaryFailure: { status: 403 } },
    });
    expect(second).toMatchObject({
      listings: [],
      requestRoute: "browser_run",
      requestEvidence: { collectionOutcome: "verified_empty" },
    });
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });
});
