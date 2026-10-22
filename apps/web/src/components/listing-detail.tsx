"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import {
  ArrowLeft,
  ArrowUpRight,
  BellRing,
  Clock3,
  ExternalLink,
  History,
  Radio,
  ScanSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { canCreateItemPriceWatch, formatJpy } from "@jpgr/core";
import { productFactsSchema } from "@jpgr/validation";
import { apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import { isRakutenSource, RakutenCredit } from "@/components/rakuten-credit";

interface Listing {
  id: string;
  title: string;
  source_id: string;
  canonical_url: string;
  image_url: string | null;
  seller_name: string | null;
  shop_name: string | null;
  current_price: number | null;
  original_price: number | null;
  identity_scope: string;
  availability: string;
  item_condition: string;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  jan: string | null;
  isbn: string | null;
  model_number: string | null;
  brand: string | null;
  manufacturer: string | null;
  release_date: string | null;
  preorder_deadline: string | null;
  product_facts_json: string | null;
}

interface Snapshot {
  id: string;
  price: number | null;
  availability: string;
  observed_at: string;
}

interface EventRow {
  id: string;
  event_type: string;
  status: string;
  created_at: string;
}

interface WatchRow {
  profile_id: string;
  binding_id: string;
  enabled: number;
  profile_enabled: number;
  schedule_interval_minutes: number;
  next_run_at: string;
}

interface ListingDetailBody {
  listing: Listing;
  snapshots: Snapshot[];
  events: EventRow[];
  watches: WatchRow[];
}

const availabilityLabels: Record<string, string> = {
  available: "在售",
  sold_out: "已售出",
  unavailable: "当前不可购买",
  preorder: "预售",
  backorder: "等待补货",
  unknown: "库存未确认",
};

const eventTypeLabels: Record<string, string> = {
  new_listing: "首次进入监控视野",
  price_drop: "价格下降",
  price_rise: "价格上涨",
  target_price: "达到目标价",
  restock: "恢复可购",
  sold_out: "已售出",
  source_error: "来源异常",
  watch_completed: "监控完成",
  morning_digest: "早间摘要",
};

const eventStatusLabels: Record<string, string> = {
  pending: "待发送",
  sending: "发送中",
  sent: "已发送",
  failed: "发送失败",
  suppressed: "已抑制",
};

const formatDateTime = tokyoFull;

function fetchListingDetail(id: string, signal?: AbortSignal) {
  return apiFetch<ListingDetailBody>(`/api/listings/${id}`, { signal });
}

function parseProductFacts(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = productFactsSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function PriceEvidence({ snapshots, points }: { snapshots: Snapshot[]; points: string }) {
  if (snapshots.length === 0) {
    return (
      <div className="record-empty-evidence">
        <History aria-hidden="true" />
        <div><h3>还没有价格快照</h3><p>第一次真实观察会建立基线；没有证据时不会绘制一条看似完整的曲线。</p></div>
      </div>
    );
  }

  if (snapshots.length === 1) {
    const snapshot = snapshots[0]!;
    return (
      <article className="record-baseline">
        <span>01 / FIRST BASELINE</span>
        <div><p>观察时间</p><time dateTime={snapshot.observed_at}>{formatDateTime(snapshot.observed_at)}</time></div>
        <div><p>记录价格</p><strong>{formatJpy(snapshot.price ?? undefined)}</strong></div>
        <div><p>来源状态</p><strong>{availabilityLabels[snapshot.availability] ?? snapshot.availability}</strong></div>
        <small>目前只有一个真实观察点，因此保留为基线证据，不绘制没有比较意义的“价格曲线”。</small>
      </article>
    );
  }

  return (
    <>
      {points ? (
        <div className="record-chart-frame">
          <svg className="price-chart" viewBox="0 0 100 100" role="img" aria-label="最近一百次以内的价格变化曲线">
            <path d="M0 90 H100" />
            <polyline points={points} />
          </svg>
          <span>{formatDateTime(snapshots[0]!.observed_at)}</span>
          <strong>{snapshots.length} 个变化快照</strong>
          <span>{formatDateTime(snapshots.at(-1)!.observed_at)}</span>
        </div>
      ) : (
        <div className="record-chart-unavailable">
          <span>CHART HELD</span>
          <p>已有多条状态证据，但带价格的观察点还不足两个；先展示明细，不绘制误导性的曲线。</p>
        </div>
      )}
      <div className="record-timeline-scroll" role="region" aria-label="价格快照明细" tabIndex={0}>
        <div className="timeline record-timeline">
          {snapshots.map((snapshot, index) => (
            <div key={snapshot.id}>
              <span className="record-sequence">{String(index + 1).padStart(2, "0")}</span>
              <time dateTime={snapshot.observed_at}>{formatDateTime(snapshot.observed_at)}</time>
              <strong>{formatJpy(snapshot.price ?? undefined)}</strong>
              <span>{availabilityLabels[snapshot.availability] ?? snapshot.availability}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function ListingDetail({ id }: { id: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [watches, setWatches] = useState<WatchRow[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [watching, setWatching] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const body = await fetchListingDetail(id, signal);
    setListing(body.listing);
    setSnapshots(body.snapshots);
    setEvents(body.events);
    setWatches(body.watches);
    setError("");
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchListingDetail(id, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        setListing(body.listing);
        setSnapshots(body.snapshots);
        setEvents(body.events);
        setWatches(body.watches);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "商品记录读取失败");
      });
    return () => controller.abort();
  }, [id]);

  const points = useMemo(() => {
    const priced = snapshots.filter((snapshot): snapshot is Snapshot & { price: number } => snapshot.price !== null);
    if (priced.length < 2) return "";
    const values = priced.map((snapshot) => snapshot.price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    return priced
      .map((snapshot, index) => `${(index / (priced.length - 1)) * 100},${90 - ((snapshot.price - min) / range) * 80}`)
      .join(" ");
  }, [snapshots]);

  async function watch() {
    if (!listing || !canCreateItemPriceWatch(listing.availability, listing.identity_scope, listing.source_id)) return;
    setWatching(true);
    setNotice("");
    try {
      const result = await apiFetch<{ paused: boolean; alreadyWatching: boolean }>(`/api/listings/${id}/watch`, {
        method: "POST",
        body: JSON.stringify({
          name: listing.title,
          monitoringPurpose: "item_price",
          intervalMinutes: 180,
          minDropAmount: 100,
        }),
      });
      setNotice(
        result.alreadyWatching
          ? "这个来源商品 ID 已经有关联监控，没有重复创建。"
          : result.paused
            ? "关注档案已保存；来源启用后开始巡回。"
            : "已建立每 3 小时的价格与库存监控；频率与提醒请到关注档案管理。",
      );
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "关注档案建立失败";
      setNotice(message === "terminal_listing_requires_product_radar"
        ? "这件来源商品已经售出，不能建立单品降价监控；请改用同款重新出现雷达。"
        : message);
    } finally {
      setWatching(false);
    }
  }

  if (error) return <div className="empty-state"><p className="form-error">{error}</p></div>;
  if (!listing) return <div className="empty-state"><p>正在读取商品记录…</p></div>;

  const facts = parseProductFacts(listing.product_facts_json);
  const existingWatch = watches[0];
  const watchActive = existingWatch?.enabled === 1 && existingWatch.profile_enabled === 1;
  const terminalListing = !canCreateItemPriceWatch(listing.availability, listing.identity_scope, listing.source_id);

  return (
    <div className="detail-stack record-detail reveal reveal-delay-1">
      <section className="detail-route-context" aria-label="商品记录与关注档案的职责">
        <Link href="/listings"><ArrowLeft size={14} aria-hidden="true" />返回商品库</Link>
        <div data-current="true">
          <span>当前 / 商品记录</span>
          <strong>商品记录</strong>
          <p>来源身份、结构化事实、价格快照与这件商品自己的变化事件。</p>
        </div>
        <div>
          <span>关联 / 关注档案</span>
          <strong>关注档案</strong>
          <p>巡回频率、提醒、目标价、暂停与每次运行结果。</p>
          {existingWatch && <Link href={`/watches/${existingWatch.profile_id}` as Route}>打开关联关注档案 <ArrowUpRight size={13} aria-hidden="true" /></Link>}
        </div>
      </section>

      <section className="paper-panel listing-hero record-hero">
        <div className="listing-hero-media">
          {listing.image_url
            ? <Image src={listing.image_url} alt={listing.title} width={900} height={700} />
            : <div className="listing-placeholder" aria-label="商品图片暂缺" />}
        </div>
        <div className="panel-body">
          <p className="eyebrow">商品记录 · {listing.source_id} · {listing.item_condition}</p>
          <h2>{listing.title}</h2>
          <div className="record-current-fact">
            <span>{terminalListing ? "最后保存的来源公开标价" : "当前保存价格"}</span>
            <strong className="detail-price">{formatJpy(listing.current_price ?? undefined)}</strong>
            {listing.original_price !== null && <del>{formatJpy(listing.original_price)}</del>}
          </div>
          <p className="record-availability">{listing.shop_name || listing.seller_name || "来源未提供店铺"} · {availabilityLabels[listing.availability] ?? listing.availability}</p>
          {isRakutenSource(listing.source_id) && <RakutenCredit />}
          <dl className="record-observation-meta">
            <div><dt>首次发现</dt><dd>{formatDateTime(listing.first_seen_at)}</dd></div>
            <div><dt>最近看见</dt><dd>{formatDateTime(listing.last_seen_at)}</dd></div>
            <div><dt>最近变化</dt><dd>{formatDateTime(listing.last_changed_at)}</dd></div>
          </dl>
          {existingWatch && (
            <div className="record-watch-relation" data-state={watchActive ? "active" : "paused"}>
              <Radio size={15} aria-hidden="true" />
              <div>
                <span>关联关注档案</span>
                <strong>{watchActive ? "巡回运行中" : "巡回已暂停"}</strong>
                {watchActive && <small>每 {existingWatch.schedule_interval_minutes} 分钟 · 下次 {formatDateTime(existingWatch.next_run_at)}</small>}
              </div>
            </div>
          )}
          <div className="action-row record-primary-actions">
            <a className="primary-button button-link" href={listing.canonical_url} target="_blank" rel="noreferrer">打开来源商品 <ExternalLink size={14} aria-hidden="true" /></a>
            {existingWatch
              ? <Link className="ghost-button" href={`/watches/${existingWatch.profile_id}` as Route}>管理关注档案 <ArrowUpRight size={14} aria-hidden="true" /></Link>
              : terminalListing
                ? <Link className="ghost-button" href="/search"><ScanSearch size={14} aria-hidden="true" />搜索同款并建立上新雷达</Link>
                : <button className="ghost-button" type="button" disabled={watching} onClick={() => void watch()}><BellRing size={14} aria-hidden="true" />{watching ? "正在建立…" : "建立此单品价格与库存监控"}</button>}
          </div>
          {terminalListing && !existingWatch && <p className="terminal-listing-note">已售单品不会再发生可购买的降价；同款雷达会按设定频率重新搜索整个同款范围。</p>}
          {notice && <p className="form-note" role="status">{notice}</p>}
        </div>
      </section>

      {(facts || listing.jan || listing.isbn || listing.brand || listing.manufacturer) && (
        <section className="paper-panel record-evidence-section">
          <div className="panel-header">
            <div><p className="eyebrow">来源事实</p><h2>来源结构化事实</h2></div>
            <span className="status-pill">商品身份</span>
          </div>
          <div className="panel-body detail-summary">
            <p><strong>商品标识</strong><br />{listing.jan ? `JAN ${listing.jan}` : listing.isbn ? `ISBN ${listing.isbn}` : listing.model_number || facts?.identifiers?.sourceCatalogId || "来源未提供"}</p>
            <p><strong>品牌 / 厂商</strong><br />{[listing.brand || facts?.brand, listing.manufacturer || facts?.manufacturer].filter(Boolean).join(" / ") || "来源未提供"}</p>
            <p><strong>作品 / 系列</strong><br />{facts?.workTitle || facts?.series || "来源未提供"}</p>
            <p><strong>发售 / 预约</strong><br />{listing.release_date || facts?.releaseDate || "来源未提供"}{(listing.preorder_deadline || facts?.preorderDeadline) ? ` · 截止 ${listing.preorder_deadline || facts?.preorderDeadline}` : ""}</p>
            {facts?.characters?.length ? <p><strong>角色</strong><br />{facts.characters.join("、")}</p> : null}
            {facts?.specifications?.slice(0, 16).map((item) => <p key={`${item.name}:${item.value}`}><strong>{item.name}</strong><br />{item.value}</p>)}
          </div>
        </section>
      )}

      <section className="paper-panel record-evidence-section">
        <div className="panel-header record-panel-heading">
          <div><p className="eyebrow">价格证据</p><h2>价格快照</h2><p>本页有界读取最近 100 条价格或状态变化证据；每次巡回的成功、失败与耗时属于关注档案。</p></div>
          <span className="status-pill">最近 {snapshots.length} 条</span>
        </div>
        <div className="panel-body"><PriceEvidence snapshots={snapshots} points={points} /></div>
      </section>

      <section className="paper-panel record-evidence-section">
        <div className="panel-header record-panel-heading">
          <div><p className="eyebrow">商品变化</p><h2>该商品的变化事件</h2><p>这里只看这件商品；跨商品筛选与通知处理统一去“变化与通知”。</p></div>
          <div className="record-heading-actions">
            <span className="status-pill">{events.length} 条</span>
            <Link href="/events">打开变化与通知 <ArrowUpRight size={13} aria-hidden="true" /></Link>
          </div>
        </div>
        <div className="panel-body">
          {events.length > 0 ? (
            <div className="record-timeline-scroll" role="region" aria-label="该商品的变化事件明细" tabIndex={0}>
              <div className="timeline record-event-timeline">
                {events.map((event, index) => (
                  <div key={event.id}>
                    <span className="record-sequence">{String(index + 1).padStart(2, "0")}</span>
                    <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                    <strong>{eventTypeLabels[event.event_type] ?? event.event_type}</strong>
                    <span>{eventStatusLabels[event.status] ?? event.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="record-empty-evidence">
              <Clock3 aria-hidden="true" />
              <div><h3>还没有商品变化事件</h3><p>没有价格或库存变化就保持安静；来源巡回是否成功请到关联关注档案查看。</p></div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
