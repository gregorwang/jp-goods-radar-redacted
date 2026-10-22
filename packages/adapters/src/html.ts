import { AdapterError, ParserStructureError, record } from "./http.js";

export interface HtmlRequestPolicy {
  label: string;
  allowedHosts: readonly string[];
  allowedPath(pathname: string): boolean;
  isLoginPage?(html: string, finalUrl: URL): boolean;
  minBytes?: number;
  maxBytes?: number;
  timeoutMs?: number;
  acceptedStatusCodes?: readonly number[];
}

export interface FetchedHtml {
  html: string;
  finalUrl: URL;
  byteLength: number;
  status: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function isAllowedHtmlUrl(url: URL, policy: HtmlRequestPolicy): boolean {
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && policy.allowedHosts.includes(url.hostname)
    && policy.allowedPath(url.pathname);
}

function decodeUtf8LocationHeader(value: string): string {
  const codePoints = Array.from(value, (character) => character.codePointAt(0) ?? 0);
  if (!codePoints.some((codePoint) => codePoint > 0x7f) || codePoints.some((codePoint) => codePoint > 0xff)) {
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(codePoints));
  } catch {
    return value;
  }
}

export function resolveHtmlRedirect(location: string, currentUrl: URL): URL {
  return new URL(decodeUtf8LocationHeader(location), currentUrl);
}

export function containsHtmlChallenge(html: string): boolean {
  return /(?:class|id)=["'][^"']*(?:g-recaptcha|h-captcha|cf-chl|captcha-container)[^"']*["']|<iframe[^>]+(?:recaptcha|hcaptcha)|ロボットではない|アクセス認証|api-services-support@amazon|Enter the characters you see below|画像に表示されている文字を入力/iu.test(html);
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(Math.ceil(numeric), 24 * 60 * 60);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(0, Math.ceil((parsed - Date.now()) / 1_000)), 24 * 60 * 60);
}

async function cancelHtmlBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation is best effort after a response is no longer usable.
  }
}

function responseCharset(response: Response): string {
  const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1]?.toLowerCase();
  if (!charset) return "utf-8";
  if (["utf-8", "utf8", "euc-jp", "shift_jis", "shift-jis", "sjis", "iso-2022-jp"].includes(charset)) return charset;
  return "utf-8";
}

async function boundedHtml(response: Response, maxBytes: number): Promise<{ html: string; byteLength: number }> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    await cancelHtmlBody(response);
    throw new AdapterError("HTML 响应超过安全上限", "response_too_large");
  }
  if (!response.body) throw new ParserStructureError("HTML 响应正文为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response_too_large");
        throw new AdapterError("HTML 响应超过安全上限", "response_too_large");
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
  return { html: new TextDecoder(responseCharset(response)).decode(bytes), byteLength: total };
}

