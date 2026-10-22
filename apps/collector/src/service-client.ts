import { AdapterError } from "@jpgr/adapters";
import {
  canonicalJson,
  type AdapterContext,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SourceId,
  type SourceRouteFailureAttempt,
  type SourceRouteFailureEvidence,
} from "@jpgr/core";
import { normalizedListingSchema, searchResultSchema } from "@jpgr/validation";
import { signServiceRequest } from "./service-signing";

/**
 * 调用 Vercel 东京适配服务（apps/mercari-service）的那一层：签名、发请求、读响应、
 * 把服务端/平台的失败翻译成 AdapterError。选哪条路、失败后换哪条路不在这里，
 * 在 source-execution.ts。
 */

export type ConfiguredEnv = Env & {
  MERCARI_ADAPTER_URL?: string;
  MERCARI_SOURCE_RUNNER_MODE?: string;
  SURUGAYA_ADAPTER_URL?: string;
  SOURCE_ADAPTER_URL?: string;
  MERCARI_ADAPTER_SIGNING_KEY?: string;
  AMAZON_CLOUDFLARE_DIRECT_ENABLED?: string;
  YAHOO_CLOUDFLARE_DIRECT_ENABLED?: string;
  SURUGAYA_CLOUDFLARE_DIRECT_ENABLED?: string;
  FIXED_HTML_CLOUDFLARE_DIRECT_ENABLED?: string;
  YAHOO_FLEAMARKET_CLOUDFLARE_DIRECT_ENABLED?: string;
};

const SERVICE_SOURCE_IDS = ["mercari_jp", "surugaya", "yahoo_shopping", "charaon", "cospa", "animate"] as const satisfies readonly SourceId[];
export type ServiceSourceId = (typeof SERVICE_SOURCE_IDS)[number];
type ServiceOperation = "search" | "item";
type ServiceCallTrace = {
  correlationId: string;
  sourceId: ServiceSourceId;
  operation: ServiceOperation;
  startedAt: number;
};

type ServiceError = {
  code?: unknown;
  message?: unknown;
  upstreamStatus?: unknown;
  retryable?: unknown;
  retryAfterSeconds?: unknown;
};

type ServiceDescriptor = {
  label: string;
  codePrefix: string;
  searchPath: string;
  itemPath?: string;
  searchScope: string;
  itemScope?: string;
  timeoutMs: number;
  sharedEndpoint: boolean;
};

const SERVICE_DESCRIPTORS = {
  mercari_jp: {
    label: "Mercari",
    codePrefix: "mercari_service",
    searchPath: "api/search",
    itemPath: "api/item",
    searchScope: "mercari.search.v1",
    itemScope: "mercari.item.v1",
    timeoutMs: 10_000,
    sharedEndpoint: false,
  },
  surugaya: {
    label: "骏河屋",
    codePrefix: "surugaya_service",
    searchPath: "api/surugaya-search",
    itemPath: "api/surugaya-item",
    searchScope: "surugaya.search.v1",
    itemScope: "surugaya.item.v1",
    timeoutMs: 25_000,
    sharedEndpoint: false,
  },
  yahoo_shopping: {
    label: "Yahoo! Shopping",
    codePrefix: "yahoo_service",
    searchPath: "api/yahoo-search",
    searchScope: "yahoo.search.v1",
    timeoutMs: 18_000,
    sharedEndpoint: false,
  },
  charaon: {
    label: "CharaON",
    codePrefix: "charaon_service",
    searchPath: "api/source-search",
    itemPath: "api/source-item",
    searchScope: "source.search.v1",
    itemScope: "source.item.v1",
    timeoutMs: 25_000,
    sharedEndpoint: true,
  },
  cospa: {
    label: "COSPA",
    codePrefix: "cospa_service",
    searchPath: "api/source-search",
    itemPath: "api/source-item",
    searchScope: "source.search.v1",
    itemScope: "source.item.v1",
    timeoutMs: 25_000,
    sharedEndpoint: true,
  },
  animate: {
    label: "Animate",
    codePrefix: "animate_service",
    searchPath: "api/source-search",
    itemPath: "api/source-item",
    searchScope: "source.search.v1",
    itemScope: "source.item.v1",
    timeoutMs: 25_000,
    sharedEndpoint: true,
  },
} as const satisfies Record<ServiceSourceId, ServiceDescriptor>;

