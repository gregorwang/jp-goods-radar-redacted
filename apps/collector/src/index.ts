import { getAdapter } from "@jpgr/adapters";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  findHistoricalProductListings,
  type AnalyticsSearchRun,
  type AnalyticsHistoricalListing,
  type AnalyticsSourceCapture,
} from "@jpgr/analytics";
import {
  assessKeywordWindow,
  evaluateListingEvents,
  interestRiseEvent,
  type ListingInterest,
  exactProductEvidenceFilters,
  assessProductMatch,
  buildProductMatchCorpus,
  buildProductSearchPlan,
  candidateKey,
  compareProductSearchCandidates,
  describeProductMatchDifference,
  fingerprintFromExtractedProductName,
  filterListings,
  keywordRuleMiss,
  matchingMutedProduct,
  mutedProductLabel,
  listingFieldCoverage,
  listingFieldCompleteness,
  listingForDeterministicState,
  NEW_LISTING_ANCHOR_MAX_ATTEMPTS,
  newListingAnchorSettled,
  newListingDailyPageBudget,
  newListingDiscoveryKind,
  newListingPageBudget,
  nextNewListingWatermark,
  OVERNIGHT_COLLECTION_OVERRIDE_FLAG,
  overnightCollectionPolicy,
  productFingerprintSupportsExactMatch,
  productMatchDeterministicallySettled,
  groundProductTargetExtraction,
  productTargetExtractionIsEmpty,
  PRODUCT_MATCH_VERSION,
  PRODUCT_SEARCH_AI_REVIEW_VERSION,
  PRODUCT_SEARCH_PLAN_VERSION,
  PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT,
  searchCandidateEvidence,
  searchFiltersFromConfig,
  countProductSearchUnreviewedCandidates,
  planCandidateDetailActions,
  selectProductSearchAiReviewCandidates,
  SOURCE_IDS,
  sourcePaginationPolicy,
  validComparablePrice,
  type ConfirmPriceDropJob,
  type QueryCoverage,
  type QueryStopReason,
  type SearchQueryVariant,
  type CandidateDetailActionReason,
  type CandidateDetailCapability,
  type CandidateHit,
  type FinalizeKeywordDigestJob,
  type GeminiJob,
  type MonitorJob,
  type RunBindingJob,
  type RunTrackedListingJob,
  type SearchFilters,
  type ProductMatchRelation,
  type ProductSearchPlan,
  type SearchCandidateEvidence,
  type SearchRequest,
  type SearchResult,
  type SearchRouteOutcome,
  type SourceId,
  type SourceRequestRoute,
  type SourceRouteFailureEvidence,
} from "@jpgr/core";
import {
  bindPostgresDatabase,
  RadarRepository,
  sameDayRetryEligible,
  withPostgresDatabase,
  type StoredListingDetail,
  type WatchBindingRow,
} from "@jpgr/db";
import {
  listingEnrichmentSchema,
  normalizedListingSchema,
  previewListingDetailSchema,
  searchPreviewSchema,
  type ListingEnrichment,
  type SearchPreviewInput,
} from "@jpgr/validation";
import { AdapterError, ParserStructureError, redactSensitiveText } from "@jpgr/adapters";
import { finalAcceptanceEmail, sendResendEmail } from "@jpgr/email";
import type { NormalizedListing, ProductFingerprint } from "@jpgr/core";
import { maybeRunAutomaticP0, runP0Qualification } from "./p0-qualification";
import { createPacedFetch } from "./request-pacer";
import { SOURCE_RUNNER_SOURCE_IDS, cloudflareDirectEnabled, fixedHtmlServiceConfigured, itemWithConfiguredRoute, mercariServiceConfigured, mercariSourceRunnerMode, searchWithConfiguredRoute, sourceRequestRoute, sourceRouteFailures, sourceRunnerConfigured, sourceServiceFallbackConfigured, surugayaServiceConfigured, yahooServiceConfigured, type RoutedSearchResult, type SourceRouteSession } from "./source-execution";
import { isUnexpectedEmptySearch } from "./result-health";
import {
  FIRECRAWL_EMERGENCY_RESERVE,
  FIRECRAWL_DAILY_BUDGET,
  FIRECRAWL_RUNTIME_BUDGET,
  FIRECRAWL_WARNING_THRESHOLD,
  firecrawlFallbackConfigured,
  latestFirecrawlLocalUsage,
} from "./firecrawl-fallback";
import {
  aiEnrichmentPersistenceResponse,
  enqueueAnalyticsOutbox,
  enqueuePendingAnalytics,
  ingestAnalyticsOutbox,
  markAnalyticsOutboxDeadLettered,
  manualAnalyticsOutboxStatement,
  marketAnalyticsOutboxStatement,
  marketAnalyticsRun,
  latestAiEnrichmentResponse,
} from "./analytics";
import { collectMarketWindow, collectNewListingWindow, mergedRequestEvidence } from "./market-pagination";
import { yahooAuctionsConfigured } from "./yahoo-auctions-runtime";
import { createSourceCaptureRecorder, sourceCaptureStatements, stageSourceCaptures } from "./source-capture";
import { stageWatchQueryAttempts, type WatchQueryAttempt } from "./query-attempts";
import {
  BROWSER_RUN_SOURCE_IDS,
  browserRunFallbackConfigured,
  createBrowserRunFetch,
  isBrowserRunSource,
} from "./browser-run-fallback";
import {
  backfillExactWatchProductIdentityProjections,
  enqueueKeywordGeminiJob,
  enqueueProductSearchGeminiJob,
  listingGeminiJobResponse,
  abandonedKeywordGeminiJobs,
  pendingKeywordGeminiJobs,
  processGeminiJob,
  recoverGeminiJobs,
  markGeminiJobDeadLettered,
  productTargetGeminiJobResponse,
  readCompletedProductTargetExtraction,
  searchOverviewGeminiJobResponse,
} from "./gemini-jobs";
import {
  backfillProductIdentityProjections,
  exactProductIdentityDecision,
  reprojectProductIdentities,
  materializeProductIdentityForTask,
  type ExactIdentityAiItemStatus,
} from "./product-identity";
import { publishKeywordRound } from "./push-delivery";
import { deliverPendingNotifications, followUpNotices } from "./notice-delivery";
import { isHealthCheckTick, isWeeklyMarketDigestTick } from "./weekly-schedule";
import { applyExactReferenceImages, releaseHeldExactImageDigests } from "./exact-reference-image";
import { monitorQueueFor } from "./monitor-queue";
import { enrichDigestItems } from "./listing-enrich";
import type { WorkerBindings } from "./bindings";
import type { RuntimeEnv as Env } from "./runtime-env";
import { registerRouteAlertDelivery } from "./mercari-route";
import { keywordDigestMembership, scheduleSameDayRetry } from "./same-day-retry";
import { advanceListingGrouping } from "./listing-grouping";

// 煤炉路线提醒（主路断 / 恢复 / 全线不通）写进事件表后立刻投递，不等每小时的例行投递。
registerRouteAlertDelivery((env) => deliverPendingNotifications(env, new RadarRepository(env.DB)));

type ManagedApiEnv = Env & {
  AMAZON_HTML_MONITORING_ENABLED?: string;
  RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED?: string;
  RAKUTEN_BOOKS_PRIVATE_MONITORING_ENABLED?: string;
  YAHOO_CLOUDFLARE_DIRECT_ENABLED?: string;
  SURUGAYA_CLOUDFLARE_DIRECT_ENABLED?: string;
  YAHOO_WEB_EXPERIMENTAL_ENABLED?: string;
  YAHOO_WEB_EXPERIMENTAL_MAX_PAGES?: string;
  YAHOO_WEB_EXPERIMENTAL_DELAY_MS?: string;
  FIRECRAWL_API_KEY?: string;
};

const RAKUTEN_SOURCE_IDS = ["rakuten_ichiba", "rakuten_books"] as const satisfies readonly SourceId[];
// Bounds due work per tick, not the number of profiles or active bindings.
const MONITOR_DISPATCH_BATCH_SIZE = 80;
// 单件商品下架后每天确认一次是否恢复；满这么多天仍看不到就自动暂停（煤炉申诉一周内出结果，留足余量）。
const UNAVAILABLE_ITEM_PAUSE_DAYS = 15;
/** 手动搜索主查询的有界翻页预算；已售商品往往不在第一页。 */
const MANUAL_SEARCH_PAGE_BUDGET = 3;
/**
 * 精确同款：每条查询只收上游排序的前 N 条。
 *
 * 一页 100~120 条全收下来，等于用自己的分数去重排平台已经排好的东西，而详情预算
 * 只有个位数。先收窄，再把详情花在前排。
 */
const EXACT_PRODUCT_CANDIDATES_PER_QUERY = 40;
/** 手动精确搜索按查询逐步补详情；前一枪失败后仍给后续短召回保留预算。 */
const MANUAL_EXACT_DETAIL_LIMIT = 6;
const MANUAL_EXACT_DETAILS_PER_QUERY = 2;
/** 历史索引只有在站内短查询仍没找到同款时才启用，并额外保留少量实时详情预算。 */
const MANUAL_EXACT_TOTAL_DETAIL_LIMIT = 9;
const MANUAL_EXACT_HISTORY_CANDIDATE_LIMIT = 80;
/**
 * 一手（新品零售）来源。这些店卖的是还在发行的新货，不收二手。
 *
 * 对绝版限定商品，一手店搜不到是**结构性**的：东西早就卖完了，换任何召回词都一样。
 * 2026-09-08 全量实测（radar_core，精确同款绑定全历史）：
 *
 *   animate / cospa / charaon / amazon_jp / yahoo_shopping / amiami / rakuten_ichiba
 *   七家累计只产出过 1 件确认同款（乐天的第三方代购书店），而且那一件是主查询直接
 *   命中的。cospa 与 charaon 更彻底，全历史一条观测都没有——它们是自有品牌店，
 *   根本不收录别家的限定品。
 *
 * 但主查询恒为 0 又正好踩中 hasQualifiedExactCandidate 的收手判据：判据不成立，
 * 追加召回每轮必然打满。等于为一个结构上不可能发生的事长期付费。
 *
 * 所以一手店只发主查询。**这不是停止监控**——一手店有再販，货会重新上架，
 * 那正是要盯的；只是"没有"就是没有，多问两遍不会变成有。
 */
const FIRST_HAND_SOURCE_IDS: ReadonlySet<string> = new Set([
  "animate",
  "cospa",
  "charaon",
  "amazon_jp",
  "yahoo_shopping",
  "amiami",
  "rakuten_ichiba",
]);
/**
 * 精确同款巡检在主查询没捞到合格同款时，最多再追加几条短召回。
 *
 * 计划里最多可以有 5 条来源原生查询，但那是给手动建档用的上界。巡检是每天重复付的
 * 成本：一条召回词 = 一次真实上游请求 × 来源数 × 每天轮数。
 *
 * 2026-09-08 复盘把这里从 2 降到 1：可追溯的确认同款里，**没有一件是靠追加召回
 * 才找回来的**（全部由主查询命中，追加召回最多是冗余重复命中）。保留 1 条是为了
 * 兜住个人卖家的口语化缩写——二手市场的标题是人手打的，这个风险真实存在；
 * 一手店的标题是商品数据库出的，不需要这层兜底，见 FIRST_HAND_SOURCE_IDS。
 *
 * 注意这个证据只覆盖了煤炉一家（只有它的响应体里能还原出实际查询词），所以降到 1
 * 而不是直接归零。要把这条判死，得先补 watch_run_listing_observations 的变体埋点。
 */
const EXACT_PRODUCT_WATCH_FALLBACK_VARIANTS = 1;
/** 一手店不追加短召回。 */
const EXACT_PRODUCT_WATCH_FALLBACK_VARIANTS_FIRST_HAND = 0;
function exactProductFallbackVariants(sourceId: string): number {
  return FIRST_HAND_SOURCE_IDS.has(sourceId)
    ? EXACT_PRODUCT_WATCH_FALLBACK_VARIANTS_FIRST_HAND
    : EXACT_PRODUCT_WATCH_FALLBACK_VARIANTS;
}
/** 精确同款巡检每轮最多补抓几条候选详情。 */
const EXACT_PRODUCT_WATCH_DETAIL_LIMIT = 4;
/**
 * 详情补抓的有效期。详情页提供的是描述与结构化属性，商品一旦上架就不再变；
 * 价格与在售状态每轮都从搜索结果里拿到最新值，不依赖补抓。所以这里只需要保证
 * 每天至少复核一次，其余轮次直接复用库里的那一份。
 */
const EXACT_PRODUCT_DETAIL_HYDRATION_TTL_MS = 12 * 60 * 60 * 1000;
const KEYWORD_DIGEST_DELAY_SECONDS = 15 * 60;
const KEYWORD_DIGEST_RETRY_SECONDS = 5 * 60;
const KEYWORD_DIGEST_MAX_FINALIZE_ATTEMPTS = 576;
/**
 * 超过这么久还挂着 `running` 的采集，当它没跑成。
 *
 * `watch_runs` 里的 `running` 没有兜底：一次被运行时打断的执行不会回来改状态，
 * 那条队列消息重试耗尽就进死信了，这一行于是永久停在 running。摘要等的是
 * 「这一轮跑完没有」，一条这样的记录就能让它等满 576 次重试（48 小时）。
 * 一次正常采集只要几十秒到几分钟，30 分钟足够宽松；宁可迟到半小时出一封
 * 写明「这个来源没跑成」的摘要，也不要让一整天的结论烂在队列里。
 */
const STALE_RUN_MINUTES = 30;
const ONE_OFF_TERMINAL_RETIRE_DAYS = 7;
type RakutenSourceId = (typeof RAKUTEN_SOURCE_IDS)[number];

function recordJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArrayJson(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function bindingSearchFilters(binding: WatchBindingRow, config: Record<string, unknown>): SearchFilters {
  const filters = searchFiltersFromConfig(config, {
    sort: "newest",
    page: 1,
    pageSize: 30,
    maxPrice: binding.profile_default_max_price ?? undefined,
  });
  return config.searchMode === "exact_product" ? exactProductEvidenceFilters(filters) : filters;
}

function supportedPostSearchFilters(sourceId: SourceId, filters: SearchFilters): SearchFilters {
  if (sourceId !== "yahoo_shopping") return filters;
  const { conditions: _conditions, availabilityMode: _availabilityMode, ...supported } = filters;
  return { ...supported, inStockOnly: false, availabilityMode: "all" };
}

function secrets(env: Env): Partial<Record<string, string>> {
  const managed = env as ManagedApiEnv;
  return {
    RAKUTEN_APPLICATION_ID: env.RAKUTEN_APPLICATION_ID,
    RAKUTEN_ACCESS_KEY: env.RAKUTEN_ACCESS_KEY,
    RAKUTEN_AFFILIATE_ID: env.RAKUTEN_AFFILIATE_ID,
    RAKUTEN_AFFILIATE_MODE: env.RAKUTEN_AFFILIATE_MODE,
    RAKUTEN_PRIVATE_MONITORING_ENABLED: env.RAKUTEN_PRIVATE_MONITORING_ENABLED,
    RAKUTEN_APPLICATION_URL: env.RAKUTEN_APPLICATION_URL,
    YAHOO_WEB_EXPERIMENTAL_ENABLED: managed.YAHOO_WEB_EXPERIMENTAL_ENABLED,
    YAHOO_WEB_EXPERIMENTAL_MAX_PAGES: managed.YAHOO_WEB_EXPERIMENTAL_MAX_PAGES,
    YAHOO_WEB_EXPERIMENTAL_DELAY_MS: managed.YAHOO_WEB_EXPERIMENTAL_DELAY_MS,
    YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: env.YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED,
    YAHOO_AUCTIONS_TIMEOUT_MS: env.YAHOO_AUCTIONS_TIMEOUT_MS,
    YAHOO_AUCTIONS_RATE_INTERVAL_MS: env.YAHOO_AUCTIONS_RATE_INTERVAL_MS,
    YAHOO_AUCTIONS_SEARCH_CACHE_SECONDS: env.YAHOO_AUCTIONS_SEARCH_CACHE_SECONDS,
    YAHOO_AUCTIONS_DETAIL_CACHE_SECONDS: env.YAHOO_AUCTIONS_DETAIL_CACHE_SECONDS,
  };
}

function isRakutenSource(sourceId: SourceId): sourceId is RakutenSourceId {
  return (RAKUTEN_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

function rakutenPrivateMonitoringEnabled(sourceId: RakutenSourceId, env: Env): boolean {
  const configured = env as ManagedApiEnv;
  const sourceValue = sourceId === "rakuten_ichiba"
    ? configured.RAKUTEN_ICHIBA_PRIVATE_MONITORING_ENABLED
    : configured.RAKUTEN_BOOKS_PRIVATE_MONITORING_ENABLED;
  return String(sourceValue ?? env.RAKUTEN_PRIVATE_MONITORING_ENABLED) === "true";
}

function rakutenPrivateMonitoringBySource(env: Env): Record<RakutenSourceId, boolean> {
  return {
    rakuten_ichiba: rakutenPrivateMonitoringEnabled("rakuten_ichiba", env),
    rakuten_books: rakutenPrivateMonitoringEnabled("rakuten_books", env),
  };
}

function amazonMonitoringEnabled(env: Env): boolean {
  return String((env as ManagedApiEnv).AMAZON_HTML_MONITORING_ENABLED) === "true";
}

function browserFallbackFetch(sourceId: SourceId, env: Env): typeof fetch | undefined {
  return isBrowserRunSource(sourceId) && browserRunFallbackConfigured(sourceId, env)
    ? createBrowserRunFetch(env, sourceId)
    : undefined;
}

function credentialReady(sourceId: SourceId, env: Env): boolean {
  if (sourceId === "rakuten_ichiba" || sourceId === "rakuten_books") {
    return Boolean(env.RAKUTEN_APPLICATION_ID && env.RAKUTEN_ACCESS_KEY);
  }
  if (sourceId === "yahoo_shopping") {
    return sourceRunnerConfigured(sourceId, env) || cloudflareDirectEnabled(sourceId, env) || yahooServiceConfigured(env);
  }
  if (sourceId === "amazon_jp") return cloudflareDirectEnabled(sourceId, env);
  if (["mercari_jp", "surugaya", "yahoo_fleamarket_jp", "charaon", "cospa", "animate"].includes(sourceId)) return true;
  return false;
}

async function sourceStatus(env: Env): Promise<Response> {
  const repository = new RadarRepository(env.DB);
  const privateMonitoringBySource = rakutenPrivateMonitoringBySource(env);
  const overnightFlag = await env.DB.prepare(
    "SELECT enabled,config_json FROM runtime_feature_flags WHERE flag_key=?",
  ).bind(OVERNIGHT_COLLECTION_OVERRIDE_FLAG).first<{ enabled: number; config_json: string }>();
  let firecrawlUsage = {
    provider: "firecrawl",
    periodStartedAt: null as string | null,
    periodEndsAt: null as string | null,
    runtimeBudget: FIRECRAWL_RUNTIME_BUDGET,
    runtimeCalls: 0,
    dailyDayJst: null as string | null,
    dailyBudget: FIRECRAWL_DAILY_BUDGET,
    dailyRuntimeCalls: 0,
    warningThreshold: FIRECRAWL_WARNING_THRESHOLD,
    emergencyReserve: FIRECRAWL_EMERGENCY_RESERVE,
    ledgerAvailable: false,
  };
  try {
    const usage = await latestFirecrawlLocalUsage(env);
    if (usage) firecrawlUsage = { ...usage, warningThreshold: FIRECRAWL_WARNING_THRESHOLD, ledgerAvailable: true };
  } catch {
    // A missing migration must not make the source status endpoint unavailable.
  }
  return Response.json({
    sources: SOURCE_IDS.filter((sourceId) => Boolean(getAdapter(sourceId))).map((sourceId) => ({
      sourceId,
      adapterAvailable: Boolean(getAdapter(sourceId)),
      historySearchSupported: getAdapter(sourceId)?.capabilities.historySearchSupported ?? false,
      credentialStatus: sourceId === "amazon_jp" || sourceId === "yahoo_auctions_jp"
        ? "not_required"
        : credentialReady(sourceId, env) ? "ready" : "missing",
      requestRoute: sourceRequestRoute(sourceId, env),
    })),
    resend: { configured: Boolean(env.RESEND_API_KEY), recipient: env.ALERT_EMAIL_TO },
    rakuten: {
      affiliateMode: String(env.RAKUTEN_AFFILIATE_MODE) === "true",
      privateMonitoringEnabled: Object.values(privateMonitoringBySource).every(Boolean),
      privateMonitoringBySource,
      publicPreviewEnabled: credentialReady("rakuten_ichiba", env) && credentialReady("rakuten_books", env),
    },
    mercari: {
      independentServiceConfigured: mercariServiceConfigured(env),
      sourceRunnerConfigured: sourceRunnerConfigured("mercari_jp", env),
      sourceRunnerMode: mercariSourceRunnerMode(env),
      requestRoute: sourceRequestRoute("mercari_jp", env),
    },
    surugaya: {
      independentServiceConfigured: firecrawlFallbackConfigured(env)
        || sourceRunnerConfigured("surugaya", env) || surugayaServiceConfigured(env),
      sourceRunnerConfigured: sourceRunnerConfigured("surugaya", env),
      cloudflareDirectEnabled: cloudflareDirectEnabled("surugaya", env),
      vercelFallbackConfigured: surugayaServiceConfigured(env),
      firecrawlFallbackConfigured: firecrawlFallbackConfigured(env),
      firecrawlUsage,
      standaloneProbeEnabled: false,
      requestRoute: sourceRequestRoute("surugaya", env),
    },
    yahoo: {
      experimentalServiceConfigured: sourceRunnerConfigured("yahoo_shopping", env) || yahooServiceConfigured(env),
      sourceRunnerConfigured: sourceRunnerConfigured("yahoo_shopping", env),
      cloudflareDirectEnabled: cloudflareDirectEnabled("yahoo_shopping", env),
      vercelFallbackConfigured: yahooServiceConfigured(env),
      requestRoute: sourceRequestRoute("yahoo_shopping", env),
    },
    yahooAuctions: {
      experimentalEnabled: yahooAuctionsConfigured(env),
      sourceRunnerConfigured: sourceRunnerConfigured("yahoo_auctions_jp", env),
      requestRoute: sourceRequestRoute("yahoo_auctions_jp", env),
    },
    yahooFleamarket: {
      sourceRunnerConfigured: sourceRunnerConfigured("yahoo_fleamarket_jp", env),
      cloudflareDirectEnabled: cloudflareDirectEnabled("yahoo_fleamarket_jp", env),
      browserRunFallbackConfigured: browserRunFallbackConfigured("yahoo_fleamarket_jp", env),
      requestRoute: sourceRequestRoute("yahoo_fleamarket_jp", env),
    },
    browserRun: {
      configured: BROWSER_RUN_SOURCE_IDS.some((sourceId) => browserRunFallbackConfigured(sourceId, env)),
      sources: BROWSER_RUN_SOURCE_IDS.filter((sourceId) => browserRunFallbackConfigured(sourceId, env)),
    },
    sourceRunner: {
      configured: SOURCE_RUNNER_SOURCE_IDS.every((sourceId) => sourceRunnerConfigured(sourceId, env)),
      sources: SOURCE_RUNNER_SOURCE_IDS.filter((sourceId) => sourceRunnerConfigured(sourceId, env)),
      concurrency: 1,
      transportPolicy: "http_first_playwright_fallback",
    },
    amazon: {
      configured: credentialReady("amazon_jp", env),
      monitoringEnabled: amazonMonitoringEnabled(env),
      cloudflareDirectEnabled: cloudflareDirectEnabled("amazon_jp", env),
      browserRunFallbackConfigured: browserRunFallbackConfigured("amazon_jp", env),
      requestRoute: sourceRequestRoute("amazon_jp", env),
      transport: "html_endpoint",
    },
    sourceService: {
      configured: fixedHtmlServiceConfigured(env),
      requestRoute: sourceRequestRoute("charaon", env),
      sources: ["charaon", "cospa", "animate"],
    },
    collectionPolicy: overnightCollectionPolicy(new Date(), overnightFlag),
  });
}

async function testSource(sourceId: SourceId, env: Env): Promise<Response> {
  const adapter = getAdapter(sourceId);
  if (!adapter) return Response.json({ error: "adapter_unavailable" }, { status: 409 });
  const route = sourceRequestRoute(sourceId, env);
  const sourceState = await env.DB.prepare(
    "SELECT cooldown_until,cooldown_route,last_http_status,last_error_code,last_error_message FROM source_registry WHERE id=?",
  ).bind(sourceId).first<{
    cooldown_until: string | null;
    cooldown_route: SourceRequestRoute | null;
    last_http_status: number | null;
    last_error_code: string | null;
    last_error_message: string | null;
  }>();
  const primaryCooling = Boolean(sourceState?.cooldown_until && Date.parse(sourceState.cooldown_until) > Date.now()
    && (sourceState.cooldown_route ?? "direct") === route);
  if (primaryCooling && !sourceServiceFallbackConfigured(sourceId, env)
    && !browserRunFallbackConfigured(sourceId, env)
    && !(sourceId === "surugaya" && firecrawlFallbackConfigured(env))) {
    return Response.json({
      sourceId,
      ok: false,
      error: "来源处于冷却期，暂不重复请求上游",
      cooldownUntil: sourceState?.cooldown_until,
    }, { status: 429 });
  }
  const skippedPrimaryFailure = primaryCooling && sourceState?.cooldown_until
    ? cooldownFailureEvidence({ ...sourceState, cooldown_until: sourceState.cooldown_until })
    : undefined;
  const now = new Date().toISOString();
  try {
    const result = await searchWithConfiguredRoute(env, adapter,
      {
        query: adapter.healthcheckQuery ?? "千反田える",
        filters: sourceId === "yahoo_auctions_jp"
          ? { page: 1, pageSize: 5, inStockOnly: true, availabilityMode: "purchasable", sort: "relevance" }
          // AmiAmi retains closed catalog entries. A valid first page can be
          // entirely sold out; this check verifies transport and parsing.
          : sourceId === "amiami" ? { page: 1, pageSize: 5, availabilityMode: "all", sort: "newest" }
          : { page: 1, pageSize: 5, inStockOnly: true, sort: "newest" },
        sourceConfig: adapter.healthcheckSourceConfig,
      },
      { fetch, secrets: secrets(env), signal: AbortSignal.timeout(25_000) },
      {
        allowManagedFallback: sourceId === "surugaya",
        skippedPrimaryFailure,
        browserFetch: browserFallbackFetch(sourceId, env),
      },
    );
    if (result.listings.length === 0) {
      throw new AdapterError("来源成功响应，但资格关键词没有匹配商品", "qualification_empty_result");
    }
    if (result.routeOutcome.kind === "fallback_success") {
      await recordPreviewSuccess(env, sourceId, result);
    } else {
      const actualRoute = result.requestRoute;
      await env.DB.prepare(
        `UPDATE source_registry SET credential_status=CASE WHEN official_api=0 THEN 'not_required' ELSE 'ready' END,
         health_status='healthy',parser_version=?,last_success_at=?,cooldown_until=NULL,
         consecutive_failures=0,last_error_code=NULL,last_error_message=NULL,
         request_route=?,cooldown_route=NULL,
         last_signature_success_at=CASE WHEN ?='mercari_service' THEN ? ELSE last_signature_success_at END,
         last_container_count=CASE WHEN id='surugaya' THEN ? ELSE last_container_count END,
         last_page_bytes=CASE WHEN id='surugaya' THEN ? ELSE last_page_bytes END,captcha_detected=0,updated_at=? WHERE id=?`,
      ).bind(adapter.parserVersion, now, actualRoute, actualRoute, actualRoute === "mercari_service" ? now : null,
        sourceId === "surugaya" ? result.listings.length : null,
        sourceId === "surugaya" ? Number(result.listings[0]?.rawMetadata?.pageBytes ?? 0) || null : null, now, sourceId).run();
    }
    return Response.json({ sourceId, ok: true, resultCount: result.listings.length, coverage: result.coverage,
      parserVersion: result.parserVersion, requestRoute: result.requestRoute, routeOutcome: result.routeOutcome,
      warnings: result.warnings });
  } catch (error) {
    const routeFailure = sourceRouteFailures(error).find((failure) => failure.route === route)?.failure;
    const adapterError = error instanceof AdapterError ? error : undefined;
    const failureStatus = routeFailure?.status ?? adapterError?.status;
    const failureCode = routeFailure?.code ?? adapterError?.code;
    const message = error instanceof Error ? error.message : "来源测试失败";
    const missing = message.includes("凭据未配置") || message.includes("密钥未配置")
      || adapterError?.code.endsWith("_credentials_missing") === true || adapterError?.code.endsWith("_not_configured") === true;
    const retryAfterSeconds = adapterError?.retryAfterSeconds
      ?? (failureStatus === 403 ? 12 * 60 * 60 : failureStatus === 429 ? 2 * 60 * 60 : undefined);
    const cooldownUntil = retryAfterSeconds
      ? new Date(Date.now() + retryAfterSeconds * 1_000).toISOString()
      : null;
    await env.DB.prepare(
      `UPDATE source_registry SET credential_status=?,health_status=?,last_failure_at=?,last_http_status=?,
       last_error_code=?,last_error_message=?,last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,
       last_429_at=CASE WHEN ?=429 THEN ? ELSE last_429_at END,captcha_detected=CASE WHEN ?='captcha' THEN 1 ELSE captcha_detected END,
       request_route=?,cooldown_until=CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN ? ELSE cooldown_until END,
       cooldown_route=CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN ? ELSE cooldown_route END,updated_at=? WHERE id=?`,
    ).bind(["amazon_jp", "mercari_jp", "surugaya", "yahoo_shopping", "yahoo_auctions_jp", "yahoo_fleamarket_jp", "charaon", "cospa", "animate"].includes(sourceId) ? "not_required" : missing ? "missing" : "error",
      missing ? "unknown" : "degraded", now, failureStatus ?? null,
      failureCode ?? (missing ? "credentials_missing" : "source_test_failed"), message.slice(0, 500), failureStatus ?? null, now,
      failureStatus ?? null, now, failureCode ?? "", route, cooldownUntil, cooldownUntil,
      cooldownUntil, route, now, sourceId).run();
    return Response.json({ sourceId, ok: false, error: message, httpStatus: failureStatus ?? null, cooldownUntil,
      routeFailures: sourceRouteFailures(error) },
      { status: missing ? 409 : 502 });
  }
}

async function scheduleWatchAnalytics(env: Env, run: AnalyticsSearchRun): Promise<void> {
  const outboxId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await marketAnalyticsOutboxStatement(env.DB, outboxId, run, createdAt).run();
    await enqueueAnalyticsOutbox(env, outboxId);
  } catch (error) {
    console.error(JSON.stringify({
      message: "watch_analytics_schedule_failed",
      bindingId: run.bindingId,
      runId: run.id,
      error: error instanceof Error ? error.message : "unknown",
    }));
  }
}

async function persistWatchRunListingAudit(
  repository: RadarRepository,
  binding: WatchBindingRow,
  runId: string,
  observedAt: string,
  candidates: readonly { listing: NormalizedListing; relation?: ProductMatchRelation; reviewSelected?: boolean; differenceNote?: string }[],
): Promise<void> {
  if (candidates.length === 0) return;
  const unique = [...new Map(candidates.map((candidate) => [
    candidateKey(candidate.listing.sourceId, candidate.listing.sourceItemId),
    candidate,
  ] as const)).values()];
  const observations: Parameters<RadarRepository["recordRunListingObservations"]>[0][number][] = [];
  for (const [index, candidate] of unique.entries()) {
    const listing = listingForDeterministicState(candidate.listing);
    const purchasable = ["available", "preorder", "backorder"].includes(listing.availability);
    const hardRejected = candidate.relation === "variant"
      || candidate.relation === "bundle"
      || candidate.relation === "related"
      || candidate.relation === "irrelevant";
    // 没轮到 AI 复核 = 证据不足，不是反证（AGENTS.md §4）：落 uncertain 而不是 rejected。
    // 日报疑似分区要求 ai_relevance 非空，所以它们不会被当成「疑似」发出去，只是记录不再撒谎。
    const notReviewed = !hardRejected && candidate.reviewSelected === false;
    observations.push({
      runId,
      bindingId: binding.id,
      sourceId: listing.sourceId,
      sourceItemId: listing.sourceItemId,
      canonicalUrl: listing.canonicalUrl,
      title: listing.title,
      ...(listing.imageUrl ? { imageUrl: listing.imageUrl } : {}),
      ...(listing.currentPrice !== undefined ? { currentPrice: listing.currentPrice } : {}),
      ...(listing.originalPrice !== undefined ? { originalPrice: listing.originalPrice } : {}),
      currency: listing.currency,
      priceBasis: listing.priceBasis,
      availability: listing.availability,
      itemCondition: listing.condition,
      ...(listing.sourceListedAt ? { sourceListedAt: listing.sourceListedAt } : {}),
      ordinal: index + 1,
      observedAt,
      decisionStatus: !purchasable || hardRejected
        ? "rejected"
        : notReviewed
          ? "uncertain"
          : binding.kind === "item" || candidate.relation === "exact"
            ? "confirmed"
            : "pending",
      // 用户要判断的是"这条和我的目标差在哪"，所以差异说明优先于内部状态措辞。
      decisionReason: !purchasable
        ? `来源状态 ${listing.availability}，不参与购买雷达`
        : notReviewed
          ? [candidate.differenceNote, "本轮 AI 复核名额已满，没轮到"].filter(Boolean).join("；")
          : candidate.differenceNote
            || (hardRejected
              ? `确定性同款关系为 ${candidate.relation}`
              : binding.kind === "item" || candidate.relation === "exact"
                ? "来源身份已确定"
                : "等待同款或关键词相关性判定"),
      ...(candidate.relation ? { matchRelation: candidate.relation } : {}),
      purchasable,
    });
  }
  await repository.recordRunListingObservations(observations);
}

async function runBinding(env: Env, job: RunBindingJob): Promise<void> {
  const repository = new RadarRepository(env.DB);
  const binding = await repository.getBinding(job.bindingId);
  if (!binding || !binding.enabled) return;
  const run = await repository.createRun(binding.id, job.trigger);
  await repository.closeSupersededBusinessRepairRuns(binding.id);
  const adapter = getAdapter(binding.source_id);

  if (binding.cooldown_until && Date.parse(binding.cooldown_until) > Date.now()) {
    const message = `来源冷却至 ${binding.cooldown_until}`;
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter?.coverage ?? "unknown", resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter?.parserVersion, errorCode: "cooldown_active", errorMessage: message,
    });
    return;
  }

  if (isRakutenSource(binding.source_id) && !rakutenPrivateMonitoringEnabled(binding.source_id, env)) {
    const message = `${binding.source_id === "rakuten_ichiba" ? "Rakuten Ichiba" : "Rakuten Books"} 定时监控未启用`;
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter?.coverage ?? "unknown", resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter?.parserVersion,
      errorCode: "rakuten_private_monitoring_disabled",
      errorMessage: message,
    });
    return;
  }

  if (binding.source_id === "amazon_jp" && !amazonMonitoringEnabled(env)) {
    const message = "Amazon Japan 定时监控未启用";
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter?.coverage ?? "unknown", resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter?.parserVersion,
      errorCode: "amazon_monitoring_disabled",
      errorMessage: message,
    });
    return;
  }

  if (!adapter) {
    const message = `来源 ${binding.source_id} 尚未启用`;
    await repository.finishRun(run, {
      status: "skipped", coverage: "unknown", resultCount: 0, newCount: 0, changedCount: 0,
      errorCode: "adapter_unavailable", errorMessage: message,
    });
    return;
  }

  const captureRecorder = createSourceCaptureRecorder(
    binding.source_id,
    isRakutenSource(binding.source_id) ? createPacedFetch(fetch) : fetch,
  );
  const rawBrowserFetch = browserFallbackFetch(binding.source_id, env);
  const capturedBrowserFetch = rawBrowserFetch ? captureRecorder.wrap(rawBrowserFetch) : undefined;
  let analyticsFilters: SearchFilters = {};
  // 通知投递移出采集主流程：投递失败绝不能把成功的采集改写为失败并触发冷却。
  let deliverNotificationsAfterRun = false;
  const queryAttempts: WatchQueryAttempt[] = [];

  try {
    const sourceConfig = recordJson(binding.source_config_json);
    const filters = bindingSearchFilters(binding, sourceConfig);
    analyticsFilters = filters;
    const skippedPrimaryFailure = await skippedPrimaryFailureForSource(env, binding.source_id);
    const request: SearchRequest = {
      query: binding.query ?? "",
      filters,
      sourceConfig,
    };
    const adapterContext = {
      fetch: captureRecorder.fetch,
      secrets: secrets(env),
    };
    const routeSession: SourceRouteSession = {};
    const executeSearch = (pageRequest: SearchRequest) => searchWithConfiguredRoute(
      env,
      adapter,
      pageRequest,
      adapterContext,
      {
        allowManagedFallback: true,
        skippedPrimaryFailure: routeSession.directFailure ?? skippedPrimaryFailure,
        browserFetch: capturedBrowserFetch,
        routeSession,
      },
    );
    const exactProductBinding = binding.kind === "keyword" && sourceConfig.searchMode === "exact_product";
    // 存量档案回填：AI 抽取只发生在建档时，2026-09-05 之前建的档案带的仍是启发式指纹，
    // 拿不到 edition 也拿不到召回词——而召回词是目前最大的漏报修复。这里在巡回时补上：
    // 首轮只把抽取任务排进队列（任务按商品名 dedupe，模型只会真跑一次），拿到结果的
    // 那一轮合并并写回绑定。抽取失败或未完成时保持原指纹，绝不阻塞本轮采集。
    let backfilledTarget: Record<string, unknown> | undefined;
    if (exactProductBinding && recordValue(sourceConfig.productTarget).aiExtracted !== true && binding.query) {
      try {
        const extraction = await readCompletedProductTargetExtraction(env, binding.query);
        // 空抽取一律不写回。写回不只是浪费一次 UPDATE：它会打上 aiExtracted=true，
        // 上面那道守卫此后永不重试，等于把一份比启发式还弱的指纹永久焊死。
        if (extraction && !productTargetExtractionIsEmpty(extraction)) {
          // 计划 §4.3：抽取器补出来的、原文里没有依据的值不进入商品身份。
          // 这些提议不静默丢弃——它们留痕，用来定位是抽取步骤本身需要修，
          // 而不是反过来要求用户把商品名写得更长。
          const fidelity = groundProductTargetExtraction(binding.query, extraction).fidelity;
          if (fidelity.ungroundedProposals.length > 0) {
            console.warn(JSON.stringify({
              event: "product_target_extraction_ungrounded",
              bindingId: binding.id,
              extractionStatus: fidelity.extractionStatus,
              ungrounded: fidelity.ungroundedProposals,
            }));
          }
          const merged = fingerprintFromExtractedProductName(binding.query, extraction);
          const previous = recordValue(sourceConfig.productTarget);
          const target = {
            ...merged,
            // 用户手填的召回词与筛选词优先于抽取结果。
            recallQueries: [
              ...(Array.isArray(previous.recallQueries) ? previous.recallQueries as string[] : []),
              ...(merged.recallQueries ?? []),
            ].slice(0, 4),
            requiredTermGroups: Array.isArray(previous.requiredTermGroups) ? previous.requiredTermGroups as string[] : [],
            supportingTermGroups: Array.isArray(previous.supportingTermGroups) ? previous.supportingTermGroups as string[] : [],
            excludedTerms: Array.isArray(previous.excludedTerms) ? previous.excludedTerms as string[] : [],
          };
          backfilledTarget = target as unknown as Record<string, unknown>;
          await env.DB.prepare("UPDATE watch_bindings SET source_config_json=? WHERE id=?")
            .bind(JSON.stringify({ ...sourceConfig, productTarget: target, intentKind: "fingerprint" }), binding.id)
            .run();
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: "product_target_backfill_failed",
          bindingId: binding.id,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }));
      }
    }
    const exactPlan = exactProductBinding
      ? buildProductSearchPlan({
          query: binding.query ?? "",
          mode: "exact_product",
          target: backfilledTarget ?? recordValue(sourceConfig.productTarget),
          intentKind: backfilledTarget
            ? "fingerprint"
            : sourceConfig.intentKind === "named_product" || sourceConfig.intentKind === "fingerprint"
            ? sourceConfig.intentKind
            : undefined,
        })
      : undefined;
    const exactMatchRelations = new Map<string, ProductMatchRelation>();
    let exactAuditCandidates: Array<{ listing: NormalizedListing; relation: ProductMatchRelation; reviewSelected?: boolean; differenceNote?: string }> = [];
    const executeExactProductSearch = async (): Promise<RoutedSearchResult> => {
      if (!exactPlan?.target) throw new Error("商品名同款雷达缺少商品意图");
      const candidates = new Map<string, SearchCandidateAccumulator>();
      const results: RoutedSearchResult[] = [];
      const warnings: string[] = [];
      let lastError: unknown;
      // 巡检扇出是长期采集成本的大头：一个绑定每天要在多个来源上跑好几轮，多打一条
      // 召回词就多一次真实上游请求。完整商品名（第一条变体）本来就能命中绝大多数
      // 轮次，短召回只是"来源站搜不动完整标题"时的补救——每轮都打出去等于为一个
      // 偶发情况长期付费，对 Mercari 这种怕频率的来源还额外损耗 IP 声誉。
      //
      // 所以巡检改成主查询优先：先只打完整商品名，本轮已经捞到合格同款就收手；
      // 一条都没有才逐条追加短召回，追加条数由来源性质决定（一手店 0 条，二手 1 条，
      // 见 exactProductFallbackVariants）。
      // 手动搜索路径不走这里，仍然一次把所有变体打完——建档时要看清卖家都怎么写标题，
      // 那是一次性成本；这里省的是之后每天重复付的那份。
      const nativeVariants = exactPlan.variants.filter((value) => value.lane === "source_native");
      // 规划器现在按判别力排序，完整商品名降成了可选一枪（排在「角色+版本」等短组合之后）。
      // 巡检的主查询仍固定为完整商品名：2026-09-08 复盘里可追溯的确认同款全部由它命中，
      // 一手店的标题也来自商品数据库。追加的那一枪才用规划器排第一的短组合——
      // 它专门对付二手卖家的简写，正是手动搜索那边验证过有效的部分。
      const mainVariant = nativeVariants.find((value) => value.kind === "original") ?? nativeVariants[0];
      const orderedVariants = mainVariant
        ? [mainVariant, ...nativeVariants.filter((value) => value !== mainVariant)]
        : [];
      const plannedVariants = orderedVariants.slice(0, 1 + exactProductFallbackVariants(binding.source_id));
      for (const [variantIndex, variant] of plannedVariants.entries()) {
        if (variantIndex > 0) {
          // 主查询整个失败（429 / 封锁 / 解析失败）时不要继续扇出：那只是往一个
          // 已经在拒绝我们的来源上再压请求。本轮直接以失败收场，交给既有冷却与重试。
          if (results.length === 0) break;
          // 已售出的同款不算「本轮目标已满足」（计划 §6.4）。它证明查询有价值，
          // 但用户买不到它；多发的那一条短召回正是为了找另一个在售的卖家。
          if (hasQualifiedExactCandidate(candidates, exactPlan.target, { requirePurchasable: true })) break;
        }
        const attemptStartedAt = Date.now();
        const attemptBase = {
          role: variantIndex === 0 ? "main" as const : "fallback" as const,
          variantKind: variant.kind,
          query: variant.query,
        };
        try {
          const result = await executeSearch({ ...request, query: variant.query });
          results.push(result);
          const taken = result.listings.slice(0, EXACT_PRODUCT_CANDIDATES_PER_QUERY);
          queryAttempts.push({
            ...attemptBase,
            outcome: "succeeded",
            upstreamCount: result.listings.length,
            candidateCount: taken.length,
            newCandidateCount: taken
              .filter((listing) => !candidates.has(candidateKey(listing.sourceId, listing.sourceItemId))).length,
            sourceItemIds: taken.map((listing) => listing.sourceItemId),
            durationMs: Date.now() - attemptStartedAt,
          });
          // 与手动搜索同一口径：每条查询只收上游前 N 名，详情预算不撒进整页后排。
          taken.forEach((listing, index) => addCandidate(candidates, listing, {
            variantId: variant.id,
            query: variant.query,
            kind: variant.kind,
            lane: "source_native",
            upstreamRank: index + 1,
            weight: variant.weight,
            liveVerified: true,
          }));
        } catch (error) {
          lastError = error;
          queryAttempts.push({
            ...attemptBase,
            outcome: "failed",
            upstreamCount: 0,
            candidateCount: 0,
            newCandidateCount: 0,
            sourceItemIds: [],
            errorMessage: error instanceof Error ? error.message : "来源失败",
            durationMs: Date.now() - attemptStartedAt,
          });
          warnings.push(`同款查询「${variant.query}」未完成：${error instanceof Error ? error.message.slice(0, 220) : "来源失败"}`);
        }
      }
      if (results.length === 0) throw lastError ?? new Error("商品名同款雷达没有完成任何来源查询");

      // 本轮候选集就是这件商品的邻居，用它统计词频，让匹配器知道这个系列里
      // 哪些词是人人都有的废话、哪些词才是区别（见 buildProductMatchCorpus）。
      const corpus = buildProductMatchCorpus([...candidates.values()].map((value) => value.listing), exactPlan.target);
      if (adapter.getItem) {
        const purchasableCandidates = [...candidates.values()]
          .filter((candidate) => ["available", "preorder", "backorder"].includes(candidate.listing.availability));
        // 详情补抓的去重水位。原来那道 rawMetadata.detailHydrated 守卫是死的：
        // 这个字段全仓库只有 surugaya-direct 会写，其余来源的搜索结果里根本没有它，
        // 于是同一件商品每天被重复补抓 4 轮 × N 来源。水位改从库里读
        // （listings.detail_hydrated_at），跨轮次有效。
        //
        // 跳过抓取不等于让匹配器变瞎：上一次补抓的描述与结构化属性就在库里，
        // 这里原样贴回本轮的搜索结果，判定证据和真抓一次是同一份。
        const storedDetails = purchasableCandidates.length > 0
          ? await repository.storedListingDetails(purchasableCandidates.map((candidate) => ({
              sourceId: candidate.listing.sourceId,
              sourceItemId: candidate.listing.sourceItemId,
            })))
          : new Map<string, StoredListingDetail>();
        const hydrationFloor = Date.now() - EXACT_PRODUCT_DETAIL_HYDRATION_TTL_MS;
        const freshlyStored = new Set<string>();
        for (const candidate of purchasableCandidates) {
          const key = candidateKey(candidate.listing.sourceId, candidate.listing.sourceItemId);
          const stored = storedDetails.get(key);
          const hydratedAt = stored?.detailHydratedAt ? Date.parse(stored.detailHydratedAt) : Number.NaN;
          // 库里已有详情的候选照样补厚，那不花任何上游预算，也不占下面的请求名额。
          if (stored && Number.isFinite(hydratedAt) && hydratedAt >= hydrationFloor) {
            candidate.listing = applyStoredListingDetail(candidate.listing, stored);
            freshlyStored.add(key);
          }
        }
        // 派单依据与手动搜索同一套（planCandidateDetailActions）：看「这次详情能解决什么」，
        // 不是按分数从高往低挑。已被程序判定为异类/有硬冲突的不再花请求——2026-09-12 重搜
        // 12 次详情里有 10 次花在这一类上；只差一个版本词、标题写得简略的候选优先。
        const detailActions = planCandidateDetailActions(
          purchasableCandidates.map((candidate) => {
            const key = candidateKey(candidate.listing.sourceId, candidate.listing.sourceItemId);
            const itemTarget = candidate.listing.canonicalUrl || candidate.listing.sourceItemId;
            const detailCapability: CandidateDetailCapability = adapter.canGetItem?.(itemTarget) === false
              ? "unsupported_item"
              : "supported";
            return {
              key,
              hits: candidate.hits,
              match: assessProductMatch(candidate.listing, exactPlan.target!, candidate.hits, corpus),
              detailHydrated: freshlyStored.has(key) || candidate.listing.rawMetadata?.detailHydrated === true,
              detailCapability,
              availability: candidate.listing.availability,
              candidate,
            };
          }),
          EXACT_PRODUCT_WATCH_DETAIL_LIMIT,
        );
        for (const { candidate: { candidate } } of detailActions) {
          try {
            const detail = await itemWithConfiguredRoute(
              env,
              adapter,
              candidate.listing.canonicalUrl || candidate.listing.sourceItemId,
              adapterContext,
              { browserFetch: capturedBrowserFetch, routeSession },
            );
            candidate.listing = mergeSearchAndDetailListing(candidate.listing, detail);
          } catch (error) {
            warnings.push(`候选 ${candidate.listing.sourceItemId} 详情复核失败：${error instanceof Error ? error.message.slice(0, 180) : "详情失败"}`);
          }
        }
      }

      // Deterministic matching removes obvious noise and hard-conflicting
      // variants. Ambiguous abbreviations stay in the candidate set so the
      // persistent Gemini job can make the semantic relevance decision.
      const assessedCandidates = [...candidates.values()]
        .map((candidate) => ({
          listing: candidate.listing,
          evidence: searchCandidateEvidence(candidate.hits, assessProductMatch(candidate.listing, exactPlan.target!, candidate.hits, corpus)),
        }));
      // 复核名额只给在售的：已售出的就算选中，下面 cleaningCandidates 也会把它滤掉，名额白占。
      // 绝版货搜出来一大半是同名已售（2026-10-10 メダリスト展 一轮 23 件高度疑似里 13 件已售），
      // 不先滤掉，在售的真同款会被挤出名额，按"没轮到复核"处理（m30058906515 ¥5,000）。
      const reviewKeys = new Set(selectProductSearchAiReviewCandidates(
        assessedCandidates
          .filter(({ listing }) => ["available", "preorder", "backorder"].includes(listing.availability))
          .map(({ listing, evidence }) => ({
            key: candidateKey(listing.sourceId, listing.sourceItemId),
            evidence,
          })),
        PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT,
      ).map(({ key }) => key));
      exactAuditCandidates = assessedCandidates.map(({ listing, evidence }) => ({
        listing,
        relation: evidence.match?.relation ?? "uncertain",
        reviewSelected: evidence.match?.relation === "exact"
          || reviewKeys.has(candidateKey(listing.sourceId, listing.sourceItemId)),
        differenceNote: describeProductMatchDifference(evidence.match?.difference),
      }));
      const cleaningCandidates = assessedCandidates
        .filter(({ listing, evidence }) => evidence.match?.relation === "exact"
          || reviewKeys.has(candidateKey(listing.sourceId, listing.sourceItemId)))
        .filter(({ listing }) => ["available", "preorder", "backorder"].includes(listing.availability))
        .sort((left, right) => compareProductSearchCandidates(left.evidence, right.evidence))
        .map(({ listing, evidence }) => {
          exactMatchRelations.set(
            candidateKey(listing.sourceId, listing.sourceItemId),
            evidence.match?.relation ?? "uncertain",
          );
          return listing;
        });
      const primary = results[0]!;
      const mergedEvidence = mergedRequestEvidence(results, cleaningCandidates.length);
      return {
        ...primary,
        listings: cleaningCandidates,
        warnings: [...new Set([...primary.warnings, ...warnings, ...exactPlan.warnings])],
        requestEvidence: mergedEvidence,
      };
    };
    // 上新窗口的锚定状态。new_listing_anchored_at 为空表示这个绑定还没有建立过可信的
    // 深度基线（历史上只读了一页），本轮用更大的页预算重新锚定，并且**不产生上新通知**：
    // 深挖出来的都是早就在架的存量，把它们当成今天的新品会直接刷屏。
    // 精确同款走 executeExactProductSearch 的变体扇出，不用这套时间窗口，
    // 也不能被静默：它的首轮命中本来就是用户要的发现结果。
    const newListingBinding = binding.monitoring_purpose === "keyword_new_listing";
    const windowBinding = newListingBinding && !exactProductBinding;
    const anchored = Boolean(binding.new_listing_anchored_at);
    const anchorPass = windowBinding && !anchored;
    const windowPageBudget = windowBinding
      ? newListingPageBudget({ sourceId: binding.source_id, anchored })
      : 1;
    const knownSourceItemIds = binding.kind === "keyword"
      ? new Set(await repository.knownSourceItemIds(binding.id))
      : new Set<string>();
    const newListingWatermark = binding.new_listing_watermark ?? undefined;
    const searchStartedAt = Date.now();
    // 普通关键词档案只发档案本身那一个词（上新窗口可能翻多页，仍是同一个词）。
    const plainKeywordSearch = binding.kind === "keyword" && !exactProductBinding;
    const unfilteredResult = await (async () => {
      try {
        return binding.kind !== "keyword"
          ? await runItemBinding(adapter, binding, env, captureRecorder.fetch, capturedBrowserFetch, skippedPrimaryFailure)
          : exactProductBinding
            ? await executeExactProductSearch()
          : windowPageBudget > 1
            ? await collectNewListingWindow(
                request,
                windowPageBudget,
                executeSearch,
                {
                  knownSourceItemIds,
                  ...(newListingWatermark === undefined ? {} : { watermark: newListingWatermark }),
                  // 锚定轮读满预算：收敛判据此时只会立刻成立，深度预算等于白给。
                  ...(anchorPass ? { exhaustive: true } : {}),
                },
              )
            : await executeSearch(request);
      } catch (error) {
        // 失败的这一轮也要留一行，不然拿这张表算失败率、主词命中率时失败轮次看不见（10-14 code review）。
        // 外层 catch 会把 queryAttempts 写进库。
        if (plainKeywordSearch) queryAttempts.push({
          role: "main",
          variantKind: "original",
          query: request.query,
          outcome: "failed",
          upstreamCount: 0,
          candidateCount: 0,
          newCandidateCount: 0,
          sourceItemIds: [],
          errorMessage: error instanceof Error ? error.message : "来源失败",
          durationMs: Date.now() - searchStartedAt,
        });
        throw error;
      }
    })();
    if (plainKeywordSearch) {
      queryAttempts.push({
        role: "main",
        variantKind: "original",
        query: request.query,
        outcome: "succeeded",
        upstreamCount: unfilteredResult.listings.length,
        candidateCount: unfilteredResult.listings.length,
        // 「新增」= 这个绑定以前没见过的商品，和精确同款那边同一口径；以前直接填了总数，老货也算成新货。
        newCandidateCount: unfilteredResult.listings
          .filter((listing) => !knownSourceItemIds.has(listing.sourceItemId)).length,
        sourceItemIds: unfilteredResult.listings.map((listing) => listing.sourceItemId),
        durationMs: Date.now() - searchStartedAt,
      });
    }
    await stageWatchQueryAttempts(env.DB, { id: run.id, bindingId: binding.id, sourceId: binding.source_id }, queryAttempts);
    await stageSourceCaptures(env.DB, run.id, await captureRecorder.flush());
    const previousTypicalCount = await repository.previousTypicalCount(binding.id);
    const requestEvidence = (unfilteredResult as SearchResult).requestEvidence;
    const rawResultCount = requestEvidence?.rawResultCount ?? unfilteredResult.listings.length;
    const windowTruncated = (unfilteredResult as RoutedSearchResult).windowTruncated === true;
    // 锚定轮读到的真实深度。后续页失败被容忍（保留已采到的页、整轮仍报 success），
    // 所以"没读满预算"不会以失败的形式表现出来，只能靠这里核对。
    const windowPagesFetched = requestEvidence?.pagesFetched ?? 1;
    const anchorAttempt = anchorPass ? (binding.new_listing_anchor_attempts ?? 0) + 1 : 0;
    const anchorSettled = anchorPass && newListingAnchorSettled({
      sourceId: binding.source_id,
      pagesFetched: windowPagesFetched,
      windowTruncated,
      attempt: anchorAttempt,
    });
    if (anchorPass && !anchorSettled) {
      // 深挖没挖够就落锁，等于把这个绑定的深挖机会永久用掉；留给下一轮重来。
      console.warn(JSON.stringify({
        event: "keyword_new_listing_anchor_deferred",
        bindingId: binding.id,
        sourceId: binding.source_id,
        watchRunId: run.id,
        pageBudget: windowPageBudget,
        pagesFetched: windowPagesFetched,
        dailyPageBudget: newListingDailyPageBudget(binding.source_id),
        attempt: anchorAttempt,
        maxAttempts: NEW_LISTING_ANCHOR_MAX_ATTEMPTS,
      }));
    }
    await persistWatchRunListingAudit(
      repository,
      binding,
      run.id,
      unfilteredResult.fetchedAt,
      exactProductBinding
        ? exactAuditCandidates
        : unfilteredResult.listings.map((listing) => ({ listing })),
    );
    if (isUnexpectedEmptySearch({
      bindingKind: binding.kind,
      exactProduct: exactProductBinding,
      previousTypicalCount,
      rawResultCount,
      collectionOutcome: requestEvidence?.collectionOutcome,
    })) {
      throw new ParserStructureError(`结果从典型值 ${previousTypicalCount} 条骤降为 0 条`);
    }
    const profileIncludeTerms = stringArrayJson(binding.profile_include_terms_json);
    const profileExcludeTerms = stringArrayJson(binding.profile_exclude_terms_json);
    const ruleScopeListings = binding.kind === "keyword" && !exactProductBinding
      ? filterListings(unfilteredResult.listings, {}, profileIncludeTerms, profileExcludeTerms)
      : unfilteredResult.listings;
    // 用户屏蔽的单品（景品、一番赏这类天天有新卖家挂出来的）在 AI 之前挡掉，不再花额度判。
    const mutedProducts = binding.kind === "keyword" && !exactProductBinding
      ? await repository.mutedProducts(binding.watch_profile_id)
      : [];
    // 档案的最低价是送达门槛，不是搜索条件（改它不重置基线），所以不传给来源，在这里挡。
    // 价格缺失的不挡；拍卖按当前出价比。
    const minListingPrice = binding.kind === "keyword" && !exactProductBinding
      && binding.profile_min_listing_price !== null && binding.profile_min_listing_price !== undefined
      ? Number(binding.profile_min_listing_price)
      : undefined;
    const thresholdHits = new Map<string, { listing: NormalizedListing; label: string }>();
    for (const listing of ruleScopeListings) {
      const rule = mutedProducts.length > 0 ? matchingMutedProduct(listing.title, mutedProducts) : undefined;
      const tooCheap = minListingPrice !== undefined && listing.currentPrice !== undefined && listing.currentPrice < minListingPrice;
      if (!rule && !tooCheap) continue;
      thresholdHits.set(candidateKey(listing.sourceId, listing.sourceItemId), {
        listing,
        label: rule ? `你屏蔽了这件商品（${mutedProductLabel(rule.termGroups)}）` : `低于档案最低价 ¥${minListingPrice}`,
      });
    }
    const keywordScopeListings = thresholdHits.size > 0
      ? ruleScopeListings.filter((listing) => !thresholdHits.has(candidateKey(listing.sourceId, listing.sourceItemId)))
      : ruleScopeListings;
    const thresholdByReason = new Map<string, string[]>();
    for (const hit of thresholdHits.values()) {
      thresholdByReason.set(hit.label, [...(thresholdByReason.get(hit.label) ?? []), hit.listing.sourceItemId]);
    }
    for (const [label, sourceItemIds] of thresholdByReason) {
      await repository.applyKeywordRuleExclusions({
        runId: run.id,
        bindingId: binding.id,
        sourceId: binding.source_id,
        sourceItemIds,
        reason: label,
      });
    }
    if (binding.kind === "keyword" && !exactProductBinding
        && ruleScopeListings.length !== unfilteredResult.listings.length) {
      const acceptedKeys = new Set(ruleScopeListings.map((listing) => (
        candidateKey(listing.sourceId, listing.sourceItemId)
      )));
      // 原因按条写清楚：没含必须词，还是命中了哪个排除词、在标题里还是只在说明里。
      // App「被筛掉的」列表靠 decision_reason 以「命中排除词」开头找出这些商品给人回查（怕排除词误伤）。
      const byReason = new Map<string, string[]>();
      for (const listing of unfilteredResult.listings) {
        if (acceptedKeys.has(candidateKey(listing.sourceId, listing.sourceItemId))) continue;
        const miss = keywordRuleMiss(listing, profileIncludeTerms, profileExcludeTerms);
        const reason = miss?.kind === "exclude_hit"
          ? `命中排除词「${miss.term}」（${miss.inTitle ? "标题" : "只在说明或店名里"}）`
          : "未满足当前关键词档案的必须包含规则";
        byReason.set(reason, [...(byReason.get(reason) ?? []), listing.sourceItemId]);
      }
      for (const [reason, sourceItemIds] of byReason) {
        await repository.applyKeywordRuleExclusions({
          runId: run.id,
          bindingId: binding.id,
          sourceId: binding.source_id,
          sourceItemIds,
          reason,
        });
      }
    }
    const deterministicListings = binding.kind === "keyword"
      ? filterListings(
          keywordScopeListings,
          supportedPostSearchFilters(
            binding.source_id,
            exactProductBinding ? analyticsFilters : filters,
          ),
        )
      : unfilteredResult.listings;
    // Exact-product watches intentionally fan out several query variants and
    // may append a separate sold-out evidence page. That candidate corpus is
    // not a stable keyword window, so comparing it with the prior accepted
    // match baseline can misclassify legitimate sale evidence as source churn.
    //
    // 深度锚定轮同样不能用换血启发式判断：它按设计就要读到比日常巡回深得多的位置，
    // "本轮几乎全是没见过的商品"正是预期结果，而不是来源退化的信号。
    if (binding.kind === "keyword" && !exactProductBinding && !anchorPass) {
      const assessment = assessKeywordWindow({
        listings: deterministicListings,
        knownSourceItemIds,
        previousTypicalCount,
        intervalMinutes: binding.schedule_interval_minutes,
        coverage: unfilteredResult.coverage,
      });
      if (assessment.status === "anomalous") {
        const fields = listingFieldCompleteness(deterministicListings, adapter.fieldProfile?.required);
        const message = assessment.reason ?? "关键词结果窗口疑似来源退化";
        await repository.incrementCounter("search_calls");
        await repository.finishRun(run, {
          status: "skipped",
          coverage: unfilteredResult.coverage,
          resultCount: deterministicListings.length,
          newCount: 0,
          changedCount: 0,
          parserVersion: adapter.parserVersion,
          errorCode: "suspected_source_degradation",
          errorMessage: message,
          fieldTotal: fields.total,
          fieldComplete: fields.complete,
        });
        console.warn(JSON.stringify({
          event: "keyword_window_rejected",
          bindingId: binding.id,
          sourceId: binding.source_id,
          ...assessment,
        }));
        return;
      }
    }
    await scheduleWatchAnalytics(env, marketAnalyticsRun(
      binding,
      run.id,
      unfilteredResult,
      analyticsFilters,
      Date.now() - run.startedAt,
    ));
    if (binding.kind === "keyword" && "routeOutcome" in unfilteredResult
      && unfilteredResult.routeOutcome.kind === "fallback_success") {
      await recordPreviewSuccess(env, binding.source_id, unfilteredResult);
    }

    if (binding.kind === "keyword" && !exactProductBinding
        && unfilteredResult.listings.length > 0 && keywordScopeListings.length === 0) {
      const includesMatched = filterListings(unfilteredResult.listings, {}, profileIncludeTerms).length;
      const excludedNormally = includesMatched > 0;
      const message = excludedNormally
        ? `采集成功，已抓取 ${unfilteredResult.listings.length} 条商品；符合必须包含规则的 ${includesMatched} 条均命中排除词或你屏蔽的单品，本轮无符合条件商品。原始采集证据已保留。`
        : `采集成功，已抓取 ${unfilteredResult.listings.length} 条商品，但均未满足必须包含规则。本轮无匹配结果；若持续如此，可检查关键词别名。原始采集证据已保留。`;
      // This is a dossier filter outcome, not a source failure. Preserve an
      // unfinished initial baseline and keep the source available for polling.
      if (binding.baseline_completed === 1) await repository.completeBinding(binding);
      await repository.incrementCounter("search_calls");
      const fields = listingFieldCompleteness(unfilteredResult.listings, adapter.fieldProfile?.required);
      await repository.finishRun(run, {
        status: "success",
        coverage: unfilteredResult.coverage,
        resultCount: 0,
        newCount: 0,
        changedCount: 0,
        parserVersion: adapter.parserVersion,
        fieldTotal: fields.total,
        fieldComplete: fields.complete,
        errorCode: excludedNormally ? "keyword_rules_excluded_all" : "keyword_rules_filtered_all",
        errorMessage: message,
        healthEvidence: {
          rawResultCount,
          pageDepth: requestEvidence?.pagesFetched ?? 1,
          cursorTerminationReason: (unfilteredResult as SearchResult).nextCursor ? "budget_reached" : "exhausted",
        },
      });
      if (!excludedNormally) {
        await repository.recordKeywordRuleWarning(binding, message);
        deliverNotificationsAfterRun = true;
      }
      return;
    }

    if (binding.monitoring_purpose === "keyword_new_listing" && deterministicListings.length > 0) {
      // 水位线只记录"这一轮采集覆盖到哪里"，与 AI 清洗判定无关，所以采集一成功就写。
      // 顺序上必须排在 AI 派单**之前**：这是一次幂等、单调的簿记写入，一旦它失败，
      // 整轮会被判失败并重试——排在派单之后就意味着每次重试都重新烧一遍 Gemini 额度，
      // 还会把来源打进冷却。排在前面则失败零成本，且失败本身仍然是响亮的。
      // 精确同款的结果是多个查询变体的候选集合而不是一个时间窗口，
      // 从中取最大上架时间没有意义，只记锚定时间。
      await repository.advanceNewListingWatermark(binding.id, {
        ...(windowBinding
          ? { watermark: nextNewListingWatermark(newListingWatermark, unfilteredResult.listings) }
          : {}),
        // 精确同款不走时间窗口，没有"深度够不够"可言，照旧一轮落锁。
        ...(anchored || (anchorPass && !anchorSettled) ? {} : { anchoredAt: new Date().toISOString() }),
        ...(anchorPass ? { anchorAttempts: anchorAttempt } : {}),
      });
      let derivativeJobId: string | null = null;
      try {
        const derivative = await enqueueKeywordGeminiJob(env, {
          bindingId: binding.id,
          watchRunId: run.id,
          trigger: job.trigger,
          scanStartedAt: job.queuedAt,
          // 深度锚定轮把存量一次性挖出来，它们不是今天的新品；沿用基线未完成的静默语义。
          baselineCompleted: binding.baseline_completed === 1 && !anchorPass,
          ...(newListingWatermark === undefined ? {} : { watermark: newListingWatermark }),
          query: binding.query ?? "",
          targetLabel: binding.profile_name,
          targetDescription: binding.profile_description ?? undefined,
          listings: deterministicListings,
          includeTerms: profileIncludeTerms,
          excludeTerms: profileExcludeTerms,
          ...(exactProductBinding && exactPlan?.target ? {
            searchMode: "exact_product" as const,
            productTarget: exactPlan.target,
            matchRelations: deterministicListings.map((listing) => (
              exactMatchRelations.get(candidateKey(listing.sourceId, listing.sourceItemId)) ?? "uncertain"
            )),
            matcherVersion: PRODUCT_MATCH_VERSION,
          } : { searchMode: "keyword" as const }),
        });
        derivativeJobId = derivative.jobId;
        if (derivative.skippedItems > 0) {
          console.warn(JSON.stringify({
            event: "keyword_derivative_partially_queued",
            sourceId: binding.source_id,
            bindingId: binding.id,
            watchRunId: run.id,
            collectedItems: deterministicListings.length,
            queuedItems: derivative.queuedItems,
            skippedItems: derivative.skippedItems,
          }));
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: "keyword_derivative_enqueue_failed",
          sourceId: binding.source_id,
          bindingId: binding.id,
          watchRunId: run.id,
          collectedItems: deterministicListings.length,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: error instanceof AdapterError ? error.code : "derivative_enqueue_failed",
        }));
      }
      // 有在途 AI 任务时基线只能由 finalizeKeywordJob 成功后回写（否则任务失败会在
      // 下一轮把整窗口商品误判为新品洪水）；没有在途任务时按旧行为立即完成。
      if (!derivativeJobId) await repository.completeBinding(binding);
      await repository.incrementCounter("search_calls");
      const fields = listingFieldCompleteness(deterministicListings, adapter.fieldProfile?.required);
      if (windowTruncated) {
        console.warn(JSON.stringify({
          event: "keyword_new_listing_window_truncated",
          bindingId: binding.id,
          sourceId: binding.source_id,
          watchRunId: run.id,
          pageBudget: windowPageBudget,
          pagesFetched: (unfilteredResult as SearchResult).requestEvidence?.pagesFetched ?? 1,
          collectedItems: unfilteredResult.listings.length,
        }));
      }
      await repository.finishRun(run, {
        status: "success",
        coverage: unfilteredResult.coverage,
        resultCount: deterministicListings.length,
        newCount: 0,
        changedCount: 0,
        parserVersion: adapter.parserVersion,
        fieldTotal: fields.total,
        fieldComplete: fields.complete,
        healthEvidence: {
          rawResultCount: (unfilteredResult as SearchResult).requestEvidence?.rawResultCount ?? unfilteredResult.listings.length,
          pageDepth: (unfilteredResult as SearchResult).requestEvidence?.pagesFetched ?? 1,
          // budget_reached 现在精确表示"本轮覆盖不完整"：预算耗尽而窗口还没回溯到既有覆盖范围。
          // 旧实现只看 nextCursor 是否存在，于是正常收敛的轮次也被记成 budget_reached，
          // 掩盖了真正被截断的那些轮。
          cursorTerminationReason: windowTruncated ? "budget_reached" : "exhausted",
        },
      });
      return;
    }
    const result = { ...unfilteredResult, listings: deterministicListings };

    let newCount = 0;
    let changedCount = 0;
    const eventGroups: Array<{ listingId: string; events: ReturnType<typeof evaluateListingEvents> }> = [];
    const listingStates = await repository.findListingsWithMatchState(
      binding.id,
      result.listings.map((listing) => ({
        sourceId: listing.sourceId,
        sourceItemId: listing.sourceItemId,
      })),
    );
    for (const listing of result.listings) {
      const deterministicListing = listingForDeterministicState(listing);
      const stored = await repository.persistListing(binding, deterministicListing, {
        prefetched: listingStates.get(candidateKey(listing.sourceId, listing.sourceItemId)) ?? {
          listing: null,
          matched: false,
        },
      });
      if (stored.isNewMatch) newCount += 1;
      if (stored.changed) changedCount += 1;
      const oldPrice = validComparablePrice(stored.previous?.current_price ?? undefined);
      const newPrice = deterministicListing.currentPrice;
      const droppedEnough = oldPrice !== undefined && newPrice !== undefined
        && newPrice < oldPrice && oldPrice - newPrice >= binding.min_drop_amount;
      const crossedTarget = binding.target_price !== null && oldPrice !== undefined && newPrice !== undefined
        && oldPrice > binding.target_price && newPrice <= binding.target_price;
      if (binding.monitoring_purpose === "item_price" && ((binding.notify_price_drop === 1 && droppedEnough) || crossedTarget)) {
        const candidateNewPrice = newPrice ?? 0;
        await monitorQueueFor(env, binding.source_id).send({
          idempotencyKey: `confirm_price_drop:${binding.id}:${stored.listingId}:${candidateNewPrice}`,
          type: "confirm_price_drop", bindingId: binding.id, listingId: stored.listingId,
          expectedOldPrice: oldPrice ?? 0, candidateNewPrice, queuedAt: new Date().toISOString(),
        } satisfies ConfirmPriceDropJob, { delaySeconds: 30 });
      }
      const events = evaluateListingEvents({
        bindingId: binding.id,
        listingId: stored.listingId,
        previous: stored.previous ? {
          price: validComparablePrice(stored.previous.current_price ?? undefined),
          availability: stored.previous.availability as "available" | "sold_out" | "unavailable" | "preorder" | "backorder" | "unknown",
          stateHash: stored.previous.state_hash ?? undefined,
        } : undefined,
        current: { price: deterministicListing.currentPrice, availability: deterministicListing.availability, stateHash: stored.stateHash },
        isNewMatch: stored.isNewMatch,
        baselineCompleted: binding.baseline_completed === 1,
        notifyInitial: binding.notify_initial === 1,
        notifyNewListing: binding.notify_new_listing === 1,
        notifyPriceDrop: binding.notify_price_drop === 1,
        notifyPriceRise: binding.notify_price_rise === 1,
        notifyRestock: binding.notify_restock === 1,
        notifySoldOut: binding.notify_sold_out === 1,
        targetPrice: binding.target_price ?? undefined,
        minDropAmount: binding.min_drop_amount,
        availabilityChangeConfirmed: binding.kind === "item" && deterministicListing.availability === "unavailable",
        observedAt: result.fetchedAt,
      });
      const directItem = binding.kind === "item" && deterministicListing.sourceId === binding.source_id
        && (!binding.source_item_id || deterministicListing.sourceItemId === binding.source_item_id);
      if (directItem) {
        // 热度：详情页里的点赞 / 评论数，涨了就提醒（单品档案都是用户亲手挑的，不另设开关）。
        const interest = listingInterest(deterministicListing);
        const previousInterest = await repository.recordListingInterest(stored.listingId, interest, result.fetchedAt);
        const interestEvent = previousInterest && interestRiseEvent({
          bindingId: binding.id,
          listingId: stored.listingId,
          previous: previousInterest,
          current: interest,
          availability: deterministicListing.availability,
        });
        if (interestEvent) events.push(interestEvent);
      }
      if (events.length > 0) eventGroups.push({ listingId: stored.listingId, events });
      if (directItem) {
        await repository.recordItemScheduleObservation(binding, {
          price: validComparablePrice(deterministicListing.currentPrice) ?? null,
          availability: deterministicListing.availability,
        }, { scheduled: job.trigger === "cron" });
      }
    }
    await repository.insertEventBatch(binding, eventGroups);
    await repository.completeBinding(binding);
    await repository.incrementCounter(binding.kind === "keyword" ? "search_calls" : "detail_calls");
    const fields = listingFieldCompleteness(result.listings, adapter.fieldProfile?.required);
    await repository.finishRun(run, {
      status: "success",
      coverage: result.coverage,
      resultCount: result.listings.length,
      newCount,
      changedCount,
      parserVersion: adapter.parserVersion,
      fieldTotal: fields.total,
      fieldComplete: fields.complete,
      healthEvidence: {
        rawResultCount: (result as SearchResult).requestEvidence?.rawResultCount ?? result.listings.length,
        pageDepth: (result as SearchResult).requestEvidence?.pagesFetched ?? 1,
        cursorTerminationReason: (result as SearchResult).nextCursor ? "budget_reached" : "exhausted",
      },
    });
    if (binding.monitoring_purpose === "keyword_new_listing") {
      if (job.trigger !== "cron") {
        const scanFinishedAt = new Date().toISOString();
        await repository.prepareKeywordDigest({
          profileId: binding.watch_profile_id,
          bindingIds: [binding.id],
          ...(binding.baseline_completed === 0 ? { initialBaselineBindingIds: [binding.id] } : {}),
          scanStartedAt: job.queuedAt,
          scanFinishedAt,
          digestKey: `keyword_digest:${binding.watch_profile_id}:${job.queuedAt}`,
          failedSources: [],
        });
        deliverNotificationsAfterRun = true;
      }
    } else {
      deliverNotificationsAfterRun = true;
    }
  } catch (error) {
    // 搜索阶段已写过的不会重复写（ON CONFLICT），这里兜住"所有词都失败"那一轮。
    await stageWatchQueryAttempts(env.DB, { id: run.id, bindingId: binding.id, sourceId: binding.source_id }, queryAttempts);
    try {
      await stageSourceCaptures(env.DB, run.id, await captureRecorder.flush());
    } catch (captureError) {
      console.error(JSON.stringify({
        message: "source_capture_stage_failed",
        bindingId: binding.id,
        runId: run.id,
        error: captureError instanceof Error ? captureError.message : "unknown",
      }));
    }
    const adapterError = error instanceof AdapterError ? error : undefined;
    const message = error instanceof Error ? error.message : "未知采集错误";
    const lowerMessage = message.toLowerCase();
    if (adapterError?.code === "source_runner_repair_pending") {
      await repository.markRunAwaitingBusinessRepair(
        binding,
        run,
        message,
        adapterError.retryAfterSeconds,
      );
      console.warn(JSON.stringify({
        event: "source_runner_business_repair_pending",
        sourceId: binding.source_id,
        bindingId: binding.id,
        runId: run.id,
        retryAfterSeconds: adapterError.retryAfterSeconds ?? 120,
      }));
      return;
    }
    const rakutenMissingItem = binding.source_id === "rakuten_ichiba"
      && binding.kind === "item"
      && adapterError?.status === 404;
    if (rakutenMissingItem) {
      const unavailable = await repository.markBindingListingUnavailable(binding.id);
      if (unavailable) {
        const lifecycleEvents = evaluateListingEvents({
          bindingId: binding.id,
          listingId: unavailable.listingId,
          previous: unavailable.previous,
          current: unavailable.current,
          baselineCompleted: binding.baseline_completed === 1,
          notifyInitial: false,
          notifyNewListing: false,
          notifyPriceDrop: false,
          // 乐天 404：商品已消失，没有可比的新价格。
          notifyPriceRise: false,
          notifyRestock: false,
          notifySoldOut: binding.notify_sold_out === 1,
          minDropAmount: binding.min_drop_amount,
          availabilityChangeConfirmed: true,
          observedAt: unavailable.observedAt,
        });
        await repository.insertEvents(binding, unavailable.listingId, lifecycleEvents);
        if (lifecycleEvents.length > 0) deliverNotificationsAfterRun = true;
      }
      const nextRunAt = await repository.deferTemporarilyUnavailableItem(binding.id, 24);
      const autoPaused = await repository.pauseLongUnavailableItem(binding.id, UNAVAILABLE_ITEM_PAUSE_DAYS);
      await repository.finishRun(run, {
        status: "skipped",
        coverage: adapter.coverage,
        resultCount: 0,
        newCount: 0,
        changedCount: unavailable ? 1 : 0,
        parserVersion: adapter.parserVersion,
        httpStatus: 404,
        errorCode: "rakuten_item_temporarily_unavailable",
        errorMessage: autoPaused
          ? `商品页下架满 ${UNAVAILABLE_ITEM_PAUSE_DAYS} 天未恢复，已自动暂停监控`
          : `商品页当前不可见；保留监控并降频至 ${nextRunAt}`,
        healthEvidence: { cursorTerminationReason: "not_applicable" },
      });
      return;
    }
    // Mercari 对"卖家已删除商品"回 410（mercari_item_gone），对"查无此商品"回 404。
    // 两者都是这一条商品终结，不是来源故障。此前只认 404，410 一路掉进下面的通用
    // 失败分支：商品状态永远停在最后一次成功抓取的"在售"，consecutive_failures
    // 却一直涨，连带把整个 mercari_jp 标成 degraded 并发来源故障邮件。
    // 跟踪任务那条路径（isTrackedListingMissing）一直是 404/410 都收，这里复用它，
    // 避免再出现两份各自维护的状态码名单。
    const mercariMissingItem = binding.source_id === "mercari_jp" && binding.kind === "item"
      && isTrackedListingMissing(error);
    const confirmedMissingItem = mercariMissingItem && binding.consecutive_failures + 1 >= 2;
    const abnormalEmpty = error instanceof ParserStructureError && message.includes("骤降为 0");
    const errorCode = abnormalEmpty
      ? "keyword_result_count_drop"
      : confirmedMissingItem
      ? "mercari_item_unavailable"
      : mercariMissingItem
        ? "mercari_item_not_found_unconfirmed"
        : error instanceof ParserStructureError ? "parser_structure_error" : adapterError?.code ?? "collector_error";
    if (errorCode === "yahoo_auctions_local_rate_limited") {
      await repository.finishRun(run, {
        status: "skipped",
        coverage: adapter.coverage,
        resultCount: 0,
        newCount: 0,
        changedCount: 0,
        parserVersion: adapter.parserVersion,
        errorCode,
        errorMessage: message,
        healthEvidence: { cursorTerminationReason: "not_applicable" },
      });
      throw error;
    }
    if (confirmedMissingItem) {
      const unavailable = await repository.markBindingListingUnavailable(binding.id);
      if (unavailable) {
        const lifecycleEvents = evaluateListingEvents({
          bindingId: binding.id,
          listingId: unavailable.listingId,
          previous: unavailable.previous,
          current: unavailable.current,
          baselineCompleted: binding.baseline_completed === 1,
          notifyInitial: false,
          notifyNewListing: false,
          notifyPriceDrop: false,
          // 商品已确认消失：没有可比的新价格，涨价无从谈起。
          notifyPriceRise: false,
          notifyRestock: false,
          notifySoldOut: binding.notify_sold_out === 1,
          minDropAmount: binding.min_drop_amount,
          availabilityChangeConfirmed: true,
          observedAt: unavailable.observedAt,
        });
        await repository.insertEvents(binding, unavailable.listingId, lifecycleEvents);
        if (lifecycleEvents.length > 0) deliverNotificationsAfterRun = true;
      }
      // 商品确认消失就是这条监控的结论，不是采集失败。继续往下走 failBinding 会
      // 把 mercari_jp 整个来源记成 degraded，并在连续 3 次后发来源故障邮件——
      // 商品早就没了，故障邮件却每天照发。这里和乐天缺货那条分支一样收尾：
      // 清零失败计数、降频保留监控、本轮记 skipped。
      const nextRunAt = await repository.deferTemporarilyUnavailableItem(binding.id, 24);
      const autoPaused = await repository.pauseLongUnavailableItem(binding.id, UNAVAILABLE_ITEM_PAUSE_DAYS);
      await repository.finishRun(run, {
        status: "skipped",
        coverage: adapter.coverage,
        resultCount: 0,
        newCount: 0,
        changedCount: unavailable ? 1 : 0,
        parserVersion: adapter.parserVersion,
        httpStatus: adapterError?.status,
        errorCode: "mercari_item_unavailable",
        errorMessage: autoPaused
          ? `商品下架满 ${UNAVAILABLE_ITEM_PAUSE_DAYS} 天未恢复，已自动暂停监控`
          : `商品已确认不可见；保留监控并降频至 ${nextRunAt}`,
        healthEvidence: { cursorTerminationReason: "not_applicable" },
      });
      return;
    }
    await repository.failBinding(binding, errorCode, message, adapterError?.status, adapterError?.retryAfterSeconds);
    if (sameDayRetryEligible(binding, errorCode, adapterError?.status)) {
      try {
        await scheduleSameDayRetry(env, binding, new Date(run.startedAt).toISOString(), KEYWORD_DIGEST_DELAY_SECONDS);
      } catch (retryError) {
        console.error(JSON.stringify({
          event: "same_day_retry_schedule_failed",
          bindingId: binding.id,
          error: retryError instanceof Error ? retryError.message.slice(0, 300) : "unknown",
        }));
      }
    }
    await repository.finishRun(run, {
      status: adapterError?.status === 429 ? "rate_limited" : adapterError?.status === 403 ? "blocked" : "failed",
      coverage: adapter.coverage,
      resultCount: 0,
      newCount: 0,
      changedCount: 0,
      parserVersion: adapter.parserVersion,
      httpStatus: adapterError?.status,
      errorCode,
      errorMessage: message,
      captchaDetected: adapterError?.code === "captcha" || lowerMessage.includes("captcha"),
      cpuLimitDetected: adapterError?.code === "cpu_limit" || lowerMessage.includes("cpu limit"),
      loginRequired: adapterError?.code === "login_required" || lowerMessage.includes("login required") || message.includes("需要登录"),
      healthEvidence: {
        abnormalEmpty,
        blockedDetected: adapterError?.status === 403,
        cursorTerminationReason: "unknown",
      },
    });
    if (binding.consecutive_failures + 1 >= 3) deliverNotificationsAfterRun = true;
    throw error;
  } finally {
    if (deliverNotificationsAfterRun) {
      try {
        await deliverPendingNotifications(env, repository);
      } catch (error) {
        console.error(JSON.stringify({
          event: "notification_dispatch_failed_after_run",
          bindingId: binding.id,
          runId: run.id,
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        }));
      }
    }
  }
}

