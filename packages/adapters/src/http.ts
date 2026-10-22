export class AdapterError extends Error {
  /**
   * 上游自有的错误码与子码。HTTP 状态码不足以分类：Mercari 把"商品已被删除"
   * （InvisibleItemException / meta.sub_error_code=410）也返回 403，只看状态码
   * 就会把一条失效商品误判成来源被反爬封禁。适配器需要按语义而非状态码分流。
   */
  upstreamCode?: string;
  upstreamSubCode?: string;

  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class ParserStructureError extends AdapterError {
  constructor(message: string) {
    super(message, "parser_structure_error", undefined, false);
    this.name = "ParserStructureError";
  }
}

const JSON_LIMIT_BYTES = 2_000_000;
const ERROR_PREVIEW_LIMIT_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const SENSITIVE_QUERY_VALUE = /([?&](?:applicationId|accessKey|affiliateId)=)[^&#\s]*/gi;

export function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]");
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(Math.ceil(numeric), 24 * 60 * 60);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000)), 24 * 60 * 60);
}

interface UpstreamErrorDetail {
  detail?: string;
  code?: string;
  subCode?: string;
}

function codeText(value: unknown): string | undefined {
  return text(value) ?? (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined);
}

async function readUpstreamError(response: Response): Promise<UpstreamErrorDetail | undefined> {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < ERROR_PREVIEW_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = ERROR_PREVIEW_LIMIT_BYTES - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        await reader.cancel("error_preview_limit");
        break;
      }
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = record(JSON.parse(new TextDecoder().decode(bytes)));
    // 结构化错误体的形状按来源不同：Mercari 用 errors[].code + meta.sub_error_code，
    // 其它来源多用顶层 code / error_code。三者都收，交给适配器按语义分类。
    const first = record(list(body.errors)[0]);
    const detail = text(body.error_description) ?? text(body.message) ?? text(body.error) ?? text(first.message);
    const code = codeText(first.code) ?? codeText(body.error_code) ?? codeText(body.code);
    const subCode = codeText(record(body.meta).sub_error_code) ?? codeText(body.sub_error_code);
    return {
      ...(detail ? { detail: redactSensitiveText(detail.replace(/\s+/g, " ").slice(0, 300)) } : {}),
      ...(code ? { code: code.slice(0, 120) } : {}),
      ...(subCode ? { subCode: subCode.slice(0, 40) } : {}),
    };
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > JSON_LIMIT_BYTES) throw new AdapterError("来源响应超过 2 MB 安全上限", "response_too_large");
  if (!response.body) throw new ParserStructureError("来源响应正文为空");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > JSON_LIMIT_BYTES) {
        await reader.cancel("response_too_large");
        throw new AdapterError("来源响应超过 2 MB 安全上限", "response_too_large");
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
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ParserStructureError("来源返回的 JSON 无法解析");
  }
}

export async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit = {},
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "JP-Goods-Radar/0.1 (+personal-monitor)",
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AdapterError("来源请求超时", "request_timeout", undefined, true);
    }
    throw new AdapterError(
      error instanceof Error ? `来源网络错误：${redactSensitiveText(error.message)}` : "来源网络错误",
      "network_error",
      undefined,
      true,
    );
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const upstreamError = await readUpstreamError(response);
    const error = new AdapterError(
      `来源请求失败 (${response.status})${upstreamError?.detail ? `：${upstreamError.detail}` : ""}`,
      `http_${response.status}`,
      response.status,
      retryable,
      response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : undefined,
    );
    if (upstreamError?.code) error.upstreamCode = upstreamError.code;
    if (upstreamError?.subCode) error.upstreamSubCode = upstreamError.subCode;
    throw error;
  }

  // 正文是流式读取的：超时若在读取途中触发，reader.read() 会抛出原始
  // DOMException，必须在这里补齐与 fetch 分支一致的可重试分类。
  try {
    return await readJson(response);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AdapterError("来源请求超时", "request_timeout", undefined, true);
    }
    throw new AdapterError("来源响应读取失败", "network_error", undefined, true);
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function integer(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

export function uniqueListings<T extends { sourceItemId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.sourceItemId)) return false;
    seen.add(item.sourceItemId);
    return true;
  });
}

export function requireArrayField(body: unknown, key: string): unknown[] {
  const value = record(body)[key];
  if (!Array.isArray(value)) throw new ParserStructureError(`来源 JSON schema 缺少 ${key} 数组`);
  return value;
}

export function requireArrayFieldAny(body: unknown, keys: readonly string[]): unknown[] {
  const object = record(body);
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key];
  }
  throw new ParserStructureError(`来源 JSON schema 缺少 ${keys.join("/")} 数组`);
}
