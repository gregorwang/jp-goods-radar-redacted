import { describe, expect, it, vi } from "vitest";
import { amiamiAdapter, getAmiamiItem, searchAmiami } from "../packages/adapters/src/amiami";
import { parseSourceItemUrl } from "../packages/core/src/source-item-url";
import { normalizedListingSchema } from "../packages/validation/src";
import { AdaptiveSourceTransport } from "../apps/source-runner/src/adaptive-fetch";
import { createJobBodySchema } from "../apps/source-runner/src/schemas";
import { isAllowedSourceRunnerUrl } from "../apps/source-runner/src/source-policy";
import { sourceRunnerConfigured } from "../apps/collector/src/source-runner-client";
import { parseGoldenSuite } from "../apps/source-runner/src/golden-regression";
import { createSourceCaptureRecorder } from "../apps/collector/src/source-capture";

const used = { gcode: "FIGURE-156074-R", gname: "氷菓 千反田える フィギュア", min_price: 1880, max_price: 2200,
  c_price_taxed: 6000, condition_flg: 1, instock_flg: 1, stock_flg: 1, thumb_url: "/images/product/main/item.jpg" };
const detail = { ...used, scode: "FIGURE-156074-R085", sname_simple_j: used.gname, gname: "English title", price: 1880,
  sname: "(Pre-owned ITEM:A/BOX:B)English title", stock: 1, soldout_flg: 1, instock_flg: 0, order_closed_flg: 0,
  memo: "商品説明".repeat(900), spec: "高さ18cm", remarks: "外箱あり" };
function context(data: unknown, status = 200) {
  return { secrets: {}, fetch: vi.fn(async () => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })) };
}
function searchData(items = [used], total = 24) { return { RSuccess: true, items, search_result: { total_results: total } }; }
function detailData(item = detail) { return { RSuccess: true, item, _embedded: { other_items: [{ scode: "FIGURE-156074-R099", price: 2200, condition: "Item:A Box:A" }] } }; }

