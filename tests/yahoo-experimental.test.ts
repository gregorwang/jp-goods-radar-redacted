import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../packages/core/src";
import {
  createYahooShoppingAdapter,
  extractYahooNextData,
  parseYahooBootstrapHtml,
  resolveYahooShoppingPageUrl,
} from "../packages/adapters/src/yahoo-shopping";
import { normalizeYahooListings } from "../packages/adapters/src/yahoo-shopping/normalize";
import { normalizedListingSchema } from "../packages/validation/src";
import { yahooSearchBodySchema } from "../apps/mercari-service/src/schemas";
import { searchYahooWithCache } from "../apps/mercari-service/src/yahoo-runtime";

const bootstrapHtml = readFileSync(new URL("./fixtures/yahoo-experimental/bootstrap.html", import.meta.url), "utf8");
const page2Json = readFileSync(new URL("./fixtures/yahoo-experimental/page-2.json", import.meta.url), "utf8");
const page2Html = `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { initialState: { bff: JSON.parse(page2Json) as unknown } },
})}</script></body></html>`;
const yahooSecrets = {
  YAHOO_WEB_EXPERIMENTAL_ENABLED: "true",
  YAHOO_WEB_EXPERIMENTAL_MAX_PAGES: "3",
  YAHOO_WEB_EXPERIMENTAL_DELAY_MS: "2000",
};