const RESPONSE_LIMIT_BYTES = 2_000_000;
const SURUGAYA_SOURCE_CONFIG_KEYS = ["category", "includeMarketplace", "pages", "pageToken"] as const;

export function isServiceSource(sourceId: SourceId): sourceId is ServiceSourceId {
  return (SERVICE_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

export function descriptor(sourceId: ServiceSourceId): ServiceDescriptor {
  return SERVICE_DESCRIPTORS[sourceId];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeDiagnosticHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 160);
  return /^[A-Za-z0-9:._/\-]+$/.test(trimmed) ? trimmed : undefined;
}

function safePlatformCode(response: Response, bodyText?: string): string | undefined {
  const headerValue = response.headers.get("x-vercel-error") ?? response.headers.get("x-vercel-error-code");
  const candidate = headerValue?.trim().slice(0, 100)
    ?? bodyText?.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,8}\b/)?.[0];
  return candidate && /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,8}$/.test(candidate) ? candidate : undefined;
}

function responseDiagnostic(response: Response, bodyText?: string) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().slice(0, 80) || "missing",
    requestId: safeDiagnosticHeader(response.headers.get("x-vercel-id") ?? response.headers.get("x-request-id") ?? response.headers.get("cf-ray")),
    platformCode: safePlatformCode(response, bodyText),
  };
}

function configuredUrl(sourceId: ServiceSourceId, env: ConfiguredEnv): string | undefined {
  if (sourceId === "mercari_jp") return env.MERCARI_ADAPTER_URL;
  if (sourceId === "surugaya") return env.SURUGAYA_ADAPTER_URL;
  return env.SOURCE_ADAPTER_URL;
}

export function serviceConfig(sourceId: ServiceSourceId, env: Env): { baseUrl: URL; signingKey: string } | undefined {
  const configured = env as ConfiguredEnv;
  const rawUrl = configuredUrl(sourceId, configured);
  if (!rawUrl || !configured.MERCARI_ADAPTER_SIGNING_KEY) return undefined;
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return undefined;
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return { baseUrl, signingKey: configured.MERCARI_ADAPTER_SIGNING_KEY };
}

export function mercariServiceConfigured(env: Env): boolean {
  return Boolean(serviceConfig("mercari_jp", env));
}

export function surugayaServiceConfigured(env: Env): boolean {
  return Boolean(serviceConfig("surugaya", env));
}

export function yahooServiceConfigured(env: Env): boolean {
  return Boolean(serviceConfig("yahoo_shopping", env));
}

export function fixedHtmlServiceConfigured(env: Env): boolean {
  return Boolean(serviceConfig("charaon", env));
}

/**
 * 我们的服务只用 JSON 信封回话；煤炉真的拦了，服务回的是 HTTP 200 + `error.upstreamStatus=403`。
 * 一个没有 JSON 的 401/403 只可能是 Vercel 平台自己挡在前面（防火墙、部署保护、项目暂停）。
 * 它以前带着 status=403 往下走，被当成"煤炉封了我们"冷却 12 小时，修的方向也会错。
 * 这里换成独立错误码、status 记 502（网关层失败），不触发封禁冷却，换路仍然照常发生。
 */
