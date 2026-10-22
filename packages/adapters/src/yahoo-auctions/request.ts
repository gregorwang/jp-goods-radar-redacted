import { AdapterError } from "../http.js";
import { fetchPublicHtml, type FetchedHtml, type HtmlRequestPolicy } from "../html.js";
import { YahooAuctionsError } from "./errors.js";

export const YAHOO_AUCTIONS_ORIGIN = "https://auctions.yahoo.co.jp";
export const YAHOO_AUCTIONS_SEARCH_URL = new URL("/search/search", YAHOO_AUCTIONS_ORIGIN);
export const YAHOO_AUCTIONS_CLOSED_SEARCH_URL = new URL("/closedsearch/closedsearch", YAHOO_AUCTIONS_ORIGIN);

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const LOGIN_REQUIRED_PATTERN = /ログインしてください|login\s+required/iu;
const PUBLIC_DETAIL_PATTERN = /"@type"\s*:\s*"Product"|"pageName"\s*:\s*"PRODUCT"/u;

type YahooAuctionsOperation = "search" | "detail";

function yahooAuctionsDetailLoginPage(html: string): boolean {
  if (!LOGIN_REQUIRED_PATTERN.test(html)) return false;
  return !PUBLIC_DETAIL_PATTERN.test(html);
}

const SEARCH_HTML_POLICY: HtmlRequestPolicy = {
  label: "Yahoo!オークション搜索页",
  allowedHosts: ["auctions.yahoo.co.jp"],
  allowedPath: (pathname) => pathname === "/search/search" || pathname === "/closedsearch/closedsearch",
  minBytes: 2_000,
  maxBytes: 2_000_000,
  timeoutMs: 20_000,
  acceptedStatusCodes: [404],
};

const DETAIL_HTML_POLICY: HtmlRequestPolicy = {
  label: "Yahoo!オークション详情页",
  allowedHosts: ["auctions.yahoo.co.jp"],
  allowedPath: (pathname) => /^\/jp\/auction\/[A-Za-z0-9]{8,16}\/?$/u.test(pathname),
  isLoginPage: yahooAuctionsDetailLoginPage,
  minBytes: 2_000,
  maxBytes: 1_000_000,
  timeoutMs: 20_000,
};

function mappedFailure(error: unknown, operation: YahooAuctionsOperation): YahooAuctionsError {
  if (error instanceof YahooAuctionsError) return error;
  if (!(error instanceof AdapterError)) {
    return new YahooAuctionsError("Yahoo!オークション网络请求失败", "yahoo_auctions_network_error", undefined, true);
  }
  if (operation === "detail" && error.status === 404) {
    return new YahooAuctionsError(
      "Yahoo!オークション商品不存在或已不可访问",
      "yahoo_auctions_item_not_found",
      404,
      false,
    );
  }
  if (error.status === 429) {
    return new YahooAuctionsError(
      "Yahoo!オークション请求频率受限",
      "yahoo_auctions_rate_limited",
      429,
      true,
      error.retryAfterSeconds ?? 60,
    );
  }
  if (error.code === "request_timeout") {
    return new YahooAuctionsError("Yahoo!オークション请求已超时", "yahoo_auctions_timeout", 504, true);
  }
  if (error.code === "network_error") {
    return new YahooAuctionsError("Yahoo!オークション网络请求失败", "yahoo_auctions_network_error", undefined, true);
  }
  if (error.status !== undefined) {
    return new YahooAuctionsError(
      `Yahoo!オークション上游暂不可用 (${error.status})`,
      "yahoo_auctions_upstream_unavailable",
      error.status,
      error.retryable,
      error.retryAfterSeconds,
    );
  }
  return new YahooAuctionsError(
    `Yahoo!オークション公开页结构不可用：${error.message}`,
    "yahoo_auctions_bad_response",
    502,
    false,
  );
}

function randomRetryDelayMs(minimumMs: number): number {
  if (minimumMs <= 0) return 0;
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return minimumMs + (random % 501);
}

export async function waitForYahooAuctionsDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal.aborted) {
    throw new YahooAuctionsError("Yahoo!オークション请求已超时", "yahoo_auctions_timeout", 504, true);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new YahooAuctionsError("Yahoo!オークション请求已超时", "yahoo_auctions_timeout", 504, true));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function yahooAuctionsSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export async function fetchYahooAuctionsHtml(
  fetcher: typeof fetch,
  url: URL,
  signal: AbortSignal,
  operation: YahooAuctionsOperation,
  retryDelayMs: number,
): Promise<FetchedHtml> {
  const policy = operation === "search" ? SEARCH_HTML_POLICY : DETAIL_HTML_POLICY;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchPublicHtml(fetcher, url, policy, signal);
    } catch (error) {
      const failure = mappedFailure(error, operation);
      const retryableStatus = failure.status === undefined || RETRYABLE_STATUSES.has(failure.status);
      if (attempt > 0 || signal.aborted || !failure.retryable || !retryableStatus) throw failure;
      const retryAfterMs = failure.retryAfterSeconds === undefined ? 0 : failure.retryAfterSeconds * 1_000;
      const delayMs = Math.max(randomRetryDelayMs(retryDelayMs), retryAfterMs);
      if (delayMs > 4_000) throw failure;
      await waitForYahooAuctionsDelay(delayMs, signal);
    }
  }
  throw new YahooAuctionsError(
    "Yahoo!オークション请求重试状态异常",
    "yahoo_auctions_upstream_unavailable",
    503,
    true,
  );
}
