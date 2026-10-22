import { describe, expect, it, vi } from "vitest";
import { marketPageBudget, type NormalizedListing, type SearchRequest } from "../packages/core/src";
import { collectMarketWindow, collectNewListingWindow, mergedRequestEvidence } from "../apps/collector/src/market-pagination";
import type { RoutedSearchResult } from "../apps/collector/src/source-execution";

function listing(sourceItemId: string): NormalizedListing {
  return {
    sourceId: "mercari_jp",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl: `https://jp.mercari.com/item/${sourceItemId}`,
    title: sourceItemId,
    currency: "JPY",
    currentPrice: 1_000,
    priceBasis: "listing_price",
    condition: "used",
    availability: "available",
  };
}

function result(items: string[], nextCursor?: string): RoutedSearchResult {
  return {
    sourceId: "mercari_jp",
    listings: items.map(listing),
    coverage: "rolling_window",
    ...(nextCursor ? { nextCursor } : {}),
    totalAvailable: 90,
    warnings: [],
    parserVersion: "fixture",
    fetchedAt: "2026-07-15T00:00:00.000Z",
    requestRoute: "direct",
    routeOutcome: { kind: "primary_success", route: "direct" },
    requestEvidence: {
      availabilityMode: "all",
      rawResultCount: items.length,
      normalizedResultCount: items.length,
      pagesFetched: 1,
    },
  };
}

describe("bounded market pagination", () => {
  it("merges and de-duplicates multiple cursor pages inside one comparable market run", async () => {
    const requests: SearchRequest[] = [];
    const execute = vi.fn(async (request: SearchRequest) => {
      requests.push(request);
      return request.sourceConfig?.pageToken === "cursor-2"
        ? result(["m1", "m2"], "cursor-3")
        : result(["m1"], "cursor-2");
    });

    const merged = await collectMarketWindow({ query: "氷菓", filters: {}, sourceConfig: { pages: 2 } }, 2, execute);

    expect(requests.map((request) => request.sourceConfig?.pageToken)).toEqual([undefined, "cursor-2"]);
    expect(merged.listings.map((item) => item.sourceItemId)).toEqual(["m1", "m2"]);
    expect(merged.nextCursor).toBe("cursor-3");
    expect(merged.requestEvidence).toMatchObject({ rawResultCount: 3, normalizedResultCount: 2, pagesFetched: 2 });
    expect(merged.warnings.join(" ")).toContain("安全预算读取 2 页");
  });

  it.each(["pages", "pageCount"] as const)("passes only the source-specific %s aggregate key", async (aggregatePageKey) => {
    const execute = vi.fn(async () => result(["m1", "m2"]));
    await collectMarketWindow(
      { query: "氷菓", filters: {}, sourceConfig: { pages: 2, pageCount: 2, pageToken: "2" } },
      3,
      execute,
      { aggregatePageKey },
    );
    expect(execute.mock.calls[0]?.[0].sourceConfig).toEqual({ [aggregatePageKey]: 3 });
  });

  it("keeps source budgets explicit instead of treating Mercari or any other source as full inventory", () => {
    expect(marketPageBudget("mercari_jp")).toBe(4);
    expect(marketPageBudget("mercari_jp", 100)).toBe(100);
    expect(marketPageBudget("mercari_jp", 101)).toBe(100);
    expect(marketPageBudget("yahoo_shopping")).toBe(3);
    expect(marketPageBudget("cospa")).toBe(1);
  });
});

describe("merged request evidence", () => {
  it("keeps optional counters absent instead of turning unknown into 0", () => {
    const merged = mergedRequestEvidence([result(["m1"]), result(["m2", "m3"])]);

    expect(Object.keys(merged ?? {}).sort()).toEqual([
      "availabilityMode",
      "normalizedResultCount",
      "pagesFetched",
      "rawResultCount",
    ]);
    expect(merged).toMatchObject({ rawResultCount: 3, normalizedResultCount: 3, pagesFetched: 2 });
  });

  it("sums only the counters a source actually reported and accepts a de-duplicated count", () => {
    const first = result(["m1"]);
    const second = result(["m1", "m2"]);
    const merged = mergedRequestEvidence([
      { ...first, requestEvidence: { ...first.requestEvidence!, requestedStatuses: ["OPEN"], keywordRawResultCount: 4 } },
      { ...second, requestEvidence: { ...second.requestEvidence!, keywordRawResultCount: 6 } },
    ], 2);

    expect(merged).toMatchObject({
      requestedStatuses: ["OPEN"],
      rawResultCount: 3,
      normalizedResultCount: 2,
      pagesFetched: 2,
      keywordRawResultCount: 10,
    });
    expect(Object.keys(merged ?? {})).not.toContain("liveDetailResultCount");
    expect(Object.keys(merged ?? {})).not.toContain("parserRejectedCount");
  });
});

