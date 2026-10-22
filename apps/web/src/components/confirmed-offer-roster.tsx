"use client";

import Image from "next/image";
import { Check, ExternalLink, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatJpy } from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";

type TrackingStatus =
  | "discovery_only" | "anchor_known" | "active" | "unavailable_pending" | "waiting_restock"
  | "terminal" | "dismissed" | "purchased" | "paused";

interface ConfirmedOffer {
  binding_id: string;
  listing_id: string;
  source_id: string;
  source_display_name: string;
  canonical_url: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  price_basis: string;
  availability: string;
  item_condition: string;
  first_seen_at: string;
  tracking_status: TrackingStatus;
  tracking_next_run_at: string | null;
  tracking_last_success_at: string | null;
  tracking_last_error_message: string | null;
  first_price: number | null;
}

interface AlertPolicy {
  targetPrice: number | null;
  everyDrop: boolean;
}

// 用户在这里只关心一件事：这件同款还在不在帮我等降价。标签按这个问题来写，
// 不复述内部状态名。
const statusCopy: Record<TrackingStatus, { label: string; detail: string; tone: "good" | "warn" | "" }> = {
  active: { label: "跟踪价格中", detail: "定期检查价格", tone: "good" },
  unavailable_pending: { label: "下架复核中", detail: "页面暂时打不开，稍后再确认一次", tone: "warn" },
  waiting_restock: { label: "等补货中", detail: "暂时无货，仍在定期检查", tone: "warn" },
  paused: { label: "只在巡回时看价", detail: "这个来源不支持单独盯一件商品，降价不会单独提醒", tone: "" },
  discovery_only: { label: "未单独盯价", detail: "只在每轮巡回里看到价格，降价不会单独提醒", tone: "" },
  anchor_known: { label: "已有单品关注", detail: "这件已经有自己的单品监控，在那里提醒", tone: "" },
  terminal: { label: "已售出或下架", detail: "二手挂牌已经结束", tone: "" },
  purchased: { label: "已购买", detail: "不再提醒这件", tone: "" },
  dismissed: { label: "已忽略", detail: "不再提醒这件", tone: "" },
};

const waitingStatuses = new Set<TrackingStatus>(["active", "unavailable_pending", "waiting_restock"]);
const endedStatuses = new Set<TrackingStatus>(["terminal", "purchased", "dismissed"]);
const detailUnsupportedSources = new Set(["yahoo_shopping", "ebay"]);

function formatDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isEnded(offer: ConfirmedOffer): boolean {
  return endedStatuses.has(offer.tracking_status)
    || (!waitingStatuses.has(offer.tracking_status) && ["sold_out", "unavailable"].includes(offer.availability));
}

// "在跟踪"只说明系统在看价格；用户真正想知道的是"什么情况下会给我发邮件"。
function activeCopy(offer: ConfirmedOffer, policy: AlertPolicy): { label: string; detail: string; tone: "good" | "" } {
  const { targetPrice, everyDrop } = policy;
  if (targetPrice !== null) {
    const reached = offer.current_price !== null && offer.current_price <= targetPrice;
    return {
      label: reached ? "已在目标价内" : `等降到 ${formatJpy(targetPrice)}`,
      detail: everyDrop
        ? "每次降价都提醒，降到目标价另有提醒"
        : `降到 ${formatJpy(targetPrice)} 以下才发邮件，小幅降价不提醒`,
      tone: "good",
    };
  }
  if (everyDrop) return { label: "等降价中", detail: "只要降价（降 1 日元也算）就发邮件", tone: "good" };
  return { label: "只记录价格", detail: "这份档案没开降价或目标价提醒，价格变化只留记录", tone: "" };
}

function targetGap(offer: ConfirmedOffer, targetPrice: number | null): string | null {
  if (targetPrice === null || offer.current_price === null || offer.price_basis === "auction_current_bid") return null;
  const gap = offer.current_price - targetPrice;
  return gap > 0 ? `离目标价还差 ${formatJpy(gap)}` : "已达到目标价";
}

function priceMovement(offer: ConfirmedOffer): { text: string; direction: "down" | "up" | "flat" } | null {
  if (offer.first_price === null || offer.current_price === null) return null;
  const delta = offer.current_price - offer.first_price;
  if (delta === 0) return { text: "与首次确认时相同", direction: "flat" };
  const amount = formatJpy(Math.abs(delta));
  return delta < 0
    ? { text: `较首次确认降 ${amount}`, direction: "down" }
    : { text: `较首次确认涨 ${amount}`, direction: "up" };
}