async function finalizeKeywordDigest(env: Env, job: FinalizeKeywordDigestJob): Promise<void> {
  const repository = new RadarRepository(env.DB);
  const members = await repository.keywordScanMembers(job.bindingIds, job.scanStartedAt);
  // 一次被运行时打断的采集会把 `running` 永久留在 watch_runs 里——没有哪条路径会
  // 回来改它，队列那条消息重试耗尽后就进死信了。摘要等的是「这一轮跑完没有」，
  // 于是永远等下去：2026-09-21 两条 12:35 的 running 把当天的摘要挂在 576 次重试
  // （48 小时）上，最后一封都没发出去。超过这个窗口还在 running 的当它没跑成，
  // 照常出摘要并在信里写明这个来源缺了——迟到的结论也好过没有结论。
  const staleRunCutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  const incomplete = members.filter((member) => member.status === null
    || (member.status === "running" && (member.runStartedAt ?? "") > staleRunCutoff));
  const pendingAiJobs = await pendingKeywordGeminiJobs(env, job.bindingIds, job.scanStartedAt);
  if ((incomplete.length > 0 || pendingAiJobs > 0) && job.finalizeAttempt < KEYWORD_DIGEST_MAX_FINALIZE_ATTEMPTS) {
    await env.MONITOR_QUEUE.send({
      ...job,
      finalizeAttempt: job.finalizeAttempt + 1,
      idempotencyKey: `${job.digestKey}:${job.finalizeAttempt + 1}`,
      queuedAt: new Date().toISOString(),
    } satisfies FinalizeKeywordDigestJob, { delaySeconds: KEYWORD_DIGEST_RETRY_SECONDS });
    return;
  }

  const sourceIssues = members
    .filter((member) => member.status !== "success"
      && !["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(member.errorCode ?? ""))
    .map((member) => ({
      sourceId: member.sourceId,
      status: member.status ?? ("not_started" as const),
      errorCode: member.errorCode ?? undefined,
    }));
  // 抓回来不等于看过。上面那一段只看抓取状态；判定任务被判死或反复解析不出来时，
  // 抓取全是 success，而这一轮有一部分商品从没被模型看过一眼。缺了多少要写进邮件，
  // 否则这封日报会以「一切正常」的样子发出去（2026-09-21 的原形）。
  const abandonedJudgements = await abandonedKeywordGeminiJobs(env, job.bindingIds, job.scanStartedAt);
  const sourceByBindingId = new Map(members.map((member) => [member.bindingId, member.sourceId]));
  const alreadyReported = new Set(sourceIssues.map((issue) => issue.sourceId));
  const judgementIssues = abandonedJudgements.flatMap((entry) => {
    const sourceId = sourceByBindingId.get(entry.bindingId);
    if (!sourceId || alreadyReported.has(sourceId)) return [];
    alreadyReported.add(sourceId);
    return [{
      sourceId,
      status: "success" as const,
      errorCode: `ai_judgement_incomplete:${entry.totalItems - entry.completedItems}/${entry.totalItems}`,
    }];
  });
  const allSourceIssues = [...sourceIssues, ...judgementIssues];
  const failedSources = [...new Set(allSourceIssues.map((issue) => issue.sourceId))];
  // 精确同款按参考图打分：文字判定全部落定后、日报生成前。开关关着 / 没有参考图时什么都不做；
  // 看图失败只是这一轮没看图，日报照常按文字发（exact-reference-image.ts）。
  try {
    await applyExactReferenceImages(env, {
      profileId: job.profileId,
      bindingIds: job.bindingIds,
      scanStartedAt: job.scanStartedAt,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "exact_reference_image_step_failed",
      profileId: job.profileId,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
  const digestEventId = await repository.prepareKeywordDigest({
    profileId: job.profileId,
    bindingIds: job.bindingIds,
    initialBaselineBindingIds: job.initialBaselineBindingIds,
    scanStartedAt: job.scanStartedAt,
    scanFinishedAt: new Date().toISOString(),
    digestKey: job.digestKey,
    failedSources,
    sourceIssues: allSourceIssues,
    enrichItems: (items, options) => enrichDigestItems(env, items, options),
  });
  await deliverPendingNotifications(env, repository);
  // 手机首页的「上一轮 / 下一轮」：没新货也报。自己吞掉错误，不影响这一轮收尾。
  await publishKeywordRound(env, repository, {
    profileId: job.profileId,
    scanStartedAt: job.scanStartedAt,
    digestEventId,
    failedSources,
  });
}

async function confirmPriceDrop(env: Env, job: ConfirmPriceDropJob): Promise<void> {
  const repository = new RadarRepository(env.DB);
  const binding = await repository.getBinding(job.bindingId);
  const storedListing = await repository.getConfirmationListing(job.listingId);
  if (!binding || !binding.enabled || !storedListing || storedListing.source_id !== binding.source_id) return;
  const trackedListing = binding.profile_dossier_kind === "exact_product"
    ? await repository.getTrackedListing(binding.id, job.listingId)
    : null;
  if (binding.profile_dossier_kind === "exact_product" && (
    !trackedListing
    || !["active", "unavailable_pending", "waiting_restock"].includes(trackedListing.tracking_status)
  )) return;
  if (binding.cooldown_until && Date.parse(binding.cooldown_until) > Date.now()) return;
  const adapter = getAdapter(binding.source_id);
  if (!adapter) return;
  // 查不到详情的商品（如 Mercari Shops）不该进二次确认：请求必然失败，而
  // keyword 档案在这里走的是 failBinding，一条失效商品会被记到来源级健康度上。
  if (adapter.canGetItem?.(storedListing.source_item_id) === false) return;
  const run = await repository.createRun(binding.id, "confirmation");
  await repository.closeSupersededBusinessRepairRuns(binding.id);
  if (isRakutenSource(binding.source_id) && !rakutenPrivateMonitoringEnabled(binding.source_id, env)) {
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter.parserVersion,
      errorCode: "rakuten_private_monitoring_disabled",
      errorMessage: `${binding.source_id === "rakuten_ichiba" ? "Rakuten Ichiba" : "Rakuten Books"} 定时监控未启用`,
    });
    return;
  }
  try {
    const sourceConfig = recordJson(binding.source_config_json);
    const confirmationBrowserFetch = browserFallbackFetch(binding.source_id, env);
    const listing = adapter.getItem
      ? await itemWithConfiguredRoute(
          env,
          adapter,
          storedListing.source_item_id,
          { fetch, secrets: secrets(env) },
          { browserFetch: confirmationBrowserFetch },
        )
      : (await searchWithConfiguredRoute(env, adapter, {
          query: binding.query ?? "",
          filters: searchFiltersFromConfig(sourceConfig, { sort: "newest", page: 1, pageSize: 50 }),
          sourceConfig,
        }, { fetch, secrets: secrets(env) }, { browserFetch: confirmationBrowserFetch })).listings.find((item) => item.sourceItemId === storedListing.source_item_id);

    const purchasable = listing && ["available", "preorder", "backorder"].includes(listing.availability);
    if (!listing || !purchasable || listing.currentPrice === undefined || listing.currentPrice >= job.expectedOldPrice) {
      await repository.recordItemScheduleObservation(binding, listing ? {
        price: validComparablePrice(listing.currentPrice) ?? null, availability: listing.availability,
      } : null, { scheduled: false });
      const fields = listingFieldCompleteness(listing ? [listing] : [], adapter.fieldProfile?.required);
      await repository.finishRun(run, { status: "success", coverage: adapter.coverage, resultCount: listing ? 1 : 0,
        newCount: 0, changedCount: 0, parserVersion: adapter.parserVersion, fieldTotal: fields.total, fieldComplete: fields.complete });
      return;
    }

    const persisted = await repository.persistListing(binding, listing);
    const events = evaluateListingEvents({
      bindingId: binding.id, listingId: persisted.listingId,
      previous: { price: job.expectedOldPrice, availability: storedListing.availability as NormalizedListing["availability"] },
      current: { price: listing.currentPrice, availability: listing.availability, stateHash: persisted.stateHash },
      baselineCompleted: true, notifyInitial: false, notifyPriceDrop: binding.notify_price_drop === 1,
      // 降价复核任务，结果只保留 price_drop / target_price。
      notifyPriceRise: false,
      notifyRestock: false, notifySoldOut: false, targetPrice: binding.target_price ?? undefined,
      minDropAmount: binding.min_drop_amount, priceDropConfirmed: true,
      observedAt: new Date().toISOString(),
    }).filter((event) => event.type === "price_drop" || event.type === "target_price");
    await repository.insertEvents(binding, persisted.listingId, events);
    await repository.recordItemScheduleObservation(binding, {
      price: validComparablePrice(listing.currentPrice) ?? null, availability: listing.availability,
    }, { scheduled: false, significantSignal: events.length > 0 });
    if (trackedListing) {
      await repository.completeTrackedListing(trackedListing, {
        price: validComparablePrice(listing.currentPrice) ?? null,
        availability: listing.availability,
        stateHash: persisted.stateHash,
      });
    }
    const fields = listingFieldCompleteness([listing], adapter.fieldProfile?.required);
    await repository.finishRun(run, { status: "success", coverage: adapter.coverage, resultCount: 1,
      newCount: 0, changedCount: persisted.changed ? 1 : 0, parserVersion: adapter.parserVersion,
      fieldTotal: fields.total, fieldComplete: fields.complete });
    await deliverPendingNotifications(env, repository);
  } catch (error) {
    const adapterError = error instanceof AdapterError ? error : undefined;
    const message = error instanceof Error ? error.message : "降价二次确认失败";
    const lowerMessage = message.toLowerCase();
    if (adapterError?.code === "source_runner_repair_pending") {
      await repository.markRunAwaitingBusinessRepair(
        binding,
        run,
        message,
        adapterError.retryAfterSeconds,
      );
      console.warn(JSON.stringify({
        event: "source_runner_confirmation_repair_pending",
        sourceId: binding.source_id,
        bindingId: binding.id,
        runId: run.id,
        retryAfterSeconds: adapterError.retryAfterSeconds ?? 120,
      }));
      return;
    }
    if (trackedListing) {
      await repository.failTrackedListing(
        trackedListing,
        adapterError?.code ?? "confirmation_failed",
        message,
        adapterError?.retryAfterSeconds,
      );
    } else {
      await repository.failBinding(binding, adapterError?.code ?? "confirmation_failed", message, adapterError?.status, adapterError?.retryAfterSeconds);
    }
    await repository.finishRun(run, { status: adapterError?.status === 429 ? "rate_limited" : adapterError?.status === 403 ? "blocked" : "failed",
      coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0, parserVersion: adapter.parserVersion,
      httpStatus: adapterError?.status, errorCode: adapterError?.code ?? "confirmation_failed", errorMessage: message,
      captchaDetected: adapterError?.code === "captcha" || lowerMessage.includes("captcha"),
      cpuLimitDetected: adapterError?.code === "cpu_limit" || lowerMessage.includes("cpu limit"),
      loginRequired: adapterError?.code === "login_required" || lowerMessage.includes("login required") || message.includes("需要登录") });
    // 二次确认失败不能被当成“已处理”：队列需要继续重试，否则详情任务
    // 已写入的新价格会令下一轮失去这次降价事件。
    throw error;
  }
}

function isTrackedListingMissing(error: unknown): boolean {
  const missingStatuses = new Set([404, 410]);
  if (error instanceof AdapterError && error.status !== undefined && missingStatuses.has(error.status)) return true;
  const failures = sourceRouteFailures(error);
  return failures.length > 0
    && failures.every(({ failure }) => failure.status !== null && missingStatuses.has(failure.status));
}

async function runTrackedListing(env: Env, job: RunTrackedListingJob): Promise<void> {
  const repository = new RadarRepository(env.DB);
  const [binding, tracked] = await Promise.all([
    repository.getBinding(job.bindingId),
    repository.getTrackedListing(job.bindingId, job.listingId),
  ]);
  if (
    !binding
    || !binding.enabled
    || binding.profile_dossier_kind !== "exact_product"
    || !tracked
    || !["active", "unavailable_pending", "waiting_restock"].includes(tracked.tracking_status)
  ) return;

  const adapter = getAdapter(binding.source_id);
  // Detail refreshes are confirmation work, not the profile's scheduled market
  // scan. Keeping that distinction makes weekly scan-health counts accurate.
  const run = await repository.createRun(binding.id, "confirmation");
  // 能力判定要精确到这一条商品：来源整体支持详情查询，不代表每个 ID 都查得了。
  // 查不了的直接暂停，否则它会以来源的调度周期无限重试同一个必然失败的请求。
  if (!adapter?.getItem || adapter.canGetItem?.(tracked.source_item_id) === false) {
    const message = adapter?.getItem
      ? `来源 ${binding.source_id} 不支持商品 ${tracked.source_item_id} 的独立详情跟踪`
      : `来源 ${binding.source_id} 暂不支持独立商品详情跟踪`;
    await repository.pauseTrackedListing(tracked, "item_lookup_unsupported", message);
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter?.coverage ?? "unknown", resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter?.parserVersion, errorCode: "item_lookup_unsupported", errorMessage: message,
    });
    return;
  }
  if (binding.cooldown_until && Date.parse(binding.cooldown_until) > Date.now()) {
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter.parserVersion, errorCode: "cooldown_active",
      errorMessage: `来源冷却至 ${binding.cooldown_until}`,
    });
    return;
  }
  if (isRakutenSource(binding.source_id) && !rakutenPrivateMonitoringEnabled(binding.source_id, env)) {
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter.parserVersion, errorCode: "rakuten_private_monitoring_disabled",
      errorMessage: `${binding.source_id === "rakuten_ichiba" ? "Rakuten Ichiba" : "Rakuten Books"} 定时监控未启用`,
    });
    return;
  }
  if (binding.source_id === "amazon_jp" && !amazonMonitoringEnabled(env)) {
    await repository.finishRun(run, {
      status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter.parserVersion, errorCode: "amazon_monitoring_disabled",
      errorMessage: "Amazon Japan 定时监控未启用",
    });
    return;
  }

  const captureRecorder = createSourceCaptureRecorder(
    binding.source_id,
    isRakutenSource(binding.source_id) ? createPacedFetch(fetch) : fetch,
  );
  const rawBrowserFetch = browserFallbackFetch(binding.source_id, env);
  const capturedBrowserFetch = rawBrowserFetch ? captureRecorder.wrap(rawBrowserFetch) : undefined;
  let capturesStaged = false;
  const stageCaptures = async () => {
    if (capturesStaged) return;
    capturesStaged = true;
    await stageSourceCaptures(env.DB, run.id, await captureRecorder.flush());
  };

  try {
    const sourceConfig = recordJson(binding.source_config_json);
    const listing = listingForDeterministicState(await itemWithConfiguredRoute(
      env,
      adapter,
      tracked.canonical_url || tracked.source_item_id,
      { fetch: captureRecorder.fetch, secrets: secrets(env) },
      {
        browserFetch: capturedBrowserFetch,
        preferSourceRunner: sourceConfig.inventoryLookup === "source_runner_page",
      },
    ));
    await stageCaptures();
    // 搜索发现与详情跟踪会共同更新 listings；比较基线必须来自 match 自己，
    // 并在网络请求后复核一次状态，避免用户刚刚“已购/忽略”仍被发通知。
    const currentTracked = await repository.getTrackedListing(binding.id, tracked.listing_id);
    if (!currentTracked || !["active", "unavailable_pending", "waiting_restock"].includes(currentTracked.tracking_status)) {
      await repository.finishRun(run, {
        status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
        parserVersion: adapter.parserVersion, errorCode: "tracking_state_changed",
        errorMessage: "商品详情返回前跟踪状态已被用户或另一任务终止",
      });
      return;
    }
    const persisted = await repository.persistListing(binding, listing);
    const oldPrice = validComparablePrice(currentTracked.tracking_baseline_completed === 1
      ? currentTracked.tracking_last_price ?? undefined
      : currentTracked.current_price ?? undefined);
    const newPrice = validComparablePrice(listing.currentPrice);
    const droppedEnough = oldPrice !== undefined && newPrice !== undefined
      && oldPrice - newPrice >= binding.min_drop_amount;
    const crossedTarget = binding.target_price !== null && oldPrice !== undefined && newPrice !== undefined
      && oldPrice > binding.target_price && newPrice <= binding.target_price;
    const purchasable = ["available", "preorder", "backorder"].includes(listing.availability);
    if (purchasable && ((binding.notify_price_drop === 1 && droppedEnough) || crossedTarget)) {
      await monitorQueueFor(env, binding.source_id).send({
        type: "confirm_price_drop",
        idempotencyKey: `confirm_price_drop:${binding.id}:${persisted.listingId}:${newPrice}`,
        bindingId: binding.id,
        listingId: persisted.listingId,
        expectedOldPrice: oldPrice ?? 0,
        candidateNewPrice: newPrice ?? 0,
        queuedAt: new Date().toISOString(),
      } satisfies ConfirmPriceDropJob, { delaySeconds: 30 });
    }
    const availabilityEvents = evaluateListingEvents({
      bindingId: binding.id,
      listingId: persisted.listingId,
      previous: {
        price: oldPrice,
        availability: (currentTracked.tracking_last_availability
          ?? currentTracked.availability) as NormalizedListing["availability"],
        stateHash: currentTracked.tracking_last_state_hash
          ?? currentTracked.state_hash
          ?? undefined,
      },
      current: {
        price: newPrice,
        availability: listing.availability,
        stateHash: persisted.stateHash,
      },
      isNewMatch: false,
      baselineCompleted: true,
      notifyInitial: false,
      notifyNewListing: false,
      notifyPriceDrop: false,
      notifyPriceRise: binding.notify_price_rise === 1,
      notifyRestock: binding.notify_restock === 1,
      notifySoldOut: binding.notify_sold_out === 1,
      targetPrice: binding.target_price ?? undefined,
      minDropAmount: binding.min_drop_amount,
      availabilityChangeConfirmed: true,
      observedAt: new Date().toISOString(),
    }).filter((event) => event.type === "restock" || event.type === "sold_out");
    const insertedEvents = await repository.insertEvents(binding, persisted.listingId, availabilityEvents);
    await repository.completeTrackedListing(currentTracked, {
      price: newPrice ?? null,
      availability: listing.availability,
      stateHash: persisted.stateHash,
    });
    await repository.incrementCounter("detail_calls");
    const fields = listingFieldCompleteness([listing], adapter.fieldProfile?.required);
    await repository.finishRun(run, {
      status: "success", coverage: adapter.coverage, resultCount: 1, newCount: 0,
      changedCount: persisted.changed ? 1 : 0, parserVersion: adapter.parserVersion,
      fieldTotal: fields.total, fieldComplete: fields.complete,
    });
    if (insertedEvents > 0) await deliverPendingNotifications(env, repository);
  } catch (error) {
    await stageCaptures();
    if (isTrackedListingMissing(error)) {
      const currentTracked = await repository.getTrackedListing(binding.id, tracked.listing_id);
      if (!currentTracked || !["active", "unavailable_pending", "waiting_restock"].includes(currentTracked.tracking_status)) {
        await repository.finishRun(run, {
          status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
          parserVersion: adapter.parserVersion, errorCode: "tracking_state_changed",
          errorMessage: "商品缺失响应返回前跟踪状态已被用户或另一任务终止",
        });
        return;
      }
      const missing = await repository.recordTrackedListingMissing(currentTracked);
      if (!missing.accepted) {
        await repository.finishRun(run, {
          status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
          parserVersion: adapter.parserVersion, errorCode: "tracking_state_changed",
          errorMessage: "商品缺失结果未写入：跟踪状态已改变",
        });
        return;
      }
      let insertedEvents = 0;
      if (missing.confirmed) {
        const stateHash = await repository.markTrackedListingUnavailable(currentTracked);
        const confirmedTracked = await repository.getTrackedListing(binding.id, tracked.listing_id);
        const stillConfirmed = confirmedTracked
          && ["terminal", "waiting_restock"].includes(confirmedTracked.tracking_status)
          && confirmedTracked.tracking_last_availability === "unavailable";
        if (!stillConfirmed) {
          await repository.finishRun(run, {
            status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
            parserVersion: adapter.parserVersion, errorCode: "tracking_state_changed",
            errorMessage: "下架确认完成前跟踪状态已被用户改变",
          });
          return;
        }
        const events = evaluateListingEvents({
          bindingId: binding.id,
          listingId: currentTracked.listing_id,
          previous: {
            price: validComparablePrice(currentTracked.tracking_baseline_completed === 1
              ? currentTracked.tracking_last_price ?? undefined
              : currentTracked.current_price ?? undefined),
            availability: (currentTracked.tracking_last_availability
              ?? currentTracked.availability) as NormalizedListing["availability"],
            stateHash: currentTracked.tracking_last_state_hash
              ?? currentTracked.state_hash
              ?? undefined,
          },
          current: {
            price: validComparablePrice(currentTracked.tracking_baseline_completed === 1
              ? currentTracked.tracking_last_price ?? undefined
              : currentTracked.current_price ?? undefined),
            availability: "unavailable",
            stateHash,
          },
          isNewMatch: false,
          baselineCompleted: true,
          notifyInitial: false,
          notifyNewListing: false,
          notifyPriceDrop: false,
          // 商品已确认消失：没有可比的新价格，涨价无从谈起。
          notifyPriceRise: false,
          notifyRestock: false,
          notifySoldOut: binding.notify_sold_out === 1,
          minDropAmount: binding.min_drop_amount,
          availabilityChangeConfirmed: true,
          observedAt: new Date().toISOString(),
        }).filter((event) => event.type === "sold_out");
        insertedEvents = await repository.insertEvents(binding, currentTracked.listing_id, events);
      }
      await repository.incrementCounter("detail_calls");
      await repository.finishRun(run, {
        status: "success", coverage: adapter.coverage, resultCount: 0, newCount: 0,
        changedCount: missing.confirmed ? 1 : 0, parserVersion: adapter.parserVersion,
        errorCode: missing.confirmed ? "item_missing_confirmed" : "item_missing_pending_confirmation",
        errorMessage: missing.confirmed
          ? "商品详情连续两次不可访问，已确认下架状态"
          : "商品详情首次不可访问，将在 15 分钟后复核",
      });
      if (insertedEvents > 0) await deliverPendingNotifications(env, repository);
      return;
    }
    const adapterError = error instanceof AdapterError ? error : undefined;
    const message = error instanceof Error ? error.message : "商品详情跟踪失败";
    await repository.failTrackedListing(
      tracked,
      adapterError?.code ?? "tracked_listing_failed",
      message,
      adapterError?.retryAfterSeconds,
    );
    await repository.finishRun(run, {
      status: adapterError?.status === 429 ? "rate_limited" : adapterError?.status === 403 ? "blocked" : "failed",
      coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
      parserVersion: adapter.parserVersion, httpStatus: adapterError?.status,
      errorCode: adapterError?.code ?? "tracked_listing_failed", errorMessage: message,
    });
    console.warn(JSON.stringify({
      event: "tracked_listing_failed",
      bindingId: binding.id,
      listingId: tracked.listing_id,
      sourceId: binding.source_id,
      errorCode: adapterError?.code ?? "tracked_listing_failed",
      errorMessage: message.slice(0, 300),
    }));
  }
}

