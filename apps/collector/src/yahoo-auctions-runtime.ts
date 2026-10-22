import { AdapterError } from "@jpgr/adapters";
import {
  canonicalJson,
  type AdapterContext,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SourceAdapter,
} from "@jpgr/core";
import { normalizedListingSchema, searchResultSchema } from "@jpgr/validation";

const SOURCE_ID = "yahoo_auctions_jp";
const CACHE_PROVIDER = "yahoo_auctions_public_html_v2";
const FAILURE_WINDOW_MS = 30_000;
const CIRCUIT_DURATION_MS = 60_000;
const MAX_SLOT_WAIT_MS = 60_000;

interface RuntimeState {
  next_request_at: string | null;
  failure_window_started_at: string | null;
  failure_count: number;
  circuit_until: string | null;
}

function configuredInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function runtimeEnabled(env: Env): boolean {
  return String(env.YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED).toLowerCase() === "true";
}

function intervalMs(env: Env): number {
  return configuredInteger(env.YAHOO_AUCTIONS_RATE_INTERVAL_MS, 2_000, 2_000, 10_000);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cacheKey(kind: "search" | "detail", value: unknown): Promise<string> {
  return `${kind}:${await sha256Hex(canonicalJson(value))}`;
}

async function cachedJson(env: Env, key: string): Promise<unknown | undefined> {
  try {
    const row = await env.DB.prepare(
      "SELECT response_json FROM managed_api_cache WHERE provider=? AND cache_key=? AND expires_at>?",
    ).bind(CACHE_PROVIDER, key, new Date().toISOString()).first<{ response_json: string }>();
    if (!row) return undefined;
    return JSON.parse(row.response_json) as unknown;
  } catch {
    console.warn(JSON.stringify({ event: "yahoo_auctions_cache_read_failed", sourceId: SOURCE_ID }));
    return undefined;
  }
}

async function putCachedJson(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const now = new Date();
  try {
    await env.DB.prepare(
      `INSERT INTO managed_api_cache(provider,cache_key,response_json,expires_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(provider,cache_key) DO UPDATE SET
       response_json=excluded.response_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    ).bind(
      CACHE_PROVIDER,
      key,
      JSON.stringify(value),
      new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
    ).run();
  } catch {
    console.warn(JSON.stringify({ event: "yahoo_auctions_cache_write_failed", sourceId: SOURCE_ID }));
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw new AdapterError("Yahoo!オークション请求已取消", "yahoo_auctions_timeout", 504, true);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AdapterError("Yahoo!オークション请求已取消", "yahoo_auctions_timeout", 504, true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensureRuntimeRow(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO experimental_source_runtime(
      source_id,next_request_at,failure_window_started_at,failure_count,circuit_until,updated_at
    ) VALUES(?,NULL,NULL,0,NULL,?)
    ON CONFLICT DO NOTHING`,
  ).bind(SOURCE_ID, new Date().toISOString()).run();
}

async function readRuntimeState(env: Env): Promise<RuntimeState> {
  const state = await env.DB.prepare(
    `SELECT next_request_at,failure_window_started_at,failure_count,circuit_until
     FROM experimental_source_runtime WHERE source_id=?`,
  ).bind(SOURCE_ID).first<RuntimeState>();
  if (!state) throw new AdapterError("Yahoo!オークション运行保护状态不可用", "yahoo_auctions_runtime_unavailable", 503, true, 60);
  return state;
}

async function runtimeState(env: Env): Promise<RuntimeState> {
  await ensureRuntimeRow(env);
  return readRuntimeState(env);
}

function circuitFailure(until: string): AdapterError {
  const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1_000));
  return new AdapterError(
    "Yahoo!オークション实验来源已短时熔断",
    "yahoo_auctions_circuit_open",
    503,
    true,
    retryAfterSeconds,
  );
}

async function acquireRequestSlot(env: Env, signal?: AbortSignal): Promise<void> {
  const spacing = intervalMs(env);
  const waitDeadline = Date.now() + MAX_SLOT_WAIT_MS;
  // 行 bootstrap 只需一次；放在循环里会让每次 CAS 失败都多付一次幂等写入。
  await ensureRuntimeRow(env);
  // 固定 25ms 自旋在最坏情况下是 2400 轮 × 3 次数据库调用。改为指数退避并硬限迭代次数，
  // 争用风暴会落到下面的 local_rate_limited，由 Queue 重试而不是把配额烧在自旋上。
  for (let attempt = 0; attempt < 40 && Date.now() <= waitDeadline; attempt += 1) {
    const state = await readRuntimeState(env);
    const nowMs = Date.now();
    if (state.circuit_until && Date.parse(state.circuit_until) > nowMs) throw circuitFailure(state.circuit_until);
    const parsedNextRequestAt = state.next_request_at ? Date.parse(state.next_request_at) : Number.NaN;
    const slotStartedAtMs = Number.isFinite(parsedNextRequestAt) && parsedNextRequestAt > nowMs
      ? parsedNextRequestAt
      : nowMs;
    const waitMs = slotStartedAtMs - nowMs;
    if (slotStartedAtMs > waitDeadline) break;
    const now = new Date(nowMs).toISOString();
    const next = new Date(slotStartedAtMs + spacing).toISOString();
    const update = await env.DB.prepare(
      `UPDATE experimental_source_runtime SET next_request_at=?,updated_at=?
       WHERE source_id=?
         AND ((next_request_at IS NULL AND CAST(? AS TEXT) IS NULL) OR next_request_at=?)
         AND (circuit_until IS NULL OR circuit_until<=?)`,
    ).bind(next, now, SOURCE_ID, state.next_request_at, state.next_request_at, now).run();
    if ((update.meta.changes ?? 0) > 0) {
      await delay(waitMs, signal);
      const latest = await readRuntimeState(env);
      if (latest.circuit_until && Date.parse(latest.circuit_until) > Date.now()) throw circuitFailure(latest.circuit_until);
      return;
    }
    const backoffMs = Math.min(500, 25 * 2 ** Math.min(attempt, 4));
    await delay(Math.min(backoffMs, Math.max(1, waitDeadline - Date.now())), signal);
  }
  throw new AdapterError(
    "Yahoo!オークション本地低频队列暂时满载，稍后自动重试",
    "yahoo_auctions_local_rate_limited",
    503,
    true,
    Math.ceil(spacing / 1_000),
  );
}

