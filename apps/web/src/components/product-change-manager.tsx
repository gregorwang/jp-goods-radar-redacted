"use client";

import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { Ban, CircleAlert, Database, ExternalLink, RadioTower, RefreshCw, Undo2, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatJpy } from "@jpgr/core";
import { ConfirmedOfferRoster } from "@/components/confirmed-offer-roster";
import { EditorialSelect } from "@/components/editorial-select";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { presentEvent } from "@/lib/event-presentation";

interface ChangeRow {
  id: string;
  event_type: string;
  created_at: string;
  payload_json: string;
  title: string | null;
  canonical_url: string | null;
  source_id: string | null;
  source_display_name: string | null;
}

interface WatchChoice {
  id: string;
  name: string;
  dossier_kind: "item" | "exact_product" | "keyword" | null;
  enabled: number;
  binding_count: number;
  active_binding_count: number;
}

interface AuditListing {
  ordinal: number;
  source_id: string;
  source_item_id: string;
  canonical_url: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  currency: string;
  price_basis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid";
  availability: string;
  item_condition: string;
  decision_status: "pending" | "confirmed" | "rejected" | "uncertain";
  decision_reason: string | null;
  match_relation: string | null;
  is_purchasable: number;
  first_observed_at: string;
  observation_count: number;
  is_first_observation: number;
}

type AuditDecisionFilter = "all" | "confirmed" | "rejected" | "pending" | "price_changed" | "price_unchanged" | "price_initial";
type AuditPriceFilter = "all" | "fixed" | "auction";
type AuditNoveltyFilter = "all" | "first" | "seen";
type PriceObservation = "changed" | "unchanged" | "initial";

interface PresentedAuditListing extends AuditListing {
  previous_price: number | null;
  price_observation: PriceObservation;
}

interface PresentedAuditRun extends Omit<AuditRun, "listings"> {
  listings: PresentedAuditListing[];
  total_listing_count: number;
}

interface DailyAuditSummary {
  day: string;
  runs: number;
  sourceReturns: number;
  retainedListings: number;
  confirmedFixed: number;
  confirmedAuctions: number;
}

interface AuditRun {
  id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  result_count: number;
  new_count: number;
  changed_count: number;
  coverage: string;
  error_code: string | null;
  error_message: string | null;
  source_id: string;
  watch_binding_id: string;
  source_display_name: string;
  raw_result_count: number | null;
  listings: AuditListing[];
  decisionCounts: { pending: number; confirmed: number; rejected: number; uncertain: number };
}

type DismissalReason = "not_same_product" | "too_expensive";

interface CandidateDismissal {
  watch_binding_id: string;
  source_id: string;
  source_item_id: string;
  reason: DismissalReason;
  created_at: string;
}

interface ChangesResponse {
  items: ChangeRow[];
  audits: AuditRun[];
  dismissals: CandidateDismissal[];
  page: { total: number; pageSize: number; hasMore: boolean; nextCursor: string | null };
  summary: { todayProductChanges: number };
  sources: Array<{ id: string; display_name: string }>;
}

const availabilityLabels: Record<string, string> = {
  available: "在售",
  preorder: "预售",
  backorder: "可订购",
  sold_out: "已售出",
  unavailable: "不可购买",
  unknown: "状态待确认",
};

const exactDecisionLabels: Record<AuditListing["decision_status"], string> = {
  pending: "判定处理中",
  confirmed: "确认同款",
  rejected: "已排除",
  uncertain: "证据不足",
};

const keywordDecisionLabels: Record<AuditListing["decision_status"], string> = {
  pending: "相关性处理中",
  confirmed: "关键词相关",
  rejected: "规则排除",
  uncertain: "相关性待定",
};

// 标掉的两种理由语义不同，界面必须把差别说清楚：判错是永久静音，
// 嫌贵只是不再当作"新发现"，降价照旧提醒——用户排除它的原因正是价格。
const dismissalCopy: Record<DismissalReason, { label: string; detail: string }> = {
  not_same_product: { label: "已标记不是同款", detail: "这条商品的所有通知已静音" },
  too_expensive: { label: "已标记太贵了", detail: "不再作为新发现打扰；降价或到达目标价仍会提醒" },
};

const exactAuditOptions = [
  { value: "all", label: "全部判定商品", code: "显示全部" },
  { value: "confirmed", label: "只看确认同款", code: "人工核验重点" },
  { value: "rejected", label: "只看已排除", code: "排除证据" },
  { value: "pending", label: "只看待判定", code: "处理中或证据不足" },
] as const;