describe("Yahoo Shopping experimental public-HTML adapter", () => {
  it("treats Yahoo's zero original-price sentinel as missing evidence", () => {
    const { listings } = normalizeYahooListings([{
      itemId: "fixture-store_zero-original-price",
      name: "原价字段なし商品",
      url: "https://store.shopping.yahoo.co.jp/fixture-store/zero-original-price.html",
      price: 1_980,
      actualPrice: 1_980,
      originalPrice: 0,
    }]);

    expect(listings).toHaveLength(1);
    expect(listings[0]?.originalPrice).toBeUndefined();
    expect(listings[0]?.facts?.priceReferences).toBeUndefined();
    expect(normalizedListingSchema.safeParse(listings[0]).success).toBe(true);
  });

  it("invokes a Workers runtime fetch reference without an object receiver", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation fixture");
      return Promise.resolve(new Response(bootstrapHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "YAHOO_ANON=fixture-anonymous-cookie; Path=/; HttpOnly; SameSite=Lax",
        },
      }));
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });

    const result = await adapter.search(
      { query: "陶器", filters: {}, sourceConfig: { pageCount: 1 } },
      { fetch: fetcher, secrets: yahooSecrets },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.listings).toHaveLength(1);
  });

  it("follows one canonical same-origin bootstrap redirect and rejects unsafe redirects", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const redirectedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return new Response(null, {
          status: 301,
          headers: {
            Location: "/search/Re%3A%E3%82%BC%E3%83%AD+%E3%82%A8%E3%83%9F%E3%83%AA%E3%82%A2/0/?prom=1&view=grid",
            "Set-Cookie": "YAHOO_REDIRECT=canonical-session; Path=/; HttpOnly",
          },
        });
      }
      return new Response(bootstrapHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "YAHOO_ANON=redirect-session; Path=/; HttpOnly",
        },
      });
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });

    const result = await adapter.search(
      { query: "Re:ゼロ エミリア", filters: {}, sourceConfig: { pageCount: 1 } },
      { fetch: redirectedFetch, secrets: yahooSecrets },
    );

    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).origin).toBe("https://shopping.yahoo.co.jp");
    expect(new URL(requests[1]!.url).pathname).toContain("Re%3A");
    expect(requests[0]!.headers.has("cookie")).toBe(false);
    expect(requests[1]!.headers.get("cookie")).toBe("YAHOO_REDIRECT=canonical-session");
    expect(result.listings).toHaveLength(1);

    const unsafeFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/search/escaped/0/" },
    })) as unknown as typeof fetch;
    await expect(adapter.search(
      { query: "Re:ゼロ エミリア", filters: {}, sourceConfig: { pageCount: 1 } },
      { fetch: unsafeFetch, secrets: yahooSecrets },
    )).rejects.toMatchObject({ code: "yahoo_unexpected_redirect", status: 502 });
    expect(unsafeFetch).toHaveBeenCalledTimes(1);

    const loopingFetch = vi.fn(async () => new Response(null, {
      status: 301,
      headers: { Location: "/search/canonical-loop/0/?prom=1&view=grid" },
    })) as unknown as typeof fetch;
    await expect(adapter.search(
      { query: "Re:ゼロ エミリア", filters: {}, sourceConfig: { pageCount: 1 } },
      { fetch: loopingFetch, secrets: yahooSecrets },
    )).rejects.toMatchObject({ code: "yahoo_unexpected_redirect", status: 502 });
    expect(loopingFetch).toHaveBeenCalledTimes(3);
  });

  it("uses one anonymous HTML session and a field whitelist across pages", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (new URL(url).pathname.endsWith("/0/2/")) {
        return new Response(page2Html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(bootstrapHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "YAHOO_ANON=fixture-anonymous-cookie; Path=/; HttpOnly; SameSite=Lax",
        },
      });
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });

    const result = await adapter.search({
      query: "氷菓 Blu-ray",
      filters: { minPrice: 3_000, maxPrice: 10_000, conditions: ["new"], inStockOnly: true },
      sourceConfig: { categoryId: "0", pageCount: 2 },
    }, { fetch: fetcher, secrets: yahooSecrets });

    expect(requests).toHaveLength(2);
    const bootstrap = new URL(requests[0]!.url);
    expect(bootstrap.origin).toBe("https://shopping.yahoo.co.jp");
    expect(bootstrap.searchParams.get("pf")).toBe("3000");
    expect(bootstrap.searchParams.get("pt")).toBe("10000");

    const secondPage = requests[1]!;
    expect(new URL(secondPage.url).pathname).toBe("/search/%E6%B0%B7%E8%8F%93%20Blu-ray/0/2/");
    expect(new URL(secondPage.url).searchParams.get("pf")).toBe("3000");
    expect(secondPage.headers.get("cookie")).toBe("YAHOO_ANON=fixture-anonymous-cookie");
    expect(secondPage.headers.get("referer")).toBe(bootstrap.href);
    expect(secondPage.headers.has("crumb")).toBe(false);
    expect(secondPage.headers.has("current-url")).toBe(false);
    expect(secondPage.headers.has("x-b3-traceid")).toBe(false);

    expect(result.listings).toHaveLength(2);
    expect(result.listings[0]).toMatchObject({
      sourceId: "yahoo_shopping",
      sourceItemId: "fixture-store_item-1",
      canonicalUrl: "https://store.shopping.yahoo.co.jp/fixture-store/item-1.html",
      descriptionExcerpt: "TVアニメ「氷菓」の限定版Blu-ray。特典ブックレット付き。",
      currentPrice: 5563,
      originalPrice: 6500,
      condition: "unknown",
      availability: "unknown",
      shopName: "テスト書店",
      facts: {
        identifiers: { sku: "fixture-sku-1" },
        brand: "KADOKAWA",
        displayFacts: [
          { key: "delivery", kind: "list", values: ["最短翌日配送"] },
          { key: "discount_rate", kind: "text", value: "15%" },
          { key: "product_review", kind: "text", value: "平均 4.6 · 128 件评价" },
          { key: "seller_review", kind: "text", value: "平均 4.7 · 321 件评价" },
          { key: "seller_best_store", kind: "text", value: "是" },
          { key: "category_id", kind: "text", value: "12345" },
          { key: "shipping_code", kind: "text", value: "2" },
        ],
      },
      rawMetadata: { basePrice: 5830, payablePrice: 5563, categoryId: "12345" },
    });
    expect(result.totalAvailable).toBe(200);
    expect(result.requestEvidence).toMatchObject({ rawResultCount: 3, normalizedResultCount: 2, pagesFetched: 2 });
    expect(result.warnings.join(" ")).toContain("未应用新品/中古筛选");

    const publicOutput = JSON.stringify(result);
    expect(publicOutput).not.toContain("fixture-session-crumb");
    expect(publicOutput).not.toContain("fixture-anonymous-cookie");
    expect(publicOutput).not.toContain("must-not-leak");
    expect(publicOutput).not.toContain("dataBeacon");
    expect(publicOutput).not.toContain("browserFingerprint");
  });

  it("returns only the requested logical HTML page", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new URL(url).pathname.endsWith("/0/2/")
        ? new Response(page2Html, { headers: { "Content-Type": "text/html" } })
        : new Response(bootstrapHtml, {
            headers: { "Content-Type": "text/html", "Set-Cookie": "YAHOO_ANON=fixture; Path=/; HttpOnly" },
          });
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });
    const result = await adapter.search({
      query: "氷菓 Blu-ray",
      filters: {},
      sourceConfig: { pageToken: "2" },
    }, { fetch: fetcher, secrets: yahooSecrets });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.listings.map((listing) => listing.sourceItemId)).toEqual(["fixture-store_item-1", "fixture-store_item-2"]);
    expect(result).toMatchObject({ totalAvailable: 200, nextCursor: "3" });
    expect(result.requestEvidence).toMatchObject({ pagesFetched: 1, rawResultCount: 2, normalizedResultCount: 2 });
  });

  it("fails closed when a public second page is forbidden without switching transports", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new URL(url).pathname.endsWith("/0/2/")
        ? new Response("forbidden", { status: 403 })
        : new Response(bootstrapHtml, {
            headers: { "Content-Type": "text/html", "Set-Cookie": "YAHOO_ANON=session-1; Path=/; HttpOnly" },
          });
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });

    await expect(adapter.search({
      query: "氷菓 Blu-ray",
      filters: {},
      sourceConfig: { pageCount: 2 },
    }, { fetch: fetcher, secrets: yahooSecrets })).rejects.toMatchObject({
      code: "yahoo_page_forbidden",
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a disabled experiment, missing NEXT_DATA and an off-domain pager", async () => {
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });
    expect(adapter.capabilities).toMatchObject({ itemLookup: false, conditionFilter: false, historySearchSupported: false });
    expect(adapter.getItem).toBeUndefined();
    const unusedFetch = vi.fn(async () => new Response(bootstrapHtml)) as unknown as typeof fetch;
    await expect(adapter.search({ query: "陶器", filters: {} }, { fetch: unusedFetch, secrets: {} }))
      .rejects.toMatchObject({ code: "yahoo_experiment_disabled", status: 503 });
    expect(unusedFetch).not.toHaveBeenCalled();

    expect(() => extractYahooNextData("<html><body>ordinary page</body></html>"))
      .toThrowError(expect.objectContaining({ code: "yahoo_next_data_missing" }));
    expect(() => extractYahooNextData("<html><body>ログインしてください</body></html>"))
      .toThrowError(expect.objectContaining({ code: "yahoo_login_required" }));
    expect(() => resolveYahooShoppingPageUrl("https://attacker.invalid/search/query/0/2/"))
      .toThrowError(expect.objectContaining({ code: "yahoo_schema_changed" }));
    expect(() => parseYahooBootstrapHtml(bootstrapHtml.replace('"type": "RESULT"', '"type": "CHANGED"')))
      .toThrowError(expect.objectContaining({ code: "yahoo_schema_changed" }));

    const encoded = resolveYahooShoppingPageUrl(
      "https://shopping.yahoo.co.jp/search/%E6%B0%B7%E8%8F%93%20%2F%2B/0/2/?prom=1",
    );
    expect(decodeURIComponent(encoded.pathname)).toBe("/search/氷菓 /+/0/2/");
    expect(encoded.href).toContain("%20%2F%2B");
  });

  it("does not mistake a normal Yahoo header login link for a login gate", () => {
    const page = parseYahooBootstrapHtml(bootstrapHtml.replace(
      "<body>",
      '<body><a href="https://login.yahoo.co.jp/">ログイン</a>',
    ));

    expect(page.items).toHaveLength(1);
  });

  it("accepts only a structurally explicit Yahoo no-result page as empty", () => {
    const nextData = JSON.stringify({
      props: {
        initialState: {
          bff: { searchResults: {} },
        },
      },
    });
    const emptyHtml = `<html><body>商品が見つかりません<script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`;

    expect(parseYahooBootstrapHtml(emptyHtml)).toMatchObject({
      items: [],
      totalAvailable: 0,
      totalPages: 0,
      warnings: ["Yahoo 明确返回该关键词没有匹配商品。"],
    });
    expect(() => parseYahooBootstrapHtml(emptyHtml.replace("商品が見つかりません", "ordinary empty page")))
      .toThrowError(expect.objectContaining({ code: "yahoo_schema_changed" }));
  });

  it("bounds an upstream 429 to three attempts", async () => {
    const fetcher = vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "0" } })) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });
    await expect(adapter.search({ query: "陶器", filters: {} }, { fetch: fetcher, secrets: yahooSecrets }))
      .rejects.toMatchObject({ code: "yahoo_rate_limited", status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("normalizes a timeout while reading an upstream response body", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(new DOMException("fixture body aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(body, {
        headers: { "Set-Cookie": "YAHOO_ANON=fixture-timeout-cookie; Path=/; HttpOnly" },
      });
    }) as unknown as typeof fetch;
    const adapter = createYahooShoppingAdapter({ pageDelayMs: 0 });

    await expect(adapter.search(
      { query: "陶器", filters: {} },
      { fetch: fetcher, secrets: yahooSecrets, signal: AbortSignal.timeout(10) },
    )).rejects.toMatchObject({ code: "yahoo_timeout", status: 504, retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the signed service payload fixed-purpose and bounded", () => {
    expect(yahooSearchBodySchema.safeParse({
      query: "氷菓",
      filters: { minPrice: 1_000, pageSize: 30 },
      sourceConfig: { categoryId: "0", pageCount: 3, pageToken: "2" },
    }).success).toBe(true);
    expect(yahooSearchBodySchema.safeParse({
      query: "氷菓",
      filters: {},
      sourceConfig: { categoryId: "all", pageCount: 4, arbitraryUrl: "https://example.com" },
    }).success).toBe(false);
    expect(yahooSearchBodySchema.safeParse({
      query: "氷菓",
      filters: {},
      sourceConfig: { pageToken: "4" },
    }).success).toBe(false);
  });

  it("separates cached logical pages", async () => {
    const pageOne = { query: "cache-page-fixture", filters: {}, sourceConfig: { pageToken: "1" } };
    const pageTwo = { query: "cache-page-fixture", filters: {}, sourceConfig: { pageToken: "2" } };
    const operation = vi.fn(async (): Promise<SearchResult> => ({
      sourceId: "yahoo_shopping",
      listings: [],
      coverage: "rolling_window",
      warnings: [],
      parserVersion: "fixture",
      fetchedAt: "2026-07-14T00:00:00.000Z",
    }));

    expect((await searchYahooWithCache(pageOne, operation)).cacheStatus).toBe("MISS");
    expect((await searchYahooWithCache(pageTwo, operation)).cacheStatus).toBe("MISS");
    expect((await searchYahooWithCache(pageOne, operation)).cacheStatus).toBe("HIT");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("caches only the normalized result for a short repeated search", async () => {
    const request = { query: "cache-fixture-氷菓", filters: {}, sourceConfig: { pageCount: 1 } };
    const operation = vi.fn(async (): Promise<SearchResult> => ({
      sourceId: "yahoo_shopping",
      listings: [],
      coverage: "rolling_window",
      warnings: [],
      parserVersion: "fixture",
      fetchedAt: "2026-07-14T00:00:00.000Z",
    }));

    expect((await searchYahooWithCache(request, operation)).cacheStatus).toBe("MISS");
    expect((await searchYahooWithCache(request, operation)).cacheStatus).toBe("HIT");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