/** 点赞：煤炉 likeCount、PayPayフリマ likeCount、雅虎拍卖 watchCount（ウォッチ）；评论只有煤炉给。 */
function listingInterest(listing: NormalizedListing): ListingInterest {
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const likeCount = count(listing.rawMetadata?.likeCount) ?? count(listing.rawMetadata?.watchCount);
  const commentCount = count(listing.rawMetadata?.commentCount);
  return {
    ...(likeCount === undefined ? {} : { likeCount }),
    ...(commentCount === undefined ? {} : { commentCount }),
  };
}

async function runItemBinding(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  binding: WatchBindingRow,
  env: Env,
  fetcher: typeof globalThis.fetch = fetch,
  browserFetch?: typeof globalThis.fetch,
  skippedPrimaryFailure?: SourceRouteFailureEvidence,
) {
  if (!adapter.getItem || !binding.target_url) throw new Error(`来源 ${binding.source_id} 暂不支持单品查询`);
  const config = recordJson(binding.source_config_json);
  const lookup = config.itemLookup === "target_url"
    ? binding.target_url
    : typeof config.itemId === "string" && config.itemId ? config.itemId : binding.target_url;
  const listing = await itemWithConfiguredRoute(
    env,
    adapter,
    lookup,
    { fetch: fetcher, secrets: secrets(env) },
    {
      browserFetch,
      preferSourceRunner: config.inventoryLookup === "source_runner_page",
      skippedPrimaryFailure,
    },
  );
  return { sourceId: binding.source_id, listings: [listing], coverage: adapter.coverage, warnings: [], parserVersion: adapter.parserVersion, fetchedAt: new Date().toISOString() };
}

// 0–180 秒抖动（开发文档规定值）。同一分钟到期的绑定若挤在 20 秒内并发打上游，
// 会直接触发 403/429 并进入 2h/6h/12h 冷却阶梯。
function randomDelaySeconds(): number {
  const bytes = new Uint16Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] ?? 0) % 181;
}

