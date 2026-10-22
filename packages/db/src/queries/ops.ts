/**
 * 运维与验证：仪表盘、cron 心跳、验收检查、P0 资格跑批、完工通知。
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
import { RepositoryBase } from "./base";

export abstract class OpsRepository extends RepositoryBase {
  async dashboardSummary(now = Date.now()): Promise<DashboardSummary> {
    const dayStart = japanDayStart(now);
    const [watches, sources, watchSearches, newListings, drops, failures, suppressed, previewSearches, sentEmails] = await this.db.batch([
      this.db.prepare("SELECT COUNT(*) count FROM watch_profiles WHERE enabled = 1"),
      this.db.prepare("SELECT COUNT(*) count FROM source_registry WHERE enabled = 1"),
      this.db.prepare(
        `SELECT COUNT(*) count FROM watch_runs r JOIN watch_bindings b ON b.id=r.watch_binding_id
         WHERE b.kind='keyword' AND r.status='success' AND r.started_at>=?`,
      ).bind(dayStart),
      this.db.prepare("SELECT COUNT(*) count FROM events WHERE event_type = 'new_listing' AND created_at >= ?").bind(dayStart),
      this.db.prepare(
        `SELECT COUNT(*) count FROM events
         WHERE COALESCE(semantic_event_type,event_type) IN ('price_drop','target_price') AND created_at >= ?`,
      ).bind(dayStart),
      this.db.prepare("SELECT COUNT(*) count FROM source_registry WHERE health_status IN ('degraded','blocked','broken')"),
      this.db.prepare("SELECT COUNT(*) count FROM events WHERE status = 'suppressed' AND created_at >= ?").bind(dayStart),
      this.db.prepare("SELECT COUNT(*) count FROM search_history WHERE searched_at >= ?").bind(dayStart),
      this.db.prepare("SELECT COUNT(*) count FROM notice_deliveries WHERE channel='email' AND status='sent' AND sent_at>=?").bind(dayStart),
    ]);
    if (!watches || !sources || !watchSearches || !newListings || !drops || !failures || !suppressed || !previewSearches || !sentEmails) {
      throw new Error("dashboard database batch returned an incomplete result set");
    }
    const count = (result: OperationalResult<unknown>) => Number((result.results[0] as Record<string, unknown> | undefined)?.count ?? 0);
    return {
      activeWatches: count(watches),
      activeSources: count(sources),
      todaySearches: count(watchSearches) + count(previewSearches),
      todayNewListings: count(newListings),
      todayPriceDrops: count(drops),
      todayEmails: count(sentEmails),
      failingSources: count(failures),
      emailProtectionTriggered: count(suppressed) > 0,
    };
  }

  /**
   * 一跳 cron 真正待办多少活——**不带 LIMIT**。
   *
   * `dueBindings()` / `dueTrackedListings()` 都带 `LIMIT MAX_ACTIVE_BINDINGS`，
   * 所以按它们的返回条数记录出来的 `due_bindings` 取值上限就是 80：积压一旦超过
   * 一跳的派发量，指标就钉在 80 上，再也分辨不出欠了多少。要判断系统追不追得上，
   * 只能数没有被截断的那个数。
   *
   * 两个 count 写成标量子查询而不是两次往返：这个方法每跳都要跑，而它是挂在
   * `handleScheduled` 开头那个 `Promise.all` 里的，一次往返意味着零额外延迟。
   *
   * WHERE 条件必须和 `dueBindings` / `dueTrackedListings` 逐字对应，否则量出来的
   * 是另一个系统的积压。改那两个查询时，这里要一起改。
   */
  async dueWorkloadTotals(): Promise<{ bindings: number; trackedListings: number }> {
    const now = new Date().toISOString();
    const row = await this.db.prepare(
      `SELECT
         (SELECT count(*) FROM watch_bindings b
           JOIN watch_profiles p ON p.id=b.watch_profile_id
          WHERE b.enabled = 1 AND b.next_run_at <= ?
            AND (b.cooldown_until IS NULL OR b.cooldown_until <= ?)) AS due_bindings,
         (SELECT count(*) FROM watch_listing_matches m
           JOIN watch_bindings b ON b.id=m.watch_binding_id
           JOIN watch_profiles p ON p.id=b.watch_profile_id
          WHERE p.dossier_kind='exact_product' AND p.enabled=1 AND b.enabled=1
            AND m.tracking_status IN ('active','unavailable_pending','waiting_restock')
            AND m.tracking_next_run_at IS NOT NULL AND m.tracking_next_run_at<=?
            AND (m.tracking_cooldown_until IS NULL OR m.tracking_cooldown_until<=?)) AS due_tracked`,
    ).bind(now, now, now, now).first<{ due_bindings: number; due_tracked: number }>();
    return {
      bindings: Number(row?.due_bindings ?? 0),
      trackedListings: Number(row?.due_tracked ?? 0),
    };
  }

  /**
   * 每跳写一行。`dispatched*` 是这一跳实际派发的量（受 LIMIT 截断），
   * `due*Total` 是真实待办量——两者的差就是这一跳没吃下的欠账。
   *
   * `verifyContinuity` 只在每小时的维护跳打开：那段 48 小时连续性校验要把
   * 50 小时内的心跳全读出来，每分钟跑一次纯属浪费，而它证明的是"cron 没停过"，
   * 一小时确认一次足够。
   */
  async recordCronHeartbeat(input: {
    scheduledAt: string;
    dispatchedBindings: number;
    dueBindingsTotal: number;
    dueTrackedTotal: number;
    enqueuedJobs: number;
    dispatchMs: number;
    verifyContinuity: boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO cron_heartbeats(id,scheduled_at,observed_at,due_bindings,enqueued_jobs,
         due_bindings_total,due_tracked_total,dispatch_ms) VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),
      input.scheduledAt,
      now,
      input.dispatchedBindings,
      input.enqueuedJobs,
      input.dueBindingsTotal,
      input.dueTrackedTotal,
      input.dispatchMs,
    ).run();
    if (!input.verifyContinuity) return;
    const cutoff = new Date(Date.now() - 50 * 60 * 60 * 1_000).toISOString();
    const rows = await this.db.prepare(
      "SELECT observed_at FROM cron_heartbeats WHERE observed_at>=? ORDER BY observed_at ASC",
    ).bind(cutoff).all<{ observed_at: string }>();
    const timestamps = rows.results.map((row) => Date.parse(row.observed_at)).filter(Number.isFinite);
    const span = timestamps.length > 1 ? timestamps[timestamps.length - 1]! - timestamps[0]! : 0;
    const maxGap = timestamps.slice(1).reduce((max, value, index) => Math.max(max, value - timestamps[index]!), 0);
    if (timestamps.length >= 49 && span >= PROBE_WINDOW_MS - 5 * 60_000 && maxGap <= 90 * 60_000) {
      await this.markVerification("final", "continuous_48h", "passed", {
        heartbeatCount: timestamps.length,
        firstObservedAt: new Date(timestamps[0]!).toISOString(),
        lastObservedAt: new Date(timestamps[timestamps.length - 1]!).toISOString(),
        maxGapMinutes: Math.round(maxGap / 60_000),
      });
    }
  }

  async markVerification(scope: "p0" | "final", checkKey: string, status: VerificationCheckRow["status"], evidence: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE verification_checks SET status=?,evidence_json=?,verified_at=CASE WHEN ?='passed' THEN ? ELSE NULL END,updated_at=?
       WHERE scope=? AND check_key=?`,
    ).bind(status, JSON.stringify(evidence), status, now, now, scope, checkKey).run();
  }

  async verificationChecks(scope: "p0" | "final"): Promise<VerificationCheckRow[]> {
    const result = await this.db.prepare(
      "SELECT scope,check_key,label,status,evidence_json,verified_at FROM verification_checks WHERE scope=? ORDER BY check_key",
    ).bind(scope).all<VerificationCheckRow>();
    return result.results;
  }

  async markHtmlIsolationIfProven(): Promise<boolean> {
    const failure = await this.db.prepare(
      `SELECT source_id,observed_at,status,error_code FROM source_probe_observations
       WHERE source_id IN ('mercari_jp','surugaya') AND status IN ('failed','rate_limited','blocked')
       ORDER BY observed_at DESC LIMIT 1`,
    ).first<{ source_id: SourceId; observed_at: string; status: string; error_code: string | null }>();
    if (!failure) return false;
    const official = await this.db.prepare(
      `SELECT id,health_status,last_success_at FROM source_registry
       WHERE id IN ('rakuten_ichiba','rakuten_books') ORDER BY id`,
    ).all<{ id: SourceId; health_status: string; last_success_at: string | null }>();
    if (official.results.length !== 2 || official.results.some((source) => source.health_status !== "healthy"
      || !source.last_success_at || Date.parse(source.last_success_at) <= Date.parse(failure.observed_at))) return false;
    await this.markVerification("final", "html_isolation", "passed", {
      checkedAt: new Date().toISOString(),
      experimentalFailure: { sourceId: failure.source_id, observedAt: failure.observed_at, status: failure.status, errorCode: failure.error_code },
      officialSuccesses: official.results.map((source) => ({ sourceId: source.id, observedAt: source.last_success_at })),
      result: "official_sources_succeeded_after_experimental_source_failure",
    });
    return true;
  }

  async createP0QualificationRun(triggeredBy: "admin" | "system" = "admin"): Promise<string | null> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const result = await this.db.prepare(
      `INSERT INTO p0_qualification_runs(id,status,triggered_by,started_at,created_at,updated_at)
       SELECT ?,'running',?,?,?,? WHERE NOT EXISTS (
         SELECT 1 FROM p0_qualification_runs WHERE status='running' AND started_at>?
       )`,
    ).bind(id, triggeredBy, now, now, now, staleBefore).run();
    return result.meta.changes > 0 ? id : null;
  }

  async finishP0QualificationRun(
    id: string,
    status: P0QualificationRunRow["status"],
    results: unknown,
    errorMessage?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE p0_qualification_runs SET status=?,finished_at=?,results_json=?,error_message=?,updated_at=? WHERE id=?`,
    ).bind(status, now, JSON.stringify(results), errorMessage?.slice(0, 500) ?? null, now, id).run();
  }

  async latestP0QualificationRun(): Promise<P0QualificationRunRow | null> {
    return this.db.prepare("SELECT * FROM p0_qualification_runs ORDER BY started_at DESC LIMIT 1").first<P0QualificationRunRow>();
  }

  async reserveCompletionNotification(): Promise<{ key: string; checks: VerificationCheckRow[] } | null> {
    const checks = await this.verificationChecks("final");
    if (checks.length === 0 || checks.some((check) => check.status !== "passed")) return null;
    const key = "final_acceptance:v4";
    const existing = await this.db.prepare("SELECT status,updated_at FROM completion_notifications WHERE idempotency_key=?")
      .bind(key).first<{ status: string; updated_at: string }>();
    if (existing?.status === "sent") return null;
    if (existing?.status === "sending" && Date.now() - Date.parse(existing.updated_at) < 15 * 60_000) return null;
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO completion_notifications(idempotency_key,status,attempts,created_at,updated_at) VALUES(?,'sending',1,?,?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         status='sending',attempts=completion_notifications.attempts+1,last_error=NULL,updated_at=excluded.updated_at`,
    ).bind(key, now, now).run();
    return { key, checks };
  }

  async finishCompletionNotification(key: string, resendId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      "UPDATE completion_notifications SET status='sent',resend_email_id=?,sent_at=?,updated_at=? WHERE idempotency_key=?",
    ).bind(resendId, now, now, key).run();
  }

  async failCompletionNotification(key: string, error: string): Promise<void> {
    await this.db.prepare(
      "UPDATE completion_notifications SET status='failed',last_error=?,updated_at=? WHERE idempotency_key=?",
    ).bind(error.slice(0, 500), new Date().toISOString(), key).run();
  }

}
