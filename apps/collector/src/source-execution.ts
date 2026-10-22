import {
  AdapterError,
  getRakutenIchibaItemFromApi,
  getRakutenIchibaItemFromPage,
} from "@jpgr/adapters";
import {
  type AdapterContext,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SearchRouteOutcome,
  type SourceAdapter,
  type SourceId,
  type SourceRequestRoute,
  type SourceRouteFailure,
  type SourceRouteFailureEvidence,
} from "@jpgr/core";
import { createFirecrawlSurugayaFetch, firecrawlFallbackConfigured } from "./firecrawl-fallback";
import { searchSurugayaDirect } from "./surugaya-direct";
import { itemYahooAuctionsWithRuntime, searchYahooAuctionsWithRuntime } from "./yahoo-auctions-runtime";
import {
  callService,
  descriptor,
  isServiceSource,
  routeFailureEvidence,
  serviceConfig,
  serviceSearch,
  validatedListing,
  type ConfiguredEnv,
  type ServiceSourceId,
} from "./service-client";
import {
  markMercariPrimaryFailed,
  markMercariPrimaryRecovered,
  queueMercariRouteAlert,
  readMercariPrimaryState,
  type MercariPrimaryState,
} from "./mercari-route";
import {
  isSourceRunnerSource,
  isSourceRunnerSearchSource,
  itemWithSourceRunner,
  searchWithSourceRunner,
  sourceRunnerConfigured,
} from "./source-runner-client";

const FIXED_HTML_SOURCE_IDS = ["charaon", "cospa", "animate"] as const satisfies readonly ServiceSourceId[];
type FixedHtmlSourceId = (typeof FIXED_HTML_SOURCE_IDS)[number];
type CloudflareDirectSourceId = "amazon_jp" | "surugaya" | "yahoo_shopping" | "yahoo_fleamarket_jp" | FixedHtmlSourceId;
export type MercariSourceRunnerMode = "off" | "shadow" | "primary";

export function mercariSourceRunnerMode(env: Env): MercariSourceRunnerMode {
  const configured = String((env as ConfiguredEnv).MERCARI_SOURCE_RUNNER_MODE ?? "off").trim().toLowerCase();
  if ((configured === "shadow" || configured === "primary") && sourceRunnerConfigured("mercari_jp", env)) {
    return configured;
  }
  return "off";
}

