import { describe, expect, it, vi } from "vitest";
import {
  normalizeYahooFleamarketItem,
  parseYahooFleamarketItemHtml,
  parseYahooFleamarketSearchHtml,
  yahooFleamarketAdapter,
} from "../packages/adapters/src/yahoo-fleamarket";
import { normalizedListingSchema } from "../packages/validation/src";

function nextDataHtml(initialState: Record<string, unknown>): string {
  return `<!doctype html><html><head><title>fixture</title></head><body><main>${"fixture ".repeat(300)}</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { initialState } })}</script></body></html>`;
}

const searchItem = {
  id: "z589863828",
  title: "Re:ゼロから始める異世界生活 合成测试商品",
  price: 7_200,
  itemStatus: "OPEN",
  condition: "used",
  thumbnailImageUrl: "https://item-shopping.c.yimg.jp/i/n/synthetic/item.jpg",
  likeCount: 8,
  imageCount: 4,
  openTime: "2026-07-16T10:00:00+09:00",
  category: { path: [{ name: "おもちゃ" }, { name: "キャラクターグッズ" }] },
  brand: { name: "Synthetic Brand" },
  sellerId: "bounded-seller-id",
};

function searchHtml(): string {
  return nextDataHtml({
    searchState: {
      search: {
        result: {
          totalResultsAvailable: 250,
          totalResultsReturned: 100,
          offset: 100,
          items: [searchItem, { id: "invalid-without-price", title: "invalid" }],
        },
      },
    },
  });
}

