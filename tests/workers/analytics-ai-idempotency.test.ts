/// <reference path="../../apps/collector/worker-configuration.d.ts" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { ingestAnalyticsAiProcessingBatch } from "@jpgr/analytics";

type BatchStatus = "parsed" | "partial" | "unparsed";

function createFixture() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const sourceItemId = `idempotent-${suffix}`;
  const inputHash = suffix.padEnd(64, "0").slice(0, 64);
  const observedAt = new Date().toISOString();
  const listing = {
    sourceId: "mercari_jp",
    sourceItemId,
    identityScope: "listing" as const,
    canonicalUrl: `https://jp.mercari.com/item/${sourceItemId}`,
    title: "AI batch idempotency fixture",
    currency: "JPY",
    currentPrice: 1_000,
    priceBasis: "listing_price" as const,
    condition: "used",
    availability: "available" as const,
    facts: {},
    rawMetadata: {},
  };

  const payload = ({
    batchId,
    rawResponse,
    status,
    summary,
  }: {
    batchId: string;
    rawResponse: string;
    status: BatchStatus;
    summary?: string;
  }) => ({
    batchId,
    batch: {
      purpose: "listing_semantics" as const,
      provider: "google-ai-studio",
      model: "gemini-idempotency-test",
      promptVersion: "idempotency:v2",
      inputHash,
      input: { sourceItemId },
      rawResponse,
      status,
      metadata: { test: true },
      observedAt,
    },
    records: summary === undefined ? [] : [{
      listing,
      purpose: "listing_semantics" as const,
      provider: "google-ai-studio",
      model: "gemini-idempotency-test",
      promptVersion: "idempotency:v2",
      inputHash,
      input: { sourceItemId },
      output: { summary },
      evidence: {},
      confidence: "high" as const,
      metadata: { test: true },
      observedAt,
    }],
  });

  return { inputHash, observedAt, payload, sourceItemId, suffix };
}

async function connectAnalytics() {
  const connection = new Client({
    connectionString: env.ANALYTICS_DB.connectionString,
  });
  await connection.connect();
  return connection;
}

