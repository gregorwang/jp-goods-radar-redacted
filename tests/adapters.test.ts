import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decodeHtmlEntities, fetchPublicHtml, parseYenText, stripHtml } from "../packages/adapters/src/html";
import { AdapterError, redactSensitiveText } from "../packages/adapters/src/http";
import { rakutenBooksAdapter } from "../packages/adapters/src/rakuten-books";
import { parseRakutenItemHtml, rakutenIchibaAdapter } from "../packages/adapters/src/rakuten-ichiba";
import { createDpopSigner } from "../packages/adapters/src/mercari/dpop";
import { MercariBlockedError, MercariRateLimitError, MercariSchemaChangedError } from "../packages/adapters/src/mercari/errors";
import { mercariAdapter } from "../packages/adapters/src/mercari";
import { mercariCanonicalUrl } from "../packages/adapters/src/mercari/normalize";
import { buildMercariSearchPayload } from "../packages/adapters/src/mercari/payload";
import { historyListingMatchesQuery } from "../packages/adapters/src/mercari/search";
import { normalizeSurugayaItem } from "../packages/adapters/src/surugaya/normalize";
import { parseSurugayaHtmlFallback } from "../packages/adapters/src/surugaya/parser";
import { fetchSurugayaHtml } from "../packages/adapters/src/surugaya/request";
import { SurugayaBlockedError, surugayaAdapter } from "../packages/adapters/src/surugaya";
import { charaonAdapter, parseCharaonDetailHtml, parseCharaonSearchHtml } from "../packages/adapters/src/charaon";
import { cospaAdapter, parseCospaDetailHtml, parseCospaSearchHtml } from "../packages/adapters/src/cospa";
import { animateAdapter, parseAnimateDetailHtml, parseAnimateSearchHtml } from "../packages/adapters/src/animate";
import { amazonJapanAdapter, parseAmazonSearchHtml } from "../packages/adapters/src/amazon";
import { normalizedListingSchema } from "../packages/validation/src";
import rakutenIchibaFixture from "./fixtures/rakuten-ichiba.normal.json";
import rakutenBooksFixture from "./fixtures/rakuten-books.normal.json";
import mercariSearchFixture from "./fixtures/mercari/search-success.json";
import mercariItemFixture from "./fixtures/mercari/item-success.json";
import mercariSchemaFixture from "./fixtures/mercari/schema-changed.json";

const surugayaPage1 = readFileSync(new URL("./fixtures/surugaya/search-page-1.html", import.meta.url), "utf8");
const surugayaPage2 = readFileSync(new URL("./fixtures/surugaya/search-page-2.html", import.meta.url), "utf8");
const charaonSearch = readFileSync(new URL("./fixtures/charaon/search.html", import.meta.url), "utf8");
const charaonDetail = readFileSync(new URL("./fixtures/charaon/detail.html", import.meta.url), "utf8");
const cospaSearch = readFileSync(new URL("./fixtures/cospa/search.html", import.meta.url), "utf8");
const cospaDetail = readFileSync(new URL("./fixtures/cospa/detail.html", import.meta.url), "utf8");
const animateSearch = readFileSync(new URL("./fixtures/animate/search.html", import.meta.url), "utf8");
const animateDetail = readFileSync(new URL("./fixtures/animate/detail.html", import.meta.url), "utf8");
const amazonSearch = readFileSync(new URL("./fixtures/amazon/search.html", import.meta.url), "utf8");

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const rakutenSecrets = { RAKUTEN_APPLICATION_ID: "app", RAKUTEN_ACCESS_KEY: "access", RAKUTEN_APPLICATION_URL: "https://eru.example.com/" };

function isMercariItemRequest(value: string, itemId: string): boolean {
  const url = new URL(value);
  return url.origin === "https://api.mercari.jp"
    && url.pathname === "/items/get"
    && url.searchParams.get("id") === itemId
    && url.searchParams.get("include_auction") === "true";
}

describe("Amazon Japan public HTML adapter", () => {
  it("forces Japanese yen and normalizes stable ASIN search results", async () => {
    let requested = "";
    let headers = new Headers();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requested = String(input);
      headers = new Headers(init?.headers);
      return new Response(`${amazonSearch}${" ".repeat(3_000)}`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;
    const result = await amazonJapanAdapter.search({ query: "雪ミク", filters: { conditions: ["new"], minPrice: 2_000 } }, {
      fetch: fetcher,
      secrets: {},
    });
    expect(new URL(requested).origin).toBe("https://www.amazon.co.jp");
    expect(new URL(requested).pathname).toBe("/s");
    expect(new URL(requested).searchParams.get("language")).toBe("ja_JP");
    expect(headers.get("cookie")).toContain("i18n-prefs=JPY");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceId: "amazon_jp",
      sourceItemId: "B0GZ9NMHFJ",
      canonicalUrl: "https://www.amazon.co.jp/dp/B0GZ9NMHFJ",
      currentPrice: 4980,
      originalPrice: 5500,
      condition: "new",
      availability: "available",
      facts: {
        identifiers: { asin: "B0GZ9NMHFJ" },
        sourceConditionLabel: "新品の主オファー",
      },
    });
    expect(result.nextCursor).toBe("2");
  });

  it("never converts a foreign-currency amount into a yen price", () => {
    const parsed = parseAmazonSearchHtml(amazonSearch);
    expect(parsed.listings.find((listing) => listing.sourceItemId === "B0FOREIGN1")).toMatchObject({
      currency: "JPY",
      currentPrice: undefined,
      availability: "unknown",
    });
  });

  it("treats Amazon's 2026-09 empty-result wording as an empty result, not a layout change", () => {
    const html = `<div data-component-type="s-search-results"><span>検索クエリに一致する結果はありません。</span></div>`;
    expect(parseAmazonSearchHtml(html)).toEqual({ listings: [], hasNextPage: false });
  });

  it("uses a bounded page token and finds an exact ASIN without a product-page request", async () => {
    let requested = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(`${amazonSearch}${" ".repeat(3_000)}`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;
    const result = await amazonJapanAdapter.search(
      { query: "雪ミク", filters: {}, sourceConfig: { pageToken: "2" } },
      { fetch: fetcher, secrets: {} },
    );
    expect(new URL(requested).searchParams.get("page")).toBe("2");
    expect(result).toMatchObject({ nextCursor: "3" });
    expect(result.requestEvidence).toMatchObject({ pagesFetched: 1 });

    const item = await amazonJapanAdapter.getItem!("B0GZ9NMHFJ", { fetch: fetcher, secrets: {} });
    expect(new URL(requested).pathname).toBe("/s");
    expect(new URL(requested).searchParams.get("k")).toBe("B0GZ9NMHFJ");
    expect(item).toMatchObject({ sourceItemId: "B0GZ9NMHFJ", currentPrice: 4_980 });
  });

  it("fails closed on an Amazon challenge page", async () => {
    const challenge = vi.fn(async () => new Response(
      `<html><body>Enter the characters you see below api-services-support@amazon.com ${"x".repeat(3_000)}</body></html>`,
      { headers: { "Content-Type": "text/html; charset=UTF-8" } },
    )) as unknown as typeof fetch;
    await expect(amazonJapanAdapter.search({ query: "雪ミク", filters: {} }, { fetch: challenge, secrets: {} }))
      .rejects.toMatchObject({ code: "captcha" });
  });
});