function platformForbidden(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function platformForbiddenError(service: ServiceDescriptor, status: number, trace: ServiceCallTrace, detail?: string): AdapterError {
  return new AdapterError(
    `${service.label} 适配服务被 Vercel 平台拒绝 (${status}${detail ? `；${detail}` : ""})，不是来源封禁：请到 Vercel 后台检查防火墙 / 部署保护 / 项目状态；关联 ${trace.correlationId}`,
    `${service.codePrefix}_platform_forbidden`,
    502,
    false,
  );
}

async function readLimitedJson(response: Response, service: ServiceDescriptor, trace: ServiceCallTrace): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel("declared_response_too_large").catch(() => undefined);
    console.warn(JSON.stringify({
      event: "source_service_invalid_response",
      sourceId: trace.sourceId,
      operation: trace.operation,
      correlationId: trace.correlationId,
      durationMs: Date.now() - trace.startedAt,
      reason: "declared_response_too_large",
      declaredLength,
    }));
    throw new AdapterError(`${service.label} 适配服务响应超过安全上限；关联 ${trace.correlationId}`, `${service.codePrefix}_response_too_large`);
  }
  if (!response.body) {
    const diagnostic = responseDiagnostic(response);
    console.warn(JSON.stringify({
      event: "source_service_invalid_response",
      sourceId: trace.sourceId,
      operation: trace.operation,
      correlationId: trace.correlationId,
      durationMs: Date.now() - trace.startedAt,
      service: service.codePrefix,
      ...diagnostic,
    }));
    if (platformForbidden(response)) throw platformForbiddenError(service, response.status, trace);
    throw new AdapterError(`${service.label} 适配服务响应为空 (${response.status})；关联 ${trace.correlationId}`,
      response.status >= 500 ? `${service.codePrefix}_platform_invalid_response` : `${service.codePrefix}_invalid_response`,
      response.status, response.status >= 500);
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
        await reader.cancel("response_too_large");
        throw new AdapterError(`${service.label} 适配服务响应超过安全上限`, `${service.codePrefix}_response_too_large`);
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
  const decoded = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    const diagnostic = responseDiagnostic(response, decoded);
    console.warn(JSON.stringify({
      event: "source_service_invalid_response",
      sourceId: trace.sourceId,
      operation: trace.operation,
      correlationId: trace.correlationId,
      durationMs: Date.now() - trace.startedAt,
      service: service.codePrefix,
      ...diagnostic,
    }));
    const requestLabel = diagnostic.requestId ? `；请求 ${diagnostic.requestId}` : "";
    const platformLabel = diagnostic.platformCode ? `；平台 ${diagnostic.platformCode}` : "";
    if (platformForbidden(response)) {
      throw platformForbiddenError(service, response.status, trace, `${diagnostic.contentType}${requestLabel}${platformLabel}`);
    }
    throw new AdapterError(`${service.label} 适配服务返回了非 JSON 响应 (${response.status}；${diagnostic.contentType}${requestLabel}${platformLabel})；关联 ${trace.correlationId}`,
      response.status >= 500 ? `${service.codePrefix}_platform_invalid_response` : `${service.codePrefix}_invalid_response`,
      response.status, response.status >= 500);
  }
}

function serviceBody(sourceId: ServiceSourceId, operation: ServiceOperation, body: unknown): unknown {
  const service = descriptor(sourceId);
  if (!service.sharedEndpoint) return body;
  return operation === "search" ? { sourceId, request: body } : { sourceId, urlOrId: record(body).urlOrId };
}