describe("analytics AI batch idempotency", () => {
  it("preserves an unparsed attempt and links recovered output to its parsed retry", async () => {
    const fixture = createFixture();
    const firstBatchId = `${"1".repeat(32)}${fixture.suffix}`;
    const retryBatchId = `${"2".repeat(32)}${fixture.suffix}`;

    await ingestAnalyticsAiProcessingBatch(
      env.ANALYTICS_DB.connectionString,
      fixture.payload({
        batchId: firstBatchId,
        rawResponse: "unparsed-response",
        status: "unparsed",
      }),
    );
    await ingestAnalyticsAiProcessingBatch(
      env.ANALYTICS_DB.connectionString,
      fixture.payload({
        batchId: retryBatchId,
        rawResponse: "recovered-response",
        status: "parsed",
        summary: "recovered",
      }),
    );

    const connection = await connectAnalytics();
    try {
      const batches = await connection.query<{
        batch_id: string;
        parsed_count: number;
        raw_response: string;
        status: string;
      }>(
        `SELECT batch_id,raw_response,status,parsed_count
         FROM radar_analytics.ai_processing_batches
         WHERE purpose='listing_semantics'
           AND provider='google-ai-studio'
           AND model='gemini-idempotency-test'
           AND prompt_version='idempotency:v2'
           AND input_hash=$1
         ORDER BY batch_id`,
        [fixture.inputHash],
      );
      expect(batches.rows).toEqual([
        {
          batch_id: firstBatchId,
          raw_response: "unparsed-response",
          status: "unparsed",
          parsed_count: 0,
        },
        {
          batch_id: retryBatchId,
          raw_response: "recovered-response",
          status: "parsed",
          parsed_count: 1,
        },
      ]);

      const enrichments = await connection.query<{
        batch_id: string;
        summary: string;
      }>(
        `SELECT enrichment.batch_id,enrichment.output->>'summary' summary
         FROM radar_analytics.ai_enrichments AS enrichment
         JOIN radar_analytics.source_listings AS listing
           ON listing.id=enrichment.source_listing_id
         WHERE listing.source_id='mercari_jp'
           AND listing.source_item_id=$1
           AND enrichment.input_hash=$2`,
        [fixture.sourceItemId, fixture.inputHash],
      );
      expect(enrichments.rows).toEqual([{
        batch_id: retryBatchId,
        summary: "recovered",
      }]);
    } finally {
      await connection.end();
    }
  });

  it("keeps distinct parsed response evidence while retaining the first sequential projection", async () => {
    const fixture = createFixture();
    const firstBatchId = `${"1".repeat(32)}${fixture.suffix}`;
    const retryBatchId = `${"2".repeat(32)}${fixture.suffix}`;

    await ingestAnalyticsAiProcessingBatch(
      env.ANALYTICS_DB.connectionString,
      fixture.payload({
        batchId: firstBatchId,
        rawResponse: "first-response",
        status: "parsed",
        summary: "first",
      }),
    );
    await ingestAnalyticsAiProcessingBatch(
      env.ANALYTICS_DB.connectionString,
      fixture.payload({
        batchId: retryBatchId,
        rawResponse: "retry-response",
        status: "parsed",
        summary: "retry",
      }),
    );

    const connection = await connectAnalytics();
    try {
      const batches = await connection.query<{
        batch_id: string;
        raw_response: string;
      }>(
        `SELECT batch_id,raw_response
         FROM radar_analytics.ai_processing_batches
         WHERE purpose='listing_semantics'
           AND provider='google-ai-studio'
           AND model='gemini-idempotency-test'
           AND prompt_version='idempotency:v2'
           AND input_hash=$1
         ORDER BY batch_id`,
        [fixture.inputHash],
      );
      expect(batches.rows).toEqual([
        { batch_id: firstBatchId, raw_response: "first-response" },
        { batch_id: retryBatchId, raw_response: "retry-response" },
      ]);

      const enrichments = await connection.query<{
        batch_id: string;
        summary: string;
      }>(
        `SELECT enrichment.batch_id,enrichment.output->>'summary' summary
         FROM radar_analytics.ai_enrichments AS enrichment
         JOIN radar_analytics.source_listings AS listing
           ON listing.id=enrichment.source_listing_id
         WHERE listing.source_id='mercari_jp'
           AND listing.source_item_id=$1
           AND enrichment.input_hash=$2`,
        [fixture.sourceItemId, fixture.inputHash],
      );
      expect(enrichments.rows).toEqual([{
        batch_id: firstBatchId,
        summary: "first",
      }]);
    } finally {
      await connection.end();
    }
  });

  it("deduplicates concurrent exact replays and rejects batch-id evidence drift", async () => {
    const fixture = createFixture();
    const batchId = `${"3".repeat(32)}${fixture.suffix}`;
    const payload = fixture.payload({
      batchId,
      rawResponse: "exact-response",
      status: "parsed",
      summary: "exact",
    });

    await Promise.all([
      ingestAnalyticsAiProcessingBatch(env.ANALYTICS_DB.connectionString, payload),
      ingestAnalyticsAiProcessingBatch(env.ANALYTICS_DB.connectionString, payload),
    ]);

    await expect(ingestAnalyticsAiProcessingBatch(
      env.ANALYTICS_DB.connectionString,
      {
        ...payload,
        batch: {
          ...payload.batch,
          rawResponse: "different-response-with-reused-id",
        },
      },
    )).rejects.toThrow(/collision or inconsistent replay/);

    const connection = await connectAnalytics();
    try {
      const counts = await connection.query<{
        batch_count: string;
        enrichment_count: string;
      }>(
        `SELECT
           (SELECT count(*) FROM radar_analytics.ai_processing_batches
             WHERE batch_id=$1) AS batch_count,
           (SELECT count(*) FROM radar_analytics.ai_enrichments AS enrichment
             JOIN radar_analytics.source_listings AS listing
               ON listing.id=enrichment.source_listing_id
             WHERE listing.source_id='mercari_jp'
               AND listing.source_item_id=$2
               AND enrichment.input_hash=$3) AS enrichment_count`,
        [batchId, fixture.sourceItemId, fixture.inputHash],
      );
      expect(counts.rows).toEqual([{
        batch_count: "1",
        enrichment_count: "1",
      }]);
    } finally {
      await connection.end();
    }
  });

  it("preserves both concurrent response attempts with one valid item projection", async () => {
    const fixture = createFixture();
    const firstBatchId = `${"4".repeat(32)}${fixture.suffix}`;
    const secondBatchId = `${"5".repeat(32)}${fixture.suffix}`;
    const firstPayload = fixture.payload({
      batchId: firstBatchId,
      rawResponse: "concurrent-first-response",
      status: "parsed",
      summary: "concurrent-first",
    });
    const secondPayload = fixture.payload({
      batchId: secondBatchId,
      rawResponse: "concurrent-second-response",
      status: "parsed",
      summary: "concurrent-second",
    });

    await Promise.all([
      ingestAnalyticsAiProcessingBatch(
        env.ANALYTICS_DB.connectionString,
        firstPayload,
      ),
      ingestAnalyticsAiProcessingBatch(
        env.ANALYTICS_DB.connectionString,
        secondPayload,
      ),
    ]);

    const connection = await connectAnalytics();
    try {
      const batches = await connection.query<{ batch_id: string }>(
        `SELECT batch_id
         FROM radar_analytics.ai_processing_batches
         WHERE batch_id=ANY($1::text[])
         ORDER BY batch_id`,
        [[firstBatchId, secondBatchId]],
      );
      expect(batches.rows).toEqual([
        { batch_id: firstBatchId },
        { batch_id: secondBatchId },
      ]);

      const enrichments = await connection.query<{
        batch_id: string;
        raw_response: string;
        summary: string;
      }>(
        `SELECT
           enrichment.batch_id,
           batch.raw_response,
           enrichment.output->>'summary' summary
         FROM radar_analytics.ai_enrichments AS enrichment
         JOIN radar_analytics.ai_processing_batches AS batch
           ON batch.batch_id=enrichment.batch_id
         JOIN radar_analytics.source_listings AS listing
           ON listing.id=enrichment.source_listing_id
         WHERE listing.source_id='mercari_jp'
           AND listing.source_item_id=$1
           AND enrichment.input_hash=$2`,
        [fixture.sourceItemId, fixture.inputHash],
      );
      expect(enrichments.rows).toHaveLength(1);
      expect([
        {
          batch_id: firstBatchId,
          raw_response: "concurrent-first-response",
          summary: "concurrent-first",
        },
        {
          batch_id: secondBatchId,
          raw_response: "concurrent-second-response",
          summary: "concurrent-second",
        },
      ]).toContainEqual(enrichments.rows[0]);
    } finally {
      await connection.end();
    }
  });
});