describe("bounded new-listing pagination", () => {
  it("keeps backfilling past a single already-known id and stops on a fully covered page", async () => {
    // 按更新时间排序的来源会把改过价的老商品顶回首页。撞上一个已知 ID 就停，
    // 会把整轮回溯截断在它上面，下面真正的新品永远读不到。
    const execute = vi.fn(async (request: SearchRequest) => (
      request.sourceConfig?.pageToken === "cursor-2"
        ? result(["known-1", "known-2"], "cursor-3")
        : result(["known-1", "m2"], "cursor-2")
    ));

    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 }, sourceConfig: {} },
      4,
      execute,
      { knownSourceItemIds: new Set(["known-1", "known-2"]) },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(merged.listings.map((item) => item.sourceItemId)).toEqual(["known-1", "m2", "known-2"]);
    // 整页都已覆盖才停下，不是预算截断。
    expect(merged.windowTruncated).toBe(false);
    expect(merged.warnings.join(" ")).not.toContain("安全预算");
  });

  it("stops once every listing on a page is at or below the watermark", async () => {
    const execute = vi.fn(async () => ({
      ...result(["m1", "m2"], "cursor-2"),
      listings: [
        { ...listing("m1"), sourceListedAt: "2026-09-01T00:00:00.000Z" },
        { ...listing("m2"), sourceListedAt: "2026-09-02T00:00:00.000Z" },
      ],
    }));

    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      4,
      execute,
      {
        knownSourceItemIds: new Set(["m1", "m2"]),
        watermark: "2026-09-03T00:00:00.000Z",
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(merged.windowTruncated).toBe(false);
  });

  it("keeps the pages it already fetched when a later page fails", async () => {
    // 单页超时不该报废整轮：前面的页是有效观察，丢掉它们会把一次成功采集判成失败，
    // 触发重试并把来源打进冷却。页预算越深踩中的概率越高，锚定轮尤其如此。
    let page = 0;
    const execute = vi.fn(async () => {
      page += 1;
      if (page === 3) throw new Error("The operation was aborted due to timeout");
      return result([`p${page}-a`, `p${page}-b`], `cursor-${page + 1}`);
    });

    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      8,
      execute,
      { knownSourceItemIds: new Set() },
    );

    expect(execute).toHaveBeenCalledTimes(3);
    expect(merged.listings.map((item) => item.sourceItemId))
      .toEqual(["p1-a", "p1-b", "p2-a", "p2-b"]);
    // 回溯没走到底，必须如实标成截断。
    expect(merged.windowTruncated).toBe(true);
  });

  it("still fails the run when the very first page fails", async () => {
    const execute = vi.fn(async () => { throw new Error("upstream down"); });
    await expect(collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      8,
      execute,
      { knownSourceItemIds: new Set() },
    )).rejects.toThrow("upstream down");
  });

  it("reads the whole budget on the anchor pass instead of converging on page one", async () => {
    // 锚定轮还没有水位线，收敛判据退化成"整页都见过就停"。历史上只读过一页的绑定
    // 第一页恰恰全都见过，收敛立刻成立——深预算一页都用不上，锚定就白做了。
    let page = 0;
    const execute = vi.fn(async () => {
      page += 1;
      return result([`known-${page}a`, `known-${page}b`], `cursor-${page + 1}`);
    });

    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      3,
      execute,
      {
        knownSourceItemIds: new Set(["known-1a", "known-1b", "known-2a", "known-2b", "known-3a", "known-3b"]),
        exhaustive: true,
      },
    );

    expect(execute).toHaveBeenCalledTimes(3);
    expect(merged.listings).toHaveLength(6);
  });

  it("reports truncation when the budget runs out before the window is covered", async () => {
    let page = 0;
    const fullPages = vi.fn(async () => {
      page += 1;
      return result([`p${page}-a`, `p${page}-b`], `cursor-${page + 1}`);
    });
    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      3,
      fullPages,
      { knownSourceItemIds: new Set() },
    );

    expect(fullPages).toHaveBeenCalledTimes(3);
    expect(merged.listings).toHaveLength(6);
    expect(merged.requestEvidence).toMatchObject({ normalizedResultCount: 6, pagesFetched: 3 });
    expect(merged.windowTruncated).toBe(true);
    expect(merged.warnings.join(" ")).toContain("新品窗口按安全预算读取 3 页");
  });

  it("stops instead of failing the run when the source stops advancing its cursor", async () => {
    // 游标不前进时丢掉整轮，会连第一页已经拿到的有效证据一起丢掉。
    const stalled = vi.fn(async () => result(["m1", "m2"], "cursor-stuck"));
    const merged = await collectNewListingWindow(
      { query: "氷菓", filters: { pageSize: 2 } },
      4,
      stalled,
      { knownSourceItemIds: new Set() },
    );

    expect(stalled).toHaveBeenCalledTimes(2);
    expect(merged.listings.map((item) => item.sourceItemId)).toEqual(["m1", "m2"]);
    expect(merged.windowTruncated).toBe(true);
  });
});
