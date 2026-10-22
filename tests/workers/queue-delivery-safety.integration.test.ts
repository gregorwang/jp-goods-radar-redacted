/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../apps/collector/src/index";
import { enqueuePendingAnalytics } from "../../apps/collector/src/analytics";
import type { IngestAnalyticsJob, MonitorJob } from "@jpgr/core";
import { RadarRepository } from "@jpgr/db";
import { testDatabase } from "./postgres";

describe("Queue delivery safety", () => {
  it("claims one delivery, defers a concurrent duplicate, and seals a completed key", async () => {
    const repository = new RadarRepository(testDatabase);
    const input = {
      queueName: "jp-goods-radar-jobs",
      idempotencyKey: "test:claim:one",
      messageId: "message-one",
      messageType: "ingest_analytics",
      deliveryAttempt: 1,
      processingLeaseCutoff: new Date(Date.now() - 8 * 60_000).toISOString(),
    };

    await expect(repository.claimQueueMessage(input)).resolves.toBe("claimed");
    await expect(repository.claimQueueMessage({ ...input, messageId: "message-two" })).resolves.toBe("busy");
    await repository.completeQueueMessage(input.queueName, input.idempotencyKey);
    await expect(repository.claimQueueMessage({ ...input, deliveryAttempt: 2 })).resolves.toBe("completed");
  });

  it("acks a duplicate only after the original dispatch is completed", async () => {
    const body: IngestAnalyticsJob = {
      type: "ingest_analytics",
      idempotencyKey: "test:completed-dispatch",
      outboxId: "outbox-that-does-not-exist",
      queuedAt: new Date().toISOString(),
    };
    const first = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "completed-dispatch-first",
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);
    const firstContext = createExecutionContext();
    await worker.queue(first, env);
    expect((await getQueueResult(first, firstContext)).explicitAcks).toEqual(["completed-dispatch-first"]);

    const duplicate = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "completed-dispatch-duplicate",
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);
    const duplicateContext = createExecutionContext();
    await worker.queue(duplicate, env);
    expect((await getQueueResult(duplicate, duplicateContext)).explicitAcks).toEqual(["completed-dispatch-duplicate"]);

    const receipt = await testDatabase.prepare(
      `SELECT status,deliveries FROM queue_message_receipts
       WHERE queue_name='jp-goods-radar-jobs' AND idempotency_key=?`,
    ).bind(body.idempotencyKey).first<{ status: string; deliveries: number }>();
    expect(receipt).toEqual({ status: "completed", deliveries: 1 });
  });

  it("persists a non-retryable routing failure instead of silently acknowledging it", async () => {
    const body: MonitorJob = {
      type: "run_binding",
      idempotencyKey: "test:wrong-consumer",
      bindingId: "not-run",
      trigger: "manual",
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-gemini", [{
      id: "wrong-consumer-message",
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["wrong-consumer-message"]);
    const deadLetter = await testDatabase.prepare(
      `SELECT queue_name,dead_letter_queue_name,message_type,last_error
       FROM queue_dead_letters WHERE idempotency_key=?`,
    ).bind(body.idempotencyKey).first<Record<string, unknown>>();
    expect(deadLetter).toMatchObject({
      queue_name: "jp-goods-radar-gemini",
      dead_letter_queue_name: "jp-goods-radar-gemini-dlq",
      message_type: "run_binding",
      last_error: "queue_message_routed_to_wrong_consumer",
    });
  });

  it("stores an exhausted analytics message and prevents the outbox scheduler from resurrecting it", async () => {
    const now = new Date().toISOString();
    await testDatabase.prepare(
      `INSERT INTO analytics_outbox(
         id,kind,reference_id,status,attempts,created_at,updated_at
       ) VALUES(?, 'preview_search', ?, 'queued', 4, ?, ?)`,
    ).bind("dead-outbox", "missing-history", now, now).run();
    const body: IngestAnalyticsJob = {
      type: "ingest_analytics",
      idempotencyKey: "ingest_analytics:dead-outbox",
      outboxId: "dead-outbox",
      queuedAt: now,
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-dlq", [{
      id: "dead-outbox-message",
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["dead-outbox-message"]);
    expect(await testDatabase.prepare(
      "SELECT status,last_error FROM analytics_outbox WHERE id='dead-outbox'",
    ).first()).toEqual({
      status: "skipped",
      last_error: "queue_dead_lettered:jp-goods-radar-dlq",
    });
    expect(await enqueuePendingAnalytics(env)).toBe(0);
    expect(await testDatabase.prepare(
      `SELECT queue_name,dead_letter_queue_name,body_json
       FROM queue_dead_letters WHERE idempotency_key=?`,
    ).bind(body.idempotencyKey).first()).toMatchObject({
      queue_name: "jp-goods-radar-jobs",
      dead_letter_queue_name: "jp-goods-radar-dlq",
      body_json: JSON.stringify(body),
    });
  });

  it("reclaims an outbox row left processing by a dead Queue isolate", async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await testDatabase.prepare(
      `INSERT INTO analytics_outbox(
         id,kind,reference_id,status,attempts,created_at,updated_at
       ) VALUES(?, 'listing_backfill', ?, 'processing', 1, ?, ?)`,
    ).bind("stale-processing-outbox", "missing-listing", stale, stale).run();
    const body: IngestAnalyticsJob = {
      type: "ingest_analytics",
      idempotencyKey: "ingest_analytics:stale-processing-outbox",
      outboxId: "stale-processing-outbox",
      queuedAt: new Date().toISOString(),
    };
    const batch = createMessageBatch<MonitorJob>("jp-goods-radar-jobs", [{
      id: "stale-processing-message",
      timestamp: new Date(),
      attempts: 2,
      body,
    }]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["stale-processing-message"]);
    expect(await testDatabase.prepare(
      "SELECT status,attempts,last_error FROM analytics_outbox WHERE id=?",
    ).bind("stale-processing-outbox").first()).toEqual({
      status: "skipped",
      attempts: 2,
      last_error: "listing_not_available",
    });
    expect(await testDatabase.prepare(
      `SELECT status FROM queue_message_receipts
       WHERE queue_name='jp-goods-radar-jobs' AND idempotency_key=?`,
    ).bind(body.idempotencyKey).first()).toEqual({ status: "completed" });
  });
});
