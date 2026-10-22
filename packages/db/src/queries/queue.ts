/**
 * 队列与死信：认领 / 完成 / 失败 / 转死信。
 */
/**
 * 本文件是 `RadarRepository` 的一部分。
 *
 * 拆分方式：各组按继承链串起来（见 `packages/db/src/repository.ts` 顶部说明），
 * 因此方法体与原文件逐字相同，`this.db` 与跨方法调用都照旧可用。
 * 新增方法时若要调用别组的方法，那一组必须排在本组**之前**，否则 typecheck 会报错。
 */
import type { Availability, EventCandidate, ListingState, MonitorEventType, NormalizedListing, SourceId, StrongReminderPolicy } from "@jpgr/core";
import {
  buildLandedCostEstimate,
  advanceItemSchedule,
  adaptiveItemScheduleEnabled,
  itemScheduleConfig,
  itemSchedulePolicy,
  itemScheduleDelayMinutes,
  effectiveItemIntervalMinutes,
  buildProductLifecycleIntelligence,
  canonicalMonitorEventType,
  evaluateProbeWindow,
  extractLandedCostListingFacts,
  isOneOffListingSource,
  landedCostMeetsTarget,
  landedCostThresholdPolicy,
  PROBE_WINDOW_MS,
  stableStateHash,
  strongReminderDeliveryTimes,
} from "@jpgr/core";
import type {
  ConfirmationListingRow,
  CostProfileRow,
  DashboardSummary,
  ExistingListingRow,
  HermesDeliveryClaim,
  MonitorEventInsertDecision,
  MonitorRuleRow,
  MonitorRuleLandedCostTargetRow,
  P0QualificationRunRow,
  PendingEmailRow,
  WeeklyExactReport,
  ProbeWindowRow,
  StoredListingDetail,
  VerificationCheckRow,
  TrackedListingRow,
  WatchBindingRow,
  WatchRunResult,
} from "../types";
import { costProfileFromRow } from "../cost-profiles";
import type {
  OperationalDatabase,
  OperationalPreparedStatement,
  OperationalResult,
} from "../database";
import {
  metadataRecord,
  stringValue,
  JAPAN_OFFSET_MS,
  MAX_KEYWORD_DIGEST_SUSPECTS,
  SQL_ID_CHUNK_SIZE,
  TOKYO_OFFSET_MS,
  HERMES_SENDING_STALE_MS,
  HERMES_MAX_ATTEMPTS,
  HERMES_MAX_EVENT_AGE_MS,
  MAX_DESCRIPTION_EXCERPT_CHARACTERS,
  boundedDescriptionExcerpt,
  storedEventType,
  chunks,
  interleaveBySource,
  discoveryKindOf,
  parsedStringArray,
  parsedObject,
  minuteOfDay,
  quietHoursNotBefore,
  listingCompleteness,
  DAILY_COUNTER_COLUMNS,
  VOLATILE_DISPLAY_FACT_KEYS,
  contentHashFacts,
  japanDayStart,
  japanDayKey,
  japanDay,
  monitorRuleScopeUsable,
  monitorRuleAcceptsSource,
  isPriceTargetTrigger,
  keywordBaselineResetStatements,
} from "./shared";
import type {
  MonitorListingRow,
  MonitorLandedCostContext,
} from "./shared";
import { QuotaRepository } from "./quota";

export abstract class QueueRepository extends QuotaRepository {
  async claimQueueMessage(input: {
    queueName: string;
    idempotencyKey: string;
    messageId: string;
    messageType: string;
    deliveryAttempt: number;
    processingLeaseCutoff: string;
  }): Promise<"claimed" | "completed" | "dead_lettered" | "busy"> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `INSERT INTO queue_message_receipts(
         queue_name,idempotency_key,message_id,message_type,status,deliveries,last_delivery_attempt,
         first_received_at,last_received_at
       ) VALUES(?,?,?,?,'processing',1,?,?,?)
       ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET
         message_id=excluded.message_id,
         status='processing',
         deliveries=queue_message_receipts.deliveries+1,
          last_delivery_attempt=excluded.last_delivery_attempt,
          last_received_at=excluded.last_received_at,
          last_error=NULL
       WHERE queue_message_receipts.status='failed'
          OR (
            queue_message_receipts.status='processing'
            AND queue_message_receipts.last_received_at<?
          )`,
    ).bind(
      input.queueName,
      input.idempotencyKey,
      input.messageId,
      input.messageType,
      Math.max(1, input.deliveryAttempt),
      now,
      now,
      input.processingLeaseCutoff,
    ).run();
    if (result.meta.changes === 1) return "claimed";
    const receipt = await this.db.prepare(
      `SELECT status FROM queue_message_receipts
       WHERE queue_name=? AND idempotency_key=?`,
    ).bind(input.queueName, input.idempotencyKey).first<{ status: string }>();
    if (receipt?.status === "completed") return "completed";
    if (receipt?.status === "dead_lettered") return "dead_lettered";
    return "busy";
  }

  async completeQueueMessage(queueName: string, idempotencyKey: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE queue_message_receipts
       SET status='completed',completed_at=?,last_received_at=?,last_error=NULL
       WHERE queue_name=? AND idempotency_key=? AND status='processing'`,
    ).bind(now, now, queueName, idempotencyKey).run();
  }

  async failQueueMessage(queueName: string, idempotencyKey: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.db.prepare(
      `UPDATE queue_message_receipts
       SET status='failed',last_error=?,last_received_at=?
       WHERE queue_name=? AND idempotency_key=? AND status='processing'`,
    ).bind(message.slice(0, 500), new Date().toISOString(), queueName, idempotencyKey).run();
  }

  async deadLetterQueueMessage(input: {
    queueName: string;
    deadLetterQueueName: string;
    idempotencyKey: string;
    messageId: string;
    messageType: string;
    body: unknown;
    deliveryAttempt: number;
    error?: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    const error = input.error instanceof Error
      ? input.error.message
      : input.error === undefined ? null : String(input.error);
    const bodyJson = JSON.stringify(input.body) ?? "null";
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO queue_dead_letters(
           queue_name,dead_letter_queue_name,idempotency_key,message_id,message_type,body_json,
           deliveries,last_delivery_attempt,
           first_dead_lettered_at,last_dead_lettered_at,last_error
         ) VALUES(?,?,?,?,?,?,1,?,?,?,?)
         ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET
           dead_letter_queue_name=excluded.dead_letter_queue_name,
           message_id=excluded.message_id,
           body_json=excluded.body_json,
           deliveries=queue_dead_letters.deliveries+1,
           last_delivery_attempt=excluded.last_delivery_attempt,
           last_dead_lettered_at=excluded.last_dead_lettered_at,
           last_error=COALESCE(excluded.last_error,queue_dead_letters.last_error)`,
      ).bind(
        input.queueName,
        input.deadLetterQueueName,
        input.idempotencyKey,
        input.messageId,
        input.messageType,
        bodyJson,
        Math.max(1, input.deliveryAttempt),
        now,
        now,
        error?.slice(0, 500) ?? null,
      ),
      this.db.prepare(
        `UPDATE queue_message_receipts
         SET status='dead_lettered',last_error=COALESCE(?,last_error),last_received_at=?
         WHERE queue_name=? AND idempotency_key=? AND status<>'completed'`,
      ).bind(error?.slice(0, 500) ?? null, now, input.queueName, input.idempotencyKey),
    ]);
  }

}
