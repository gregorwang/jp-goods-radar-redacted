import { AdapterError, classifySurugayaSearchHtml, getAdapter, getRakutenIchibaItemFromPage } from "@jpgr/adapters";
import type {
  AdapterContext,
  EmbeddedUpstreamResponseCapture,
  NormalizedListing,
  SearchRequest,
  SearchResult,
} from "@jpgr/core";
import { normalizedListingSchema, searchResultSchema } from "@jpgr/validation";
import { AdaptiveSourceTransport } from "./adaptive-fetch";
import { fetchAmiamiWithChrome } from "./amiami-fetch";
import type { CreateJobBody } from "./schemas";

const JOB_TIMEOUT_MS = 100_000;
const MAX_SURUGAYA_404_BYTES = 2_000_000;

export interface RunnerJobError {
  code: string;
  message: string;
  upstreamStatus: number | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  repairStatus?: "pending" | "repairing";
  repairIncidentId?: string;
  repairOriginalCode?: string;
}

export type RunnerJobResult = SearchResult | NormalizedListing;

export type RunnerExecutionOutcome =
  | { ok: true; result: RunnerJobResult; captures: readonly EmbeddedUpstreamResponseCapture[] }
  | { ok: false; error: RunnerJobError; captures: readonly EmbeddedUpstreamResponseCapture[] };

const RUNNER_SECRETS = {
  YAHOO_WEB_EXPERIMENTAL_ENABLED: "true",
  YAHOO_WEB_EXPERIMENTAL_MAX_PAGES: "3",
  YAHOO_WEB_EXPERIMENTAL_DELAY_MS: "2000",
  YAHOO_AUCTIONS_EXPERIMENTAL_ENABLED: "true",
  YAHOO_AUCTIONS_TIMEOUT_MS: "20000",
  YAHOO_AUCTIONS_RATE_INTERVAL_MS: "2000",
} as const;

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) {
    await response.body?.cancel("source_runner_response_too_large").catch(() => undefined);
    throw new AdapterError("骏河屋 404 页面超过安全上限", "response_too_large", 404, false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("source_runner_response_too_large");
        throw new AdapterError("骏河屋 404 页面超过安全上限", "response_too_large", 404, false);
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

async function searchSurugaya(
  request: SearchRequest,
  context: AdapterContext,
): Promise<SearchResult> {
  const adapter = getAdapter("surugaya");
  if (!adapter) throw new AdapterError("骏河屋适配器不可用", "source_runner_adapter_unavailable", 500, true);
  const upstreamFetch = context.fetch;
  const exactFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await upstreamFetch(input, init);
    if (response.status !== 404) return response;
    const html = await boundedResponseText(response, MAX_SURUGAYA_404_BYTES);
    if (classifySurugayaSearchHtml(html).kind !== "verified_empty") {
      throw new AdapterError("骏河屋完整关键词搜索未命中 (404)", "surugaya_exact_query_not_found", 404, false);
    }
    const normalized = new Response(html, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "text/html; charset=utf-8",
        "X-JPGR-Upstream-Status": "404",
        "X-JPGR-Collection-Outcome": "verified_empty",
      },
    });
    if (response.url) Object.defineProperty(normalized, "url", { configurable: true, value: response.url });
    return normalized;
  }) as typeof fetch;
  return adapter.search(request, { ...context, fetch: exactFetch });
}

function jobError(error: unknown): RunnerJobError {
  const adapterError = error instanceof AdapterError ? error : undefined;
  return {
    code: adapterError?.code ?? "source_runner_execution_failed",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : "来源采集任务发生未知错误",
    upstreamStatus: adapterError?.status ?? null,
    retryable: adapterError?.retryable ?? true,
    retryAfterSeconds: adapterError?.retryAfterSeconds ?? null,
  };
}

export async function executeRunnerTask(task: CreateJobBody): Promise<RunnerExecutionOutcome> {
  const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
  const transport = new AdaptiveSourceTransport(task.sourceId, signal, task.sourceId === "amiami" ? { baseFetch: fetchAmiamiWithChrome } : {});
  try {
    const adapter = getAdapter(task.sourceId);
    if (!adapter) throw new AdapterError("来源适配器不可用", "source_runner_adapter_unavailable", 500, true);
    const context: AdapterContext = { fetch: transport.fetch, secrets: RUNNER_SECRETS, signal };
    if (task.operation === "search") {
      const result = task.sourceId === "surugaya"
        ? await searchSurugaya(task.request, context)
        : await adapter.search(task.request, context);
      const parsed = searchResultSchema.safeParse(result);
      if (!parsed.success || parsed.data.sourceId !== task.sourceId) {
        throw new AdapterError("来源采集结果结构不合法", "source_runner_invalid_result", 502, false);
      }
      return { ok: true, result: parsed.data, captures: [...transport.captures] };
    }
    if (!adapter.getItem) throw new AdapterError("来源不支持单品查询", "item_lookup_unsupported", 409, false);
    const result = task.sourceId === "rakuten_ichiba"
      ? await getRakutenIchibaItemFromPage(task.urlOrId, context)
      : await adapter.getItem(task.urlOrId, context);
    const parsed = normalizedListingSchema.safeParse(result);
    if (!parsed.success || parsed.data.sourceId !== task.sourceId) {
      throw new AdapterError("来源商品结果结构不合法", "source_runner_invalid_result", 502, false);
    }
    return { ok: true, result: parsed.data, captures: [...transport.captures] };
  } catch (error) {
    return { ok: false, error: jobError(error), captures: [...transport.captures] };
  }
}
