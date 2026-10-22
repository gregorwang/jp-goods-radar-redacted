import { AdapterError } from "../../../packages/adapters/src/http.js";
import type { EmbeddedUpstreamResponseCapture } from "../../../packages/core/src/index.js";
import type { ZodError } from "zod";
import type { VercelRequest, VercelResponse } from "./vercel-types.js";

export type ServiceHandlerStage = "method" | "validation" | "authentication" | "upstream_search" | "response";

export function serviceCorrelationId(request: VercelRequest): string {
  const header = request.headers["x-jpgr-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/u.test(value)
    ? value
    : crypto.randomUUID();
}

export function attachServiceCorrelation(response: VercelResponse, correlationId: string): void {
  response.setHeader("X-JPGR-Request-ID", correlationId);
}

export function runtimeMeta(upstreamCaptures: readonly EmbeddedUpstreamResponseCapture[] = []) {
  return {
    runtime: "vercel-node",
    region: process.env.VERCEL_REGION ?? null,
    handledAt: new Date().toISOString(),
    ...(upstreamCaptures.length > 0 ? { upstreamCaptures } : {}),
  };
}

export function methodNotAllowed(response: VercelResponse): void {
  response.setHeader("Allow", "POST");
  response.status(405).json({ ok: false, error: { code: "method_not_allowed", message: "仅支持 POST" }, meta: runtimeMeta() });
}

export function invalidBody(response: VercelResponse, error: ZodError): void {
  response.status(400).json({
    ok: false,
    error: { code: "invalid_request", message: "请求参数不合法", issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    meta: runtimeMeta(),
  });
}

export function authRejected(response: VercelResponse, code: string): void {
  response.status(401).json({ ok: false, error: { code, message: "请求认证失败" }, meta: runtimeMeta() });
}

/**
 * 采集端拿到的失败必须是可读的 JSON。之前这里对所有适配器错误一律回 5xx，而
 * 5xx 的响应体在到达采集端之前会被边缘层换成 16 字节的 `error code: 502`
 * 纯文本 —— 真实错误码（商品已删除、参数非法、来源被封）全部丢失，采集端只能
 * 统一记成 `platform_invalid_response` 并当作可重试的平台故障。
 *
 * 因此业务性失败改用 HTTP 200 承载 `ok:false` 信封：传输确实成功了，失败信息在
 * 载荷里。真实语义不丢——采集端读的是 `error.upstreamStatus ?? response.status`
 * 与 `error.retryable`，两者都由信封原样给出。状态码不再表达失败，改用
 * `X-JPGR-Failure-Code` 响应头，保证服务端自身的日志与指标仍能筛出失败。
 */
export function adapterFailure(
  response: VercelResponse,
  error: unknown,
  sourceLabel = "来源",
  upstreamCaptures: readonly EmbeddedUpstreamResponseCapture[] = [],
): void {
  const adapterError = error instanceof AdapterError ? error : undefined;
  const code = adapterError?.code ?? "adapter_service_error";
  response.setHeader("X-JPGR-Failure-Code", code.slice(0, 120));
  response.status(200).json({
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message.slice(0, 500) : `${sourceLabel}适配服务发生未知错误`,
      upstreamStatus: adapterError?.status ?? null,
      retryable: adapterError?.retryable ?? false,
      retryAfterSeconds: adapterError?.retryAfterSeconds ?? null,
    },
    meta: runtimeMeta(upstreamCaptures),
  });
}

export function unexpectedServiceFailure(
  response: VercelResponse,
  error: unknown,
  input: {
    sourceId: string;
    sourceLabel: string;
    stage: ServiceHandlerStage;
    correlationId?: string;
    durationMs?: number;
  },
): void {
  const errorName = error instanceof Error ? error.name.slice(0, 100) : "UnknownError";
  const errorCode = error instanceof AdapterError ? error.code : "unhandled_error";
  console.error(JSON.stringify({
    event: "source_service_unhandled_error",
    sourceId: input.sourceId,
    stage: input.stage,
    correlationId: input.correlationId,
    durationMs: input.durationMs,
    errorName,
    errorCode,
    ...runtimeMeta(),
  }));
  if (response.headersSent) return;
  adapterFailure(response, new AdapterError(
    `${input.sourceLabel}适配服务在${input.stage}阶段发生未处理错误`,
    `${input.sourceId}_service_unhandled`,
    500,
    true,
  ), input.sourceLabel);
}
