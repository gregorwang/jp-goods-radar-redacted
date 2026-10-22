/**
 * 采集运行与来源探针：建 run、收尾 run、来源健康快照、探针窗口。
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
  isParserFailureCode,
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
import { BindingRepository } from "./bindings";

export abstract class RunRepository extends BindingRepository {
  async createRun(bindingId: string, trigger: string): Promise<{ id: string; startedAt: number }> {
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    await this.db.prepare(
      "INSERT INTO watch_runs (id, watch_binding_id, trigger_type, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    ).bind(id, bindingId, trigger, new Date(startedAt).toISOString()).run();
    return { id, startedAt };
  }

  async finishRun(run: { id: string; startedAt: number }, result: WatchRunResult): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.db.prepare(
      `UPDATE watch_runs SET status = ?, finished_at = ?, duration_ms = ?, http_status = ?, result_count = ?,
       new_count = ?, changed_count = ?, coverage = ?, parser_version = ?, error_code = ?, error_message = ?,
       field_total = ?, field_complete = ?, captcha_detected = ?, cpu_limit_detected = ?, login_required = ? WHERE id = ?`,
    ).bind(
      result.status,
      finishedAt,
      Date.now() - run.startedAt,
      result.httpStatus ?? null,
      result.resultCount,
      result.newCount,
      result.changedCount,
      result.coverage,
      result.parserVersion ?? null,
      result.errorCode ?? null,
      result.errorMessage?.slice(0, 500) ?? null,
      result.fieldTotal ?? 0,
      result.fieldComplete ?? 0,
      result.captchaDetected ? 1 : 0,
      result.cpuLimitDetected ? 1 : 0,
      result.loginRequired ? 1 : 0,
      run.id,
    ).run();
    await this.recordSourceHealthSnapshot(run.id, finishedAt, result);
    await this.recordProbeResult(run.id, result);
    if (result.status !== "success" || result.resultCount === 0) {
      // Only invalidate an older observation. A late failure must not erase a
      // newer successful check, and failures never extend the polling interval.
      await this.db.prepare(
        `UPDATE watch_bindings b SET source_config_json=jsonb_set(
           jsonb_set(jsonb_set(b.source_config_json::jsonb,
             '{itemSchedule,state,lastObservedAt}', 'null'::jsonb),
             '{itemSchedule,state,stableMinutes}', '0'::jsonb),
             '{itemSchedule,state,reason}', '"incomplete"'::jsonb)::text
         FROM watch_runs r,watch_profiles p
         WHERE r.id=? AND r.watch_binding_id=b.id AND p.id=b.watch_profile_id
           AND p.dossier_kind='item' AND b.kind='item' AND b.monitoring_purpose='item_price'
           AND b.source_id<>'yahoo_auctions_jp'
           AND b.source_config_json::jsonb#>>'{itemSchedule,mode}'='adaptive'
           AND b.source_config_json::jsonb#>>'{itemSchedule,state,lastObservedAt}'<=?`,
      ).bind(run.id, new Date(run.startedAt).toISOString()).run();
    }
  }

  private async recordSourceHealthSnapshot(runId: string, observedAt: string, result: WatchRunResult): Promise<void> {
    const context = await this.db.prepare(
      `SELECT b.id watch_binding_id,b.source_id,b.schedule_interval_minutes,
              b.kind,b.monitoring_purpose,b.source_config_json,p.dossier_kind profile_dossier_kind,
              c.content_hash,c.payload_bytes,c.response_status
       FROM watch_runs r
       JOIN watch_bindings b ON b.id=r.watch_binding_id
       JOIN watch_profiles p ON p.id=b.watch_profile_id
       LEFT JOIN source_response_captures c ON c.id=(
         SELECT capture.id FROM source_response_captures capture
         WHERE capture.run_id=r.id AND capture.source_id=b.source_id
         ORDER BY capture.ordinal DESC LIMIT 1
       )
       WHERE r.id=?`,
    ).bind(runId).first<{
      watch_binding_id: string;
      source_id: SourceId;
      schedule_interval_minutes: number;
      kind: string;
      monitoring_purpose: string;
      source_config_json: string;
      profile_dossier_kind: string;
      content_hash: string | null;
      payload_bytes: number | null;
      response_status: number | null;
    }>();
    if (!context) return;

    const abnormalEmpty = result.healthEvidence?.abnormalEmpty === true
      || result.errorCode === "suspected_source_degradation";
    const filteredByRules = ["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(result.errorCode ?? "");
    const state = filteredByRules ? "healthy" : result.status === "success"
      ? result.resultCount === 0 ? "empty" : "healthy"
      : result.status === "skipped"
        ? ["cooldown_active", "yahoo_auctions_local_rate_limited"].includes(result.errorCode ?? "") ? "cooldown" : "disabled"
        : abnormalEmpty || isParserFailureCode(result.errorCode)
          ? "suspected_degradation"
          : "failed";
    const requestSucceeded = filteredByRules || result.status === "success"
      || (context.response_status !== null && context.response_status >= 200 && context.response_status < 400);
    const blockedDetected = result.healthEvidence?.blockedDetected === true
      || result.status === "blocked"
      || result.captchaDetected === true
      || result.loginRequired === true;
    const freshnessSlaMinutes = Math.max(60, effectiveItemIntervalMinutes(context) * 2);

    await this.db.prepare(
      `INSERT INTO source_health_snapshots(
         id,source_id,watch_binding_id,watch_run_id,observed_at,state,request_succeeded,parse_succeeded,
         coverage,raw_result_count,normalized_result_count,page_depth,cursor_termination_reason,
         response_content_hash,response_bytes,template_version,http_status,field_total,field_complete,
         captcha_detected,login_required,blocked_detected,abnormal_empty,freshness_sla_minutes,error_code,error_message
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      crypto.randomUUID(), context.source_id, context.watch_binding_id, runId, observedAt, state,
      requestSucceeded ? 1 : 0, filteredByRules || result.status === "success" ? 1 : 0, result.coverage,
      result.healthEvidence?.rawResultCount ?? result.resultCount, result.resultCount,
      result.healthEvidence?.pageDepth ?? (requestSucceeded ? 1 : 0),
      result.healthEvidence?.cursorTerminationReason ?? "unknown",
      context.content_hash, context.payload_bytes ?? 0, result.parserVersion ?? null,
      result.httpStatus ?? context.response_status, result.fieldTotal ?? 0, result.fieldComplete ?? 0,
      result.captchaDetected ? 1 : 0, result.loginRequired ? 1 : 0, blockedDetected ? 1 : 0,
      abnormalEmpty ? 1 : 0, freshnessSlaMinutes, result.errorCode ?? null,
      result.errorMessage?.slice(0, 500) ?? null,
    ).run();
  }

  private async recordProbeResult(runId: string, result: WatchRunResult): Promise<void> {
    const source = await this.db.prepare(
      `SELECT b.source_id FROM watch_runs r JOIN watch_bindings b ON b.id=r.watch_binding_id WHERE r.id=?`,
    ).bind(runId).first<{ source_id: SourceId }>();
    if (!source) return;
    // Dossier rules do not turn a successful upstream parse into a failed
    // source probe (which could otherwise disable every watch on that source).
    await this.recordSourceProbeObservation(source.source_id, ["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(result.errorCode ?? "")
      ? {
          ...result,
          status: "success",
          resultCount: result.healthEvidence?.rawResultCount ?? result.resultCount,
          errorCode: undefined,
          errorMessage: undefined,
        }
      : result);
  }

  async recordSourceProbeObservation(sourceId: SourceId, result: WatchRunResult): Promise<void> {
    // Local admission control means no Yahoo response was attempted, so it is
    // scheduler evidence rather than a source-stability observation.
    if (result.errorCode === "yahoo_auctions_local_rate_limited") return;
    const now = new Date().toISOString();
    const activeWindow = await this.db.prepare(
      "SELECT started_at FROM source_probe_windows WHERE source_id=? AND status='running'",
    ).bind(sourceId).first<{ started_at: string | null }>();
    if (!activeWindow?.started_at) return;
    const [updated] = await this.db.batch([
      this.db.prepare(
        `UPDATE source_probe_windows SET total_runs=total_runs+1,
         successful_runs=successful_runs+?,field_total=field_total+?,field_complete=field_complete+?,
         captcha_runs=captcha_runs+?,cpu_limit_runs=cpu_limit_runs+?,login_required_runs=login_required_runs+?,updated_at=?
         WHERE source_id=? AND status='running' AND started_at=?`,
      ).bind(result.status === "success" ? 1 : 0, result.fieldTotal ?? 0, result.fieldComplete ?? 0,
        result.captchaDetected ? 1 : 0, result.cpuLimitDetected ? 1 : 0, result.loginRequired ? 1 : 0,
        now, sourceId, activeWindow.started_at),
      this.db.prepare(
        `INSERT INTO source_probe_observations(
          id,source_id,window_started_at,observed_at,status,coverage,result_count,field_total,field_complete,
          http_status,parser_version,error_code,error_message,captcha_detected,cpu_limit_detected,login_required
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), sourceId, activeWindow.started_at, now, result.status, result.coverage,
        result.resultCount, result.fieldTotal ?? 0, result.fieldComplete ?? 0, result.httpStatus ?? null,
        result.parserVersion ?? null, result.errorCode ?? null, result.errorMessage?.slice(0, 500) ?? null,
        result.captchaDetected ? 1 : 0, result.cpuLimitDetected ? 1 : 0, result.loginRequired ? 1 : 0),
    ]);
    if (!updated || updated.meta.changes === 0) return;
    const window = await this.db.prepare("SELECT * FROM source_probe_windows WHERE source_id=?")
      .bind(sourceId).first<ProbeWindowRow>();
    if (!window) return;
    const decision = evaluateProbeWindow({
      startedAt: window.started_at,
      totalRuns: window.total_runs,
      successfulRuns: window.successful_runs,
      fieldTotal: window.field_total,
      fieldComplete: window.field_complete,
      captchaRuns: window.captcha_runs,
      cpuLimitRuns: window.cpu_limit_runs,
      loginRequiredRuns: window.login_required_runs,
    });
    if (decision.status === "running") return;
    const reason = decision.reasons.join("；") || "48 小时探针全部指标通过";
    const statements = [this.db.prepare(
      `UPDATE source_probe_windows SET status=?,finished_at=?,decision_reason=?,updated_at=? WHERE source_id=? AND status='running'`,
    ).bind(decision.status, now, reason, now, sourceId)];
    // Yahoo!フリマ and Yahoo!オークション are core second-hand sources: a failed
    // probe window is recorded for review but must not switch off the source and
    // every watch on it (a 39/39-success window was disabled for missing hourly ticks).
    const autoDisableOnNoGo = sourceId !== "yahoo_fleamarket_jp" && sourceId !== "yahoo_auctions_jp";
    if (decision.status === "failed" && autoDisableOnNoGo) {
      statements.push(
        this.db.prepare("UPDATE source_registry SET enabled=0,health_status='disabled',last_error_code='probe_no_go',last_error_message=?,updated_at=? WHERE id=?")
          .bind(reason.slice(0, 500), now, sourceId),
        this.db.prepare("UPDATE watch_bindings SET enabled=0,last_error_code='probe_no_go',last_error_message=?,updated_at=? WHERE source_id=?")
          .bind(reason.slice(0, 500), now, sourceId),
      );
    }
    await this.db.batch(statements);
    if (sourceId === "mercari_jp" || sourceId === "surugaya") {
      await this.markVerification("final", sourceId, decision.status === "passed" ? "passed" : "failed", {
        observedAt: now,
        totalRuns: window.total_runs,
        successRate: decision.successRate,
        fieldCompletenessRate: decision.fieldCompletenessRate,
        reasons: decision.reasons,
      });
    }
  }

  async startSourceProbe(sourceId: SourceId): Promise<{ startedAt: string; plannedEndAt: string; requestRoute: "direct" | "mercari_service"; reused: boolean }> {
    const source = await this.db.prepare("SELECT transport,request_route FROM source_registry WHERE id=?").bind(sourceId)
      .first<{ transport: string; request_route: "direct" | "mercari_service" }>();
    if (!source) throw new Error("source_not_found");
    if (source.transport !== "internal_api" && source.transport !== "html_endpoint") throw new Error("probe_only_for_experimental_sources");
    const current = await this.db.prepare(
      "SELECT status,started_at,planned_end_at,request_route FROM source_probe_windows WHERE source_id=?",
    ).bind(sourceId).first<{ status: string; started_at: string | null; planned_end_at: string | null; request_route: "direct" | "mercari_service" }>();
    if (current?.status === "running" && current.started_at && current.planned_end_at) {
      if (current.request_route !== source.request_route) throw new Error("probe_route_changed_requires_restart");
      return { startedAt: current.started_at, plannedEndAt: current.planned_end_at, requestRoute: current.request_route, reused: true };
    }
    const startedAt = new Date().toISOString();
    const plannedEndAt = new Date(Date.now() + PROBE_WINDOW_MS).toISOString();
    await this.db.prepare(
      `INSERT INTO source_probe_windows(source_id,status,started_at,planned_end_at,total_runs,successful_runs,field_total,field_complete,
       captcha_runs,cpu_limit_runs,login_required_runs,decision_reason,updated_at,request_route)
       VALUES(?,'running',?,?,0,0,0,0,0,0,0,NULL,?,?)
       ON CONFLICT(source_id) DO UPDATE SET status='running',started_at=excluded.started_at,planned_end_at=excluded.planned_end_at,
       finished_at=NULL,total_runs=0,successful_runs=0,field_total=0,field_complete=0,captcha_runs=0,cpu_limit_runs=0,
       login_required_runs=0,decision_reason=NULL,updated_at=excluded.updated_at,request_route=excluded.request_route`,
    ).bind(sourceId, startedAt, plannedEndAt, startedAt, source.request_route).run();
    return { startedAt, plannedEndAt, requestRoute: source.request_route, reused: false };
  }

  async restartSourceProbeForRouteChange(sourceId: SourceId): Promise<{
    startedAt: string;
    plannedEndAt: string;
    previousRequestRoute: "direct" | "mercari_service";
    requestRoute: "direct" | "mercari_service";
    archivedWindowId: string;
  }> {
    const current = await this.db.prepare(
      `SELECT p.*,s.transport,s.request_route source_request_route
       FROM source_probe_windows p JOIN source_registry s ON s.id=p.source_id WHERE p.source_id=?`,
    ).bind(sourceId).first<ProbeWindowRow & { transport: string; source_request_route: "direct" | "mercari_service" }>();
    if (!current) throw new Error("source_or_probe_not_found");
    if (current.transport !== "internal_api" && current.transport !== "html_endpoint") throw new Error("probe_only_for_experimental_sources");
    if (!current.started_at) throw new Error("probe_has_no_window_to_archive");
    if (current.request_route === current.source_request_route) throw new Error("probe_request_route_unchanged");

    const archivedWindowId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const plannedEndAt = new Date(Date.now() + PROBE_WINDOW_MS).toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO source_probe_window_history(
          id,source_id,status,request_route,started_at,planned_end_at,finished_at,total_runs,successful_runs,
          field_total,field_complete,captcha_runs,cpu_limit_runs,login_required_runs,decision_reason,original_updated_at,
          archived_at,archive_reason,next_request_route
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'request_route_changed',?)`,
      ).bind(archivedWindowId, sourceId, current.status, current.request_route, current.started_at, current.planned_end_at,
        current.finished_at, current.total_runs, current.successful_runs, current.field_total, current.field_complete,
        current.captcha_runs, current.cpu_limit_runs, current.login_required_runs, current.decision_reason,
        current.updated_at, startedAt, current.source_request_route),
      this.db.prepare(
        `UPDATE source_probe_windows SET status='running',started_at=?,planned_end_at=?,finished_at=NULL,total_runs=0,
         successful_runs=0,field_total=0,field_complete=0,captcha_runs=0,cpu_limit_runs=0,login_required_runs=0,
         decision_reason=NULL,updated_at=?,request_route=? WHERE source_id=? AND started_at=? AND request_route=?`,
      ).bind(startedAt, plannedEndAt, startedAt, current.source_request_route, sourceId, current.started_at, current.request_route),
      this.db.prepare(
        `UPDATE verification_checks SET status='pending',evidence_json=?,verified_at=NULL,updated_at=?
         WHERE scope='final' AND check_key=?`,
      ).bind(JSON.stringify({ reason: "probe_restarted_after_request_route_change", previousRequestRoute: current.request_route,
        requestRoute: current.source_request_route, archivedWindowId, restartedAt: startedAt }), startedAt, sourceId),
    ]);
    if (!results[0] || results[0].meta.changes !== 1 || !results[1] || results[1].meta.changes !== 1) {
      throw new Error("probe_route_restart_not_persisted");
    }
    return { startedAt, plannedEndAt, previousRequestRoute: current.request_route,
      requestRoute: current.source_request_route, archivedWindowId };
  }

}
