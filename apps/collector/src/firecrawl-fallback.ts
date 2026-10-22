import { AdapterError } from "@jpgr/adapters";
import { RadarRepository, type ManagedApiBillingUsage } from "@jpgr/db";
import type { AdapterContext } from "@jpgr/core";

const PROVIDER = "firecrawl";
const FIRECRAWL_ORIGIN = "https://api.firecrawl.dev";
const SCRAPE_PATH = "/v2/scrape";
const CREDIT_USAGE_PATH = "/v2/team/credit-usage";
const RESPONSE_LIMIT_BYTES = 3_000_000;
const TARGET_HTML_LIMIT_BYTES = 2_000_000;
const FIRECRAWL_MAX_AGE_MS = 5 * 60_000;

export const FIRECRAWL_RUNTIME_BUDGET = 900;
export const FIRECRAWL_DAILY_BUDGET = Math.floor(FIRECRAWL_RUNTIME_BUDGET / 30);
export const FIRECRAWL_WARNING_THRESHOLD = 700;
export const FIRECRAWL_EMERGENCY_RESERVE = 100;

type FirecrawlEnv = Env & { FIRECRAWL_API_KEY?: string };

type FirecrawlCreditUsage = {
  remainingCredits: number;
  planCredits: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
};

export type FirecrawlFetchStats = {
  requestCount: number;
  localRuntimeCalls: number;
  localDailyRuntimeCalls: number;
  providerRemainingBefore: number | null;
  providerPlanCredits: number | null;
  cacheStates: Array<"hit" | "miss" | "unknown">;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function validIsoTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function safeMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 400) : undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel("firecrawl_response_too_large").catch(() => undefined);
    throw new AdapterError("Firecrawl 响应超过 3 MB 安全上限", "firecrawl_response_too_large", response.status, false);
  }
  if (!response.body) {
    throw new AdapterError("Firecrawl 响应正文为空", "firecrawl_empty_response", response.status, response.status >= 500);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("firecrawl_response_too_large");
        throw new AdapterError("Firecrawl 响应超过 3 MB 安全上限", "firecrawl_response_too_large", response.status, false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } catch {
    throw new AdapterError("Firecrawl 返回了非 JSON 响应", "firecrawl_invalid_json", response.status, response.status >= 500);
  }
}

function isAllowedSurugayaUrl(url: URL): boolean {
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && !url.hash
    && url.hostname === "www.suruga-ya.jp"
    && (url.pathname === "/search"
      || /^\/product\/detail\/[A-Za-z0-9_-]{1,100}\/?$/u.test(url.pathname));
}

