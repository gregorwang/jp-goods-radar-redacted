import type { EventCandidate, ListingState } from "./types.js";

export interface EventEvaluationInput {
  bindingId: string;
  listingId: string;
  previous?: ListingState;
  current: ListingState;
  isNewMatch?: boolean;
  /** Previously collected evidence that only now passed keyword relevance. */
  recoveredMatch?: boolean;
  /**
   * 区分"来源上架时间确认是新上架"与"只是我们第一次看见"。
   * 只有来源返回 sourceListedAt 时前者才可判定；`recoveredMatch` 优先级更高。
   */
  discoveryKind?: "listed_new" | "newly_seen";
  baselineCompleted: boolean;
  notifyInitial: boolean;
  notifyNewListing?: boolean;
  notifyPriceDrop: boolean;
  /** Uses the legacy price-notification gate until watch settings are renamed. */
  notifyPriceRise?: boolean;
  notifyRestock: boolean;
  notifySoldOut: boolean;
  targetPrice?: number;
  minDropAmount: number;
  priceDropConfirmed?: boolean;
  /** 详情页明确返回不可购买，或连续两次 404 已完成业务确认。 */
  availabilityChangeConfirmed?: boolean;
  /** 本次观测时间（ISO）。事件 key 含其小时桶：同轮重试保持幂等，之后真实再次发生的同一转移可重新通知。 */
  observedAt?: string;
}

export function currentTargetPriceEvent(input: {
  bindingId: string;
  listingId: string;
  currentPrice: number;
  previousPrice?: number;
  targetPrice: number;
}): EventCandidate {
  return {
    type: "target_price",
    eventKey: `target_price:${input.bindingId}:${input.listingId}:${input.targetPrice}:first_confirmed_hit`,
    payload: {
      oldPrice: input.previousPrice ?? input.currentPrice,
      newPrice: input.currentPrice,
      targetPrice: input.targetPrice,
      firstConfirmedHit: true,
    },
  };
}

export interface ListingInterest {
  /** 煤炉 いいね / PayPayフリマ 收藏 / 雅虎拍卖 ウォッチ。 */
  likeCount?: number;
  commentCount?: number;
}

/**
 * 详情页里的热度：点赞或评论比上一次记下的多了，就是「有人盯上了」（2026-10-16 用户定）。
 * 只比两边都有的数；来源这次没给（undefined）不算变化。只在还能买的时候提醒——卖掉了另有售罄通知。
 * eventKey 带上新数值：同一个数只提醒一次，涨到下一个数再提醒。
 */
export function interestRiseEvent(input: {
  bindingId: string;
  listingId: string;
  previous: ListingInterest;
  current: ListingInterest;
  availability: ListingState["availability"];
}): EventCandidate | undefined {
  if (!["available", "preorder", "backorder"].includes(input.availability)) return undefined;
  const rose = (key: keyof ListingInterest) => {
    const before = input.previous[key];
    const after = input.current[key];
    return before !== undefined && after !== undefined && after > before;
  };
  const likesRose = rose("likeCount");
  const commentsRose = rose("commentCount");
  if (!likesRose && !commentsRose) return undefined;
  const { likeCount, commentCount } = input.current;
  return {
    type: "interest_rise",
    eventKey: `interest_rise:${input.bindingId}:${input.listingId}:${likeCount ?? "-"}:${commentCount ?? "-"}`,
    payload: {
      oldLikeCount: input.previous.likeCount,
      newLikeCount: likeCount,
      oldCommentCount: input.previous.commentCount,
      newCommentCount: commentCount,
      likesRose,
      commentsRose,
    },
  };
}