function isCloudflareDirectSource(sourceId: SourceId): sourceId is CloudflareDirectSourceId {
  return sourceId === "amazon_jp" || sourceId === "surugaya" || sourceId === "yahoo_shopping" || sourceId === "yahoo_fleamarket_jp"
    || (FIXED_HTML_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

export function cloudflareDirectEnabled(sourceId: SourceId, env: Env): boolean {
  if (!isCloudflareDirectSource(sourceId)) return false;
  const configured = env as ConfiguredEnv;
  const value = sourceId === "amazon_jp"
    ? configured.AMAZON_CLOUDFLARE_DIRECT_ENABLED
    : sourceId === "surugaya"
    ? configured.SURUGAYA_CLOUDFLARE_DIRECT_ENABLED
    : sourceId === "yahoo_shopping"
      ? configured.YAHOO_CLOUDFLARE_DIRECT_ENABLED
      : sourceId === "yahoo_fleamarket_jp"
        ? configured.YAHOO_FLEAMARKET_CLOUDFLARE_DIRECT_ENABLED
        : configured.FIXED_HTML_CLOUDFLARE_DIRECT_ENABLED;
  return String(value) === "true";
}

export function sourceServiceFallbackConfigured(sourceId: SourceId, env: Env): boolean {
  return sourceRunnerConfigured(sourceId, env)
    || (isServiceSource(sourceId) && Boolean(serviceConfig(sourceId, env)));
}

/**
 * `mercari_service` is retained as the persisted route name for compatibility
 * with the active Probe schema. It now means the fixed-purpose Vercel Tokyo
 * service, not a Mercari-only proxy.
 */
export function sourceRequestRoute(sourceId: SourceId, env: Env): SourceRequestRoute {
  // Cloudflare 直连一旦为某来源打开，它就是主路径：少一次新加坡 VPS 往返，也不占
  // runner 那条串行队列（雅虎商城一个任务要走完 1→N 页，排在它后面的来源跟着一起等）。
  // 一旦 Cloudflare 出口被上游拉黑，把对应的 *_CLOUDFLARE_DIRECT_ENABLED 置 false 即整源
  // 退回 runner，不需要改代码。
  if (cloudflareDirectEnabled(sourceId, env)) return "direct";
  if (sourceId !== "rakuten_ichiba" && sourceRunnerConfigured(sourceId, env)) return "mercari_service";
  return isServiceSource(sourceId) && serviceConfig(sourceId, env) ? "mercari_service" : "direct";
}

export {
  fixedHtmlServiceConfigured,
  mercariServiceConfigured,
  surugayaServiceConfigured,
  yahooServiceConfigured,
} from "./service-client";
export { SOURCE_RUNNER_SOURCE_IDS, isSourceRunnerSource, sourceRunnerConfigured } from "./source-runner-client";

export type RoutedSearchResult = SearchResult & {
  requestRoute: SourceRequestRoute;
  routeOutcome: SearchRouteOutcome;
  /**
   * 新品窗口的页预算已经用尽，但上游仍有后续结果且收敛条件未满足。
   * 只由 `collectNewListingWindow` 设置：这一轮的覆盖是不完整的。
   */
  windowTruncated?: boolean;
};

export interface SourceRouteSession {
  directFailure?: SourceRouteFailureEvidence;
  /** 煤炉：本次运行读到的主路状态，翻页和详情补抓不再重复查库。 */
  mercariPrimary?: MercariPrimaryState;
  /** 煤炉：本次运行里 Vercel 主路已失败或在冷却中，后续请求直接走 VPS。 */
  mercariServiceFailure?: SourceRouteFailureEvidence;
}

function routeLabel(route: SourceRequestRoute): string {
  if (route === "direct") return "Cloudflare 直连";
  if (route === "mercari_service") return "隔离签名采集服务";
  if (route === "managed_api") return "受管抓取 API 兜底";
  if (route === "browser_run") return "Cloudflare Browser Run 兜底";
  if (route === "source_runner") return "新加坡 VPS 采集服务";
  return route;
}

function sourceLabel(sourceId: SourceId): string {
  if (sourceId === "amazon_jp") return "Amazon Japan";
  if (sourceId === "yahoo_fleamarket_jp") return "Yahoo!フリマ";
  return isServiceSource(sourceId) ? descriptor(sourceId).label : sourceId;
}

function routeFailureWarning(route: SourceRequestRoute, failure: SourceRouteFailureEvidence): string {
  if (failure.code === "source_cooldown") return failure.message;
  const attempts = failure.attempts
    .map((attempt) => `第 ${attempt.attempt} 次：${attempt.message.slice(0, 220)}`)
    .join("；");
  return `${routeLabel(route)}经 ${failure.attempts.length} 次有界尝试仍失败：${attempts}`;
}

function adapterError(error: unknown, label: string, code: string): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError(
    error instanceof Error ? `${label}：${error.message.slice(0, 360)}` : label,
    code,
    undefined,
    true,
  );
}

export class SourceRouteChainError extends AdapterError {
  readonly routeFailures: SourceRouteFailure[];

  constructor(sourceId: CloudflareDirectSourceId | "rakuten_ichiba" | "mercari_jp", failures: SourceRouteFailure[]) {
    const lastFailure = failures.at(-1)?.failure;
    const label = sourceLabel(sourceId);
    const summary = failures
      .map(({ route, failure }) => `${routeLabel(route)}：${failure.message.slice(0, 220)}`)
      .join("；");
    super(
      `${label}全部可用路径均失败：${summary}`,
      sourceId === "yahoo_shopping" ? "yahoo_all_routes_failed" : `${sourceId}_all_routes_failed`,
      lastFailure?.status ?? undefined,
      failures.some(({ failure }) => failure.retryable),
    );
    this.name = "SourceRouteChainError";
    this.routeFailures = failures;
  }
}

export function sourceRouteFailures(error: unknown): readonly SourceRouteFailure[] {
  return error instanceof SourceRouteChainError ? error.routeFailures : [];
}

function primaryResult(result: SearchResult, route: SourceRequestRoute): RoutedSearchResult {
  return {
    ...result,
    requestRoute: route,
    routeOutcome: { kind: "primary_success", route },
  };
}

function directContext(sourceId: CloudflareDirectSourceId, context: AdapterContext): AdapterContext {
  const timeoutMs = sourceId === "amazon_jp" || sourceId === "animate"
    ? 22_000
    : sourceId === "yahoo_shopping"
      ? 18_000
      : 15_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    ...context,
    signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
  };
}

function mercariSearchComparison(primary: SearchResult, runner: SearchResult) {
  const primaryIds = new Set(primary.listings.map((listing) => listing.sourceItemId));
  const runnerIds = new Set(runner.listings.map((listing) => listing.sourceItemId));
  let overlap = 0;
  for (const id of primaryIds) if (runnerIds.has(id)) overlap += 1;
  return {
    primaryCount: primaryIds.size,
    runnerCount: runnerIds.size,
    overlap,
    sameNextCursor: primary.nextCursor === runner.nextCursor,
  };
}

