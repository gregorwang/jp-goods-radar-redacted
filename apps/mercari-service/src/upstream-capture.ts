import type { EmbeddedUpstreamResponseCapture } from "../../../packages/core/src/index.js";

const MAX_CAPTURE_BYTES = 700_000;
const MAX_TOTAL_CAPTURE_BYTES = 900_000;
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|access[-_]?token|authorization|credential|password|secret|signature)/iu;

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

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function boundedBody(response: Response, limit: number): Promise<{
  rawPayload: string;
  payloadBytes: number;
  truncated: boolean;
}> {
  if (!response.body || limit <= 0) return { rawPayload: "", payloadBytes: 0, truncated: limit <= 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let payloadBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - payloadBytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel("mercari_upstream_capture_limit");
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        payloadBytes += remaining;
        truncated = true;
        await reader.cancel("mercari_upstream_capture_limit");
        break;
      }
      chunks.push(value);
      payloadBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(payloadBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { rawPayload: new TextDecoder().decode(bytes), payloadBytes, truncated };
}

export interface MercariUpstreamCaptureRecorder {
  fetch: typeof fetch;
  flush(): Promise<EmbeddedUpstreamResponseCapture[]>;
}

export function createMercariUpstreamCaptureRecorder(baseFetch: typeof fetch): MercariUpstreamCaptureRecorder {
  const pending: Array<Promise<EmbeddedUpstreamResponseCapture | null>> = [];
  let sequence = Promise.resolve();
  let capturedBytes = 0;

  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const startedAt = Date.now();
    try {
      const response = await baseFetch(input, init);
      if (new URL(request.url).origin !== "https://api.mercari.jp") return response;
      const clone = response.clone();
      let resolveCapture!: (capture: EmbeddedUpstreamResponseCapture | null) => void;
      const capturePromise = new Promise<EmbeddedUpstreamResponseCapture | null>((resolve) => {
        resolveCapture = resolve;
      });
      pending.push(capturePromise);
      sequence = sequence.then(async () => {
        const capturedAt = new Date().toISOString();
        try {
          const available = Math.max(0, MAX_TOTAL_CAPTURE_BYTES - capturedBytes);
          const body = await boundedBody(clone, Math.min(MAX_CAPTURE_BYTES, available));
          capturedBytes += body.payloadBytes;
          resolveCapture({
            version: 1,
            requestUrl: safeUrl(request.url),
            ...(response.url ? { responseUrl: safeUrl(response.url) } : {}),
            requestMethod: request.method === "POST" ? "POST" : "GET",
            responseStatus: response.status,
            ...(response.headers.get("content-type")?.split(";", 1)[0]?.trim()
              ? { contentType: response.headers.get("content-type")!.split(";", 1)[0]!.trim().slice(0, 120) }
              : {}),
            rawPayload: body.rawPayload,
            payloadBytes: body.payloadBytes,
            contentHash: await sha256(body.rawPayload),
            capturedAt,
            durationMs: Math.max(0, Date.now() - startedAt),
            truncated: body.truncated || available === 0,
          });
        } catch (error) {
          resolveCapture({
            version: 1,
            requestUrl: safeUrl(request.url),
            ...(response.url ? { responseUrl: safeUrl(response.url) } : {}),
            requestMethod: request.method === "POST" ? "POST" : "GET",
            responseStatus: response.status,
            payloadBytes: 0,
            contentHash: await sha256(""),
            capturedAt,
            durationMs: Math.max(0, Date.now() - startedAt),
            truncated: false,
            error: error instanceof Error ? error.message.slice(0, 300) : "mercari_upstream_unreadable",
          });
        }
      });
      return response;
    } catch (error) {
      if (new URL(request.url).origin === "https://api.mercari.jp") {
        pending.push(Promise.resolve({
          version: 1,
          requestUrl: safeUrl(request.url),
          requestMethod: request.method === "POST" ? "POST" : "GET",
          payloadBytes: 0,
          contentHash: await sha256(""),
          capturedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "mercari_upstream_request_failed",
        } satisfies EmbeddedUpstreamResponseCapture));
      }
      throw error;
    }
  }) as typeof fetch;

  return {
    fetch: recordingFetch,
    async flush() {
      await sequence;
      return (await Promise.all(pending)).filter((capture): capture is EmbeddedUpstreamResponseCapture => capture !== null);
    },
  };
}
