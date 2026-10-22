import { AdapterError } from "@jpgr/adapters";
import {
  canonicalJson,
  type AdapterContext,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
  type SourceId,
} from "@jpgr/core";
import { normalizedListingSchema, searchResultSchema } from "@jpgr/validation";
import { signServiceRequest } from "./service-signing";

export const SOURCE_RUNNER_SOURCE_IDS = [
  "amiami",
  "mercari_jp",
  "rakuten_ichiba",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceId[];

export type SourceRunnerSourceId = (typeof SOURCE_RUNNER_SOURCE_IDS)[number];
export const SOURCE_RUNNER_SEARCH_SOURCE_IDS = [
  "amiami",
  "mercari_jp",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceRunnerSourceId[];
export type SourceRunnerSearchSourceId = (typeof SOURCE_RUNNER_SEARCH_SOURCE_IDS)[number];
type RunnerOperation = "search" | "item";

type SourceRunnerEnv = Env & {
  SOURCE_RUNNER_URL?: string;
  MERCARI_ADAPTER_SIGNING_KEY?: string;
};

interface RunnerConfig {
  baseUrl: URL;
  signingKey: string;
}

interface RunnerTrace {
  correlationId: string;
  sourceId: SourceRunnerSourceId;
  operation: RunnerOperation;
  startedAt: number;
}

const CREATE_SCOPE = "source-runner.job.create.v1";
const STATUS_SCOPE = "source-runner.job.read.v1";
const RUNNER_RESPONSE_LIMIT_BYTES = 4_000_000;
const RUNNER_JOB_TIMEOUT_MS = 95_000;
const RUNNER_POLL_INTERVAL_MS = 650;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function runnerConfig(env: Env): RunnerConfig | undefined {
  const configured = env as SourceRunnerEnv;
  if (!configured.SOURCE_RUNNER_URL || !configured.MERCARI_ADAPTER_SIGNING_KEY) return undefined;
  let baseUrl: URL;
  try {
    baseUrl = new URL(configured.SOURCE_RUNNER_URL);
  } catch {
    return undefined;
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return undefined;
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return { baseUrl, signingKey: configured.MERCARI_ADAPTER_SIGNING_KEY };
}

export function isSourceRunnerSource(sourceId: SourceId): sourceId is SourceRunnerSourceId {
  return (SOURCE_RUNNER_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

export function isSourceRunnerSearchSource(sourceId: SourceId): sourceId is SourceRunnerSearchSourceId {
  return (SOURCE_RUNNER_SEARCH_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

export function sourceRunnerConfigured(sourceId: SourceId, env: Env): boolean {
  return isSourceRunnerSource(sourceId) && Boolean(runnerConfig(env));
}

function selectedSourceConfig(sourceId: SourceRunnerSearchSourceId, request: SearchRequest): Record<string, unknown> | undefined {
  const input = request.sourceConfig;
  if (!input) return undefined;
  const output: Record<string, unknown> = {};
  const allowed = sourceId === "mercari_jp"
      ? ["excludeKeyword", "itemConditionId", "pageToken", "historyItemIds"] as const
      : sourceId === "yahoo_shopping"
      ? ["categoryId", "pageCount", "pages", "pageToken"] as const
      : sourceId === "yahoo_auctions_jp"
        ? ["pageToken", "minBidCount", "maxBidCount", "auctionConditionCodes", "categoryIds", "freeShipping", "buyNow"] as const
        : ["pageToken"] as const;
  for (const key of allowed) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) output[key] = input[key];
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function runnerSearchRequest(sourceId: SourceRunnerSearchSourceId, request: SearchRequest): SearchRequest {
  const sourceConfig = selectedSourceConfig(sourceId, request);
  return {
    query: request.query,
    filters: request.filters,
    ...(sourceConfig ? { sourceConfig } : {}),
  };
}

async function readLimitedJson(response: Response, trace: RunnerTrace): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > RUNNER_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel("source_runner_response_too_large").catch(() => undefined);
    throw new AdapterError(
      `新加坡采集服务响应超过安全上限；关联 ${trace.correlationId}`,
      "source_runner_response_too_large",
      response.status,
      false,
    );
  }
  if (!response.body) {
    throw new AdapterError(
      `新加坡采集服务响应为空 (${response.status})；关联 ${trace.correlationId}`,
      "source_runner_invalid_response",
      response.status,
      response.status >= 500,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RUNNER_RESPONSE_LIMIT_BYTES) {
        await reader.cancel("source_runner_response_too_large");
        throw new AdapterError("新加坡采集服务响应超过安全上限", "source_runner_response_too_large", response.status, false);
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
    throw new AdapterError(
      `新加坡采集服务返回了非 JSON 响应 (${response.status})；关联 ${trace.correlationId}`,
      "source_runner_invalid_response",
      response.status,
      response.status >= 500,
    );
  }
}

function remoteFailure(response: Response, envelope: Record<string, unknown>, trace: RunnerTrace): AdapterError {
  const failure = record(envelope.error);
  const upstreamStatus = typeof failure.upstreamStatus === "number" ? failure.upstreamStatus : response.status;
  const repairStatus = failure.repairStatus === "pending" || failure.repairStatus === "repairing"
    ? failure.repairStatus
    : undefined;
  // A missing item is a business terminal state, not a parser incident.  Do
  // not turn a runner's 404/410 into repair_pending: doing so leaves the item
  // run open and repeatedly superseded while the listing can never recover.
  const itemBusinessTerminal = trace.operation === "item" && (upstreamStatus === 404 || upstreamStatus === 410);
  if (repairStatus && !itemBusinessTerminal) {
    const incidentId = typeof failure.repairIncidentId === "string"
      ? failure.repairIncidentId.slice(0, 120)
      : "unknown";
    const originalCode = typeof failure.repairOriginalCode === "string"
      ? failure.repairOriginalCode.slice(0, 120)
      : typeof failure.code === "string"
        ? failure.code.slice(0, 120)
        : "source_runner_failed";
    return new AdapterError(
      `新加坡采集服务正在自动修复业务故障（${originalCode}）；事件 ${incidentId}；关联 ${trace.correlationId}`,
      "source_runner_repair_pending",
      503,
      true,
      typeof failure.retryAfterSeconds === "number"
        ? Math.max(60, Math.min(900, failure.retryAfterSeconds))
        : 120,
    );
  }
  return new AdapterError(
    typeof failure.message === "string"
      ? `${failure.message.slice(0, 430)}；关联 ${trace.correlationId}`
      : `新加坡采集服务请求失败 (${response.status})；关联 ${trace.correlationId}`,
    typeof failure.code === "string" ? failure.code.slice(0, 120) : "source_runner_failed",
    upstreamStatus,
    failure.retryable === true || response.status >= 500,
    typeof failure.retryAfterSeconds === "number" ? failure.retryAfterSeconds : undefined,
  );
}

async function signedPost(
  config: RunnerConfig,
  path: string,
  scope: string,
  body: unknown,
  fetcher: AdapterContext["fetch"],
  trace: RunnerTrace,
  signal: AbortSignal,
  requestId: string,
): Promise<{ response: Response; envelope: Record<string, unknown> }> {
  const timestamp = String(Date.now());
  const signature = await signServiceRequest(config.signingKey, scope, timestamp, body);
  let response: Response;
  try {
    response = await fetcher(new URL(path, config.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-JPGR-Timestamp": timestamp,
        "X-JPGR-Signature": signature,
        "X-JPGR-Request-ID": requestId,
      },
      body: canonicalJson(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
    throw new AdapterError(
      timedOut
        ? `新加坡采集任务请求超时；关联 ${trace.correlationId}`
        : `新加坡采集服务网络错误；关联 ${trace.correlationId}`,
      timedOut ? "source_runner_timeout" : "source_runner_network_error",
      undefined,
      true,
    );
  }
  const envelope = record(await readLimitedJson(response, trace));
  if (!response.ok || envelope.ok !== true) throw remoteFailure(response, envelope, trace);
  return { response, envelope };
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runJob(
  env: Env,
  sourceId: SourceRunnerSourceId,
  operation: RunnerOperation,
  body: unknown,
  fetcher: AdapterContext["fetch"],
  parentSignal?: AbortSignal,
): Promise<unknown> {
  const config = runnerConfig(env);
  if (!config) throw new AdapterError("新加坡采集服务尚未配置", "source_runner_not_configured");
  const trace: RunnerTrace = { correlationId: crypto.randomUUID(), sourceId, operation, startedAt: Date.now() };
  const timeout = AbortSignal.timeout(RUNNER_JOB_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const created = await signedPost(
    config,
    "v1/jobs",
    CREATE_SCOPE,
    body,
    fetcher,
    trace,
    signal,
    `${trace.correlationId}:create`,
  );
  const createData = record(created.envelope.data);
  const jobId = typeof createData.jobId === "string" && /^[0-9a-f-]{36}$/iu.test(createData.jobId)
    ? createData.jobId
    : undefined;
  if (!jobId) throw new AdapterError("新加坡采集服务没有返回任务 ID", "source_runner_invalid_response", 502, true);

  for (let poll = 1; !signal.aborted; poll += 1) {
    await delay(RUNNER_POLL_INTERVAL_MS, signal);
    const statusBody = { jobId };
    const status = await signedPost(
      config,
      "v1/jobs/status",
      STATUS_SCOPE,
      statusBody,
      fetcher,
      trace,
      signal,
      `${trace.correlationId}:poll-${poll}`,
    );
    const data = record(status.envelope.data);
    if (data.status === "queued" || data.status === "running") continue;
    if (data.status === "failed") {
      throw remoteFailure(status.response, { error: data.error }, trace);
    }
    if (data.status === "succeeded" && data.result !== undefined) {
      console.info(JSON.stringify({
        event: "source_runner_job_completed",
        sourceId,
        operation,
        correlationId: trace.correlationId,
        durationMs: Date.now() - trace.startedAt,
        polls: poll,
      }));
      return data.result;
    }
    throw new AdapterError("新加坡采集服务返回了无效任务状态", "source_runner_invalid_response", 502, true);
  }
  throw new AdapterError(
    `新加坡采集任务超时；关联 ${trace.correlationId}`,
    "source_runner_timeout",
    504,
    true,
  );
}

export async function searchWithSourceRunner(
  env: Env,
  sourceId: SourceRunnerSearchSourceId,
  request: SearchRequest,
  context: AdapterContext,
): Promise<SearchResult> {
  const body = { sourceId, operation: "search", request: runnerSearchRequest(sourceId, request) } as const;
  const result = await runJob(env, sourceId, "search", body, context.fetch, context.signal);
  const parsed = searchResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.sourceId !== sourceId
    || parsed.data.listings.some((listing) => listing.sourceId !== sourceId)) {
    throw new AdapterError("新加坡采集服务搜索结果结构不合法", "source_runner_invalid_response", 502, false);
  }
  return parsed.data;
}

export async function itemWithSourceRunner(
  env: Env,
  sourceId: Exclude<SourceRunnerSourceId, "yahoo_shopping">,
  urlOrId: string,
  context: AdapterContext,
): Promise<NormalizedListing> {
  const body = { sourceId, operation: "item", urlOrId } as const;
  const result = await runJob(env, sourceId, "item", body, context.fetch, context.signal);
  const parsed = normalizedListingSchema.safeParse(result);
  if (!parsed.success || parsed.data.sourceId !== sourceId) {
    throw new AdapterError("新加坡采集服务商品结果结构不合法", "source_runner_invalid_response", 502, false);
  }
  return parsed.data;
}
import type { RuntimeEnv as Env } from "./runtime-env";
