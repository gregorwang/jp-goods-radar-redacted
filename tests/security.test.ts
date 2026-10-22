import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  bindingPatchUrlsMatchSource,
  directItemWatchUrlSchema,
  isAllowedSourceUrl,
  monitorRuleSchema,
  previewItemWatchSchema,
  rakutenItemWatchUrlSchema,
  searchPreviewSchema,
  watchBindingSchema,
  watchProfileSchema,
} from "../packages/validation/src/index";
import { parseRakutenIchibaItemUrl, parseSourceItemUrl } from "@jpgr/core";
import { surugayaItemBodySchema, surugayaSearchBodySchema } from "../apps/mercari-service/src/schemas";
import { notificationColumns } from "../apps/web/src/lib/monitoring";
import { monitorRuleNeedsNewListingCandidate } from "../apps/web/src/lib/monitor-rule-events";

describe("source URL allowlist", () => {
  it("accepts the canonical host for the matching source", () => {
    expect(isAllowedSourceUrl("rakuten_ichiba", "https://item.rakuten.co.jp/shop/item/")).toBe(true);
    expect(previewItemWatchSchema.safeParse({ source: "yahoo_shopping", sourceItemId: "shop_item", targetUrl: "https://store.shopping.yahoo.co.jp/shop/item.html", name: "item", identityScope: "catalog", availability: "available" }).success).toBe(true);
  });

  it.each([
    "http://127.0.0.1/admin",
    "https://169.254.169.254/latest/meta-data",
    "https://item.rakuten.co.jp.evil.example/item",
    "https://user:password@item.rakuten.co.jp/item",
    "https://item.rakuten.co.jp:8443/item",
  ])("rejects unsafe URL %s", (url) => {
    expect(isAllowedSourceUrl("rakuten_ichiba", url)).toBe(false);
  });

  it("rejects a valid platform URL assigned to the wrong source", () => {
    const parsed = watchBindingSchema.safeParse({ source: "rakuten_books", kind: "item", targetUrl: "https://item.rakuten.co.jp/shop/item/" });
    expect(parsed.success).toBe(false);
  });

  it("keeps patched binding URLs on the existing source", () => {
    expect(bindingPatchUrlsMatchSource("mercari_jp", { targetUrl: "https://jp.mercari.com/item/m12345678" })).toBe(true);
    expect(bindingPatchUrlsMatchSource("mercari_jp", { targetUrl: "https://item.rakuten.co.jp/shop/item/" })).toBe(false);
  });

  it("rejects duplicate search sources and out-of-range profile intervals", () => {
    expect(searchPreviewSchema.safeParse({
      query: "氷菓",
      sources: ["surugaya", "surugaya"],
      inStockOnly: false,
    }).success).toBe(false);
    expect(watchProfileSchema.safeParse({
      name: "氷菓",
      bindings: [{ source: "surugaya", kind: "keyword", query: "氷菓", intervalMinutes: 1_441 }],
    }).success).toBe(false);
  });

  it("accepts 30-minute schedules and rejects purpose/kind mismatches", () => {
    expect(watchBindingSchema.safeParse({
      source: "mercari_jp",
      kind: "keyword",
      monitoringPurpose: "keyword_new_listing",
      query: "雪ミク",
      intervalMinutes: 30,
    }).success).toBe(true);
    expect(watchBindingSchema.safeParse({
      source: "mercari_jp",
      kind: "keyword",
      monitoringPurpose: "item_price",
      query: "雪ミク",
      intervalMinutes: 30,
    }).success).toBe(false);
    expect(watchBindingSchema.safeParse({
      source: "mercari_jp",
      kind: "item",
      monitoringPurpose: "keyword_market",
      targetUrl: "https://jp.mercari.com/item/m12345678",
      intervalMinutes: 29,
    }).success).toBe(false);
  });

  it("extracts a stable Rakuten itemCode and discards tracking parameters", () => {
    const parsed = parseRakutenIchibaItemUrl(
      "https://item.rakuten.co.jp/gscraft/n0066/?s-id=rk_shop_pc_rnkInShop",
    );
    expect(parsed).toEqual({
      sourceId: "rakuten_ichiba",
      sourceItemId: "gscraft:n0066",
      canonicalUrl: "https://item.rakuten.co.jp/gscraft/n0066/",
    });
    expect(rakutenItemWatchUrlSchema.parse({
      targetUrl: "https://item.rakuten.co.jp/gscraft/n0066/?s-id=tracking",
    })).toMatchObject({ intervalMinutes: 30 });
  });

  it.each([
    "https://item.rakuten.co.jp/gscraft/n0066/extra/",
    "https://item.rakuten.co.jp.evil.example/gscraft/n0066/",
    "https://user:password@item.rakuten.co.jp/gscraft/n0066/",
    "https://item.rakuten.co.jp/gscraft/n0066%2Fescape/",
    "http://item.rakuten.co.jp/gscraft/n0066/",
  ])("rejects a non-canonical Rakuten item URL %s", (url) => {
    expect(parseRakutenIchibaItemUrl(url)).toBeNull();
    expect(rakutenItemWatchUrlSchema.safeParse({ targetUrl: url }).success).toBe(false);
  });

  it.each([
    [
      "https://jp.mercari.com/item/m53125261416?utm_source=share",
      { sourceId: "mercari_jp", sourceItemId: "m53125261416", canonicalUrl: "https://jp.mercari.com/item/m53125261416" },
    ],
    [
      "https://paypayfleamarket.yahoo.co.jp/item/z670805040?cpt_s=share",
      { sourceId: "yahoo_fleamarket_jp", sourceItemId: "z670805040", canonicalUrl: "https://paypayfleamarket.yahoo.co.jp/item/z670805040" },
    ],
    [
      "https://auctions.yahoo.co.jp/jp/auction/x1242298276",
      { sourceId: "yahoo_auctions_jp", sourceItemId: "x1242298276", canonicalUrl: "https://auctions.yahoo.co.jp/jp/auction/x1242298276" },
    ],
    [
      "https://www.amazon.co.jp/example/dp/B0HGLQYN3P/ref=share",
      { sourceId: "amazon_jp", sourceItemId: "B0HGLQYN3P", canonicalUrl: "https://www.amazon.co.jp/dp/B0HGLQYN3P" },
    ],
    [
      "https://www.suruga-ya.jp/product/detail/992296489?tenpo_cd=400",
      { sourceId: "surugaya", sourceItemId: "992296489", canonicalUrl: "https://www.suruga-ya.jp/product/detail/992296489" },
    ],
    [
      "https://www.animate-onlineshop.jp/pn/test/pd/1234567/",
      { sourceId: "animate", sourceItemId: "1234567", canonicalUrl: "https://www.animate-onlineshop.jp/pn/_/pd/1234567/" },
    ],
    [
      "https://www.cospa.com/nijigencospa/detail/id/123456/?share=1",
      { sourceId: "cospa", sourceItemId: "123456", canonicalUrl: "https://www.cospa.com/nijigencospa/detail/id/123456" },
    ],
    [
      "https://charaon.jp/SHOP/ABC_123.html?tracking=1",
      { sourceId: "charaon", sourceItemId: "ABC_123", canonicalUrl: "https://www.charaon.jp/SHOP/ABC_123.html" },
    ],
  ])("recognizes a supported direct item URL %s", (url, expected) => {
    expect(parseSourceItemUrl(url)).toEqual(expected);
    expect(directItemWatchUrlSchema.safeParse({ targetUrl: url }).success).toBe(true);
  });

  it.each([
    "https://jp.mercari.com.evil.example/item/m53125261416",
    "https://user:password@jp.mercari.com/item/m53125261416",
    "https://jp.mercari.com/item/m53125261416/extra",
    "https://jp.mercari.com/item/m53125261416%2Fescape",
    "http://jp.mercari.com/item/m53125261416",
    "https://shopping.yahoo.co.jp/product/example",
  ])("rejects an unsupported or unsafe direct item URL %s", (url) => {
    expect(parseSourceItemUrl(url)).toBeNull();
    expect(directItemWatchUrlSchema.safeParse({ targetUrl: url }).success).toBe(false);
  });

  it("keeps exact-product dossiers separate and requires a stable product fingerprint", () => {
    const exactBinding = {
      source: "mercari_jp" as const,
      kind: "keyword" as const,
      monitoringPurpose: "keyword_new_listing" as const,
      query: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
      intervalMinutes: 1_440,
      sourceConfig: {
        searchMode: "exact_product",
        productTarget: {
          canonicalName: "雪ミク SNOW MIKU 限定ネックストラップ HAC JAL 青",
          characters: ["雪ミク"],
          aliases: [],
          excludedTerms: [],
        },
      },
    };
    expect(watchProfileSchema.safeParse({
      name: "雪ミク同款",
      dossierKind: "exact_product",
      offerTrackingPolicy: "all_confirmed_offers",
      knownOffers: [{ source: "mercari_jp", sourceItemId: "m12345678" }],
      bindings: [exactBinding],
    }).success).toBe(true);
    expect(watchProfileSchema.safeParse({
      name: "缺少指纹",
      dossierKind: "exact_product",
      bindings: [{ ...exactBinding, sourceConfig: { searchMode: "exact_product" } }],
    }).success).toBe(false);
    expect(watchProfileSchema.safeParse({
      name: "混合档案",
      bindings: [exactBinding, { source: "surugaya", kind: "keyword", query: "雪ミク" }],
    }).success).toBe(false);
    expect(watchProfileSchema.safeParse({
      name: "关键词不能持续跟踪候选",
      offerTrackingPolicy: "all_confirmed_offers",
      bindings: [{ source: "surugaya", kind: "keyword", query: "雪ミク" }],
    }).success).toBe(false);
  });

  it("forces data-only monitoring to remain notification-free", () => {
    expect(notificationColumns("keyword_market", {
      notifyNewListing: true,
      notifyPriceDrop: true,
      notifyRestock: true,
      notifySoldOut: true,
    })).toEqual({
      notifyNewListing: 0,
      notifyPriceDrop: 0,
      notifyRestock: 0,
      notifySoldOut: 0,
    });
  });

  it("alerts on price drops of already-confirmed exact-product offers by default", () => {
    expect(notificationColumns("keyword_new_listing", {}, { exactProduct: true })).toEqual({
      notifyNewListing: 1,
      notifyPriceDrop: 1,
      notifyRestock: 0,
      notifySoldOut: 0,
    });
  });
});