describe("rich public HTML adapters", () => {
  it("discovers CharaON products and enriches JAN, release date and specifications", async () => {
    const parsed = parseCharaonSearchHtml(charaonSearch);
    expect(parsed.totalAvailable).toBe(148);
    expect(parsed.lastVisible).toBe(40);
    expect(parsed.listings).toHaveLength(2);
    expect(parsed.listings[0]).toMatchObject({ sourceId: "charaon", sourceItemId: "AZBSD154", currentPrice: 440, availability: "available" });
    const detail = parseCharaonDetailHtml(charaonDetail, new URL("https://www.charaon.jp/SHOP/AZBSD154.html"));
    expect(detail).toMatchObject({ sourceItemId: "AZBSD154", facts: { identifiers: { jan: "4580805211413", sku: "AZBSD154" },
      manufacturer: "アズメーカー", releaseDate: "2026-07-31" } });
    expect(detail.facts?.imageUrls).toHaveLength(2);
    expect(detail.facts?.specifications?.map((item) => item.name)).toContain("サイズ");
  });

  it("bounds CharaON detail images to the canonical listing schema", () => {
    const extraImages = Array.from(
      { length: 40 },
      (_, index) => `<img src="https://image1.shopserve.jp/charaon.jp/pic-labo/llimg/AZBSD154-${index}.jpg">`,
    ).join("");
    const detail = parseCharaonDetailHtml(
      charaonDetail.replace("</body>", `${extraImages}</body>`),
      new URL("https://www.charaon.jp/SHOP/AZBSD154.html"),
    );
    expect(detail.facts?.imageUrls).toHaveLength(30);
    expect(normalizedListingSchema.safeParse(detail).success).toBe(true);
  });

  it("discovers both COSPA brands and enriches stable catalog identifiers", () => {
    const parsed = parseCospaSearchHtml(cospaSearch);
    expect(parsed.totalAvailable).toBe(2);
    expect(parsed.listings).toHaveLength(2);
    expect(parsed.listings.map((item) => item.facts?.brand)).toEqual(["COSPA", "二次元COSPA"]);
    const detail = parseCospaDetailHtml(cospaDetail, new URL("https://www.cospa.com/cospa/detail/id/00000129680"));
    expect(detail).toMatchObject({ sourceItemId: "00000129680", currentPrice: 110, availability: "available",
      facts: { identifiers: { jan: "4549970366267", modelNumber: "9204-0469G" }, manufacturer: "株式会社コスパ" } });
  });

  it("discovers Animate catalog items and enriches JAN, manufacturer and distributor", () => {
    const parsed = parseAnimateSearchHtml(animateSearch);
    expect(parsed.totalAvailable).toBe(120);
    expect(parsed.listings).toHaveLength(2);
    expect(parsed.listings[0]).toMatchObject({ sourceItemId: "3533580", currentPrice: 1430, availability: "preorder",
      facts: { releaseDate: "2026-09" } });
    const detail = parseAnimateDetailHtml(animateDetail, new URL("https://www.animate-onlineshop.jp/pn/_/pd/3533580/"));
    expect(detail).toMatchObject({ sourceItemId: "3533580", currentPrice: 1430, availability: "preorder",
      facts: { identifiers: { jan: "4570111256529" }, manufacturer: "サンスター文具株式会社", distributor: "株式会社GRANUP", releaseDate: "2026-09" } });
  });

  it("takes the Animate result count from the result header instead of any 件 on the page", () => {
    const withNoisyTitle = animateSearch.replace(/ガンダム アクリルペンスタンド/g, "ガンダム アクリルペンスタンド 3件セット");
    expect(parseAnimateSearchHtml(withNoisyTitle).totalAvailable).toBe(120);

    const withResultPhrasing = animateSearch.replace("<p>120件</p>", "<p>おすすめ 8件</p><p>全480件中1〜30件を表示</p>");
    expect(parseAnimateSearchHtml(withResultPhrasing).totalAvailable).toBe(480);
  });

  it("keeps Animate detail images inside the product gallery and ignores page-wide CDN assets", () => {
    const productImages = [
      "https://tc-animate.techorus-cdn.com/resize_image/product-main.jpg",
      "https://tc-animate.techorus-cdn.com/resize_image/product-back.jpg",
    ];
    const noisyAssets = Array.from({ length: 45 }, (_, index) => (
      `<img src="https://tc-animate.techorus-cdn.com/navigation/banner-${index}.jpg">`
    )).join("");
    const html = animateDetail
      .replace(
        "https://tc-animate.techorus-cdn.com/resize_image/item1.jpg",
        "https://tc-animate.techorus-cdn.com/resize_image/resize_image.php?image=",
      )
      .replace(
        '<section class="item_detail" id="item_productinfo">',
        `<div class="item_images"><img data-src="${productImages[0]}"><a href="${productImages[1]}">背面</a></div><div class="item_detail"></div>${noisyAssets}<section class="item_detail" id="item_productinfo">`,
      );
    const detail = parseAnimateDetailHtml(html, new URL("https://www.animate-onlineshop.jp/pn/_/pd/3533580/"));

    expect(detail.imageUrl).toBe(productImages[0]);
    expect(detail.facts?.imageUrls).toEqual(productImages);
  });

  it("limits Animate detail galleries to 25 unique product images", () => {
    const productImages = Array.from({ length: 35 }, (_, index) => (
      `https://tc-animate.techorus-cdn.com/resize_image/product-${index + 1}.jpg`
    ));
    const gallery = [...productImages, productImages[0]]
      .map((image) => `<a href="${image}">商品画像</a>`)
      .join("");
    const html = animateDetail.replace(
      '<section class="item_detail" id="item_productinfo">',
      `<div class="item_images">${gallery}</div><div class="item_detail"></div><section class="item_detail" id="item_productinfo">`,
    );
    const detail = parseAnimateDetailHtml(html, new URL("https://www.animate-onlineshop.jp/pn/_/pd/3533580/"));

    expect(detail.imageUrl).toBe(productImages[0]);
    expect(detail.facts?.imageUrls).toEqual(productImages.slice(0, 25));
  });

  it.each([
    [charaonAdapter, "https://www.charaon.jp/SHOP/list.php", charaonSearch],
    [cospaAdapter, "https://www.cospa.com/itemlist/words/test", cospaSearch],
    [animateAdapter, "https://www.animate-onlineshop.jp/products/list.php", `${animateSearch}<script src="//www.google.com/recaptcha/api.js"></script>`],
  ] as const)("runs %s search through bounded public HTML fetch", async (adapter, responseUrl, fixture) => {
    const fetcher = vi.fn(async () => new Response(`${fixture}${" ".repeat(3_000)}`, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    })) as unknown as typeof fetch;
    const result = await adapter.search({ query: adapter.healthcheckQuery ?? "test", filters: { page: 1 } }, { fetch: fetcher, secrets: {} });
    expect(result.listings.length).toBeGreaterThan(0);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(new URL(responseUrl).hostname);
    if (adapter.id === "cospa") expect(result.nextCursor).toBeUndefined();
    else expect(result.nextCursor).toBe("2");
    expect(result.requestEvidence).toMatchObject({ pagesFetched: 1 });
  });

  it("keeps an out-of-range numeric entity literal instead of aborting the parse", () => {
    const raw = "限定&#99999999;商品&#xFFFFFFF;&#xD800;&#x30DF;&#12463;&amp;";
    const decoded = "限定&#99999999;商品&#xFFFFFFF;&#xD800;ミク&";
    expect(decodeHtmlEntities(raw)).toBe(decoded);
    expect(stripHtml(`<p>${raw}</p>`)).toBe(decoded);
  });

  it("reads the yen amount instead of a quantity or tax prefix in the same price block", () => {
    expect(parseYenText("2点セット ¥3,200")).toBe(3_200);
    expect(parseYenText("税抜 1,000円")).toBe(1_000);
    expect(parseYenText("2点セット &yen;3,200")).toBe(3_200);
    expect(parseYenText("￥16,900 ～ ￥22,500")).toBe(16_900);
    // 整段没有货币符号时只能退回旧行为，取第一个数字。
    expect(parseYenText("4,500")).toBe(4_500);
    expect(parseYenText("送料無料")).toBeUndefined();
    expect(parseYenText(undefined)).toBeUndefined();
  });

  it("在真实 HTML 片段里也能锚定金额，而不是被标签挡住", () => {
    // Animate 的价格块把标签夹在数字与 円 之间；不先去标签就锚定不到，
    // 只能退回首个数字获胜——正是这个函数要解决的问题本身。
    expect(parseYenText('<font class="notranslate">1,430</font>円(税込)')).toBe(1_430);
    expect(parseYenText('<span>2点セット</span><strong>￥3,200</strong>')).toBe(3_200);
    // 纯文本路径不受影响。
    expect(parseYenText("¥980")).toBe(980);
  });

  it("fails closed when a known list container loses all product selectors", () => {
    expect(() => parseCharaonSearchHtml('<div id="itemList"><h1>商品一覧</h1></div>')).toThrow("结构发生变化");
    expect(() => parseCospaSearchHtml('<div class="itemlist" id="itemlist_main"></div>')).toThrow("结构发生变化");
    expect(() => parseAnimateSearchHtml('<div class="item_list"><ul></ul></div>')).toThrow("结构发生变化");
  });

  it("fails closed on an actual CAPTCHA widget without rejecting a script preload", async () => {
    const challenge = vi.fn(async () => new Response(`<div class="g-recaptcha"></div>${animateSearch}${" ".repeat(3_000)}`, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    })) as unknown as typeof fetch;
    await expect(animateAdapter.search({ query: "ガンダム", filters: {} }, { fetch: challenge, secrets: {} }))
      .rejects.toMatchObject({ code: "captcha" });
  });

  it("does not follow a public HTML redirect outside the fixed source boundary", async () => {
    const redirected = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/collect" },
    })) as unknown as typeof fetch;
    await expect(animateAdapter.search({ query: "ガンダム", filters: {} }, { fetch: redirected, secrets: {} }))
      .rejects.toMatchObject({ code: "unexpected_redirect" });
    expect(redirected).toHaveBeenCalledTimes(1);
  });
});

