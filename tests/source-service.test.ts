import { describe, expect, it, vi } from "vitest";
import { AdapterError } from "../packages/adapters/src/http";
import type { SourceAdapter } from "../packages/core/src";
import type {
  VercelRequest,
  VercelResponse,
} from "../apps/mercari-service/src/vercel-types";
import surugayaSearchHandler from "../apps/mercari-service/api/surugaya-search";
import { getSurugayaItemWithSearchFallback } from "../apps/mercari-service/src/surugaya-item-fallback";
import { fixedSourceItemBodySchema, fixedSourceSearchBodySchema } from "../apps/mercari-service/src/schemas";
import { fixedSourceAdapter } from "../apps/mercari-service/src/source-dispatch";
import { SOURCE_SERVICE_IDS } from "../apps/mercari-service/src/source-ids";
import { normalizedListingSchema } from "../packages/validation/src";

function adapter(overrides: Partial<SourceAdapter>): SourceAdapter {
  return {
    id: "surugaya",
    transport: "html_endpoint",
    parserVersion: "test",
    coverage: "rolling_window",
    capabilities: {
      keywordSearch: true,
      itemLookup: true,
      newestSort: false,
      priceFilter: false,
      conditionFilter: false,
      supportsUsed: true,
      historySearchSupported: false,
    },
    search: vi.fn(),
    ...overrides,
  } as SourceAdapter;
}

describe("Surugaya item service fallback", () => {
  it("uses one exact public search page when the detail page is blocked", async () => {
    const search = vi.fn(async () => ({
      sourceId: "surugaya" as const,
      listings: [{ sourceId: "surugaya" as const, sourceItemId: "869006709", identityScope: "listing" as const,
        canonicalUrl: "https://www.suruga-ya.jp/product/detail/869006709", title: "商品", condition: "used" as const,
        availability: "available" as const, rawMetadata: { marketplacePrice: null } }],
      coverage: "rolling_window" as const,
      warnings: [],
      parserVersion: "test",
      fetchedAt: new Date().toISOString(),
    }));
    const source = adapter({
      search,
      getItem: vi.fn(async () => { throw new AdapterError("blocked", "surugaya_blocked", 403); }),
    });
    const listing = await getSurugayaItemWithSearchFallback("https://www.suruga-ya.jp/product/detail/869006709",
      { fetch, secrets: {} }, source);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "869006709", sourceConfig: { pages: 1 } }), expect.anything());
    expect(listing).toMatchObject({ sourceItemId: "869006709",
      rawMetadata: { itemLookupMethod: "search_exact_id", detailErrorCode: "surugaya_blocked" } });
  });

  it("does not conceal a non-recoverable item validation error", async () => {
    const search = vi.fn();
    const source = adapter({
      search,
      getItem: vi.fn(async () => { throw new AdapterError("invalid", "invalid_item_id"); }),
    });
    await expect(getSurugayaItemWithSearchFallback("invalid", { fetch, secrets: {} }, source))
      .rejects.toMatchObject({ code: "invalid_item_id" });
    expect(search).not.toHaveBeenCalled();
  });
});

describe("fixed-purpose source service boundary", () => {
  it("returns a structured retryable JSON error when the Surugaya handler fails before adapter execution", async () => {
    const state: { status: number; body?: unknown } = { status: 200 };
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      status(code: number) {
        state.status = code;
        return response;
      },
      json(body: unknown) {
        state.body = body;
        return response;
      },
    } as VercelResponse;
    const request = {
      method: "POST",
      headers: {},
      get body(): never {
        throw new Error("sensitive validation failure");
      },
    } as VercelRequest;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await surugayaSearchHandler(request, response);

    expect(state.status).toBe(502);
    // 验签先于 schema 校验，因此第一个触碰 request.body 的阶段是 authentication。
    expect(state.body).toMatchObject({
      ok: false,
      error: {
        code: "surugaya_service_unhandled",
        message: "骏河屋适配服务在authentication阶段发生未处理错误",
        upstreamStatus: 500,
        retryable: true,
      },
    });
    expect(JSON.stringify(state.body)).not.toContain("sensitive validation failure");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"stage":"authentication"'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"correlationId":'));
    expect(response.setHeader).toHaveBeenCalledWith("X-JPGR-Request-ID", expect.any(String));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("sensitive validation failure"));
    consoleError.mockRestore();
  });

  it("advertises every fixed-purpose route in health metadata", () => {
    expect(SOURCE_SERVICE_IDS).toEqual(["mercari_jp", "surugaya", "yahoo_shopping", "charaon", "cospa", "animate"]);
  });

  it("dispatches only the three declared adapters", () => {
    expect(fixedSourceAdapter("charaon").id).toBe("charaon");
    expect(fixedSourceAdapter("cospa").id).toBe("cospa");
    expect(fixedSourceAdapter("animate").id).toBe("animate");
  });

  it("accepts official item IDs and rejects cross-source or arbitrary URLs", () => {
    expect(fixedSourceItemBodySchema.safeParse({ sourceId: "charaon", urlOrId: "AZMGS92" }).success).toBe(true);
    expect(fixedSourceItemBodySchema.safeParse({ sourceId: "cospa", urlOrId: "00000123456" }).success).toBe(true);
    expect(fixedSourceItemBodySchema.safeParse({ sourceId: "animate", urlOrId: "3141592" }).success).toBe(true);
    expect(fixedSourceItemBodySchema.safeParse({
      sourceId: "cospa",
      urlOrId: "https://www.charaon.jp/SHOP/AZMGS92.html",
    }).success).toBe(false);
    expect(fixedSourceItemBodySchema.safeParse({
      sourceId: "animate",
      urlOrId: "https://example.com/pn/_/pd/3141592/",
    }).success).toBe(false);
    expect(fixedSourceItemBodySchema.safeParse({ sourceId: "unknown", urlOrId: "3141592" }).success).toBe(false);
  });

  it("keeps search payloads bounded and strict", () => {
    expect(fixedSourceSearchBodySchema.safeParse({
      sourceId: "charaon",
      request: { query: "文豪", filters: { page: 1, pageSize: 30, sort: "newest" } },
    }).success).toBe(true);
    expect(fixedSourceSearchBodySchema.safeParse({
      sourceId: "charaon",
      request: { query: "文豪", filters: { pageSize: 500 }, arbitraryUrl: "https://example.com" },
    }).success).toBe(false);
  });

  it("rejects a canonical URL that does not belong to the declared source", () => {
    expect(normalizedListingSchema.safeParse({
      sourceId: "charaon",
      sourceItemId: "AZMGS92",
      identityScope: "catalog",
      canonicalUrl: "https://example.com/SHOP/AZMGS92.html",
      title: "商品",
      currency: "JPY",
      currentPrice: 440,
      priceBasis: "catalog_price",
      condition: "new",
      availability: "available",
    }).success).toBe(false);
  });
});