async function searchMercariDuringMigration(
  env: Env,
  request: SearchRequest,
  context: AdapterContext,
): Promise<RoutedSearchResult | undefined> {
  const mode = mercariSourceRunnerMode(env);
  if (mode === "off") return undefined;
  if (mode === "primary") {
    return primaryResult(
      await searchWithSourceRunner(env, "mercari_jp", request, context),
      "mercari_service",
    );
  }

  const [primary, runner] = await Promise.allSettled([
    serviceSearch(env, "mercari_jp", request, context.fetch),
    searchWithSourceRunner(env, "mercari_jp", request, context),
  ]);
  console.info(JSON.stringify({
    event: "mercari_source_runner_shadow",
    primaryOk: primary.status === "fulfilled",
    runnerOk: runner.status === "fulfilled",
    ...(primary.status === "fulfilled" && runner.status === "fulfilled"
      ? mercariSearchComparison(primary.value, runner.value)
      : {}),
    primaryErrorCode: primary.status === "rejected" && primary.reason instanceof AdapterError
      ? primary.reason.code
      : null,
    runnerErrorCode: runner.status === "rejected" && runner.reason instanceof AdapterError
      ? runner.reason.code
      : null,
  }));
  if (primary.status === "fulfilled") return primaryResult(primary.value, "mercari_service");
  if (runner.status === "fulfilled") return primaryResult(runner.value, "mercari_service");
  throw primary.reason;
}

async function itemMercariDuringMigration(
  env: Env,
  urlOrId: string,
  context: AdapterContext,
): Promise<NormalizedListing | undefined> {
  const mode = mercariSourceRunnerMode(env);
  if (mode === "off") return undefined;
  if (mode === "primary") return itemWithSourceRunner(env, "mercari_jp", urlOrId, context);

  const [primary, runner] = await Promise.allSettled([
    callService(env, "mercari_jp", "item", { urlOrId }, context.fetch)
      .then((value) => validatedListing(value, "mercari_jp")),
    itemWithSourceRunner(env, "mercari_jp", urlOrId, context),
  ]);
  console.info(JSON.stringify({
    event: "mercari_source_runner_item_shadow",
    primaryOk: primary.status === "fulfilled",
    runnerOk: runner.status === "fulfilled",
    sameSourceItemId: primary.status === "fulfilled" && runner.status === "fulfilled"
      ? primary.value.sourceItemId === runner.value.sourceItemId
      : null,
    samePrice: primary.status === "fulfilled" && runner.status === "fulfilled"
      ? primary.value.currentPrice === runner.value.currentPrice
      : null,
    sameAvailability: primary.status === "fulfilled" && runner.status === "fulfilled"
      ? primary.value.availability === runner.value.availability
      : null,
    primaryErrorCode: primary.status === "rejected" && primary.reason instanceof AdapterError
      ? primary.reason.code
      : null,
    runnerErrorCode: runner.status === "rejected" && runner.reason instanceof AdapterError
      ? runner.reason.code
      : null,
  }));
  if (primary.status === "fulfilled") return primary.value;
  if (runner.status === "fulfilled") return runner.value;
  throw primary.reason;
}

/**
 * 煤炉换路（2026-10-08）：Vercel 东京主路失败时，换新加坡 VPS 试一次，然后停。
 *
 * 以前煤炉只有 Vercel 一条路，失败就整次失败；每天一跑的档案要等到明天。现在：
 * - 换路的：煤炉 403、Vercel 平台自己拒绝、5xx / 超时 / 网络错误、服务层的各种坏响应。
 * - 不换路的：商品没了（换路也还是没了）、我们自己的请求有错（DPoP / 参数 / 结构变化，换路一样错）、
 *   429（煤炉明说"慢一点"，按它给的时间等，不换 IP 硬闯——服务能力扩张文档第 7 项的规矩）。
 * - 主路在冷却期内（或本次运行里已经失败过）就不再先撞它，直接走 VPS。
 * - 两条都失败抛 SourceRouteChainError，带两条路各自的失败原因。
 *
 * 主路状态与三封提醒在 mercari-route.ts。MERCARI_SOURCE_RUNNER_MODE=primary 时 VPS 是主路、
 * 没有兜底（上面的迁移分支先返回）；shadow 模式同理，那是对账用的双发，不是兜底。
 */
const MERCARI_NO_FALLBACK_CODES = new Set([
  "mercari_item_gone",
  "mercari_invalid_request",
  "mercari_dpop_error",
  "mercari_schema_changed",
  "mercari_rate_limited",
  "item_lookup_unsupported",
  "invalid_request",
]);

