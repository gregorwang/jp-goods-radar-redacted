"use client";

import Image from "next/image";
import { ArrowUpRight, BellRing, Check, Database, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatJpy } from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import { isRakutenSource, RakutenCredit } from "@/components/rakuten-credit";

type MatchStage = "baseline" | "detected" | "notified";
type TrackingStatus = "discovery_only" | "anchor_known" | "active" | "unavailable_pending" | "waiting_restock"
  | "terminal" | "dismissed" | "purchased" | "paused";

interface WatchListingEvidenceRow {
  id: string;
  source_id: string;
  source_item_id: string;
  canonical_url: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  original_price: number | null;
  currency: string;
  availability: string;
  item_condition: string;
  source_listed_at: string | null;
  last_changed_at: string;
  match_first_seen_at: string;
  match_last_seen_at: string;
  new_listing_notified_at: string | null;
  match_stage: MatchStage;
  tracking_status: TrackingStatus;
  tracking_interval_minutes: number;
  tracking_next_run_at: string | null;
  tracking_last_run_at: string | null;
  tracking_last_success_at: string | null;
  tracking_last_error_code: string | null;
  tracking_last_error_message: string | null;
  tracking_terminal_reason: string | null;
}

const keywordStageCopy: Record<MatchStage, { label: string; detail: string }> = {
  baseline: {
    label: "初始基线",
    detail: "首轮确认相关，不发送上新通知",
  },
  detected: {
    label: "后续新增",
    detail: "基线之后首次发现，等待汇总处理",
  },
  notified: {
    label: "已汇总通知",
    detail: "已纳入关键词上新汇总",
  },
};

const exactStageCopy: Record<MatchStage, { label: string; detail: string }> = {
  baseline: { label: "已确认同款", detail: "已登记为同款报价；是否通知由当前同款与目标价规则决定" },
  detected: { label: "首次发现", detail: "首次确认为目标同款，等待汇总处理" },
  notified: { label: "已汇总通知", detail: "已纳入精确同款上新通知" },
};

const availabilityLabels: Record<string, string> = {
  available: "在售",
  in_stock: "在售",
  unavailable: "不可购买",
  out_of_stock: "缺货",
  sold_out: "已售出",
  preorder: "预售",
  ended: "已结束",
  unknown: "状态待确认",
};

const trackingCopy: Record<TrackingStatus, { label: string; detail: string }> = {
  discovery_only: { label: "只参与发现", detail: "未建立独立详情跟踪" },
  anchor_known: { label: "已知报价锚点", detail: "由已有单品关注提供，只用于同款去重" },
  active: { label: "持续跟踪中", detail: "独立检查价格与可购状态" },
  unavailable_pending: { label: "下架复核中", detail: "首次不可访问，15 分钟后再次确认" },
  waiting_restock: { label: "等待补货", detail: "目录商品无货，仍会继续检查" },
  terminal: { label: "跟踪已结束", detail: "一次性挂牌已确认售出或下架" },
  dismissed: { label: "已忽略", detail: "不再跟踪这条商品" },
  purchased: { label: "已购买", detail: "你已完成购买，不再提醒这条商品" },
  paused: { label: "跟踪暂停", detail: "详情能力暂不可用，可查看具体原因" },
};