const itemAuditOptions = [
  { value: "all", label: "全部价格观测", code: "每次巡回" },
  { value: "price_changed", label: "只看价格刷新", code: "与上次不同" },
  { value: "price_unchanged", label: "只看价格未变", code: "与上次相同" },
  { value: "price_initial", label: "只看首次观测", code: "没有上次价格" },
] as const;

const keywordAuditOptions = [
  { value: "all", label: "全部抓取商品", code: "显示全部" },
  { value: "confirmed", label: "只看规则命中", code: "确认相关" },
  { value: "rejected", label: "只看已排除", code: "排除证据" },
  { value: "pending", label: "只看待判定", code: "处理中或证据不足" },
] as const;

const keywordNoveltyOptions = [
  { value: "all", label: "全部新旧状态", code: "首次与历史" },
  { value: "first", label: "只看首次发现", code: "此前从未抓到" },
  { value: "seen", label: "只看历史已见", code: "来源商品 ID 重复" },
] as const;

const priceFilterOptions = [
  { value: "all", label: "全部价格口径", code: "固定价与拍卖" },
  { value: "fixed", label: "只看可成交标价", code: "可参与目标价" },
  { value: "auction", label: "只看进行中拍卖", code: "当前出价非最终价" },
] as const;

const typeOptions = [
  { value: "all", label: "全部商品变化", code: "全部类型" },
  { value: "product.new_comparable_offer", label: "关键词新增商品", code: "首次发现且相关" },
  { value: "listing.price_changed", label: "相关商品价格变化", code: "上涨或下降" },
  { value: "product.offer_below_target_listing_price", label: "低于目标标价", code: "命中目标" },
  { value: "listing.availability_changed", label: "可购状态变化", code: "库存状态" },
  { value: "product.condition_match_seen", label: "指定品相出现", code: "事实命中" },
  { value: "product.complete_set_seen", label: "完整套装出现", code: "事实命中" },
] as const;

const itemTypeOptions = [
  { value: "all", label: "全部单品变化", code: "价格与库存" },
  { value: "listing.price_changed", label: "确认价格刷新", code: "上涨或下降" },
  { value: "product.offer_below_target_listing_price", label: "命中目标价格", code: "达到目标" },
  { value: "listing.availability_changed", label: "可购状态变化", code: "补货或不可购买" },
] as const;

const exactTypeOptions = [
  { value: "all", label: "全部同款事件", code: "同款与目标价" },
  { value: "product.new_comparable_offer", label: "新确认同款报价", code: "首次发现" },
  { value: "product.offer_below_target_listing_price", label: "固定价命中目标", code: "拍卖出价不计入" },
] as const;

const emptyPage = { total: 0, pageSize: 40, hasMore: false, nextCursor: null as string | null };