function mercariFallbackAvailable(env: Env): boolean {
  return Boolean(serviceConfig("mercari_jp", env)) && sourceRunnerConfigured("mercari_jp", env);
}

function shouldTryMercariFallback(failure: SourceRouteFailureEvidence): boolean {
  if (MERCARI_NO_FALLBACK_CODES.has(failure.code)) return false;
  if (failure.status === 429 || failure.status === 404 || failure.status === 410) return false;
  return failure.status === 403
    || failure.retryable
    || (failure.status ?? 0) >= 500
    || failure.code.startsWith("mercari_service_");
}

/** 备路给出的是业务结论或我们自己的背压，原样交给上层，不算"全线不通"。 */
function mercariFallbackFailurePassesThrough(error: AdapterError): boolean {
  return error.code === "mercari_item_gone" || error.status === 404 || error.status === 410
    || error.code === "queue_full" || error.code === "queue_stopping";
}

async function mercariWithFallback<T>(
  env: Env,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  session: SourceRouteSession | undefined,
): Promise<{ value: T; primaryFailure?: SourceRouteFailureEvidence }> {
  const state = session?.mercariPrimary ?? await readMercariPrimaryState(env);
  if (session) session.mercariPrimary = state;
  let primaryFailure = session?.mercariServiceFailure ?? state.coolingFailure;
  let freshPrimaryFailure = false;
  if (!primaryFailure) {
    try {
      const value = await primary();
      if (state.outageOpen) {
        // 只有真正清掉状态的那一个请求发"已恢复"，并发的其他成功什么都不做。
        state.outageOpen = false;
        if (await markMercariPrimaryRecovered(env)) {
          await queueMercariRouteAlert(env, "primary_recovered", {
            code: "mercari_primary_route_recovered",
            message: "煤炉东京主路（Vercel）重新请求成功，煤炉采集已切回主路。",
          });
        }
      }
      return { value };
    } catch (error) {
      const normalized = adapterError(error, "Mercari Vercel 主路失败", "mercari_service_failed");
      const evidence = routeFailureEvidence(normalized);
      if (!shouldTryMercariFallback(evidence)) throw error;
      primaryFailure = evidence;
      freshPrimaryFailure = true;
    }
  }
  if (session) session.mercariServiceFailure = primaryFailure;
  // 先把主路标成故障，再试备路：这样即使备路也挂了，下一个任务也不会再先去撞主路。
  const marked = freshPrimaryFailure ? await markMercariPrimaryFailed(env, primaryFailure) : undefined;
  if (marked) state.outageOpen = true;
  try {
    const value = await fallback();
    if (marked?.opened) {
      await queueMercariRouteAlert(env, "primary_down", {
        code: primaryFailure.code,
        message: primaryFailure.message,
        cooldownUntil: marked.cooldownUntil,
        routeFailures: [{ route: "mercari_service", failure: primaryFailure }],
      });
    }
    return { value, primaryFailure };
  } catch (error) {
    const normalized = adapterError(error, "Mercari 新加坡 VPS 备路失败", "mercari_source_runner_failed");
    if (mercariFallbackFailurePassesThrough(normalized)) throw normalized;
    const chain = new SourceRouteChainError("mercari_jp", [
      { route: "mercari_service", failure: primaryFailure },
      { route: "source_runner", failure: routeFailureEvidence(normalized) },
    ]);
    await queueMercariRouteAlert(env, "all_down", {
      code: chain.code,
      message: chain.message,
      routeFailures: chain.routeFailures,
    });
    throw chain;
  }
}

function mercariFallbackResult(result: SearchResult, primaryFailure: SourceRouteFailureEvidence): RoutedSearchResult {
  const routeFailures: SourceRouteFailure[] = [{ route: "mercari_service", failure: primaryFailure }];
  return {
    ...result,
    warnings: [routeFailureWarning("mercari_service", primaryFailure), ...result.warnings],
    requestRoute: "source_runner",
    routeOutcome: {
      kind: "fallback_success",
      primaryRoute: "mercari_service",
      fallbackRoute: "source_runner",
      primaryFailure,
      routeFailures,
    },
  };
}

function serviceFallbackResult(
  result: SearchResult,
  failure: SourceRouteFailureEvidence,
  routeFailures: SourceRouteFailure[] = [{ route: "direct", failure }],
): RoutedSearchResult {
  return {
    ...result,
    warnings: [...routeFailures.map(({ route, failure: routeFailure }) => routeFailureWarning(route, routeFailure)), ...result.warnings],
    requestRoute: "mercari_service",
    routeOutcome: {
      kind: "fallback_success",
      primaryRoute: "direct",
      fallbackRoute: "mercari_service",
      primaryFailure: failure,
      routeFailures,
    },
  };
}