describe("Rakuten Ichiba adapter", () => {
  it("normalizes a current API response and applies filters", async () => {
    let requested = "";
    let requestedHeaders: Headers | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requested = String(input);
      requestedHeaders = new Headers(init?.headers);
      return jsonResponse(rakutenIchibaFixture);
    }) as unknown as typeof fetch;
    const result = await rakutenIchibaAdapter.search({ query: "千反田える", filters: { minPrice: 1000, maxPrice: 5000, inStockOnly: true, sort: "newest" } }, { fetch: fetcher, secrets: rakutenSecrets });
    expect(result.listings[0]).toMatchObject({ sourceItemId: "shop:123", currentPrice: 4980, availability: "available", condition: "new" });
    const url = new URL(requested);
    expect(url.searchParams.get("sort")).toBe("-updateTimestamp");
    expect(url.searchParams.get("field")).toBe("0");
    expect(url.searchParams.get("imageFlag")).toBe("0");
    expect(url.searchParams.get("availability")).toBe("1");
    expect(url.searchParams.get("minPrice")).toBe("1000");
    expect(requestedHeaders?.get("origin")).toBe("https://eru.example.com");
    expect(requestedHeaders?.get("referer")).toBe("https://eru.example.com/");
    expect(requestedHeaders?.get("accesskey")).toBe("access");
    expect(requestedHeaders?.get("user-agent")).toContain("eru.example.com");
  });

  it("returns official pagination metadata for a broad Ichiba search", async () => {
    let requested = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return jsonResponse({ ...rakutenIchibaFixture, count: 85, pageCount: 3 });
    }) as unknown as typeof fetch;
    const result = await rakutenIchibaAdapter.search(
      { query: "千反田 氷菓", filters: {}, sourceConfig: { pageToken: "2", matchMode: "any" } },
      { fetch: fetcher, secrets: rakutenSecrets },
    );
    const url = new URL(requested);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("orFlag")).toBe("1");
    expect(result).toMatchObject({ totalAvailable: 85, nextCursor: "3" });
  });

  it("accepts the 2026 API image URL string arrays", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ Items: [{
      itemCode: "shop:string-image",
      itemUrl: "https://item.rakuten.co.jp/shop/string-image/",
      itemName: "商品",
      itemPrice: 1000,
      availability: 1,
      mediumImageUrls: ["https://thumbnail.image.rakuten.co.jp/string-image.jpg"],
    }] })) as unknown as typeof fetch;
    const result = await rakutenIchibaAdapter.search({ query: "商品", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets });
    expect(result.listings[0]?.imageUrl).toBe("https://thumbnail.image.rakuten.co.jp/string-image.jpg");
  });

  it("treats a non-empty response with no valid identity as parser failure", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ Items: [{ itemName: "missing identity" }] })) as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets }))
      .rejects.toMatchObject({ code: "parser_structure_error" });
  });

  it("accepts a real empty result and tolerates optional image and price fields", async () => {
    const responses = [
      jsonResponse({ Items: [] }),
      jsonResponse({ Items: [{ itemCode: "shop:optional", itemUrl: "https://item.rakuten.co.jp/shop/optional/?scid=tracking", itemName: "価格未定", availability: 0 }] }),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    expect((await rakutenIchibaAdapter.search({ query: "none", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets })).listings).toEqual([]);
    expect((await rakutenIchibaAdapter.search({ query: "optional", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets })).listings[0])
      .toMatchObject({ currentPrice: undefined, imageUrl: undefined, availability: "sold_out", sourceItemId: "shop:optional" });
  });

  it("deduplicates stable IDs even when URLs have different tracking parameters", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ Items: [
      { itemCode: "shop:same", itemUrl: "https://item.rakuten.co.jp/shop/same/?scid=a", itemName: "商品", itemPrice: 1 },
      { itemCode: "shop:same", itemUrl: "https://item.rakuten.co.jp/shop/same/?scid=b", itemName: "商品", itemPrice: 1 },
    ] })) as unknown as typeof fetch;
    const result = await rakutenIchibaAdapter.search({ query: "same", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.sourceItemId).toBe("shop:same");
  });

  it("looks up a stable itemCode for item monitoring", async () => {
    let requested = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => { requested = String(input); return jsonResponse({ Items: [{ itemCode: "shop:123", itemUrl: "https://item.rakuten.co.jp/shop/123/", itemName: "商品", itemPrice: 4000, availability: 1 }] }); }) as unknown as typeof fetch;
    const listing = await rakutenIchibaAdapter.getItem!("shop:123", { fetch: fetcher, secrets: rakutenSecrets });
    const url = new URL(requested);
    expect(url.searchParams.get("itemCode")).toBe("shop:123");
    expect(url.searchParams.get("availability")).toBe("0");
    expect(listing).toMatchObject({ sourceItemId: "shop:123", availability: "available" });
  });

  it("keeps a sold-out SKU visible during item monitoring", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ Items: [{
      itemCode: "gscraft:n0066",
      itemUrl: "https://item.rakuten.co.jp/gscraft/n0066/",
      itemName: "在庫監視商品",
      itemPrice: 4_000,
      availability: 0,
    }] })) as unknown as typeof fetch;
    const listing = await rakutenIchibaAdapter.getItem!("gscraft:n0066", { fetch: fetcher, secrets: rakutenSecrets });
    expect(listing).toMatchObject({ sourceItemId: "gscraft:n0066", availability: "sold_out" });
  });

  it("falls back to official page microdata when the API does not index a valid item URL", async () => {
    const html = `${" ".repeat(10_000)}
      <meta itemprop="image" content="https://shop.r10s.jp/gscraft/item.jpg">
      <meta itemprop="name" content="ユリウス ぬいぐるみ：GSクラフト">
      <meta itemprop="sku" content="gscraft:n0066">
      <meta itemprop="price" content="3850">
      <meta itemprop="priceCurrency" content="JPY">
      <meta itemprop="availability" content="http://schema.org/OutOfStock">`;
    const fetcher = vi.fn(async (_input: string | URL | Request) => fetcher.mock.calls.length === 1
      ? jsonResponse({ error: "wrong_parameter", error_description: "itemCode is not valid" }, 400)
      : new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } })) as unknown as typeof fetch;
    const listing = await rakutenIchibaAdapter.getItem!("gscraft:n0066", { fetch: fetcher, secrets: rakutenSecrets });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://item.rakuten.co.jp/gscraft/n0066/");
    expect(listing).toMatchObject({
      sourceItemId: "gscraft:n0066",
      title: "ユリウス ぬいぐるみ：GSクラフト",
      currentPrice: 3850,
      availability: "sold_out",
      rawMetadata: { inventorySource: "public_item_microdata" },
    });
  });

  it("rejects page fallback microdata for a different Rakuten item", () => {
    expect(() => parseRakutenItemHtml(
      '<meta itemprop="name" content="別の商品"><meta itemprop="sku" content="shop:other">',
      "shop:expected",
      new URL("https://item.rakuten.co.jp/shop/expected/"),
    )).toThrow("匹配的稳定 ID");
  });

  it("rejects missing credentials before making a request", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: {} })).rejects.toThrow("凭据未配置");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not enable affiliate requests merely because an Affiliate ID is stored", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return jsonResponse({ Items: [] });
    }) as unknown as typeof fetch;
    await rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, {
      fetch: fetcher,
      secrets: { ...rakutenSecrets, RAKUTEN_AFFILIATE_ID: "affiliate-stored", RAKUTEN_AFFILIATE_MODE: "false" },
    });
    await rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, {
      fetch: fetcher,
      secrets: { ...rakutenSecrets, RAKUTEN_AFFILIATE_ID: "affiliate-enabled", RAKUTEN_AFFILIATE_MODE: "true" },
    });
    expect(new URL(requested[0]!).searchParams.has("affiliateId")).toBe(false);
    expect(new URL(requested[1]!).searchParams.get("affiliateId")).toBe("affiliate-enabled");
  });
});

