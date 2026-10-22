import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createYahooAuctionsAdapter,
  normalizeYahooAuctionsSearchItem,
  normalizeYahooAuctionsDetail,
  YAHOO_AUCTIONS_SEARCH_URL,
} from "../packages/adapters/src/yahoo-auctions";
import { normalizedListingSchema } from "../packages/validation/src";

const searchFixture = JSON.parse(
  readFileSync(new URL("./fixtures/yahoo-auctions/search.json", import.meta.url), "utf8"),
) as { totalResultsAvailable: number; items: Array<Record<string, unknown>> };
const detailFixture = JSON.parse(
  readFileSync(new URL("./fixtures/yahoo-auctions/detail.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const enabledSecrets = {
  YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true",
  YAHOO_AUCTIONS_TIMEOUT_MS: "15000",
  YAHOO_AUCTIONS_RATE_INTERVAL_MS: "2000",
};

function attribute(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function epochSeconds(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function openSearchHtml(total = searchFixture.totalResultsAvailable): string {
  const cards = searchFixture.items.map((row) => {
    const categoryPath = Array.isArray(row.categoryPath)
      ? row.categoryPath.map((entry) => (entry as Record<string, unknown>).id).join(",")
      : "";
    const category = (row.category ?? {}) as Record<string, unknown>;
    return `<li class="Product">
      <div class="Product__bonus"
        data-auction-id="${attribute(row.auctionId)}"
        data-auction-endtime="${epochSeconds(row.endTime)}"
        data-auction-buynowprice="${attribute(row.buyNowPrice)}"
        data-auction-categoryidpath="${attribute(categoryPath)}"
        data-auction-price="${attribute(row.price)}"></div>
      <h3 class="Product__title"><a class="Product__titleLink"
        data-auction-id="${attribute(row.auctionId)}"
        data-auction-category="${attribute(category.id)}"
        data-auction-title="${attribute(row.title)}"
        data-auction-img="${attribute(row.imageUrl)}"
        data-auction-price="${attribute(row.price)}"
        data-auction-isfreeshipping="${row.isFreeShipping ? "1" : ""}"
        data-auction-isflea="${row.isFleamarketItem ? "1" : ""}"
        data-cl-params="st:${epochSeconds(row.startTime)};etc:p=${attribute(row.price)},b=${attribute(row.bidCount)},w=${attribute(row.watchCount)},x=1;"
        href="https://auctions.yahoo.co.jp/jp/auction/${attribute(row.auctionId)}">${attribute(row.title)}</a></h3>
      <dl><div><dd class="Product__bid">${attribute(row.bidCount ?? 0)}</dd></div></dl>
    </li>`;
  }).join("");
  return `<!doctype html><html><body>${"fixture ".repeat(300)}
    <li class="Tab__item Tab__item--current"><span class="Tab__subText">${total.toLocaleString("en-US")}件</span></li>
    <ul class="Products__items">${cards}</ul>
  </body></html>`;
}

function emptyOpenSearchHtml(): string {
  return `<!doctype html><html><body>${"fixture ".repeat(300)}
    <li class="Tab__item Tab__item--current"><span class="Tab__subText">0件</span></li>
    <h2 class="Empty__title">条件に一致する商品は見つかりませんでした。</h2>
  </body></html>`;
}

function closedSearchHtml(): string {
  const nextData = {
    props: {
      initialState: {
        search: {
          items: {
            listing: {
              items: searchFixture.items,
              totalResultsAvailable: searchFixture.totalResultsAvailable,
            },
          },
        },
      },
    },
  };
  return `<!doctype html><html><body>${"fixture ".repeat(300)}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

function detailHtml(): string {
  const images = (detailFixture.img as Array<Record<string, unknown>>).map((image) => image.image);
  const categories = ((detailFixture.category as Record<string, unknown>).path as Array<Record<string, unknown>>);
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: categories.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: { "@id": `https://auctions.yahoo.co.jp/category/list/${entry.id}`, name: entry.name },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "Product",
      url: "https://auctions.yahoo.co.jp/jp/auction/x1234567890",
      name: detailFixture.title,
      description: (detailFixture.description as string[]).join("\n"),
      image: images,
      offers: {
        "@type": "Offer",
        priceCurrency: "JPY",
        price: String(detailFixture.price),
        priceValidUntil: detailFixture.endTime,
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/UsedCondition",
      },
    },
  ];
  return `<!doctype html><html><body>${"fixture ".repeat(300)}${jsonLd.map((value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`).join("")}</body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

describe("Yahoo! Auctions Japan experimental public-HTML adapter", () => {
  it("maps verified public query parameters and emits only normalized whitelist fields", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return htmlResponse(openSearchHtml());
    }) as unknown as typeof fetch;
    const adapter = createYahooAuctionsAdapter({ interRequestDelayMs: 0, retryDelayMs: 0 });

    const result = await adapter.search({
      query: "ポケモンカード",
      filters: {
        availabilityMode: "purchasable",
        page: 2,
        pageSize: 20,
        sort: "price_asc",
        minPrice: 1_000,
        maxPrice: 20_000,
        conditions: ["used"],
      },
      sourceConfig: {
        categoryIds: [2084317608, 2084317608],
        minBidCount: 1,
        maxBidCount: 20,
        freeShipping: true,
        buyNow: true,
      },
    }, { fetch: fetcher, secrets: enabledSecrets });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(YAHOO_AUCTIONS_SEARCH_URL.origin + YAHOO_AUCTIONS_SEARCH_URL.pathname);
    expect(calls[0]?.init?.method).toBeUndefined();
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(url.searchParams.get("p")).toBe("ポケモンカード");
    expect(url.searchParams.get("b")).toBe("21");
    expect(url.searchParams.get("n")).toBe("20");
    expect(url.searchParams.get("s1")).toBe("tbids");
    expect(url.searchParams.get("o1")).toBe("a");
    expect(url.searchParams.get("auccat")).toBe("2084317608");
    expect(url.searchParams.get("aucminprice")).toBe("1000");
    expect(url.searchParams.get("aucmaxprice")).toBe("20000");
    expect(url.searchParams.get("istatus")).toBe("3,4,5,6,7,2");
    expect(url.searchParams.get("pstagefree")).toBe("1");
    expect(url.searchParams.get("fixed")).toBe("1");

    expect(result).toMatchObject({
      sourceId: "yahoo_auctions_jp",
      coverage: "best_effort",
      nextCursor: "3",
      requestEvidence: {
        availabilityMode: "purchasable",
        requestedStatuses: ["OPEN"],
        rawResultCount: 2,
        normalizedResultCount: 1,
        parserRejectedCount: 1,
      },
      listings: [{
        sourceId: "yahoo_auctions_jp",
        sourceItemId: "x1234567890",
        canonicalUrl: "https://auctions.yahoo.co.jp/jp/auction/x1234567890",
        currentPrice: 3888,
        condition: "used",
        availability: "available",
      }],
    });
    expect(result.totalAvailable).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("当前页结果内应用出价数筛选");
    expect(normalizedListingSchema.safeParse(result.listings[0]).success).toBe(true);
    expect(result.listings[0]?.facts.provenance.identifiers?.method).toBe("html");
    const publicOutput = JSON.stringify(result);
    expect(publicOutput).not.toContain("must-not-leak-user-id");
    expect(publicOutput).not.toContain("must-not-leak-crumb");
    expect(publicOutput).not.toContain("must-not-leak-tracking");
  });

  it("uses the closed HTML state and can combine open plus closed without mixing statuses", async () => {
    const urls: URL[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return htmlResponse(url.pathname.startsWith("/closedsearch/") ? closedSearchHtml() : openSearchHtml());
    }) as unknown as typeof fetch;
    const adapter = createYahooAuctionsAdapter({ interRequestDelayMs: 0, retryDelayMs: 0 });

    const closed = await adapter.search({
      query: "ポケモンカード",
      filters: { availabilityMode: "sold_out", pageSize: 20, sort: "ending_late" },
    }, { fetch: fetcher, secrets: enabledSecrets });
    expect(urls[0]?.pathname).toBe("/closedsearch/closedsearch");
    expect(urls[0]?.searchParams.get("s1")).toBe("end");
    expect(urls[0]?.searchParams.get("o1")).toBe("d");
    expect(closed.listings[0]).toMatchObject({ availability: "sold_out", sellerName: "synthetic-seller" });
    expect(closed.listings[0]?.rawMetadata?.verifiedSaleEvidence).toEqual({
      evidenceVersion: "verified-sale-v1",
      kind: "closed_auction_with_bid",
      sourceSaleId: "x1234567890",
      soldPriceJpy: 3888,
      soldAt: "2026-07-15T12:39:43.000Z",
      bidCount: 3,
      sourceStatus: "CLOSED",
    });

    urls.length = 0;
    const all = await adapter.search({
      query: "ポケモンカード",
      filters: { availabilityMode: "all", pageSize: 20, sort: "relevance" },
    }, { fetch: fetcher, secrets: enabledSecrets });
    expect(urls.map((url) => url.pathname)).toEqual(["/search/search", "/closedsearch/closedsearch"]);
    expect(all.requestEvidence?.requestedStatuses).toEqual(["OPEN", "CLOSED"]);
    expect(all.listings.map((listing) => listing.availability)).toEqual(["available", "sold_out"]);
    // 在售拍卖给的是当前出价（会随竞价上涨），已结束的才是成交价。两者不能同池比较，
    // 也不能用当前出价判定"达到目标价"。
    expect(all.listings.map((listing) => listing.priceBasis)).toEqual(["auction_current_bid", "listing_price"]);
  });

  it("never calls a no-bid closed auction a verified sale", () => {
    const listing = normalizeYahooAuctionsSearchItem({
      ...searchFixture.items[0],
      bidCount: 0,
    }, "closed");

    expect(listing?.availability).toBe("sold_out");
    expect(listing?.rawMetadata).not.toHaveProperty("verifiedSaleEvidence");
  });

  it("keeps configured requests at least two seconds apart", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async (input: string | URL | Request) => htmlResponse(
        new URL(String(input)).pathname.startsWith("/closedsearch/") ? closedSearchHtml() : openSearchHtml(),
      )) as unknown as typeof fetch;
      const adapter = createYahooAuctionsAdapter({ retryDelayMs: 0 });
      const request = adapter.search({
        query: "ポケモンカード",
        filters: { availabilityMode: "all", pageSize: 20 },
      }, {
        fetch: fetcher,
        secrets: { ...enabledSecrets, YAHOO_AUCTIONS_RATE_INTERVAL_MS: "1" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toMatchObject({ sourceId: "yahoo_auctions_jp" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes detail Product JSON-LD without exposing unrelated page data", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://auctions.yahoo.co.jp/jp/auction/x1234567890");
      return htmlResponse(detailHtml().replace("</body>", "<aside>ログインしてください</aside></body>"));
    }) as unknown as typeof fetch;
    const adapter = createYahooAuctionsAdapter({ retryDelayMs: 0 });

    const listing = await adapter.getItem!(
      "https://auctions.yahoo.co.jp/jp/auction/x1234567890",
      { fetch: fetcher, secrets: enabledSecrets },
    );

    expect(listing).toMatchObject({
      sourceId: "yahoo_auctions_jp",
      sourceItemId: "x1234567890",
      canonicalUrl: "https://auctions.yahoo.co.jp/jp/auction/x1234567890",
      title: "合成测试用 ポケモンカード 詳細",
      currentPrice: 3888,
      condition: "used",
      availability: "available",
      descriptionExcerpt: "合成测试说明第一行。\n合成测试说明第二行。",
      imageUrl: "https://auc-pctr.c.yimg.jp/synthetic/detail-1.jpg",
      facts: {
        categoryPath: ["おもちゃ", "シングルカード"],
        imageUrls: [
          "https://auc-pctr.c.yimg.jp/synthetic/detail-1.jpg",
          "https://auc-pctr.c.yimg.jp/synthetic/detail-2.jpg",
        ],
        sourceConditionLabel: "https://schema.org/UsedCondition",
      },
    });
    expect(normalizedListingSchema.safeParse(listing).success).toBe(true);
    const publicOutput = JSON.stringify(listing);
    expect(publicOutput).not.toContain("must-not-leak-description-html");
    expect(publicOutput).not.toContain("must-not-leak-auc-id");
    expect(publicOutput).not.toContain("must-not-leak-seller-crumb");
    expect(publicOutput).not.toContain("must-not-leak-transaction");
    expect(publicOutput).not.toContain("attacker.invalid");

    expect(normalizeYahooAuctionsDetail({ ...detailFixture, conditionName: "未使用に近い" }, "x1234567890")?.condition).toBe("used");
    expect(normalizeYahooAuctionsDetail({ ...detailFixture, conditionName: "新品、未使用" }, "x1234567890")?.condition).toBe("new");
  });

  it("accepts structurally valid 404 search results and requires explicit zero for an empty page", async () => {
    const adapter = createYahooAuctionsAdapter({ retryDelayMs: 0 });
    const populatedFetcher = vi.fn(async () => htmlResponse(openSearchHtml(), 404)) as unknown as typeof fetch;
    await expect(adapter.search({ query: "long-exact-query", filters: { availabilityMode: "purchasable" } }, { fetch: populatedFetcher, secrets: enabledSecrets }))
      .resolves.toMatchObject({ totalAvailable: 100, listings: [{ sourceItemId: "x1234567890" }] });

    const emptyFetcher = vi.fn(async () => htmlResponse(emptyOpenSearchHtml(), 404)) as unknown as typeof fetch;
    await expect(adapter.search({ query: "no-result", filters: { availabilityMode: "purchasable" } }, { fetch: emptyFetcher, secrets: enabledSecrets }))
      .resolves.toMatchObject({ listings: [], totalAvailable: 0 });

    const malformedFetcher = vi.fn(async () => htmlResponse(`<!doctype html><html><body>${"missing ".repeat(400)}</body></html>`, 404)) as unknown as typeof fetch;
    await expect(adapter.search({ query: "no-result", filters: { availabilityMode: "purchasable" } }, { fetch: malformedFetcher, secrets: enabledSecrets }))
      .rejects.toMatchObject({ code: "yahoo_auctions_bad_response", status: 502 });
  });

  it("treats Yahoo's partial-keyword substitute page as zero results on both open and closed search", async () => {
    const notice = `<p><mark>小木曽雪菜 ぬいぐるみ</mark> に一致する商品はありません。キーワードの一部を利用した結果を表示しています。</p>`;
    const adapter = createYahooAuctionsAdapter({ interRequestDelayMs: 0, retryDelayMs: 0 });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const closed = new URL(String(input)).pathname.startsWith("/closedsearch");
      const html = (closed ? closedSearchHtml() : openSearchHtml(262_787)).replace("<body>", `<body>${notice}`);
      return htmlResponse(html, closed ? 200 : 404);
    }) as unknown as typeof fetch;
    const result = await adapter.search(
      { query: "小木曽雪菜 ぬいぐるみ", filters: { availabilityMode: "all" } },
      { fetch: fetcher, secrets: enabledSecrets },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.listings).toEqual([]);
    expect(result.totalAvailable).toBe(0);
    expect(result.nextCursor).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("自动删减关键词"))).toBe(true);
  });

  it("fails closed before fetch when disabled or given an unsafe item URL", async () => {
    const fetcher = vi.fn(async () => htmlResponse(openSearchHtml())) as unknown as typeof fetch;
    const adapter = createYahooAuctionsAdapter({ retryDelayMs: 0 });
    await expect(adapter.search({ query: "ポケモン", filters: {} }, { fetch: fetcher, secrets: {} }))
      .rejects.toMatchObject({ code: "yahoo_auctions_experiment_disabled", status: 503 });
    await expect(adapter.getItem!("https://example.com/jp/auction/x1234567890", { fetch: fetcher, secrets: enabledSecrets }))
      .rejects.toMatchObject({ code: "yahoo_auctions_invalid_item_id", status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries bounded transient statuses and rejects malformed HTML", async () => {
    let attempts = 0;
    const transientFetcher = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? new Response("bad gateway", { status: 502 }) : htmlResponse(openSearchHtml());
    }) as unknown as typeof fetch;
    const adapter = createYahooAuctionsAdapter({ interRequestDelayMs: 0, retryDelayMs: 0 });
    await expect(adapter.search({
      query: "ポケモン",
      filters: { availabilityMode: "purchasable" },
    }, { fetch: transientFetcher, secrets: enabledSecrets })).resolves.toMatchObject({ sourceId: "yahoo_auctions_jp" });
    expect(transientFetcher).toHaveBeenCalledTimes(2);

    const malformedFetcher = vi.fn(async () => htmlResponse(`<!doctype html><html><body>${"ordinary ".repeat(300)}</body></html>`)) as unknown as typeof fetch;
    await expect(adapter.search({
      query: "ポケモン",
      filters: { availabilityMode: "purchasable" },
    }, { fetch: malformedFetcher, secrets: enabledSecrets }))
      .rejects.toMatchObject({ code: "yahoo_auctions_bad_response", status: 502 });
    expect(malformedFetcher).toHaveBeenCalledTimes(1);
  });
});
