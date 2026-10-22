"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { ArrowUpRight, ExternalLink, Radio, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatJpy } from "@jpgr/core";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import { intervalText } from "@/lib/profile-change-log";
import { LoadStateNotice, type LoadState } from "@/components/load-state-notice";
import { isRakutenSource, RakutenCredit } from "@/components/rakuten-credit";

interface ListingRow {
  id: string;
  title: string;
  source_id: string;
  source_item_id: string;
  image_url: string | null;
  canonical_url: string;
  current_price: number | null;
  availability: string;
  item_condition: string;
  last_changed_at: string;
  brand: string | null;
  manufacturer: string | null;
  jan: string | null;
  isbn: string | null;
  release_date: string | null;
  watch_binding_id: string;
  watch_profile_id: string;
  watch_enabled: number;
  schedule_interval_minutes: number;
  next_run_at: string | null;
}

// 商品下架后采集程序每天确认一次是否恢复，满 15 天仍看不到就自动暂停
// （apps/collector 的 UNAVAILABLE_ITEM_PAUSE_DAYS）。这里按商品状态说清楚是哪一种，
// 别让一件已经没了的商品挂着绿色的「运行中」和原来的频率。
function watchStatusLabel(item: ListingRow): string {
  const gone = item.availability === "unavailable";
  if (item.watch_enabled) return gone ? "商品已下架或暂停出售" : "巡回监控运行中";
  return gone ? "商品已下架，监控已暂停" : "巡回监控已暂停";
}

function watchScheduleText(item: ListingRow): string {
  const next = item.next_run_at ? ` · 下次 ${tokyoFull(item.next_run_at)}` : "";
  if (!item.watch_enabled) {
    return item.availability === "unavailable" ? "需要继续盯可在档案里恢复" : "规则已暂停";
  }
  if (item.availability === "unavailable") return `每天确认一次是否恢复${next}`;
  return `${intervalText(item.schedule_interval_minutes) ?? ""}${next}`;
}

export function ListingManager() {
  const [items, setItems] = useState<ListingRow[]>([]);
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");

  const listingsUrl = (q: string) => `/api/listings${q ? `?q=${encodeURIComponent(q)}` : ""}`;

  function startLoad(q: string) {
    setLoadState("loading");
    setLoadError("");
    apiFetch<{ items: ListingRow[] }>(listingsUrl(q))
      .then((body) => {
        setItems(body.items);
        setLoadState("loaded");
      })
      .catch((reason: unknown) => {
        setLoadError(apiErrorMessage(reason));
        setLoadState("error");
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ items: ListingRow[] }>("/api/listings", { signal: controller.signal })
      .then((body) => {
        setItems(body.items);
        setLoadState("loaded");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(apiErrorMessage(reason));
        setLoadState("error");
      });
    return () => controller.abort();
  }, []);

  const groups = Array.from(new Set(items.map((item) => item.source_id)))
    .map((sourceId) => ({ sourceId, items: items.filter((item) => item.source_id === sourceId) }));

  return (
    <div className="paper-panel listing-index-panel reveal reveal-delay-1">
      <div className="panel-header listing-panel-header">
        <div className="listing-header-main">
          <div className="listing-title-row">
            <h2>已收录商品</h2>
            <span className="status-pill">{items.length} 件</span>
          </div>
          <p className="listing-header-subtitle">
            集中管理雷达所监控的具体商品单品与最新巡回状态
          </p>
        </div>
        <form className="listing-search-bar" onSubmit={(event) => { event.preventDefault(); startLoad(query); }}>
          <div className="search-input-wrapper">
            <Search size={14} className="search-icon" aria-hidden="true" />
            <input
              className="search-input"
              aria-label="按标题或来源商品 ID 搜索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按标题或来源商品 ID 搜索..."
            />
            {query && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => { setQuery(""); startLoad(""); }}
                aria-label="清除搜索"
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <button type="submit" className="search-submit-btn">
            筛选
          </button>
        </form>
      </div>

      <div className="panel-body listing-panel-body">
        <div className="public-source-stack">
          {groups.map((group) => (
            <section className="source-result-group" key={group.sourceId}>
              <div className="source-result-heading">
                <div className="source-heading-left">
                  <span className="source-platform-tag">{group.sourceId}</span>
                  <span className="source-count-pill">{group.items.length} 件</span>
                </div>
              </div>
              {isRakutenSource(group.sourceId) && <RakutenCredit />}
              <div className="listing-grid">
                {group.items.map((item) => (
                  <article className="listing-card" key={item.id} data-watched="true">
                    <div className="listing-card-media">
                      {item.image_url ? (
                        <Image
                          src={item.image_url}
                          alt={item.title}
                          width={280}
                          height={210}
                          className="listing-thumb"
                        />
                      ) : (
                        <div className="listing-placeholder" aria-label="商品图片暂缺" />
                      )}
                      <div className="listing-media-badges">
                        <span className="media-source-tag">{item.source_id}</span>
                        <span className={`media-status-tag ${item.availability === "AVAILABLE" ? "is-available" : ""}`}>
                          {item.availability}
                        </span>
                      </div>
                    </div>

                    <div className="listing-card-body">
                      <div className="listing-card-primary">
                        <h3 className="listing-title" title={item.title}>
                          {item.title}
                        </h3>
                        <div className="listing-price-tag">
                          <strong>{formatJpy(item.current_price ?? undefined)}</strong>
                        </div>
                      </div>

                      <div className="listing-meta-strip">
                        <span className="listing-meta-item mono">ID: {item.source_item_id}</span>
                        {(item.brand || item.manufacturer) && (
                          <span className="listing-meta-item">{item.brand || item.manufacturer}</span>
                        )}
                        {(item.jan || item.isbn) && (
                          <span className="listing-meta-item mono">{item.jan ? `JAN ${item.jan}` : `ISBN ${item.isbn}`}</span>
                        )}
                        <span className="listing-meta-item muted">最后变化 {tokyoFull(item.last_changed_at)}</span>
                      </div>

                      <div className="listing-watch-card" data-state={item.availability === "unavailable" ? "gone" : item.watch_enabled ? "active" : "paused"}>
                        <div className="watch-card-header">
                          <span className="watch-status-dot" aria-hidden="true" />
                          <Radio size={13} className="watch-icon" aria-hidden="true" />
                          <span className="watch-status-label">{watchStatusLabel(item)}</span>
                        </div>
                        <span className="watch-schedule-text">{watchScheduleText(item)}</span>
                      </div>

                      <div className="action-row listing-card-actions">
                        <Link className="primary-button button-link listing-action-btn" href={`/watches/${item.watch_profile_id}` as Route}>
                          管理关注档案 <ArrowUpRight size={13} aria-hidden="true" />
                        </Link>
                        <a className="ghost-button listing-action-btn" href={item.canonical_url} target="_blank" rel="noreferrer">
                          打开来源商品 <ExternalLink size={13} aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
        <LoadStateNotice
          state={loadState}
          title="商品库读取失败"
          loadingTitle="正在读取商品库"
          loadingHint="结果返回后再判断是否为空。"
          error={loadError}
          onRetry={() => { startLoad(query); }}
        />
        {loadState === "loaded" && !items.length && (
          <div className="empty-state">
            <p>还没有单品档案。请从搜索结果中选择真正需要长期盯住的具体商品建立档案。</p>
          </div>
        )}
      </div>
    </div>
  );
}