describe("Rakuten Books adapter", () => {
  it("uses ISBN/JAN for stable catalog identity", async () => {
    const fetcher = vi.fn(async () => jsonResponse(rakutenBooksFixture)) as unknown as typeof fetch;
    const result = await rakutenBooksAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets });
    expect(result.listings[0]).toMatchObject({
      sourceItemId: "9784041064839",
      identityScope: "catalog",
      descriptionExcerpt: "省エネを信条とする高校生・折木奉太郎が、古典部で日常の謎に挑む青春ミステリー。",
      availability: "available",
      facts: { identifiers: { isbn: "9784041064839" }, sourceConditionLabel: "新品" },
    });
  });

  it("returns official pagination metadata for broad Books search", async () => {
    let requested = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return jsonResponse({ ...rakutenBooksFixture, count: 61, pageCount: 3 });
    }) as unknown as typeof fetch;
    const result = await rakutenBooksAdapter.search(
      { query: "氷菓", filters: {}, sourceConfig: { pageToken: "2" } },
      { fetch: fetcher, secrets: rakutenSecrets },
    );
    expect(new URL(requested).searchParams.get("page")).toBe("2");
    expect(new URL(requested).searchParams.get("field")).toBe("0");
    expect(result).toMatchObject({ totalAvailable: 61, nextCursor: "3" });
  });

  it.each([["4", "backorder"], ["5", "preorder"], ["6", "backorder"]] as const)("maps Books availability %s to %s", async (code, expected) => {
    const fetcher = vi.fn(async () => jsonResponse({ Items: [{ jan: "4900000000000", itemUrl: "https://books.rakuten.co.jp/rb/2/", title: "予約商品", availability: code }] })) as unknown as typeof fetch;
    const result = await rakutenBooksAdapter.search({ query: "予約", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets });
    expect(result.listings[0]?.availability).toBe(expected);
  });

  it("rejects a changed Books schema and accepts an empty Items array", async () => {
    const changed = vi.fn(async () => jsonResponse({ products: [] })) as unknown as typeof fetch;
    await expect(rakutenBooksAdapter.search({ query: "氷菓", filters: {} }, { fetch: changed, secrets: rakutenSecrets }))
      .rejects.toMatchObject({ code: "parser_structure_error" });
    const empty = vi.fn(async () => jsonResponse({ Items: [] })) as unknown as typeof fetch;
    expect((await rakutenBooksAdapter.search({ query: "none", filters: {} }, { fetch: empty, secrets: rakutenSecrets })).listings).toEqual([]);
  });

  it("rejects an unstable item lookup identifier", async () => {
    await expect(rakutenBooksAdapter.getItem!("not-an-isbn", { fetch, secrets: rakutenSecrets })).rejects.toThrow("13 位");
  });
});