function browserFallbackResult(
  result: SearchResult,
  directFailure: SourceRouteFailureEvidence,
  routeFailures: SourceRouteFailure[] = [{ route: "direct", failure: directFailure }],
): RoutedSearchResult {
  return {
    ...result,
    warnings: [...routeFailures.map(({ route, failure }) => routeFailureWarning(route, failure)), ...result.warnings],
    requestRoute: "browser_run",
    routeOutcome: {
      kind: "fallback_success",
      primaryRoute: "direct",
      fallbackRoute: "browser_run",
      primaryFailure: directFailure,
      routeFailures,
    },
  };
}

function firecrawlCacheStatus(states: readonly ("hit" | "miss" | "unknown")[]): "hit" | "miss" | "mixed" | "unknown" {
  const unique = new Set(states);
  if (unique.size === 0 || unique.has("unknown")) return unique.size === 1 ? "unknown" : "mixed";
  if (unique.size > 1) return "mixed";
  return unique.has("hit") ? "hit" : "miss";
}

async function firecrawlSurugayaFallback(
  env: Env,
  adapter: SourceAdapter,
  request: SearchRequest,
  routeFailures: SourceRouteFailure[],
  context: AdapterContext,
): Promise<RoutedSearchResult> {
  const transport = createFirecrawlSurugayaFetch(env, context.fetch, fetch, context.signal);
  const result = await searchSurugayaDirect(adapter, request, {
    fetch: transport.fetch,
    secrets: {},
    signal: context.signal,
  }, {
    enrichSoldOutPrices: false,
    routeWarning: "Firecrawl 日本 Basic 代理按完整关键词读取搜索页；不执行托管商品详情补抓",
  });
  const primary = routeFailures[0]!;
  return {
    ...result,
    warnings: [
      ...routeFailures.map(({ route, failure }) => routeFailureWarning(route, failure)),
      ...result.warnings,
      `Firecrawl 本次消耗 ${transport.stats.requestCount} credits；本账期本地账本累计 ${transport.stats.localRuntimeCalls} 次`,
    ],
    requestRoute: "managed_api",
    routeOutcome: {
      kind: "fallback_success",
      primaryRoute: primary.route === "direct" ? "direct" : "mercari_service",
      fallbackRoute: "managed_api",
      provider: "firecrawl",
      cacheStatus: firecrawlCacheStatus(transport.stats.cacheStates),
      searchQuery: request.query,
      queryNarrowed: false,
      primaryFailure: primary.failure,
      routeFailures,
    },
  };
}

function shouldTrySurugayaFallback(failure: SourceRouteFailureEvidence): boolean {
  return failure.code === "source_cooldown"
    || failure.retryable
    || failure.status === 403
    || failure.status === 429;
}

async function surugayaFallbackAfterDirectFailure(
  env: Env,
  adapter: SourceAdapter,
  request: SearchRequest,
  directFailure: SourceRouteFailureEvidence,
  context: AdapterContext,
  browserFetch: AdapterContext["fetch"] | undefined,
  allowManagedFallback: boolean,
): Promise<RoutedSearchResult> {
  const failures: SourceRouteFailure[] = [{ route: "direct", failure: directFailure }];

  if (allowManagedFallback && firecrawlFallbackConfigured(env)) {
    try {
      return await firecrawlSurugayaFallback(env, adapter, request, failures, context);
    } catch (fallbackError) {
      failures.push({
        route: "managed_api",
        failure: routeFailureEvidence(adapterError(
          fallbackError,
          "骏河屋 Firecrawl 兜底失败",
          "surugaya_firecrawl_failed",
        )),
      });
    }
  }

  if (browserFetch) {
    try {
      const result = await searchSurugayaDirect(adapter, request, directContext("surugaya", {
        fetch: browserFetch,
        secrets: {},
      }));
      return browserFallbackResult(result, directFailure, failures);
    } catch (browserError) {
      failures.push({
        route: "browser_run",
        failure: routeFailureEvidence(adapterError(browserError, "骏河屋 Browser Run 兜底失败", "surugaya_browser_run_failed")),
      });
    }
  }

  if (serviceConfig("surugaya", env)) {
    try {
      return serviceFallbackResult(await serviceSearch(env, "surugaya", request, context.fetch), directFailure, failures);
    } catch (serviceError) {
      const normalizedServiceError = adapterError(
        serviceError,
        "骏河屋 Vercel 兜底失败",
        "surugaya_service_failed",
      );
      failures.push({ route: "mercari_service", failure: routeFailureEvidence(normalizedServiceError) });
    }
  }

  if (failures.length > 1) throw new SourceRouteChainError("surugaya", failures);
  throw new AdapterError(
    directFailure.message,
    directFailure.code,
    directFailure.status ?? undefined,
    directFailure.retryable,
  );
}

