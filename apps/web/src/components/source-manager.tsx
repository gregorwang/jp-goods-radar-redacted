"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, Clock3, Moon, RefreshCw, Route, SearchCheck, ShieldCheck } from "lucide-react";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoDateTime, tokyoFull } from "@/lib/format-time";
import { LoadStateNotice, type LoadState } from "@/components/load-state-notice";
import { rakutenMonitoringEnabledForSource, type RakutenRuntimePolicy } from "@/lib/rakuten-policy";

interface SourceRow {
  id: string;
  display_name: string;
  transport: string;
  official_api: number;
  enabled: number;
  adapter_available: boolean;
  monitoring_allowed: boolean;
  credential_status: string;
  health_status: string;
  request_route: "direct" | "mercari_service" | "managed_api";
  parser_version: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_http_status: number | null;
  last_error_message: string | null;
  last_signature_success_at: string | null;
  schema_version: string | null;
  last_403_at: string | null;
  last_429_at: string | null;
  last_container_count: number | null;
  last_page_bytes: number | null;
  captcha_detected: number;
  probe_status: "pending" | "running" | "passed" | "failed" | null;
  probe_started_at: string | null;
  probe_planned_end_at: string | null;
  probe_total_runs: number | null;
  probe_successful_runs: number | null;
  probe_field_total: number | null;
  probe_field_complete: number | null;
  probe_captcha_runs: number | null;
  probe_cpu_limit_runs: number | null;
  probe_login_required_runs: number | null;
  probe_decision_reason: string | null;
  probe_request_route: "direct" | "mercari_service" | null;
  health_24h: {
    totalRuns: number;
    attemptedRuns: number;
    requestSuccesses: number;
    parseSuccesses: number;
    abnormalEmptyRuns: number;
    fieldTotal: number;
    fieldComplete: number;
    latestState: "healthy" | "empty" | "suspected_degradation" | "failed" | "disabled" | "cooldown";
    latestObservedAt: string | null;
    freshnessSlaMinutes: number;
    fresh: boolean;
  } | null;
}

interface ProbeHistory {
  id: string;
  source_id: string;
  status: "pending" | "running" | "passed" | "failed";
  request_route: "direct" | "mercari_service";
  started_at: string | null;
  planned_end_at: string | null;
  total_runs: number;
  successful_runs: number;
  archived_at: string;
  archive_reason: "request_route_changed" | "manual_restart";
  next_request_route: "direct" | "mercari_service";
}

interface SourceHealthObservation {
  id: string;
  source_id: string;
  observed_at: string;
  state: "healthy" | "empty" | "suspected_degradation" | "failed" | "disabled" | "cooldown";
  request_succeeded: number;
  parse_succeeded: number;
  raw_result_count: number;
  normalized_result_count: number;
  page_depth: number;
  cursor_termination_reason: "exhausted" | "budget_reached" | "not_applicable" | "unknown";
  field_total: number;
  field_complete: number;
  http_status: number | null;
  abnormal_empty: number;
  error_code: string | null;
  error_message: string | null;
}

interface VerificationCheck {
  scope: "p0" | "final";
  check_key: string;
  label: string;
  status: "pending" | "passed" | "failed" | "blocked";
  verified_at: string | null;
}