describe("HTTP isolation", () => {
  it("honors an allowlisted EUC-JP charset for public HTML", async () => {
    const prefix = new TextEncoder().encode("<html><body>");
    const suffix = new TextEncoder().encode("</body></html>");
    const bytes = new Uint8Array(prefix.byteLength + 4 + suffix.byteLength);
    bytes.set(prefix);
    bytes.set([190, 166, 201, 202], prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + 4);
    const fetcher = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=EUC-JP" },
    })) as unknown as typeof fetch;
    const fetched = await fetchPublicHtml(fetcher, new URL("https://example.test/item"), {
      label: "测试来源",
      allowedHosts: ["example.test"],
      allowedPath: (pathname) => pathname === "/item",
      minBytes: 0,
    });
    expect(fetched.html).toContain("商品");
  });

  it("redacts Rakuten credential query values from diagnostic text", () => {
    const value = redactSensitiveText("GET https://example.test/?applicationId=app-secret&accessKey=key-secret&affiliateId=affiliate-secret&keyword=x");
    expect(value).not.toContain("app-secret");
    expect(value).not.toContain("key-secret");
    expect(value).not.toContain("affiliate-secret");
    expect(value.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it.each([429, 500])("surfaces %s as a typed retryable adapter error", async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({ error: true }, status)) as unknown as typeof fetch;
    const error = await rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ status, retryable: true });
  });

  it("preserves a bounded JSON error description from an upstream API", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      error: "wrong_parameter",
      error_description: `itemCode parameter is not valid ${"x".repeat(500)}`,
    }, 400)) as unknown as typeof fetch;
    const error = await rakutenIchibaAdapter.getItem!("shop:item", {
      fetch: fetcher,
      secrets: rakutenSecrets,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "http_400", status: 400, retryable: false });
    expect((error as Error).message).toContain("itemCode parameter is not valid");
    expect((error as Error).message.length).toBeLessThan(340);
  });

  it("rejects an oversized response before JSON parsing", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 200, { "content-length": "2000001" })) as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets })).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("reads Retry-After on 429", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 429, { "retry-after": "120" })) as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets }))
      .rejects.toMatchObject({ code: "http_429", retryAfterSeconds: 120, retryable: true });
  });

  it("converts an aborted fetch into a retryable timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets, signal: controller.signal }))
      .rejects.toMatchObject({ code: "request_timeout", retryable: true });
  });

  it("flags invalid JSON as parser failure", async () => {
    const fetcher = vi.fn(async () => new Response("<html>error</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(rakutenIchibaAdapter.search({ query: "氷菓", filters: {} }, { fetch: fetcher, secrets: rakutenSecrets }))
      .rejects.toMatchObject({ code: "parser_structure_error" });
  });
});