describe("monitor rule contract", () => {
  const baseRule = {
    eventTypes: ["product.new_comparable_offer"] as const,
    sourceAllow: [],
    sourceDeny: [],
    conditions: [],
    completeness: [],
    targetListingPrice: null,
    deliveryMode: "digest" as const,
    quietHours: null,
    timezone: "Asia/Tokyo" as const,
    dedupeWindowMinutes: 1_440,
    cooldownMinutes: 180,
    staleSourcePolicy: "annotate" as const,
    enabled: true,
  };

  it("requires a target when the listing-price threshold event is enabled", () => {
    expect(monitorRuleSchema.safeParse({
      ...baseRule,
      eventTypes: ["product.offer_below_target_listing_price"],
    }).success).toBe(false);
    expect(monitorRuleSchema.safeParse({
      ...baseRule,
      eventTypes: ["product.offer_below_target_listing_price"],
      targetListingPrice: 3_800,
    }).success).toBe(true);
  });

  it("queues new candidates for target-only exact-product rules", () => {
    expect(monitorRuleNeedsNewListingCandidate([
      "product.offer_below_target_listing_price",
    ])).toBe(true);
    expect(monitorRuleNeedsNewListingCandidate([
      "product.offer_below_target_landed_cost",
    ])).toBe(true);
  });

  it("requires both a target and a pinned cost profile for landed-cost alerts", () => {
    const missingProfile = monitorRuleSchema.safeParse({
      ...baseRule,
      eventTypes: ["product.offer_below_target_landed_cost"],
      targetLandedCost: 5_000,
    });
    expect(missingProfile.success).toBe(false);
    if (!missingProfile.success) {
      expect(missingProfile.error.issues.some((issue) => issue.path.includes("costProfileId"))).toBe(true);
    }
    expect(monitorRuleSchema.safeParse({
      ...baseRule,
      eventTypes: ["product.offer_below_target_landed_cost"],
      targetLandedCost: 5_000,
      costProfileId: "cp_test-v1",
    }).success).toBe(true);
  });
});