export async function fetchPublicHtml(
  fetcher: typeof fetch,
  url: URL,
  policy: HtmlRequestPolicy,
  signal?: AbortSignal,
): Promise<FetchedHtml> {
  if (!isAllowedHtmlUrl(url, policy)) {
    throw new AdapterError(`${policy.label} 请求地址不在固定来源范围内`, "invalid_source_url");
  }
  const timeout = AbortSignal.timeout(policy.timeoutMs ?? 15_000);
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
        await cancelHtmlBody(response);
        throw new AdapterError(`${policy.label} 响应重定向次数异常`, "unexpected_redirect");
      }
      const redirectedUrl = resolveHtmlRedirect(location, currentUrl);
      if (!isAllowedHtmlUrl(redirectedUrl, policy)) {
        await cancelHtmlBody(response);
        throw new AdapterError(`${policy.label} 响应被重定向到非预期页面`, "unexpected_redirect");
      }
      await cancelHtmlBody(response);
      currentUrl = redirectedUrl;
      response = undefined;
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (combined.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AdapterError(`${policy.label} 请求超时`, "request_timeout", undefined, true);
    }
    throw new AdapterError(error instanceof Error ? `${policy.label} 网络错误：${error.message}` : `${policy.label} 网络错误`, "network_error", undefined, true);
  }
  if (!response) throw new AdapterError(`${policy.label} 请求没有返回响应`, "network_error", undefined, true);
  if (!response.ok && !policy.acceptedStatusCodes?.includes(response.status)) {
    const failure = new AdapterError(
      `${policy.label} 请求失败 (${response.status})`,
      `http_${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
      response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : undefined,
    );
    await cancelHtmlBody(response);
    throw failure;
  }
  const finalUrl = new URL(response.url || currentUrl.href);
  if (!isAllowedHtmlUrl(finalUrl, policy)) {
    await cancelHtmlBody(response);
    throw new AdapterError(`${policy.label} 响应被重定向到非预期页面`, "unexpected_redirect");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    await cancelHtmlBody(response);
    throw new ParserStructureError(`${policy.label} 返回了非 HTML 内容`);
  }
  // 正文是流式读取的：超时若在读取途中触发，reader.read() 会抛出原始
  // DOMException，必须在这里补齐与 fetch 分支一致的可重试分类。
  let bounded: { html: string; byteLength: number };
  try {
    bounded = await boundedHtml(response, policy.maxBytes ?? 2_000_000);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (combined.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AdapterError(`${policy.label} 请求超时`, "request_timeout", undefined, true);
    }
    throw new AdapterError(`${policy.label} 响应读取失败`, "network_error", undefined, true);
  }
  if (bounded.byteLength < (policy.minBytes ?? 2_000)) {
    throw new AdapterError(`${policy.label} 页面体积异常偏小`, "short_html");
  }
  if (containsHtmlChallenge(bounded.html)) {
    throw new AdapterError(`${policy.label} 出现 CAPTCHA`, "captcha");
  }
  const isLoginPage = policy.isLoginPage
    ? policy.isLoginPage(bounded.html, finalUrl)
    : /ログインしてください|login\s+required/iu.test(bounded.html);
  if (isLoginPage) {
    throw new AdapterError(`${policy.label} 页面要求登录`, "login_required");
  }
  return { html: bounded.html, finalUrl, byteLength: bounded.byteLength, status: response.status };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: "\"",
  apos: "'",
  "#39": "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  yen: "¥",
};

// String.fromCodePoint 对越界码位与代理区会抛 RangeError；实体解码位于所有
// HTML 解析的热路径上，畸形实体只能原样保留，不能让整轮采集失败。
function codePoint(value: number): string | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : undefined;
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, token: string) => {
    const lower = token.toLowerCase();
    if (lower.startsWith("#x")) return codePoint(Number.parseInt(lower.slice(2), 16)) ?? entity;
    if (lower.startsWith("#")) return codePoint(Number.parseInt(lower.slice(1), 10)) ?? entity;
    return NAMED_ENTITIES[lower] ?? entity;
  });
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "))
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

// 价格块常挟带 "2点セット"、"税抜" 之类前缀，直接取第一个数字会把件数当成价格；
// 所以先认 ¥/円 锚定的金额，只有整段都没有货币符号时才退回原来的首个数字。
export function parseYenText(value?: string): number | undefined {
  if (!value) return undefined;
  // 调用方传进来的常常是原始 HTML 片段，而真实 markup 会把标签夹在数字与货币符号之间
  // （Animate 是 `<font class="notranslate">1,430</font>円`）。不先去标签，锚定匹配就永远
  // 落不到这类价格上，只能退回"首个数字获胜"——也就是本函数要修的那个问题本身。
  const text = value.includes("<") ? stripHtml(value) : value;
  const normalized = decodeHtmlEntities(text).normalize("NFKC");
  // 搜索卡片可能展示价格区间 "￥16,900 ～ ￥22,500"：锚定匹配取最左侧金额即区间下限，
  // 不会把区间里的数字拼成一个不存在的价格。
  const anchored = normalized.match(/(?:[¥￥]\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円)/);
  const digits = anchored?.[1] ?? anchored?.[2] ?? normalized.match(/[0-9][0-9,]*/)?.[0];
  if (!digits) return undefined;
  const parsed = Number(digits.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeJapaneseDate(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.normalize("NFKC");
  const day = normalized.match(/(20\d{2})\s*(?:年|[\/-])\s*(\d{1,2})\s*(?:月|[\/-])\s*(\d{1,2})\s*日?/);
  if (day) return `${day[1]}-${day[2]!.padStart(2, "0")}-${day[3]!.padStart(2, "0")}`;
  const month = normalized.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
  return month ? `${month[1]}-${month[2]!.padStart(2, "0")}` : undefined;
}

export function uniqueStrings(values: Iterable<string | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) if (value?.trim()) unique.add(decodeHtmlEntities(value.trim()));
  return [...unique];
}

export function metaContent(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1];
    if (value) return decodeHtmlEntities(value).trim();
  }
  return undefined;
}

export function itempropContent(html: string, itemprop: string): string | undefined {
  const escaped = itemprop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+itemprop=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+itemprop=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1];
    if (value) return decodeHtmlEntities(value).trim();
  }
  return undefined;
}

export function jsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "null");
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0) {
        const current = record(queue.shift());
        if (Object.keys(current).length === 0) continue;
        objects.push(current);
        if (Array.isArray(current["@graph"])) queue.push(...current["@graph"]);
      }
    } catch {
      // Invalid optional JSON-LD falls through to source-specific HTML parsing.
    }
  }
  return objects;
}
