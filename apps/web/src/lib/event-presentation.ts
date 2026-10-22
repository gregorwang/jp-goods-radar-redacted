import { formatJpy } from "@jpgr/core";

export const PRODUCT_EVENT_TYPES = [
  "new_listing",
  "price_drop",
  "price_rise",
  "interest_rise",
  "target_price",
  "restock",
  "sold_out",
] as const;

export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];

export interface EventPresentation {
  label: string;
  headline: string;
  detail: string;
  eventPrice: number | null;
  tone: "discovery" | "price" | "positive" | "negative" | "system" | "digest" | "neutral";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function money(value: number | null): string {
  return value === null ? "价格待确认" : formatJpy(value);
}

function availabilityLabel(value: unknown): string {
  const labels: Record<string, string> = {
    available: "在售",
    sold_out: "已售出",
    unavailable: "当前不可购买",
    preorder: "预售",
    backorder: "等待补货",
    unknown: "库存未确认",
  };
  const key = stringValue(value);
  return key ? labels[key] ?? key : "状态未记录";
}

export function parseEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    return record(JSON.parse(payloadJson) as unknown) ?? {};
  } catch {
    return {};
  }
}

export function presentEvent(
  eventType: string,
  payloadJson: string,
  sourceDisplayName?: string | null,
  dossierKind?: "item" | "exact_product" | "keyword" | null,
): EventPresentation {
  const payload = parseEventPayload(payloadJson);

  if (eventType === "new_listing" || eventType === "product.new_comparable_offer") {
    const current = record(payload.current);
    const eventPrice = numberValue(current?.price);
    // 关键词雷达和精确同款雷达共用这个事件；只有精确同款雷达的才叫「确认同款」。
    const exactOffer = eventType === "product.new_comparable_offer" && dossierKind === "exact_product";
    return {
      label: payload.discoveryKind === "recovered_match" ? "恢复识别" : exactOffer ? "确认同款新报价" : "新商品",
      headline: payload.discoveryKind === "recovered_match" ? "此前已采集的商品通过筛选" : exactOffer ? "首次发现新的确认同款" : "首次发现新商品",
      detail: payload.discoveryKind === "recovered_match" ? "保留此前采集历史，本次不计为首次发现" : eventPrice === null ? "来源暂未提供可确认价格" : `首次发现价 ${money(eventPrice)}`,
      eventPrice,
      tone: "discovery",
    };
  }

  if (eventType === "price_drop" || eventType === "price_rise" || eventType === "listing.price_changed") {
    const oldPrice = numberValue(payload.oldPrice);
    const newPrice = numberValue(payload.newPrice);
    const rising = eventType === "price_rise"
      || (oldPrice !== null && newPrice !== null && newPrice > oldPrice);
    const changeAmount = rising
      ? numberValue(payload.riseAmount) ?? (oldPrice !== null && newPrice !== null ? newPrice - oldPrice : null)
      : numberValue(payload.dropAmount) ?? (oldPrice !== null && newPrice !== null ? oldPrice - newPrice : null);
    return {
      label: eventType === "listing.price_changed" ? "确认价格变化" : rising ? "价格上涨" : "价格下降",
      headline: oldPrice !== null && newPrice !== null
        ? `${money(oldPrice)} → ${money(newPrice)}`
        : rising ? "确认发生价格上涨" : "确认发生价格下降",
      detail: changeAmount !== null
        ? `确认${rising ? "上涨" : "下降"} ${money(Math.abs(changeAmount))}`
        : "事件价格证据不完整",
      eventPrice: newPrice,
      tone: "price",
    };
  }

  if (eventType === "interest_rise") {
    const before = (key: string) => numberValue(payload[key]);
    const parts = [
      ["评论", before("oldCommentCount"), before("newCommentCount")],
      ["点赞", before("oldLikeCount"), before("newLikeCount")],
    ] as const;
    const changes = parts
      .filter(([, from, to]) => from !== null && to !== null && to > from)
      .map(([name, from, to]) => `${name} ${from} → ${to}`);
    return {
      label: "有人盯上了",
      headline: changes.join("，") || "点赞或评论变多了",
      detail: "详情页里的点赞 / 评论数比上一次巡回时多",
      eventPrice: null,
      tone: "positive",
    };
  }

  if (eventType === "target_price" || eventType === "product.offer_below_target_listing_price") {
    const oldPrice = numberValue(payload.oldPrice);
    const newPrice = numberValue(payload.newPrice);
    const targetPrice = numberValue(payload.targetPrice);
    const transition = oldPrice !== null && newPrice !== null
      ? `${money(oldPrice)} → ${money(newPrice)}`
      : newPrice !== null ? `事件价格 ${money(newPrice)}` : "事件价格证据不完整";
    return {
      label: "达到目标价",
      headline: targetPrice === null ? "价格已进入目标范围" : `已到达目标价 ${money(targetPrice)}`,
      detail: transition,
      eventPrice: newPrice,
      tone: "positive",
    };
  }

  if (eventType === "product.offer_below_target_landed_cost") {
    const landed = record(payload.landedCostJpy);
    const landedMin = numberValue(landed?.min);
    const landedMax = numberValue(landed?.max);
    const target = numberValue(payload.targetLandedCostJpy);
    const profileVersion = numberValue(payload.costProfileVersion);
    const range = landedMin !== null && landedMax !== null
      ? landedMin === landedMax ? money(landedMin) : `${money(landedMin)}–${money(landedMax)}`
      : "到手成本区间证据不完整";
    return {
      label: "到手价命中",
      headline: target === null ? "到手成本区间进入目标范围" : `估算上界不高于 ${money(target)}`,
      detail: `${range}${profileVersion === null ? "" : ` · 成本档案 v${profileVersion}`} · 按上界保守判断`,
      eventPrice: landedMax,
      tone: "positive",
    };
  }

  if (eventType === "restock") {
    return {
      label: "恢复库存",
      headline: "商品恢复可购买",
      detail: `${availabilityLabel(payload.previousAvailability)} → ${availabilityLabel(payload.currentAvailability)}`,
      eventPrice: null,
      tone: "positive",
    };
  }

  if (eventType === "sold_out") {
    return {
      label: "已售出",
      headline: "商品已变为不可购买",
      detail: `${availabilityLabel(payload.previousAvailability)} → ${availabilityLabel(payload.currentAvailability ?? "sold_out")}`,
      eventPrice: null,
      tone: "negative",
    };
  }

  if (eventType === "listing.availability_changed") {
    const current = payload.currentAvailability ?? payload.availability;
    const sold = stringValue(current) === "sold_out" || stringValue(current) === "unavailable";
    return {
      label: "可购状态变化",
      headline: sold ? "商品已变为不可购买" : "商品可购状态已更新",
      detail: `${availabilityLabel(payload.previousAvailability)} → ${availabilityLabel(current)}`,
      eventPrice: null,
      tone: sold ? "negative" : "positive",
    };
  }

  if (eventType === "product.condition_match_seen") {
    return {
      label: "指定品相出现",
      headline: `出现符合品相的确认同款`,
      detail: stringValue(payload.condition) ? `品相：${stringValue(payload.condition)}` : "品相事实已命中当前规则",
      eventPrice: null,
      tone: "discovery",
    };
  }

  if (eventType === "product.complete_set_seen") {
    return {
      label: "完整套装出现",
      headline: "出现明确完整的确认同款",
      detail: "来源或清洗事实明确证明完整；未知完整度不会触发。",
      eventPrice: null,
      tone: "discovery",
    };
  }

  if (eventType === "source_error") {
    const source = sourceDisplayName || stringValue(payload.sourceId) || "未知来源";
    const message = stringValue(payload.message);
    const code = stringValue(payload.code);
    if (["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(code ?? "")) {
      return {
        label: "筛选结果",
        headline: `${source} 采集完成，本轮无匹配商品`,
        detail: message ?? "采集证据已保留，来源仍按计划巡回",
        eventPrice: null,
        tone: "neutral",
      };
    }
    const failures = numberValue(payload.failures);
    const evidence = [
      message || code || "来源巡回连续失败",
      failures === null ? null : `连续失败 ${failures} 次`,
    ].filter((item): item is string => item !== null);
    return {
      label: "来源异常",
      headline: `${source} 暂时异常`,
      detail: evidence.join(" · "),
      eventPrice: null,
      tone: "system",
    };
  }

  if (eventType === "watch_completed") {
    const terminalDays = numberValue(payload.terminalDays);
    const profileName = stringValue(payload.profileName);
    return {
      label: "监控完成",
      headline: profileName ? `${profileName} 已自动结束` : "一次性挂牌监控已自动结束",
      detail: terminalDays === null
        ? "挂牌持续处于终局状态，历史记录已保留"
        : terminalDays === 0
          ? "挂牌已售出，历史记录已保留"
          : `挂牌已连续 ${terminalDays} 天处于终局状态，历史记录已保留`,
      eventPrice: null,
      tone: "digest",
    };
  }

  if (eventType === "morning_digest") {
    const total = numberValue(payload.total);
    const day = stringValue(payload.day);
    return {
      label: "早间摘要",
      headline: day ? `${day} 雷达晨报` : "东京时间 09:00 雷达晨报",
      detail: total === null ? "昨日变化已主动汇总" : `昨日 ${total} 条变化已主动汇总`,
      eventPrice: null,
      tone: "digest",
    };
  }

  if (eventType === "weekly_market_digest") {
    const profileName = stringValue(payload.profileName);
    const listings = payload.listings && typeof payload.listings === "object" && !Array.isArray(payload.listings)
      ? payload.listings as Record<string, unknown>
      : {};
    const available = numberValue(listings.available);
    const belowThreshold = numberValue(listings.belowThreshold);
    return {
      label: "每周市场总结",
      headline: profileName ? `${profileName} 的任务与行情周报` : "精确同款雷达任务与行情周报",
      detail: available === null
        ? "本周采集健康与市场行情已汇总"
        : `当前在售 ${available} 件 · 目标价内 ${belowThreshold ?? 0} 件`,
      eventPrice: null,
      tone: "digest",
    };
  }

  if (eventType === "daily_digest") {
    const total = numberValue(payload.total);
    if (stringValue(payload.kind) === "keyword_scan_summary") {
      const newTotal = numberValue(payload.newTotal) ?? 0;
      const recoveredTotal = numberValue(payload.recoveredTotal) ?? 0;
      const baselineTotal = numberValue(payload.baselineTotal) ?? 0;
      return {
        label: "关键词巡回摘要",
        headline: "本次巡回已按商品发现情况汇总",
        detail: [`首次发现 ${newTotal} 件`,
          ...(recoveredTotal > 0 ? [`恢复识别 ${recoveredTotal} 件`] : []),
          ...(baselineTotal > 0 ? [`来源基线 ${baselineTotal} 件`] : []),
        ].join(" · "),
        eventPrice: null,
        tone: "digest",
      };
    }
    if (stringValue(payload.kind) === "keyword_initial_baseline") {
      const baselineTotal = numberValue(payload.baselineTotal) ?? total;
      return {
        label: "首次巡回摘要",
        headline: "关键词巡回基线已建立",
        detail: baselineTotal === null ? "已有商品已记录，后续上新将单独识别" : `首次收录 ${baselineTotal} 件，后续上新将单独识别`,
        eventPrice: null,
        tone: "digest",
      };
    }
    if (stringValue(payload.kind) === "exact_product_new_listing") {
      return {
        label: "同款上新摘要",
        headline: "本次精确同款巡回已合并发送",
        detail: total === null ? "确认同款已整理为一封摘要" : `${total} 件确认同款已整理为一封摘要`,
        eventPrice: null,
        tone: "digest",
      };
    }
    if (stringValue(payload.kind) === "keyword_new_listing") {
      return {
        label: "上新摘要",
        headline: "本次关键词巡回已合并发送",
        detail: total === null ? "新发现商品已整理为一封摘要" : `${total} 件新商品已整理为一封摘要`,
        eventPrice: null,
        tone: "digest",
      };
    }
    return {
      label: "每日摘要",
      headline: "变化已整理为每日摘要",
      detail: total === null ? "多条变化被整理为一封摘要" : `${total} 条变化被整理为一封摘要`,
      eventPrice: null,
      tone: "digest",
    };
  }

  return {
    label: "状态变化",
    headline: "记录了一条状态变化",
    detail: "该事件类型暂时没有专用展示说明",
    eventPrice: null,
    tone: "neutral",
  };
}
