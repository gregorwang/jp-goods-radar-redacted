import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SignatureReplayGuard, verifyRunnerRequest } from "./auth";
import { executeRunnerTask } from "./execution";
import { PooledJobQueue, type RunnerJobSnapshot, type RunnerPoolId, type RunnerPoolLimits } from "./job-queue";
import { createJobBodySchema, jobStatusBodySchema } from "./schemas";

const MAX_REQUEST_BYTES = 64 * 1_024;
const CREATE_SCOPE = "source-runner.job.create.v1";
const STATUS_SCOPE = "source-runner.job.read.v1";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/u;

type JsonRecord = Record<string, unknown>;

class HttpInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpInputError";
    this.status = status;
    this.code = code;
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function requestId(headers: Headers): string {
  const candidate = headers.get("x-jpgr-request-id")?.trim();
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : crypto.randomUUID();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpInputError(415, "unsupported_media_type", "请求必须使用 application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        throw new HttpInputError(413, "request_too_large", "请求正文超过 64 KB 安全上限");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    request.resume();
    throw error;
  }
  if (bytes === 0) throw new HttpInputError(400, "invalid_json", "请求正文不能为空");
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw new HttpInputError(400, "invalid_json", "请求正文不是合法 JSON");
  }
}

function runtimeMeta(captures: readonly unknown[] = []): JsonRecord {
  return {
    runtime: "node-fetch",
    region: "singapore-vps",
    handledAt: new Date().toISOString(),
    ...(captures.length > 0 ? { upstreamCaptures: captures } : {}),
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  correlationId: string,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
    "X-Content-Type-Options": "nosniff",
    "X-JPGR-Request-ID": correlationId,
    ...extraHeaders,
  });
  response.end(payload);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  correlationId: string,
  retryable = false,
): void {
  sendJson(response, status, {
    ok: false,
    error: { code, message, upstreamStatus: status, retryable, retryAfterSeconds: null },
    meta: runtimeMeta(),
  }, correlationId);
}

async function authorize(
  response: ServerResponse,
  headers: Headers,
  scope: string,
  body: unknown,
  correlationId: string,
  replayGuard: SignatureReplayGuard,
): Promise<boolean> {
  const result = await verifyRunnerRequest(headers, scope, body, replayGuard);
  if (result.ok) return true;
  sendError(response, 401, result.code, "请求认证失败", correlationId);
  return false;
}

function statusResponse(response: ServerResponse, job: RunnerJobSnapshot, correlationId: string): void {
  if (job.status === "succeeded") {
    const { captures, ...data } = job;
    sendJson(response, 200, { ok: true, data, meta: runtimeMeta(captures) }, correlationId);
    return;
  }
  if (job.status === "failed") {
    const { captures, ...data } = job;
    sendJson(response, 200, { ok: true, data, meta: runtimeMeta(captures) }, correlationId);
    return;
  }
  sendJson(response, 200, { ok: true, data: job, meta: runtimeMeta() }, correlationId);
}

export interface SourceRunnerServer {
  server: Server;
  queue: PooledJobQueue;
}

export function createSourceRunnerServer(options: {
  queue?: PooledJobQueue;
  pools?: Partial<Record<RunnerPoolId, Partial<RunnerPoolLimits>>>;
} = {}): SourceRunnerServer {
  const queue = options.queue ?? new PooledJobQueue(executeRunnerTask, { pools: options.pools });
  const replayGuard = new SignatureReplayGuard();
  const server = createServer(async (request, response) => {
    const headers = requestHeaders(request);
    const correlationId = requestId(headers);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        // 该路径经 Caddy 公开暴露，因此只回存活性。来源清单与队列水位属于内部状态，
        // 公开后可被用来枚举抓取目标并算准队列耗尽时机；需要时从 VPS 日志读取。
        sendJson(response, 200, {
          ok: true,
          data: { service: "jpgr-source-runner", version: 1 },
          meta: runtimeMeta(),
        }, correlationId);
        return;
      }

      if (url.pathname === "/v1/jobs" && request.method !== "POST") {
        sendJson(response, 405, {
          ok: false,
          error: { code: "method_not_allowed", message: "仅支持 POST", upstreamStatus: 405, retryable: false, retryAfterSeconds: null },
          meta: runtimeMeta(),
        }, correlationId, { Allow: "POST" });
        return;
      }
      if (url.pathname === "/v1/jobs/status" && request.method !== "POST") {
        sendJson(response, 405, {
          ok: false,
          error: { code: "method_not_allowed", message: "仅支持 POST", upstreamStatus: 405, retryable: false, retryAfterSeconds: null },
          meta: runtimeMeta(),
        }, correlationId, { Allow: "POST" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs") {
        const body = await readJsonBody(request);
        if (!await authorize(response, headers, CREATE_SCOPE, body, correlationId, replayGuard)) return;
        const parsed = createJobBodySchema.safeParse(body);
        if (!parsed.success) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "invalid_request",
              message: "采集任务参数不合法",
              issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
            },
            meta: runtimeMeta(),
          }, correlationId);
          return;
        }
        const enqueued = queue.enqueue(parsed.data);
        if (!enqueued.ok) {
          sendError(response, 503, enqueued.code, "采集队列暂时不可接收新任务", correlationId, true);
          return;
        }
        console.info(JSON.stringify({
          event: "source_runner_job_queued",
          jobId: enqueued.job.jobId,
          sourceId: parsed.data.sourceId,
          operation: parsed.data.operation,
          correlationId,
        }));
        sendJson(response, 202, { ok: true, data: enqueued.job, meta: runtimeMeta() }, correlationId);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs/status") {
        const body = await readJsonBody(request);
        if (!await authorize(response, headers, STATUS_SCOPE, body, correlationId, replayGuard)) return;
        const parsed = jobStatusBodySchema.safeParse(body);
        if (!parsed.success) {
          sendError(response, 400, "invalid_request", "任务状态参数不合法", correlationId);
          return;
        }
        const job = queue.get(parsed.data.jobId);
        if (!job) {
          sendError(response, 404, "job_not_found", "采集任务不存在或结果已过期", correlationId);
          return;
        }
        statusResponse(response, job, correlationId);
        return;
      }

      sendError(response, 404, "not_found", "Not Found", correlationId);
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendError(response, error.status, error.code, error.message, correlationId);
        return;
      }
      console.error(JSON.stringify({
        event: "source_runner_http_failure",
        correlationId,
        errorName: error instanceof Error ? error.name.slice(0, 100) : "UnknownError",
      }));
      if (!response.headersSent) {
        sendError(response, 500, "source_runner_http_failure", "采集服务发生未处理错误", correlationId, true);
      } else {
        response.end();
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return { server, queue };
}
