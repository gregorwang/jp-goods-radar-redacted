"use client";

import type { Route } from "next";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft, ChevronRight, Eye, FileClock } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { tokyoDateTime } from "@/lib/format-time";
import { searchHistoryStatus, sourceNames, type SearchHistoryItem } from "@/lib/search-run";

const PAGE_SIZE = 10;

export function SearchHistoryBrowser() {
  const [items, setItems] = useState<SearchHistoryItem[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<{ items: SearchHistoryItem[] }>("/api/search/preview", { signal: controller.signal })
      .then((body) => setItems(body.items))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "搜索记录读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (loading) return <div className="search-history-state"><FileClock size={22} aria-hidden="true" /><p>正在读取搜索记录…</p></div>;
  if (error) return <div className="search-history-state" data-tone="bad"><FileClock size={22} aria-hidden="true" /><p>{error}</p></div>;
  if (items.length === 0) return <div className="search-history-state"><FileClock size={22} aria-hidden="true" /><p>完成一次搜索后，这里会保存运行摘要与结果入口。</p><Link href="/search">开始第一次搜索</Link></div>;

  return (
    <section className="search-history-index" aria-labelledby="search-history-index-title">
      <header>
        <div><p className="eyebrow">SEARCH JOURNAL</p><h2 id="search-history-index-title">过去的搜索运行</h2></div>
        <span>最近 {items.length} 次 · 每页最多 {PAGE_SIZE} 次</span>
      </header>
      <div className="search-history-rows">
        {pageItems.map((item) => {
          const status = searchHistoryStatus(item.status);
          return (
            <article className="search-history-row" key={item.id}>
              <div className="search-history-row-index">
                <time dateTime={item.searchedAt}>{tokyoDateTime(item.searchedAt)}</time>
                <em className={`source-state ${status.tone}`}>{status.label}</em>
              </div>
              <div className="search-history-row-main">
                <p>{item.mode === "exact_product" ? "精确同款" : "宽泛关键词"}</p>
                <h3>{item.query}</h3>
                <div className="search-history-source-summary" aria-label="来源响应摘要">
                  {item.sourceSummary.map((source) => (
                    <span key={source.sourceId} data-status={source.status}>
                      <strong>{sourceNames[source.sourceId] ?? source.sourceId}</strong>
                      {source.resultCount} 件{source.durationMs === undefined || source.durationMs === null ? "" : ` · ${(source.durationMs / 1_000).toFixed(1)}s`}
                    </span>
                  ))}
                </div>
              </div>
              <div className="search-history-row-result">
                <strong>{item.resultCount.toLocaleString("zh-CN")}</strong><span>件来源候选</span>
                <small>{item.hasSnapshot ? `结果已保存${(item.pageCount ?? 1) > 1 ? ` · ${item.pageCount} 次取页` : ""}` : "仅保存搜索条件"}</small>
              </div>
              <div className="search-history-row-actions">
                {item.hasSnapshot ? (
                  <Link prefetch={false} href={`/search?historyId=${encodeURIComponent(item.id)}` as Route}><Eye size={14} aria-hidden="true" />恢复当时结果</Link>
                ) : <span aria-disabled="true"><Eye size={14} aria-hidden="true" />没有结果快照</span>}
                <Link prefetch={false} href={`/search/history/${item.id}` as Route}>查看运行详情<ArrowUpRight size={14} aria-hidden="true" /></Link>
              </div>
            </article>
          );
        })}
      </div>
      <nav className="search-history-pager" aria-label="搜索记录分页">
        <span>{(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, items.length)} / {items.length}</span>
        <button type="button" aria-label="上一页搜索记录" disabled={currentPage === 1} onClick={() => setPage(Math.max(1, currentPage - 1))}><ChevronLeft size={17} aria-hidden="true" /></button>
        <strong>第 {currentPage} / {pageCount} 页</strong>
        <button type="button" aria-label="下一页搜索记录" disabled={currentPage === pageCount} onClick={() => setPage(Math.min(pageCount, currentPage + 1))}><ChevronRight size={17} aria-hidden="true" /></button>
      </nav>
    </section>
  );
}
