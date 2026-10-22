"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import {
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Mail,
  RadioTower,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatJpy } from "@jpgr/core";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditorialSelect } from "@/components/editorial-select";
import { apiFetch } from "@/lib/client-api";
import { presentEvent } from "@/lib/event-presentation";

type EventView = "changes" | "deliveries" | "system";
type LoadState = "loading" | "loaded" | "error";

interface EventRow {
  id: string;
  event_type: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  payload_json: string;
  title: string | null;
  listing_id: string | null;
  canonical_url: string | null;
  image_url: string | null;
  source_item_id: string | null;
  source_id: string | null;
  source_display_name: string | null;
  seller_name: string | null;
  shop_name: string | null;
  current_price: number | null;
  original_price: number | null;
  item_condition: string | null;
  availability: string | null;
  item_watch_profile_id: string | null;
  watch_profile_id?: string | null;
  dossier_kind?: "item" | "exact_product" | "keyword" | null;
  monitor_rule_id?: string | null;
  rule_version?: number | null;
  evidence_hash?: string | null;
  occurred_at?: string | null;
  detected_at?: string | null;
  notification_eligibility?: string | null;
  suppression_reason?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  attempts: number | null;
  last_error: string | null;
}

interface EventsResponse {
  items: EventRow[];
  page: {
    total: number;
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  summary: {
    todayProductChanges: number;
    pendingDeliveries: number;
    failedDeliveries: number;
    sentToday: number;
  };
  sources: Array<{ id: string; display_name: string }>;
}

const viewOptions = [
  { value: "changes", label: "商品变化", caption: "上新、降价与库存变化" },
  { value: "deliveries", label: "通知送达", caption: "实际邮件、摘要与失败重试" },
  { value: "system", label: "来源异常", caption: "来源故障与恢复入口" },
] as const;

const productEventTypeOptions = [
  { value: "all", label: "全部商品变化", code: "全部类型" },
  { value: "product.new_comparable_offer", label: "新商品 / 新同款", code: "首次发现" },
  { value: "listing.price_changed", label: "确认价格变化", code: "上涨或下降" },
  { value: "product.offer_below_target_listing_price", label: "低于目标标价", code: "命中目标" },
  { value: "listing.availability_changed", label: "可购状态变化", code: "库存状态" },
  { value: "product.condition_match_seen", label: "指定品相出现", code: "事实命中" },
  { value: "product.complete_set_seen", label: "完整套装出现", code: "事实命中" },
] as const;

const deliveryEventTypeOptions = [
  { value: "all", label: "全部通知类型", code: "全部类型" },
  { value: "new_listing", label: "新商品", code: "首次发现" },
  { value: "price_drop", label: "价格下降", code: "发生降价" },
  { value: "price_rise", label: "价格上涨", code: "发生涨价" },
  { value: "interest_rise", label: "有人盯上了", code: "点赞评论变多" },
  { value: "target_price", label: "达到目标价", code: "命中目标" },
  { value: "restock", label: "恢复库存", code: "重新可购买" },
  { value: "sold_out", label: "已售出", code: "来源状态" },
  { value: "source_error", label: "来源异常", code: "来源状态" },
  { value: "daily_digest", label: "每日摘要", code: "摘要通知" },
  { value: "watch_completed", label: "监控完成", code: "自动结束" },
  { value: "morning_digest", label: "早间摘要", code: "东京 09:00" },
  { value: "weekly_market_digest", label: "每周市场总结", code: "任务健康" },
] as const;

const statusOptions = [
  { value: "all", label: "全部发送状态", code: "全部状态" },
  { value: "pending", label: "待发送", code: "等待处理" },
  { value: "sending", label: "发送中", code: "正在处理" },
  { value: "sent", label: "已送达", code: "发送成功" },
  { value: "failed", label: "发送失败", code: "需要处理" },
] as const;

const availabilityLabels: Record<string, string> = {
  available: "在售",
  sold_out: "已售出",
  unavailable: "当前不可购买",
  preorder: "预售",
  backorder: "等待补货",
  unknown: "库存未确认",
};

const conditionLabels: Record<string, string> = {
  new: "新品",
  used: "中古",
  collectible: "收藏品",
  refurbished: "翻新",
  unknown: "品相未确认",
};

const emptyPage = { total: 0, pageSize: 40, hasMore: false, nextCursor: null as string | null };

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function deliveryLabel(status: string): string {
  return {
    pending: "待发送",
    sending: "发送中",
    sent: "已送达",
    failed: "发送失败",
  }[status] ?? status;
}

function deliveryTone(status: string): string {
  if (status === "sent") return "good";
  if (status === "failed") return "bad";
  if (status === "pending" || status === "sending") return "warn";
  return "";
}

function eventsUrl(
  view: EventView,
  type: string,
  status: string,
  source: string,
  cursor?: string | null,
): string {
  const params = new URLSearchParams({ view });
  if (type !== "all") params.set("type", type);
  if (status !== "all") params.set("status", status);
  if (source !== "all") params.set("source", source);
  if (cursor) params.set("cursor", cursor);
  return `/api/events?${params}`;
}

export function EventManager({ fixedView }: { fixedView?: EventView }) {
  const [items, setItems] = useState<EventRow[]>([]);
  const [view, setView] = useState<EventView>(fixedView ?? "changes");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [sources, setSources] = useState<EventsResponse["sources"]>([]);
  const [summary, setSummary] = useState<EventsResponse["summary"] | null>(null);
  const [page, setPage] = useState(emptyPage);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingSuppression, setPendingSuppression] = useState<EventRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const requestUrl = useMemo(() => eventsUrl(view, type, status, source), [source, status, type, view]);
  const sourceOptions = useMemo(() => [
    { value: "all", label: "全部来源", code: "全部来源" },
    ...sources.map((item) => ({ value: item.id, label: item.display_name, code: item.id })),
  ], [sources]);
  const eventTypeOptions = view === "changes" ? productEventTypeOptions : deliveryEventTypeOptions;

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<EventsResponse>(requestUrl, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        setItems(body.items);
        setPage(body.page);
        setSummary(body.summary);
        setSources(body.sources);
        setLoadState("loaded");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "变化记录读取失败");
        setLoadState("error");
      });
    return () => controller.abort();
  }, [refreshKey, requestUrl]);

  function beginReload() {
    setLoadState("loading");
    setError("");
    setItems([]);
    setPage(emptyPage);
    setSummary(null);
  }

  function selectView(nextView: EventView) {
    if (fixedView) return;
    if (nextView === view) return;
    beginReload();
    setView(nextView);
    setType("all");
    setStatus("all");
    setSource("all");
    setNotice("");
  }

  async function loadMore() {
    if (!page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const body = await apiFetch<EventsResponse>(eventsUrl(view, type, status, source, page.nextCursor));
      setItems((current) => [...current, ...body.items]);
      setPage(body.page);
      setSummary(body.summary);
      setSources(body.sources);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早的变化记录读取失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function mutate(item: EventRow, action: "retry-email" | "suppress") {
    setBusyId(item.id);
    setNotice("");
    try {
      await apiFetch(`/api/events/${item.id}/${action}`, { method: "POST" });
      setNotice(action === "retry-email"
        ? "已恢复为待发送；下一次 Collector 运行会重新尝试。"
        : "已跳过这次通知；变化事实仍保留在记录中。"
      );
      beginReload();
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "操作失败";
      setNotice(message);
      throw reason;
    } finally {
      setBusyId(null);
    }
  }

  const emptyCopy = view === "changes"
    ? { title: "还没有符合条件的商品变化", detail: "第一次巡回只建立价格与库存基线；没有真实变化时，雷达会保持安静。" }
    : view === "deliveries"
      ? { title: "还没有符合条件的通知记录", detail: "只有实际生成的邮件或合并摘要，才会在这里留下待发送、已送达或失败记录。" }
      : { title: "当前没有来源异常记录", detail: "来源实时健康状态、冷却时间与重新测试入口仍以来源控制台为准。" };

  return (
    <div className="event-workbench reveal reveal-delay-1">
      <section className="event-summary-grid" aria-label={fixedView === "deliveries" ? "通知摘要" : "变化与通知摘要"} data-count={fixedView === "deliveries" ? "three" : "four"}>
        {!fixedView && <article data-kind="changes"><div className="event-summary-heading"><RadioTower size={16} aria-hidden="true" /><span>今日商品变化</span></div><strong>{summary ? summary.todayProductChanges : "—"}</strong><small>东京时间</small></article>}
        <article data-kind="failed" data-alert={Boolean(summary?.failedDeliveries)}><div className="event-summary-heading"><CircleAlert size={16} aria-hidden="true" /><span>发送失败</span></div><strong>{summary ? summary.failedDeliveries : "—"}</strong><small>需要人工判断</small></article>
        <article data-kind="pending"><div className="event-summary-heading"><Clock3 size={16} aria-hidden="true" /><span>等待送达</span></div><strong>{summary ? summary.pendingDeliveries : "—"}</strong><small>包含排队与发送中</small></article>
        <article data-kind="sent"><div className="event-summary-heading"><CheckCircle2 size={16} aria-hidden="true" /><span>今日已送达</span></div><strong>{summary ? summary.sentToday : "—"}</strong><small>成功邮件</small></article>
      </section>

      <section className="paper-panel event-workbench-panel">
        <div className="panel-header event-panel-header">
          <div><p className="eyebrow">{fixedView === "deliveries" ? "NOTIFICATION DELIVERY" : "事件总览"}</p><h2>{fixedView === "deliveries" ? "通知送达记录" : "全局事件台"}</h2></div>
          <span className="status-pill">{loadState === "loaded" ? `${items.length} / ${page.total}` : "读取中"}</span>
        </div>
        <div className="panel-body">
          {!fixedView && <nav className="event-view-nav" aria-label="变化记录视图">
            {viewOptions.map((option, index) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={view === option.value}
                data-active={view === option.value}
                onClick={() => selectView(option.value)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{option.label}</strong>
                <small>{option.caption}</small>
              </button>
            ))}
          </nav>}

          {view === "changes" && (
            <div className="event-view-intro">
              <p>这里只显示 V2 规则命中的不可变事件事实。邮件是否待发、已送达或被跳过，单独放在“通知送达”；旧事件不会被迁移后重新解释。</p>
            </div>
          )}

          {view === "system" && (
            <div className="event-view-intro">
              <p>这里保留来源异常通知；实时状态、冷却和重新测试统一回到来源控制台处理。</p>
              <Link href="/sources">打开来源控制台 <ArrowUpRight size={13} aria-hidden="true" /></Link>
            </div>
          )}

          <div className="event-filters event-workbench-filters" data-view={view} role="group" aria-label="筛选变化与通知">
            {view !== "system" && (
              <EditorialSelect index="01" label="事件类型" caption="按变化类型" showCode={false} value={type} options={eventTypeOptions} onValueChange={(value) => { beginReload(); setType(value); }} />
            )}
            <EditorialSelect index={view === "system" ? "01" : "02"} label="来源" caption="按来源" showCode={false} value={source} options={sourceOptions} onValueChange={(value) => { beginReload(); setSource(value); }} />
            {view === "deliveries" && (
              <EditorialSelect index="03" label="通知状态" caption="按送达状态" showCode={false} value={status} options={statusOptions} onValueChange={(value) => { beginReload(); setStatus(value); }} />
            )}
          </div>

          {notice && <p className="form-note event-notice" role="status">{notice}</p>}
          {error && loadState !== "error" && <p className="form-error event-inline-error" role="alert">{error}</p>}

          {loadState === "loading" && (
            <div className="event-loading-state" role="status"><span aria-hidden="true" /><div><strong>正在读取变化记录</strong><p>筛选条件会保留，结果返回后再判断是否为空。</p></div></div>
          )}

          {loadState === "error" && (
            <div className="event-error-state" role="alert">
              <CircleAlert aria-hidden="true" />
              <div><h3>变化记录读取失败</h3><p>{error}</p><button type="button" className="ghost-button" onClick={() => { beginReload(); setRefreshKey((current) => current + 1); }}><RefreshCw size={14} aria-hidden="true" />重新读取</button></div>
            </div>
          )}

          {loadState === "loaded" && items.length > 0 && (
            <ol className="event-record-list" aria-label={`变化与通知记录，已显示 ${items.length} 条，共 ${page.total} 条`}>
              {items.map((item, index) => {
                const presentation = presentEvent(item.event_type, item.payload_json, item.source_display_name, item.dossier_kind);
                const sourceName = item.source_display_name || item.source_id || "系统";
                const currentPriceChanged = presentation.eventPrice !== null
                  && item.current_price !== null
                  && presentation.eventPrice !== item.current_price;
                const merchant = item.shop_name || item.seller_name;
                const displayPrice = item.current_price ?? presentation.eventPrice;
                const listingHref = item.listing_id ? "/changes" as Route : null;
                const newOfferEvent = item.event_type === "new_listing" || item.event_type === "product.new_comparable_offer";
                return (
                  <li key={item.id}>
                    <article className="event-record-card" data-tone={presentation.tone} data-view={view}>
                      <header>
                        <span className="event-record-index">{String(index + 1).padStart(2, "0")}</span>
                        <div><span className="event-kind">{presentation.label}</span><span>{sourceName}</span></div>
                        <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
                      </header>
                      <div className="event-record-body" data-view={view}>
                        {view === "changes" && listingHref ? (
                          <div className="event-product-overview">
                            <Link className="event-product-media" href={listingHref} aria-label={`查看${item.title || "该商品"}的完整信息`}>
                              {item.image_url
                                ? <Image src={item.image_url} alt={item.title || "商品图片"} width={420} height={315} sizes="(max-width: 760px) calc(100vw - 42px), 220px" />
                                : <span className="event-product-placeholder">商品图片暂缺</span>}
                            </Link>
                            <div className="event-product-content">
                              <div className="event-product-heading">
                                <h3><Link href={listingHref}>{item.title || "商品标题暂缺"}</Link></h3>
                                <div className="event-product-price">
                                  <span>{currentPriceChanged ? "当前价格" : newOfferEvent ? "首次发现价" : "当前价格"}</span>
                                  <strong>{displayPrice === null ? "价格待确认" : formatJpy(displayPrice)}</strong>
                                  {item.original_price !== null && item.original_price !== displayPrice && <del>{formatJpy(item.original_price)}</del>}
                                </div>
                              </div>
                              <dl className="event-product-meta">
                                {item.availability && <div><dt>状态</dt><dd>{availabilityLabels[item.availability] ?? item.availability}</dd></div>}
                                {item.item_condition && <div><dt>品相</dt><dd>{conditionLabels[item.item_condition] ?? item.item_condition}</dd></div>}
                                {merchant && <div><dt>店铺 / 卖家</dt><dd>{merchant}</dd></div>}
                                {item.source_item_id && <div><dt>来源商品 ID</dt><dd>{item.source_item_id}</dd></div>}
                              </dl>
                              {!newOfferEvent ? (
                                <div className="event-change-evidence">
                                  <span>事件发生时</span>
                                  <strong>{presentation.headline}</strong>
                                  <p>{presentation.detail}</p>
                                </div>
                              ) : presentation.eventPrice === null ? <p className="event-product-note">{presentation.detail}</p> : null}
                              {currentPriceChanged && <p className="event-current-fact">事件发生后，当前保存价格已更新为 {formatJpy(item.current_price)}。</p>}
                              {view === "changes" && item.rule_version && (
                                <dl className="event-rule-evidence">
                                  <div><dt>规则版本</dt><dd>v{item.rule_version}</dd></div>
                                  <div><dt>发生 / 发现</dt><dd>{formatDateTime(item.occurred_at ?? item.created_at)} / {formatDateTime(item.detected_at ?? item.created_at)}</dd></div>
                                  <div><dt>事件处理</dt><dd>{item.notification_eligibility === "cooldown" ? `已记录 · ${item.suppression_reason === "dedupe_window" ? "相同事实去重" : "冷却期"}` : item.notification_eligibility === "digest" ? "进入合并摘要" : item.notification_eligibility === "quiet_hours" ? "静默期延后" : "可即时通知"}</dd></div>
                                  {item.evidence_hash && <div><dt>证据哈希</dt><dd><code>{item.evidence_hash.slice(0, 12)}</code></dd></div>}
                                </dl>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="event-fact">
                            <h3>{presentation.headline}</h3>
                            {item.title && <p className="event-product-title">{item.title}</p>}
                            <p>{presentation.detail}</p>
                          </div>
                        )}
                        {view === "deliveries" && (
                          <aside className="event-delivery-state" aria-label="通知送达状态">
                            <span className={`status-pill ${deliveryTone(item.status)}`}>{deliveryLabel(item.status)}</span>
                            {item.status === "sent" && item.sent_at && <small>送达于 {formatDateTime(item.sent_at)}</small>}
                            {item.attempts !== null && <small>已尝试 {item.attempts} 次</small>}
                          </aside>
                        )}
                      </div>
                      {view === "deliveries" && item.last_error && item.status === "failed" && (
                        <details className="event-error-details"><summary>查看发送失败原因</summary><p>{item.last_error}</p></details>
                      )}
                      <footer className="event-record-actions">
                        <div>
                          {listingHref && <Link className="ghost-button" href={listingHref}>查看商品变化 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
                          {item.canonical_url && <a className="ghost-button" href={item.canonical_url} target="_blank" rel="noreferrer">打开来源商品 <ExternalLink size={13} aria-hidden="true" /></a>}
                          {item.item_watch_profile_id && <Link className="ghost-button" href={`/watches/${item.item_watch_profile_id}` as Route}>管理事件规则 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
                          {item.event_type === "source_error" && <Link className="ghost-button" href="/sources">打开来源控制台 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
                        </div>
                        {view === "deliveries" && (
                          <div>
                            {item.status === "failed" && <button type="button" className="ghost-button" disabled={busyId === item.id} onClick={() => void mutate(item, "retry-email").catch(() => undefined)}><Mail size={14} aria-hidden="true" />{busyId === item.id ? "正在恢复…" : "重新发送"}</button>}
                            {(item.status === "pending" || item.status === "failed") && <button type="button" className="ghost-button event-skip-button" disabled={busyId === item.id} onClick={() => setPendingSuppression(item)}><BellRing size={14} aria-hidden="true" />跳过本次通知</button>}
                          </div>
                        )}
                      </footer>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          {loadState === "loaded" && items.length === 0 && (
            <div className="event-empty-state">
              <RadioTower aria-hidden="true" />
              <div><h3>{emptyCopy.title}</h3><p>{emptyCopy.detail}</p></div>
            </div>
          )}

          {loadState === "loaded" && items.length > 0 && (
            <div className="event-pagination">
              <p>已显示 {items.length} / {page.total} 条；每次最多继续读取 {page.pageSize} 条。</p>
              {page.hasMore && <button type="button" className="ghost-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "继续加载更早记录"}</button>}
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={pendingSuppression !== null}
        title="跳过这次通知？"
        description="这只会停止当前这条通知的发送；事件事实、商品记录和后续监控都会保留。"
        confirmLabel="跳过本次通知"
        eyebrow="通知处理"
        cancelLabel="继续等待发送"
        busyLabel="正在跳过…"
        errorFallback="通知跳过失败，请稍后再试。"
        onCancel={() => setPendingSuppression(null)}
        onConfirm={async () => {
          if (!pendingSuppression) return;
          await mutate(pendingSuppression, "suppress");
          setPendingSuppression(null);
        }}
      />
    </div>
  );
}
