import type { SearchRequest } from "../../../core/src/index.js";
import { text } from "../http.js";
import { YahooAnonymousCookieJar } from "./cookies.js";
import { YahooExperimentalError } from "./errors.js";

export const YAHOO_SHOPPING_ORIGIN = "https://shopping.yahoo.co.jp";

const YAHOO_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MAX_RESPONSE_BYTES = 2_500_000;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 2;
const SAFE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function safeCategoryId(request: SearchRequest): string {
  const configured = text(request.sourceConfig?.categoryId);
  const categoryId = configured ?? "0";
  if (!/^\d{1,20}$/.test(categoryId)) {
    throw new YahooExperimentalError("Yahoo 类目 ID 必须是纯数字", "yahoo_invalid_request", 400);
  }
  return categoryId;
}

export function buildYahooBootstrapUrl(request: SearchRequest): URL {
  const query = request.query.trim();
  if (!query || query.length > 120) {
    throw new YahooExperimentalError("Yahoo 搜索词长度必须为 1～120 字符", "yahoo_invalid_request", 400);
  }
  const categoryId = safeCategoryId(request);
  const url = new URL(`${YAHOO_SHOPPING_ORIGIN}/search/${encodeURIComponent(query)}/${categoryId}/`);
  url.searchParams.set("prom", "1");
  url.searchParams.set("view", "grid");
  if (request.filters.minPrice !== undefined) url.searchParams.set("pf", String(request.filters.minPrice));
  if (request.filters.maxPrice !== undefined) url.searchParams.set("pt", String(request.filters.maxPrice));
  return url;
}

export function resolveYahooShoppingPageUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value, YAHOO_SHOPPING_ORIGIN);
  } catch {
    throw new YahooExperimentalError("Yahoo 下一页 URL 无法解析", "yahoo_schema_changed", 502);
  }
  if (url.origin !== YAHOO_SHOPPING_ORIGIN
    || url.username
    || url.password
    || url.port
    || !url.pathname.startsWith("/search/")) {
    throw new YahooExperimentalError("Yahoo 下一页 URL 离开固定来源路径", "yahoo_schema_changed", 502);
  }
  return url;
}

async function boundedHtml(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    await cancelBody(response);
    throw new YahooExperimentalError("Yahoo 搜索页返回了非 HTML 内容", "yahoo_schema_changed", 502);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new YahooExperimentalError("Yahoo 响应超过 2.5 MB 安全上限", "yahoo_response_too_large", 502);
  }
  if (!response.body) throw new YahooExperimentalError("Yahoo 响应正文为空", "yahoo_schema_changed", 502);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("yahoo_response_too_large");
        throw new YahooExperimentalError("Yahoo 响应超过 2.5 MB 安全上限", "yahoo_response_too_large", 502);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(Math.ceil(numeric), 24 * 60 * 60);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000)), 24 * 60 * 60);
}

async function cancelBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation is best effort after an unusable response.
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new YahooExperimentalError("Yahoo 请求已超时", "yahoo_timeout", 504, true);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new YahooExperimentalError("Yahoo 请求已超时", "yahoo_timeout", 504, true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function failureForStatus(response: Response): YahooExperimentalError {
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  if (response.status === 403 || response.status === 419) {
    return new YahooExperimentalError("Yahoo 公开搜索页拒绝了匿名请求", "yahoo_page_forbidden", response.status, false, 60);
  }
  if (response.status === 429) {
    return new YahooExperimentalError("Yahoo 请求频率受限", "yahoo_rate_limited", 429, true, retryAfter ?? 60);
  }
  return new YahooExperimentalError(
    `Yahoo 上游请求失败 (${response.status})`,
    "yahoo_upstream_error",
    response.status,
    response.status >= 500,
  );
}

function transportFailure(error: unknown, signal?: AbortSignal): YahooExperimentalError {
  if (error instanceof YahooExperimentalError) return error;
  if (signal?.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
    return new YahooExperimentalError("Yahoo 请求已超时", "yahoo_timeout", 504, true);
  }
  return new YahooExperimentalError("Yahoo 网络请求失败", "yahoo_network_error", undefined, true);
}

export class YahooWebSession {
  readonly #cookies = new YahooAnonymousCookieJar();

  constructor(
    readonly fetcher: typeof fetch,
    readonly signal?: AbortSignal,
  ) {}

  async bootstrap(url: URL): Promise<string> {
    return this.#request(resolveYahooShoppingPageUrl(url));
  }

  async page(nextUrl: string, referer?: URL): Promise<string> {
    return this.#request(resolveYahooShoppingPageUrl(nextUrl), referer);
  }

  async #request(initialUrl: URL, referer?: URL): Promise<string> {
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let requestUrl = new URL(initialUrl.href);
      let redirectCount = 0;
      try {
        while (true) {
          const headers = new Headers({
            "User-Agent": YAHOO_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
          });
          const cookie = this.#cookies.headerValue();
          if (cookie) headers.set("Cookie", cookie);
          if (referer) headers.set("Referer", referer.href);
          const fetcher = this.fetcher;
          const response = await fetcher(requestUrl, {
            method: "GET",
            redirect: "manual",
            headers,
            signal: requestSignal,
          });
          this.#cookies.capture(response.headers);
          if (SAFE_REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get("location");
            await cancelBody(response);
            if (!location || redirectCount >= MAX_REDIRECTS) {
              throw new YahooExperimentalError("Yahoo 返回了意外重定向", "yahoo_unexpected_redirect", 502);
            }
            try {
              requestUrl = resolveYahooShoppingPageUrl(new URL(location, requestUrl));
            } catch {
              throw new YahooExperimentalError("Yahoo 搜索页重定向离开固定来源路径", "yahoo_unexpected_redirect", 502);
            }
            redirectCount += 1;
            continue;
          }
          if (response.ok) return await boundedHtml(response);

          const failure = failureForStatus(response);
          await cancelBody(response);
          if (!failure.retryable || attempt + 1 >= MAX_ATTEMPTS) throw failure;
          if (failure.retryAfterSeconds !== undefined && failure.retryAfterSeconds > 8) throw failure;
          await delay((failure.retryAfterSeconds ?? 2 ** (attempt + 1)) * 1_000, requestSignal);
          break;
        }
      } catch (error) {
        const failure = transportFailure(error, requestSignal);
        if (!failure.retryable || attempt + 1 >= MAX_ATTEMPTS) throw failure;
        await delay(2 ** attempt * 1_000, requestSignal);
      }
    }
    throw new YahooExperimentalError("Yahoo 请求重试状态异常", "yahoo_upstream_error", 502);
  }
}

export async function waitForYahooNextPage(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, signal);
}
