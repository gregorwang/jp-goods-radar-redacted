import {
  sha256Hex,
  type AdapterContext,
  type EmbeddedUpstreamResponseCapture,
  type SourceId,
} from "@jpgr/core";
import type { AnalyticsSourceCapture, AnalyticsSourcePayloadKind } from "@jpgr/analytics";
import type { OperationalDatabase, OperationalPreparedStatement } from "@jpgr/db";

// Bound capture work so hashing and JSON evidence cannot monopolize Worker memory.
const MAX_CAPTURE_BYTES = 1_500_000;
const MAX_EMBEDDED_CAPTURE_BYTES = 1_800_000;
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|access[-_]?token|application[-_]?id|affiliate[-_]?id|app[-_]?id|client[-_]?id|authorization|credential|password|secret|signature|x-goog-api-key)/iu;

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

function payloadKind(contentType: string | null, payload: string, readable: boolean): AnalyticsSourcePayloadKind {
  if (!readable) return "unreadable";
  if (payload.length === 0) return "empty";
  const normalized = contentType?.toLocaleLowerCase() ?? "";
  if (normalized.includes("json") || /^[\s\uFEFF]*(?:\{|\[)/u.test(payload)) return "json";
  if (normalized.includes("html") || /^\s*<!doctype\s+html|^\s*<html/iu.test(payload)) return "html";
  if (normalized.startsWith("text/") || normalized.includes("xml") || normalized.includes("javascript")) return "text";
  return "binary";
}

function persistedRawPayload(
  kind: AnalyticsSourcePayloadKind,
  payload: string,
): string | undefined {
  // HTML is useful only while the adapter parses it. Persist its size/hash and
  // transport metadata, not the complete page body.
  if (kind === "html" || kind === "binary") return undefined;
  return payload;
}

function isFirecrawlHtmlScrape(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.origin === "https://api.firecrawl.dev" && url.pathname === "/v2/scrape";
  } catch {
    return false;
  }
}

function firecrawlRawHtml(payload: string): string | undefined {
  try {
    const envelope = record(JSON.parse(payload) as unknown);
    const data = record(envelope?.data);
    return typeof data?.rawHtml === "string" ? data.rawHtml : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response: Response): Promise<{ payload: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { payload: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_CAPTURE_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel("raw_capture_limit_reached");
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel("raw_capture_limit_reached");
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { payload: new TextDecoder().decode(combined), bytes, truncated };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const EMBEDDED_CAPTURE_SOURCE_IDS = [
  "amiami",
  "mercari_jp",
  "surugaya",
  "yahoo_shopping",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
] as const satisfies readonly SourceId[];
type EmbeddedCaptureSourceId = (typeof EMBEDDED_CAPTURE_SOURCE_IDS)[number];

function isEmbeddedCaptureSourceId(value: string): value is EmbeddedCaptureSourceId {
  return (EMBEDDED_CAPTURE_SOURCE_IDS as readonly string[]).includes(value);
}

function safeEmbeddedUpstreamUrl(sourceId: EmbeddedCaptureSourceId, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    const allowed = sourceId === "amiami"
      ? url.hostname === "api.amiami.com" && ["/api/v1.0/items", "/api/v1.0/item"].includes(url.pathname)
      : sourceId === "mercari_jp"
      ? url.origin === "https://api.mercari.jp"
      : sourceId === "surugaya"
        ? url.hostname === "www.suruga-ya.jp"
        : sourceId === "yahoo_shopping"
          ? url.hostname === "shopping.yahoo.co.jp"
          : sourceId === "yahoo_auctions_jp"
            ? url.hostname === "auctions.yahoo.co.jp"
            : sourceId === "yahoo_fleamarket_jp"
              ? url.hostname === "paypayfleamarket.yahoo.co.jp"
              : false;
    if (!allowed) return undefined;
    return safeUrl(url.toString());
  } catch {
    return undefined;
  }
}

function embeddedCapture(sourceId: EmbeddedCaptureSourceId, value: unknown): EmbeddedUpstreamResponseCapture | null {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1) return null;
  const requestUrl = safeEmbeddedUpstreamUrl(sourceId, candidate.requestUrl);
  const requestMethod = candidate.requestMethod;
  const rawPayload = typeof candidate.rawPayload === "string" ? candidate.rawPayload : undefined;
  const rawBytes = rawPayload === undefined ? 0 : new TextEncoder().encode(rawPayload).byteLength;
  const responseStatus = typeof candidate.responseStatus === "number" && Number.isInteger(candidate.responseStatus)
    && candidate.responseStatus >= 100 && candidate.responseStatus <= 599
    ? candidate.responseStatus
    : undefined;
  const contentType = typeof candidate.contentType === "string" && /^[\w.+-]+\/[\w.+-]+$/u.test(candidate.contentType)
    ? candidate.contentType.slice(0, 120)
    : undefined;
  const capturedAt = typeof candidate.capturedAt === "string" && Number.isFinite(Date.parse(candidate.capturedAt))
    ? candidate.capturedAt
    : undefined;
  const durationMs = typeof candidate.durationMs === "number" && Number.isSafeInteger(candidate.durationMs)
    && candidate.durationMs >= 0
    ? candidate.durationMs
    : undefined;
  const contentHash = typeof candidate.contentHash === "string" && /^[a-f0-9]{64}$/u.test(candidate.contentHash)
    ? candidate.contentHash
    : undefined;
  if (!requestUrl || (requestMethod !== "GET" && requestMethod !== "POST") || !capturedAt || durationMs === undefined
      || !contentHash || rawBytes > MAX_EMBEDDED_CAPTURE_BYTES || typeof candidate.truncated !== "boolean") {
    return null;
  }
  return {
    version: 1,
    requestUrl,
    ...(safeEmbeddedUpstreamUrl(sourceId, candidate.responseUrl) ? { responseUrl: safeEmbeddedUpstreamUrl(sourceId, candidate.responseUrl) } : {}),
    requestMethod,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(contentType ? { contentType } : {}),
    ...(rawPayload === undefined ? {} : { rawPayload }),
    payloadBytes: rawPayload === undefined && typeof candidate.payloadBytes === "number" && Number.isSafeInteger(candidate.payloadBytes)
      && candidate.payloadBytes >= 0 ? candidate.payloadBytes : rawBytes,
    contentHash,
    capturedAt,
    durationMs,
    truncated: candidate.truncated === true,
    ...(typeof candidate.error === "string" ? { error: candidate.error.slice(0, 300) } : {}),
  };
}

export async function separateEmbeddedUpstreamCaptures(
  capture: AnalyticsSourceCapture,
): Promise<AnalyticsSourceCapture[]> {
  if (!isEmbeddedCaptureSourceId(capture.sourceId)
    || capture.payloadKind !== "json" || !capture.rawPayload) return [capture];
  const sourceId = capture.sourceId;
  let envelope: Record<string, unknown>;
  try {
    const parsed = record(JSON.parse(capture.rawPayload) as unknown);
    if (!parsed) return [capture];
    envelope = parsed;
  } catch {
    return [capture];
  }
  const meta = record(envelope.meta);
  if (!meta || !Array.isArray(meta.upstreamCaptures)) return [capture];
  const upstream = meta.upstreamCaptures
    .map((value) => embeddedCapture(sourceId, value))
    .filter((value): value is EmbeddedUpstreamResponseCapture => value !== null);
  delete meta.upstreamCaptures;
  envelope.meta = meta;
  const outerPayload = JSON.stringify(envelope);
  const outer: AnalyticsSourceCapture = {
    ...capture,
    rawPayload: outerPayload,
    payloadBytes: new TextEncoder().encode(outerPayload).byteLength,
    contentHash: await sha256Hex(outerPayload),
  };
  const extracted = await Promise.all(upstream.map(async (value): Promise<AnalyticsSourceCapture> => {
    const rawPayload = value.rawPayload ?? "";
    const contentHash = value.rawPayload === undefined ? value.contentHash : await sha256Hex(rawPayload);
    const hashMismatch = contentHash !== value.contentHash;
    const kind = value.rawPayload === undefined && value.contentType === "text/html"
      ? "html" : payloadKind(value.contentType ?? null, rawPayload, value.error === undefined);
    return {
      id: crypto.randomUUID(),
      sourceId,
      ordinal: 0,
      requestUrl: value.requestUrl,
      responseUrl: value.responseUrl,
      requestMethod: value.requestMethod,
      responseStatus: value.responseStatus,
      contentType: value.contentType,
      payloadKind: kind,
      rawPayload: persistedRawPayload(kind, rawPayload),
      payloadBytes: value.payloadBytes,
      contentHash,
      capturedAt: value.capturedAt,
      durationMs: value.durationMs,
      truncated: value.truncated,
      error: hashMismatch
        ? "embedded_capture_content_hash_mismatch"
        : value.error,
    };
  }));
  return [outer, ...extracted];
}

export interface SourceCaptureRecorder {
  fetch: AdapterContext["fetch"];
  wrap(baseFetch: AdapterContext["fetch"]): AdapterContext["fetch"];
  flush(): Promise<AnalyticsSourceCapture[]>;
}

export function createSourceCaptureRecorder(
  sourceId: SourceId,
  baseFetch: AdapterContext["fetch"],
): SourceCaptureRecorder {
  const pending: Array<Promise<AnalyticsSourceCapture[]>> = [];

  const wrap = (wrappedFetch: AdapterContext["fetch"]): AdapterContext["fetch"] => (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Evidence capture must never make an otherwise valid upstream request
    // fail. In particular, workerd can reject a second Request construction
    // for some POST signal/body combinations even though fetch accepts them.
    const requestUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
    const requestMethod = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const startedAt = Date.now();
    try {
      const response = await wrappedFetch(input, init);
      const capturedAt = new Date().toISOString();
      const clone = response.clone();
      pending.push((async () => {
        try {
          const body = await readBoundedBody(clone);
          const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
          // Firecrawl wraps the requested page in JSON as data.rawHtml. Treat
          // that response as HTML evidence so the envelope cannot become a
          // back door for persisting the complete page body.
          const firecrawlHtml = isFirecrawlHtmlScrape(requestUrl);
          const evidencePayload = firecrawlHtml
            ? firecrawlRawHtml(body.payload) ?? body.payload
            : body.payload;
          const kind = firecrawlHtml ? "html" : payloadKind(contentType ?? null, body.payload, true);
          const outer = {
            id: crypto.randomUUID(),
            sourceId,
            ordinal: 0,
            requestUrl: safeUrl(requestUrl),
            responseUrl: response.url ? safeUrl(response.url) : undefined,
            requestMethod,
            responseStatus: response.status,
            contentType: firecrawlHtml ? "text/html" : contentType || undefined,
            payloadKind: kind,
            rawPayload: persistedRawPayload(kind, evidencePayload),
            payloadBytes: new TextEncoder().encode(evidencePayload).byteLength,
            contentHash: await sha256Hex(evidencePayload),
            capturedAt,
            durationMs: Date.now() - startedAt,
            truncated: body.truncated,
          } satisfies AnalyticsSourceCapture;
          return separateEmbeddedUpstreamCaptures(outer);
        } catch (error) {
          return [{
            id: crypto.randomUUID(),
            sourceId,
            ordinal: 0,
            requestUrl: safeUrl(requestUrl),
            responseUrl: response.url ? safeUrl(response.url) : undefined,
            requestMethod,
            responseStatus: response.status,
            contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined,
            payloadKind: "unreadable",
            payloadBytes: 0,
            contentHash: await sha256Hex(""),
            capturedAt,
            durationMs: Date.now() - startedAt,
            truncated: false,
            error: error instanceof Error ? error.message.slice(0, 300) : "raw_response_unreadable",
          } satisfies AnalyticsSourceCapture];
        }
      })());
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "source_request_failed";
      pending.push(Promise.resolve([{
        id: crypto.randomUUID(),
        sourceId,
        ordinal: 0,
        requestUrl: safeUrl(requestUrl),
        requestMethod,
        payloadKind: "unreadable",
        payloadBytes: 0,
        contentHash: "request_failed",
        capturedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        truncated: false,
        error: message,
      }]));
      throw error;
    }
  }) as AdapterContext["fetch"];

  const recordingFetch = wrap(baseFetch);

  return {
    fetch: recordingFetch,
    wrap,
    async flush() {
      const captures = (await Promise.all(pending)).flat();
      return captures.map((capture, index) => ({ ...capture, ordinal: index + 1 }));
    },
  };
}

export function sourceCaptureStatements(
  db: OperationalDatabase,
  runId: string,
  captures: readonly AnalyticsSourceCapture[],
): OperationalPreparedStatement[] {
  return captures.map((capture) => db.prepare(
    `INSERT INTO source_response_captures(
       id,run_id,source_id,ordinal,request_url,response_url,request_method,response_status,
       content_type,payload_kind,raw_payload,payload_bytes,content_hash,captured_at,duration_ms,truncated,error_message
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    capture.id,
    runId,
    capture.sourceId,
    capture.ordinal,
    capture.requestUrl,
    capture.responseUrl ?? null,
    capture.requestMethod,
    capture.responseStatus ?? null,
    capture.contentType ?? null,
    capture.payloadKind,
    capture.payloadKind === "html" ? null : capture.rawPayload ?? null,
    capture.payloadBytes,
    capture.contentHash,
    capture.capturedAt,
    capture.durationMs,
    capture.truncated ? 1 : 0,
    capture.error ?? null,
  ));
}

export async function stageSourceCaptures(
  db: OperationalDatabase,
  runId: string,
  captures: readonly AnalyticsSourceCapture[],
): Promise<void> {
  if (captures.length === 0) return;
  const statements = sourceCaptureStatements(db, runId, captures);
  // 采集元数据与结构化响应证据是尽力而为：单条超大 capture 或单块失败绝不能连带拖垮采集主流程，
  // 因此按小块分批写入并逐块吞错（batch 是事务，整批写会被一条坏行整体回滚）。
  for (let index = 0; index < statements.length; index += 5) {
    try {
      await db.batch(statements.slice(index, index + 5));
    } catch (error) {
      console.error(JSON.stringify({
        event: "source_capture_batch_failed",
        runId,
        offset: index,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }
}
