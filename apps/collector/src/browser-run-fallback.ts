import { AdapterError } from "@jpgr/adapters";
import type { AdapterContext, SourceId } from "@jpgr/core";

export const BROWSER_RUN_SOURCE_IDS = ["amazon_jp", "surugaya", "yahoo_fleamarket_jp"] as const satisfies readonly SourceId[];
export type BrowserRunSourceId = (typeof BROWSER_RUN_SOURCE_IDS)[number];

type BrowserRunEnv = Env & {
  BROWSER_RUN_FALLBACK_ENABLED?: string;
  BROWSER?: BrowserRun;
};

const MAX_ENVELOPE_BYTES = 2_000_000;

export function isBrowserRunSource(sourceId: SourceId): sourceId is BrowserRunSourceId {
  return (BROWSER_RUN_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

export function browserRunFallbackConfigured(sourceId: SourceId, env: Env): boolean {
  const configured = env as BrowserRunEnv;
  return isBrowserRunSource(sourceId)
    && configured.BROWSER_RUN_FALLBACK_ENABLED === "true"
    && typeof configured.BROWSER?.quickAction === "function";
}

function isAllowedUrl(sourceId: BrowserRunSourceId, url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
  if (sourceId === "amazon_jp") {
    return (url.hostname === "www.amazon.co.jp" || url.hostname === "amazon.co.jp")
      && (url.pathname === "/s" || url.pathname === "/s/");
  }
  if (sourceId === "yahoo_fleamarket_jp") {
    return url.hostname === "paypayfleamarket.yahoo.co.jp"
      && (/^\/search\/[^/]{1,800}$/u.test(url.pathname) || /^\/item\/[A-Za-z0-9_-]{1,100}$/u.test(url.pathname));
  }
  return (url.hostname === "www.suruga-ya.jp" || url.hostname === "suruga-ya.jp")
    && (/^\/search(?:\/|$)/u.test(url.pathname) || /^\/product\/detail\//u.test(url.pathname));
}

async function boundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_ENVELOPE_BYTES) {
    throw new AdapterError("Browser Run 响应超过安全上限", "browser_run_response_too_large");
  }
  if (!response.body) throw new AdapterError("Browser Run 响应正文为空", "browser_run_empty_response", 502, true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ENVELOPE_BYTES) {
        await reader.cancel("browser_run_response_too_large");
        throw new AdapterError("Browser Run 响应超过安全上限", "browser_run_response_too_large");
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
  return new TextDecoder().decode(bytes);
}

function errorMessage(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const errors = (value as Record<string, unknown>).errors;
    if (!Array.isArray(errors)) return undefined;
    const messages = errors.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const message = (entry as Record<string, unknown>).message;
      return typeof message === "string" && message.trim() ? [message.trim().slice(0, 240)] : [];
    });
    return messages.length ? messages.join("；").slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function contentEnvelope(body: string): { html: string; status: number } | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const envelope = value as Record<string, unknown>;
    if (envelope.success !== true || typeof envelope.result !== "string") return undefined;
    const meta = envelope.meta && typeof envelope.meta === "object" && !Array.isArray(envelope.meta)
      ? envelope.meta as Record<string, unknown>
      : {};
    const status = typeof meta.status === "number" && Number.isInteger(meta.status)
      && meta.status >= 100 && meta.status <= 599
      ? meta.status
      : 200;
    return { html: envelope.result, status };
  } catch {
    return undefined;
  }
}

export function createBrowserRunFetch(env: Env, sourceId: BrowserRunSourceId): AdapterContext["fetch"] {
  const configured = env as BrowserRunEnv;
  const browser = configured.BROWSER;
  if (!browserRunFallbackConfigured(sourceId, env) || !browser) {
    throw new AdapterError("Browser Run 兜底未配置", "browser_run_not_configured");
  }

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET" || request.body || !isAllowedUrl(sourceId, url)) {
      throw new AdapterError("Browser Run 只允许固定来源的 GET 请求", "browser_run_url_rejected", 400, false);
    }
    if (request.signal.aborted) throw new AdapterError("Browser Run 请求已取消", "browser_run_aborted", undefined, true);

    let response: Response;
    try {
      response = await browser.quickAction("content", {
        url: url.href,
        ...(sourceId === "amazon_jp" ? {
          cookies: [
            { name: "i18n-prefs", value: "JPY", url: "https://www.amazon.co.jp/" },
            { name: "lc-acbjp", value: "ja_JP", url: "https://www.amazon.co.jp/" },
          ],
          setExtraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9" },
        } : {}),
        gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
        actionTimeout: 45_000,
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        setJavaScriptEnabled: true,
        bestAttempt: false,
        cacheTTL: 30,
      });
    } catch (error) {
      throw new AdapterError(
        error instanceof Error ? `Browser Run 网络错误：${error.message.slice(0, 360)}` : "Browser Run 网络错误",
        "browser_run_network_error",
        undefined,
        true,
      );
    }

    const body = await boundedText(response);
    if (!response.ok) {
      const detail = errorMessage(body);
      throw new AdapterError(
        detail ? `Browser Run 请求失败 (${response.status})：${detail}` : `Browser Run 请求失败 (${response.status})`,
        `browser_run_http_${response.status}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    const content = contentEnvelope(body);
    if (!content) {
      throw new AdapterError("Browser Run 返回了无效内容响应", "browser_run_invalid_response", 502, true);
    }
    const headers = new Headers({ "content-type": "text/html; charset=UTF-8", "x-jpgr-browser-run": "1" });
    const browserMs = response.headers.get("x-browser-ms-used");
    if (browserMs && /^\d{1,10}$/u.test(browserMs)) headers.set("x-browser-ms-used", browserMs);
    return new Response(content.html, { status: content.status, headers });
  }) as AdapterContext["fetch"];
}
import type { RuntimeEnv as Env } from "./runtime-env";