describe("Mercari internal API adapter", () => {
  it("builds canonical URLs for marketplace and Shops item types", () => {
    expect(mercariCanonicalUrl("m95317526324", "ITEM_TYPE_MERCARI"))
      .toBe("https://jp.mercari.com/item/m95317526324");
    expect(mercariCanonicalUrl("FxHFY4yGnZznBUN76YziYm", "ITEM_TYPE_BEYOND"))
      .toBe("https://jp.mercari.com/shops/product/FxHFY4yGnZznBUN76YziYm");
  });

  it("generates an ES256 DPoP proof with exact request claims", async () => {
    const signer = await createDpopSigner();
    const url = "https://api.mercari.jp/v2/entities:search";
    const proof = await signer.createProof("POST", url);
    const [encodedHeader, encodedPayload, encodedSignature] = proof.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    expect(payload).toMatchObject({ htu: url, htm: "POST" });
    expect(typeof payload.jti).toBe("string");
    expect(Buffer.from(encodedSignature ?? "", "base64url")).toHaveLength(64);
  });

  it("builds the verified low-frequency web search payload", () => {
    const payload = buildMercariSearchPayload({ keyword: "千反田える", pageSize: 120, priceMax: 5000 });
    expect(payload).toMatchObject({
      userId: "",
      pageSize: 120,
      source: "BaseSerp",
      serviceFrom: "suruga",
      withSuggestedItems: false,
      withAuction: true,
      searchCondition: {
        keyword: "千反田える",
        sort: "SORT_CREATED_TIME",
        order: "ORDER_DESC",
        status: ["STATUS_ON_SALE"],
        priceMax: 5000,
        itemTypes: [],
      },
    });
  });

  it("searches with DPoP and normalizes stable Mercari IDs", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return jsonResponse(mercariSearchFixture);
    }) as unknown as typeof fetch;
    const result = await mercariAdapter.search({ query: "千反田える", filters: { pageSize: 60, inStockOnly: true } }, { fetch: fetcher, secrets: {} });
    const headers = new Headers(requestInit?.headers);
    const body = JSON.parse(String(requestInit?.body)) as { withAuction: boolean; searchCondition: { itemTypes: string[] } };
    expect(headers.get("dpop")?.split(".")).toHaveLength(3);
    expect(headers.get("x-platform")).toBe("web");
    expect(headers.get("x-country-code")).toBe("JP");
    expect(body.withAuction).toBe(true);
    expect(body.searchCondition.itemTypes).toEqual([]);
    expect(result).toMatchObject({ coverage: "rolling_window", nextCursor: "v1:1", totalAvailable: 2, parserVersion: "mercari-internal-v2" });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceItemId: "m95317526324",
      currentPrice: 3000,
      condition: "used",
      availability: "available",
      sourceListedAt: "2024-09-07T23:49:54.000Z",
      rawMetadata: { sourceConditionId: "2", sourceConditionLabel: "未使用に近い" },
    });
  });

  it("includes sold Mercari listings when the user asks for market references", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return jsonResponse(mercariSearchFixture);
    }) as unknown as typeof fetch;
    const result = await mercariAdapter.search(
      { query: "千反田える", filters: { pageSize: 60, inStockOnly: false } },
      { fetch: fetcher, secrets: {} },
    );
    const body = JSON.parse(String(requestInit?.body)) as { searchCondition: { status: string[] } };
    expect(body.searchCondition.status).toEqual(["STATUS_ON_SALE", "STATUS_SOLD_OUT", "STATUS_TRADING"]);
    expect(result.listings).toHaveLength(2);
    expect(result.listings[1]).toMatchObject({
      sourceItemId: "m42583722790",
      currentPrice: 4300,
      availability: "sold_out",
    });
  });

  it("sends sold and trading statuses and filters out on-sale items in history mode", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return jsonResponse(mercariSearchFixture);
    }) as unknown as typeof fetch;
    const result = await mercariAdapter.search(
      { query: "雪ミク", filters: { pageSize: 120, availabilityMode: "sold_out" } },
      { fetch: fetcher, secrets: {} },
    );
    const body = JSON.parse(String(requestInit?.body)) as { searchCondition: { status: string[] } };
    expect(body.searchCondition.status).toEqual(["STATUS_SOLD_OUT", "STATUS_TRADING"]);
    expect(result.listings.map((item) => item.sourceItemId)).toEqual(["m42583722790"]);
    expect(result.requestEvidence).toEqual({
      availabilityMode: "sold_out",
      requestedStatuses: ["STATUS_SOLD_OUT", "STATUS_TRADING"],
      rawResultCount: 2,
      normalizedResultCount: 1,
      pagesFetched: 1,
      keywordRawResultCount: 2,
      liveDetailResultCount: 0,
      anchorCandidateCount: 0,
    });
  });

  it("live-refreshes matching sold history anchors without using stored listing fields", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (url.includes("/v2/entities:search")) return jsonResponse({ items: [], meta: { numFound: 0 } });
      if (url.includes("id=m43570223189")) {
        return jsonResponse({
          data: {
            id: "m43570223189",
            name: "HAC オリジナル 雪ミク機 ネックストラップ 青",
            description: "SNOW MIKU / JAL 北海道エアシステム限定品",
            price: 1_222,
            status: "sold_out",
            itemConditionId: "2",
          },
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await mercariAdapter.search({
      query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      filters: { availabilityMode: "sold_out", pageSize: 120 },
      sourceConfig: { historyItemIds: ["m43570223189"] },
    }, { fetch: fetcher, secrets: {} });

    const searchBody = calls.find((call) => call.url.includes("/v2/entities:search"))?.body as {
      searchCondition?: { status?: string[] };
    };
    expect(searchBody.searchCondition?.status).toEqual(["STATUS_SOLD_OUT", "STATUS_TRADING"]);
    expect(calls.some((call) => isMercariItemRequest(call.url, "m43570223189"))).toBe(true);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceItemId: "m43570223189",
      currentPrice: 1_222,
      availability: "sold_out",
      rawMetadata: { sourceStatus: "sold_out" },
    });
    expect(result.requestEvidence).toMatchObject({
      availabilityMode: "sold_out",
      requestedStatuses: ["STATUS_SOLD_OUT", "STATUS_TRADING"],
      keywordRawResultCount: 0,
      liveDetailResultCount: 1,
      anchorCandidateCount: 1,
      rawResultCount: 1,
      normalizedResultCount: 1,
    });
  });

  it("merges live-refreshed sold history anchors into all-mode keyword results", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (url.includes("/v2/entities:search")) {
        return jsonResponse({
          meta: { nextPageToken: "", previousPageToken: "", numFound: "1", properties: [] },
          items: [{
            id: "m27930309484",
            status: "ITEM_STATUS_ON_SALE",
            name: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
            price: "3800",
            created: "1774673297",
            updated: "1776163095",
            thumbnails: ["https://static.mercdn.net/thumb/item/webp/m27930309484_1.jpg"],
            itemType: "ITEM_TYPE_MERCARI",
            itemConditionId: "1",
          }],
        });
      }
      if (url.includes("id=m43570223189")) {
        return jsonResponse({ data: {
          id: "m43570223189",
          name: "HAC オリジナル 雪ミク機 ネックストラップ 青",
          description: "JAL 北海道 初音ミク 雪ミク 北海道エアシステム",
          price: 1_222,
          status: "sold_out",
          itemConditionId: "1",
        } });
      }
      if (url.includes("id=m90671490011")) {
        return jsonResponse({ data: {
          id: "m90671490011",
          name: "JAL（HACオリジナル） 雪ミク機 ネックストラップ（青）",
          description: "SNOW MIKU / 三沢空港限定品",
          price: 1_300,
          status: "sold_out",
          itemConditionId: "1",
        } });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await mercariAdapter.search({
      query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      filters: { availabilityMode: "all", pageSize: 30, sort: "newest" },
      sourceConfig: { historyItemIds: ["m43570223189", "m90671490011"] },
    }, { fetch: fetcher, secrets: {} });

    const searchBody = calls.find((call) => call.url.includes("/v2/entities:search"))?.body as {
      searchCondition?: { status?: string[] };
    };
    expect(searchBody.searchCondition?.status).toEqual(["STATUS_ON_SALE", "STATUS_SOLD_OUT", "STATUS_TRADING"]);
    expect(calls.some((call) => isMercariItemRequest(call.url, "m43570223189"))).toBe(true);
    expect(calls.some((call) => isMercariItemRequest(call.url, "m90671490011"))).toBe(true);
    expect(result.listings).toMatchObject([
      { sourceItemId: "m27930309484", currentPrice: 3_800, availability: "available" },
      { sourceItemId: "m43570223189", currentPrice: 1_222, availability: "sold_out" },
      { sourceItemId: "m90671490011", currentPrice: 1_300, availability: "sold_out" },
    ]);
    expect(result.requestEvidence).toEqual({
      availabilityMode: "all",
      requestedStatuses: ["STATUS_ON_SALE", "STATUS_SOLD_OUT", "STATUS_TRADING"],
      rawResultCount: 3,
      normalizedResultCount: 3,
      pagesFetched: 1,
      keywordRawResultCount: 1,
      liveDetailResultCount: 2,
      anchorCandidateCount: 2,
    });
  });

  it("requires history anchor titles to match the current query", () => {
    const exactQuery = "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青";
    expect(historyListingMatchesQuery(exactQuery, {
      title: "HAC オリジナル 雪ミク機 ネックストラップ 青",
    })).toBe(true);
    expect(historyListingMatchesQuery(exactQuery, {
      title: "JAL（HACオリジナル） 雪ミク機 ネックストラップ（青）",
    })).toBe(true);
    expect(historyListingMatchesQuery("雪ミク HAC JAL ネックストラップ", {
      title: "JAL（HACオリジナル） 雪ミク機 ネックストラップ（青）",
    })).toBe(true);
    expect(historyListingMatchesQuery("雪ミク HAC JAL ネックストラップ", {
      title: "JAL 飛行機 ミニチュア ホワイト",
    })).toBe(false);
  });

  it("looks up item detail and maps the nested data schema", async () => {
    const fetcher = vi.fn(async () => jsonResponse(mercariItemFixture)) as unknown as typeof fetch;
    const item = await mercariAdapter.getItem!("https://jp.mercari.com/item/m95317526324", { fetch: fetcher, secrets: {} });
    expect(item).toMatchObject({
      sourceItemId: "m95317526324",
      currentPrice: 2800,
      sellerName: "えるのお店",
      availability: "available",
      condition: "used",
      rawMetadata: { sourceConditionId: "2", sourceConditionLabel: "目立った傷なし" },
    });
  });

  it("extracts an opaque Mercari Shops ID for item detail", async () => {
    let requested = "";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return jsonResponse({
        ...mercariItemFixture,
        data: {
          ...mercariItemFixture.data,
          id: "FxHFY4yGnZznBUN76YziYm",
          itemType: "ITEM_TYPE_BEYOND",
        },
      });
    }) as unknown as typeof fetch;
    const item = await mercariAdapter.getItem!(
      "https://jp.mercari.com/shops/product/FxHFY4yGnZznBUN76YziYm",
      { fetch: fetcher, secrets: {} },
    );
    expect(new URL(requested).searchParams.get("id")).toBe("FxHFY4yGnZznBUN76YziYm");
    expect(item.canonicalUrl).toBe("https://jp.mercari.com/shops/product/FxHFY4yGnZznBUN76YziYm");
  });

  it("fails closed on schema changes and classifies 403/429", async () => {
    const changed = vi.fn(async () => jsonResponse(mercariSchemaFixture)) as unknown as typeof fetch;
    await expect(mercariAdapter.search({ query: "x", filters: {} }, { fetch: changed, secrets: {} })).rejects.toBeInstanceOf(MercariSchemaChangedError);
    const blocked = vi.fn(async () => jsonResponse({}, 403)) as unknown as typeof fetch;
    await expect(mercariAdapter.search({ query: "x", filters: {} }, { fetch: blocked, secrets: {} })).rejects.toBeInstanceOf(MercariBlockedError);
    const limited = vi.fn(async () => jsonResponse({}, 429, { "Retry-After": "180" })) as unknown as typeof fetch;
    await expect(mercariAdapter.search({ query: "x", filters: {} }, { fetch: limited, secrets: {} }))
      .rejects.toMatchObject({ constructor: MercariRateLimitError, retryAfterSeconds: 180, retryable: true });
  });
});