interface QualificationRun {
  id: string;
  status: "running" | "passed" | "failed" | "blocked";
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

interface SourcesPayload {
  items: SourceRow[];
  resend: { configured?: boolean; recipient?: string };
  rakuten: RakutenRuntimePolicy;
  mercari: { independentServiceConfigured?: boolean; sourceRunnerConfigured?: boolean; sourceRunnerMode?: "off" | "shadow" | "primary"; requestRoute?: string };
  surugaya: {
    independentServiceConfigured?: boolean;
    sourceRunnerConfigured?: boolean;
    firecrawlFallbackConfigured?: boolean;
    standaloneProbeEnabled?: boolean;
    requestRoute?: string;
    firecrawlUsage?: {
      periodStartedAt?: string | null;
      periodEndsAt?: string | null;
      runtimeBudget?: number;
      runtimeCalls?: number;
      warningThreshold?: number;
      emergencyReserve?: number;
      ledgerAvailable?: boolean;
    };
  };
  yahooAuctions: { experimentalEnabled?: boolean; sourceRunnerConfigured?: boolean; requestRoute?: string };
  yahooFleamarket: { sourceRunnerConfigured?: boolean; cloudflareDirectEnabled?: boolean; browserRunFallbackConfigured?: boolean; requestRoute?: string };
  browserRun: { configured?: boolean; sources?: string[] };
  sourceRunner: { configured?: boolean; sources?: string[]; concurrency?: number; transportPolicy?: string };
  amazon: {
    configured?: boolean;
    monitoringEnabled?: boolean;
    cloudflareDirectEnabled?: boolean;
    browserRunFallbackConfigured?: boolean;
    requestRoute?: string;
  };
  sourceService: { configured?: boolean; requestRoute?: string; sources?: string[] };
  collectionPolicy: {
    timeZone: "Asia/Tokyo";
    quietHoursStart: "00:00";
    quietHoursEnd: "05:00";
    quietHoursActive: boolean;
    overrideActive: boolean;
    overrideExpiresAt: string | null;
    automaticCollectionAllowed: boolean;
  };
  verification: VerificationCheck[];
  completion: { status?: string; sent_at?: string | null; last_error?: string | null } | null;
  qualification: QualificationRun | null;
  probeHistory: ProbeHistory[];
  healthObservations: SourceHealthObservation[];
}

const sourceNames: Record<string, string> = {
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate 通贩",
  amiami: "AmiAmi（あみあみ）",
  yahoo_shopping: "Yahoo! Shopping（实验）",
  yahoo_auctions_jp: "Yahoo!オークション（实验）",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  amazon_jp: "Amazon Japan",
};

const sourceDescriptions: Record<string, string> = {
  amiami: "按日文关键词查找新品、预约和中古商品；保留商品说明与品相报价",
  rakuten_ichiba: "日本店铺新品与综合商品",
  rakuten_books: "书籍、影像、音乐与出版物",
  mercari_jp: "个人卖家的一口价、普通拍卖与 3 小时拍卖商品",
  surugaya: "中古店铺与 Marketplace 商品；公开页面受阻时使用有额度保护的 Firecrawl 搜索页回退",
  charaon: "角色周边、预约商品与 JAN 目录信息",
  cospa: "COSPA / 二次元COSPA 官方角色商品",
  animate: "Animate 通贩的新品、预约与作品商品",
  yahoo_shopping: "匿名公开 HTML 关键词搜索；有限分页，不提供单品监控",
  yahoo_auctions_jp: "新加坡串行服务读取匿名公开 HTML；受短缓存、限流与熔断保护",
  yahoo_fleamarket_jp: "新加坡串行服务读取个人闲置与一口价商品；必要时按需启动浏览器",
  amazon_jp: "Cloudflare 直接读取 Amazon Japan 日文、日元公开搜索结果",
};

function healthPresentation(source: SourceRow): { label: string; tone: "good" | "warn" | "bad" } {
  if (!source.enabled) return { label: "暂未开放", tone: "bad" };
  if (source.cooldown_until && Date.parse(source.cooldown_until) > Date.now()) return { label: "冷却中", tone: "warn" };
  if (source.health_24h?.latestState === "suspected_degradation") return { label: "疑似结构退化", tone: "bad" };
  if (source.health_24h?.latestState === "failed") return { label: "最近一轮失败", tone: "warn" };
  if (source.health_24h && !source.health_24h.fresh) return { label: "数据已过期", tone: "warn" };
  if (source.health_status === "healthy") return { label: "可用", tone: "good" };
  if (source.health_status === "blocked") return { label: "上游暂时拒绝", tone: "warn" };
  return { label: "近期不稳定", tone: "warn" };
}

function routeLabel(source: SourceRow): string {
  if (["yahoo_shopping", "yahoo_auctions_jp", "yahoo_fleamarket_jp"].includes(source.id)
    && source.request_route === "mercari_service") return "新加坡串行采集服务";
  if (source.id === "yahoo_shopping" || source.id === "yahoo_auctions_jp") return "公开页面直连";
  if (source.id === "yahoo_fleamarket_jp") return "公开页面直连";
  if (source.request_route === "mercari_service") return "东京固定用途适配服务";
  if (source.request_route === "managed_api") return "受管第三方 API";
  if (source.official_api) return "官方 API";
  if (source.id === "surugaya") return "公开搜索页面";
  return "直接连接";
}

function probeProgress(source: SourceRow): number {
  if (source.probe_status === "passed" || source.probe_status === "failed") return 100;
  if (!source.probe_started_at || !source.probe_planned_end_at) return 0;
  const start = Date.parse(source.probe_started_at);
  const end = Date.parse(source.probe_planned_end_at);
  return Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)));
}