function defaultAuditDecision(kind?: WatchChoice["dossier_kind"]): AuditDecisionFilter {
  return kind === "exact_product" ? "confirmed" : "all";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function tokyoDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function priceBasisLabel(listing: AuditListing): { label: string; note: string; auction: boolean } {
  if (listing.price_basis === "auction_current_bid") {
    return { label: "当前出价", note: "进行中拍卖 · 不计入目标价", auction: true };
  }
  if (listing.price_basis === "catalog_price") return { label: "官方标价", note: "可参与目标价判断", auction: false };
  if (listing.price_basis === "offer_price") return { label: "当前优惠价", note: "可参与目标价判断", auction: false };
  return { label: "当前标价", note: "可参与目标价判断", auction: false };
}

function dossierKindLabel(kind: WatchChoice["dossier_kind"]): string {
  return kind === "item" ? "商品监控" : kind === "exact_product" ? "精确同款雷达" : "关键词雷达";
}

function changeUrl(watchId: string, type: string, source: string, cursor?: string | null): string {
  const params = new URLSearchParams({ view: "changes", watch: watchId });
  if (type !== "all") params.set("type", type);
  if (source !== "all") params.set("source", source);
  if (cursor) params.set("cursor", cursor);
  return `/api/events?${params}`;
}

function toneClass(tone: ReturnType<typeof presentEvent>["tone"]): string {
  if (tone === "positive") return "good";
  if (tone === "negative") return "bad";
  if (tone === "price") return "price";
  return "";
}

function runStatusLabel(status: string): string {
  if (status === "success") return "成功";
  if (status === "running") return "运行中";
  if (status === "skipped") return "已跳过";
  if (status === "rate_limited") return "来源限流";
  if (status === "blocked") return "来源阻断";
  return "失败";
}

export function ProductChangeManager() {
  const [watches, setWatches] = useState<WatchChoice[]>([]);
  const [selectedWatchId, setSelectedWatchId] = useState<string | null>(null);
  const [watchState, setWatchState] = useState<"loading" | "loaded" | "error">("loading");
  const [items, setItems] = useState<ChangeRow[]>([]);
  const [audits, setAudits] = useState<AuditRun[]>([]);
  const [type, setType] = useState("all");
  const [source, setSource] = useState("all");
  const [auditDecision, setAuditDecision] = useState<AuditDecisionFilter>("all");
  const [auditPrice, setAuditPrice] = useState<AuditPriceFilter>("all");
  const [auditNovelty, setAuditNovelty] = useState<AuditNoveltyFilter>("all");
  const [selectedAuditDay, setSelectedAuditDay] = useState<string | null>(null);
  const [sources, setSources] = useState<ChangesResponse["sources"]>([]);
  const [page, setPage] = useState(emptyPage);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dismissals, setDismissals] = useState<CandidateDismissal[]>([]);
  const [dismissBusyKey, setDismissBusyKey] = useState<string | null>(null);
  const auditListHeadingRef = useRef<HTMLDivElement>(null);

  const selectedWatch = watches.find((watch) => watch.id === selectedWatchId) ?? null;
  const isExactProduct = selectedWatch?.dossier_kind === "exact_product";
  const isItemWatch = selectedWatch?.dossier_kind === "item";
  const isKeywordWatch = selectedWatch?.dossier_kind === "keyword";
  const requestUrl = useMemo(() => selectedWatchId ? changeUrl(selectedWatchId, type, source) : null, [selectedWatchId, source, type]);
  const sourceOptions = useMemo(() => [{ value: "all", label: "全部来源", code: "全部来源" }, ...sources.map((item) => ({ value: item.id, label: item.display_name, code: item.id }))], [sources]);
  const auditDecisionOptions = isItemWatch ? itemAuditOptions : isExactProduct ? exactAuditOptions : keywordAuditOptions;
  const eventTypeOptions = isItemWatch ? itemTypeOptions : isExactProduct ? exactTypeOptions : typeOptions;
  const presentedAudits = useMemo<PresentedAuditRun[]>(() => {
    const previousPrices = new Map<string, number | null>();
    return [...audits].reverse().map((run) => ({
      ...run,
      total_listing_count: run.listings.length,
      listings: run.listings.map((listing) => {
        const key = `${listing.source_id}:${listing.source_item_id}`;
        const hasPrevious = previousPrices.has(key);
        const previousPrice = previousPrices.get(key) ?? null;
        const priceObservation: PriceObservation = !hasPrevious
          ? "initial"
          : previousPrice === listing.current_price
            ? "unchanged"
            : "changed";
        previousPrices.set(key, listing.current_price);
        return { ...listing, previous_price: previousPrice, price_observation: priceObservation };
      }),
    })).reverse();
  }, [audits]);
  const filteredAudits = useMemo(() => {
    return presentedAudits.map((run) => ({
      ...run,
      listings: run.listings.filter((listing) => {
        const decisionMatches = auditDecision === "all"
          || auditDecision === listing.decision_status
          || (auditDecision === "pending" && listing.decision_status === "uncertain")
          || (auditDecision === "price_changed" && listing.price_observation === "changed")
          || (auditDecision === "price_unchanged" && listing.price_observation === "unchanged")
          || (auditDecision === "price_initial" && listing.price_observation === "initial");
        const priceMatches = auditPrice === "all"
          || (auditPrice === "auction" && listing.price_basis === "auction_current_bid")
          || (auditPrice === "fixed" && listing.price_basis !== "auction_current_bid");
        const noveltyMatches = auditNovelty === "all"
          || (auditNovelty === "first" && listing.is_first_observation === 1)
          || (auditNovelty === "seen" && listing.is_first_observation === 0);
        return decisionMatches && priceMatches && noveltyMatches;
      }),
    }));
  }, [auditDecision, auditNovelty, auditPrice, presentedAudits]);
  const dailyAuditSummaries = useMemo<DailyAuditSummary[]>(() => {
    const latestByDayAndSource = new Map<string, PresentedAuditRun>();
    for (const run of presentedAudits) {
      const key = `${tokyoDay(run.started_at)}:${run.source_id}`;
      if (!latestByDayAndSource.has(key)) latestByDayAndSource.set(key, run);
    }
    const grouped = new Map<string, DailyAuditSummary>();
    for (const run of latestByDayAndSource.values()) {
      const day = tokyoDay(run.started_at);
      const summary = grouped.get(day) ?? { day, runs: 0, sourceReturns: 0, retainedListings: 0, confirmedFixed: 0, confirmedAuctions: 0 };
      summary.runs += 1;
      summary.sourceReturns += run.raw_result_count ?? run.result_count;
      summary.retainedListings += run.listings.filter((listing) => listing.decision_status !== "rejected").length;
      summary.confirmedFixed += run.listings.filter((listing) => listing.decision_status === "confirmed" && listing.price_basis !== "auction_current_bid").length;
      summary.confirmedAuctions += run.listings.filter((listing) => listing.decision_status === "confirmed" && listing.price_basis === "auction_current_bid").length;
      grouped.set(day, summary);
    }
    return [...grouped.values()].sort((left, right) => right.day.localeCompare(left.day));
  }, [presentedAudits]);
  const visibleAudits = useMemo(
    () => selectedAuditDay ? filteredAudits.filter((run) => tokyoDay(run.started_at) === selectedAuditDay) : filteredAudits,
    [filteredAudits, selectedAuditDay],
  );
  const dismissalByKey = useMemo(() => new Map<string, CandidateDismissal>(
    dismissals.map((entry) => [`${entry.watch_binding_id}:${entry.source_id}:${entry.source_item_id}`, entry]),
  ), [dismissals]);
  const totalAuditListings = presentedAudits.reduce((count, run) => count + run.listings.length, 0);
  const filteredAuditListings = visibleAudits.reduce((count, run) => count + run.listings.length, 0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ items: WatchChoice[] }>("/api/watch-profiles", { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        const selectable = body.items;
        const requestedWatchId = new URLSearchParams(window.location.search).get("watch");
        const initialWatch = selectable.find((watch) => watch.id === requestedWatchId) ?? selectable[0];
        setWatches(selectable);
        setSelectedWatchId((current) => current ?? initialWatch?.id ?? null);
        setAuditDecision(defaultAuditDecision(initialWatch?.dossier_kind));
        setWatchState("loaded");
      })
      .catch(() => { if (!controller.signal.aborted) setWatchState("error"); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!requestUrl) return;
    const controller = new AbortController();
    apiFetch<ChangesResponse>(requestUrl, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        setItems(body.items);
        setAudits(body.audits);
        setDismissals(body.dismissals ?? []);
        setPage(body.page);
        setTodayCount(body.summary.todayProductChanges);
        setSources(body.sources);
        setState("loaded");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "商品变化读取失败");
        setState("error");
      });
    return () => controller.abort();
  }, [refreshKey, requestUrl]);

  function selectWatch(id: string) {
    if (id === selectedWatchId) return;
    setSelectedWatchId(id);
    setType("all");
    setSource("all");
    setAuditDecision(defaultAuditDecision(watches.find((watch) => watch.id === id)?.dossier_kind));
    setAuditPrice("all");
    setAuditNovelty("all");
    setSelectedAuditDay(null);
    setItems([]);
    setAudits([]);
    setDismissals([]);
    setPage(emptyPage);
    setTodayCount(null);
    setState("loading");
    setError("");
  }

  // 「疑似同款」分区的收敛出口。判定按来源商品 ID 回写，因为候选还不是匹配，
  // 库里没有 listing_id 可点——这正是旧的「已忽略」按钮够不着这批商品的原因。
  async function updateDismissal(
    run: PresentedAuditRun,
    listing: PresentedAuditListing,
    reason: DismissalReason | "restore",
  ) {
    const key = `${run.watch_binding_id}:${listing.source_id}:${listing.source_item_id}`;
    if (dismissBusyKey) return;
    setDismissBusyKey(key);
    setError("");
    try {
      await apiFetch(`/api/watch-bindings/${run.watch_binding_id}/dismissals`, {
        method: "POST",
        body: JSON.stringify({ sourceId: listing.source_id, sourceItemId: listing.source_item_id, reason }),
      });
      setDismissals((current) => {
        const rest = current.filter((entry) => `${entry.watch_binding_id}:${entry.source_id}:${entry.source_item_id}` !== key);
        if (reason === "restore") return rest;
        return [...rest, {
          watch_binding_id: run.watch_binding_id,
          source_id: listing.source_id,
          source_item_id: listing.source_item_id,
          reason,
          created_at: new Date().toISOString(),
        }];
      });
    } catch (reasonError) {
      setError(apiErrorMessage(reasonError, "同款判定回写失败"));
    } finally {
      setDismissBusyKey(null);
    }
  }

  function selectType(value: string) {
    if (value === type) return;
    setType(value);
    setError("");
  }

  function selectSource(value: string) {
    if (value === source) return;
    setSource(value);
    setSelectedAuditDay(null);
    setState("loading");
    setError("");
  }

  function selectAuditDay(day: string) {
    setSelectedAuditDay(day);
    requestAnimationFrame(() => auditListHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function loadMore() {
    if (!selectedWatchId || !page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const body = await apiFetch<ChangesResponse>(changeUrl(selectedWatchId, type, source, page.nextCursor));
      setItems((current) => [...current, ...body.items]);
      setPage(body.page);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早的商品变化读取失败");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="product-change-workbench reveal reveal-delay-1">
      <div className="product-change-layout">
        <aside className="paper-panel product-change-watch-picker" aria-label="选择关注档案">
          <header>
            <div>
              <p className="eyebrow">WATCH DOSSIERS</p>
              <h2>关注档案</h2>
            </div>
            <span className="status-pill">{watches.length} 个</span>
          </header>
          {watchState === "loading" && <p className="product-change-picker-state">正在读取关注档案…</p>}
          {watchState === "error" && <p className="product-change-picker-state">关注档案读取失败，请刷新重试。</p>}
          {watchState === "loaded" && !watches.length && <p className="product-change-picker-state">暂无关注档案。</p>}
        {watches.length > 0 && <ol>{watches.map((watch) => <li key={watch.id}><button type="button" data-selected={watch.id === selectedWatchId} onClick={() => selectWatch(watch.id)}><span>{dossierKindLabel(watch.dossier_kind)}</span><strong>{watch.name}</strong><small>{watch.active_binding_count}/{watch.binding_count} 个来源运行中 · {watch.enabled ? "档案已启用" : "档案已暂停"}</small></button></li>)}</ol>}
      </aside>

      <section className="paper-panel product-change-panel">
        <div className="panel-header event-panel-header">
          <div><p className="eyebrow">{selectedWatch ? dossierKindLabel(selectedWatch.dossier_kind) : "PRODUCT OBSERVATION LOG"}</p><h2>{selectedWatch ? `${selectedWatch.name} 的观测与变化` : "选择一份关注档案"}</h2></div>
          <div className="product-change-heading-actions">{selectedWatch && <Link href={`/watches/${selectedWatch.id}` as Route}>管理这份关注档案</Link>}<span className="status-pill">{state === "loaded" ? `${audits.length} 次巡回 · ${page.total} 条变化` : "读取中"}</span></div>
        </div>
        <div className="panel-body">
          {selectedWatch && <div className="event-filters product-change-filters" data-columns={isExactProduct || isKeywordWatch ? "3" : "2"} role="group" aria-label="筛选当前关注档案的巡回证据">
            <EditorialSelect
              compact
              index="01"
              label={isItemWatch ? "价格观测" : isKeywordWatch ? "相关性判断" : "同款判定"}
              caption={isItemWatch ? "按价格是否刷新" : isKeywordWatch ? "按关键词相关性" : "按同款判定结果"}
              value={auditDecision}
              options={auditDecisionOptions}
              onValueChange={(value) => setAuditDecision(value as AuditDecisionFilter)}
            />
            {isExactProduct && <EditorialSelect compact index="02" label="价格口径" caption="区分固定价与拍卖" value={auditPrice} options={priceFilterOptions} onValueChange={(value) => setAuditPrice(value as AuditPriceFilter)} />}
            {isKeywordWatch && <EditorialSelect compact index="02" label="首次 / 已见" caption="按来源商品 ID 精确比对" value={auditNovelty} options={keywordNoveltyOptions} onValueChange={(value) => setAuditNovelty(value as AuditNoveltyFilter)} />}
            <EditorialSelect compact index={isExactProduct || isKeywordWatch ? "03" : "02"} label="来源" caption="筛选巡回与事件" value={source} options={sourceOptions} onValueChange={selectSource} />
          </div>}
          {state === "idle" && <div className="event-empty-state"><RadioTower aria-hidden="true" /><div><h3>请选择左侧关注档案</h3><p>选择后可核对每次巡回抓到了什么，以及最终生成了哪些变化。</p></div></div>}
          {state === "loading" && <div className="event-loading-state" role="status"><span aria-hidden="true" /><div><strong>正在读取巡回证据</strong><p>正在汇总来源运行、商品明细、判定状态和变化事件。</p></div></div>}
          {state === "error" && <div className="event-error-state" role="alert"><CircleAlert aria-hidden="true" /><div><h3>商品变化读取失败</h3><p>{error}</p><button type="button" className="ghost-button" onClick={() => { setState("loading"); setError(""); setRefreshKey((current) => current + 1); }}><RefreshCw size={14} aria-hidden="true" />重新读取</button></div></div>}
          {state === "loaded" && (
            <>
              <section className="product-run-audit" aria-labelledby="product-run-audit-heading">
                <header>
                  <div><p className="eyebrow">COLLECTION AUDIT</p><h3 id="product-run-audit-heading">{isItemWatch ? "价格巡回记录" : "巡回抓取与商品明细"}</h3><p>{isItemWatch ? "这里逐次记录当前价格以及它与上次观测是否相同；没有变化也会留下运行证据。" : isKeywordWatch ? "这里把关键词相关性与来源商品 ID 的首次/历史状态分开保存；历史已见商品仍是相关商品，只是不重复发送上新。" : "这里展示系统实际执行了什么。数量、商品、来源状态与同款判定都会保留，即使没有命中通知。"}</p></div>
                  <span><Database size={14} aria-hidden="true" />显示 {filteredAuditListings} / {totalAuditListings} 件</span>
                </header>
                {isExactProduct && dailyAuditSummaries.length > 0 && <section className="product-audit-days" aria-labelledby="product-audit-days-heading">
                  <header><div><p className="eyebrow">DAILY TOTAL</p><h4 id="product-audit-days-heading">每日最新巡回汇总</h4></div><p>同一天同一来源只取最新一轮，避免手动复跑重复计数。</p></header>
                  <ol>{dailyAuditSummaries.map((day) => <li key={day.day} data-selected={day.day === selectedAuditDay}>
                    <button type="button" aria-pressed={day.day === selectedAuditDay} onClick={() => selectAuditDay(day.day)}>
                      <time dateTime={day.day}>{day.day.replaceAll("-", "/")}</time>
                      <span>查看明细</span>
                    </button>
                    <dl>
                      <div><dt>完成来源</dt><dd>{day.runs}</dd></div>
                      <div><dt>来源返回</dt><dd>{day.sourceReturns}</dd></div>
                      <div><dt>同款 / 待定</dt><dd>{day.retainedListings}</dd></div>
                      <div><dt>固定价同款</dt><dd>{day.confirmedFixed}</dd></div>
                      <div><dt>拍卖同款</dt><dd>{day.confirmedAuctions}</dd></div>
                    </dl>
                  </li>)}</ol>
                </section>}
                {audits.length > 0 && <div className="product-audit-list-heading" ref={auditListHeadingRef}>
                  <div><strong>{selectedAuditDay ? `${selectedAuditDay.replaceAll("-", "/")} 巡回明细` : "全部日期巡回明细"}</strong><span>{visibleAudits.length} 次巡回 · {filteredAuditListings} 件符合当前筛选</span></div>
                  {selectedAuditDay && <button type="button" onClick={() => setSelectedAuditDay(null)}>查看全部日期</button>}
                </div>}
                {audits.length === 0 && <p className="product-run-audit-empty">还没有可展示的巡回。新一轮运行完成后，会在这里留下逐件商品证据。</p>}
                {filteredAudits.length > 0 && visibleAudits.length === 0 && <p className="product-run-audit-empty">当天在当前筛选下没有匹配的巡回记录。</p>}
                {visibleAudits.length > 0 && <div className="product-run-audit-list">{visibleAudits.map((run, index) => (
                  <details key={run.id} className="product-run-record" open={index === 0 ? true : undefined}>
                    <summary>
                      <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time>
                      <div><strong>{run.source_display_name}</strong><small>{run.trigger_type === "cron" ? "定时巡回" : run.trigger_type === "manual" ? "手动巡回" : run.trigger_type === "confirmation" ? (isItemWatch ? "降价复核" : "商品复核") : "重试任务"}</small></div>
                      <span className={`status-pill ${run.status === "success" ? "good" : "warn"}`}>{runStatusLabel(run.status)}</span>
                      {isItemWatch
                        ? <dl>
                            <div><dt>观测价格</dt><dd>{run.listings[0] ? formatJpy(run.listings[0].current_price ?? undefined) : "暂无明细"}</dd></div>
                            <div><dt>上次价格</dt><dd>{run.listings[0] ? formatJpy(run.listings[0].previous_price ?? undefined) : "暂无明细"}</dd></div>
                            <div><dt>价格结果</dt><dd>{!run.listings[0] ? "无法比较" : run.listings[0].price_observation === "changed" ? "已刷新" : run.listings[0].price_observation === "unchanged" ? "未变化" : "首次"}</dd></div>
                            <div><dt>商品状态</dt><dd>{run.listings[0] ? availabilityLabels[run.listings[0].availability] ?? run.listings[0].availability : "暂无明细"}</dd></div>
                          </dl>
                        : isKeywordWatch
                          ? <dl>
                              <div><dt>来源返回</dt><dd>{run.raw_result_count ?? run.result_count}</dd></div>
                              <div><dt>首次发现</dt><dd>{run.listings.filter((listing) => listing.is_first_observation === 1).length}</dd></div>
                              <div><dt>历史已见</dt><dd>{run.listings.filter((listing) => listing.is_first_observation === 0).length}</dd></div>
                              <div><dt>关键词相关</dt><dd>{run.decisionCounts.confirmed}</dd></div>
                            </dl>
                          : <dl>
                            <div><dt>来源返回</dt><dd>{run.raw_result_count ?? run.result_count}</dd></div>
                            <div><dt>筛选显示</dt><dd>{run.listings.length}</dd></div>
                            <div><dt>确认同款</dt><dd>{run.decisionCounts.confirmed}</dd></div>
                            <div><dt>排除/待定</dt><dd>{run.decisionCounts.rejected + run.decisionCounts.uncertain + run.decisionCounts.pending}</dd></div>
                          </dl>}
                    </summary>
                    {run.error_message && <p className="product-run-error">{run.error_code ?? "run_error"}：{run.error_message}</p>}
                    {run.listings.length === 0
                      ? <p className="product-run-no-items">{run.total_listing_count > 0
                          ? isItemWatch
                            ? `本轮已保存 ${run.total_listing_count} 件价格观测，但当前价格筛选命中 0 件。可切换为“全部价格观测”查看。`
                            : `本轮已保存 ${run.total_listing_count} 件逐件证据，但当前商品判定或价格口径命中 0 件。可调整筛选查看。`
                          : run.result_count > 0
                            ? run.trigger_type === "confirmation"
                              ? `${run.status === "success" ? "本次复核已完成" : "本次复核已有商品返回"}，但未保存逐件明细。复核会再次读取商品价格与库存；通知结果请查看通知中心。`
                              : "本次已读取商品，但未保存逐件明细；这里只展示数量与运行状态。"
                            : "这次巡回没有解析到商品。"}</p>
                      : <ol className="product-run-listings">{run.listings.map((listing) => {
                        const dismissalKey = `${run.watch_binding_id}:${listing.source_id}:${listing.source_item_id}`;
                        const dismissal = dismissalByKey.get(dismissalKey);
                        const dismissBusy = dismissBusyKey === dismissalKey;
                        return (
                        <li key={`${run.id}:${listing.source_id}:${listing.source_item_id}`} data-decision={listing.decision_status} data-price-basis={listing.price_basis} data-dismissed={dismissal ? dismissal.reason : undefined}>
                          <span className="product-run-listing-index">{String(listing.ordinal).padStart(2, "0")}</span>
                          <div className="product-run-listing-media">
                            {listing.image_url
                              ? <Image src={listing.image_url} alt={listing.title} width={144} height={144} sizes="(max-width: 520px) 64px, 78px" />
                              : <div role="img" aria-label="商品图片暂缺" />}
                          </div>
                          <div className="product-run-listing-main">
                            <a href={listing.canonical_url} target="_blank" rel="noreferrer">{listing.title}<ExternalLink size={12} aria-hidden="true" /></a>
                            <small>{listing.source_item_id} · {availabilityLabels[listing.availability] ?? listing.availability} · {listing.item_condition}{listing.price_basis === "auction_current_bid" ? " · 拍卖进行中" : ""}</small>
                            <p>{listing.decision_reason ?? "判定证据暂缺"}</p>
                          </div>
                          <div className="product-run-listing-price" data-auction={priceBasisLabel(listing).auction}>
                            <span>{priceBasisLabel(listing).label}</span>
                            <strong>{formatJpy(listing.current_price ?? undefined)}</strong>
                            <small>{priceBasisLabel(listing).note}</small>
                            {isItemWatch && <small>{listing.price_observation === "changed" ? `上次 ${formatJpy(listing.previous_price ?? undefined)}` : listing.price_observation === "unchanged" ? "与上次相同" : "首次价格观测"}</small>}
                          </div>
                          <div className="product-run-listing-statuses">
                            <span className="status-pill">{isKeywordWatch ? keywordDecisionLabels[listing.decision_status] : exactDecisionLabels[listing.decision_status]}</span>
                            {isKeywordWatch && <span className={`status-pill ${listing.is_first_observation === 1 ? "good" : ""}`}>{listing.is_first_observation === 1 ? "首次发现" : `历史已见 · ${listing.observation_count} 次`}</span>}
                            {isExactProduct && (dismissal
                              ? <div className="product-run-listing-verdict" data-state="dismissed">
                                  <span>{dismissalCopy[dismissal.reason].label}</span>
                                  <small>{dismissalCopy[dismissal.reason].detail}</small>
                                  <button type="button" disabled={dismissBusy} onClick={() => void updateDismissal(run, listing, "restore")}>
                                    <Undo2 size={11} aria-hidden="true" />撤销
                                  </button>
                                </div>
                              : <div className="product-run-listing-verdict">
                                  <button type="button" disabled={dismissBusy} onClick={() => void updateDismissal(run, listing, "not_same_product")}>
                                    <Ban size={11} aria-hidden="true" />不是同款
                                  </button>
                                  <button type="button" disabled={dismissBusy} onClick={() => void updateDismissal(run, listing, "too_expensive")}>
                                    <Wallet size={11} aria-hidden="true" />太贵了
                                  </button>
                                </div>)}
                          </div>
                        </li>
                        );
                      })}</ol>}
                  </details>
                ))}</div>}
              </section>

              <section className="product-change-events" aria-labelledby="product-change-events-heading">
                <header><div><p className="eyebrow">CONFIRMED CHANGES</p><h3 id="product-change-events-heading">{isItemWatch ? "价格与库存变化事件" : "确认变化事件"}</h3><p>{isItemWatch ? "这里仅列出价格或库存真正发生变化的事件；上方价格巡回记录会保留每一次未变化观测。" : "这是巡回证据经过规则判断后真正成立的变化；没有事件不代表系统没有运行。"}</p></div><span>{items.length} / {page.total}</span></header>
                {isExactProduct && selectedWatchId && <ConfirmedOfferRoster key={`${selectedWatchId}:${refreshKey}`} profileId={selectedWatchId} />}
                <div className="product-change-event-filter"><EditorialSelect compact index="E1" label="事件类型" caption="只筛选本区事件" value={type} options={eventTypeOptions} onValueChange={selectType} /></div>
                {items.length > 0 && <div className="product-change-log" role="region" aria-label={`${selectedWatch?.name ?? "当前档案"}的商品变化，已显示 ${items.length} 条，共 ${page.total} 条`} tabIndex={0}><ol>{items.map((item) => {
                  const presentation = presentEvent(item.event_type, item.payload_json, item.source_display_name, selectedWatch?.dossier_kind);
                  return <li key={item.id} data-tone={presentation.tone}>
                    <div className="product-change-event-meta">
                      <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
                      <span className={`status-pill ${toneClass(presentation.tone)}`}>{presentation.label}</span>
                    </div>
                    <div className="product-change-fact">
                      <strong>{item.title || "商品标题暂缺"}</strong>
                      <p>{presentation.headline}</p>
                      <small>{presentation.detail}</small>
                    </div>
                    <div className="product-change-source">
                      <span>{item.source_display_name || item.source_id || "来源未记录"}</span>
                      {item.canonical_url && <a href={item.canonical_url} target="_blank" rel="noreferrer">打开来源 <ExternalLink size={12} aria-hidden="true" /></a>}
                    </div>
                  </li>;
                })}</ol></div>}
                {items.length === 0 && <div className="event-empty-state"><RadioTower aria-hidden="true" /><div><h3>本档案暂时没有确认变化</h3><p>请以上方巡回记录核对系统每天抓到了什么；事件区只记录确认成立的事实。</p></div></div>}
                <div className="event-pagination"><p>本档案今日确认 {todayCount ?? "—"} 条变化；已显示 {items.length} / {page.total} 条。</p>{page.hasMore && <button type="button" className="ghost-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "继续加载更早记录"}</button>}</div>
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  </div>
  );
}
