import { describe, expect, it } from "vitest";
import { currentTargetPriceEvent, evaluateListingEvents } from "@jpgr/core";

const base = {
  bindingId: "binding-1", listingId: "listing-1", baselineCompleted: true, notifyInitial: false,
  notifyPriceDrop: true, notifyRestock: true, notifySoldOut: false, minDropAmount: 100,
} as const;

describe("evaluateListingEvents", () => {
  it("marks recovered keyword matches without changing baseline notification gates", () => {
    const input = { ...base, current: { price: 1000, availability: "available" as const }, isNewMatch: true, recoveredMatch: true };
    expect(evaluateListingEvents(input)).toEqual([expect.objectContaining({
      type: "new_listing", payload: expect.objectContaining({ discoveryKind: "recovered_match" }),
    })]);
    expect(evaluateListingEvents({ ...input, baselineCompleted: false })).toEqual([]);
  });

  it("当前商品簇命中同一目标价时生成一次稳定事件", () => {
    expect(currentTargetPriceEvent({
      bindingId: "binding-1",
      listingId: "listing-1",
      currentPrice: 4_500,
      previousPrice: 4_500,
      targetPrice: 4_500,
    })).toEqual({
      type: "target_price",
      eventKey: "target_price:binding-1:listing-1:4500:first_confirmed_hit",
      payload: {
        oldPrice: 4_500,
        newPrice: 4_500,
        targetPrice: 4_500,
        firstConfirmedHit: true,
      },
    });
  });

  it("首次基线不发送新商品事件", () => {
    const events = evaluateListingEvents({ ...base, baselineCompleted: false, previous: undefined, current: { price: 5000, availability: "available" } });
    expect(events).toEqual([]);
  });

  it("链接库存监控首次检查已经有货时生成一次稳定通知", () => {
    const events = evaluateListingEvents({
      ...base,
      baselineCompleted: false,
      notifyInitial: true,
      notifyNewListing: false,
      previous: undefined,
      current: { price: 5_000, availability: "available" },
    });
    expect(events).toEqual([{
      type: "restock",
      eventKey: "restock:binding-1:listing-1:initial_available",
      payload: {
        previousAvailability: "unknown",
        currentAvailability: "available",
        initialObservation: true,
      },
    }]);
  });

  it("解析状态从未知恢复为有货时不冒充补货", () => {
    const events = evaluateListingEvents({
      ...base,
      previous: { availability: "unknown" },
      current: { availability: "available" },
    });
    expect(events).toEqual([]);
  });

  it("链接库存监控首次检查无货时只建立基线", () => {
    expect(evaluateListingEvents({
      ...base,
      baselineCompleted: false,
      notifyInitial: true,
      notifyNewListing: false,
      previous: undefined,
      current: { price: 5_000, availability: "sold_out" },
    })).toEqual([]);
  });

  it("基线完成后发现新商品只生成稳定事件 key", () => {
    const events = evaluateListingEvents({ ...base, previous: undefined, current: { price: 5000, availability: "available" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKey).toBe("new_listing:binding-1:listing-1:first_seen");
  });

  it("按关键词绑定判断新匹配，而不是按全库商品是否已存在", () => {
    const events = evaluateListingEvents({
      ...base,
      isNewMatch: true,
      previous: { price: 5000, availability: "available" },
      current: { price: 5000, availability: "available" },
    });
    expect(events.map((event) => event.type)).toEqual(["new_listing"]);
  });

  it("行情积累和单品监控可明确关闭新品事件", () => {
    const events = evaluateListingEvents({
      ...base,
      isNewMatch: true,
      notifyNewListing: false,
      previous: undefined,
      current: { price: 5000, availability: "available" },
    });
    expect(events).toEqual([]);
  });

  it("首次观察到历史售罄商品时不生成新商品事件", () => {
    const events = evaluateListingEvents({
      ...base,
      previous: undefined,
      current: { price: 1_222, availability: "sold_out" },
    });
    expect(events).toEqual([]);
  });

  it("第一次发现降价时不生成事件", () => {
    const events = evaluateListingEvents({ ...base, previous: { price: 5000, availability: "available" }, current: { price: 4800, availability: "available" } });
    expect(events.some((event) => event.type === "price_drop")).toBe(false);
  });

  it("二次确认后按价格转移与小时桶生成稳定降价事件 key", () => {
    const events = evaluateListingEvents({ ...base, priceDropConfirmed: true, observedAt: "2026-07-26T10:23:45.000Z", previous: { price: 5000, availability: "available" }, current: { price: 4800, availability: "available" } });
    expect(events.find((event) => event.type === "price_drop")?.eventKey).toBe("price_drop:binding-1:listing-1:5000->4800@2026-07-26T10");
  });

  it("同一转移在同一小时桶内幂等，跨小时桶可重新发生", () => {
    const at = (observedAt: string) => evaluateListingEvents({
      ...base, priceDropConfirmed: true, observedAt,
      previous: { price: 5000, availability: "available" },
      current: { price: 4000, availability: "available" },
    }).find((event) => event.type === "price_drop")?.eventKey;
    expect(at("2026-07-26T10:05:00.000Z")).toBe(at("2026-07-26T10:55:00.000Z"));
    expect(at("2026-07-26T10:05:00.000Z")).not.toBe(at("2026-07-26T14:05:00.000Z"));
  });

  it("同价位的重复补货循环跨小时桶后仍可再次通知", () => {
    const restockKey = (observedAt: string) => evaluateListingEvents({
      ...base, observedAt,
      previous: { price: 5000, availability: "sold_out" },
      current: { price: 5000, availability: "available" },
    }).find((event) => event.type === "restock")?.eventKey;
    expect(restockKey("2026-07-26T09:00:00.000Z")).toBeDefined();
    expect(restockKey("2026-07-26T09:00:00.000Z")).not.toBe(restockKey("2026-07-27T09:00:00.000Z"));
  });

  it("涨价按同一价格通知门槛生成独立事件，未达到最小降幅仍不发降价事件", () => {
    expect(evaluateListingEvents({
      ...base,
      notifyPriceRise: true,
      priceDropConfirmed: true,
      previous: { price: 5000, availability: "available" },
      current: { price: 5100, availability: "available" },
    })).toMatchObject([{
      type: "price_rise",
      payload: { oldPrice: 5000, newPrice: 5100, riseAmount: 100 },
    }]);
    expect(evaluateListingEvents({ ...base, priceDropConfirmed: true, previous: { price: 5000, availability: "available" }, current: { price: 4950, availability: "available" } })).toEqual([]);
  });

  it("二次确认跨过目标价时以目标阈值、新价与小时桶作为幂等键", () => {
    const events = evaluateListingEvents({ ...base, priceDropConfirmed: true, targetPrice: 4500, observedAt: "2026-07-26T10:23:45.000Z", previous: { price: 5000, availability: "available" }, current: { price: 4400, availability: "available" } });
    expect(events.find((event) => event.type === "target_price")?.eventKey).toBe("target_price:binding-1:listing-1:4500:4400@2026-07-26T10");
  });

  it("从售罄恢复可用时生成补货事件", () => {
    const events = evaluateListingEvents({ ...base, previous: { price: 5000, availability: "sold_out" }, current: { price: 5000, availability: "available" } });
    expect(events.map((event) => event.type)).toContain("restock");
  });

  it("搜索结果消失本身不会创建售罄事件", () => {
    expect(evaluateListingEvents({ ...base, previous: { price: 5000, availability: "available" }, current: { price: 5000, availability: "unknown" } })
      .some((event) => event.type === "sold_out")).toBe(false);
  });

  it("最小降幅为零时仍要求价格真实下降", () => {
    expect(evaluateListingEvents({
      ...base,
      minDropAmount: 0,
      priceDropConfirmed: true,
      previous: { price: 5000, availability: "available" },
      current: { price: 5000, availability: "available" },
    })).toEqual([]);
  });

  it("详情页明确售罄时从可购状态生成售出事件", () => {
    const events = evaluateListingEvents({
      ...base,
      notifySoldOut: true,
      previous: { price: 5000, availability: "preorder" },
      current: { price: 5000, availability: "sold_out" },
      observedAt: "2026-08-21T05:20:00.000Z",
    });
    expect(events).toMatchObject([{
      type: "sold_out",
      payload: { previousAvailability: "preorder", currentAvailability: "sold_out" },
    }]);
  });

  it("连续缺失经确认后生成下架事件，单次未知状态仍不生成", () => {
    const input = {
      ...base,
      notifySoldOut: true,
      previous: { price: 5000, availability: "available" as const },
      current: { price: 5000, availability: "unavailable" as const },
    };
    expect(evaluateListingEvents(input)).toEqual([]);
    expect(evaluateListingEvents({ ...input, availabilityChangeConfirmed: true })).toMatchObject([{
      type: "sold_out",
      payload: {
        previousAvailability: "available",
        currentAvailability: "unavailable",
        inference: "confirmed_missing",
      },
    }]);
  });
});
