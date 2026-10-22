"use client";

import type { Route } from "next";
import Link from "next/link";
import { ArrowLeft, Braces, Download, Eye, FileClock } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";
import {
  coverageNames,
  searchHistoryStatus,
  searchRunStatus,
  sourceNames,
  type RawCaptureState,
  type RawSourceCapture,
  type SearchHistoryItem,
  type SearchRunGroup,
} from "@/lib/search-run";

interface SearchRunResponse {
  history: SearchHistoryItem;
  groups: SearchRunGroup[];
}

function CaptureDetails({ capture }: { capture: RawSourceCapture }) {
  return (
    <details className="search-run-capture">
      <summary>#{capture.ordinal} · HTTP {capture.responseStatus ?? "无响应"} · {capture.payloadKind} · {capture.payloadBytes.toLocaleString("zh-CN")} bytes</summary>
      <dl>
        <div><dt>请求</dt><dd>{capture.requestMethod} {capture.requestUrl}</dd></div>
        {capture.responseUrl && <div><dt>响应</dt><dd>{capture.responseUrl}</dd></div>}
        <div><dt>采集</dt><dd>{tokyoFull(capture.capturedAt)} · {capture.durationMs}ms</dd></div>
        <div><dt>内容哈希</dt><dd>{capture.contentHash}</dd></div>
      </dl>
      {capture.error && <p className="error-copy">{capture.error}</p>}
      <pre>{capture.rawPayload ?? "该响应没有可显示的文本正文。"}</pre>
      {capture.truncated && <p>正文超过单次安全边界；数据库保存了前 1.8 MB，并明确标记为 truncated。</p>}
    </details>
  );
}