describe("AmiAmi Japanese source", () => {
  it("sends Japanese verbatim, preserves the storefront header and advances raw pagination", async () => {
    const ctx = context(searchData());
    const result = await searchAmiami({ query: "千反田える", filters: { pageSize: 1, minPrice: 2000 }, sourceConfig: { pageToken: "2" } }, ctx);
    const [url, init] = ctx.fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("s_keywords")).toBe("千反田える");
    expect(url.searchParams.has("lang")).toBe(false);
    expect(url.searchParams.get("pagecnt")).toBe("2");
    expect(new Headers(init.headers).get("x-user-key")).toBe("amiami_dev");
    expect(result.listings).toEqual([]);
    expect(result.nextCursor).toBe("3");
    expect(result.requestEvidence?.rawResultCount).toBe(1);
  });

  it("uses the live minimum rather than the reference price and handles used filtering", async () => {
    const ctx = context(searchData());
    const result = await searchAmiami({ query: "千反田える", filters: { conditions: ["used"], availabilityMode: "purchasable" } }, ctx);
    const [url] = ctx.fetch.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("s_st_condition_flg")).toBe("1");
    expect(result.listings[0]).toMatchObject({ currentPrice: 1880, identityScope: "catalog", priceBasis: "catalog_price", condition: "used", availability: "available" });
    expect(result.listings[0]?.facts?.priceReferences?.[0]?.amountJpy).toBe(6000);
    expect(normalizedListingSchema.safeParse(result.listings[0]).success).toBe(true);
  });

  it("does not turn missing prices into zero or claim ambiguous inventory is available", async () => {
    const result = await searchAmiami({ query: "千反田える", filters: {} }, context(searchData([{ ...used, min_price: null as never, instock_flg: 0 }])));
    expect(result.listings[0]?.currentPrice).toBeUndefined();
    expect(result.listings[0]?.availability).toBe("unknown");
  });

  it("keeps preorder separate from immediate stock", async () => {
    const result = await searchAmiami({ query: "初音ミク", filters: {} }, context(searchData([{ ...used, condition_flg: 0, preorderitem: 1 } as typeof used])));
    expect(result.listings[0]?.availability).toBe("preorder");
  });

  it("keeps catalog identity during detail refresh, full descriptions, Japanese titles and condition offers", async () => {
    const item = await getAmiamiItem(used.gcode, context(detailData()));
    expect(item).toMatchObject({ sourceItemId: used.gcode, identityScope: "catalog", title: used.gname, currentPrice: 1880, availability: "available" });
    expect(item.descriptionExcerpt?.length).toBeLessThanOrEqual(2500);
    expect(String(item.rawMetadata?.description)).toContain(detail.memo);
    expect(item.facts?.variants).toHaveLength(2);
    expect(item.facts?.variants?.[1]?.priceJpy).toBe(2200);
    expect(normalizedListingSchema.safeParse(item).success).toBe(true);
  });

  it("preserves an explicit offer and rejects an upstream substitution", async () => {
    const ctx = context(detailData());
    const item = await getAmiamiItem("https://www.amiami.com/eng/detail/?scode=FIGURE-156074-R085", ctx);
    expect(item).toMatchObject({ sourceItemId: "FIGURE-156074-R085", identityScope: "offer", priceBasis: "offer_price" });
    expect((ctx.fetch.mock.calls[0] as unknown as [URL])[0].searchParams.get("scode")).toBe("FIGURE-156074-R085");
    await expect(getAmiamiItem("FIGURE-156074-R099", context(detailData()))).rejects.toMatchObject({ code: "amiami_offer_mismatch" });
    await expect(getAmiamiItem("FIGURE-123456", context(detailData()))).rejects.toMatchObject({ code: "amiami_catalog_mismatch" });
  });

  it("distinguishes verified empty from an invalid or denied response", async () => {
    const result = await searchAmiami({ query: "存在しない商品", filters: {} }, context(searchData([], 0)));
    expect(result.requestEvidence?.collectionOutcome).toBe("verified_empty");
    expect(result.nextCursor).toBeUndefined();
    await expect(searchAmiami({ query: "千反田える", filters: {} }, context({ RSuccess: false, RValue: { ErrorMessage: "Invalid access." } }, 400)))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Invalid access.") });
    await expect(searchAmiami({ query: "千反田える", filters: {} }, context({ RSuccess: true })))
      .rejects.toMatchObject({ code: "parser_structure_error" });
  });

  it("recognizes Japanese item URLs, validates jobs and restricts API destinations", () => {
    expect(() => parseGoldenSuite({ schema: 1, sources: {} }, "amiami")).toThrow("golden_source_not_provisioned:amiami");
    expect(parseSourceItemUrl("https://www.amiami.jp/top/detail/detail?gcode=FIGURE-156074-R&utm_source=test"))
      .toMatchObject({ sourceId: "amiami", sourceItemId: used.gcode });
    expect(createJobBodySchema.safeParse({ sourceId: "amiami", operation: "search", request: { query: "千反田える", filters: {}, sourceConfig: { pageToken: "2" } } }).success).toBe(true);
    expect(createJobBodySchema.safeParse({ sourceId: "amiami", operation: "item", urlOrId: "https://evil.test/detail?gcode=FIGURE-1" }).success).toBe(false);
    expect(isAllowedSourceRunnerUrl("amiami", "https://api.amiami.com/api/v1.0/item?gcode=FIGURE-1")).toBe(true);
    expect(isAllowedSourceRunnerUrl("amiami", "https://api.amiami.com/api/v1.0/members/me")).toBe(false);
    expect(sourceRunnerConfigured("amiami", { SOURCE_RUNNER_URL: "https://runner.test/", MERCARI_ADAPTER_SIGNING_KEY: "test" } as never)).toBe(true);
    expect(amiamiAdapter.capabilities.historySearchSupported).toBe(false);
  });

  it("captures complete JSON and records challenge metadata without browser fallback or HTML storage", async () => {
    const rendererFactory = vi.fn();
    const transport = new AdaptiveSourceTransport("amiami", undefined, { rendererFactory, baseFetch: context(searchData()).fetch });
    await transport.fetch("https://api.amiami.com/api/v1.0/items?pagemax=1");
    expect(JSON.parse(transport.captures[0]!.rawPayload!)).toEqual(searchData());
    const blocked = new AdaptiveSourceTransport("amiami", undefined, { rendererFactory, baseFetch: vi.fn(async () => new Response("<html>Just a moment</html>", { status: 403, headers: { "content-type": "text/html" } })) });
    expect((await blocked.fetch("https://api.amiami.com/api/v1.0/items?pagemax=1")).status).toBe(403);
    expect(blocked.captures[0]?.rawPayload).toBeUndefined();
    expect(blocked.captures[0]?.payloadBytes).toBeGreaterThan(0);
    expect(rendererFactory).not.toHaveBeenCalled();
    for (const origin of [transport, blocked]) {
      const recorder = createSourceCaptureRecorder("amiami", context({ meta: { upstreamCaptures: origin.captures } }).fetch);
      await recorder.fetch("https://runner.test/v1/jobs/status");
      const stored = await recorder.flush();
      expect(stored).toHaveLength(2);
      expect(stored[0]?.rawPayload).not.toContain("upstreamCaptures");
      expect(stored[1]).toMatchObject({ requestUrl: origin.captures[0]?.requestUrl,
        payloadBytes: origin.captures[0]?.payloadBytes, contentHash: origin.captures[0]?.contentHash });
      expect(stored[1]?.error).toBeUndefined();
      if (origin === transport) expect(JSON.parse(stored[1]!.rawPayload!)).toEqual(searchData());
      else { expect(stored[1]?.rawPayload).toBeUndefined(); expect(stored[1]?.payloadKind).toBe("html"); }
    }
  });
});