function serviceSearchRequest(sourceId: ServiceSourceId, request: SearchRequest): SearchRequest {
  if (!request.sourceConfig) return request;
  if (sourceId === "yahoo_shopping") {
    const sourceConfig: Record<string, unknown> = {};
    const categoryId = request.sourceConfig.categoryId;
    if (typeof categoryId === "string" && /^\d{1,20}$/.test(categoryId)) sourceConfig.categoryId = categoryId;
    const requestedPages = request.sourceConfig.pageCount ?? request.sourceConfig.pages;
    const pageCount = typeof requestedPages === "number" ? requestedPages : Number(requestedPages);
    if (Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= 3) sourceConfig.pageCount = pageCount;
    const pageToken = request.sourceConfig.pageToken;
    if ((typeof pageToken === "string" || typeof pageToken === "number") && /^[1-3]$/u.test(String(pageToken))) {
      sourceConfig.pageToken = String(pageToken);
    }
    return Object.keys(sourceConfig).length > 0
      ? { ...request, sourceConfig }
      : { query: request.query, filters: request.filters };
  }
  if (sourceId !== "surugaya") return request;
  const sourceConfig: Record<string, unknown> = {};
  for (const key of SURUGAYA_SOURCE_CONFIG_KEYS) {
    if (Object.hasOwn(request.sourceConfig, key) && request.sourceConfig[key] !== undefined) {
      sourceConfig[key] = request.sourceConfig[key];
    }
  }
  return Object.keys(sourceConfig).length > 0
    ? { ...request, sourceConfig }
    : { query: request.query, filters: request.filters };
}

