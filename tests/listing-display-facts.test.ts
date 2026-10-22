import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "../packages/core/src";
import { productFactsSchema, searchResultSchema } from "../packages/validation/src";
import { listingDisplayFactRows } from "../apps/web/src/lib/listing-display-facts";

const listing = {
  sourceId: "yahoo_shopping",
  sourceItemId: "store_item-code",
  identityScope: "listing",
  canonicalUrl: "https://store.shopping.yahoo.co.jp/store/item-code.html",
  title: "商品标题",
  shopName: "示例店铺",
  currency: "JPY",
  currentPrice: 5_162,
  priceBasis: "listing_price",
  condition: "unknown",
  availability: "unknown",
  facts: {
    identifiers: { jan: "4900000000000", isbn: "9784040000000", sku: "sku-01" },
    brand: "示例品牌",
    categoryPath: ["文房具", "ステーショナリー"],
    specifications: [
      { name: "尺寸", value: "A4" },
      { name: "材质", value: "纸" },
    ],
    displayFacts: [
      { key: "delivery", label: "配送信息", group: "shipping", kind: "list", values: ["最短翌日配送", "送料無料"] },
      { key: "review", label: "商品评价", group: "commerce", kind: "text", value: "平均 4.6 · 128 件评价" },
    ],
    sourceConditionLabel: "中古（やや傷や汚れあり）",
  },
  rawMetadata: {
    upstreamPayload: "must-not-render",
    parserVersion: "fixture-v1",
  },
} satisfies NormalizedListing;

describe("source-independent listing display facts", () => {
  it("renders every canonical and adapter-approved fact without enumerating raw metadata", () => {
    const rows = listingDisplayFactRows(listing);
    const rendered = Object.fromEntries(rows.map((row) => [row.label, row.value]));

    expect(rendered).toMatchObject({
      "来源商品 ID": "store_item-code",
      "JAN 代码": "4900000000000",
      "ISBN 代码": "9784040000000",
      SKU: "sku-01",
      商品分类: "文房具 / ステーショナリー",
      配送信息: "最短翌日配送 · 送料無料",
      商品评价: "平均 4.6 · 128 件评价",
      尺寸: "A4",
      材质: "纸",
      来源品相原文: "中古（やや傷や汚れあり）",
    });
    expect(rows.map((row) => row.value).join(" ")).not.toContain("must-not-render");
    expect(rows.map((row) => row.value).join(" ")).not.toContain("fixture-v1");
  });

  it("survives the strict search-result boundary", () => {
    expect(searchResultSchema.safeParse({
      sourceId: "yahoo_shopping",
      listings: [listing],
      coverage: "rolling_window",
      warnings: [],
      parserVersion: "fixture-v1",
      fetchedAt: "2026-07-14T00:00:00.000Z",
    }).success).toBe(true);
  });

  it("accepts bounded display facts and rejects duplicate keys or arbitrary fields", () => {
    expect(productFactsSchema.safeParse(listing.facts).success).toBe(true);

    const duplicateKeys = {
      displayFacts: [
        { key: "delivery", label: "配送", group: "shipping", kind: "text", value: "翌日" },
        { key: "delivery", label: "配送补充", group: "shipping", kind: "text", value: "免费" },
      ],
    };
    expect(productFactsSchema.safeParse(duplicateKeys).success).toBe(false);
    expect(productFactsSchema.safeParse({
      displayFacts: [{ key: "unsafe", label: "不安全字段", group: "other", kind: "text", value: "x", html: "<b>x</b>" }],
    }).success).toBe(false);
  });
});