function itemHtml(): string {
  return nextDataHtml({
    itemsState: {
      items: {
        item: {
          ...searchItem,
          itemStatus: "SOLD",
          condition: { key: "new", name: "新品、未使用" },
          description: "合成测试详情，不包含真实用户数据。",
          seller: { nickname: "synthetic-seller" },
          imageUrls: [
            "https://item-shopping.c.yimg.jp/i/n/synthetic/detail-1.jpg",
            "https://item-shopping.c.yimg.jp/i/n/synthetic/detail-2.jpg",
          ],
          createDate: "2026-07-15T10:00:00+09:00",
          updateDate: "2026-07-17T10:00:00+09:00",
        },
      },
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

describe("Yahoo! Fleamarket public HTML adapter", () => {
  it("accepts complete anonymous results even when the page embeds a login call-to-action", async () => {
    const html = searchHtml().replace("</body>", "<aside>ログインしてください</aside></body>");
    const fetcher = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch;

    const result = await yahooFleamarketAdapter.search({
      query: "リゼロ",
      filters: {},
    }, { fetch: fetcher, secrets: {} });

    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.sourceItemId).toBe("z589863828");
  });

  it("reads the fixed public search page, keeps upstream pagination evidence and filters locally", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return htmlResponse(searchHtml());
    }) as unknown as typeof fetch;

    const result = await yahooFleamarketAdapter.search({
      query: "リゼロ",
      filters: { page: 2, minPrice: 5_000, maxPrice: 8_000, conditions: ["used"], sort: "newest" },
    }, { fetch: fetcher, secrets: {} });

    expect(calls).toEqual(["https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AA%E3%82%BC%E3%83%AD?page=2&sort=openTime&order=desc"]);
    expect(result).toMatchObject({
      sourceId: "yahoo_fleamarket_jp",
      coverage: "rolling_window",
      totalAvailable: 250,
      nextCursor: "3",
      requestEvidence: {
        rawResultCount: 2,
        normalizedResultCount: 1,
        parserAcceptedCount: 1,
        parserRejectedCount: 1,
      },
      listings: [{
        sourceId: "yahoo_fleamarket_jp",
        sourceItemId: "z589863828",
        canonicalUrl: "https://paypayfleamarket.yahoo.co.jp/item/z589863828",
        currentPrice: 7_200,
        condition: "used",
        availability: "available",
        facts: {
          brand: "Synthetic Brand",
          categoryPath: ["おもちゃ", "キャラクターグッズ"],
        },
      }],
    });
    expect(result.warnings.join(" ")).toContain("保留上游默认顺序");
    expect(normalizedListingSchema.safeParse(result.listings[0]).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("cookie");
  });

  it("normalizes a sold item detail while preserving the canonical Yahoo! Fleamarket URL", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://paypayfleamarket.yahoo.co.jp/item/z589863828");
      return htmlResponse(itemHtml());
    }) as unknown as typeof fetch;

    const listing = await yahooFleamarketAdapter.getItem!(
      "https://paypayfleamarket.yahoo.co.jp/item/z589863828",
      { fetch: fetcher, secrets: {} },
    );

    expect(listing).toMatchObject({
      sourceId: "yahoo_fleamarket_jp",
      sourceItemId: "z589863828",
      availability: "sold_out",
      condition: "new",
      sellerName: "synthetic-seller",
      sourceListedAt: "2026-07-16T10:00:00+09:00",
      sourceUpdatedAt: "2026-07-17T10:00:00+09:00",
      facts: { sourceConditionLabel: "新品、未使用" },
    });
    expect(normalizedListingSchema.safeParse(listing).success).toBe(true);
  });

  it("classifies a missing item page as a non-retryable item-level outcome", async () => {
    const fetcher = vi.fn(async () => htmlResponse("not found", 404)) as unknown as typeof fetch;

    await expect(yahooFleamarketAdapter.getItem!(
      "z589863828",
      { fetch: fetcher, secrets: {} },
    )).rejects.toMatchObject({
      code: "yahoo_fleamarket_item_not_found",
      status: 404,
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts structurally valid 404 results and requires an explicit total for an empty page", async () => {
    const emptyHtml = nextDataHtml({
      searchState: {
        search: {
          result: {
            totalResultsAvailable: 0,
            totalResultsReturned: 0,
            offset: 0,
            items: [],
          },
        },
      },
    });
    const emptyFetcher = vi.fn(async () => htmlResponse(emptyHtml, 404)) as unknown as typeof fetch;
    await expect(yahooFleamarketAdapter.search({ query: "no-result", filters: {} }, { fetch: emptyFetcher, secrets: {} }))
      .resolves.toMatchObject({ listings: [], totalAvailable: 0 });

    const populatedFetcher = vi.fn(async () => htmlResponse(searchHtml(), 404)) as unknown as typeof fetch;
    await expect(yahooFleamarketAdapter.search({ query: "long-exact-query", filters: {} }, { fetch: populatedFetcher, secrets: {} }))
      .resolves.toMatchObject({ totalAvailable: 250, listings: [{ sourceItemId: "z589863828" }] });

    const ambiguousEmpty = nextDataHtml({ searchState: { search: { result: { items: [] } } } });
    const ambiguousFetcher = vi.fn(async () => htmlResponse(ambiguousEmpty, 404)) as unknown as typeof fetch;
    await expect(yahooFleamarketAdapter.search({ query: "ambiguous-empty", filters: {} }, { fetch: ambiguousFetcher, secrets: {} }))
      .rejects.toMatchObject({ code: "parser_structure_error" });
  });

  it("treats the similar-items retry page as zero results", async () => {
    const fallbackHtml = nextDataHtml({
      searchState: {
        search: {
          result: {
            totalResultsAvailable: 12_564,
            totalResultsReturned: 100,
            offset: 0,
            metadata: { retriedWithVectorSearch: true },
            items: [searchItem],
          },
        },
      },
    });
    const fetcher = vi.fn(async () => htmlResponse(fallbackHtml, 404)) as unknown as typeof fetch;
    const result = await yahooFleamarketAdapter.search(
      { query: "高木さん からかいパーカー グレー Lサイズ", filters: {} },
      { fetch: fetcher, secrets: {} },
    );
    expect(result.listings).toEqual([]);
    expect(result.totalAvailable).toBe(0);
    expect(result.nextCursor).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("相近搜索"))).toBe(true);

    const noticeOnly = searchHtml().replace("<main>", "<main><p>一致する商品が見つからなかったため、検索キーワードに近い商品を表示しています</p>");
    expect(parseYahooFleamarketSearchHtml(noticeOnly)).toMatchObject({ items: [], totalAvailable: 0, vectorFallback: true });
  });

  it("fails closed for foreign item URLs and malformed Next.js state", async () => {
    const fetcher = vi.fn(async () => htmlResponse(itemHtml())) as unknown as typeof fetch;
    await expect(yahooFleamarketAdapter.getItem!("https://example.com/item/z589863828", { fetch: fetcher, secrets: {} }))
      .rejects.toMatchObject({ code: "parser_structure_error" });
    expect(fetcher).not.toHaveBeenCalled();

    expect(() => parseYahooFleamarketSearchHtml("<html></html>"))
      .toThrow("缺少 __NEXT_DATA__");
    expect(() => parseYahooFleamarketItemHtml(nextDataHtml({})))
      .toThrow("缺少 items.item");
    expect(normalizeYahooFleamarketItem({ id: "unsafe/id", title: "x", price: 1 })).toBeUndefined();
  });
});