describe("fixed-purpose Surugaya service input", () => {
  it("accepts only bounded search options", () => {
    expect(surugayaSearchBodySchema.safeParse({
      query: "千反田える",
      filters: { page: 1, pageSize: 30, sort: "newest" },
      sourceConfig: { pages: 2, includeMarketplace: false, pageToken: "2" },
    }).success).toBe(true);
    expect(surugayaSearchBodySchema.safeParse({
      query: "千反田える",
      filters: {},
      sourceConfig: { pages: 3 },
    }).success).toBe(false);
    expect(surugayaSearchBodySchema.safeParse({
      query: "千反田える",
      filters: {},
      sourceConfig: { pageToken: "3" },
    }).success).toBe(false);
    expect(surugayaSearchBodySchema.safeParse({
      query: "千反田える",
      filters: {},
      sourceConfig: { targetUrl: "https://example.com/" },
    }).success).toBe(false);
  });

  it.each([
    "https://example.com/product/detail/123",
    "http://www.suruga-ya.jp/product/detail/123",
    "https://user:pass@www.suruga-ya.jp/product/detail/123",
    "https://www.suruga-ya.jp/search?search_word=test",
  ])("rejects a non-canonical item target %s", (url) => {
    expect(surugayaItemBodySchema.safeParse({ urlOrId: url }).success).toBe(false);
  });

  it("accepts an official item ID or canonical item URL", () => {
    expect(surugayaItemBodySchema.safeParse({ urlOrId: "123456789" }).success).toBe(true);
    expect(surugayaItemBodySchema.safeParse({ urlOrId: "https://www.suruga-ya.jp/product/detail/123456789" }).success).toBe(true);
  });
});

describe("Rakuten Web Service compliance surface", () => {
  it("keeps the official credit snippet byte-for-byte in the dedicated component", () => {
    const source = readFileSync("apps/web/src/components/rakuten-credit.tsx", "utf8");
    const snippet = `<!-- Rakuten Web Services Attribution Snippet FROM HERE -->
<a href="https://webservice.rakuten.co.jp/" target="_blank"><img src="https://webservice.rakuten.co.jp/img/credit/200709/credit_22121.gif" border="0" alt="Rakuten Web Service Center" title="Rakuten Web Service Center" width="221" height="21"/></a>
<!-- Rakuten Web Services Attribution Snippet TO HERE -->`;
    expect(source.replace(/\r\n/g, "\n")).toContain(snippet);
  });

  it("keeps public Rakuten results read-only and source-grouped", () => {
    const source = readFileSync("apps/web/src/components/public-rakuten-results.tsx", "utf8");
    expect(source).toContain("groups.map");
    expect(source).toContain("RakutenCredit");
    expect(source).not.toContain("watchItem");
    expect(source).not.toContain("yahoo_shopping");
  });
});
