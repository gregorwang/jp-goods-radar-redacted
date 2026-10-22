export const HERMES_NOTIFICATION_EVENT_TYPE = "jp_goods_radar.notification" as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const MIN_SECRET_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface HermesNotificationPayload {
  event_type: typeof HERMES_NOTIFICATION_EVENT_TYPE;
  event_key: string;
  notification_type: string;
  message: string;
  occurred_at: string;
  source: "jp-goods-radar";
}

export interface SendHermesNotificationInput {
  url: string;
  secret: string;
  requestId: string;
  payload: HermesNotificationPayload;
  timeoutMs?: number;
}

export interface HermesDeliveryReceipt {
  deliveryId: string;
  duplicate: boolean;
  httpStatus: number;
}

export class HermesWebhookError extends Error {
  readonly httpStatus: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, httpStatus: number, retryAfterSeconds: number | null) {
    super(message);
    this.name = "HermesWebhookError";
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hermes Webhook URL 无效");
  }
  if (url.protocol !== "https:") throw new Error("Hermes Webhook 必须使用 HTTPS");
  if (url.username || url.password) throw new Error("Hermes Webhook URL 不得包含凭据");
  if (!url.pathname.startsWith("/webhooks/")) throw new Error("Hermes Webhook URL 路径必须以 /webhooks/ 开头");
  url.hash = "";
  return url.href;
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hermesWebhookSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  if (encoder.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error(`Hermes Webhook Secret 至少需要 ${MIN_SECRET_BYTES} 字节`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return bytesToHex(signature);
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let offset = 0;
  let finished = false;
  try {
    while (offset < bytes.byteLength) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      const remaining = bytes.byteLength - offset;
      const value = chunk.value.subarray(0, remaining);
      bytes.set(value, offset);
      offset += value.byteLength;
      if (value.byteLength < chunk.value.byteLength) break;
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The bounded response has already been captured; cancellation errors are non-actionable.
      }
    }
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, offset));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : null;
}

function errorDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function sendHermesNotification(
  input: SendHermesNotificationInput,
  fetcher: typeof fetch = fetch,
): Promise<HermesDeliveryReceipt> {
  const url = normalizedWebhookUrl(input.url);
  const body = JSON.stringify(input.payload);
  if (byteLength(body) > MAX_REQUEST_BYTES) throw new Error("Hermes 通知超过 64 KiB 上限");
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await hermesWebhookSignature(input.secret, timestamp, body);
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 20_000));
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": input.requestId,
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature-V2": signature,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await boundedResponseText(response);
  if (!response.ok) {
    const detail = errorDetail(responseText);
    throw new HermesWebhookError(
      `Hermes Webhook 请求失败 (${response.status})${detail ? `：${detail}` : ""}`,
      response.status,
      parsedRetryAfter(response.headers.get("Retry-After")),
    );
  }

  let responseBody: unknown;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = null;
  }
  const record = recordValue(responseBody);
  const deliveryId = typeof record?.delivery_id === "string" && record.delivery_id
    ? record.delivery_id
    : input.requestId;
  return {
    deliveryId,
    duplicate: record?.status === "duplicate",
    httpStatus: response.status,
  };
}
