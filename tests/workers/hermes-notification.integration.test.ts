/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { RadarRepository } from "@jpgr/db";
import { afterEach, describe, expect, it } from "vitest";
import { deliverPendingHermesNotifications } from "../../apps/collector/src/hermes-delivery";
import { testDatabase } from "./postgres";

const webhookUrl = "https://hermes.example.test/webhooks/jp-goods-radar";
const webhookSecret = "w".repeat(64);

function configureHermes(enabled: boolean): void {
  Reflect.set(env, "HERMES_NOTIFICATIONS_ENABLED", enabled ? "true" : "false");
  Reflect.set(env, "HERMES_WEBHOOK_URL", webhookUrl);
  Reflect.set(env, "HERMES_WEBHOOK_SECRET", webhookSecret);
}

async function insertSourceError(id: string, createdAt: string): Promise<void> {
  await testDatabase.prepare(
    `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
     VALUES(?,?, 'source_error',?,'pending',?)`,
  ).bind(
    id,
    `source_error:surugaya:${id}`,
    JSON.stringify({ sourceId: "surugaya", message: "连续抓取失败", failures: 3 }),
    createdAt,
  ).run();
}

afterEach(() => {
  configureHermes(false);
});

describe("Hermes notification delivery ledger", () => {
  it("delivers only post-activation events and keeps email state independent", async () => {
    configureHermes(true);
    await insertSourceError("historical-event", new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString());
    await insertSourceError("current-event", new Date().toISOString());
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ status: "delivered", delivery_id: "weixin-delivery-1" });
    };
    const repository = new RadarRepository(testDatabase);

    await expect(deliverPendingHermesNotifications(env, repository, fetcher)).resolves.toBe(1);
    await expect(deliverPendingHermesNotifications(env, repository, fetcher)).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    const body: unknown = await requests[0]?.json();
    expect(body).toMatchObject({
      event_type: "jp_goods_radar.notification",
      notification_type: "source_error",
      source: "jp-goods-radar",
    });
    const deliveries = await testDatabase.prepare(
      "SELECT event_id,status,attempts,remote_id remote_delivery_id FROM notice_deliveries WHERE channel='hermes' ORDER BY event_id",
    ).all<{ event_id: string; status: string; attempts: number; remote_delivery_id: string | null }>();
    expect(deliveries.results).toEqual([{
      event_id: "current-event",
      status: "sent",
      attempts: 1,
      remote_delivery_id: "weixin-delivery-1",
    }]);
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM notice_deliveries WHERE channel='email'").first<{ count: number }>())
      .toEqual({ count: 0 });
    const events = await testDatabase.prepare("SELECT id,status FROM events ORDER BY id").all<{ id: string; status: string }>();
    expect(events.results).toEqual([
      { id: "current-event", status: "pending" },
      { id: "historical-event", status: "pending" },
    ]);
  });

  it("records a failed Hermes request without failing or mutating the source event", async () => {
    configureHermes(true);
    await insertSourceError("failed-event", new Date().toISOString());
    const repository = new RadarRepository(testDatabase);
    const fetcher: typeof fetch = async () => new Response("weixin unavailable", { status: 502 });

    await expect(deliverPendingHermesNotifications(env, repository, fetcher)).resolves.toBe(0);

    const delivery = await testDatabase.prepare(
      "SELECT status,attempts,last_http_status,last_error,next_attempt_at FROM notice_deliveries WHERE channel='hermes' AND event_id=?",
    ).bind("failed-event").first<{
      status: string;
      attempts: number;
      last_http_status: number | null;
      last_error: string | null;
      next_attempt_at: string | null;
    }>();
    expect(delivery).toMatchObject({ status: "failed", attempts: 1, last_http_status: 502 });
    expect(delivery?.last_error).toContain("weixin unavailable");
    expect(Date.parse(delivery?.next_attempt_at ?? "")).toBeGreaterThan(Date.now());
    expect(await testDatabase.prepare("SELECT status FROM events WHERE id='failed-event'").first<{ status: string }>())
      .toEqual({ status: "pending" });
  });

  it("does nothing while the Hermes channel is disabled", async () => {
    configureHermes(false);
    await insertSourceError("disabled-event", new Date().toISOString());
    const fetcher: typeof fetch = async () => {
      throw new Error("disabled channel must not fetch");
    };
    await expect(deliverPendingHermesNotifications(env, new RadarRepository(testDatabase), fetcher)).resolves.toBe(0);
    expect(await testDatabase.prepare("SELECT COUNT(*) count FROM notification_channels").first<{ count: number }>())
      .toEqual({ count: 0 });
  });
});