export async function searchWithConfiguredRoute(
  env: Env,
  adapter: SourceAdapter,
  request: SearchRequest,
  context: AdapterContext,
  options: {
    allowManagedFallback?: boolean;
    skippedPrimaryFailure?: SourceRouteFailureEvidence;
    browserFetch?: AdapterContext["fetch"];
    routeSession?: SourceRouteSession;
  } = {},
): Promise<RoutedSearchResult> {
  const route = sourceRequestRoute(adapter.id, env);
  if (adapter.id === "mercari_jp") {
    const migrated = await searchMercariDuringMigration(env, request, context);
    if (migrated) return migrated;
    if (mercariFallbackAvailable(env)) {
      const routed = await mercariWithFallback(
        env,
        () => serviceSearch(env, "mercari_jp", request, context.fetch),
        () => searchWithSourceRunner(env, "mercari_jp", request, context),
        options.routeSession,
      );
      return routed.primaryFailure
        ? mercariFallbackResult(routed.value, routed.primaryFailure)
        : primaryResult(routed.value, "mercari_service");
    }
  }
  if (adapter.id !== "mercari_jp" && isSourceRunnerSearchSource(adapter.id) && sourceRunnerConfigured(adapter.id, env)
      && !cloudflareDirectEnabled(adapter.id, env)) {
    const skippedFailure = options.skippedPrimaryFailure;
    if (skippedFailure) {
      throw new AdapterError(
        skippedFailure.message,
        skippedFailure.code,
        skippedFailure.status ?? undefined,
        skippedFailure.retryable,
      );
    }
    return primaryResult(await searchWithSourceRunner(env, adapter.id, request, context), "mercari_service");
  }
  if (adapter.id === "yahoo_auctions_jp") {
    return primaryResult(await searchYahooAuctionsWithRuntime(env, adapter, request, context), route);
  }
  if (adapter.id === "yahoo_fleamarket_jp" || adapter.id === "amazon_jp") {
    const label = sourceLabel(adapter.id);
    let directFailure = options.skippedPrimaryFailure;
    if (!directFailure) {
      try {
        return primaryResult(await adapter.search(request, directContext(adapter.id, context)), "direct");
      } catch (error) {
        directFailure = routeFailureEvidence(adapterError(
          error,
          `${label} Cloudflare 直连失败`,
          `${adapter.id}_direct_failed`,
        ));
      }
    }
    if (!options.browserFetch) {
      throw new AdapterError(
        directFailure.message,
        directFailure.code,
        directFailure.status ?? undefined,
        directFailure.retryable,
      );
    }
    try {
      const browserContext = directContext(adapter.id, { ...context, fetch: options.browserFetch });
      return browserFallbackResult(await adapter.search(request, browserContext), directFailure);
    } catch (browserError) {
      throw new SourceRouteChainError(adapter.id, [
        { route: "direct", failure: directFailure },
        {
          route: "browser_run",
          failure: routeFailureEvidence(adapterError(
            browserError,
            `${label} Browser Run 兜底失败`,
            `${adapter.id}_browser_run_failed`,
          )),
        },
      ]);
    }
  }
  if (!isServiceSource(adapter.id)) {
    return primaryResult(await adapter.search(request, context), route);
  }

  if (isCloudflareDirectSource(adapter.id) && cloudflareDirectEnabled(adapter.id, env)) {
    let directFailure: SourceRouteFailureEvidence;
    const skippedPrimaryFailure = options.skippedPrimaryFailure
      ?? (adapter.id === "surugaya" ? options.routeSession?.directFailure : undefined);
    if (skippedPrimaryFailure) {
      if (adapter.id === "surugaya") {
        const failure = skippedPrimaryFailure;
        if (shouldTrySurugayaFallback(failure)) {
          return surugayaFallbackAfterDirectFailure(
            env,
            adapter,
            request,
            failure,
            context,
            options.browserFetch,
            options.allowManagedFallback === true,
          );
        }
        throw new AdapterError(
          failure.message,
          failure.code,
          failure.status ?? undefined,
          failure.retryable,
        );
      }
      directFailure = skippedPrimaryFailure;
    } else {
      try {
        const direct = directContext(adapter.id, context);
        const result = adapter.id === "surugaya"
          ? await searchSurugayaDirect(adapter, request, direct)
          : await adapter.search(request, direct);
        return primaryResult(result, "direct");
      } catch (error) {
        const normalizedDirectError = adapterError(
          error,
          `${descriptor(adapter.id).label} Cloudflare 直连失败`,
          `${adapter.id}_direct_failed`,
        );
        if (adapter.id === "surugaya") {
          const failure = routeFailureEvidence(normalizedDirectError);
          if (shouldTrySurugayaFallback(failure)) {
            if (options.routeSession) options.routeSession.directFailure = failure;
            return surugayaFallbackAfterDirectFailure(
              env,
              adapter,
              request,
              failure,
              context,
              options.browserFetch,
              options.allowManagedFallback === true,
            );
          }
          throw normalizedDirectError;
        }
        directFailure = routeFailureEvidence(normalizedDirectError);
      }
    }

    if (!serviceConfig(adapter.id, env)) {
      throw new AdapterError(
        `${descriptor(adapter.id).label} Cloudflare 直连失败且 Vercel 兜底未配置：${directFailure.message}`,
        directFailure.code,
        directFailure.status ?? undefined,
        directFailure.retryable,
      );
    }

    try {
      return serviceFallbackResult(await serviceSearch(env, adapter.id, request, context.fetch), directFailure);
    } catch (serviceError) {
      const normalizedServiceError = adapterError(
        serviceError,
        `${descriptor(adapter.id).label} Vercel 兜底失败`,
        `${descriptor(adapter.id).codePrefix}_failed`,
      );
      const failures: SourceRouteFailure[] = [
        { route: "direct", failure: directFailure },
        { route: "mercari_service", failure: routeFailureEvidence(normalizedServiceError) },
      ];
      throw new SourceRouteChainError(adapter.id, failures);
    }
  }

  if (route === "direct") return primaryResult(await adapter.search(request, context), route);
  return primaryResult(await serviceSearch(env, adapter.id, request, context.fetch), route);
}