function authorization(apiKey: string): HeadersInit {
  return { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}

async function fetchCreditUsage(apiKey: string, fetcher: typeof globalThis.fetch): Promise<FirecrawlCreditUsage> {
  let response: Response;
  try {
    response = await fetcher(new URL(CREDIT_USAGE_PATH, FIRECRAWL_ORIGIN), {
      headers: authorization(apiKey),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
    throw new AdapterError(
      timeout ? "Firecrawl 额度检查超时" : "Firecrawl 额度检查网络失败",
      timeout ? "firecrawl_usage_timeout" : "firecrawl_usage_network_error",
      undefined,
      true,
    );
  }
  const body = record(await boundedJson(response));
  const data = record(body.data);
  if (!response.ok || body.success !== true) {
    const message = safeMessage(body.error) ?? safeMessage(body.message);
    throw new AdapterError(
      `Firecrawl 额度检查失败 (${response.status})${message ? `：${message}` : ""}`,
      response.status === 401 ? "firecrawl_credentials_invalid" : `firecrawl_usage_http_${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  const remainingCredits = finiteNonNegativeInteger(data.remainingCredits);
  const planCredits = finiteNonNegativeInteger(data.planCredits);
  const billingPeriodStart = validIsoTimestamp(data.billingPeriodStart);
  const billingPeriodEnd = validIsoTimestamp(data.billingPeriodEnd);
  if (remainingCredits === undefined || planCredits === undefined || !billingPeriodStart || !billingPeriodEnd
      || Date.parse(billingPeriodEnd) <= Date.parse(billingPeriodStart)) {
    throw new AdapterError("Firecrawl 额度响应结构发生变化", "firecrawl_usage_schema_changed", 502, false);
  }
  return { remainingCredits, planCredits, billingPeriodStart, billingPeriodEnd };
}

function cacheState(metadata: Record<string, unknown>): "hit" | "miss" | "unknown" {
  return metadata.cacheState === "hit" || metadata.cacheState === "miss" ? metadata.cacheState : "unknown";
}

function targetStatus(metadata: Record<string, unknown>): number {
  const status = finiteNonNegativeInteger(metadata.statusCode);
  return status !== undefined && status >= 100 && status <= 599 ? status : 200;
}

function normalizedSearch(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function validateSourceUrl(metadata: Record<string, unknown>, requestedUrl: URL): void {
  const value = typeof metadata.sourceURL === "string" ? metadata.sourceURL : undefined;
  if (!value) throw new AdapterError("Firecrawl 响应缺少来源地址", "firecrawl_source_url_missing", 502, false);
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(value);
  } catch {
    throw new AdapterError("Firecrawl 返回了无效来源地址", "firecrawl_invalid_source_url", 502, false);
  }
  const requestedPath = requestedUrl.pathname.replace(/\/$/u, "");
  const sourcePath = sourceUrl.pathname.replace(/\/$/u, "");
  if (!isAllowedSurugayaUrl(sourceUrl)
      || sourcePath !== requestedPath
      || normalizedSearch(sourceUrl) !== normalizedSearch(requestedUrl)) {
    throw new AdapterError("Firecrawl 响应来源不属于所请求的骏河屋公开页面", "firecrawl_source_url_rejected", 502, false);
  }
}

export function firecrawlFallbackConfigured(env: Env): boolean {
  return Boolean((env as FirecrawlEnv).FIRECRAWL_API_KEY?.trim());
}

export async function latestFirecrawlLocalUsage(env: Env): Promise<ManagedApiBillingUsage | null> {
  return new RadarRepository(env.DB).latestManagedApiBillingUsage(PROVIDER);
}

export function createFirecrawlSurugayaFetch(
  env: Env,
  providerFetcher: AdapterContext["fetch"],
  controlFetcher: typeof globalThis.fetch = fetch,
  parentSignal?: AbortSignal,
): { fetch: AdapterContext["fetch"]; stats: FirecrawlFetchStats } {
  const apiKey = (env as FirecrawlEnv).FIRECRAWL_API_KEY?.trim();
  if (!apiKey) throw new AdapterError("Firecrawl 骏河屋兜底未配置", "firecrawl_not_configured");
  const repository = new RadarRepository(env.DB);
  const stats: FirecrawlFetchStats = {
    requestCount: 0,
    localRuntimeCalls: 0,
    localDailyRuntimeCalls: 0,
    providerRemainingBefore: null,
    providerPlanCredits: null,
    cacheStates: [],
  };
  let creditUsagePromise: Promise<FirecrawlCreditUsage> | undefined;
  const usage = async () => {
    creditUsagePromise ??= fetchCreditUsage(apiKey, controlFetcher);
    const value = await creditUsagePromise;
    stats.providerRemainingBefore ??= value.remainingCredits;
    stats.providerPlanCredits ??= value.planCredits;
    return value;
  };

  const firecrawlFetch: AdapterContext["fetch"] = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET" || request.body || !isAllowedSurugayaUrl(url)) {
      throw new AdapterError("Firecrawl 只允许固定骏河屋搜索页或商品详情页 GET 请求", "firecrawl_url_rejected", 400, false);
    }
    if (request.signal.aborted) {
      throw new AdapterError("Firecrawl 请求已取消", "firecrawl_aborted", undefined, true);
    }

    const currentUsage = await usage();
    if (currentUsage.remainingCredits - stats.requestCount <= FIRECRAWL_EMERGENCY_RESERVE) {
      throw new AdapterError(
        `Firecrawl 余额已进入 ${FIRECRAWL_EMERGENCY_RESERVE} credits 保留区`,
        "firecrawl_provider_reserve_reached",
        429,
        false,
      );
    }
    const reserved = await repository.reserveManagedApiBillingCall({
      provider: PROVIDER,
      periodStartedAt: currentUsage.billingPeriodStart,
      periodEndsAt: currentUsage.billingPeriodEnd,
      runtimeBudget: FIRECRAWL_RUNTIME_BUDGET,
      emergencyReserve: FIRECRAWL_EMERGENCY_RESERVE,
      dailyBudget: FIRECRAWL_DAILY_BUDGET,
    });
    if (!reserved) {
      throw new AdapterError(
        `Firecrawl JST 单日 ${FIRECRAWL_DAILY_BUDGET} 次或本账期 ${FIRECRAWL_RUNTIME_BUDGET} 次自动调用预算已用尽`,
        "firecrawl_runtime_budget_exhausted",
        429,
        false,
      );
    }
    stats.localRuntimeCalls = reserved.runtimeCalls;
    stats.localDailyRuntimeCalls = reserved.dailyRuntimeCalls;
    // 计"已尝试"而不是"已成功"：配额账本在这一步就已扣减，若等到成功后才加，
    // 同一会话内的连续失败会让上面的保留区判断一直按 requestCount=0 放行。
    stats.requestCount += 1;
    if (stats.localRuntimeCalls >= FIRECRAWL_WARNING_THRESHOLD) {
      await repository.recordManagedApiBudgetWarning({
        provider: PROVIDER,
        sourceId: "surugaya",
        runtimeCalls: stats.localRuntimeCalls,
        runtimeBudget: FIRECRAWL_RUNTIME_BUDGET,
        warningThreshold: FIRECRAWL_WARNING_THRESHOLD,
        message: `Firecrawl 本账期自动调用已达 ${stats.localRuntimeCalls}/${FIRECRAWL_RUNTIME_BUDGET} 次；JST 单日上限 ${FIRECRAWL_DAILY_BUDGET} 次`,
      }).catch((error) => {
        console.error(JSON.stringify({
          event: "managed_api_budget_warning_event_failed",
          provider: PROVIDER,
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        }));
      });
    }

    let response: Response;
    try {
      response = await providerFetcher(new URL(SCRAPE_PATH, FIRECRAWL_ORIGIN), {
        method: "POST",
        headers: { ...authorization(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.href,
          formats: ["rawHtml"],
          proxy: "basic",
          location: { country: "JP", languages: ["ja"] },
          maxAge: FIRECRAWL_MAX_AGE_MS,
          storeInCache: true,
        }),
        signal: parentSignal
          ? AbortSignal.any([parentSignal, AbortSignal.timeout(45_000)])
          : AbortSignal.timeout(45_000),
      });
    } catch (error) {
      const timeout = request.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      throw new AdapterError(
        timeout ? "Firecrawl 骏河屋抓取超时" : "Firecrawl 骏河屋抓取网络失败",
        timeout ? "firecrawl_timeout" : "firecrawl_network_error",
        undefined,
        true,
      );
    }
    const body = record(await boundedJson(response));
    const data = record(body.data);
    const metadata = record(data.metadata);
    if (!response.ok || body.success !== true) {
      const message = safeMessage(body.error) ?? safeMessage(body.message);
      const code = response.status === 402
        ? "firecrawl_credits_exhausted"
        : response.status === 401
          ? "firecrawl_credentials_invalid"
          : `firecrawl_http_${response.status}`;
      throw new AdapterError(
        `Firecrawl 骏河屋抓取失败 (${response.status})${message ? `：${message}` : ""}`,
        code,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    const rawHtml = typeof data.rawHtml === "string" ? data.rawHtml : undefined;
    if (!rawHtml) throw new AdapterError("Firecrawl 未返回 rawHtml", "firecrawl_raw_html_missing", 502, false);
    const bytes = new TextEncoder().encode(rawHtml).byteLength;
    if (bytes > TARGET_HTML_LIMIT_BYTES) {
      throw new AdapterError("Firecrawl 骏河屋 HTML 超过 2 MB 安全上限", "firecrawl_target_html_too_large", 502, false);
    }
    validateSourceUrl(metadata, url);
    stats.cacheStates.push(cacheState(metadata));
    if (stats.localRuntimeCalls >= FIRECRAWL_WARNING_THRESHOLD) {
      console.warn(JSON.stringify({
        event: "firecrawl_budget_warning",
        runtimeCalls: stats.localRuntimeCalls,
        runtimeBudget: FIRECRAWL_RUNTIME_BUDGET,
        dailyRuntimeCalls: stats.localDailyRuntimeCalls,
        dailyBudget: FIRECRAWL_DAILY_BUDGET,
        providerRemainingBefore: stats.providerRemainingBefore,
      }));
    }
    return new Response(rawHtml, {
      status: targetStatus(metadata),
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Content-Length": String(bytes),
        "X-JPGR-Firecrawl": "basic-jp",
        "X-JPGR-Firecrawl-Cache": stats.cacheStates.at(-1) ?? "unknown",
      },
    });
  };

  return { fetch: firecrawlFetch, stats };
}
import type { RuntimeEnv as Env } from "./runtime-env";