function healthObservationLabel(state: SourceHealthObservation["state"]): string {
  return {
    healthy: "采集正常",
    empty: "可信空窗口",
    suspected_degradation: "疑似退化",
    failed: "采集失败",
    disabled: "按规则暂停",
    cooldown: "冷却跳过",
  }[state];
}

function rate(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
}

export function SourceManager() {
  const [items, setItems] = useState<SourceRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [resend, setResend] = useState<SourcesPayload["resend"]>({});
  const [rakuten, setRakuten] = useState<SourcesPayload["rakuten"]>({});
  const [mercari, setMercari] = useState<SourcesPayload["mercari"]>({});
  const [surugaya, setSurugaya] = useState<SourcesPayload["surugaya"]>({});
  const [yahooAuctions, setYahooAuctions] = useState<SourcesPayload["yahooAuctions"]>({});
  const [yahooFleamarket, setYahooFleamarket] = useState<SourcesPayload["yahooFleamarket"]>({});
  const [browserRun, setBrowserRun] = useState<SourcesPayload["browserRun"]>({});
  const [sourceRunner, setSourceRunner] = useState<SourcesPayload["sourceRunner"]>({});
  const [amazon, setAmazon] = useState<SourcesPayload["amazon"]>({});
  const [sourceService, setSourceService] = useState<SourcesPayload["sourceService"]>({});
  const [collectionPolicy, setCollectionPolicy] = useState<SourcesPayload["collectionPolicy"]>({
    timeZone: "Asia/Tokyo",
    quietHoursStart: "00:00",
    quietHoursEnd: "05:00",
    quietHoursActive: false,
    overrideActive: false,
    overrideExpiresAt: null,
    automaticCollectionAllowed: true,
  });
  const [verification, setVerification] = useState<VerificationCheck[]>([]);
  const [completion, setCompletion] = useState<SourcesPayload["completion"]>(null);
  const [qualification, setQualification] = useState<QualificationRun | null>(null);
  const [probeHistory, setProbeHistory] = useState<ProbeHistory[]>([]);
  const [healthObservations, setHealthObservations] = useState<SourceHealthObservation[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const applyPayload = useCallback((body: SourcesPayload) => {
    setItems(body.items);
    setResend(body.resend);
    setRakuten(body.rakuten);
    setMercari(body.mercari);
    setSurugaya(body.surugaya);
    setYahooAuctions(body.yahooAuctions);
    setYahooFleamarket(body.yahooFleamarket);
    setBrowserRun(body.browserRun);
    setSourceRunner(body.sourceRunner);
    setAmazon(body.amazon);
    setSourceService(body.sourceService);
    setCollectionPolicy(body.collectionPolicy);
    setVerification(body.verification);
    setCompletion(body.completion);
    setQualification(body.qualification);
    setProbeHistory(body.probeHistory);
    setHealthObservations(body.healthObservations);
  }, []);

  const load = useCallback((signal?: AbortSignal) => apiFetch<SourcesPayload>("/api/sources", { signal }), []);

  function startReload() {
    setLoadState("loading");
    setLoadError("");
    load()
      .then((payload) => { applyPayload(payload); setLoadState("loaded"); })
      .catch((reason: unknown) => { setLoadError(apiErrorMessage(reason)); setLoadState("error"); });
  }

  // 状态只在 then/catch 回调里更新；初始值本来就是 loading。
  // 读取失败绝不能渲染成"零个来源"——那会被误读为系统正常但没有配置来源。
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((payload) => { applyPayload(payload); setLoadState("loaded"); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(apiErrorMessage(reason));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [applyPayload, load]);

  async function action(id: string, name: "test" | "enable" | "disable") {
    setBusy(`${id}:${name}`);
    setNotice("");
    try {
      const result = await apiFetch<Record<string, unknown>>(`/api/sources/${id}/${name}`, { method: "POST" });
      setNotice(name === "test" ? `真实连接成功，读取到 ${String(result.resultCount ?? 0)} 件商品。` : "来源状态已更新。" );
      applyPayload(await load());
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function runQualification() {
    setBusy("qualification");
    setNotice("");
    try {
      const result = await apiFetch<{ status: string; checks: unknown[] }>("/api/verification/p0/run", { method: "POST" });
      setNotice(`官方来源重新核验完成：${result.status}，保存了 ${result.checks.length} 项证据。`);
      applyPayload(await load());
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "核验失败");
    } finally {
      setBusy("");
    }
  }

  async function toggleOvernightCollection() {
    setBusy("overnight-collection");
    setNotice("");
    try {
      const policy = await apiFetch<SourcesPayload["collectionPolicy"]>("/api/collection-policy/overnight", {
        method: "POST",
        body: JSON.stringify({ enabled: !collectionPolicy.overrideActive }),
      });
      setCollectionPolicy(policy);
      setNotice(policy.overrideActive
        ? `今晚的自动采集已开启，将在 ${policy.overrideExpiresAt ? tokyoFull(policy.overrideExpiresAt) : "东京 05:00"} 自动恢复静默。`
        : "已恢复默认夜间静默；手动搜索与立即刷新仍然可用。");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "夜间采集设置失败");
    } finally {
      setBusy("");
    }
  }

  const p0 = verification.filter((check) => check.scope === "p0");
  const final = verification.filter((check) => check.scope === "final");
  const p0Passed = p0.filter((check) => check.status === "passed").length;
  const finalPassed = final.filter((check) => check.status === "passed").length;
  const searchable = items.filter((source) => source.enabled && source.adapter_available).length;
  const monitoring = items.filter((source) => source.monitoring_allowed).length;
  const runningProbes = items.filter((source) => source.probe_status === "running").length;
  const credentialsReady = ["rakuten_ichiba", "rakuten_books"].every((id) => items.find((source) => source.id === id)?.credential_status === "ready");
  const firecrawlRuntimeRemaining = Math.max(0,
    (surugaya.firecrawlUsage?.runtimeBudget ?? 900) - (surugaya.firecrawlUsage?.runtimeCalls ?? 0));
  const rakutenIchibaMonitoring = rakutenMonitoringEnabledForSource("rakuten_ichiba", rakuten);
  const rakutenBooksMonitoring = rakutenMonitoringEnabledForSource("rakuten_books", rakuten);

  return (
    <div className="source-console reveal reveal-delay-1">
      <section className="source-index" aria-label="来源摘要">
        <article><SearchCheck size={20} aria-hidden="true" /><span>当前可搜索</span><strong>{searchable}</strong></article>
        <article><RefreshCw size={20} aria-hidden="true" /><span>可定时追踪</span><strong>{monitoring}</strong></article>
        <article><Clock3 size={20} aria-hidden="true" /><span>观察窗口进行中</span><strong>{runningProbes}</strong></article>
        <article><ShieldCheck size={20} aria-hidden="true" /><span>最终证据</span><strong>{finalPassed}/{final.length}</strong></article>
      </section>

      {notice && <p className="form-note source-notice">{notice}</p>}

      <section className="source-board">
        <header className="source-board-heading"><div><p className="eyebrow">LIVE SOURCE MAP</p><h2>来源控制台</h2></div><p>搜索能力与定时监控分别判断；一个平台失败，不会拖住其他来源。</p></header>
        <LoadStateNotice
          state={loadState}
          title="来源控制台读取失败"
          loadingTitle="正在读取来源状态"
          loadingHint="读取完成前不要按这里的列表判断来源是否已配置。"
          error={loadError}
          onRetry={startReload}
        />
        <div className="source-card-list">
          {items.map((source, index) => {
            const health = healthPresentation(source);
            const progress = probeProgress(source);
            const experimental = source.transport === "internal_api" || source.transport === "html_endpoint";
            return (
              <article className="source-card" key={source.id} data-health={health.tone}>
                <span className="source-card-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="source-card-title">
                  <p className="eyebrow">{routeLabel(source)}</p>
                  <h3>{sourceNames[source.id] ?? source.display_name}</h3>
                  <p>{sourceDescriptions[source.id] ?? "日本商品来源"}</p>
                </div>
                <div className="source-card-state">
                  <span className={`status-pill ${health.tone}`}>{health.label}</span>
                  <small>{source.monitoring_allowed ? "搜索与自动追踪可用" : source.enabled ? "搜索可用 · 自动追踪暂停" : "不会参与搜索"}</small>
                </div>
                <dl className="source-facts">
                  <div><dt>最近成功</dt><dd>{source.last_success_at ? tokyoDateTime(source.last_success_at) : "尚无"}</dd></div>
                  <div><dt>连续失败</dt><dd data-alert={source.consecutive_failures > 0}>{source.consecutive_failures}</dd></div>
                  <div><dt>24h 请求成功</dt><dd>{source.health_24h ? rate(source.health_24h.requestSuccesses, source.health_24h.attemptedRuns) : "—"}</dd></div>
                  <div><dt>24h 解析成功</dt><dd>{source.health_24h ? rate(source.health_24h.parseSuccesses, source.health_24h.requestSuccesses) : "—"}</dd></div>
                  <div><dt>字段完整</dt><dd>{source.health_24h ? rate(source.health_24h.fieldComplete, source.health_24h.fieldTotal) : "—"}</dd></div>
                  <div><dt>异常空窗口</dt><dd data-alert={(source.health_24h?.abnormalEmptyRuns ?? 0) > 0}>{source.health_24h?.abnormalEmptyRuns ?? 0}</dd></div>
                  <div><dt>解析版本</dt><dd>{source.parser_version || "—"}</dd></div>
                  <div><dt>连接路径</dt><dd><Route size={13} aria-hidden="true" />{routeLabel(source)}</dd></div>
                </dl>
                {experimental && source.id !== "surugaya" && (
                  <div className="probe-progress">
                    <div><span>48 小时稳定性观察</span><strong>{source.probe_status === "running" ? `${progress}%` : source.probe_status === "passed" ? "已通过" : source.probe_status === "failed" ? "未通过" : "尚未开始"}</strong></div>
                    <progress className="probe-track" max={100} value={progress}>{progress}%</progress>
                    <small>{source.probe_successful_runs ?? 0}/{source.probe_total_runs ?? 0} 次成功{source.probe_planned_end_at && source.probe_status === "running" ? ` · 计划于 ${tokyoDateTime(source.probe_planned_end_at)} 完成` : ""}</small>
                  </div>
                )}
                {source.last_error_message && <p className="source-error"><CircleAlert size={15} aria-hidden="true" /><span><strong>最近一次异常</strong>{source.last_error_message}</span></p>}
                {source.probe_decision_reason && <p className="source-decision">{source.probe_decision_reason}</p>}
                <div className="source-actions">
                  <button type="button" className="ghost-button" disabled={!source.adapter_available || Boolean(busy)} onClick={() => void action(source.id, "test")}><RefreshCw size={14} aria-hidden="true" />{busy === `${source.id}:test` ? "真实连接中…" : "重新测试"}</button>
                  <button type="button" className="ghost-button" disabled={Boolean(busy)} onClick={() => void action(source.id, source.enabled ? "disable" : "enable")}>{source.enabled ? "暂停来源" : experimental ? "测试、启用并观察" : "测试并启用"}</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="evidence-journal">
        <header><div><p className="eyebrow">SOURCE HEALTH LOG</p><h2>逐轮来源健康证据</h2></div><p>所有定时巡回都会留下记录；HTTP 成功、解析成功与可信空窗口分别判断。</p></header>
        {healthObservations.length > 0 ? (
          <ol>
            {healthObservations.slice(0, 24).map((observation) => {
              const completeness = observation.field_total > 0 ? Math.round((observation.field_complete / observation.field_total) * 100) : null;
              return (
                <li key={observation.id} data-status={observation.state}>
                  <time>{tokyoDateTime(observation.observed_at)}</time>
                  <strong>{sourceNames[observation.source_id] ?? observation.source_id}</strong>
                  <span>{healthObservationLabel(observation.state)}</span>
                  <p>{observation.parse_succeeded === 1
                    ? `原始 ${observation.raw_result_count} 件 · 规范化 ${observation.normalized_result_count} 件 · ${observation.page_depth} 页${completeness === null ? "" : ` · 字段完整 ${completeness}%`}`
                    : observation.abnormal_empty === 1
                      ? "上游有响应但结果异常归零；旧库存已保留，本轮不参与趋势解释"
                      : observation.error_message || "本轮未形成可解析市场窗口"}</p>
                </li>
              );
            })}
          </ol>
        ) : <div className="empty-state compact-empty"><p>下一次定时巡回后，逐轮请求与解析证据会出现在这里。</p></div>}
      </section>

      {probeHistory.length > 0 && (
        <details className="acceptance-details">
          <summary><span><Clock3 size={16} aria-hidden="true" />已封存的观察窗口</span><strong>{probeHistory.length} 个</strong></summary>
          <div>
            <p>来源连接路径发生变化时，旧窗口会原样封存，新路径从零重新累计 48 小时；旧失败不会被覆盖。</p>
            <ul>{probeHistory.map((window) => (
              <li key={window.id}>
                <span>{sourceNames[window.source_id] ?? window.source_id} · {window.request_route === "direct" ? "原直接连接" : "原隔离签名服务"}
                  {window.started_at ? ` · ${tokyoFull(window.started_at)}` : ""}</span>
                <strong data-status={window.status}>{window.successful_runs}/{window.total_runs} 次成功</strong>
              </li>
            ))}</ul>
          </div>
        </details>
      )}

      <section className="policy-grid">
        <article>
          <p className="eyebrow">OVERNIGHT COLLECTION</p>
          <h3>{collectionPolicy.quietHoursActive
            ? collectionPolicy.overrideActive ? "今晚夜间自动采集已临时开启" : "正在执行东京凌晨静默"
            : collectionPolicy.overrideActive ? "今晚将继续自动采集" : "东京 00:00–05:00 默认不自动抓取"}</h3>
          <p>静默只暂停 Cron 自动来源请求；网站、历史数据、通知处理、手动搜索与立即刷新照常运行。临时开启会在东京时间 05:00 自动失效。</p>
          <button type="button" className="ghost-button" disabled={Boolean(busy)} onClick={() => void toggleOvernightCollection()}>
            <Moon size={14} aria-hidden="true" />
            {busy === "overnight-collection"
              ? "正在更新…"
              : collectionPolicy.overrideActive ? "恢复默认夜间静默" : "今晚开启夜间采集"}
          </button>
        </article>
        <article>
          <p className="eyebrow">RAKUTEN POLICY</p><h3>{rakutenIchibaMonitoring ? "乐天市场定时监控已开启" : "乐天市场定时监控暂停"}</h3>
          <p>乐天市场按照已登记的应用用途{rakutenIchibaMonitoring ? "执行即时搜索与定时监控" : "仅执行即时搜索"}；Rakuten Books {rakutenBooksMonitoring ? "也已开启定时监控" : "保持仅搜索，不进入定时巡回"}。两个来源独立控制，不再共用总闸门。</p>
          <a className="text-link" href="/sources/rakuten" target="_blank" rel="noreferrer">查看公开 Rakuten 页面 <ArrowUpRight size={14} aria-hidden="true" /></a>
        </article>
        <article>
          <p className="eyebrow">INDEPENDENT ROUTES</p><h3>{sourceRunner.configured ? "新加坡串行采集服务已接通" : "新加坡采集服务仍有来源未接通"}</h3>
          <p>Yahoo Shopping、Yahoo!オークション与 Yahoo!フリマ统一走新加坡服务，普通 HTTP 成功时不启动浏览器，受阻时才按需启动 Playwright；全局并发固定为 {sourceRunner.concurrency ?? 1}。骏河屋先尝试公开页面直连，403 后只对搜索页使用 Firecrawl 日本 Basic 代理；商品详情不会自动消耗 Firecrawl。Mercari {mercari.sourceRunnerMode === "primary" ? "已切换到 VPS 主路径" : mercari.sourceRunnerMode === "shadow" ? "正在由东京 Vercel 与 VPS 双路影子核对" : "仍使用东京独立签名服务"}。CharaON / COSPA / Animate 的固定用途服务{sourceService.configured ? "已配置" : "尚未配置"}。每次上游响应仍先保存证据再进入解析。</p>
        </article>
        <article>
          <p className="eyebrow">FIRECRAWL BUDGET</p><h3>骏河屋自动回退剩余 {firecrawlRuntimeRemaining}/{surugaya.firecrawlUsage?.runtimeBudget ?? 900}</h3>
          <p>Firecrawl {surugaya.firecrawlFallbackConfigured ? "密钥已配置" : "密钥未配置"}；固定日本 Basic 代理、5 分钟最大缓存年龄，每页 1 credit。独立小时探针已停用，只有真实监控或手动搜索在直连受阻时才使用。达到 {surugaya.firecrawlUsage?.warningThreshold ?? 700} 次开始告警，{surugaya.firecrawlUsage?.runtimeBudget ?? 900} 次硬停止，并保留 {surugaya.firecrawlUsage?.emergencyReserve ?? 100} credits。{surugaya.firecrawlUsage?.periodEndsAt ? `当前本地账期截至 ${tokyoFull(surugaya.firecrawlUsage.periodEndsAt)}` : "首次实际回退后建立供应商账期账本"}。</p>
        </article>
        <article>
          <p className="eyebrow">AMAZON JAPAN</p><h3>{amazon.cloudflareDirectEnabled ? "Cloudflare 公开 HTML 直连已开启" : "Amazon Japan 直连未开启"}</h3>
          <p>搜索固定使用日文界面与 JPY 偏好，只接收稳定 ASIN，并保留原始页面证据；直连受阻时{amazon.browserRunFallbackConfigured ? "可按需启动浏览器回退" : "尚未配置浏览器回退"}。定时监控{amazon.monitoringEnabled ? "已开启" : "未开启"}，不再消耗 Amazon 第三方 API 配额。</p>
        </article>
        <article>
          <p className="eyebrow">NOTIFICATION</p><h3>{resend.configured ? "通知通道已连接" : "通知通道未配置"}</h3>
          <p>只有真实变化才进入通知队列；首次运行建立基线。Rakuten 的条款闸门不会因为邮件通道已配置而被绕过。</p>
        </article>
      </section>

      <details className="acceptance-details">
        <summary><span><Check size={16} aria-hidden="true" />验收与高级证据</span><strong>{p0Passed}/{p0.length} 基础 · {finalPassed}/{final.length} 最终</strong></summary>
        <div>
          <p>最近一次官方来源核验：{qualification ? `${qualification.status} · ${tokyoFull(qualification.started_at)}` : "尚未运行"}。最终通知：{completion?.status || "尚未触发"}。</p>
          <ul>{verification.map((check) => <li key={`${check.scope}:${check.check_key}`}><span>{check.label}</span><strong data-status={check.status}>{check.status === "passed" ? "通过" : check.status === "blocked" ? "受阻" : check.status === "failed" ? "失败" : "待验证"}</strong></li>)}</ul>
          <button type="button" className="ghost-button" disabled={!credentialsReady || Boolean(busy)} onClick={() => void runQualification()}>{busy === "qualification" ? "正在实测…" : "重新核验官方来源"}</button>
          {!credentialsReady && <p className="muted-copy">Rakuten 官方凭据尚未就绪；实验来源不会冒充官方 API 验收结果。</p>}
        </div>
      </details>
    </div>
  );
}