describe("Surugaya HTML endpoint adapter", () => {
  it("keeps a long query intact and requests sold-out products when availability is unrestricted", async () => {
    const query = "ぬいぐるみ　エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定";
    const requestedUrls: URL[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      return new Response(`${surugayaPage1}${" ".repeat(9_000)}`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;

    const result = await surugayaAdapter.search(
      { query, filters: { availabilityMode: "all", inStockOnly: false }, sourceConfig: { pages: 1 } },
      { fetch: fetcher, secrets: {} },
    );

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.searchParams.get("search_word")).toBe(query);
    expect(requestedUrls[0]?.searchParams.get("ck")).toBe("true");
    expect(requestedUrls[0]?.searchParams.get("inStock")).toBe("On");
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBe("2");
    expect(result.warnings).toContain("已按骏河屋官方品切れ开关包含无库存商品");
  });

  it("does not rewrite or retry a rejected long query", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(surugayaAdapter.search(
      { query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青", filters: {}, sourceConfig: { pages: 1 } },
      { fetch: fetcher, secrets: {} },
    )).rejects.toMatchObject({ code: "http_404", status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the official sold-out switch off for purchasable-only searches", async () => {
    let requestedUrl: URL | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = new URL(input instanceof Request ? input.url : String(input));
      return new Response(`${surugayaPage1}${" ".repeat(9_000)}`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }) as unknown as typeof fetch;

    await surugayaAdapter.search(
      { query: "エミリア", filters: { availabilityMode: "purchasable", inStockOnly: false } },
      { fetch: fetcher, secrets: {} },
    );

    expect(requestedUrl?.searchParams.has("ck")).toBe(false);
    expect(requestedUrl?.searchParams.has("inStock")).toBe(false);
  });

  it.each([403, 429])("does not retry a blocked long query after %s", async (status) => {
    const fetcher = vi.fn(async () => new Response("blocked", { status })) as unknown as typeof fetch;
    await expect(surugayaAdapter.search(
      { query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青", filters: {}, sourceConfig: { pages: 1 } },
      { fetch: fetcher, secrets: {} },
    )).rejects.toBeInstanceOf(SurugayaBlockedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("streams responses through the 2 MB limit and rejects an oversized body without Content-Length", async () => {
    const oversized = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_500_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/html; charset=UTF-8" } })) as unknown as typeof fetch;
    await expect(fetchSurugayaHtml(oversized, new URL("https://www.suruga-ya.jp/search")))
      .rejects.toMatchObject({ code: "response_too_large" });
  });

  it("allows a reCAPTCHA script preload but blocks redirects outside Surugaya", async () => {
    const normalHtml = `${surugayaPage1}<script src="https://www.google.com/recaptcha/api.js"></script>${" ".repeat(9_000)}`;
    const normal = vi.fn(async () => new Response(normalHtml, { headers: { "Content-Type": "text/html; charset=UTF-8" } })) as unknown as typeof fetch;
    const fetched = await fetchSurugayaHtml(normal, new URL("https://www.suruga-ya.jp/search"));
    expect(fetched.byteLength).toBeGreaterThan(8_000);

    const redirected = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/challenge" },
    })) as unknown as typeof fetch;
    await expect(fetchSurugayaHtml(redirected, new URL("https://www.suruga-ya.jp/search")))
      .rejects.toMatchObject({ code: "surugaya_unexpected_redirect" });
    expect(redirected).toHaveBeenCalledTimes(1);

    await expect(fetchSurugayaHtml(redirected, new URL("https://www.suruga-ya.jp/product/detail/994909113/extra")))
      .rejects.toMatchObject({ code: "invalid_source_url" });
    expect(redirected).toHaveBeenCalledTimes(1);
  });

  it("recovers UTF-8 search terms from Surugaya's byte-oriented redirect header", async () => {
    const normalHtml = `${surugayaPage1}${" ".repeat(9_000)}`;
    const mojibake = String.fromCharCode(...new TextEncoder().encode("千反田える"));
    let calls = 0;
    const redirected = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response(null, {
        status: 301,
        headers: { Location: `https://www.suruga-ya.jp/search?search_word=${mojibake}` },
      })
        : new Response(normalHtml, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }) as unknown as typeof fetch;

    await fetchSurugayaHtml(redirected, new URL("https://www.suruga-ya.jp/search?search_word=%E5%8D%83%E5%8F%8D%E7%94%B0%E3%81%88%E3%82%8B"));
    const secondRequest = new URL(String(redirected.mock.calls[1]?.[0]));
    expect(secondRequest.searchParams.get("search_word")).toBe("千反田える");
  });

  it("parses self-operated and marketplace prices without merging them", async () => {
    const first = await Promise.all(parseSurugayaHtmlFallback(surugayaPage1).map(normalizeSurugayaItem));
    const second = await Promise.all(parseSurugayaHtmlFallback(surugayaPage2).map(normalizeSurugayaItem));
    expect(first[0]).toMatchObject({ sourceItemId: "994909113", currentPrice: 905, availability: "available", condition: "used" });
    expect(first[0]?.canonicalUrl).toBe("https://www.suruga-ya.jp/product/detail/994909113");
    expect(first[0]?.imageUrl).toBe("https://www.suruga-ya.jp/database/photo.php?shinaban=994909113&size=m");
    expect(first[0]?.rawMetadata).toMatchObject({ marketplacePrice: null, priceSource: "teika" });
    expect(second[0]).toMatchObject({ sourceItemId: "869006709", currentPrice: 1880, availability: "sold_out" });
    expect(second[0]?.rawMetadata).toMatchObject({ marketplacePrice: 1880, priceSource: "marketplace", parserVersion: "surugaya-html-v5" });
  });

  it("prices a marketplace-only listing from its marketplace amount and records the basis", async () => {
    const listing = await normalizeSurugayaItem({
      href: "/product/detail/500123456",
      title: "エミリア アクリルスタンド",
      marketplacePriceText: "￥4,200",
    });
    expect(listing).toMatchObject({ currentPrice: 4_200, availability: "available" });
    expect(listing?.rawMetadata).toMatchObject({ marketplacePrice: 4_200, priceSource: "marketplace" });
  });

  it("keeps the self-operated price when both sides are listed and marks the unpriced case", async () => {
    const both = await normalizeSurugayaItem({
      href: "/product/detail/500123457",
      title: "エミリア アクリルスタンド",
      normalPriceText: "中古：￥3,000",
      marketplacePriceText: "￥4,200",
    });
    expect(both).toMatchObject({ currentPrice: 3_000 });
    expect(both?.rawMetadata).toMatchObject({ marketplacePrice: 4_200, priceSource: "teika" });

    const neither = await normalizeSurugayaItem({ href: "/product/detail/500123458", title: "エミリア アクリルスタンド" });
    expect(neither).toMatchObject({ currentPrice: undefined, availability: "unknown" });
    expect(neither?.rawMetadata).toMatchObject({ marketplacePrice: null, priceSource: "none" });
  });

  it("keeps an explicit sold-out state when structured data still contains the last listed price", async () => {
    const listing = await normalizeSurugayaItem({
      href: "/product/detail/646170273",
      title: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
      normalPriceText: "38,300",
      soldOutText: "品切れ",
    });
    expect(listing).toMatchObject({
      sourceItemId: "646170273",
      currentPrice: 38_300,
      availability: "sold_out",
    });
  });

  it("reads an archived offer price and official list price from a sold-out product detail", async () => {
    const product = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "エミリア F:NEX限定 ふわかわロリータぬいぐるみ",
      description: "F:NEX限定のエミリアぬいぐるみ。衣装と付属品を含みます。",
      image: "https://www.suruga-ya.jp/database/photo.php?shinaban=646170273&size=m",
      offers: {
        "@type": "Offer",
        price: "38300",
        priceCurrency: "JPY",
        availability: "https://schema.org/OutOfStock",
      },
    };
    const html = `<!doctype html><html lang="ja"><head><title>中古ぬいぐるみ | 駿河屋</title>
      <script type="application/ld+json">${JSON.stringify(product)}</script></head>
      <body><h1>${product.name}</h1><table><tr><th>定価</th><td>11,000円</td></tr></table><p>品切れ</p>
      <!--${"detail-padding".repeat(700)}--></body></html>`;
    const fetcher = vi.fn(async () => new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } })) as unknown as typeof fetch;

    const listing = await surugayaAdapter.getItem!("646170273", { fetch: fetcher, secrets: {} });

    expect(listing).toMatchObject({
      sourceItemId: "646170273",
      currentPrice: 38_300,
      originalPrice: 11_000,
      descriptionExcerpt: "F:NEX限定のエミリアぬいぐるみ。衣装と付属品を含みます。",
      availability: "sold_out",
      facts: {
        sourceAvailabilityLabel: "品切れ",
        displayFacts: [{ key: "list_price", label: "官方定价", group: "commerce", kind: "text", value: "￥11,000" }],
        priceReferences: [{
          kind: "official_list",
          amountJpy: 11_000,
          currency: "JPY",
          taxStatus: "unknown",
          shippingStatus: "unknown",
          sourceLabel: "骏河屋商品详情「定価」",
        }],
      },
      rawMetadata: {
        offerAvailability: "https://schema.org/OutOfStock",
        referenceListPrice: 11_000,
        priceEvidence: "json_ld_offer",
      },
    });
  });

  it("uses the lower bound of a displayed price range instead of concatenating both amounts", async () => {
    const listing = await normalizeSurugayaItem({
      href: "/product/detail/428048532",
      title: "氷菓 BD-BOX",
      normalPriceText: "￥16,900  ～ ￥22,500",
    });
    expect(listing).toMatchObject({ currentPrice: 16900, availability: "available" });
  });

  it("keeps an explicit null marketplace price across JSON service boundaries", async () => {
    const listing = await normalizeSurugayaItem({ href: "/product/detail/123", title: "商品", normalPriceText: "￥1,000" });
    const serialized = JSON.parse(JSON.stringify(listing)) as { rawMetadata: Record<string, unknown> };
    expect(Object.hasOwn(serialized.rawMetadata, "marketplacePrice")).toBe(true);
    expect(serialized.rawMetadata.marketplacePrice).toBeNull();
  });

  it("gives one identity to a product URL with and without a trailing slash", async () => {
    const bare = await normalizeSurugayaItem({ href: "/product/detail/123456", title: "商品", normalPriceText: "￥1,000" });
    const slashed = await normalizeSurugayaItem({ href: "/product/detail/123456/", title: "商品", normalPriceText: "￥1,000" });
    expect(bare?.sourceItemId).toBe("123456");
    expect(slashed?.sourceItemId).toBe("123456");
    expect(slashed?.canonicalUrl).toBe("https://www.suruga-ya.jp/product/detail/123456");
    expect(slashed?.canonicalUrl).toBe(bare?.canonicalUrl);
  });

  it("uses URL identity rather than the title", async () => {
    const left = await normalizeSurugayaItem({ href: "/product/detail/A001", title: "同じタイトル", normalPriceText: "￥1,000" });
    const right = await normalizeSurugayaItem({ href: "/product/detail/A002", title: "同じタイトル", normalPriceText: "￥1,000" });
    expect(left?.sourceItemId).toBe("A001");
    expect(right?.sourceItemId).toBe("A002");
  });
});