async function callServiceOnce(
  env: Env,
  sourceId: ServiceSourceId,
  operation: ServiceOperation,
  body: unknown,
  fetcher: AdapterContext["fetch"],
): Promise<unknown> {
  const config = serviceConfig(sourceId, env);
  const service = descriptor(sourceId);
  if (!config) throw new AdapterError(`${service.label} 独立适配服务尚未配置`, `${service.codePrefix}_not_configured`);
  const timestamp = String(Date.now());
  const scope = operation === "search" ? service.searchScope : service.itemScope;
  const path = operation === "search" ? service.searchPath : service.itemPath;
  if (!scope || !path) throw new AdapterError(`${service.label} 暂不支持单品查询`, "item_lookup_unsupported");
  const payload = serviceBody(sourceId, operation, body);
  const signature = await signServiceRequest(config.signingKey, scope, timestamp, payload);
  const trace: ServiceCallTrace = { correlationId: crypto.randomUUID(), sourceId, operation, startedAt: Date.now() };
  let response: Response;
  try {
    response = await fetcher(new URL(path, config.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-JPGR-Timestamp": timestamp,
        "X-JPGR-Signature": signature,
        "X-JPGR-Request-ID": trace.correlationId,
      },
      body: canonicalJson(payload),
      signal: AbortSignal.timeout(service.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.warn(JSON.stringify({
      event: "source_service_transport_failed",
      sourceId,
      operation,
      correlationId: trace.correlationId,
      durationMs: Date.now() - trace.startedAt,
      errorName: error instanceof Error ? error.name : "UnknownError",
      timedOut,
    }));
    throw new AdapterError(timedOut ? `${service.label} 适配服务请求超时；关联 ${trace.correlationId}` : `${service.label} 适配服务网络错误；关联 ${trace.correlationId}`,
      timedOut ? `${service.codePrefix}_timeout` : `${service.codePrefix}_network_error`, undefined, true);
  }
  const envelope = record(await readLimitedJson(response, service, trace));
  const diagnostic = responseDiagnostic(response);
  if (response.ok && envelope.ok === true && envelope.data !== undefined) {
    console.info(JSON.stringify({
      event: "source_service_request_completed",
      sourceId,
      operation,
      correlationId: trace.correlationId,
      durationMs: Date.now() - trace.startedAt,
      ...diagnostic,
    }));
    return envelope.data;
  }
  const failure = record(envelope.error) as ServiceError;
  const upstreamStatus = typeof failure.upstreamStatus === "number" ? failure.upstreamStatus : undefined;
  const effectiveStatus = upstreamStatus ?? response.status;
  const retryable = failure.retryable === true
    || (upstreamStatus === undefined && response.status >= 500 && response.status <= 599);
  console.warn(JSON.stringify({
    event: "source_service_request_failed",
    sourceId,
    operation,
    correlationId: trace.correlationId,
    durationMs: Date.now() - trace.startedAt,
    errorCode: typeof failure.code === "string" ? failure.code.slice(0, 120) : `${service.codePrefix}_failed`,
    upstreamStatus: upstreamStatus ?? null,
    retryable,
    ...diagnostic,
  }));
  throw new AdapterError(
    typeof failure.message === "string"
      ? `${failure.message.slice(0, 430)}；关联 ${trace.correlationId}`
      : `${service.label} 适配服务请求失败 (${response.status})；关联 ${trace.correlationId}`,
    typeof failure.code === "string" ? failure.code : `${service.codePrefix}_failed`,
    effectiveStatus,
    retryable,
    typeof failure.retryAfterSeconds === "number" ? failure.retryAfterSeconds : undefined,
  );
}

function shouldRetryServiceFailure(error: unknown): error is AdapterError {
  return error instanceof AdapterError && error.retryable && typeof error.status === "number" && error.status >= 500;
}

function boundedRetryDelayMs(): number {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return 1_000 + (random % 1_001);
}

function failureAttempt(error: AdapterError, attempt: number): SourceRouteFailureAttempt {
  return {
    attempt,
    code: error.code,
    status: error.status ?? null,
    message: error.message.slice(0, 500),
  };
}

class RetriedServiceError extends AdapterError {
  readonly attempts: SourceRouteFailureAttempt[];

  constructor(first: AdapterError, second: AdapterError) {
    super(
      `${second.message.slice(0, 320)}；首次尝试：${first.message.slice(0, 160)}`,
      second.code,
      second.status,
      second.retryable,
      second.retryAfterSeconds,
    );
    this.name = "RetriedServiceError";
    this.attempts = [failureAttempt(first, 1), failureAttempt(second, 2)];
  }
}

export function routeFailureEvidence(error: AdapterError): SourceRouteFailureEvidence {
  return {
    code: error.code,
    status: error.status ?? null,
    retryable: error.retryable,
    message: error.message.slice(0, 500),
    attempts: error instanceof RetriedServiceError ? error.attempts : [failureAttempt(error, 1)],
  };
}

export async function callService(
  env: Env,
  sourceId: ServiceSourceId,
  operation: ServiceOperation,
  body: unknown,
  fetcher: AdapterContext["fetch"],
): Promise<unknown> {
  try {
    return await callServiceOnce(env, sourceId, operation, body, fetcher);
  } catch (firstError) {
    if (sourceId === "yahoo_shopping" || !shouldRetryServiceFailure(firstError)) throw firstError;
    await new Promise((resolve) => setTimeout(resolve, boundedRetryDelayMs()));
    try {
      return await callServiceOnce(env, sourceId, operation, body, fetcher);
    } catch (secondError) {
      if (secondError instanceof AdapterError) throw new RetriedServiceError(firstError, secondError);
      throw secondError;
    }
  }
}

export function serviceSearch(
  env: Env,
  sourceId: ServiceSourceId,
  request: SearchRequest,
  fetcher: AdapterContext["fetch"],
): Promise<SearchResult> {
  const serviceRequest = serviceSearchRequest(sourceId, request);
  return callService(env, sourceId, "search", serviceRequest, fetcher)
    .then((value) => validatedSearchResult(value, sourceId));
}

function validatedSearchResult(value: unknown, expectedSourceId: ServiceSourceId): SearchResult {
  const service = descriptor(expectedSourceId);
  const parsed = searchResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.sourceId !== expectedSourceId
    || parsed.data.listings.some((listing) => listing.sourceId !== expectedSourceId)) {
    throw new AdapterError(`${service.label} 适配服务结果结构不合法`, `${service.codePrefix}_invalid_response`);
  }
  return parsed.data;
}

export function validatedListing(value: unknown, expectedSourceId: ServiceSourceId): NormalizedListing {
  const service = descriptor(expectedSourceId);
  const parsed = normalizedListingSchema.safeParse(value);
  if (!parsed.success || parsed.data.sourceId !== expectedSourceId) {
    throw new AdapterError(`${service.label} 适配服务商品结构不合法`, `${service.codePrefix}_invalid_response`);
  }
  return parsed.data;
}

import type { RuntimeEnv as Env } from "./runtime-env";