export async function itemWithConfiguredRoute(
  env: Env,
  adapter: SourceAdapter,
  urlOrId: string,
  context: AdapterContext,
  options: {
    browserFetch?: AdapterContext["fetch"];
    routeSession?: SourceRouteSession;
    preferSourceRunner?: boolean;
    skippedPrimaryFailure?: SourceRouteFailureEvidence;
  } = {},
): Promise<NormalizedListing> {
  if (!adapter.getItem) throw new AdapterError("来源不支持单品查询", "item_lookup_unsupported");
  if (adapter.id === "mercari_jp") {
    const migrated = await itemMercariDuringMigration(env, urlOrId, context);
    if (migrated) return migrated;
    if (mercariFallbackAvailable(env)) {
      return (await mercariWithFallback(
        env,
        async () => validatedListing(await callService(env, "mercari_jp", "item", { urlOrId }, context.fetch), "mercari_jp"),
        () => itemWithSourceRunner(env, "mercari_jp", urlOrId, context),
        options.routeSession,
      )).value;
    }
  }
  if (adapter.id === "rakuten_ichiba") {
    if (options.preferSourceRunner && sourceRunnerConfigured(adapter.id, env)) {
      return itemWithSourceRunner(env, adapter.id, urlOrId, context);
    }
    try {
      return await getRakutenIchibaItemFromApi(urlOrId, context);
    } catch (directError) {
      const normalizedDirectError = adapterError(
        directError,
        "Rakuten Ichiba Cloudflare 直连失败",
        "rakuten_ichiba_direct_failed",
      );
      const canUseInventoryFallback = normalizedDirectError.code === "http_404"
        || (normalizedDirectError.code === "http_400" && /itemCode is not valid/iu.test(normalizedDirectError.message))
        || normalizedDirectError.code === "request_timeout"
        || normalizedDirectError.code === "network_error"
        || normalizedDirectError.code === "http_429"
        || (typeof normalizedDirectError.status === "number" && normalizedDirectError.status >= 500);
      if (!canUseInventoryFallback) throw normalizedDirectError;
      if (!sourceRunnerConfigured(adapter.id, env)) {
        return getRakutenIchibaItemFromPage(urlOrId, context);
      }
      const directFailure = routeFailureEvidence(normalizedDirectError);
      try {
        return await itemWithSourceRunner(env, adapter.id, urlOrId, context);
      } catch (runnerError) {
        throw new SourceRouteChainError(adapter.id, [
          { route: "direct", failure: directFailure },
          {
            route: "mercari_service",
            failure: routeFailureEvidence(adapterError(
              runnerError,
              "Rakuten Ichiba 新加坡采集兜底失败",
              "rakuten_ichiba_source_runner_failed",
            )),
          },
        ]);
      }
    }
  }
  if (adapter.id !== "mercari_jp" && isSourceRunnerSource(adapter.id) && sourceRunnerConfigured(adapter.id, env)
      && !cloudflareDirectEnabled(adapter.id, env)) {
    if (adapter.id === "yahoo_shopping") throw new AdapterError("来源不支持单品查询", "item_lookup_unsupported");
    return itemWithSourceRunner(env, adapter.id, urlOrId, context);
  }
  if (adapter.id === "yahoo_auctions_jp") {
    return itemYahooAuctionsWithRuntime(env, adapter, urlOrId, context);
  }
  if (adapter.id === "yahoo_fleamarket_jp" || adapter.id === "amazon_jp") {
    const label = sourceLabel(adapter.id);
    let failure = options.skippedPrimaryFailure;
    if (!failure) {
      try {
        return await adapter.getItem(urlOrId, directContext(adapter.id, context));
      } catch (directError) {
        failure = routeFailureEvidence(adapterError(
          directError,
          `${label} Cloudflare 直连失败`,
          `${adapter.id}_direct_failed`,
        ));
      }
    }
    if (!options.browserFetch) {
      throw new AdapterError(failure.message, failure.code, failure.status ?? undefined, failure.retryable);
    }
    try {
      return await adapter.getItem(urlOrId, directContext(adapter.id, { ...context, fetch: options.browserFetch }));
    } catch (browserError) {
      throw new SourceRouteChainError(adapter.id, [
        { route: "direct", failure },
        {
          route: "browser_run",
          failure: routeFailureEvidence(adapterError(
            browserError,
            `${label} Browser Run 兜底失败`,
            `${adapter.id}_browser_run_failed`,
          )),
        },
      ]);
    }
  }
  if (isCloudflareDirectSource(adapter.id) && cloudflareDirectEnabled(adapter.id, env)) {
    const rememberedFailure = adapter.id === "surugaya" ? options.routeSession?.directFailure : undefined;
    let normalizedDirectError: AdapterError;
    let directFailure: SourceRouteFailureEvidence;
    if (!rememberedFailure) {
      try {
        return await adapter.getItem(urlOrId, directContext(adapter.id, context));
      } catch (directError) {
        normalizedDirectError = adapterError(directError, `${descriptor(adapter.id).label} Cloudflare 直连失败`, `${adapter.id}_direct_failed`);
        directFailure = routeFailureEvidence(normalizedDirectError);
        if (adapter.id === "surugaya" && shouldTrySurugayaFallback(directFailure) && options.routeSession) {
          options.routeSession.directFailure = directFailure;
        }
      }
    } else {
      directFailure = rememberedFailure;
      normalizedDirectError = new AdapterError(
        directFailure.message,
        directFailure.code,
        directFailure.status ?? undefined,
        directFailure.retryable,
      );
    }
    const failures: SourceRouteFailure[] = [{ route: "direct", failure: directFailure }];
    if (adapter.id === "surugaya" && firecrawlFallbackConfigured(env)) {
      try {
        const transport = createFirecrawlSurugayaFetch(
          env,
          context.fetch,
          fetch,
          context.signal,
        );
        return await adapter.getItem(urlOrId, directContext(adapter.id, {
          ...context,
          fetch: transport.fetch,
          secrets: {},
        }));
      } catch (firecrawlError) {
        failures.push({
          route: "managed_api",
          failure: routeFailureEvidence(adapterError(
            firecrawlError,
            "骏河屋 Firecrawl 商品详情兜底失败",
            "surugaya_firecrawl_item_failed",
          )),
        });
      }
    }
    if (adapter.id === "surugaya" && options.browserFetch) {
      try {
        return await adapter.getItem(urlOrId, directContext(adapter.id, { ...context, fetch: options.browserFetch }));
      } catch (browserError) {
        failures.push({
          route: "browser_run",
          failure: routeFailureEvidence(adapterError(browserError, "骏河屋 Browser Run 兜底失败", "surugaya_browser_run_failed")),
        });
      }
    }
    if (!serviceConfig(adapter.id, env) || !descriptor(adapter.id).itemPath) {
      if (failures.length > 1) throw new SourceRouteChainError(adapter.id, failures);
      throw normalizedDirectError;
    }
    try {
      return validatedListing(await callService(env, adapter.id, "item", { urlOrId }, context.fetch), adapter.id);
    } catch (serviceError) {
      failures.push({ route: "mercari_service", failure: routeFailureEvidence(adapterError(serviceError, `${descriptor(adapter.id).label} Vercel 兜底失败`, `${descriptor(adapter.id).codePrefix}_failed`)) });
      throw new SourceRouteChainError(adapter.id, failures);
    }
  }
  if (!isServiceSource(adapter.id) || sourceRequestRoute(adapter.id, env) === "direct") {
    return adapter.getItem(urlOrId, context);
  }
  return validatedListing(await callService(env, adapter.id, "item", { urlOrId }, context.fetch), adapter.id);
}
import type { RuntimeEnv as Env } from "./runtime-env";