async function runExperimentalProbes(env: Env, repository: RadarRepository): Promise<void> {
  const now = new Date().toISOString();
  const windows = await env.DB.prepare(
    `SELECT p.source_id,s.cooldown_until,s.cooldown_route FROM source_probe_windows p JOIN source_registry s ON s.id=p.source_id
     WHERE p.status='running' AND p.source_id<>'surugaya'`,
  ).all<{ source_id: SourceId; cooldown_until: string | null; cooldown_route: "direct" | "mercari_service" | null }>();
  await Promise.allSettled(windows.results.map(async ({ source_id: sourceId, cooldown_until: cooldownUntil, cooldown_route: cooldownRoute }) => {
    const adapter = getAdapter(sourceId);
    if (!adapter) return;
    const route = sourceRequestRoute(sourceId, env);
    if (cooldownUntil && Date.parse(cooldownUntil) > Date.parse(now) && (cooldownRoute ?? "direct") === route) {
      await repository.recordSourceProbeObservation(sourceId, {
        status: "skipped", coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0,
        parserVersion: adapter.parserVersion, errorCode: "source_cooldown",
        errorMessage: `来源冷却至 ${cooldownUntil}，本轮未请求上游`,
      });
      return;
    }
    try {
      const result = await searchWithConfiguredRoute(env, adapter, {
        query: adapter.healthcheckQuery ?? "千反田える",
        filters: sourceId === "yahoo_auctions_jp"
          ? { page: 1, pageSize: 30, inStockOnly: true, availabilityMode: "purchasable", sort: "relevance" }
          : { page: 1, pageSize: 30, inStockOnly: false, sort: "newest" },
        sourceConfig: adapter.healthcheckSourceConfig,
        // 探针并行发起 N 个上游搜索，必须带整体截止时间，否则单个挂死的来源
        // 会拖垮整个每小时维护 tick。testSource 已用同样的 25 秒预算。
      }, { fetch, secrets: secrets(env), signal: AbortSignal.timeout(25_000) }, { browserFetch: browserFallbackFetch(sourceId, env) });
      if (result.routeOutcome.kind === "fallback_success") {
        // 主路径被拦但兜底拿到了结果：来源本身可用，按成功计入探针，主路径失败原因留作证据。
        // 以前记成失败，Yahoo! Shopping 兜底一直成功却被判不合格并停掉全部监控。
        const failure = result.routeOutcome.primaryFailure;
        const fields = listingFieldCompleteness(result.listings, adapter.fieldProfile?.required);
        await repository.recordSourceProbeObservation(sourceId, {
          status: "success",
          coverage: result.coverage,
          resultCount: result.listings.length,
          newCount: 0,
          changedCount: 0,
          parserVersion: adapter.parserVersion,
          fieldTotal: fields.total,
          fieldComplete: fields.complete,
          httpStatus: failure.status ?? undefined,
          errorCode: failure.code,
          errorMessage: failure.message,
        });
        await recordPreviewSuccess(env, sourceId, result);
        return;
      }
      const fields = listingFieldCompleteness(result.listings, adapter.fieldProfile?.required);
      await repository.recordSourceProbeObservation(sourceId, {
        status: "success", coverage: result.coverage, resultCount: result.listings.length, newCount: 0, changedCount: 0,
        parserVersion: adapter.parserVersion, fieldTotal: fields.total, fieldComplete: fields.complete,
      });
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE source_registry SET health_status='healthy',last_success_at=?,parser_version=?,consecutive_failures=0,
         request_route=?,cooldown_until=NULL,cooldown_route=NULL,
         last_signature_success_at=CASE WHEN ?='mercari_service' THEN ? ELSE last_signature_success_at END,
         last_container_count=CASE WHEN id='surugaya' THEN ? ELSE last_container_count END,
         last_page_bytes=CASE WHEN id='surugaya' THEN ? ELSE last_page_bytes END,captcha_detected=0,
         last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`,
      ).bind(now, adapter.parserVersion, result.requestRoute, result.requestRoute,
        result.requestRoute === "mercari_service" ? now : null,
        sourceId === "surugaya" ? result.listings.length : null,
        sourceId === "surugaya" ? Number(result.listings[0]?.rawMetadata?.pageBytes ?? 0) || null : null, now, sourceId).run();
    } catch (error) {
      const adapterError = error instanceof AdapterError ? error : undefined;
      const routeFailure = sourceRouteFailures(error).find((failure) => failure.route === route)?.failure;
      const failureStatus = routeFailure?.status ?? adapterError?.status;
      const failureCode = routeFailure?.code ?? adapterError?.code;
      const message = error instanceof Error ? error.message : "来源探针失败";
      const lower = message.toLowerCase();
      const now = new Date().toISOString();
      const retryAfterSeconds = adapterError?.retryAfterSeconds
        ?? (failureStatus === 403 ? 12 * 60 * 60 : failureStatus === 429 ? 2 * 60 * 60 : undefined);
      const cooldownUntil = retryAfterSeconds
        ? new Date(Date.now() + retryAfterSeconds * 1_000).toISOString()
        : null;
      await env.DB.prepare(
        `UPDATE source_registry SET health_status='degraded',last_failure_at=?,last_http_status=?,
         last_error_code=?,last_error_message=?,consecutive_failures=consecutive_failures+1,
         last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,last_429_at=CASE WHEN ?=429 THEN ? ELSE last_429_at END,
         captcha_detected=CASE WHEN ? THEN 1 ELSE captcha_detected END,
         request_route=?,cooldown_until=CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN ? ELSE cooldown_until END,
         cooldown_route=CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN ? ELSE cooldown_route END,updated_at=? WHERE id=?`,
      ).bind(now, failureStatus ?? null, failureCode ?? "probe_failed", message.slice(0, 500),
        failureStatus ?? null, now, failureStatus ?? null, now,
        failureCode === "captcha" || lower.includes("captcha") ? 1 : 0,
        route, cooldownUntil, cooldownUntil, cooldownUntil, route, now, sourceId).run();
      await repository.recordSourceProbeObservation(sourceId, {
        status: failureStatus === 429 ? "rate_limited" : failureStatus === 403 ? "blocked" : "failed",
        coverage: adapter.coverage, resultCount: 0, newCount: 0, changedCount: 0, parserVersion: adapter.parserVersion,
        httpStatus: failureStatus ?? undefined, errorCode: failureCode ?? "probe_failed", errorMessage: message,
        captchaDetected: failureCode === "captcha" || lower.includes("captcha"),
        loginRequired: failureCode === "login_required" || message.includes("需要登录"),
      });
    }
  }));
}

async function reconcileExperimentalProbeRoutes(env: Env, repository: RadarRepository): Promise<void> {
  const sourceIds = [
    "yahoo_shopping",
    "yahoo_auctions_jp",
    "yahoo_fleamarket_jp",
    "charaon",
    "cospa",
    "animate",
  ] as const satisfies readonly SourceId[];
  for (const sourceId of sourceIds) {
    const expectedRoute = sourceRequestRoute(sourceId, env);
    if (expectedRoute !== "direct" && expectedRoute !== "mercari_service") continue;
    const current = await env.DB.prepare(
      `SELECT s.request_route,p.request_route probe_request_route,p.started_at
       FROM source_registry s LEFT JOIN source_probe_windows p ON p.source_id=s.id WHERE s.id=?`,
    ).bind(sourceId).first<{
      request_route: "direct" | "mercari_service";
      probe_request_route: "direct" | "mercari_service" | null;
      started_at: string | null;
    }>();
    if (!current) continue;
    if (current.request_route !== expectedRoute) {
      await env.DB.prepare("UPDATE source_registry SET request_route=?,updated_at=? WHERE id=?")
        .bind(expectedRoute, new Date().toISOString(), sourceId).run();
    }
    if (!current.probe_request_route || current.probe_request_route === expectedRoute) continue;
    if (current.started_at) {
      await repository.restartSourceProbeForRouteChange(sourceId);
    } else {
      await env.DB.prepare("UPDATE source_probe_windows SET request_route=?,updated_at=? WHERE source_id=?")
        .bind(expectedRoute, new Date().toISOString(), sourceId).run();
    }
  }
}

async function deliverCompletionNotification(env: Env, repository: RadarRepository): Promise<void> {
  if (!env.RESEND_API_KEY || env.ALERT_EMAIL_TO.endsWith("@example.com") || env.ALERT_EMAIL_FROM.includes("example.com")) return;
  const reservation = await repository.reserveCompletionNotification();
  if (!reservation) return;
  const completedAt = new Date().toISOString();
  const template = finalAcceptanceEmail({
    completedAt,
    checks: reservation.checks.map((check) => {
      let evidence: unknown = {};
      try { evidence = JSON.parse(check.evidence_json); } catch { /* Stored evidence is displayed only as an audit aid. */ }
      return { label: check.label, evidence };
    }),
  });
  try {
    const resendId = await sendResendEmail({
      apiKey: env.RESEND_API_KEY,
      from: env.ALERT_EMAIL_FROM,
      to: env.ALERT_EMAIL_TO,
      subject: template.subject,
      html: template.html,
      text: template.text,
      idempotencyKey: reservation.key,
    });
    await repository.finishCompletionNotification(reservation.key, resendId);
  } catch (error) {
    await repository.failCompletionNotification(reservation.key, error instanceof Error ? error.message : "最终通知发送失败");
    throw error;
  }
}

async function pruneOperationalHistory(env: Env): Promise<void> {
  // 运营历史保留窗口（每小时执行一次）。watch_runs 删除会级联 source_health_snapshots；
  // events 删除会级联 notice_deliveries（以及不再写入的旧表 email_deliveries / hermes_deliveries），monitor_events.legacy_event_id 置 NULL。
  // 原始响应只在分析落库成功后缩短到 3 天；失败或缺少 outbox 的证据仍保留 14 天。
  // 已成功 outbox 的大 JSON 在分析 schema 有持久副本，运营表仅保留状态行用于幂等。
  // 截止时间在 JS 侧生成统一 ISO 格式，避免跨查询的时钟与格式差异。
  const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM source_response_captures
       WHERE captured_at < ?
         AND run_id IN (
           SELECT reference_id FROM analytics_outbox WHERE status='succeeded'
         )`,
    ).bind(cutoff(3)),
    env.DB.prepare("DELETE FROM source_response_captures WHERE captured_at < ?").bind(cutoff(14)),
    env.DB.prepare(
      `UPDATE analytics_outbox SET payload_json=NULL
       WHERE status='succeeded' AND payload_json IS NOT NULL AND processed_at < ?`,
    ).bind(cutoff(3)),
    env.DB.prepare("DELETE FROM listing_snapshots WHERE observed_at < ?").bind(cutoff(180)),
    env.DB.prepare("DELETE FROM source_probe_observations WHERE observed_at < ?").bind(cutoff(90)),
    env.DB.prepare("DELETE FROM cron_heartbeats WHERE observed_at < ?").bind(cutoff(30)),
    env.DB.prepare("DELETE FROM managed_api_cache WHERE expires_at < ?").bind(cutoff(1)),
    env.DB.prepare(
      "DELETE FROM queue_message_receipts WHERE status='completed' AND completed_at < ?",
    ).bind(cutoff(30)),
    env.DB.prepare(
      "DELETE FROM queue_message_receipts WHERE status IN ('failed','dead_lettered') AND last_received_at < ?",
    ).bind(cutoff(180)),
    env.DB.prepare("DELETE FROM queue_dead_letters WHERE last_dead_lettered_at < ?").bind(cutoff(365)),
    env.DB.prepare(
      "DELETE FROM analytics_outbox WHERE status IN ('succeeded','skipped') AND processed_at < ?",
    ).bind(cutoff(30)),
    env.DB.prepare(
      "DELETE FROM notice_deliveries WHERE status IN ('sent','skipped','abandoned') AND updated_at < ?",
    ).bind(cutoff(180)),
    env.DB.prepare(
      `DELETE FROM events WHERE created_at < ?
       AND (status IN ('sent','suppressed') OR email_suppressed_at IS NOT NULL)`,
    ).bind(cutoff(180)),
    env.DB.prepare("DELETE FROM watch_runs WHERE started_at < ?").bind(cutoff(90)),
    // 搜索词记录要攒得比 watch_runs 久，才看得出主词 / 补搜各自的长期命中率。
    env.DB.prepare("DELETE FROM watch_run_query_attempts WHERE created_at < ?").bind(cutoff(365)),
    env.DB.prepare(
      `DELETE FROM search_history
       WHERE COALESCE(session_id,id) NOT IN (
         SELECT id FROM search_history
         WHERE parent_history_id IS NULL
         ORDER BY searched_at DESC,id DESC LIMIT 50
       )`,
    ),
  ]);
}

async function handleScheduled(env: Env, scheduledAt: string): Promise<void> {
  const repository = new RadarRepository(env.DB);
  // Keep the legacy environment key for deployed Collector compatibility.
  // Watch creation/resume is unlimited; excess due work waits for the next tick.
  const limit = Math.max(1, Math.min(Number(env.MAX_ACTIVE_BINDINGS), MONITOR_DISPATCH_BATCH_SIZE));
  // dueWorkloadTotals 挂在这个 Promise.all 里而不是单独一次往返：它每跳都要跑，
  // 而这里本来就在等最慢的那条查询，并行加一条等于零额外延迟。
  const [dueBindings, dueTrackedListings, overnightFlag, dueTotals] = await Promise.all([
    repository.dueBindings(limit),
    repository.dueTrackedListings(limit),
    env.DB.prepare(
      "SELECT enabled,config_json FROM runtime_feature_flags WHERE flag_key=?",
    ).bind(OVERNIGHT_COLLECTION_OVERRIDE_FLAG).first<{ enabled: number; config_json: string }>(),
    repository.dueWorkloadTotals(),
  ]);
  const dispatchStartedAt = Date.now();
  const collectionPolicy = overnightCollectionPolicy(scheduledAt, overnightFlag);
  const bindings = collectionPolicy.automaticCollectionAllowed
    ? dueBindings.filter((binding) => !isRakutenSource(binding.source_id)
      || rakutenPrivateMonitoringEnabled(binding.source_id, env))
    : [];
  const trackedListings = collectionPolicy.automaticCollectionAllowed
    ? dueTrackedListings.filter((tracked) => !isRakutenSource(tracked.source_id)
      || rakutenPrivateMonitoringEnabled(tracked.source_id, env))
    : [];
  const scanStartedAt = new Date().toISOString();
  const keywordDigestBindings = new Map<string, {
    bindings: WatchBindingRow[];
    initialBaselineBindingIds: string[];
  }>();
  let enqueuedJobs = 0;
  for (const binding of bindings) {
    // 预约失败说明另一个重叠的 cron tick 已领取该绑定，跳过避免双派发。
    if (!await repository.reserveBinding(binding)) continue;
    await monitorQueueFor(env, binding.source_id).send({
      type: "run_binding",
      idempotencyKey: `run_binding:${binding.id}:cron:${scanStartedAt}`,
      bindingId: binding.id,
      trigger: "cron",
      queuedAt: scanStartedAt,
    } satisfies MonitorJob, { delaySeconds: randomDelaySeconds() });
    enqueuedJobs += 1;
    const digest = keywordDigestMembership(binding);
    if (digest.member) {
      const grouped = keywordDigestBindings.get(binding.watch_profile_id) ?? {
        bindings: [],
        initialBaselineBindingIds: [],
      };
      grouped.bindings.push(binding);
      if (digest.initialBaseline) grouped.initialBaselineBindingIds.push(binding.id);
      keywordDigestBindings.set(binding.watch_profile_id, grouped);
    }
  }
  for (const tracked of trackedListings) {
    if (!await repository.reserveTrackedListing(tracked)) continue;
    await monitorQueueFor(env, tracked.source_id).send({
      type: "run_tracked_listing",
      idempotencyKey: `run_tracked_listing:${tracked.watch_binding_id}:${tracked.listing_id}:${scanStartedAt}`,
      bindingId: tracked.watch_binding_id,
      listingId: tracked.listing_id,
      trigger: "cron",
      queuedAt: scanStartedAt,
    } satisfies MonitorJob, { delaySeconds: randomDelaySeconds() });
    enqueuedJobs += 1;
  }
  for (const [profileId, profileScan] of keywordDigestBindings) {
    const digestKey = `keyword_digest:${profileId}:${scanStartedAt}`;
    await env.MONITOR_QUEUE.send({
      type: "finalize_keyword_digest",
      idempotencyKey: `${digestKey}:1`,
      profileId,
      bindingIds: profileScan.bindings.map((binding) => binding.id),
      ...(profileScan.initialBaselineBindingIds.length > 0
        ? { initialBaselineBindingIds: profileScan.initialBaselineBindingIds }
        : {}),
      scanStartedAt,
      digestKey,
      finalizeAttempt: 1,
      queuedAt: new Date().toISOString(),
    } satisfies MonitorJob, { delaySeconds: KEYWORD_DIGEST_DELAY_SECONDS });
  }
  if (enqueuedJobs > 0) await repository.incrementCounter("queued_jobs", enqueuedJobs);
  // Weekly market health reports are independent of the daily scan cadence.
  // Cloudflare invokes this worker every minute; 00:15 UTC is Monday 09:15 JST.
  const scheduledDate = new Date(scheduledAt);
  if (isHealthCheckTick(scheduledAt)) {
    try {
      const health = await repository.runDailyHealthCheck();
      if (health.ran) console.log(JSON.stringify({ event: "daily_health_check_finished", findings: health.findings }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "daily_health_check_failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }
  if (isWeeklyMarketDigestTick(scheduledAt)) {
    try {
      await repository.prepareWeeklyExactReport(scheduledAt);
      // Deliver the newly-created report during the same tick; the regular
      // hourly maintenance delivery remains the recovery path on retries.
      await deliverPendingNotifications(env, repository);
    } catch (error) {
      console.error(JSON.stringify({
        event: "weekly_market_digest_prepare_failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }
  // 恢复扫描每 10 分钟一次即可。放在每分钟会带来约 14,400 次/天的纯维护查询，
  // 其中 analytics 恢复查询的 ORDER BY CASE 无法走索引，随表增长持续恶化。
  const recoveryTick = scheduledDate.getUTCMinutes() % 10 === 3;
  const hourlyMaintenanceTick = scheduledDate.getUTCMinutes() === 7;

  // 心跳每跳都写，不再跟着每小时的维护块走。
  //
  // 以前它一天只有 24 个采样点，每个点只反映整点过 7 分那一秒；而记进去的
  // due_bindings 又是 dueBindings(limit) 的返回条数——那个查询带 LIMIT 80，
  // 于是这个指标的取值上限就是 80，积压超过一跳的派发量之后它就再也不会变。
  // 两个缺陷叠加，等于系统没有任何可用的积压信号。
  //
  // 写在这里而不是 try 外层：心跳失败绝不能影响这一跳已经派发出去的任务。
  try {
    await repository.recordCronHeartbeat({
      scheduledAt,
      dispatchedBindings: bindings.length + trackedListings.length,
      dueBindingsTotal: dueTotals.bindings,
      dueTrackedTotal: dueTotals.trackedListings,
      enqueuedJobs,
      dispatchMs: Date.now() - dispatchStartedAt,
      // 48 小时连续性校验要读 50 小时内的全部心跳，每分钟跑一次纯属浪费。
      verifyContinuity: hourlyMaintenanceTick,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "cron_heartbeat_failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }

  // 精确同款"标题对上、图片没对上"攒到晚上的那封：每个整点看一眼有没有到点的（正常是 UTC 13:00）。
  if (scheduledDate.getUTCMinutes() === 0) {
    try {
      if (await releaseHeldExactImageDigests(env) > 0) await deliverPendingNotifications(env, repository);
    } catch (error) {
      console.error(JSON.stringify({
        event: "exact_image_hold_release_failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }

  // 建档回执的图片分组：回执发出后才开始，失败只记日志，清单页照旧按同名折叠。
  if (scheduledDate.getUTCMinutes() % 2 === 1) {
    try {
      await advanceListingGrouping(env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "listing_grouping_tick_failed",
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }

  // 只开飞书的档案，飞书没送到要几分钟内补发邮件：每分钟跟进一次飞书结果（notice-delivery.ts 的 followUpNotices）。
  try {
    await followUpNotices(env, repository);
  } catch (error) {
    console.error(JSON.stringify({
      event: "dossier_push_followup_failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }

  if (!recoveryTick && !hourlyMaintenanceTick) return;

  // 每一步都独立兜底：任何一步抛错都不能跳过后面的通知投递。
  const step = async (name: string, task: () => Promise<unknown>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      console.error(JSON.stringify({
        event: "cron_maintenance_step_failed",
        step: name,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  };

  await step("analytics_enqueue", () => enqueuePendingAnalytics(env));
  await step("gemini_recovery", () => recoverGeminiJobs(env));
  await step("product_identity_backfill", () => backfillProductIdentityProjections(env, 10));
  await step("watch_product_identity_backfill", () => (
    backfillExactWatchProductIdentityProjections(env, 10)
  ));
  if (!hourlyMaintenanceTick) return;

  await step("retired_morning_digest_cleanup", () => repository.suppressRetiredMorningDigests());
  await step("retention_prune", () => pruneOperationalHistory(env));
  await step("probe_routes", () => reconcileExperimentalProbeRoutes(env, repository));
  if (collectionPolicy.automaticCollectionAllowed) {
    await step("probes", () => runExperimentalProbes(env, repository));
    await step("automatic_p0", () => maybeRunAutomaticP0(env));
  }
  await step("html_isolation", () => repository.markHtmlIsolationIfProven());
  await step("terminal_watch_retirement", () => repository.retireTerminalItemWatches(ONE_OFF_TERMINAL_RETIRE_DAYS));
  await step("notifications", () => deliverPendingNotifications(env, repository));
  await step("completion_notification", () => deliverCompletionNotification(env, repository));
}

function publicListing(listing: NormalizedListing) {
  return {
    sourceId: listing.sourceId,
    sourceItemId: listing.sourceItemId,
    canonicalUrl: listing.canonicalUrl,
    title: listing.title,
    imageUrl: listing.imageUrl,
    shopName: listing.shopName,
    currency: listing.currency,
    currentPrice: listing.currentPrice,
    condition: listing.condition,
    availability: listing.availability,
  };
}

async function handlePublicRakutenPreview(env: Env): Promise<Response> {
  const cacheKey = new Request("https://cache.jp-goods-radar.invalid/public/rakuten/v1", { method: "GET" });
  const edgeCache = (caches as unknown as { default: Cache }).default;
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;

  const query = "千反田える";
  const sources: SourceId[] = ["rakuten_ichiba", "rakuten_books"];
  const rakutenFetch = createPacedFetch(fetch);
  const groups = await Promise.all(sources.map(async (sourceId) => {
    const adapter = getAdapter(sourceId)!;
    try {
      const result = await adapter.search({ query, filters: { page: 1, pageSize: 12, inStockOnly: true, sort: "newest" } }, {
        fetch: rakutenFetch,
        secrets: secrets(env),
      });
      return { sourceId, status: "success" as const, listings: result.listings.map(publicListing), coverage: result.coverage };
    } catch (error) {
      return { sourceId, status: "failed" as const, listings: [], error: error instanceof Error ? error.message : "搜索失败" };
    }
  }));
  const response = Response.json({ query, groups, searchedAt: new Date().toISOString() }, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" },
  });
  if (groups.every((group) => group.status === "success")) await edgeCache.put(cacheKey, response.clone());
  return response;
}

interface PreviewSourceRow {
  id: SourceId;
  enabled: 0 | 1;
  health_status: string;
  credential_status: string;
  cooldown_until: string | null;
  cooldown_route: SourceRequestRoute | null;
  request_route: SourceRequestRoute;
  last_http_status: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

function cooldownFailureEvidence(state: {
  cooldown_until: string;
  last_http_status: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}): SourceRouteFailureEvidence {
  const message = `Cloudflare 直连冷却至 ${state.cooldown_until}，本次跳过该路径${state.last_error_message ? `；上次失败：${state.last_error_message.slice(0, 300)}` : ""}`;
  return {
    code: "source_cooldown",
    status: state.last_http_status,
    retryable: false,
    message,
    attempts: [{
      attempt: 0,
      code: state.last_error_code ?? "source_cooldown",
      status: state.last_http_status,
      message,
    }],
  };
}

async function skippedPrimaryFailureForSource(
  env: Env,
  sourceId: SourceId,
): Promise<SourceRouteFailureEvidence | undefined> {
  const route = sourceRequestRoute(sourceId, env);
  const fallbackConfigured = sourceServiceFallbackConfigured(sourceId, env)
    || browserRunFallbackConfigured(sourceId, env);
  if (route !== "direct" || !fallbackConfigured) return undefined;
  const state = await env.DB.prepare(
    `SELECT cooldown_until,cooldown_route,last_http_status,last_error_code,last_error_message
     FROM source_registry WHERE id=?`,
  ).bind(sourceId).first<{
    cooldown_until: string | null;
    cooldown_route: SourceRequestRoute | null;
    last_http_status: number | null;
    last_error_code: string | null;
    last_error_message: string | null;
  }>();
  if (!state?.cooldown_until || Date.parse(state.cooldown_until) <= Date.now()
    || (state.cooldown_route ?? "direct") !== route) return undefined;
  return cooldownFailureEvidence({ ...state, cooldown_until: state.cooldown_until });
}

type PreviewGroupStatus = "success" | "empty" | "failed" | "disabled" | "cooldown";

interface PreviewHistoryGroup {
  sourceId: SourceId;
  status: PreviewGroupStatus;
  listings: NormalizedListing[];
  coverage?: string;
  parserVersion?: string;
  warnings?: string[];
  error?: string;
  errorCode?: string | null;
  retryAt?: string;
  requestRoute?: SourceRequestRoute;
  routeOutcome?: SearchRouteOutcome;
  fieldCoverage?: ReturnType<typeof listingFieldCoverage>;
  durationMs?: number;
  nextCursor?: string;
  totalAvailable?: number;
  requestEvidence?: SearchResult["requestEvidence"];
  /** Target-dependent derivative evidence keyed by source item ID. */
  candidateEvidence?: Record<string, SearchCandidateEvidence>;
  /**
   * 逐查询覆盖账本（计划 §6.5、§6.6）。
   *
   * 它回答的是“这一堆候选到底从哪几条查询来的”。没有它，宽查询造出来的
   * 噪声与真正的召回在结果里长得一模一样，只能靠固定 Top N 靠先隐起来。
   */
  queryCoverage?: QueryCoverage[];
  /**
   * 详情动作账本（计划 §6.8 / §7.3）。
   *
   * 这三件事以前都只以一句 warning 文本存在，或者根本不存在：
   * “这个来源查不了详情”、“这条详情抢失败了”、“这条详情是冲着解决什么去的”。
   * 它们是覆盖事实，不是身份结论——不能被读成“那就不是同款”。
   */
  detailLedger?: {
    requested: number;
    resolved: Record<string, string>;
    failed: Record<string, string>;
    unsupported: Record<string, string>;
  };
}

interface PreviewSourceRun {
  group: PreviewHistoryGroup;
  captures: AnalyticsSourceCapture[];
}

interface ProductSearchWorkflowTaskRow {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  input_json: string;
  plan_json: string;
  history_id: string | null;
  session_id: string | null;
  journal_ready_at: string | null;
  ai_job_id: string | null;
  ai_manifest_json: string | null;
  ai_error: string | null;
  ai_prepared_at: string | null;
}

interface ProductSearchAiManifest {
  version: typeof PRODUCT_SEARCH_AI_REVIEW_VERSION;
  totalListings: number;
  directCandidates: number;
  reviewCandidates: number;
  queuedCandidates: number;
  manualOnlyCandidates: number;
  deterministicExcludedCandidates: number;
  skippedInvalidCandidates: number;
  /**
   * 程序没判完、本轮又没拿到复核名额的候选数（计划 §9.3）。
   * 它大于 0 时，本轮的覆盖就是 partial，界面不能写“全部商品已判定”。
   */
  unreviewedUnresolvedCandidates?: number;
  /** 补详情后的二次复核（计划 §6.4 的闭环）。 */
  followUpJobId?: string;
  followUpStatus?: "not_needed" | "completed" | "unavailable";
  followUpCandidates?: number;
  followUpAppliedCandidates?: number;
  followUpHydratedCandidates?: number;
  followUpUnsupportedCandidates?: number;
  followUpError?: string;
  candidateKeys: string[];
  settlementStatus?: "completed" | "partial" | "failed" | "timed_out" | "not_needed" | "unavailable";
  settledAt?: string;
  settledModel?: string;
  settledPromptVersion?: string;
  settledItems?: Array<ListingEnrichment | null>;
  settledStates?: Array<"pending" | "ready" | "failed">;
  settlementError?: string;
}

interface ProductSearchGeminiSettlementRow {
  id: string;
  status: "staging" | "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed";
  model: string;
  prompt_version: string;
  result_json: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
}

interface ProductSearchAiSettlement {
  terminal: boolean;
  status: ProductSearchAiManifest["settlementStatus"];
  error?: string;
}

interface AdvanceProductSearchAiReviewOptions {
  timedOut?: boolean;
  processInline?: boolean;
}

interface ProductSearchWorkflowParams {
  taskId: string;
}

interface SearchContinuationRow {
  id: string;
  query: string;
  sources_json: string;
  filters_json: string;
  search_mode: ProductSearchPlan["mode"];
  target_json: string | null;
  deep_search: number;
}

interface SessionSnapshotRow {
  page_sequence: number;
  group_json: string;
}

// 本地锚点召回已停用：`source_history_anchors` 只保留为成交证据，不再作为搜索候选
// 注入结果。它的模糊标题匹配（bigram dice ≥ 0.12）会把无关 IP 带进当前关键词的结果，
// 而 Mercari 自身的 STATUS_SOLD_OUT 索引本来就返回已售商品。

function previewHistoryStatus(groups: PreviewHistoryGroup[]): "success" | "partial" | "empty" | "failed" {
  const resultCount = groups.reduce((total, group) => total + group.listings.length, 0);
  const hasUnavailableSource = groups.some((group) => ["failed", "disabled", "cooldown"].includes(group.status));
  if (resultCount > 0) return hasUnavailableSource ? "partial" : "success";
  return groups.every((group) => group.status === "success" || group.status === "empty") ? "empty" : "failed";
}

function storedPreviewFilters(input: {
  minPrice?: number;
  maxPrice?: number;
  conditions?: string[];
  inStockOnly?: boolean;
  availabilityMode?: SearchFilters["availabilityMode"];
  sourcePageTokens?: Partial<Record<SourceId, string>>;
}): Record<string, unknown> {
  return {
    minPrice: input.minPrice ?? null,
    maxPrice: input.maxPrice ?? null,
    conditions: input.conditions ?? [],
    inStockOnly: input.inStockOnly ?? false,
    availabilityMode: input.availabilityMode ?? "all",
    sourcePageTokens: input.sourcePageTokens ?? {},
  };
}

function previewSourceSummary(groups: readonly PreviewHistoryGroup[]) {
  return groups.map((group) => ({
    sourceId: group.sourceId,
    status: group.status,
    resultCount: group.listings.length,
    coverage: group.coverage ?? null,
    errorCode: group.errorCode ?? null,
    error: group.error?.slice(0, 300) ?? null,
    retryAt: group.retryAt ?? null,
    requestRoute: group.requestRoute ?? null,
    routeOutcome: group.routeOutcome ?? null,
    fieldCoverage: group.fieldCoverage ?? null,
    durationMs: group.durationMs ?? null,
  }));
}

function mergeSessionPreviewGroups(groups: readonly PreviewHistoryGroup[]): PreviewHistoryGroup[] {
  const merged = new Map<SourceId, PreviewHistoryGroup>();
  for (const group of groups) {
    const current = merged.get(group.sourceId);
    if (!current) {
      merged.set(group.sourceId, group);
      continue;
    }
    const listings = new Map(current.listings.map((listing) => [listing.sourceItemId, listing]));
    for (const listing of group.listings) listings.set(listing.sourceItemId, listing);
    const combinedListings = [...listings.values()];
    merged.set(group.sourceId, {
      ...current,
      ...group,
      status: combinedListings.length > 0 ? "success" : group.status,
      listings: combinedListings,
      warnings: [...new Set([...(current.warnings ?? []), ...(group.warnings ?? [])])],
      candidateEvidence: { ...(current.candidateEvidence ?? {}), ...(group.candidateEvidence ?? {}) },
      durationMs: (current.durationMs ?? 0) + (group.durationMs ?? 0),
    });
  }
  return [...merged.values()];
}

async function validateSearchContinuation(
  env: Env,
  sessionId: string,
  input: {
    query: string;
    plan: ProductSearchPlan;
    sources: SourceId[];
    minPrice?: number;
    maxPrice?: number;
    conditions?: string[];
    inStockOnly?: boolean;
    availabilityMode?: SearchFilters["availabilityMode"];
  },
): Promise<string | undefined> {
  const root = await env.DB.prepare(
    `SELECT id,query,sources_json,filters_json,search_mode,target_json,deep_search
     FROM search_history WHERE id=? AND parent_history_id IS NULL`,
  ).bind(sessionId).first<SearchContinuationRow>();
  if (!root) return "search_session_not_found";
  const rootSources = stringArrayJson(root.sources_json);
  if (input.sources.some((sourceId) => !rootSources.includes(sourceId))) return "search_session_source_mismatch";
  if (root.query !== input.query || root.search_mode !== input.plan.mode || root.deep_search !== (input.plan.deepSearch ? 1 : 0)) {
    return "search_session_query_mismatch";
  }
  const storedTarget = root.target_json ? recordJson(root.target_json) : null;
  if (JSON.stringify(storedTarget) !== JSON.stringify(input.plan.target ?? null)) return "search_session_target_mismatch";
  const rootFilters = recordJson(root.filters_json);
  const nextFilters = storedPreviewFilters(input);
  for (const key of ["minPrice", "maxPrice", "conditions", "inStockOnly", "availabilityMode"] as const) {
    if (JSON.stringify(rootFilters[key]) !== JSON.stringify(nextFilters[key])) return "search_session_filter_mismatch";
  }
  return undefined;
}

async function recordPreviewHistory(
  env: Env,
  input: {
    query: string;
    plan: ProductSearchPlan;
    sources: SourceId[];
    minPrice?: number;
    maxPrice?: number;
    conditions?: string[];
    inStockOnly?: boolean;
    availabilityMode?: SearchFilters["availabilityMode"];
    sourcePageTokens?: Partial<Record<SourceId, string>>;
    searchSessionId?: string;
    historyId?: string;
  },
  groups: PreviewHistoryGroup[],
  captures: readonly AnalyticsSourceCapture[],
): Promise<{ historyId: string; sessionId: string; searchedAt: string; analyticsOutboxId: string }> {
  const historyId = input.historyId ?? crypto.randomUUID();
  const sessionId = input.searchSessionId ?? historyId;
  const analyticsOutboxId = crypto.randomUUID();
  const searchedAt = new Date().toISOString();
  const resultCount = groups.reduce((total, group) => total + group.listings.length, 0);
  const sourceSummary = previewSourceSummary(groups);
  let pageSequence = 1;
  let aggregateGroups = groups;
  if (input.searchSessionId) {
    const snapshots = await env.DB.prepare(
      `SELECT history.page_sequence,snapshot.group_json
       FROM search_history history
       JOIN search_result_snapshots snapshot ON snapshot.search_history_id=history.id
       WHERE history.session_id=?
       ORDER BY history.page_sequence,snapshot.source_id`,
    ).bind(sessionId).all<SessionSnapshotRow>();
    pageSequence = Math.max(1, ...snapshots.results.map((row) => row.page_sequence)) + 1;
    const previousGroups = snapshots.results.flatMap((row) => {
      try {
        const value = JSON.parse(row.group_json) as PreviewHistoryGroup;
        return value && typeof value === "object" && Array.isArray(value.listings) ? [value] : [];
      } catch {
        return [];
      }
    });
    aggregateGroups = mergeSessionPreviewGroups([...previousGroups, ...groups]);
  }
  const aggregateResultCount = aggregateGroups.reduce((total, group) => total + group.listings.length, 0);
  const aggregateSourceSummary = previewSourceSummary(aggregateGroups);
  const statements = [
    env.DB.prepare(
      `INSERT INTO search_history(
        id,query,sources_json,filters_json,status,result_count,source_summary_json,searched_at,
        search_mode,target_json,plan_json,deep_search,session_id,parent_history_id,page_sequence,session_updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      historyId,
      input.query,
      JSON.stringify(input.sources),
      JSON.stringify(storedPreviewFilters(input)),
      previewHistoryStatus(groups),
      resultCount,
      JSON.stringify(sourceSummary),
      searchedAt,
      input.plan.mode,
      input.plan.target ? JSON.stringify(input.plan.target) : null,
      JSON.stringify(input.plan),
      input.plan.deepSearch ? 1 : 0,
      sessionId,
      input.searchSessionId ?? null,
      pageSequence,
      searchedAt,
    ),
    ...(input.searchSessionId ? [env.DB.prepare(
      `UPDATE search_history
       SET status=?,result_count=?,source_summary_json=?,session_updated_at=?
       WHERE id=? AND parent_history_id IS NULL`,
    ).bind(
      previewHistoryStatus(aggregateGroups),
      aggregateResultCount,
      JSON.stringify(aggregateSourceSummary),
      searchedAt,
      sessionId,
    )] : []),
    ...groups.map((group) => env.DB.prepare(
      `INSERT INTO search_result_snapshots(search_history_id,source_id,group_json,captured_at)
       VALUES(?,?,?,?)`,
    ).bind(historyId, group.sourceId, JSON.stringify(group), searchedAt)),
    ...sourceCaptureStatements(env.DB, historyId, captures),
    ...input.plan.variants.map((variant, index) => env.DB.prepare(
      `INSERT INTO search_query_variants(
        search_history_id,variant_id,query,query_kind,lane,weight,ordinal
       ) VALUES(?,?,?,?,?,?,?)`,
    ).bind(historyId, variant.id, variant.query, variant.kind, variant.lane, variant.weight, index + 1)),
    ...groups.flatMap((group) => group.listings.flatMap((listing) => (
      group.candidateEvidence?.[listing.sourceItemId]?.hits ?? []
    ).map((hit) => env.DB.prepare(
        `INSERT INTO search_candidate_hits(
          search_history_id,source_id,source_item_id,variant_id,lane,upstream_rank,weight,live_verified
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).bind(historyId, group.sourceId, listing.sourceItemId, hit.variantId, hit.lane, hit.upstreamRank, hit.weight, hit.liveVerified ? 1 : 0)))),
    ...groups.flatMap((group) => group.listings.flatMap((listing) => {
      const match = group.candidateEvidence?.[listing.sourceItemId]?.match;
      return match ? [env.DB.prepare(
        `INSERT INTO search_product_relations(
          search_history_id,source_id,source_item_id,relation,score,matcher_version,evidence_json,created_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).bind(historyId, group.sourceId, listing.sourceItemId, match.relation, match.score, match.version, JSON.stringify(match), searchedAt)] : [];
    })),
    manualAnalyticsOutboxStatement(env.DB, analyticsOutboxId, historyId, searchedAt),
    ...groups
      .filter((group) => group.sourceId === "mercari_jp")
      .flatMap((group) => group.listings)
      .filter((listing) => listing.availability === "sold_out")
      .slice(0, 24)
      .map((listing) => env.DB.prepare(
        `INSERT INTO source_history_anchors(
          source_id,source_item_id,title_hint,pinned,first_verified_at,last_verified_at
         ) VALUES(?,?,?,0,?,?)
         ON CONFLICT(source_id,source_item_id) DO UPDATE SET
          title_hint=excluded.title_hint,last_verified_at=excluded.last_verified_at`,
      ).bind(listing.sourceId, listing.sourceItemId, listing.title, searchedAt, searchedAt)),
  ];
  // 历史裁剪与 capture 过期清理已移至 pruneOperationalHistory（每小时 cron），
  // 不再挂在手动搜索路径上。
  // Transaction batch size is deliberately bounded. A five-variant exact search can
  // produce hundreds of hit/relation rows, while the immutable snapshot still
  // remains one logical search journal entry.
  for (let index = 0; index < statements.length; index += 80) {
    await env.DB.batch(statements.slice(index, index + 80));
  }
  return { historyId, sessionId, searchedAt, analyticsOutboxId };
}

async function recordPreviewSuccess(env: Env, sourceId: SourceId, result: RoutedSearchResult): Promise<void> {
  const now = new Date().toISOString();
  if (result.routeOutcome.kind === "fallback_success") {
    if (sourceId === "mercari_jp") {
      // 煤炉主路的冷却与故障提醒由 mercari-route.ts 在换路当下写好了；这里只记"来源可用"，
      // 让"全线不通"提醒知道故障已经结束。
      await env.DB.prepare("UPDATE source_registry SET last_success_at=?,updated_at=? WHERE id=?")
        .bind(now, now, sourceId).run();
      return;
    }
    const failure = result.routeOutcome.primaryFailure;
    if (failure.code === "source_cooldown") {
      await env.DB.prepare(
        `UPDATE source_registry SET health_status='degraded',request_route=?,
         last_signature_success_at=CASE WHEN ?='mercari_service' THEN ? ELSE last_signature_success_at END,
         updated_at=? WHERE id=?`,
      ).bind(result.routeOutcome.primaryRoute, result.requestRoute,
        result.requestRoute === "mercari_service" ? now : null, now, sourceId).run();
      return;
    }
    const retryAfterSeconds = failure.status === 403 ? 12 * 60 * 60 : failure.status === 429 ? 2 * 60 * 60 : undefined;
    const cooldownUntil = retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1_000).toISOString() : null;
    await env.DB.prepare(
      `UPDATE source_registry SET health_status='degraded',last_failure_at=?,consecutive_failures=consecutive_failures+1,
       last_http_status=?,last_error_code=?,last_error_message=?,request_route=?,
       cooldown_until=?,cooldown_route=CASE WHEN CAST(? AS TEXT) IS NULL THEN NULL ELSE ? END,
       last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,
       last_429_at=CASE WHEN ?=429 THEN ? ELSE last_429_at END,
       last_signature_success_at=CASE WHEN ?='mercari_service' THEN ? ELSE last_signature_success_at END,
       updated_at=? WHERE id=?`,
    ).bind(now, failure.status, failure.code, failure.message.slice(0, 500), result.routeOutcome.primaryRoute,
      cooldownUntil, cooldownUntil, result.routeOutcome.primaryRoute,
      failure.status, now, failure.status, now,
      result.requestRoute, result.requestRoute === "mercari_service" ? now : null,
      now, sourceId).run();
    return;
  }
  const route = result.routeOutcome.route;
  await env.DB.prepare(
    `UPDATE source_registry SET health_status='healthy',credential_status=CASE WHEN official_api=1 THEN 'ready' ELSE 'not_required' END,
     parser_version=?,last_success_at=?,consecutive_failures=0,cooldown_until=NULL,last_http_status=NULL,
     request_route=?,cooldown_route=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`,
  ).bind(result.parserVersion, now, route, now, sourceId).run();
}

async function recordPreviewFailure(env: Env, sourceId: SourceId, error: unknown): Promise<{ errorCode?: string; cooldownUntil?: string }> {
  const adapterError = error instanceof AdapterError ? error : undefined;
  const now = new Date().toISOString();
  const route = sourceRequestRoute(sourceId, env);
  const routeFailure = sourceRouteFailures(error).find((failure) => failure.route === route)?.failure;
  if (routeFailure?.code === "source_cooldown") {
    await env.DB.prepare(
      `UPDATE source_registry SET health_status='degraded',last_failure_at=?,
       consecutive_failures=consecutive_failures+1,request_route=?,updated_at=? WHERE id=?`,
    ).bind(now, route, now, sourceId).run();
    return { errorCode: adapterError?.code ?? routeFailure.code };
  }
  const failureStatus = routeFailure?.status ?? adapterError?.status;
  const retryAfterSeconds = adapterError?.retryAfterSeconds
    ?? (failureStatus === 403 ? 12 * 60 * 60 : failureStatus === 429 ? 2 * 60 * 60 : undefined);
  const cooldownUntil = retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1_000).toISOString() : undefined;
  const errorCode = routeFailure?.code ?? adapterError?.code ?? "preview_search_failed";
  const message = error instanceof Error ? error.message : "搜索失败";
  await env.DB.prepare(
    `UPDATE source_registry SET health_status=CASE WHEN ? IN (403,429) THEN 'blocked' ELSE 'degraded' END,
     last_failure_at=?,consecutive_failures=consecutive_failures+1,last_http_status=?,last_error_code=?,last_error_message=?,
     last_403_at=CASE WHEN ?=403 THEN ? ELSE last_403_at END,last_429_at=CASE WHEN ?=429 THEN ? ELSE last_429_at END,
     request_route=?,cooldown_until=CASE WHEN CAST(? AS TEXT) IS NULL THEN cooldown_until ELSE ? END,
     cooldown_route=CASE WHEN CAST(? AS TEXT) IS NULL THEN cooldown_route ELSE ? END,updated_at=? WHERE id=?`,
  ).bind(failureStatus ?? null, now, failureStatus ?? null, errorCode, message.slice(0, 500),
    failureStatus ?? null, now, failureStatus ?? null, now,
    route, cooldownUntil ?? null, cooldownUntil ?? null, cooldownUntil ?? null, route, now, sourceId).run();
  return { errorCode, cooldownUntil };
}

/**
 * 历史索引只接收查询计划里已经组合好的商品身份查询，不再把角色、品类等单个泛词
 * 拆开做 OR 召回。数据库函数仍负责有界粗召回，最终是否进入候选由同一套商品身份
 * matcher 决定。
 */
function historicalRecallTerms(plan: ProductSearchPlan): string[] {
  if (plan.mode !== "exact_product" || !plan.target) return [];
  const terms = plan.variants
    .filter((variant) => variant.lane === "source_native")
    .map((variant) => variant.query.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .filter(Boolean);
  const identifiers = [plan.target.jan, plan.target.model]
    .map((value) => value?.normalize("NFKC").trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set([...identifiers, ...terms])].slice(0, 12);
}

/**
 * 历史库里的价格和可购状态只是最后一次观测，不是现在仍然成立的事实。未重新打开详情
 * 前，把可能可购的状态降为 unknown；明确的已售/不可用终局可以作为历史事实保留。
 */
function historicalListingCandidate(value: AnalyticsHistoricalListing): NormalizedListing | undefined {
  const terminalAvailability = value.availability === "sold_out" || value.availability === "unavailable"
    ? value.availability
    : "unknown";
  const parsed = normalizedListingSchema.safeParse({
    sourceId: value.sourceId,
    sourceItemId: value.sourceItemId,
    identityScope: value.identityScope,
    canonicalUrl: value.canonicalUrl,
    title: value.title,
    ...(value.descriptionExcerpt ? { descriptionExcerpt: value.descriptionExcerpt } : {}),
    ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
    ...(value.sellerName ? { sellerName: value.sellerName } : {}),
    ...(value.shopName ? { shopName: value.shopName } : {}),
    currency: value.currency,
    ...(value.currentPrice === undefined ? {} : { currentPrice: value.currentPrice }),
    ...(value.originalPrice === undefined ? {} : { originalPrice: value.originalPrice }),
    priceBasis: value.priceBasis,
    condition: value.condition,
    availability: terminalAvailability,
    facts: value.facts,
    rawMetadata: {
      ...value.rawMetadata,
      historicalIndex: {
        firstSeenAt: value.firstSeenAt,
        lastSeenAt: value.lastSeenAt,
        lastKnownAvailability: value.availability,
      },
    },
  });
  return parsed.success ? parsed.data : undefined;
}

interface SearchCandidateAccumulator {
  listing: NormalizedListing;
  hits: CandidateHit[];
}

/**
 * 主查询这一枪是否已经把目标商品捞回来了——用它决定要不要再花一次上游请求打短召回。
 *
 * 判据取最严的两档（exact / probable_exact）：这两档意味着"这条就是目标商品"，
 * 再追加查询只会捞回同一批东西。更低的档位（variant / related / uncertain）说明
 * 本轮只搜到了周边或同系列，正是短召回该上场的场景。
 *
 * 不看在售状态：这里问的是"这条查询能不能搜到这件商品"，一条已售出的确认同款
 * 同样证明查询本身有效。在售与否由后面的清洗和送达门槛去管。
 */
function hasQualifiedExactCandidate(
  candidates: Map<string, SearchCandidateAccumulator>,
  target: ProductFingerprint,
  options: { requireLiveEvidence?: boolean; requirePurchasable?: boolean } = {},
): boolean {
  const { requireLiveEvidence = true, requirePurchasable = false } = options;
  for (const candidate of candidates.values()) {
    if (requireLiveEvidence && !candidate.hits.some((hit) => hit.liveVerified)) continue;
    // 确认同款但已售出，证明的是「这条查询有价值」，不是「用户要的在售
    // 目标已经找到了」（计划 §6.4）。拿它停搜索，用户拿到的是一件买不到的商品。
    if (requirePurchasable && candidate.listing.availability !== "available") continue;
    const { relation } = assessProductMatch(candidate.listing, target, candidate.hits);
    if (relation === "exact" || relation === "probable_exact") return true;
  }
  return false;
}

/**
 * 本轮是否已经拿到带身份锚点的候选。拿到了，宽兜底查询就不值得再发。
 * 找到一条就返回：这个判断在每条查询前都要跑一次，不能对几百条候选全量重算。
 */
function hasAnchoredCandidate(
  candidates: Map<string, SearchCandidateAccumulator>,
  plan: ProductSearchPlan,
): boolean {
  if (!plan.target) return false;
  for (const candidate of candidates.values()) {
    const assessment = assessProductMatch(candidate.listing, plan.target, candidate.hits);
    if ((assessment.difference?.matched.length ?? 0) > 0) return true;
  }
  return false;
}

/** 没发出去或没返回结果的查询也要入账：“没搜”和“搜了没有”不能同分。 */
function skippedQueryCoverage(variant: SearchQueryVariant, stopReason: QueryStopReason): QueryCoverage {
  return {
    queryId: variant.id,
    query: variant.query,
    purpose: variant.purpose ?? "precise",
    lane: "source_native",
    pagesFetched: 0,
    rawReturned: 0,
    uniqueNewListings: 0,
    duplicateListings: 0,
    hardConflictCount: 0,
    reportedTotalReliability: "unknown",
    nextCursor: null,
    stopReason,
    coverage: "unknown",
    latencyMs: 0,
  };
}

/**
 * 把库里上一次补抓留下的详情贴回本轮的搜索结果，用于跳过重复补抓的候选。
 *
 * 价格、在售状态、标题一律以本轮搜索结果为准——那是最新的；补的只有详情页才有的
 * 描述与结构化属性，它们描述商品本身，不随轮次变化。这里刻意不打
 * rawMetadata.detailHydrated：那一位是详情请求的凭据，打上会让水位自我续期，
 * 补抓从此再也不会发生。
 */
function applyStoredListingDetail(
  searchListing: NormalizedListing,
  stored: StoredListingDetail,
): NormalizedListing {
  const storedFacts = Object.keys(stored.facts).length > 0
    ? stored.facts as NormalizedListing["facts"]
    : undefined;
  const facts = searchListing.facts || storedFacts
    ? { ...searchListing.facts, ...storedFacts }
    : undefined;
  return {
    ...searchListing,
    ...(searchListing.descriptionExcerpt || !stored.descriptionExcerpt
      ? {}
      : { descriptionExcerpt: stored.descriptionExcerpt }),
    ...(facts ? { facts } : {}),
  };
}

/**
 * 详情**缺**字段和详情**显式删掉**字段不是一回事（计划 §7.2）。
 *
 * 对象展开里一个值为 undefined 的键照样会盖掉左边的值，所以适配器只要少填一个
 * 字段，列表阶段已经拿到的那个值就被抹掉了。这里先把 undefined 的键去掉再展开：
 * 详情没提到的，保留列表已有的；详情真给了空值的，才算它说了话。
 */
function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function mergeSearchAndDetailListing(searchListing: NormalizedListing, detailListing: NormalizedListing): NormalizedListing {
  const detailImages = detailListing.facts?.imageUrls;
  const searchImages = searchListing.facts?.imageUrls;
  const facts = searchListing.facts || detailListing.facts
    ? {
        ...searchListing.facts,
        ...(detailListing.facts ? definedEntries(detailListing.facts) : {}),
        ...((detailImages?.length ?? 0) > 0
          ? { imageUrls: detailImages }
          : (searchImages?.length ?? 0) > 0
            ? { imageUrls: searchImages }
            : {}),
      }
    : undefined;
  return {
    ...searchListing,
    ...definedEntries(detailListing),
    imageUrl: detailListing.imageUrl ?? searchListing.imageUrl,
    ...(facts ? { facts } : { facts: undefined }),
    // 这一位是详情补抓的落库凭据：persistListing 靠它推进 listings.detail_hydrated_at，
    // 下一轮才知道这条已经抓过、可以跳过。只有真的发出过详情请求才允许打上。
    rawMetadata: { ...searchListing.rawMetadata, ...detailListing.rawMetadata, detailHydrated: true },
  };
}

function addCandidate(
  candidates: Map<string, SearchCandidateAccumulator>,
  listing: NormalizedListing,
  hit: CandidateHit,
): void {
  const key = candidateKey(listing.sourceId, listing.sourceItemId);
  const current = candidates.get(key);
  if (!current) {
    candidates.set(key, { listing, hits: [hit] });
    return;
  }
  const existingHit = current.hits.findIndex((value) => value.variantId === hit.variantId && value.lane === hit.lane);
  if (existingHit < 0) current.hits.push(hit);
  else if (hit.upstreamRank < current.hits[existingHit]!.upstreamRank) current.hits[existingHit] = hit;
  // 重复命中只追加 query 溯源，**不覆盖已经抓到的详情**（计划 §7.2）。
  // 所有 source_native 命中都带 liveVerified=true，所以旧写法意味着：查询 1 召回
  // 并抓了详情的候选，被查询 2 再召回一次就退回列表态——正文里那句版本说明就这么
  // 没了，而它往往正是这条候选唯一的判据。
  const alreadyHydrated = current.listing.rawMetadata?.detailHydrated === true;
  if (hit.liveVerified && !alreadyHydrated) {
    current.listing = listing;
    return;
  }
  // 新列表标题与已抓详情不一致时，标记需要刷新，而不是拼成一个看着一致的假对象。
  if (alreadyHydrated && listing.title && listing.title !== current.listing.title) {
    current.listing = {
      ...current.listing,
      rawMetadata: { ...current.listing.rawMetadata, listingTitleRefreshNeeded: listing.title },
    };
  }
}

function candidateEvidence(
  candidates: ReadonlyMap<string, SearchCandidateAccumulator>,
  plan: ProductSearchPlan,
): Record<string, SearchCandidateEvidence> {
  const corpus = plan.target
    ? buildProductMatchCorpus([...candidates.values()].map((value) => value.listing), plan.target)
    : undefined;
  return Object.fromEntries([...candidates.values()].map((candidate) => {
    const match = plan.target ? assessProductMatch(candidate.listing, plan.target, candidate.hits, corpus) : undefined;
    return [candidate.listing.sourceItemId, searchCandidateEvidence(candidate.hits, match)];
  }));
}

async function runPreviewSource(
  env: Env,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
  sourceId: SourceId,
): Promise<PreviewSourceRun> {
  const {
    query,
    minPrice,
    maxPrice,
    conditions,
    inStockOnly,
    availabilityMode,
    sourcePageTokens,
  } = input;
  const startedAt = Date.now();
  const adapter = getAdapter(sourceId);
  const state = await env.DB.prepare(
    `SELECT id,enabled,health_status,credential_status,cooldown_until,cooldown_route,request_route,
      last_http_status,last_error_code,last_error_message
     FROM source_registry WHERE id=?`,
  ).bind(sourceId).first<PreviewSourceRow>();
  if (!adapter || !state) return {
    group: { sourceId, status: "disabled", listings: [], error: "该来源尚未接入", durationMs: Date.now() - startedAt },
    captures: [],
  };
  if (availabilityMode === "sold_out" && !adapter.capabilities.historySearchSupported) {
    return {
      group: {
        sourceId,
        status: "failed",
        listings: [],
        error: "该来源没有真实的已成交历史查询接口",
        errorCode: "history_search_unsupported",
        durationMs: Date.now() - startedAt,
      },
      captures: [],
    };
  }
  if (!state.enabled || state.health_status === "disabled" || state.health_status === "broken") {
    return {
      group: {
        sourceId,
        status: "disabled",
        listings: [],
        error: state.last_error_message || "该来源尚未通过可用性验证",
        errorCode: state.last_error_code,
        durationMs: Date.now() - startedAt,
      },
      captures: [],
    };
  }
  const route = sourceRequestRoute(sourceId, env);
  const primaryCooling = Boolean(state.cooldown_until && Date.parse(state.cooldown_until) > Date.now()
    && (state.cooldown_route ?? "direct") === route);
  const previewFallbackConfigured = sourceServiceFallbackConfigured(sourceId, env)
    || browserRunFallbackConfigured(sourceId, env);
  if (primaryCooling && !previewFallbackConfigured) {
    return {
      group: {
        sourceId,
        status: "cooldown",
        listings: [],
        error: "来源正在冷却，暂不重复请求",
        errorCode: state.last_error_code,
        retryAt: state.cooldown_until ?? undefined,
        durationMs: Date.now() - startedAt,
      },
      captures: [],
    };
  }
  const skippedPrimaryFailure = primaryCooling && state.cooldown_until
    ? cooldownFailureEvidence({ ...state, cooldown_until: state.cooldown_until })
    : undefined;
  const filters: SearchFilters = {
    minPrice,
    maxPrice,
    conditions,
    inStockOnly,
    availabilityMode,
    sort: plan.mode === "exact_product"
      ? "relevance"
      : sourceId === "yahoo_auctions_jp"
        ? availabilityMode === "sold_out" ? "ending_late" : "relevance"
        : availabilityMode === "sold_out" ? "relevance" : "newest",
    page: 1,
    // 含已售的模式要看的是成交历史，窗口越浅越容易只剩最近上架的在售品。
    pageSize: sourceId === "mercari_jp" && availabilityMode !== "purchasable" ? 120 : 30,
  };
  const captureRecorder = createSourceCaptureRecorder(
    sourceId,
    isRakutenSource(sourceId) ? createPacedFetch(fetch) : fetch,
  );
  const rawBrowserFetch = browserFallbackFetch(sourceId, env);
  const capturedBrowserFetch = rawBrowserFetch ? captureRecorder.wrap(rawBrowserFetch) : undefined;
  try {
    const pageToken = sourcePageTokens?.[sourceId];
    // 游标绑定它自己的查询（计划 §6.6）。旧写法把“某一条查询的下一页”当成了
    // “这个来源的下一页”，翻页时又固定拿第一条查询去用——两者对不上时，
    // 翻到的是另一个结果集。现在 token 自带它属于哪条查询；旧 token 没有前缀，
    // 按原来的行为走。
    const cursorSeparator = "::";
    const [encodedVariantId, ...encodedCursor] = pageToken?.includes(cursorSeparator)
      ? pageToken.split(cursorSeparator)
      : [];
    const resumeVariantId = encodedVariantId;
    const resumeCursor = encodedCursor.length > 0 ? encodedCursor.join(cursorSeparator) : pageToken;
    const plannedNativeVariants = plan.variants.filter((variant) => variant.lane === "source_native");
    // 二手卖家通常只写角色、品类或版本简称；一手店则使用目录里的正式商品名。
    // 计划已经按用途排好序（标识符 > 具体组合 > 召回别名 > 宽兜底），
    // 这里只决定原始完整标题放哪里：一手店提前，二手站放最后。
    const sourceOrderedVariants = plan.mode !== "exact_product"
      ? plannedNativeVariants
      : FIRST_HAND_SOURCE_IDS.has(sourceId)
        ? [
            ...plannedNativeVariants.filter((variant) => variant.kind === "original"),
            ...plannedNativeVariants.filter((variant) => variant.kind !== "original"),
          ]
        : [
            ...plannedNativeVariants.filter((variant) => variant.kind !== "original"),
            ...plannedNativeVariants.filter((variant) => variant.kind === "original"),
          ];
    // 翻页时只跑游标所属的那一条查询。计划换了版、那条查询已经不存在时，
    // 宁可从第一条查询重新开始（下面的 resumeVariantId 匹配会失败，游标自然不被使用），
    // 也不能拿它去翻另一条查询的下一页，更不能静静返回空页。
    // 旧 token 没有前缀，按旧行为归给第一条查询；否则它会被静静丢掉，
    // “加载下一页”变成重新拿第一页。
    const effectiveResumeVariantId = resumeVariantId ?? (pageToken ? sourceOrderedVariants[0]?.id : undefined);
    const resumeVariant = effectiveResumeVariantId
      ? sourceOrderedVariants.find((variant) => variant.id === effectiveResumeVariantId)
      : undefined;
    const nativeVariants = pageToken
      ? [resumeVariant ?? sourceOrderedVariants[0]].filter((variant): variant is SearchQueryVariant => Boolean(variant))
      : sourceOrderedVariants;
    /** 逐查询覆盖账本（计划 §6.5、§6.6）。 */
    const queryCoverage: QueryCoverage[] = [];
    const candidates = new Map<string, SearchCandidateAccumulator>();
    const successfulResults: RoutedSearchResult[] = [];
    const variantWarnings: string[] = [];
    const detailAttempted = new Set<string>();
    /** 来源对这条商品不支持详情 —— 能力事实，不是身份结论。 */
    const detailUnsupported = new Map<string, CandidateDetailCapability>();
    /** 详情抓到了，且这次请求本来是冲着解决什么去的。 */
    const detailResolved = new Map<string, CandidateDetailActionReason>();
    /** 详情请求失败 —— 覆盖问题，同样不是身份结论。 */
    const detailFailed = new Map<string, string>();
    let detailRequests = 0;
    let lastVariantError: unknown;

    /**
     * 这条候选的详情能力（计划 §6.8）。
     *
     * 同一个来源里有些商品天生查不了详情（Mercari Shops 的商品不在 C2C 详情接口的
     * 服务范围内）。以前只看 `adapter.getItem` 存不存在，于是这些商品每轮都稳定
     * 失败一次，失败又只变成一句 warning 文本。现在它是一条被记录的能力事实：
     * 不花请求，也不会被当成「不是同款」。
     */
    const detailCapabilityOf = (listing: NormalizedListing): CandidateDetailCapability => {
      if (!adapter.getItem || !adapter.capabilities.itemLookup) return "unsupported_source";
      const target = listing.canonicalUrl || listing.sourceItemId;
      return adapter.canGetItem?.(target) === false ? "unsupported_item" : "supported";
    };

    const hydratePromisingCandidates = async (
      limit: number,
      detailCeiling = MANUAL_EXACT_DETAIL_LIMIT,
    ): Promise<void> => {
      if (plan.mode !== "exact_product" || !plan.target || !adapter.getItem || pageToken) return;
      const corpus = buildProductMatchCorpus([...candidates.values()].map((value) => value.listing), plan.target);
      const remaining = Math.max(0, Math.min(limit, detailCeiling - detailRequests));
      if (remaining === 0) return;
      // 派单依据是「这次详情能解决什么」，不是 relation 白名单 + 分数排序。
      // 详见 packages/core 的 planCandidateDetailActions。
      const actions = planCandidateDetailActions(
        [...candidates.values()].map((candidate) => {
          const key = candidateKey(candidate.listing.sourceId, candidate.listing.sourceItemId);
          const capability = detailCapabilityOf(candidate.listing);
          if (capability !== "supported") detailUnsupported.set(key, capability);
          return {
            key,
            hits: candidate.hits,
            match: assessProductMatch(candidate.listing, plan.target!, candidate.hits, corpus),
            detailHydrated: detailAttempted.has(key)
              || candidate.listing.rawMetadata?.detailHydrated === true,
            detailCapability: capability,
            availability: candidate.listing.availability,
            candidate,
          };
        }),
        remaining,
      );
      for (const action of actions) {
        const candidate = action.candidate.candidate;
        const key = action.candidate.key;
        detailAttempted.add(key);
        detailRequests += 1;
        try {
          const detail = await itemWithConfiguredRoute(
            env,
            adapter,
            candidate.listing.canonicalUrl || candidate.listing.sourceItemId,
            { fetch: captureRecorder.fetch, secrets: secrets(env) },
            { browserFetch: capturedBrowserFetch },
          );
          candidate.listing = mergeSearchAndDetailListing(candidate.listing, detail);
          candidate.hits = candidate.hits.map((hit) => ({ ...hit, liveVerified: true }));
          detailResolved.set(key, action.reason);
        } catch (error) {
          detailFailed.set(key, error instanceof Error ? error.message.slice(0, 180) : "详情失败");
          variantWarnings.push(`候选 ${candidate.listing.sourceItemId} 详情核验失败：${error instanceof Error ? error.message.slice(0, 180) : "详情失败"}`);
        }
      }
    };

    for (const [variantIndex, variant] of nativeVariants.entries()) {
      const purpose = variant.purpose ?? "precise";
      // 收紧而不是惯性放宽（计划 §6.4）：前面的具体查询已经召回了带身份锚点的候选时，
      // 不再执行宽兜底查询。宽查询的代价不是多几条结果，是几百条噪声——2026-09-10
      // 那 866 条候选就是这么堆出来的，然后再靠固定 Top N 假装收敛。
      if (purpose === "bounded_fallback" && hasAnchoredCandidate(candidates, plan)) {
        queryCoverage.push(skippedQueryCoverage(variant, "refined"));
        continue;
      }
      const variantStartedAt = Date.now();
      const sourceConfig = {
        ...(resumeCursor && effectiveResumeVariantId === variant.id ? { pageToken: resumeCursor } : {}),
        ...(plan.mode === "exact_product" ? { searchMode: "exact_product" } : {}),
      };
      const searchRequest = {
        query: variant.query,
        filters,
        ...(Object.keys(sourceConfig).length ? { sourceConfig } : {}),
      };
      const runPage = (pageRequest: typeof searchRequest) => searchWithConfiguredRoute(env, adapter, pageRequest, {
        fetch: captureRecorder.fetch,
        secrets: secrets(env),
      }, { allowManagedFallback: true, skippedPrimaryFailure, browserFetch: capturedBrowserFetch });
      // 精确搜索靠多条高信息查询与详情闭环，不让第一条短查询独占三页预算；网页补漏
      // 负责来源索引已经遗失的老商品。关键词模式仍由主查询读取多页窗口。
      const pageBudget = pageToken || variantIndex > 0 || plan.mode === "exact_product"
        ? 1
        : MANUAL_SEARCH_PAGE_BUDGET;
      const before = new Set(candidates.keys());
      try {
        const result = pageBudget > 1
          ? await collectMarketWindow(searchRequest, pageBudget, runPage)
          : await runPage(searchRequest);
        successfulResults.push(result);
        // 只收这一枪的前若干名。
        //
        // 平台搜索本身按相关度排序，一页 100~120 条，越往后越不像。把整页照单全收
        // 的后果是 2026-09-12 那次：五枪 × 一整页 = 463 个候选，而有限的详情预算
        // 要撒进这 463 条里，撞上真货的概率接近零。名次不是同款证据（它还受价格、
        // 新旧、卖家影响），所以它只用来决定「收哪些、先问哪一条」，不参与判定。
        const accepted = plan.mode === "exact_product"
          ? result.listings.slice(0, EXACT_PRODUCT_CANDIDATES_PER_QUERY)
          : result.listings;
        accepted.forEach((listing, index) => addCandidate(candidates, listing, {
          variantId: variant.id,
          query: variant.query,
          kind: variant.kind,
          lane: "source_native",
          upstreamRank: index + 1,
          weight: variant.weight,
          liveVerified: true,
        }));
        let objectiveMet = false;
        if (plan.mode === "exact_product" && plan.target) {
          await hydratePromisingCandidates(MANUAL_EXACT_DETAILS_PER_QUERY);
          // OBSERVE → DECIDE → ACT：这一枪已经证明同款时，不再机械执行后续短查询。
          objectiveMet = hasQualifiedExactCandidate(candidates, plan.target, {
            requirePurchasable: availabilityMode === "purchasable" || inStockOnly === true,
          });
        }
        const uniqueNew = [...candidates.keys()].filter((key) => !before.has(key)).length;
        queryCoverage.push({
          queryId: variant.id,
          query: variant.query,
          purpose,
          lane: "source_native",
          pagesFetched: Math.max(1, result.requestEvidence?.pagesFetched ?? 1),
          rawReturned: result.listings.length,
          acceptedListings: accepted.length,
          uniqueNewListings: uniqueNew,
          duplicateListings: Math.max(0, accepted.length - uniqueNew),
          hardConflictCount: plan.target
            ? result.listings.filter((listing) => assessProductMatch(listing, plan.target!).conflicts.length > 0).length
            : 0,
          ...(typeof result.totalAvailable === "number" ? { reportedTotal: result.totalAvailable } : {}),
          // 来源自报总数在这几个站点上并不可靠，保留原值并标记，不据此推导「还剩几件」。
          reportedTotalReliability: typeof result.totalAvailable === "number" ? "reported" : "unknown",
          nextCursor: result.nextCursor ?? null,
          stopReason: objectiveMet ? "objective_met" : result.nextCursor ? "budget" : "exhausted",
          coverage: result.nextCursor ? "partial" : "exhausted",
          latencyMs: Date.now() - variantStartedAt,
        });
        if (objectiveMet) break;
      } catch (error) {
        lastVariantError = error;
        queryCoverage.push({
          ...skippedQueryCoverage(variant, "source_error"),
          latencyMs: Date.now() - variantStartedAt,
        });
        variantWarnings.push(`查询「${variant.query}」未完成：${error instanceof Error ? error.message.slice(0, 220) : "来源失败"}`);
      }
    }

    if (plan.mode === "exact_product" && plan.target
      && !hasQualifiedExactCandidate(candidates, plan.target)) {
      await hydratePromisingCandidates(MANUAL_EXACT_DETAIL_LIMIT);
    }

    if (plan.mode === "exact_product" && plan.target && !pageToken
      && !hasQualifiedExactCandidate(candidates, plan.target)) {
      const terms = historicalRecallTerms(plan);
      if (terms.length > 0) {
        try {
          const historicalRows = await findHistoricalProductListings(
            env.ANALYTICS_DB.connectionString,
            { sourceIds: [sourceId], terms, limit: MANUAL_EXACT_HISTORY_CANDIDATE_LIMIT },
          );
          const historicalListings = historicalRows
            .map(historicalListingCandidate)
            .filter((listing): listing is NormalizedListing => Boolean(listing));
          const corpus = buildProductMatchCorpus(
            [...candidates.values()].map((value) => value.listing).concat(historicalListings),
            plan.target,
          );
          let acceptedHistorical = 0;
          historicalListings.forEach((listing, index) => {
            const hit: CandidateHit = {
              variantId: "historical-index",
              query: terms.join(" | ").slice(0, 300),
              kind: "original",
              lane: "historical_index",
              upstreamRank: index + 1,
              weight: 0.72,
              liveVerified: false,
            };
            const assessment = assessProductMatch(listing, plan.target!, [hit], corpus);
            // 和实时链路用同一条规则：程序已经判完的才丢，标题缩写导致落到
            // irrelevant 的历史候选不丢——它们正是来补来源索引已经遗失的那一批。
            if (productMatchDeterministicallySettled(assessment)) return;
            addCandidate(candidates, listing, hit);
            acceptedHistorical += 1;
          });
          if (acceptedHistorical > 0) {
            variantWarnings.push(`本地历史索引补回 ${acceptedHistorical} 个身份相关候选；只有重新打开详情成功的候选才算本轮实时观测。`);
            await hydratePromisingCandidates(
              MANUAL_EXACT_TOTAL_DETAIL_LIMIT,
              MANUAL_EXACT_TOTAL_DETAIL_LIMIT,
            );
          }
        } catch (error) {
          variantWarnings.push(`本地历史索引暂不可用：${error instanceof Error ? error.message.slice(0, 180) : "查询失败"}`);
        }
      }
    }

    if (successfulResults.length === 0 && candidates.size === 0 && lastVariantError) throw lastVariantError;
    const primaryResult = successfulResults[0];
    if (!primaryResult && lastVariantError) await recordPreviewFailure(env, sourceId, lastVariantError);
    else if (primaryResult) await recordPreviewSuccess(env, sourceId, primaryResult);

    const preliminaryEvidence = candidateEvidence(candidates, plan);
    const listings = filterListings(
      [...candidates.values()].map((candidate) => candidate.listing),
      supportedPostSearchFilters(sourceId, filters),
    ).sort((left, right) => plan.mode === "exact_product"
      ? compareProductSearchCandidates(preliminaryEvidence[left.sourceItemId], preliminaryEvidence[right.sourceItemId])
      : 0);
    const includedIds = new Set(listings.map((listing) => listing.sourceItemId));
    const includedKeys = new Set(listings.map((listing) => candidateKey(listing.sourceId, listing.sourceItemId)));
    const evidence = Object.fromEntries(Object.entries(preliminaryEvidence).filter(([sourceItemId]) => includedIds.has(sourceItemId)));
    const fieldCoverage = listingFieldCoverage(listings, adapter.fieldProfile);
    const warnings = [...new Set([
      ...successfulResults.flatMap((result) => result.warnings),
      ...variantWarnings,
      ...plan.warnings,
    ])];
    if (state.health_status === "degraded" || state.health_status === "blocked") warnings.unshift("该来源近期不稳定，本次结果已单独验证");
    if (listings.length === 0) warnings.push("该来源成功响应但没有匹配商品；可尝试更短的日文关键词或放宽筛选");
    if (availabilityMode === "sold_out" && primaryResult?.coverage === "rolling_window") {
      warnings.push("历史查询覆盖煤炉当前可检索的滚动窗口；可继续加载下一页，较早成交记录可能只保留详情页");
    }
    if (sourceId === "mercari_jp" && availabilityMode === "all" && primaryResult?.coverage === "rolling_window") {
      warnings.push("结果来自煤炉当前关键词索引的在售与已售滚动窗口；不代表平台完整成交库存");
    }
    const requestEvidence = mergedRequestEvidence(successfulResults, listings.length);
    // 按计划排序取第一条还有下一页的查询。没有就是没有，不借别的查询的游标充数。
    const resumable = queryCoverage.find((entry) => entry.nextCursor);
    const resumableCursor = resumable?.nextCursor
      ? `${resumable.queryId}::${resumable.nextCursor}`
      : undefined;
    return {
      group: {
        sourceId,
        status: successfulResults.length === 0 && lastVariantError ? "failed" : listings.length ? "success" : "empty",
        listings,
        coverage: primaryResult?.coverage ?? "unknown",
        parserVersion: primaryResult?.parserVersion ?? adapter.parserVersion,
        warnings,
        ...(lastVariantError && successfulResults.length === 0 ? { error: lastVariantError instanceof Error ? lastVariantError.message : "实时来源查询失败" } : {}),
        requestRoute: primaryResult?.requestRoute ?? route,
        routeOutcome: primaryResult?.routeOutcome,
        fieldCoverage,
        durationMs: Date.now() - startedAt,
        // 给前端的「下一页」句柄自带它属于哪条查询，不再把某一条查询的游标
        // 当成整个来源的游标用（计划 §6.6）。
        nextCursor: resumableCursor,
        totalAvailable: primaryResult?.totalAvailable,
        requestEvidence,
        candidateEvidence: evidence,
        ...(queryCoverage.length > 0 ? { queryCoverage } : {}),
        ...(plan.mode === "exact_product"
          ? {
            detailLedger: {
              requested: detailRequests,
              resolved: Object.fromEntries([...detailResolved].filter(([key]) => includedKeys.has(key))),
              failed: Object.fromEntries([...detailFailed].filter(([key]) => includedKeys.has(key))),
              unsupported: Object.fromEntries([...detailUnsupported].filter(([key]) => includedKeys.has(key))),
            },
          }
          : {}),
      },
      captures: await captureRecorder.flush(),
    };
  } catch (error) {
    const diagnostics = await recordPreviewFailure(env, sourceId, error);
    return {
      group: {
        sourceId,
        status: "failed",
        listings: [],
        error: error instanceof Error ? error.message : "搜索失败",
        requestRoute: route,
        durationMs: Date.now() - startedAt,
        ...diagnostics,
      },
      captures: await captureRecorder.flush(),
    };
  }
}

async function runPreviewSources(
  env: Env,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
): Promise<PreviewSourceRun[]> {
  const runs = new Map<SourceId, PreviewSourceRun>();
  const rakutenSources = input.sources.filter(isRakutenSource);
  const parallelSources = input.sources.filter((sourceId) => !isRakutenSource(sourceId));
  await Promise.all(parallelSources.map(async (sourceId) => {
    runs.set(sourceId, await runPreviewSource(env, input, plan, sourceId));
  }));
  // Rakuten sources share a strict public API quota, so keep these steps ordered.
  for (const sourceId of rakutenSources) runs.set(sourceId, await runPreviewSource(env, input, plan, sourceId));
  return input.sources.map((sourceId) => runs.get(sourceId)!).filter(Boolean);
}

async function createProductSearchWorkflowTask(
  env: Env,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
): Promise<Response> {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO product_search_workflow_tasks(
      id,status,input_json,plan_json,created_at,updated_at
     ) VALUES(?,'queued',?,?,?,?)`,
  ).bind(taskId, JSON.stringify(input), JSON.stringify(plan), now, now).run();
  try {
    await env.PRODUCT_SEARCH_WORKFLOW.create({ id: taskId, params: { taskId } satisfies ProductSearchWorkflowParams });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "workflow_create_failed";
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks
       SET status='failed',last_error=?,updated_at=?,completed_at=? WHERE id=?`,
    ).bind(message, now, now, taskId).run();
    return Response.json({ error: "search_workflow_unavailable", message }, { status: 503 });
  }
  return Response.json({ jobId: taskId, status: "queued", plan }, { status: 202 });
}

function parseWorkflowTask(row: ProductSearchWorkflowTaskRow): {
  input: SearchPreviewInput;
  plan: ProductSearchPlan;
} {
  const input = searchPreviewSchema.parse(JSON.parse(row.input_json));
  const plan = JSON.parse(row.plan_json) as ProductSearchPlan;
  if (plan.version !== PRODUCT_SEARCH_PLAN_VERSION || !Array.isArray(plan.variants)) {
    throw new Error("product_search_plan_version_mismatch");
  }
  return { input, plan };
}

async function persistedWorkflowSourceResult(
  env: Env,
  taskId: string,
  sourceId: SourceId,
): Promise<{ sourceId: SourceId; status: PreviewGroupStatus; resultCount: number } | undefined> {
  const row = await env.DB.prepare(
    `SELECT group_json FROM product_search_workflow_results WHERE task_id=? AND source_id=?`,
  ).bind(taskId, sourceId).first<{ group_json: string }>();
  if (!row) return undefined;
  const group = JSON.parse(row.group_json) as PreviewHistoryGroup;
  return { sourceId, status: group.status, resultCount: group.listings.length };
}

async function executeWorkflowSource(
  env: Env,
  taskId: string,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
  sourceId: SourceId,
): Promise<{ sourceId: SourceId; status: PreviewGroupStatus; resultCount: number }> {
  const existing = await persistedWorkflowSourceResult(env, taskId, sourceId);
  if (existing) return existing;
  const run = await runPreviewSource(env, input, plan, sourceId);
  const completedAt = new Date().toISOString();
  // Keep the raw response journal and its normalized derivative atomic. The
  // statements are ordered raw-first, so a retried step can never publish a
  // group produced from a response that was not retained as evidence.
  await env.DB.batch([
    ...sourceCaptureStatements(env.DB, taskId, run.captures),
    env.DB.prepare(
      `INSERT INTO product_search_workflow_results(task_id,source_id,group_json,completed_at)
       VALUES(?,?,?,?)
       ON CONFLICT DO NOTHING`,
    ).bind(taskId, sourceId, JSON.stringify(run.group), completedAt),
  ]);
  return { sourceId, status: run.group.status, resultCount: run.group.listings.length };
}

async function prepareProductSearchAiReview(
  env: Env,
  taskId: string,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
): Promise<{ jobId: string | null; candidates: number; degraded: boolean }> {
  const state = await env.DB.prepare(
    `SELECT ai_job_id,ai_manifest_json,ai_error,ai_prepared_at
     FROM product_search_workflow_tasks WHERE id=?`,
  ).bind(taskId).first<Pick<ProductSearchWorkflowTaskRow, "ai_job_id" | "ai_manifest_json" | "ai_error" | "ai_prepared_at">>();
  if (!state) throw new Error("product_search_task_not_found");
  if (state.ai_prepared_at) {
    const manifest = state.ai_manifest_json
      ? JSON.parse(state.ai_manifest_json) as ProductSearchAiManifest
      : undefined;
    return {
      jobId: state.ai_job_id,
      candidates: manifest?.queuedCandidates ?? 0,
      degraded: Boolean(state.ai_error),
    };
  }
  if (plan.mode === "exact_product" && !plan.target) {
    return { jobId: null, candidates: 0, degraded: false };
  }

  const rows = await env.DB.prepare(
    `SELECT source_id,group_json FROM product_search_workflow_results WHERE task_id=?`,
  ).bind(taskId).all<{ source_id: SourceId; group_json: string }>();
  const bySource = new Map(rows.results.map((row) => [row.source_id, JSON.parse(row.group_json) as PreviewHistoryGroup]));
  const groups = input.sources.map((sourceId) => bySource.get(sourceId)).filter((group): group is PreviewHistoryGroup => Boolean(group));
  if (groups.length !== input.sources.length) throw new Error("product_search_source_results_incomplete");

  const seen = new Set<string>();
  const candidates = groups.flatMap((group) => group.listings.flatMap((listing) => {
    const key = candidateKey(listing.sourceId, listing.sourceItemId);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, listing, evidence: group.candidateEvidence?.[listing.sourceItemId] }];
  }));
  const selected = plan.mode === "exact_product"
    ? selectProductSearchAiReviewCandidates(candidates)
    : (() => {
        const sourceQueues = groups.map((group) => group.listings.map((listing) => ({
          key: candidateKey(listing.sourceId, listing.sourceItemId),
          listing,
          evidence: group.candidateEvidence?.[listing.sourceItemId],
        })));
        const balanced: typeof candidates = [];
        for (let ordinal = 0; balanced.length < 24; ordinal += 1) {
          let added = false;
          for (const queue of sourceQueues) {
            const candidate = queue[ordinal];
            if (!candidate || balanced.some((item) => item.key === candidate.key)) continue;
            balanced.push(candidate);
            added = true;
            if (balanced.length >= 24) break;
          }
          if (!added) break;
        }
        return balanced;
      })();
  const directCandidates = plan.mode === "exact_product"
    ? candidates.filter((candidate) => candidate.evidence?.match?.relation === "exact").length
    : 0;
  const deterministicExcludedCandidates = plan.mode === "exact_product"
    ? candidates.filter((candidate) => ["variant", "irrelevant"]
      .includes(candidate.evidence?.match?.relation ?? "uncertain")).length
    : 0;
  const baseManifest = {
    version: PRODUCT_SEARCH_AI_REVIEW_VERSION,
    totalListings: candidates.length,
    directCandidates,
    reviewCandidates: selected.length,
    deterministicExcludedCandidates,
    // 名额用完后还剩多少条没判完。这个数不记，“已完成”就是句空话。
    unreviewedUnresolvedCandidates: plan.mode === "exact_product"
      ? countProductSearchUnreviewedCandidates(candidates, selected)
      : 0,
  } as const;
  const preparedAt = new Date().toISOString();

  try {
    const queued = selected.length > 0
      ? await enqueueProductSearchGeminiJob(env, {
        query: plan.originalQuery,
        ...(plan.target ? { target: plan.target } : {}),
        listings: selected.map((candidate) => candidate.listing),
      })
      : { jobId: null, candidateKeys: [] as string[], skippedItems: 0 };
    const manifest: ProductSearchAiManifest = {
      ...baseManifest,
      queuedCandidates: queued.candidateKeys.length,
      manualOnlyCandidates: Math.max(0, candidates.length - directCandidates - queued.candidateKeys.length),
      skippedInvalidCandidates: queued.skippedItems,
      candidateKeys: queued.candidateKeys,
    };
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks
       SET ai_job_id=?,ai_manifest_json=?,ai_error=NULL,ai_prepared_at=?,updated_at=? WHERE id=?`,
    ).bind(queued.jobId, JSON.stringify(manifest), preparedAt, preparedAt, taskId).run();
    return { jobId: queued.jobId, candidates: queued.candidateKeys.length, degraded: false };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "product_search_ai_enqueue_failed";
    const candidateKeys = selected.map((candidate) => candidate.key);
    const manifest: ProductSearchAiManifest = {
      ...baseManifest,
      queuedCandidates: 0,
      manualOnlyCandidates: Math.max(0, candidates.length - directCandidates),
      skippedInvalidCandidates: 0,
      candidateKeys,
    };
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks
       SET ai_job_id=NULL,ai_manifest_json=?,ai_error=?,ai_prepared_at=?,updated_at=? WHERE id=?`,
    ).bind(JSON.stringify(manifest), message, preparedAt, preparedAt, taskId).run();
    return { jobId: null, candidates: candidateKeys.length, degraded: true };
  }
}

function frozenProductSearchAiResult(
  row: ProductSearchGeminiSettlementRow,
  expectedItems: number,
): Pick<ProductSearchAiManifest, "settledItems" | "settledStates"> {
  try {
    const value = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
    const rawItems = Array.isArray(value.items) ? value.items : [];
    const rawStates = Array.isArray(value.states) ? value.states : [];
    if (rawItems.length !== expectedItems || rawStates.length !== expectedItems) throw new Error("result_count_mismatch");
    const settledItems = rawItems.map((item) => {
      if (item === null) return null;
      const parsed = listingEnrichmentSchema.safeParse(item);
      return parsed.success ? parsed.data : null;
    });
    const settledStates = rawStates.map((state, index) => (
      state === "ready" && settledItems[index] ? "ready" : state === "failed" ? "failed" : "pending"
    ));
    return { settledItems, settledStates };
  } catch {
    return {
      settledItems: Array.from({ length: expectedItems }, () => null),
      settledStates: Array.from({ length: expectedItems }, () => "failed" as const),
    };
  }
}

async function advanceProductSearchAiReview(
  env: Env,
  taskId: string,
  options: AdvanceProductSearchAiReviewOptions = {},
): Promise<ProductSearchAiSettlement> {
  const { timedOut = false, processInline = true } = options;
  const task = await env.DB.prepare(
    `SELECT ai_job_id,ai_manifest_json,ai_error FROM product_search_workflow_tasks WHERE id=?`,
  ).bind(taskId).first<Pick<ProductSearchWorkflowTaskRow, "ai_job_id" | "ai_manifest_json" | "ai_error">>();
  if (!task?.ai_manifest_json) return { terminal: true, status: "not_needed" };
  const manifest = JSON.parse(task.ai_manifest_json) as ProductSearchAiManifest;
  if (manifest.settlementStatus) {
    return { terminal: true, status: manifest.settlementStatus, error: manifest.settlementError };
  }
  const settledAt = new Date().toISOString();
  if (!task.ai_job_id) {
    const status = manifest.queuedCandidates === 0 && !task.ai_error ? "not_needed" : "unavailable";
    const frozen = {
      ...manifest,
      settlementStatus: status,
      settledAt,
      ...(task.ai_error ? { settlementError: task.ai_error } : {}),
    } satisfies ProductSearchAiManifest;
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?`,
    ).bind(JSON.stringify(frozen), settledAt, taskId).run();
    return { terminal: true, status, error: task.ai_error ?? undefined };
  }

  let job = await env.DB.prepare(
    `SELECT id,status,model,prompt_version,result_json,last_error,next_attempt_at
     FROM gemini_jobs WHERE id=? AND kind='listing_enrichment'`,
  ).bind(task.ai_job_id).first<ProductSearchGeminiSettlementRow>();
  if (!job) {
    const error = "ai_review_job_missing";
    const frozen = { ...manifest, settlementStatus: "unavailable", settledAt, settlementError: error } satisfies ProductSearchAiManifest;
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks SET ai_job_id=NULL,ai_manifest_json=?,ai_error=?,updated_at=? WHERE id=?`,
    ).bind(JSON.stringify(frozen), error, settledAt, taskId).run();
    return { terminal: true, status: "unavailable", error };
  }

  const providerWaitActive = job.next_attempt_at !== null && Date.parse(job.next_attempt_at) > Date.now();
  if (processInline
    && !["completed", "partial", "failed"].includes(job.status)
    && !timedOut
    && !providerWaitActive) {
    await processGeminiJob(env as Env & { GEMINI_QUEUE: Queue<GeminiJob> }, job.id);
    job = await env.DB.prepare(
      `SELECT id,status,model,prompt_version,result_json,last_error,next_attempt_at
       FROM gemini_jobs WHERE id=? AND kind='listing_enrichment'`,
    ).bind(task.ai_job_id).first<ProductSearchGeminiSettlementRow>() ?? job;
  }

  if (["completed", "partial", "failed"].includes(job.status)) {
    const result = frozenProductSearchAiResult(job, manifest.queuedCandidates);
    const frozen = {
      ...manifest,
      settlementStatus: job.status as "completed" | "partial" | "failed",
      settledAt,
      settledModel: job.model,
      settledPromptVersion: job.prompt_version,
      ...result,
      ...(job.last_error ? { settlementError: job.last_error } : {}),
    } satisfies ProductSearchAiManifest;
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?`,
    ).bind(JSON.stringify(frozen), settledAt, taskId).run();
    return { terminal: true, status: frozen.settlementStatus, error: job.last_error ?? undefined };
  }

  if (!timedOut) return { terminal: false, status: undefined };
  const error = "ai_review_timeout_after_90_seconds";
  const frozen = {
    ...manifest,
    settlementStatus: "timed_out",
    settledAt,
    settledModel: job.model,
    settledPromptVersion: job.prompt_version,
    settledItems: Array.from({ length: manifest.queuedCandidates }, () => null),
    settledStates: Array.from({ length: manifest.queuedCandidates }, () => "pending" as const),
    settlementError: error,
  } satisfies ProductSearchAiManifest;
  // Detaching the still-running job freezes this search's published decision.
  // The orphan may finish and warm the semantic cache, but it cannot mutate a
  // historical search or product-identity projection later.
  await env.DB.prepare(
    `UPDATE product_search_workflow_tasks SET ai_job_id=NULL,ai_manifest_json=?,ai_error=?,updated_at=? WHERE id=?`,
  ).bind(JSON.stringify(frozen), error, settledAt, taskId).run();
  return { terminal: true, status: "timed_out", error };
}

/**
 * 每轮搜索最多补抓多少条详情用于二次复核。
 *
 * 这是「拿到判断后再决定下一步」的预算，不是采集阶段那份。采集阶段的详情是
 * 盲补（还没问过模型），这一轮是**模型自己说缺什么之后**的定向补齐，命中率更高，
 * 所以值得单独给一份额度。
 */
const MANUAL_EXACT_FOLLOW_UP_DETAIL_LIMIT = 8;

/** 模型说「证据不够」之后，哪些理由码值得花一次详情请求。 */
const FOLLOW_UP_REASON_CODES: ReadonlySet<string> = new Set([
  "candidate_detail_required",
  "identity_evidence_missing",
  "sale_unit_unresolved",
]);

interface EvidenceGapOutcome {
  hydrated: number;
  rereviewKeys: string[];
  unsupported: number;
}

/**
 * 读回本轮已判定的结果，给「模型说不清、但详情可能说得清」的候选补详情。
 *
 * 这是 P2 的闭环那一步（计划 §6.4）：以前一轮搜索只有一次单向的
 * 采集 → 复核 → 结束，模型写下的「缺版本证据」没有任何人接手，那句话就烂在
 * 理由字段里了。现在它变成下一步动作的输入。
 *
 * 三条边界：
 * - 只补**还没抓过详情**、且来源对这条商品支持详情的候选；
 * - 不支持详情的记为覆盖问题（计划 §6.8），不改判身份；
 * - 预算耗尽时剩下的候选保持未决，不因为「没补上」就改判成拒绝。
 */
/**
 * 本轮的处理质量与覆盖（计划 §9.2）。
 *
 * 它回答三个**互相独立**的问题，以前它们被混成一个「任务成功了吗」：
 *
 * - processing：该做的动作做完了没有（模型请求失败、契约错误算没做完）；
 * - coverage：合法查询把来源翻到哪一步了（名额用完、游标还在，就是 partial）；
 * - 各档位计数：确认、有反证的拒绝、未决、未产生有效输出，分别是多少。
 *
 * 没有它，「本次搜索成功」就可以在候选根本没判完的情况下写出来（§9.3）。
 */
interface ProductSearchRunQuality {
  processing: "complete" | "partial" | "failed";
  coverage: "exhausted_queries" | "partial" | "unknown";
  discoveredCount: number;
  confirmedCount: number;
  rejectedWithEvidenceCount: number;
  unresolvedCount: number;
  pendingCount: number;
  invalidOutputCount: number;
  sourceFailures: string[];
  stopReasons: string[];
}

function productSearchRunQuality(
  groups: readonly PreviewHistoryGroup[],
  manifest: ProductSearchAiManifest | undefined,
  plan: ProductSearchPlan,
): ProductSearchRunQuality {
  const outcomes = new Map<string, { output?: Record<string, unknown>; status: ExactIdentityAiItemStatus }>();
  for (const [index, key] of (manifest?.candidateKeys ?? []).entries()) {
    const state = manifest?.settledStates?.[index];
    const item = manifest?.settledItems?.[index] ?? undefined;
    outcomes.set(key, state === "ready" && item
      ? { output: item as unknown as Record<string, unknown>, status: "ready" }
      : { status: state === "failed" ? "contract_error" : "missing" });
  }
  let confirmed = 0;
  let rejected = 0;
  let unresolved = 0;
  let pending = 0;
  let invalid = 0;
  let discovered = 0;
  for (const group of groups) {
    for (const listing of group.listings) {
      discovered += 1;
      if (plan.mode !== "exact_product") continue;
      const match = group.candidateEvidence?.[listing.sourceItemId]?.match;
      if (!match) continue;
      const outcome = outcomes.get(candidateKey(listing.sourceId, listing.sourceItemId));
      const decision = exactProductIdentityDecision({
        relation: match.relation,
        ...(outcome?.output ? { output: outcome.output } : {}),
        match: {
          ...(match.difference ? { difference: match.difference } : {}),
          conflicts: match.conflicts,
          matchedFields: match.matchedFields,
        },
        aiItemStatus: outcome?.status ?? "not_executed",
      });
      if (decision.decision === "confirmed") confirmed += 1;
      else if (decision.decision === "rejected") rejected += 1;
      else {
        unresolved += 1;
        // 未决要分得清「还没轮到」「模型坏了」「看过了但证据不够」——
        // 合成一个模糊的 uncertain 数量是 §13.4 明令禁止的口径。
        if (decision.processingStatus === "failed") invalid += 1;
        else if (decision.reasonCode === "model_not_executed") pending += 1;
      }
    }
  }
  const sourceFailures = groups
    .filter((group) => group.status === "failed" || group.status === "cooldown" || group.status === "disabled")
    .map((group) => `${group.sourceId}:${group.errorCode ?? group.status}`);
  const stopReasons = [...new Set(groups.flatMap((group) => (
    group.queryCoverage ?? []).map((entry) => entry.stopReason)))];
  const unreviewed = manifest?.unreviewedUnresolvedCandidates ?? 0;
  const anyCursorLeft = groups.some((group) => (group.queryCoverage ?? []).some((entry) => entry.nextCursor));
  const anyUnknownCoverage = sourceFailures.length > 0
    || groups.some((group) => (group.queryCoverage ?? []).some((entry) => entry.coverage === "unknown"));
  return {
    // 模型输出无效的条目算没处理完。为了让结果好看把它算成 complete，
    // 正是 f123338 之前那个「AI 失败但任务显示成功」的老毛病。
    processing: invalid > 0 ? "failed" : unreviewed > 0 || pending > 0 ? "partial" : "complete",
    coverage: anyUnknownCoverage ? "unknown" : anyCursorLeft ? "partial" : "exhausted_queries",
    discoveredCount: discovered,
    confirmedCount: confirmed,
    rejectedWithEvidenceCount: rejected,
    unresolvedCount: unresolved,
    pendingCount: pending + unreviewed,
    invalidOutputCount: invalid,
    sourceFailures: sourceFailures.slice(0, 12),
    stopReasons,
  };
}

async function resolveProductSearchEvidenceGaps(
  env: Env,
  taskId: string,
  plan: ProductSearchPlan,
): Promise<EvidenceGapOutcome> {
  if (plan.mode !== "exact_product" || !plan.target) return { hydrated: 0, rereviewKeys: [], unsupported: 0 };
  const manifestRow = await env.DB.prepare(
    "SELECT ai_manifest_json FROM product_search_workflow_tasks WHERE id=?",
  ).bind(taskId).first<{ ai_manifest_json: string | null }>();
  const manifest = manifestRow?.ai_manifest_json
    ? JSON.parse(manifestRow.ai_manifest_json) as ProductSearchAiManifest
    : undefined;
  const outputs = new Map<string, { output?: Record<string, unknown>; status: ExactIdentityAiItemStatus }>();
  for (const [index, key] of (manifest?.candidateKeys ?? []).entries()) {
    const state = manifest?.settledStates?.[index];
    const item = manifest?.settledItems?.[index] ?? undefined;
    outputs.set(key, state === "ready" && item
      ? { output: item as unknown as Record<string, unknown>, status: "ready" }
      : { status: state === "failed" ? "contract_error" : "missing" });
  }

  const rows = await env.DB.prepare(
    "SELECT source_id,group_json FROM product_search_workflow_results WHERE task_id=?",
  ).bind(taskId).all<{ source_id: SourceId; group_json: string }>();

  let hydrated = 0;
  let unsupported = 0;
  const rereviewKeys: string[] = [];
  let budget = MANUAL_EXACT_FOLLOW_UP_DETAIL_LIMIT;

  for (const row of rows.results) {
    if (budget <= 0) break;
    const group = JSON.parse(row.group_json) as PreviewHistoryGroup;
    const adapter = getAdapter(row.source_id);
    if (!adapter?.getItem || !adapter.capabilities.itemLookup) continue;

    const gaps = group.listings.flatMap((listing) => {
      const key = candidateKey(listing.sourceId, listing.sourceItemId);
      const evidence = group.candidateEvidence?.[listing.sourceItemId];
      const match = evidence?.match;
      if (!match) return [];
      const outcome = outputs.get(key);
      const decision = exactProductIdentityDecision({
        relation: match.relation,
        ...(outcome?.output ? { output: outcome.output } : {}),
        match: {
          ...(match.difference ? { difference: match.difference } : {}),
          conflicts: match.conflicts,
          matchedFields: match.matchedFields,
        },
        aiItemStatus: outcome?.status ?? "not_executed",
      });
      if (decision.decision !== "uncertain" || !FOLLOW_UP_REASON_CODES.has(decision.reasonCode)) return [];
      if (listing.rawMetadata?.detailHydrated === true) return [];
      if (adapter.canGetItem?.(listing.canonicalUrl || listing.sourceItemId) === false) {
        unsupported += 1;
        return [];
      }
      return [{ key, listing, evidence }];
    });
    if (gaps.length === 0) continue;
    // 缺口可能有几百条，预算只有几条。用和采集阶段同一套 §7.3 优先级
    // 排序，而不是按存储顺序碰运气。
    const ordered = planCandidateDetailActions(
      gaps.map((gap) => ({
        key: gap.key,
        hits: gap.evidence?.hits ?? [],
        ...(gap.evidence?.match ? { match: gap.evidence.match } : {}),
        availability: gap.listing.availability,
        gap,
      })),
      budget,
    ).map((action) => action.candidate.gap);
    if (ordered.length === 0) continue;

    const captureRecorder = createSourceCaptureRecorder(
      row.source_id,
      isRakutenSource(row.source_id) ? createPacedFetch(fetch) : fetch,
    );
    const rawBrowserFetch = browserFallbackFetch(row.source_id, env);
    const capturedBrowserFetch = rawBrowserFetch ? captureRecorder.wrap(rawBrowserFetch) : undefined;
    const merged = new Map<string, NormalizedListing>();
    for (const gap of ordered) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        const detail = await itemWithConfiguredRoute(
          env,
          adapter,
          gap.listing.canonicalUrl || gap.listing.sourceItemId,
          { fetch: captureRecorder.fetch, secrets: secrets(env) },
          { browserFetch: capturedBrowserFetch },
        );
        merged.set(gap.key, mergeSearchAndDetailListing(gap.listing, detail));
        hydrated += 1;
        rereviewKeys.push(gap.key);
      } catch (error) {
        // 详情抓不到是覆盖问题。这条候选保持未决，不被改判成「不是同款」。
        console.warn(JSON.stringify({
          event: "product_search_follow_up_detail_failed",
          taskId,
          sourceId: row.source_id,
          sourceItemId: gap.listing.sourceItemId,
          error: error instanceof Error ? error.message.slice(0, 180) : "detail_failed",
        }));
      }
    }
    if (merged.size === 0) continue;

    // 详情进来之后必须重算匹配：标题缩写的候选正是靠这一步从 related / irrelevant
    // 升上来的。旧证据原样留在 AI 审计里，这里更新的是当前判定用的那一份。
    const listings = group.listings.map((listing) => (
      merged.get(candidateKey(listing.sourceId, listing.sourceItemId)) ?? listing
    ));
    const corpus = buildProductMatchCorpus(listings, plan.target);
    // 只重算**真的拿到新证据**的那几条。整组重算会因为词频语料变了而
    // 惄惄改掉没被触碰的候选的分数，那是一次没人宣布过的全局重新打分，
    // 判定应该绑定在它当时看到的快照上（计划 §10.6）。
    const refreshedEvidence = { ...group.candidateEvidence };
    for (const listing of listings) {
      if (!merged.has(candidateKey(listing.sourceId, listing.sourceItemId))) continue;
      const hits = group.candidateEvidence?.[listing.sourceItemId]?.hits ?? [];
      refreshedEvidence[listing.sourceItemId] = searchCandidateEvidence(
        hits,
        assessProductMatch(listing, plan.target!, hits, corpus),
      );
    }
    const nextGroup: PreviewHistoryGroup = {
      ...group,
      listings,
      candidateEvidence: refreshedEvidence,
      detailLedger: {
        requested: (group.detailLedger?.requested ?? 0) + merged.size,
        resolved: {
          ...group.detailLedger?.resolved,
          ...Object.fromEntries([...merged.keys()].map((key) => [key, "follow_up_after_review"])),
        },
        failed: group.detailLedger?.failed ?? {},
        unsupported: group.detailLedger?.unsupported ?? {},
      },
    };
    await env.DB.batch([
      ...sourceCaptureStatements(env.DB, taskId, await captureRecorder.flush()),
      env.DB.prepare(
        "UPDATE product_search_workflow_results SET group_json=? WHERE task_id=? AND source_id=?",
      ).bind(JSON.stringify(nextGroup), taskId, row.source_id),
    ]);
  }
  return { hydrated, rereviewKeys, unsupported };
}

/**
 * 补完详情之后的第二轮复核。
 *
 * 结果**合并回同一份 manifest**，而不是另起一套：同一个 candidateKey 已经在
 * 第一轮出现过就原地覆盖，没出现过就追加。这样下游（成员投影、结果页）不需要
 * 知道有几轮，读到的永远是「这条候选目前最好的那个结论」。
 *
 * 覆盖方向只能是新盖旧：第二轮多了详情原文，证据严格更强。第一轮的原始输出仍然
 * 完整留在 gemini_jobs 里，审计不会因为这次覆盖而丢失（计划 §10.6）。
 */
async function runProductSearchFollowUpReview(
  env: Env,
  taskId: string,
  plan: ProductSearchPlan,
  rereviewKeys: readonly string[],
): Promise<{ status: "not_needed" | "completed" | "unavailable"; reviewed: number }> {
  if (plan.mode !== "exact_product" || !plan.target || rereviewKeys.length === 0) {
    return { status: "not_needed", reviewed: 0 };
  }
  const state = await env.DB.prepare(
    "SELECT ai_manifest_json FROM product_search_workflow_tasks WHERE id=?",
  ).bind(taskId).first<{ ai_manifest_json: string | null }>();
  if (!state?.ai_manifest_json) return { status: "not_needed", reviewed: 0 };
  const manifest = JSON.parse(state.ai_manifest_json) as ProductSearchAiManifest;
  if (manifest.followUpStatus) return { status: manifest.followUpStatus, reviewed: manifest.followUpCandidates ?? 0 };

  const rows = await env.DB.prepare(
    "SELECT source_id,group_json FROM product_search_workflow_results WHERE task_id=?",
  ).bind(taskId).all<{ source_id: SourceId; group_json: string }>();
  const wanted = new Set(rereviewKeys);
  const listings = rows.results.flatMap((row) => {
    const group = JSON.parse(row.group_json) as PreviewHistoryGroup;
    return group.listings.filter((listing) => wanted.has(candidateKey(listing.sourceId, listing.sourceItemId)));
  });
  if (listings.length === 0) return { status: "not_needed", reviewed: 0 };

  const settledAt = new Date().toISOString();
  let queued: { jobId: string | null; candidateKeys: string[] };
  try {
    queued = await enqueueProductSearchGeminiJob(env, {
      query: plan.originalQuery,
      target: plan.target,
      listings,
    });
  } catch (error) {
    const frozen: ProductSearchAiManifest = {
      ...manifest,
      followUpStatus: "unavailable",
      followUpCandidates: listings.length,
      followUpError: error instanceof Error ? error.message.slice(0, 300) : "follow_up_enqueue_failed",
    };
    await env.DB.prepare(
      "UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?",
    ).bind(JSON.stringify(frozen), settledAt, taskId).run();
    return { status: "unavailable", reviewed: 0 };
  }
  if (!queued.jobId) return { status: "not_needed", reviewed: 0 };

  // 一次 processGeminiJob 只处理一个 token 预算内的批次，剩下的会重新入队。
  // 这里推到终态为止，但遇到限流退避就停手：阻塞整轮搜索去等限流窗口，
  // 比让这几条候选维持未决更坏。
  let job: ProductSearchGeminiSettlementRow | null = null;
  for (let pass = 0; pass < 4; pass += 1) {
    await processGeminiJob(env as Env & { GEMINI_QUEUE: Queue<GeminiJob> }, queued.jobId);
    job = await env.DB.prepare(
      "SELECT id,status,model,prompt_version,result_json,last_error,next_attempt_at FROM gemini_jobs WHERE id=?",
    ).bind(queued.jobId).first<ProductSearchGeminiSettlementRow>();
    if (!job || ["completed", "partial", "failed"].includes(job.status)) break;
    if (job.next_attempt_at && Date.parse(job.next_attempt_at) > Date.now()) break;
  }
  if (!job || !["completed", "partial", "failed"].includes(job.status)) {
    const frozen: ProductSearchAiManifest = {
      ...manifest,
      followUpJobId: queued.jobId,
      followUpStatus: "unavailable",
      followUpCandidates: queued.candidateKeys.length,
      ...(job?.last_error ? { followUpError: job.last_error } : {}),
    };
    await env.DB.prepare(
      "UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?",
    ).bind(JSON.stringify(frozen), settledAt, taskId).run();
    return { status: "unavailable", reviewed: 0 };
  }

  const settled = frozenProductSearchAiResult(job, queued.candidateKeys.length);
  const candidateKeys = [...(manifest.candidateKeys ?? [])];
  const settledItems = [...(manifest.settledItems ?? [])];
  const settledStates = [...(manifest.settledStates ?? [])];
  let applied = 0;
  queued.candidateKeys.forEach((key, index) => {
    const item = settled.settledItems?.[index] ?? null;
    const itemState = settled.settledStates?.[index] ?? "pending";
    // 第二轮没拿到有效结论时，保留第一轮的结论，不要用一个空结果把它抹掉。
    if (itemState !== "ready" || !item) return;
    const existing = candidateKeys.indexOf(key);
    if (existing >= 0) {
      settledItems[existing] = item;
      settledStates[existing] = "ready";
    } else {
      candidateKeys.push(key);
      settledItems.push(item);
      settledStates.push("ready");
    }
    applied += 1;
  });

  const frozen: ProductSearchAiManifest = {
    ...manifest,
    candidateKeys,
    settledItems,
    settledStates,
    queuedCandidates: candidateKeys.length,
    followUpJobId: queued.jobId,
    followUpStatus: "completed",
    followUpCandidates: queued.candidateKeys.length,
    followUpAppliedCandidates: applied,
    ...(job.last_error ? { followUpError: job.last_error } : {}),
  };
  await env.DB.prepare(
    "UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?",
  ).bind(JSON.stringify(frozen), settledAt, taskId).run();
  return { status: "completed", reviewed: applied };
}

async function finalizeProductSearchWorkflow(
  env: Env,
  taskId: string,
  input: SearchPreviewInput,
  plan: ProductSearchPlan,
): Promise<{ taskId: string; historyId: string; sessionId: string }> {
  const taskState = await env.DB.prepare(
    `SELECT status,history_id,session_id,journal_ready_at FROM product_search_workflow_tasks WHERE id=?`,
  ).bind(taskId).first<{
    status: ProductSearchWorkflowTaskRow["status"];
    history_id: string | null;
    session_id: string | null;
    journal_ready_at: string | null;
  }>();
  if (!taskState) throw new Error("product_search_task_not_found");
  if (taskState.status === "completed" && taskState.history_id && taskState.session_id) {
    return { taskId, historyId: taskState.history_id, sessionId: taskState.session_id };
  }
  const rows = await env.DB.prepare(
    `SELECT source_id,group_json FROM product_search_workflow_results WHERE task_id=?`,
  ).bind(taskId).all<{ source_id: SourceId; group_json: string }>();
  const bySource = new Map(rows.results.map((row) => [row.source_id, JSON.parse(row.group_json) as PreviewHistoryGroup]));
  const groups = input.sources.map((sourceId) => bySource.get(sourceId)).filter((group): group is PreviewHistoryGroup => Boolean(group));
  if (groups.length !== input.sources.length) throw new Error("product_search_source_results_incomplete");

  let history: { historyId: string; sessionId: string; searchedAt: string; analyticsOutboxId: string };
  if (taskState.journal_ready_at && taskState.history_id && taskState.session_id) {
    const outbox = await env.DB.prepare(
      `SELECT id FROM analytics_outbox WHERE kind='preview_search' AND reference_id=?`,
    ).bind(taskState.history_id).first<{ id: string }>();
    if (!outbox) throw new Error("product_search_analytics_outbox_missing");
    history = {
      historyId: taskState.history_id,
      sessionId: taskState.session_id,
      searchedAt: taskState.journal_ready_at,
      analyticsOutboxId: outbox.id,
    };
  } else {
    // A previous attempt may have stopped between statement batches. No
    // analytics message is sent before journal_ready_at is written, so this
    // only removes an incomplete derivative; source captures remain intact.
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM analytics_outbox WHERE kind='preview_search' AND reference_id=?`,
      ).bind(taskId),
      env.DB.prepare(`DELETE FROM search_history WHERE id=?`).bind(taskId),
    ]);
    history = await recordPreviewHistory(env, {
      query: input.query,
      plan,
      sources: input.sources,
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      conditions: input.conditions,
      inStockOnly: input.inStockOnly,
      availabilityMode: input.availabilityMode,
      sourcePageTokens: input.sourcePageTokens,
      searchSessionId: input.searchSessionId,
      historyId: taskId,
    }, groups, []);
    const journalReadyAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE product_search_workflow_tasks
       SET history_id=?,session_id=?,journal_ready_at=?,updated_at=? WHERE id=?`,
    ).bind(history.historyId, history.sessionId, journalReadyAt, journalReadyAt, taskId).run();
  }
  await enqueueAnalyticsOutbox(env, history.analyticsOutboxId);
  const now = new Date().toISOString();
  // 运行质量必须落库，不能只在界面临时算（计划 §9.2）。只在界面算的数字
  // 既不能审计，也不能用来回答“上个月那次搜索到底判完了没有”。
  const finalManifestRow = await env.DB.prepare(
    "SELECT ai_manifest_json FROM product_search_workflow_tasks WHERE id=?",
  ).bind(taskId).first<{ ai_manifest_json: string | null }>();
  const finalManifest = finalManifestRow?.ai_manifest_json
    ? JSON.parse(finalManifestRow.ai_manifest_json) as ProductSearchAiManifest
    : undefined;
  const runQuality = productSearchRunQuality(groups, finalManifest, plan);
  // The workflow row is the immutable owner of the frozen AI review. Keep it
  // for as long as its search history exists so reopening the same snapshot
  // cannot silently fall back to a different provisional decision set.
  await env.DB.prepare(
    `UPDATE product_search_workflow_tasks
     SET status='completed',history_id=?,session_id=?,result_summary_json=?,last_error=NULL,
         updated_at=?,completed_at=? WHERE id=?`,
  ).bind(
    history.historyId,
    history.sessionId,
    JSON.stringify({ ...previewSourceSummary(groups), runQuality }),
    now,
    now,
    taskId,
  ).run();
  return { taskId, historyId: history.historyId, sessionId: history.sessionId };
}

export class ProductSearchWorkflow extends WorkflowEntrypoint<WorkerBindings, ProductSearchWorkflowParams> {
  override async run(event: WorkflowEvent<ProductSearchWorkflowParams>, step: WorkflowStep) {
    // Workflow steps may span minutes. Use the unscoped adapter so no TCP
    // connection is held while a source request or durable step is waiting.
    const env = bindPostgresDatabase(this.env);
    const taskId = event.payload.taskId;
    try {
      const task = await step.do("load search task", async () => {
        const row = await env.DB.prepare(
          `SELECT id,status,input_json,plan_json,history_id,session_id,journal_ready_at,
                  ai_job_id,ai_manifest_json,ai_error,ai_prepared_at
           FROM product_search_workflow_tasks WHERE id=?`,
        ).bind(taskId).first<ProductSearchWorkflowTaskRow>();
        if (!row) throw new Error("product_search_task_not_found");
        return parseWorkflowTask(row);
      });
      await step.do("mark search running", async () => {
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE product_search_workflow_tasks
           SET status=CASE WHEN status='completed' THEN status ELSE 'running' END,
               started_at=COALESCE(started_at,?),attempt_count=attempt_count+1,updated_at=?
           WHERE id=?`,
        ).bind(now, now, taskId).run();
        return { taskId };
      });

      const runSource = (sourceId: SourceId) => step.do(`search source ${sourceId}`, {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => executeWorkflowSource(env, taskId, task.input, task.plan, sourceId));
      const parallelSources = task.input.sources.filter((sourceId) => !isRakutenSource(sourceId));
      const rakutenSources = task.input.sources.filter(isRakutenSource);
      await Promise.all(parallelSources.map(runSource));
      for (const sourceId of rakutenSources) await runSource(sourceId);

      {
        await step.do("prepare bounded Gemini review", {
          retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        }, async () => prepareProductSearchAiReview(env, taskId, task.input, task.plan));

        let aiSettlement: ProductSearchAiSettlement | undefined;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const settlement = await step.do(`advance bounded Gemini review ${attempt + 1}`, {
            retries: { limit: 1, delay: "5 seconds" },
            timeout: "2 minutes",
          }, async () => advanceProductSearchAiReview(env, taskId, {
            // Workflow-origin provider requests are rejected intermittently by
            // Google location checks. Exact search already enqueued this job;
            // let the known-good Gemini queue consumer own provider execution.
            processInline: task.plan.mode !== "exact_product",
          }));
          if (settlement.terminal) {
            aiSettlement = settlement;
            break;
          }
          if (attempt < 9) await step.sleep(`wait for bounded Gemini review ${attempt + 1}`, "10 seconds");
        }
        if (!aiSettlement) {
          aiSettlement = await step.do(
            "freeze timed out Gemini review",
            async () => advanceProductSearchAiReview(env, taskId, { timedOut: true, processInline: false }),
          );
        }
        if (task.plan.mode === "exact_product"
          && aiSettlement.status !== "completed"
          && aiSettlement.status !== "not_needed") {
          const detail = aiSettlement.error ? `：${aiSettlement.error}` : "";
          throw new Error(`精确同款搜索需要完整的 AI 裁决，本次未完成（${aiSettlement.status ?? "unknown"}）${detail}`);
        }
      }

      // 拿到判断之后再决定下一步（计划 §6.4）：模型自己说“缺版本证据”的候选，
      // 先去把详情补上，再问一次。这两步失败不能拖垮整轮搜索：它们只能把未决
      // 变成已决，做不到时候候选维持未决，而不是变成拒绝。
      if (task.plan.mode === "exact_product") {
        const gaps = await step.do("resolve evidence gaps with details", {
          retries: { limit: 1, delay: "5 seconds" },
          timeout: "5 minutes",
        }, async () => resolveProductSearchEvidenceGaps(env, taskId, task.plan));
        if (gaps.rereviewKeys.length > 0) {
          await step.do("review candidates with new detail evidence", {
            retries: { limit: 1, delay: "5 seconds" },
            timeout: "3 minutes",
          }, async () => runProductSearchFollowUpReview(env, taskId, task.plan, gaps.rereviewKeys));
        }
        await step.do("record evidence gap coverage", async () => {
          const row = await env.DB.prepare(
            "SELECT ai_manifest_json FROM product_search_workflow_tasks WHERE id=?",
          ).bind(taskId).first<{ ai_manifest_json: string | null }>();
          if (!row?.ai_manifest_json) return { recorded: false };
          const manifest = JSON.parse(row.ai_manifest_json) as ProductSearchAiManifest;
          const next: ProductSearchAiManifest = {
            ...manifest,
            followUpHydratedCandidates: gaps.hydrated,
            followUpUnsupportedCandidates: gaps.unsupported,
          };
          await env.DB.prepare(
            "UPDATE product_search_workflow_tasks SET ai_manifest_json=?,updated_at=? WHERE id=?",
          ).bind(JSON.stringify(next), new Date().toISOString(), taskId).run();
          return { recorded: true };
        });
      }

      const finalized = await step.do("finalize search", {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      }, async () => finalizeProductSearchWorkflow(env, taskId, task.input, task.plan));
      if (task.plan.mode === "exact_product") {
        await step.do("project stable product identity", {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        }, async () => {
          const projection = await materializeProductIdentityForTask(env, taskId);
          return { productVariantId: projection?.productVariant.id ?? null };
        });
      }
      return finalized;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "product_search_workflow_failed";
      await step.do("mark search failed", async () => {
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE product_search_workflow_tasks
           SET status=CASE WHEN status='completed' THEN status ELSE 'failed' END,
               last_error=CASE WHEN status='completed' THEN last_error ELSE ? END,updated_at=?,
               completed_at=CASE WHEN status='completed' THEN completed_at ELSE ? END WHERE id=?`,
        ).bind(message, now, now, taskId).run();
        return { taskId };
      });
      throw error;
    }
  }
}

async function handleSearchPreview(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = searchPreviewSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const { query, mode, target, searchSessionId, sources, minPrice, maxPrice, conditions, inStockOnly, availabilityMode, sourcePageTokens } = parsed.data;
  const plan = buildProductSearchPlan({
    query,
    mode,
    target,
  });
  if (searchSessionId) {
    const continuationError = await validateSearchContinuation(env, searchSessionId, {
      query,
      plan,
      sources,
      minPrice,
      maxPrice,
      conditions,
      inStockOnly,
      availabilityMode,
    });
    if (continuationError) return Response.json({ error: continuationError }, { status: 409 });
  }
  if (parsed.data.execution === "workflow") return createProductSearchWorkflowTask(env, parsed.data, plan);
  const sourceRuns = await runPreviewSources(env, parsed.data, plan);
  const groups = sourceRuns.map((run) => run.group);
  const captures = sourceRuns.flatMap((run) => run.captures);
  const history = await recordPreviewHistory(env, {
    query,
    plan,
    sources,
    minPrice,
    maxPrice,
    conditions,
    inStockOnly,
    availabilityMode,
    sourcePageTokens,
    searchSessionId,
  }, groups, captures);
  await enqueueAnalyticsOutbox(env, history.analyticsOutboxId);
  return Response.json({
    query,
    plan,
    groups,
    historyId: history.historyId,
    sessionId: history.sessionId,
    searchedAt: history.searchedAt,
  });
}

async function handleListingDetailPreview(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = previewListingDetailSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const { source: sourceId, sourceItemId, targetUrl } = parsed.data;
  const adapter = getAdapter(sourceId);
  const state = await env.DB.prepare(
    "SELECT enabled,health_status,cooldown_until,cooldown_route FROM source_registry WHERE id=?",
  ).bind(sourceId).first<{
    enabled: 0 | 1;
    health_status: string;
    cooldown_until: string | null;
    cooldown_route: SourceRequestRoute | null;
  }>();
  if (!adapter?.getItem || !state || !state.enabled || state.health_status === "disabled" || state.health_status === "broken") {
    return Response.json({ error: "source_unavailable" }, { status: 409 });
  }
  const route = sourceRequestRoute(sourceId, env);
  if (state.cooldown_until && Date.parse(state.cooldown_until) > Date.now()
    && (state.cooldown_route ?? "direct") === route) {
    return Response.json({ error: "source_cooldown", retryAt: state.cooldown_until }, { status: 429 });
  }
  const lookup = sourceId === "rakuten_ichiba" || sourceId === "rakuten_books" ? sourceItemId : targetUrl;
  try {
    const listing = await itemWithConfiguredRoute(env, adapter, lookup, {
      fetch,
      secrets: secrets(env),
      signal: AbortSignal.timeout(25_000),
    }, { browserFetch: browserFallbackFetch(sourceId, env) });
    if (listing.sourceId === "mercari_jp" && listing.availability === "sold_out") {
      const verifiedAt = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO source_history_anchors(
          source_id,source_item_id,title_hint,pinned,first_verified_at,last_verified_at
         ) VALUES(?,?,?,1,?,?)
         ON CONFLICT(source_id,source_item_id) DO UPDATE SET
          title_hint=excluded.title_hint,pinned=1,last_verified_at=excluded.last_verified_at`,
      ).bind(listing.sourceId, listing.sourceItemId, listing.title, verifiedAt, verifiedAt).run();
    }
    await new RadarRepository(env.DB).incrementCounter("detail_calls");
    return Response.json({ listing });
  } catch (error) {
    const adapterError = error instanceof AdapterError ? error : undefined;
    const message = redactSensitiveText(
      error instanceof Error ? error.message.slice(0, 300) : "商品详情读取失败",
    );
    console.error(JSON.stringify({
      event: "listing_detail_preview_failed",
      sourceId,
      sourceItemId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: adapterError?.code ?? "detail_lookup_failed",
      upstreamStatus: adapterError?.status ?? null,
      retryable: adapterError?.retryable ?? false,
      message,
    }));
    return Response.json({
      error: "detail_lookup_failed",
      errorCode: adapterError?.code ?? "detail_lookup_failed",
      message,
    }, { status: adapterError?.status === 429 ? 429 : 502 });
  }
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/internal/operational-db-health") {
      const health = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM source_registry) source_count,
           (SELECT COUNT(*) FROM watch_profiles) watch_profile_count`,
      ).first<{
        source_count: number;
        watch_profile_count: number;
      }>();
      return Response.json({
        ok: true,
        backend: "postgres",
        ...health,
      });
    }
    if (request.method === "GET" && url.pathname === "/internal/source-status") return sourceStatus(env);
    if (request.method === "GET" && url.pathname === "/internal/public-rakuten-preview") return handlePublicRakutenPreview(env);
    if (request.method === "POST" && url.pathname.startsWith("/internal/test-source/")) {
      const sourceId = decodeURIComponent(url.pathname.slice("/internal/test-source/".length)) as SourceId;
      return testSource(sourceId, env);
    }
    if (request.method === "POST" && url.pathname.startsWith("/internal/start-probe/")) {
      const sourceId = decodeURIComponent(url.pathname.slice("/internal/start-probe/".length)) as SourceId;
      if (sourceId === "surugaya") {
        return Response.json({ error: "surugaya_probe_retired", message: "骏河屋由真实采集被动记录健康状态，不再运行独立探针" }, { status: 409 });
      }
      try {
        return Response.json(await new RadarRepository(env.DB).startSourceProbe(sourceId));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "probe_start_failed" }, { status: 409 });
      }
    }
    if (request.method === "POST" && url.pathname.startsWith("/internal/restart-probe-route/")) {
      const sourceId = decodeURIComponent(url.pathname.slice("/internal/restart-probe-route/".length)) as SourceId;
      if (sourceId === "surugaya") {
        return Response.json({ error: "surugaya_probe_retired", message: "骏河屋由真实采集被动记录健康状态，不再运行独立探针" }, { status: 409 });
      }
      try {
        return Response.json(await new RadarRepository(env.DB).restartSourceProbeForRouteChange(sourceId));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "probe_route_restart_failed" }, { status: 409 });
      }
    }
    if (request.method === "POST" && url.pathname === "/internal/search-preview") return handleSearchPreview(request, env);
    if (request.method === "POST" && url.pathname === "/internal/listing-detail-preview") return handleListingDetailPreview(request, env);
    if (request.method === "POST" && url.pathname === "/internal/analytics/ai-enrichments") {
      return aiEnrichmentPersistenceResponse(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/analytics/ai-enrichments/latest") {
      return latestAiEnrichmentResponse(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/product-identities/reproject") {
      const body = await request.json().catch(() => ({})) as { taskIds?: unknown };
      const taskIds = Array.isArray(body.taskIds)
        ? body.taskIds.filter((value): value is string => typeof value === "string")
        : [];
      if (taskIds.length === 0) return Response.json({ error: "taskIds_required" }, { status: 400 });
      return Response.json(await reprojectProductIdentities(env, taskIds));
    }
    if (request.method === "POST" && url.pathname === "/internal/product-identities/backfill") {
      const limit = Number(url.searchParams.get("limit") ?? 30);
      return Response.json(await backfillProductIdentityProjections(env, limit));
    }
    if (request.method === "POST" && url.pathname === "/internal/ai/jobs/listing") {
      return listingGeminiJobResponse(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/internal/ai/jobs/listing/")) {
      return listingGeminiJobResponse(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/ai/jobs/search-overview") {
      return searchOverviewGeminiJobResponse(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/internal/ai/jobs/search-overview/")) {
      return searchOverviewGeminiJobResponse(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/ai/jobs/product-target") {
      return productTargetGeminiJobResponse(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/internal/ai/jobs/product-target/")) {
      return productTargetGeminiJobResponse(request, env);
    }
    if (request.method === "POST" && url.pathname === "/internal/qualify-p0") {
      const result = await runP0Qualification(env, "admin");
      return result ? Response.json(result) : Response.json({ error: "qualification_already_running" }, { status: 409 });
    }
    if (request.method === "POST" && url.pathname.startsWith("/internal/run/")) {
      const bindingId = decodeURIComponent(url.pathname.slice("/internal/run/".length));
      const queuedAt = new Date().toISOString();
      // 手动触发只拿得到 bindingId，来源未知：走串行队列。手动运行本来就零星，
      // 排在乐天后面几秒，好过让一次手动点击绕过某个来源的节拍保护。
      await monitorQueueFor(env, null).send({
        type: "run_binding",
        idempotencyKey: `run_binding:${bindingId}:manual:${queuedAt}`,
        bindingId,
        trigger: "manual",
        queuedAt,
      } satisfies MonitorJob);
      return Response.json({ queued: true }, { status: 202 });
    }
  return Response.json({ service: "jp-goods-radar-collector", status: "ok" });
}

class NonRetryableQueueError extends Error {
  override readonly name = "NonRetryableQueueError";
}

function safeQueueError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

function queueRetryDelay(attempts: number, requestedDelay?: number): number {
  const exponential = 60 * (2 ** Math.max(0, Math.min(5, attempts - 1)));
  const selected = requestedDelay === undefined ? exponential : requestedDelay;
  return Math.max(1, Math.min(1_800, Math.ceil(selected)));
}

function sourceQueueForDeadLetter(queueName: string): string {
  if (queueName === "jp-goods-radar-dlq") return "jp-goods-radar-jobs";
  if (queueName === "jp-goods-radar-gemini-dlq") return "jp-goods-radar-gemini";
  return queueName.replace(/-dlq$/u, "");
}

function deadLetterQueueForSource(queueName: string): string {
  if (queueName === "jp-goods-radar-jobs") return "jp-goods-radar-dlq";
  // 串行队列刻意共用监控 DLQ：死信处理逻辑完全相同，多开一条队列只是多一处
  // 要创建、要监控、要清理的东西。代价是 sourceQueueForDeadLetter 会把这条
  // 死信的来源标成 jp-goods-radar-jobs——只影响记账标签，不影响恢复。
  if (queueName === "jp-goods-radar-jobs-serial") return "jp-goods-radar-dlq";
  if (queueName === "jp-goods-radar-gemini") return "jp-goods-radar-gemini-dlq";
  return `${queueName}-dlq`;
}

function queueMessageIdentity(
  body: MonitorJob | GeminiJob,
  messageId: string,
): { idempotencyKey: string; messageType: string } {
  if (body.idempotencyKey?.trim()) {
    return { idempotencyKey: body.idempotencyKey.trim(), messageType: body.type };
  }
  switch (body.type) {
    case "run_binding":
      return {
        idempotencyKey: `run_binding:${body.bindingId}:${body.trigger}:${body.queuedAt}`,
        messageType: body.type,
      };
    case "run_tracked_listing":
      return {
        idempotencyKey: `run_tracked_listing:${body.bindingId}:${body.listingId}:${body.trigger}:${body.queuedAt}`,
        messageType: body.type,
      };
    case "confirm_price_drop":
      return {
        idempotencyKey: `confirm_price_drop:${body.bindingId}:${body.listingId}:${body.candidateNewPrice}`,
        messageType: body.type,
      };
    case "ingest_analytics":
      return { idempotencyKey: `ingest_analytics:${body.outboxId}`, messageType: body.type };
    case "finalize_keyword_digest":
      return {
        idempotencyKey: `${body.digestKey}:${body.finalizeAttempt}`,
        messageType: body.type,
      };
    case "gemini_job":
      return {
        idempotencyKey: `gemini_job:${body.jobId}:${body.queuedAt}`,
        messageType: body.type,
      };
    default: {
      const unreachable: never = body;
      return { idempotencyKey: `unknown:${messageId}`, messageType: String(unreachable) };
    }
  }
}

async function terminalizeDeadLetterJob(
  env: Env,
  body: MonitorJob | GeminiJob,
  deadLetterQueueName: string,
): Promise<void> {
  if (body.type === "ingest_analytics") {
    await markAnalyticsOutboxDeadLettered(env, body.outboxId, deadLetterQueueName);
  } else if (body.type === "gemini_job") {
    await markGeminiJobDeadLettered(env, body.jobId, deadLetterQueueName);
  }
}

async function handleQueue(
  batch: MessageBatch<MonitorJob | GeminiJob>,
  env: Env,
): Promise<void> {
  const repository = new RadarRepository(env.DB);
  if (batch.queue.endsWith("-dlq")) {
    // A DLQ is only durable if its consumer commits the body before acking it.
    for (const message of batch.messages) {
      const sourceQueue = sourceQueueForDeadLetter(batch.queue);
      const identity = queueMessageIdentity(message.body, message.id);
      try {
        await repository.deadLetterQueueMessage({
          queueName: sourceQueue,
          deadLetterQueueName: batch.queue,
          idempotencyKey: identity.idempotencyKey,
          messageId: message.id,
          messageType: identity.messageType,
          body: message.body,
          deliveryAttempt: message.attempts,
          error: "cloudflare_queue_retries_exhausted",
        });
        await terminalizeDeadLetterJob(env, message.body, batch.queue);
        console.error(JSON.stringify({
          event: "dead_letter_persisted",
          queue: batch.queue,
          sourceQueue,
          messageType: identity.messageType,
          idempotencyKey: identity.idempotencyKey,
          attempts: message.attempts,
        }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: "dead_letter_persistence_failed",
          queue: batch.queue,
          messageType: identity.messageType,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: safeQueueError(error),
        }));
        message.retry({ delaySeconds: queueRetryDelay(message.attempts) });
      }
    }
    return;
  }

  for (const message of batch.messages) {
    const identity = queueMessageIdentity(message.body, message.id);
    let claim: Awaited<ReturnType<RadarRepository["claimQueueMessage"]>>;
    try {
      claim = await repository.claimQueueMessage({
        queueName: batch.queue,
        idempotencyKey: identity.idempotencyKey,
        messageId: message.id,
        messageType: identity.messageType,
        deliveryAttempt: message.attempts,
        processingLeaseCutoff: new Date(Date.now() - 8 * 60_000).toISOString(),
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: "queue_idempotency_claim_failed",
        queue: batch.queue,
        messageType: identity.messageType,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: safeQueueError(error),
      }));
      message.retry({ delaySeconds: queueRetryDelay(message.attempts) });
      continue;
    }

    if (claim === "completed" || claim === "dead_lettered") {
      message.ack();
      continue;
    }
    if (claim === "busy") {
      // Wait past the processing lease. This handles concurrent duplicate
      // delivery without acknowledging a message whose first worker may die.
      message.retry({ delaySeconds: 300 });
      continue;
    }

    try {
      if (batch.queue === "jp-goods-radar-gemini") {
        if (message.body.type !== "gemini_job") throw new NonRetryableQueueError("queue_message_routed_to_wrong_consumer");
        const result = await processGeminiJob(env, message.body.jobId);
        if (result.deliverPendingEmails) await deliverPendingNotifications(env, repository);
      } else {
        if (message.body.type === "gemini_job") throw new NonRetryableQueueError("queue_message_routed_to_wrong_consumer");
        switch (message.body.type) {
          case "confirm_price_drop":
            await confirmPriceDrop(env, message.body);
            break;
          case "ingest_analytics":
            await ingestAnalyticsOutbox(env, message.body);
            break;
          case "finalize_keyword_digest":
            await finalizeKeywordDigest(env, message.body);
            break;
          case "run_binding":
            await runBinding(env, message.body);
            break;
          case "run_tracked_listing":
            await runTrackedListing(env, message.body);
            break;
          default: {
            const unreachable: never = message.body;
            throw new NonRetryableQueueError(`unknown_queue_job:${String(unreachable)}`);
          }
        }
      }
      await repository.completeQueueMessage(batch.queue, identity.idempotencyKey);
      message.ack();
    } catch (error) {
      const retryable = !(error instanceof NonRetryableQueueError)
        && (!(error instanceof AdapterError) || error.retryable);
      try {
        await repository.failQueueMessage(batch.queue, identity.idempotencyKey, error);
        if (!retryable) {
          const deadLetterQueueName = deadLetterQueueForSource(batch.queue);
          await repository.deadLetterQueueMessage({
            queueName: batch.queue,
            deadLetterQueueName,
            idempotencyKey: identity.idempotencyKey,
            messageId: message.id,
            messageType: identity.messageType,
            body: message.body,
            deliveryAttempt: message.attempts,
            error,
          });
          await terminalizeDeadLetterJob(env, message.body, deadLetterQueueName);
        }
      } catch (persistenceError) {
        console.error(JSON.stringify({
          event: "queue_failure_persistence_failed",
          queue: batch.queue,
          messageType: identity.messageType,
          errorName: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
          errorMessage: safeQueueError(persistenceError),
        }));
        message.retry({ delaySeconds: queueRetryDelay(message.attempts) });
        continue;
      }
      console.warn(JSON.stringify({
        event: "queue_consumer_failed",
        queue: batch.queue,
        messageType: identity.messageType,
        attempts: message.attempts,
        retryable,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: safeQueueError(error),
      }));
      if (!retryable) {
        message.ack();
      } else {
        const requestedDelay = error instanceof AdapterError ? error.retryAfterSeconds : undefined;
        message.retry({ delaySeconds: queueRetryDelay(message.attempts, requestedDelay) });
      }
    }
  }
}

export default {
  async fetch(request, bindings): Promise<Response> {
    try {
      return await withPostgresDatabase(bindings, (env) => handleFetch(request, env));
    } catch (error) {
      if (new URL(request.url).pathname === "/internal/operational-db-health") {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({
          ok: false,
          backend: "postgres",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: message
            .replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgresql://[redacted]@")
            .slice(0, 500),
        }, { status: 503 });
      }
      throw error;
    }
  },
  async scheduled(controller, bindings, ctx): Promise<void> {
    // waitUntil 不带 catch 时，handleScheduled 的拒绝会变成无处可查的未处理拒绝。
    ctx.waitUntil(withPostgresDatabase(
      bindings,
      (env) => handleScheduled(env, new Date(controller.scheduledTime).toISOString()),
    ).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "scheduled_handler_failed",
        error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
      }));
    }));
  },
  async queue(batch, bindings): Promise<void> {
    return withPostgresDatabase(bindings, (env) => handleQueue(batch, env));
  },
} satisfies ExportedHandler<WorkerBindings, MonitorJob | GeminiJob>;