export function SearchRunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<SearchRunResponse>();
  const [rawStates, setRawStates] = useState<Partial<Record<SearchRunGroup["sourceId"], RawCaptureState>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<SearchRunResponse>(`/api/search/preview?historyId=${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(setRun)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "运行详情读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  async function loadRawCaptures(sourceId: SearchRunGroup["sourceId"]) {
    if (rawStates[sourceId]?.status === "loading") return;
    setRawStates((states) => ({ ...states, [sourceId]: { status: "loading" } }));
    try {
      const result = await apiFetch<{ items: RawSourceCapture[] }>(
        `/api/search/raw?historyId=${encodeURIComponent(id)}&sourceId=${encodeURIComponent(sourceId)}`,
      );
      setRawStates((states) => ({ ...states, [sourceId]: { status: "ready", items: result.items } }));
    } catch (reason) {
      setRawStates((states) => ({
        ...states,
        [sourceId]: { status: "error", message: reason instanceof Error ? reason.message : "原始响应读取失败" },
      }));
    }
  }

  if (loading) return <div className="search-run-state"><FileClock size={22} aria-hidden="true" /><p>正在读取这次搜索的运行证据…</p></div>;
  if (error || !run) return <div className="search-run-state" data-tone="bad"><FileClock size={22} aria-hidden="true" /><p>{error || "运行记录不存在"}</p><Link href={"/search/history" as Route}>返回搜索记录</Link></div>;

  const status = searchHistoryStatus(run.history.status);
  const plan = run.history.plan;

  return (
    <article className="search-run-detail">
      <header className="search-run-overview">
        <div className="search-run-overview-copy">
          <span className="search-run-overview-meta"><time dateTime={run.history.searchedAt}>{tokyoFull(run.history.searchedAt)}</time><em className={`source-state ${status.tone}`}>{status.label}</em></span>
          <p>{run.history.mode === "exact_product" ? "精确同款搜索" : "宽泛关键词搜索"}</p>
          <h2>{run.history.query}</h2>
          <span>{run.history.resultCount.toLocaleString("zh-CN")} 件来源候选 · {run.groups.length} 个来源回应</span>
        </div>
        <div className="search-run-overview-actions">
          <Link href={"/search/history" as Route}><ArrowLeft size={14} aria-hidden="true" />全部搜索记录</Link>
          {run.history.hasSnapshot && <Link href={`/search?historyId=${encodeURIComponent(run.history.id)}` as Route}><Eye size={14} aria-hidden="true" />恢复结果</Link>}
          <a href={`/api/search/raw/export?historyId=${encodeURIComponent(run.history.id)}`} download><Download size={14} aria-hidden="true" />导出全部原始响应</a>
        </div>
      </header>

      <section className="search-run-section" aria-labelledby="search-run-sources-title">
        <header><div><p className="eyebrow">SOURCE OUTCOMES</p><h3 id="search-run-sources-title">来源运行摘要</h3></div><span>状态、耗时与失败在这里解释；商品判断回到结果页</span></header>
        <div className="search-run-source-list">
          {run.groups.map((group) => {
            const sourceStatus = searchRunStatus(group);
            return (
              <article key={group.sourceId} data-tone={sourceStatus.tone}>
                <header><strong>{sourceNames[group.sourceId]}</strong><em className={`source-state ${sourceStatus.tone}`}>{sourceStatus.label}</em></header>
                <dl>
                  <div><dt>耗时</dt><dd>{group.durationMs === undefined ? "未记录" : `${(group.durationMs / 1_000).toFixed(1)}s`}</dd></div>
                  <div><dt>覆盖</dt><dd>{coverageNames[group.coverage ?? "unknown"]}</dd></div>
                  <div><dt>取页</dt><dd>{group.requestEvidence?.pagesFetched ?? 1} 页</dd></div>
                  <div><dt>标准化</dt><dd>{group.requestEvidence?.normalizedResultCount ?? group.listings.length} 件</dd></div>
                </dl>
                {group.error && <p data-tone="bad">{group.error}</p>}
                {group.retryAt && <p>预计可重试：{tokyoFull(group.retryAt)}</p>}
                {group.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
              </article>
            );
          })}
        </div>
      </section>

      {plan && (
        <section className="search-plan-evidence search-run-section" aria-labelledby="search-run-plan-title">
          <header><div><p className="eyebrow">QUERY PLAN</p><h3 id="search-run-plan-title">{plan.mode === "exact_product" ? "本次商品名查询计划" : "本次来源查询"}</h3></div><span>{plan.variants.filter((variant) => variant.lane === "source_native").length} 条来源查询{plan.deepSearch ? ` · ${plan.variants.filter((variant) => variant.lane === "web_search").length} 条手动网页补漏` : ""}</span></header>
          <ol>{plan.variants.map((variant) => <li key={variant.id} data-lane={variant.lane}><code>{variant.kind}</code><span>{variant.query}</span><em>权重 {variant.weight.toFixed(2)}</em></li>)}</ol>
          {plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </section>
      )}

      <section className="search-run-section" aria-labelledby="search-run-evidence-title">
        <header><div><p className="eyebrow">REQUEST EVIDENCE</p><h3 id="search-run-evidence-title">请求与分页证据</h3></div><span>这些字段用于排查覆盖率，不参与商品排序</span></header>
        <div className="search-run-evidence-table">
          {run.groups.map((group) => (
            <p key={group.sourceId}>
              <strong>{sourceNames[group.sourceId]}</strong>
              <span>{group.totalAvailable === undefined ? `已读取 ${group.listings.length} 件；上游未提供可信总数` : `已读取 ${group.listings.length} / 上游 ${group.totalAvailable} 件`}</span>
              <span>{group.requestEvidence
                ? `原始 ${group.requestEvidence.keywordRawResultCount ?? group.requestEvidence.rawResultCount} · 标准化 ${group.requestEvidence.normalizedResultCount} · ${group.requestEvidence.pagesFetched} 页`
                : "来源未返回结构化请求证据"}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="raw-source-panel search-run-section" aria-labelledby="search-run-raw-title">
        <header><Braces size={16} aria-hidden="true" /><div><p className="eyebrow">RAW CAPTURES</p><h3 id="search-run-raw-title">解析与 AI 清洗前的来源响应</h3></div><a href={`/api/search/raw/export?historyId=${encodeURIComponent(run.history.id)}`} download><Download size={14} aria-hidden="true" />导出全部</a></header>
        <p className="search-run-raw-note">响应正文按来源惰性读取；数据库保留内容哈希、采集时间和截断标记。打开这里不会重新访问来源。</p>
        <div className="raw-source-actions">
          {run.groups.map((group) => {
            const state = rawStates[group.sourceId];
            return (
              <div key={group.sourceId} className="raw-source-entry">
                <button type="button" onClick={() => void loadRawCaptures(group.sourceId)} disabled={state?.status === "loading"}>
                  {state?.status === "loading" ? "读取中…" : `查看 ${sourceNames[group.sourceId]} 原始响应`}
                </button>
                {state?.status === "error" && <p className="error-copy">{state.message}</p>}
                {state?.status === "ready" && state.items.length === 0 && <p>本来源这一轮没有发出可捕获的上游请求。</p>}
                {state?.status === "ready" && state.items.map((capture) => <CaptureDetails key={capture.id} capture={capture} />)}
              </div>
            );
          })}
        </div>
      </section>
    </article>
  );
}
