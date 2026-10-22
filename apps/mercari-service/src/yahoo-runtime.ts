import { AdapterError } from "../../../packages/adapters/src/http.js";
import { canonicalJson, type SearchRequest, type SearchResult } from "../../../packages/core/src/index.js";
import { createHash } from "node:crypto";

export type YahooCacheStatus = "HIT" | "MISS";

type CacheEntry = {
  expiresAt: number;
  result: SearchResult;
};

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 64;
const MAX_CONCURRENT_OR_QUEUED = 4;
const SESSION_INTERVAL_MS = 2_000;

let gate = Promise.resolve();
let sessionsInFlightOrQueued = 0;
let lastSessionStartedAt = 0;

function cacheTtlMs(): number {
  const configured = Number(process.env.YAHOO_WEB_EXPERIMENTAL_CACHE_TTL_SECONDS);
  const seconds = Number.isFinite(configured) ? Math.max(60, Math.min(Math.round(configured), 300)) : 180;
  return seconds * 1_000;
}

function cacheKey(request: SearchRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function cached(key: string, now = Date.now()): SearchResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function remember(key: string, result: SearchResult): void {
  cache.set(key, { expiresAt: Date.now() + cacheTtlMs(), result });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  if (sessionsInFlightOrQueued >= MAX_CONCURRENT_OR_QUEUED) {
    throw new AdapterError("Yahoo 实验来源本地队列已满，请稍后重试", "yahoo_local_rate_limited", 429, true, 2);
  }
  sessionsInFlightOrQueued += 1;
  const previous = gate;
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await wait(Math.max(0, lastSessionStartedAt + SESSION_INTERVAL_MS - Date.now()));
    lastSessionStartedAt = Date.now();
    return await operation();
  } finally {
    sessionsInFlightOrQueued -= 1;
    release();
  }
}

export async function searchYahooWithCache(
  request: SearchRequest,
  operation: () => Promise<SearchResult>,
): Promise<{ result: SearchResult; cacheStatus: YahooCacheStatus }> {
  const key = cacheKey(request);
  const immediate = cached(key);
  if (immediate) return { result: immediate, cacheStatus: "HIT" };

  return runSerialized(async () => {
    const afterQueue = cached(key);
    if (afterQueue) return { result: afterQueue, cacheStatus: "HIT" };
    const result = await operation();
    remember(key, result);
    return { result, cacheStatus: "MISS" };
  });
}