export function WatchListingEvidence({
  bindingId,
  sourceName,
  totalCount,
  dossierKind,
}: {
  bindingId: string;
  sourceName: string;
  totalCount: number;
  dossierKind: "keyword" | "exact_product";
}) {
  const [items, setItems] = useState<WatchListingEvidenceRow[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState("");
  const [requestKey, setRequestKey] = useState(0);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [actionListingId, setActionListingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ items: WatchListingEvidenceRow[]; trackingEnabled: boolean }>(
      `/api/watch-bindings/${bindingId}/listings`,
      { signal: controller.signal },
    ).then((body) => {
      setItems(body.items);
      setTrackingEnabled(body.trackingEnabled);
      setState("loaded");
      setError("");
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(apiErrorMessage(reason, dossierKind === "exact_product" ? "确认同款商品读取失败" : "关键词相关商品读取失败"));
      setState("error");
    });
    return () => controller.abort();
  }, [bindingId, dossierKind, requestKey]);

  const headingId = `watch-listing-evidence-${bindingId}`;
  const exactProduct = dossierKind === "exact_product";
  const stageCopy = exactProduct ? exactStageCopy : keywordStageCopy;

  async function updateTracking(listingId: string, action: "track" | "dismiss" | "purchased") {
    if (actionListingId) return;
    setActionListingId(listingId);
    setError("");
    try {
      const result = await apiFetch<{
        tracking: Pick<WatchListingEvidenceRow,
          "tracking_status" | "tracking_next_run_at" | "tracking_last_run_at" | "tracking_last_success_at"
          | "tracking_last_error_code" | "tracking_last_error_message" | "tracking_terminal_reason">;
      }>(`/api/watch-bindings/${bindingId}/listings/${listingId}/tracking`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      setItems((current) => current.map((item) => item.id === listingId
        ? { ...item, ...result.tracking }
        : item));
    } catch (reason) {
      setError(apiErrorMessage(reason, "商品跟踪状态更新失败"));
    } finally {
      setActionListingId(null);
    }
  }

  return (
    <section className="watch-listing-evidence" aria-labelledby={headingId}>
      <header>
        <div>
          <p className="eyebrow">{trackingEnabled ? "DISCOVERY & LISTING TRACKING" : "BASELINE & NEW LISTINGS"}</p>
          <h3 id={headingId}>{trackingEnabled ? "已命中商品与独立跟踪" : exactProduct ? "当前确认同款" : "基线与关键词新增对照"}</h3>
          <p>{trackingEnabled
            ? "父档案会继续寻找新的确认同款；每条已命中商品同时独立检查降价、售出/下架与补货。"
            : exactProduct
              ? "这里保留已经确认同款的商品身份；每轮实际抓取明细与排除理由请到“商品变化”查看。"
              : "这里按来源商品 ID 保留已确认相关的初始基线与后续新增；重复出现只更新最近确认时间，不重复发送上新。"}</p>
        </div>
        <span><Database size={13} aria-hidden="true" />{totalCount} 件</span>
      </header>

      {isRakutenSource(items[0]?.source_id ?? "") && <RakutenCredit />}

      {state === "loading" && (
        <p className="watch-listing-state" role="status">正在读取 {sourceName} 的{exactProduct ? "确认同款" : "关键词相关"}商品…</p>
      )}
      {state === "error" && (
        <div className="watch-listing-state" role="alert">
          <p>{error}</p>
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setState("loading");
              setError("");
              setRequestKey((current) => current + 1);
            }}
          >
            重新读取
          </button>
        </div>
      )}
      {state === "loaded" && error && <p className="watch-listing-state" role="alert">{error}</p>}
      {state === "loaded" && items.length === 0 && (
        <p className="watch-listing-state">这个来源当前没有可购买且{exactProduct ? "确认同款" : "确认相关"}的商品；每次巡回抓到的完整清单可在“商品变化”中核验。</p>
      )}
      {state === "loaded" && items.length > 0 && (
        <>
          <ol className="watch-listing-list">
            {items.map((item) => {
              const stage = stageCopy[item.match_stage] ?? stageCopy.baseline;
              const tracking = trackingCopy[item.tracking_status] ?? trackingCopy.discovery_only;
              const trackingBusy = actionListingId === item.id;
              const activelyTracked = ["active", "unavailable_pending", "waiting_restock"].includes(item.tracking_status);
              const trackingSupported = !["yahoo_shopping", "ebay"].includes(item.source_id);
              const canResume = trackingSupported
                && ["discovery_only", "dismissed", "purchased", "paused"].includes(item.tracking_status);
              return (
                <li key={item.id} data-stage={item.match_stage} data-tracking={item.tracking_status}>
                  <div className="watch-listing-media">
                    {item.image_url
                      ? <Image src={item.image_url} alt={item.title} width={144} height={144} sizes="(max-width: 520px) 74px, 88px" />
                      : <div aria-label="商品图片暂缺" />}
                  </div>
                  <div className="watch-listing-main">
                    <div className="watch-listing-stage">
                      <span>{item.match_stage === "notified" && <BellRing size={11} aria-hidden="true" />}{stage.label}</span>
                      <small>{stage.detail}</small>
                    </div>
                    {trackingEnabled && (
                      <div className="watch-listing-tracking">
                        <span>{tracking.label}</span><small>{item.tracking_last_error_message || tracking.detail}</small>
                      </div>
                    )}
                    <a href={item.canonical_url} target="_blank" rel="noopener noreferrer">
                      {item.title}<ArrowUpRight size={13} aria-hidden="true" />
                    </a>
                    <div className="watch-listing-price">
                      <strong>{formatJpy(item.current_price ?? undefined)}</strong>
                      <span>{availabilityLabels[item.availability] ?? item.availability}</span>
                    </div>
                    <dl>
                      <div><dt>首次纳入</dt><dd>{tokyoFull(item.match_first_seen_at)}</dd></div>
                      <div><dt>最近确认</dt><dd>{tokyoFull(item.match_last_seen_at)}</dd></div>
                      {trackingEnabled && item.tracking_last_success_at && <div><dt>详情确认</dt><dd>{tokyoFull(item.tracking_last_success_at)}</dd></div>}
                      {trackingEnabled && item.tracking_next_run_at && <div><dt>下次检查</dt><dd>{tokyoFull(item.tracking_next_run_at)}</dd></div>}
                    </dl>
                    {trackingEnabled && (
                      <div className="watch-listing-actions">
                        {activelyTracked && <>
                          <button type="button" disabled={trackingBusy} onClick={() => updateTracking(item.id, "purchased")}><Check size={12} aria-hidden="true" />已购买</button>
                          <button type="button" disabled={trackingBusy} onClick={() => updateTracking(item.id, "dismiss")}><EyeOff size={12} aria-hidden="true" />忽略这件</button>
                        </>}
                        {canResume && <button type="button" disabled={trackingBusy} onClick={() => updateTracking(item.id, "track")}><RefreshCw size={12} aria-hidden="true" />继续跟踪</button>}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {totalCount > items.length && <p className="watch-listing-limit">当前显示最近纳入的 {items.length} / {totalCount} 件。</p>}
        </>
      )}
    </section>
  );
}
