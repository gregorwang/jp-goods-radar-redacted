import { containsHtmlChallenge, resolveHtmlRedirect } from "../html.js";
import { AdapterError } from "../http.js";
import { SurugayaBlockedError, SurugayaParserError } from "./errors.js";

const HTML_LIMIT_BYTES = 2_000_000;
const HTML_MIN_BYTES = 8_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding an error response is best-effort and must not hide its status.
  }
}

function isAllowedSurugayaUrl(url: URL): boolean {
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && url.hostname === "www.suruga-ya.jp"
    && (url.pathname === "/search" || /^\/product\/detail\/[A-Za-z0-9_-]+\/?$/.test(url.pathname));
}

function hasExpectedSurugayaContent(url: URL, html: string): boolean {
  if (url.pathname === "/search") {
    const resultContainer = /\bid=["']search_result["']/iu.test(html);
    const productLink = /href=["'][^"']*\/product\/detail\/[A-Za-z0-9_-]+/iu.test(html);
    const verifiedEmpty = /(?:検索結果|該当件数)[\s\S]{0,500}?(?:0|０)\s*件|検索結果は(?:0|０)件/iu.test(html);
    return (resultContainer && productLink) || verifiedEmpty;
  }
  return /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?["']?@type["']?\s*:\s*["']Product["']/iu.test(html)
    || /<h1\b[^>]*>[\s\S]{1,1000}?<\/h1>/iu.test(html);
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

async function boundedText(response: Response): Promise<{ html: string; byteLength: number }> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.body) throw new SurugayaParserError("骏河屋 HTML 响应正文为空", "surugaya_empty_html");
  if (declared > HTML_LIMIT_BYTES) {
    await discardResponseBody(response);
    throw new SurugayaParserError("骏河屋 HTML 超过 2 MB 安全上限", "response_too_large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HTML_LIMIT_BYTES) {
        await reader.cancel("response_too_large");
        throw new SurugayaParserError("骏河屋 HTML 超过 2 MB 安全上限", "response_too_large");
      }
      chunks.push(value);
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
  return { html: new TextDecoder().decode(bytes), byteLength: total };
}

export async function fetchSurugayaHtml(
  fetcher: typeof fetch,
  url: URL,
  signal?: AbortSignal,
): Promise<{ response: Response; html: string; byteLength: number }> {
  if (!isAllowedSurugayaUrl(url)) throw new SurugayaParserError("骏河屋请求地址不在固定来源范围内", "invalid_source_url");
  const timeout = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response | undefined;
  let currentUrl = new URL(url.href);
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      response = await fetcher(currentUrl, {
        signal: combined,
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ja-JP,ja;q=0.9",
          "User-Agent": "JP-Goods-Radar/1.0 (+personal low-frequency monitor)",
        },
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        await discardResponseBody(response);
        throw new SurugayaParserError("骏河屋响应重定向次数异常", "surugaya_unexpected_redirect");
      }
      const redirectedUrl = resolveHtmlRedirect(location, currentUrl);
      if (!isAllowedSurugayaUrl(redirectedUrl)) {
        await discardResponseBody(response);
        throw new SurugayaParserError("骏河屋响应被重定向到非预期页面", "surugaya_unexpected_redirect");
      }
      await discardResponseBody(response);
      currentUrl = redirectedUrl;
      response = undefined;
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (combined.aborted) throw new AdapterError("骏河屋请求超时", "request_timeout", undefined, true);
    throw new AdapterError(error instanceof Error ? `骏河屋网络错误：${error.message}` : "骏河屋网络错误", "network_error", undefined, true);
  }
  if (!response) throw new AdapterError("骏河屋请求没有返回响应", "network_error", undefined, true);
  if (response.status === 403 || response.status === 429) {
    await discardResponseBody(response);
    throw new SurugayaBlockedError(response.status, retryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw new AdapterError(`骏河屋请求失败 (${response.status})`, `http_${response.status}`, response.status, response.status >= 500);
  }
  const finalUrl = new URL(response.url || currentUrl.href);
  if (!isAllowedSurugayaUrl(finalUrl)) {
    await discardResponseBody(response);
    throw new SurugayaParserError("骏河屋响应被重定向到非预期页面", "surugaya_unexpected_redirect");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    await discardResponseBody(response);
    throw new SurugayaParserError("骏河屋返回了非 HTML 内容", "surugaya_non_html");
  }
  // 正文是流式读取的：超时若在读取途中触发，reader.read() 会抛出原始
  // DOMException，必须在这里补齐与 fetch 分支一致的可重试分类。
  let bounded: { html: string; byteLength: number };
  try {
    bounded = await boundedText(response);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (combined.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AdapterError("骏河屋请求超时", "request_timeout", undefined, true);
    }
    throw new AdapterError("骏河屋响应读取失败", "network_error", undefined, true);
  }
  const html = bounded.html;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (bounded.byteLength < HTML_MIN_BYTES) throw new SurugayaParserError("骏河屋页面体积异常偏小", "surugaya_short_html");
  if (containsHtmlChallenge(html) && !hasExpectedSurugayaContent(finalUrl, html)) {
    throw new SurugayaParserError("骏河屋出现 CAPTCHA，来源已暂停", "captcha");
  }
  if (/ログインしてください|login required/i.test(html)) throw new SurugayaParserError("骏河屋页面要求登录", "login_required");
  if (/エラー|error/i.test(title) && !/中古|新品|駿河屋/.test(title)) throw new SurugayaParserError(`骏河屋返回错误页：${title}`);
  return {
    response: new Response(html, { status: response.status, headers: { "Content-Type": contentType ?? "text/html; charset=utf-8" } }),
    html,
    byteLength: bounded.byteLength,
  };
}