function countsTowardCircuit(error: unknown): boolean {
  if (!(error instanceof AdapterError)) return true;
  if ([
    "yahoo_auctions_experiment_disabled",
    "yahoo_auctions_invalid_request",
    "yahoo_auctions_invalid_item_id",
    "yahoo_auctions_item_not_found",
    "yahoo_auctions_local_rate_limited",
  ].includes(error.code)) return false;
  return error.retryable || error.code === "yahoo_auctions_bad_response";
}

async function recordRuntimeSuccess(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE experimental_source_runtime SET failure_window_started_at=NULL,failure_count=0,circuit_until=NULL,updated_at=?
     WHERE source_id=?`,
  ).bind(new Date().toISOString(), SOURCE_ID).run();
}

async function recordRuntimeFailure(env: Env, error: unknown): Promise<void> {
  if (!countsTowardCircuit(error)) return;
  const state = await runtimeState(env);
  const nowMs = Date.now();
  const windowStartedMs = state.failure_window_started_at ? Date.parse(state.failure_window_started_at) : Number.NaN;
  const withinWindow = Number.isFinite(windowStartedMs) && nowMs - windowStartedMs <= FAILURE_WINDOW_MS;
  const failureCount = withinWindow ? state.failure_count + 1 : 1;
  const windowStartedAt = withinWindow && state.failure_window_started_at
    ? state.failure_window_started_at
    : new Date(nowMs).toISOString();
  const circuitUntil = failureCount >= 5 ? new Date(nowMs + CIRCUIT_DURATION_MS).toISOString() : null;
  await env.DB.prepare(
    `UPDATE experimental_source_runtime SET failure_window_started_at=?,failure_count=?,circuit_until=?,updated_at=?
     WHERE source_id=?`,
  ).bind(windowStartedAt, failureCount, circuitUntil, new Date(nowMs).toISOString(), SOURCE_ID).run();
}

export function yahooAuctionsConfigured(env: Env): boolean {
  return runtimeEnabled(env);
}

export async function searchYahooAuctionsWithRuntime(
  env: Env,
  adapter: SourceAdapter,
  request: SearchRequest,
  context: AdapterContext,
): Promise<SearchResult> {
  if (!runtimeEnabled(env)) return adapter.search(request, context);
  const key = await cacheKey("search", request);
  const cached = searchResultSchema.safeParse(await cachedJson(env, key));
  if (cached.success && cached.data.sourceId === SOURCE_ID) {
    return {
      ...cached.data,
      warnings: [...new Set(["Yahoo!オークション命中短时标准化缓存；观测时间保留为首次取得时间。", ...cached.data.warnings])],
    };
  }
  await acquireRequestSlot(env, context.signal);
  try {
    const result = await adapter.search(request, context);
    await recordRuntimeSuccess(env);
    const ttlSeconds = configuredInteger(env.YAHOO_AUCTIONS_SEARCH_CACHE_SECONDS, 45, 30, 600);
    await putCachedJson(env, key, result, ttlSeconds);
    return result;
  } catch (error) {
    await recordRuntimeFailure(env, error);
    throw error;
  }
}

export async function itemYahooAuctionsWithRuntime(
  env: Env,
  adapter: SourceAdapter,
  urlOrId: string,
  context: AdapterContext,
): Promise<NormalizedListing> {
  if (!adapter.getItem) throw new AdapterError("来源不支持单品查询", "item_lookup_unsupported");
  if (!runtimeEnabled(env)) return adapter.getItem(urlOrId, context);
  const key = await cacheKey("detail", { urlOrId });
  const cached = normalizedListingSchema.safeParse(await cachedJson(env, key));
  if (cached.success && cached.data.sourceId === SOURCE_ID) return cached.data;
  await acquireRequestSlot(env, context.signal);
  try {
    const listing = await adapter.getItem(urlOrId, context);
    await recordRuntimeSuccess(env);
    const ttlSeconds = configuredInteger(env.YAHOO_AUCTIONS_DETAIL_CACHE_SECONDS, 30, 15, 300);
    await putCachedJson(env, key, listing, ttlSeconds);
    return listing;
  } catch (error) {
    await recordRuntimeFailure(env, error);
    throw error;
  }
}
import type { RuntimeEnv as Env } from "./runtime-env";
