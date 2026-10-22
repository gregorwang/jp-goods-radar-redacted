import { describe, expect, it } from "vitest";
import { parseEventPayload, presentEvent } from "../apps/web/src/lib/event-presentation";

describe("event presentation", () => {
  it("uses the immutable price-drop payload instead of the listing's later current price", () => {
    const presentation = presentEvent("price_drop", JSON.stringify({
      oldPrice: 2_400,
      newPrice: 1_980,
      dropAmount: 420,
    }));

    expect(presentation).toMatchObject({
      label: "价格下降",
      headline: "￥2,400 → ￥1,980",
      detail: "确认下降 ￥420",
      eventPrice: 1_980,
      tone: "price",
    });
  });

  it("describes source failures with their source identity and bounded evidence", () => {
    const presentation = presentEvent("source_error", JSON.stringify({
      sourceId: "mercari_jp",
      code: "upstream_403",
      message: "上游暂时拒绝请求",
      failures: 3,
    }), "Mercari 日本站（实验）");

    expect(presentation).toMatchObject({
      label: "来源异常",
      headline: "Mercari 日本站（实验） 暂时异常",
      detail: "上游暂时拒绝请求 · 连续失败 3 次",
      tone: "system",
    });
  });

  it("keeps malformed payloads truthful instead of inventing a price", () => {
    expect(parseEventPayload("not-json")).toEqual({});
    expect(presentEvent("new_listing", "not-json")).toMatchObject({
      headline: "首次发现新商品",
      detail: "来源暂未提供可确认价格",
      eventPrice: null,
    });
  });

  it("presents a price rise as an increase rather than a negative drop", () => {
    expect(presentEvent("price_rise", JSON.stringify({
      oldPrice: 2_400,
      newPrice: 2_980,
      riseAmount: 580,
    }))).toMatchObject({
      label: "价格上涨",
      headline: "￥2,400 → ￥2,980",
      detail: "确认上涨 ￥580",
      eventPrice: 2_980,
    });
  });

  it("labels a keyword scan digest as one merged delivery unit", () => {
    expect(presentEvent("daily_digest", JSON.stringify({ kind: "keyword_new_listing", total: 12 }))).toMatchObject({
      label: "上新摘要",
      headline: "本次关键词巡回已合并发送",
      detail: "12 件新商品已整理为一封摘要",
      tone: "digest",
    });
  });

  it("labels an initial keyword baseline as completion rather than new listings", () => {
    expect(presentEvent("daily_digest", JSON.stringify({
      kind: "keyword_initial_baseline",
      total: 42,
      baselineTotal: 42,
    }))).toMatchObject({
      label: "首次巡回摘要",
      headline: "关键词巡回基线已建立",
      detail: "首次收录 42 件，后续上新将单独识别",
      tone: "digest",
    });
  });

  it("separates source baselines and recovered listings in corrected history", () => {
    expect(presentEvent("daily_digest", JSON.stringify({
      kind: "keyword_scan_summary", total: 53, newTotal: 18, recoveredTotal: 34, baselineTotal: 1,
    }))).toMatchObject({ detail: "首次发现 18 件 · 恢复识别 34 件 · 来源基线 1 件" });
    expect(presentEvent("new_listing", JSON.stringify({ discoveryKind: "recovered_match" })))
      .toMatchObject({ label: "恢复识别", headline: "此前已采集的商品通过筛选" });
    expect(presentEvent("source_error", JSON.stringify({ code: "keyword_rules_excluded_all", sourceId: "rakuten_ichiba" })))
      .toMatchObject({ label: "筛选结果", tone: "neutral" });
  });

  it("labels an exact-product digest as confirmed same-item discoveries", () => {
    expect(presentEvent("daily_digest", JSON.stringify({ kind: "exact_product_new_listing", total: 3 }))).toMatchObject({
      label: "同款上新摘要",
      headline: "本次精确同款巡回已合并发送",
      detail: "3 件确认同款已整理为一封摘要",
      tone: "digest",
    });
  });

  it("presents a weekly exact-product health and market report", () => {
    expect(presentEvent("weekly_market_digest", JSON.stringify({
      profileName: "メダリスト展 アートブック",
      listings: { available: 8, belowThreshold: 1 },
    }))).toMatchObject({
      label: "每周市场总结",
      headline: "メダリスト展 アートブック 的任务与行情周报",
      detail: "当前在售 8 件 · 目标价内 1 件",
      tone: "digest",
    });
  });

  it("renders a landed-cost hit from its immutable range and pinned profile", () => {
    expect(presentEvent("product.offer_below_target_landed_cost", JSON.stringify({
      targetLandedCostJpy: 5_600,
      landedCostJpy: { min: 4_600, max: 5_600 },
      costProfileVersion: 3,
    }))).toMatchObject({
      label: "到手价命中",
      headline: "估算上界不高于 ￥5,600",
      detail: "￥4,600–￥5,600 · 成本档案 v3 · 按上界保守判断",
      eventPrice: 5_600,
      tone: "positive",
    });
  });

  it("renders digest aggregation as delivery evidence rather than a product change", () => {
    expect(presentEvent("daily_digest", JSON.stringify({ total: 17 }))).toMatchObject({
      label: "每日摘要",
      headline: "变化已整理为每日摘要",
      detail: "17 条变化被整理为一封摘要",
      tone: "digest",
    });
  });

  it("explains automatic completion without presenting it as a failure", () => {
    expect(presentEvent("watch_completed", JSON.stringify({
      profileName: "Mercari 限定徽章",
      terminalDays: 7,
    }))).toMatchObject({
      label: "监控完成",
      headline: "Mercari 限定徽章 已自动结束",
      detail: "挂牌已连续 7 天处于终局状态，历史记录已保留",
      tone: "digest",
    });
  });

  it("presents the JST morning digest as an active summary", () => {
    expect(presentEvent("morning_digest", JSON.stringify({
      day: "2026-07-26",
      total: 18,
    }))).toMatchObject({
      label: "早间摘要",
      headline: "2026-07-26 雷达晨报",
      detail: "昨日 18 条变化已主动汇总",
      tone: "digest",
    });
  });
});
