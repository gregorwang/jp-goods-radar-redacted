import { describe, expect, it } from "vitest";
import { canCreateItemPriceWatch, isTerminalItemWatchAvailability, restockOnlyItemWatch } from "@jpgr/core";
import { watchSourcesForPreset } from "../apps/web/src/lib/watch-source-presets";

describe("item price watch semantics", () => {
  it("rejects terminal one-off listing states", () => {
    expect(isTerminalItemWatchAvailability("sold_out")).toBe(true);
    expect(isTerminalItemWatchAvailability("trading")).toBe(true);
    expect(canCreateItemPriceWatch("sold_out", "listing", "mercari_jp")).toBe(false);
    expect(canCreateItemPriceWatch("trading", "listing", "mercari_jp")).toBe(false);
    expect(canCreateItemPriceWatch("sold_out", "offer", "yahoo_auctions_jp")).toBe(false);
    expect(canCreateItemPriceWatch("sold_out", "listing", "yahoo_fleamarket_jp")).toBe(false);
  });

  it("keeps restock and price-monitorable states available", () => {
    expect(canCreateItemPriceWatch("available", "listing", "mercari_jp")).toBe(true);
    expect(canCreateItemPriceWatch("preorder", "listing", "surugaya")).toBe(true);
    expect(canCreateItemPriceWatch("backorder", "listing", "surugaya")).toBe(true);
    expect(canCreateItemPriceWatch("unavailable", "listing", "mercari_jp")).toBe(true);
    expect(canCreateItemPriceWatch("unknown", "listing", "mercari_jp")).toBe(true);
    expect(canCreateItemPriceWatch("sold_out", "catalog", "animate")).toBe(true);
  });

  it("允许为售罄的商家商品建补货监控，这是产品承诺的核心场景", () => {
    // 骏河屋中古与乐天店铺 SKU 会重新上架，售罄不是终局。
    expect(canCreateItemPriceWatch("sold_out", "listing", "surugaya")).toBe(true);
    expect(canCreateItemPriceWatch("sold_out", "listing", "rakuten_ichiba")).toBe(true);
    expect(canCreateItemPriceWatch("sold_out", "listing", "yahoo_shopping")).toBe(true);
    expect(canCreateItemPriceWatch("trading", "listing", "surugaya")).toBe(true);
  });

  it("售罄商家商品默认只开补货通知", () => {
    expect(restockOnlyItemWatch("sold_out", "surugaya")).toBe(true);
    expect(restockOnlyItemWatch("trading", "rakuten_ichiba")).toBe(true);
    // 一次性挂牌来源根本建不了这种监控，不需要该默认值。
    expect(restockOnlyItemWatch("sold_out", "mercari_jp")).toBe(false);
    // 在售商品保留完整的降价 + 补货语义。
    expect(restockOnlyItemWatch("available", "surugaya")).toBe(false);
  });
});

describe("watch source presets", () => {
  const choices = [
    { id: "animate" as const, adapter_available: true },
    { id: "mercari_jp" as const, adapter_available: true },
    { id: "yahoo_auctions_jp" as const, adapter_available: true },
    { id: "rakuten_ichiba" as const, adapter_available: true },
    { id: "surugaya" as const, adapter_available: false },
  ];

  it("keeps official retail out of the resale-first preset", () => {
    expect(watchSourcesForPreset(choices, "resale")).toEqual(["mercari_jp", "yahoo_auctions_jp"]);
  });

  it("keeps resale marketplaces out of the retail preset", () => {
    expect(watchSourcesForPreset(choices, "retail")).toEqual(["animate", "rakuten_ichiba"]);
  });
});
