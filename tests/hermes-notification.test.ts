import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_NOTIFICATION_EVENT_TYPE,
  HermesWebhookError,
  hermesWebhookSignature,
  sendHermesNotification,
  type HermesNotificationPayload,
} from "../packages/notifications/src/hermes";

const secret = "h".repeat(64);
const payload = {
  event_type: HERMES_NOTIFICATION_EVENT_TYPE,
  event_key: "source_error:surugaya:2026-07-22",
  notification_type: "source_error",
  message: "【格银西里尔】来源连续故障：骏河屋",
  occurred_at: "2026-07-22T01:02:03.000Z",
  source: "jp-goods-radar",
} satisfies HermesNotificationPayload;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hermes webhook delivery", () => {
  it("signs the exact body with the V2 timestamp scheme", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ status: "delivered", delivery_id: "delivery-123" });
    });

    const receipt = await sendHermesNotification({
      url: "https://hermes.example.test/webhooks/jp-goods-radar",
      secret,
      requestId: "hermes_weixin:event-123",
      payload,
    });

    expect(receipt).toEqual({ deliveryId: "delivery-123", duplicate: false, httpStatus: 200 });
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("X-Request-ID")).toBe("hermes_weixin:event-123");
    const timestamp = request?.headers.get("X-Webhook-Timestamp");
    const signature = request?.headers.get("X-Webhook-Signature-V2");
    const body = await request?.text();
    expect(timestamp).toMatch(/^\d+$/);
    expect(body).toBe(JSON.stringify(payload));
    expect(signature).toBe(await hermesWebhookSignature(secret, timestamp ?? "", body ?? ""));
  });

  it("treats Hermes duplicate acknowledgements as successful delivery", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ status: "duplicate", delivery_id: "delivery-original" }));
    await expect(sendHermesNotification({
      url: "https://hermes.example.test/webhooks/jp-goods-radar",
      secret,
      requestId: "hermes_weixin:event-duplicate",
      payload,
    })).resolves.toEqual({ deliveryId: "delivery-original", duplicate: true, httpStatus: 200 });
  });

  it("preserves a bounded upstream error and Retry-After", async () => {
    vi.stubGlobal("fetch", async () => new Response("gateway unavailable", {
      status: 502,
      headers: { "Retry-After": "120" },
    }));
    const error = await sendHermesNotification({
      url: "https://hermes.example.test/webhooks/jp-goods-radar",
      secret,
      requestId: "hermes_weixin:event-502",
      payload,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HermesWebhookError);
    if (!(error instanceof HermesWebhookError)) throw new Error("Expected HermesWebhookError");
    expect(error).toMatchObject({ httpStatus: 502, retryAfterSeconds: 120 });
    expect(error.message).toContain("gateway unavailable");
  });

  it("rejects insecure endpoints and weak secrets before sending", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(sendHermesNotification({
      url: "http://hermes.example.test/webhooks/jp-goods-radar",
      secret,
      requestId: "hermes_weixin:event-http",
      payload,
    })).rejects.toThrow("HTTPS");
    await expect(sendHermesNotification({
      url: "https://hermes.example.test/webhooks/jp-goods-radar",
      secret: "too-short",
      requestId: "hermes_weixin:event-secret",
      payload,
    })).rejects.toThrow("至少需要 32 字节");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