export function evaluateListingEvents(input: EventEvaluationInput): EventCandidate[] {
  const events: EventCandidate[] = [];
  const key = (type: string, discriminator: string) => `${type}:${input.bindingId}:${input.listingId}:${discriminator}`;
  const cycle = (input.observedAt ?? "").slice(0, 13) || "legacy";

  if (input.isNewMatch ?? !input.previous) {
    // 上新的语义是"出现了新商品"，不是"新商品可买"：终局状态（售罄 / 下架）不通知，
    // 但库存状态未知不能等同于不可买。Yahoo! Shopping 的公开搜索页没有库存字段，
    // 归一化后 availability 恒为 unknown；用可购买白名单做闸门会让这个来源永久静默——
    // 采集、匹配、AI 判定全部照常执行并计入 new_count，只是一条通知都发不出来。
    const terminal = ["sold_out", "unavailable"].includes(input.current.availability);
    if (input.notifyNewListing !== false && !terminal && (input.baselineCompleted || input.notifyInitial)) {
      events.push({
        type: "new_listing",
        eventKey: key("new_listing", "first_seen"),
        payload: {
          current: input.current,
          ...(input.recoveredMatch
            ? { discoveryKind: "recovered_match" }
            : input.discoveryKind
              ? { discoveryKind: input.discoveryKind }
              : {}),
        },
      });
    }
    if (input.notifyInitial && input.notifyRestock && input.current.availability === "available" && !input.previous) {
      events.push({
        type: "restock",
        eventKey: key("restock", "initial_available"),
        payload: {
          previousAvailability: "unknown",
          currentAvailability: "available",
          initialObservation: true,
        },
      });
    }
    if (!input.previous) return events;
  }

  if (!input.previous) return events;

  const oldPrice = input.previous.price;
  const newPrice = input.current.price;
  if (
    input.notifyPriceDrop && input.priceDropConfirmed === true &&
    oldPrice !== undefined &&
    newPrice !== undefined &&
    newPrice < oldPrice &&
    oldPrice - newPrice >= input.minDropAmount
  ) {
    events.push({
      type: "price_drop",
      eventKey: key("price_drop", `${oldPrice}->${newPrice}@${cycle}`),
      payload: { oldPrice, newPrice, dropAmount: oldPrice - newPrice },
    });
  }

  if (
    input.notifyPriceRise === true
    && oldPrice !== undefined
    && newPrice !== undefined
    && newPrice - oldPrice >= input.minDropAmount
  ) {
    events.push({
      type: "price_rise",
      eventKey: key("price_rise", `${oldPrice}->${newPrice}@${cycle}`),
      payload: { oldPrice, newPrice, riseAmount: newPrice - oldPrice },
    });
  }

  if (input.priceDropConfirmed === true && input.targetPrice !== undefined && newPrice !== undefined && newPrice <= input.targetPrice) {
    const crossed = oldPrice === undefined || oldPrice > input.targetPrice;
    if (crossed) {
      events.push({
        type: "target_price",
        eventKey: key("target_price", `${input.targetPrice}:${newPrice}@${cycle}`),
        payload: { oldPrice, newPrice, targetPrice: input.targetPrice },
      });
    }
  }

  const wasUnavailable = ["sold_out", "unavailable", "preorder", "backorder"].includes(input.previous.availability);
  if (input.notifyRestock && wasUnavailable && input.current.availability === "available") {
    events.push({
      type: "restock",
      eventKey: key("restock", `${input.previous.availability}->available@${cycle}`),
      payload: { previousAvailability: input.previous.availability, currentAvailability: "available" },
    });
  }

  const wasPurchasable = ["available", "preorder", "backorder"].includes(input.previous.availability);
  const becameTerminal = input.current.availability === "sold_out"
    || (input.current.availability === "unavailable" && input.availabilityChangeConfirmed === true);
  if (input.notifySoldOut && wasPurchasable && becameTerminal) {
    events.push({
      type: "sold_out",
      eventKey: key("sold_out", `${input.previous.availability}->${input.current.availability}@${cycle}`),
      payload: {
        previousAvailability: input.previous.availability,
        currentAvailability: input.current.availability,
        ...(input.current.availability === "unavailable" ? { inference: "confirmed_missing" } : {}),
      },
    });
  }

  return events;
}
