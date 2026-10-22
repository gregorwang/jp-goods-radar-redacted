import { AdapterError, containsHtmlChallenge } from "@jpgr/adapters";
import type { EmbeddedUpstreamResponseCapture } from "@jpgr/core";
import { requireAllowedSourceRunnerUrl, type SourceRunnerId } from "./source-policy";

/**
 * 单次上游响应允许读进内存的硬上界。生产观测到的最大正文约 1.5 MB（雅虎搜索页），
 * 这里留一倍余量；越界直接判失败，好过把 runner 撑爆。
 */
const MAX_RESPONSE_BYTES = 3_000_000;
/** 单条证据的留存上限。只约束"存多少"，不约束适配器能读到多少。 */
const MAX_CAPTURE_BYTES = 1_800_000;
/** 一次任务累计留存的证据上限。同样只影响留存。 */
const MAX_TOTAL_CAPTURE_BYTES = 2_600_000;
/** 判定人机验证页只需要页首几十 KB。 */
const CHALLENGE_SNIFF_BYTES = 32_768;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_DEPTH = 3;
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|access[-_]?token|authorization|credential|password|secret|signature)/iu;

export interface AdaptiveFetchOptions {
  baseFetch?: typeof fetch;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return "unavailable";
  }
}

function mimeType(headers: Headers): string | undefined {
  const value = headers.get("content-type")?.split(";", 1)[0]?.trim();
  return value && /^[\w.+-]+\/[\w.+-]+$/u.test(value) ? value.slice(0, 120) : undefined;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

/**
 * 把正文一次性读进内存。
 *
 * 这里刻意不用 `response.clone()`：clone 出来的两个分支共用一条 tee，取消其中一个
 * 分支会让另一个分支永远读不出来——`fetch` 的 await 不落地，任何 AbortSignal 都救不
 * 回来（2026-09-05 生产上雅虎第三页就是这样静默挂死，深度永远停在 2 页）。正文只读
 * 一遍，取证从这份字节里切，适配器拿到的是按同一份字节重建的响应。
 */
async function readBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("source_runner_response_too_large").catch(() => undefined);
        throw new AdapterError("上游响应超过上限", "response_too_large", undefined, false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class AdaptiveSourceTransport {
  readonly #sourceId: SourceRunnerId;
  readonly #jobSignal?: AbortSignal;
  readonly #baseFetch: typeof fetch;
  readonly #captures: EmbeddedUpstreamResponseCapture[] = [];
  #capturedBytes = 0;

  constructor(sourceId: SourceRunnerId, jobSignal?: AbortSignal, options: AdaptiveFetchOptions = {}) {
    this.#sourceId = sourceId;
    this.#jobSignal = jobSignal;
    this.#baseFetch = options.baseFetch ?? globalThis.fetch;
  }

  get captures(): readonly EmbeddedUpstreamResponseCapture[] {
    return this.#captures;
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return this.#fetchAllowed(new Request(input, init), 0);
  }) as typeof fetch;

  async #fetchAllowed(request: Request, redirectDepth: number): Promise<Response> {
    const allowedMethod = request.method === "GET"
      || (this.#sourceId === "mercari_jp" && request.method === "POST");
    if (!allowedMethod) throw new Error("source_runner_method_rejected");
    const requestMethod = request.method as "GET" | "POST";
    const url = requireAllowedSourceRunnerUrl(this.#sourceId, request.url);
    const combinedSignal = this.#jobSignal
      ? AbortSignal.any([request.signal, this.#jobSignal])
      : request.signal;
    if (combinedSignal.aborted) throw combinedSignal.reason ?? new DOMException("Aborted", "AbortError");

    const startedAt = Date.now();
    let directResponse: Response;
    try {
      // 手动处理重定向：自动跟随会让上游把请求引到白名单之外的主机，而响应体随后会
      // 作为"上游证据"回传给 Cloudflare。
      directResponse = await this.#baseFetch(new Request(request, { signal: combinedSignal, redirect: "manual" }));
    } catch (error) {
      await this.#recordFailure(url, requestMethod, startedAt, error);
      throw error;
    }

    if (REDIRECT_STATUSES.has(directResponse.status)) {
      const location = directResponse.headers.get("location");
      await directResponse.body?.cancel("source_runner_redirect").catch(() => undefined);
      // Mercari DPoP signs the exact target URL and method. Following even a
      // same-host redirect would replay a proof for a different htu value.
      if (this.#sourceId === "mercari_jp" || this.#sourceId === "amiami" || !location || redirectDepth >= MAX_REDIRECT_DEPTH) {
        throw new Error("source_runner_redirect_rejected");
      }
      const target = requireAllowedSourceRunnerUrl(this.#sourceId, new URL(location, url));
      return this.#fetchAllowed(
        new Request(target, { method: "GET", headers: request.headers, signal: request.signal }),
        redirectDepth + 1,
      );
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await readBody(directResponse, MAX_RESPONSE_BYTES);
    } catch (error) {
      await this.#recordFailure(url, requestMethod, startedAt, error);
      throw error;
    }

    const contentType = mimeType(directResponse.headers);
    if (contentType?.includes("html")) {
      const head = new TextDecoder().decode(bytes.subarray(0, CHALLENGE_SNIFF_BYTES));
      if (containsHtmlChallenge(head)) {
        // 浏览器兜底已经下线，这里不再自愈，只把它变成可检索的信号：适配器自己的
        // 人机验证判定会把这一轮判失败，业务自愈闸门据此挂起该来源。
        console.warn(JSON.stringify({
          event: "source_runner_challenge_detected",
          sourceId: this.#sourceId,
          requestUrl: safeUrl(url.href),
          responseStatus: directResponse.status,
        }));
      }
    }

    await this.#recordResponse(url, requestMethod, directResponse, bytes, startedAt);
    return this.#replay(directResponse, url, bytes);
  }

  /** 用已经读完的字节重建一份可再读的响应，交给适配器。 */
  #replay(response: Response, url: URL, bytes: Uint8Array<ArrayBuffer>): Response {
    const headers = new Headers(response.headers);
    // 正文已经解压并落成字节，保留这三个头会和实际内容对不上。
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const replay = new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    Object.defineProperty(replay, "url", { configurable: true, value: response.url || url.href });
    return replay;
  }

  async #recordResponse(
    url: URL,
    requestMethod: "GET" | "POST",
    response: Response,
    bytes: Uint8Array<ArrayBuffer>,
    startedAt: number,
  ): Promise<void> {
    const contentType = mimeType(response.headers);
    // HTML 正文在 Cloudflare 侧一定会被丢掉（source-capture.ts 的 persistedRawPayload
    // 与建表约束都拒绝存 HTML 正文），回传它只是白占任务响应的 4 MB 预算。只留大小和
    // 哈希；rawPayload 缺省时对端按 payloadBytes 记真实体积，也比截断后的数字准。
    const dropPayload = Boolean(contentType?.includes("html"))
      || (this.#sourceId === "amiami" && !contentType?.includes("json"));
    const available = Math.max(0, MAX_TOTAL_CAPTURE_BYTES - this.#capturedBytes);
    const limit = Math.min(MAX_CAPTURE_BYTES, available);
    const retained = dropPayload ? undefined : new TextDecoder().decode(bytes.subarray(0, limit));
    if (retained !== undefined) this.#capturedBytes += Math.min(bytes.byteLength, limit);
    this.#captures.push({
      version: 1,
      requestUrl: safeUrl(url.href),
      ...(response.url ? { responseUrl: safeUrl(response.url) } : {}),
      requestMethod,
      responseStatus: response.status,
      ...(contentType ? { contentType } : {}),
      ...(retained === undefined ? {} : { rawPayload: retained }),
      payloadBytes: bytes.byteLength,
      contentHash: retained === undefined ? await sha256Bytes(bytes) : await sha256(retained),
      capturedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      truncated: retained !== undefined && bytes.byteLength > limit,
    });
  }

  async #recordFailure(url: URL, requestMethod: "GET" | "POST", startedAt: number, error: unknown): Promise<void> {
    this.#captures.push({
      version: 1,
      requestUrl: safeUrl(url.href),
      requestMethod,
      payloadBytes: 0,
      contentHash: await sha256(""),
      capturedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      truncated: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "source_runner_request_failed",
    });
  }
}