export function ConfirmedOfferRoster({ profileId }: { profileId: string }) {
  const [offers, setOffers] = useState<ConfirmedOffer[]>([]);
  const [policy, setPolicy] = useState<AlertPolicy>({ targetPrice: null, everyDrop: false });
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ items: ConfirmedOffer[]; alertPolicy: AlertPolicy | null }>(`/api/watch-profiles/${profileId}/confirmed-offers`, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        setOffers(body.items);
        if (body.alertPolicy) setPolicy(body.alertPolicy);
        setState("loaded");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(apiErrorMessage(reason, "已确认同款读取失败"));
        setState("error");
      });
    return () => controller.abort();
  }, [profileId]);

  async function updateTracking(offer: ConfirmedOffer, action: "track" | "dismiss" | "purchased") {
    const key = `${offer.binding_id}:${offer.listing_id}`;
    if (busyKey) return;
    setBusyKey(key);
    setError("");
    try {
      const result = await apiFetch<{ tracking: Pick<ConfirmedOffer, "tracking_status" | "tracking_next_run_at" | "tracking_last_success_at" | "tracking_last_error_message"> }>(
        `/api/watch-bindings/${offer.binding_id}/listings/${offer.listing_id}/tracking`,
        { method: "PATCH", body: JSON.stringify({ action }) },
      );
      setOffers((current) => current.map((item) => item.binding_id === offer.binding_id && item.listing_id === offer.listing_id
        ? { ...item, ...result.tracking }
        : item));
    } catch (reason) {
      setError(apiErrorMessage(reason, "这件同款的状态更新失败"));
    } finally {
      setBusyKey(null);
    }
  }

  const current = offers.filter((offer) => !isEnded(offer));
  const ended = offers.filter(isEnded);
  const waitingCount = current.filter((offer) => waitingStatuses.has(offer.tracking_status)).length;

  function renderOffer(offer: ConfirmedOffer) {
    const key = `${offer.binding_id}:${offer.listing_id}`;
    const busy = busyKey === key;
    const waiting = waitingStatuses.has(offer.tracking_status);
    const copy = offer.tracking_status === "active"
      ? activeCopy(offer, policy)
      : statusCopy[offer.tracking_status] ?? statusCopy.discovery_only;
    const movement = priceMovement(offer);
    const gap = isEnded(offer) ? null : targetGap(offer, policy.targetPrice);
    const canTrack = !waiting
      && offer.tracking_status !== "anchor_known"
      && offer.tracking_status !== "terminal"
      && !detailUnsupportedSources.has(offer.source_id)
      && !["sold_out", "unavailable"].includes(offer.availability);
    return (
      <li key={key} data-status={offer.tracking_status}>
        <div className="confirmed-offer-media">
          {offer.image_url
            ? <Image src={offer.image_url} alt={offer.title} width={120} height={120} sizes="64px" />
            : <div role="img" aria-label="商品图片暂缺" />}
        </div>
        <div className="confirmed-offer-main">
          <a href={offer.canonical_url} target="_blank" rel="noreferrer">{offer.title}<ExternalLink size={12} aria-hidden="true" /></a>
          <small>{offer.source_display_name} · 首次确认 {formatDay(offer.first_seen_at)}</small>
        </div>
        <div className="confirmed-offer-price" data-direction={movement?.direction} data-target={gap === null ? undefined : gap === "已达到目标价" ? "reached" : "above"}>
          <strong>{formatJpy(offer.current_price ?? undefined)}</strong>
          {gap && <em>{gap}</em>}
          <small>{offer.price_basis === "auction_current_bid" ? "拍卖当前出价" : movement?.text ?? "首次价格未记录"}</small>
        </div>
        <div className="confirmed-offer-status">
          <span className={`status-pill ${copy.tone}`}>{copy.label}</span>
          <small>{offer.tracking_last_error_message && offer.tracking_status === "paused" ? offer.tracking_last_error_message : copy.detail}</small>
          {(waiting || canTrack) && <div className="confirmed-offer-actions">
            {waiting && <>
              <button type="button" disabled={busy} onClick={() => void updateTracking(offer, "purchased")}><Check size={11} aria-hidden="true" />已购买</button>
              <button type="button" disabled={busy} onClick={() => void updateTracking(offer, "dismiss")}><EyeOff size={11} aria-hidden="true" />忽略这件</button>
            </>}
            {canTrack && <button type="button" disabled={busy} onClick={() => void updateTracking(offer, "track")}><RefreshCw size={11} aria-hidden="true" />{offer.tracking_status === "purchased" || offer.tracking_status === "dismissed" ? "恢复跟踪" : "开始跟踪价格"}</button>}
          </div>}
        </div>
      </li>
    );
  }

  return (
    <section className="confirmed-offer-roster" aria-labelledby={`confirmed-offers-${profileId}`}>
      <header>
        <div>
          <p className="eyebrow">CONFIRMED OFFERS</p>
          <h4 id={`confirmed-offers-${profileId}`}>已确认的同款</h4>
          <p>{policy.targetPrice !== null
            ? `这个档案在蹲 ${formatJpy(policy.targetPrice)} 以下的好价：任何一件同款降到目标价才发邮件，${policy.everyDrop ? "另外每次降价也会提醒。" : "小幅降价不提醒。"}买了或不想要，在这里标记即可。`
            : policy.everyDrop
              ? "这个档案至今确认过的每一件同款。在跟踪的只要降价就发邮件；买了或不想要，在这里标记即可。"
              : "这个档案至今确认过的每一件同款。目前没开降价或目标价提醒，价格变化只留记录，可在上方提醒规则里打开。"}</p>
        </div>
        {state === "loaded" && <span>{policy.targetPrice !== null ? `目标 ${formatJpy(policy.targetPrice)} · ` : ""}{waitingCount} 件跟踪中 · 共 {offers.length} 件</span>}
      </header>
      {state === "loading" && <p className="confirmed-offer-state" role="status">正在读取已确认同款…</p>}
      {state === "error" && <p className="confirmed-offer-state" role="alert">{error}</p>}
      {state === "loaded" && error && <p className="confirmed-offer-state" role="alert">{error}</p>}
      {state === "loaded" && offers.length === 0 && <p className="confirmed-offer-state">还没有确认过同款。巡回确认第一件后会出现在这里。</p>}
      {state === "loaded" && current.length > 0 && <ol className="confirmed-offer-list">{current.map(renderOffer)}</ol>}
      {state === "loaded" && current.length === 0 && ended.length > 0 && <p className="confirmed-offer-state">目前没有在售的同款，结束的记录在下面。</p>}
      {state === "loaded" && ended.length > 0 && (
        <details className="confirmed-offer-ended">
          <summary>已结束 {ended.length} 件<small>已购买、已忽略、已售出或下架</small></summary>
          <ol className="confirmed-offer-list">{ended.map(renderOffer)}</ol>
        </details>
      )}
    </section>
  );
}
