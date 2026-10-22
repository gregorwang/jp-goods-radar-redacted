/**
 * 档案与绑定：取件、预约、自适应节奏观测、业务修复标记，以及绑定的收尾与失败处理。
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
  SOURCE_ERROR_REMINDERS_PER_STREAK,
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
import { TrackedListingRepository } from "./tracked-listings";

/**
 * 一天一跑（或半天一跑）的煤炉档案，本段连续失败的第一次：2 小时后补跑一次，只补一次。
 * 煤炉多是一次性挂牌，等到明天可能已经卖掉了（AGENTS.md 第 4 节）。补跑由采集器在队列里
 * 另排一条延迟任务（不动 next_run_at，否则以后每天的运行时间都会往后漂 2 小时）；这里只负责
 * 把档案冷却压到补跑之前到期。第二次失败 consecutive_failures 已经是 1，回到原来的退避。
 *
 * 不补跑：商品没了（不会走到 failBinding）、我们自己的请求有错、结构变化 / 验证码（直接停用）、
 * 429（按煤炉给的时间等）、我们自己的排队背压（有分钟级退避）。
 */
export const SAME_DAY_RETRY_DELAY_SECONDS = 2 * 60 * 60;
const SAME_DAY_RETRY_COOLDOWN_MINUTES = SAME_DAY_RETRY_DELAY_SECONDS / 60 - 5;
const SAME_DAY_RETRY_EXCLUDED_CODES = new Set([
  "mercari_invalid_request",
  "mercari_dpop_error",
  "invalid_request",
  "item_lookup_unsupported",
  "captcha",
  "parser_structure_error",
  "queue_full",
  "queue_stopping",
]);

export function sameDayRetryEligible(
  binding: Pick<WatchBindingRow, "source_id" | "schedule_interval_minutes" | "consecutive_failures">,
  code: string,
  httpStatus?: number,
): boolean {
  return binding.source_id === "mercari_jp"
    && binding.schedule_interval_minutes >= 720
    && binding.consecutive_failures === 0
    && httpStatus !== 429
    && !SAME_DAY_RETRY_EXCLUDED_CODES.has(code)
    && !isParserFailureCode(code);
}

export abstract class BindingRepository extends TrackedListingRepository {
  /**
   * 到期待采集的档案。**带 LIMIT**——一跳吃不下的留给下一跳。
   * 真实待办量看 `OpsRepository.dueWorkloadTotals()`，改这里的 WHERE 时要一起改。
   */
  async dueBindings(limit: number): Promise<WatchBindingRow[]> {
    const result = await this.db.prepare(
      `SELECT b.*,p.dossier_kind profile_dossier_kind FROM watch_bindings b
       JOIN watch_profiles p ON p.id=b.watch_profile_id
       WHERE b.enabled = 1 AND b.next_run_at <= ? AND (b.cooldown_until IS NULL OR b.cooldown_until <= ?)
       ORDER BY b.next_run_at ASC LIMIT ?`,
    ).bind(new Date().toISOString(), new Date().toISOString(), limit).all<WatchBindingRow>();
    return result.results;
  }

  async getBinding(id: string): Promise<WatchBindingRow | null> {
    return this.db.prepare(
      `SELECT b.*,p.name profile_name,p.description profile_description,p.default_max_price profile_default_max_price,
       p.include_terms_json profile_include_terms_json,p.exclude_terms_json profile_exclude_terms_json,
       p.dossier_kind profile_dossier_kind,p.offer_tracking_policy profile_offer_tracking_policy,
       p.min_listing_price profile_min_listing_price
       FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id WHERE b.id=?`,
    ).bind(id).first<WatchBindingRow>();
  }

  async reserveBinding(binding: WatchBindingRow): Promise<boolean> {
    const intervalMs = itemScheduleDelayMinutes(binding, Math.random()) * 60_000;
    const now = Date.now();
    const scheduledAt = Date.parse(binding.next_run_at);
    const base = Number.isFinite(scheduledAt) ? scheduledAt : now;
    const elapsed = Math.max(0, now - base);
    const periods = Math.floor(elapsed / intervalMs) + 1;
    const nextRunAt = new Date(base + periods * intervalMs).toISOString();
    const nowIso = new Date().toISOString();
    // CAS：只有 next_run_at 仍是读取时的值才算预约成功，
    // 重叠的 cron tick 不会把同一个绑定二次入队。
    const result = await this.db.prepare(
      `UPDATE watch_bindings SET next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ? AND next_run_at = ? AND source_config_json = ? AND schedule_interval_minutes = ? AND enabled=1`,
    ).bind(nextRunAt, nowIso, nowIso, binding.id, binding.next_run_at,
      binding.source_config_json, binding.schedule_interval_minutes).run();
    return Number(result.meta.changes ?? 0) > 0;
  }

  async recordItemScheduleObservation(
    binding: WatchBindingRow,
    observation: { price: number | null; availability: string } | null,
    options: { scheduled: boolean; significantSignal?: boolean },
  ): Promise<void> {
    if (!adaptiveItemScheduleEnabled(binding)) return;
    const now = new Date().toISOString();
    const state = advanceItemSchedule({ binding, observation, now, ...options });
    if (!state) return;
    const config = itemScheduleConfig(binding.source_config_json);
    const policy = itemSchedulePolicy(binding);
    const sourceConfigJson = JSON.stringify({ ...config, itemSchedule: { ...policy, state } });
    const delay = itemScheduleDelayMinutes({ ...binding, source_config_json: sourceConfigJson }, Math.random());
    const nextRunAt = new Date(Date.parse(now) + delay * 60_000).toISOString();
    // One atomic CAS protects a user's fixed-frequency lock and edits while a
    // request is in flight. Manual refreshes can bring work forward, never defer it.
    const result = await this.db.prepare(
      `UPDATE watch_bindings SET source_config_json=?,
       next_run_at=CASE WHEN ? THEN ? WHEN next_run_at>? THEN ? ELSE next_run_at END,
       updated_at=?
       WHERE id=? AND enabled=1 AND kind='item' AND monitoring_purpose='item_price'
         AND source_id<>'yahoo_auctions_jp' AND source_config_json=?
         AND schedule_interval_minutes=? AND next_run_at=?
         AND EXISTS(SELECT 1 FROM watch_profiles p
           WHERE p.id=watch_bindings.watch_profile_id AND p.dossier_kind='item' AND p.enabled=1)`,
    ).bind(sourceConfigJson, options.scheduled && state.reason !== "incomplete", nextRunAt, nextRunAt, nextRunAt,
      now, binding.id, binding.source_config_json, binding.schedule_interval_minutes, binding.next_run_at).run();
    if (Number(result.meta.changes ?? 0) > 0) {
      binding.source_config_json = sourceConfigJson;
      if ((options.scheduled && state.reason !== "incomplete") || binding.next_run_at > nextRunAt) binding.next_run_at = nextRunAt;
    }
  }

  async closeSupersededBusinessRepairRuns(bindingId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE watch_runs
       SET status='skipped',finished_at=?,
           duration_ms=CAST(EXTRACT(EPOCH FROM (?::timestamptz - started_at::timestamptz)) * 1000 AS bigint),
           error_code='source_runner_repair_superseded',
           error_message='自动修复后的新一轮业务任务已经开始'
       WHERE watch_binding_id=? AND status='running' AND error_code='source_runner_repair_pending'`,
    ).bind(now, now, bindingId).run();
  }

  async markRunAwaitingBusinessRepair(
    binding: WatchBindingRow,
    run: { id: string; startedAt: number },
    message: string,
    retryAfterSeconds?: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    const delaySeconds = Math.max(60, Math.min(900, retryAfterSeconds ?? 120));
    const retryAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE watch_runs SET error_code='source_runner_repair_pending',error_message=?
         WHERE id=? AND status='running'`,
      ).bind(message.slice(0, 500), run.id),
      this.db.prepare(
        `UPDATE watch_bindings
         SET next_run_at=CASE
               WHEN next_run_at IS NULL OR next_run_at<=? OR next_run_at>? THEN ?
               ELSE next_run_at
             END,
             cooldown_until=NULL,last_error_code='source_runner_repair_pending',last_error_message=?,updated_at=?
         WHERE id=?`,
      ).bind(now, retryAt, retryAt, message.slice(0, 500), now, binding.id),
      this.db.prepare(
        `UPDATE source_registry
         SET health_status='degraded',last_failure_at=?,last_error_code='source_runner_repair_pending',
             last_error_message=?,updated_at=? WHERE id=?`,
      ).bind(now, message.slice(0, 500), now, binding.source_id),
    ]);
  }

  async completeBinding(binding: WatchBindingRow): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE watch_bindings SET baseline_completed = 1, last_success_at = ?, consecutive_failures = 0,
       cooldown_until = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`,
    ).bind(now, now, binding.id).run();
    // 煤炉的来源级冷却只表示"东京主路在冷却"，由 apps/collector/src/mercari-route.ts 独占读写：
    // 这次成功可能是新加坡备路救回来的，清掉它下一个任务就会又先去撞主路。
    await this.db.prepare(
      `UPDATE source_registry SET
       health_status = CASE WHEN id = 'mercari_jp' AND cooldown_route = 'mercari_service' THEN 'degraded' ELSE 'healthy' END,
       last_success_at = ?, consecutive_failures = 0,
       cooldown_until = CASE WHEN id = 'mercari_jp' THEN cooldown_until ELSE NULL END,
       last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`,
    ).bind(now, now, binding.source_id).run();
  }

  /**
   * 一次性挂牌售出即终局：观测到 sold_out 就结束监控，不再等待。此前同样按
   * terminalDays 等待，而计时用的 last_changed_at 会被标题 / 描述等内容变化刷新
   * （见 persistListing 的 content_hash），卖家售后改一次页面就重新计时——
   * 2026-09-22 售出的煤炉挂牌到 10-07 仍在每 12 小时巡回。
   * unavailable（页面消失）可能只是暂时下架，仍按 terminalDays 等待；页面消失后
   * 内容不会再变，last_changed_at 可以作为计时起点。
   */
  async retireTerminalItemWatches(terminalDays = 7): Promise<number> {
    const days = Math.max(1, Math.min(Math.floor(terminalDays), 90));
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
    const rows = await this.db.prepare(
      `WITH ranked_matches AS (
         SELECT b.id binding_id,b.watch_profile_id,b.source_id,p.name profile_name,
                l.id listing_id,l.title,l.canonical_url,l.availability,l.last_changed_at,
                ROW_NUMBER() OVER (
                  PARTITION BY b.id
                  ORDER BY m.last_seen_at DESC,l.last_changed_at DESC,l.id DESC
                ) row_number
         FROM watch_bindings b
         JOIN watch_profiles p ON p.id=b.watch_profile_id
         JOIN watch_listing_matches m ON m.watch_binding_id=b.id
         JOIN listings l ON l.id=m.listing_id
         WHERE b.enabled=1 AND b.kind='item'
       )
       SELECT * FROM ranked_matches
       WHERE row_number=1
         AND (availability='sold_out' OR (availability='unavailable' AND last_changed_at<=?))
       ORDER BY last_changed_at ASC LIMIT 100`,
    ).bind(cutoff).all<{
      binding_id: string;
      watch_profile_id: string;
      source_id: SourceId;
      profile_name: string;
      listing_id: string;
      title: string;
      canonical_url: string;
      availability: "sold_out" | "unavailable";
      last_changed_at: string;
      row_number: number;
    }>();
    const candidates = rows.results.filter((row) => isOneOffListingSource(row.source_id));
    if (candidates.length === 0) return 0;

    const statements: OperationalPreparedStatement[] = [];
    const bindingUpdateResultIndexes: number[] = [];
    for (const row of candidates) {
      const eventKey = `watch_completed:${row.binding_id}:${row.listing_id}:${row.last_changed_at.slice(0, 10)}`;
      const payload = JSON.stringify({
        kind: "terminal_item_watch_completed",
        sourceId: row.source_id,
        profileName: row.profile_name,
        title: row.title,
        url: row.canonical_url,
        terminalAvailability: row.availability,
        terminalSince: row.last_changed_at,
        // 0 = 售出即结束，没有等待期；邮件与后台据此改写措辞。
        terminalDays: row.availability === "sold_out" ? 0 : days,
      });
      // 已经为这件挂牌发过「已售出 / 已下架」提醒时，结束监控只是收尾，照常落事件
      // （后台据此显示「监控已完成」），但不再单独发一封信——那是同一件事的第二封。
      statements.push(this.db.prepare(
        `INSERT INTO events(
           id,event_key,event_type,semantic_event_type,watch_profile_id,watch_binding_id,listing_id,
           payload_json,status,created_at
         )
         SELECT ?,?,'daily_digest','watch_completed',b.watch_profile_id,b.id,?,?,
           CASE WHEN EXISTS(
             SELECT 1 FROM events s
             WHERE s.watch_binding_id=b.id AND s.listing_id=? AND s.event_type='sold_out'
               AND s.status IN ('pending','sending','sent')
           ) THEN 'suppressed' ELSE 'pending' END,?
         FROM watch_bindings b
         WHERE b.id=? AND b.enabled=1
           AND EXISTS(
             SELECT 1 FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
             WHERE m.watch_binding_id=b.id AND l.id=?
               AND (l.availability='sold_out' OR (l.availability='unavailable' AND l.last_changed_at<=?))
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        eventKey,
        row.listing_id,
        payload,
        row.listing_id,
        now,
        row.binding_id,
        row.listing_id,
        cutoff,
      ));
      bindingUpdateResultIndexes.push(statements.length);
      statements.push(this.db.prepare(
        `UPDATE watch_bindings
         SET enabled=0,cooldown_until=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=?
         WHERE id=? AND enabled=1
           AND EXISTS(
             SELECT 1 FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
             WHERE m.watch_binding_id=watch_bindings.id AND l.id=?
               AND (l.availability='sold_out' OR (l.availability='unavailable' AND l.last_changed_at<=?))
           )`,
      ).bind(now, row.binding_id, row.listing_id, cutoff));
    }
    for (const profileId of new Set(candidates.map((row) => row.watch_profile_id))) {
      statements.push(this.db.prepare(
        `UPDATE watch_profiles SET enabled=0,updated_at=?
         WHERE id=? AND enabled=1
           AND NOT EXISTS(
             SELECT 1 FROM watch_bindings
             WHERE watch_profile_id=watch_profiles.id AND enabled=1
           )`,
      ).bind(now, profileId));
    }
    const results = await this.db.batch(statements);
    return bindingUpdateResultIndexes.reduce(
      (total, resultIndex) => total + Number(results[resultIndex]?.meta.changes ?? 0),
      0,
    );
  }

  async failBinding(binding: WatchBindingRow, code: string, message: string, httpStatus?: number, retryAfterSeconds?: number): Promise<void> {
    const now = new Date().toISOString();
    const failures = binding.consecutive_failures + 1;
    const parserFailure = isParserFailureCode(code);
    const captcha = code === "captcha";
    // source-runner 的串行队列满了是我们自己这一侧的背压，不是来源出问题：首次失败
    // 按 schedule_interval_minutes 冷却，对日更绑定就意味着排一次队就停掉一整天。
    // 给它分钟级的退避，并随连续失败逐步拉长，最长不超过本来的巡回间隔。
    const backpressure = code === "queue_full" || code === "queue_stopping";
    const sameDayRetry = sameDayRetryEligible(binding, code, httpStatus);
    const cooldownMinutes = sameDayRetry ? SAME_DAY_RETRY_COOLDOWN_MINUTES
      : parserFailure || captcha ? 24 * 60
      : httpStatus === 403 ? 12 * 60
      : httpStatus === 429 ? Math.max(1, Math.ceil((retryAfterSeconds ?? 2 * 60 * 60) / 60))
      : backpressure ? Math.min(binding.schedule_interval_minutes, 5 * Math.min(failures, 6))
      : failures >= 5 ? 12 * 60
      : failures >= 3 ? 6 * 60
      : failures >= 2 ? 2 * 60
      : binding.schedule_interval_minutes;
    const cooldown = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    const statements = [
      this.db.prepare(
        `UPDATE watch_bindings SET consecutive_failures = consecutive_failures + 1, cooldown_until = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END,
         next_run_at=CASE WHEN ? AND source_config_json=? THEN ? ELSE next_run_at END,
         last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
      ).bind(cooldown, parserFailure ? 1 : 0, adaptiveItemScheduleEnabled(binding), binding.source_config_json,
        cooldown, code, message.slice(0, 500), now, binding.id),
      this.db.prepare(
        `UPDATE source_registry SET health_status = CASE WHEN ? THEN 'broken' WHEN ? IN (403, 429) OR ? THEN 'blocked' ELSE 'degraded' END,
         enabled = CASE WHEN ? THEN 0 ELSE enabled END, cooldown_until = CASE WHEN id = 'mercari_jp' THEN cooldown_until ELSE ? END,
         last_failure_at = ?, consecutive_failures = consecutive_failures + 1, last_http_status = ?,
         last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
      ).bind(parserFailure ? 1 : 0, httpStatus ?? null, captcha ? 1 : 0, parserFailure ? 1 : 0, cooldown,
        now, httpStatus ?? null, code, message.slice(0, 500), now, binding.source_id),
    ];
    // parser 结构错误与 CAPTCHA 在第一次就把绑定和整个来源置为 enabled=0，
    // 而通知门槛原本是连续 3 次失败 —— 于是停用永远发生在通知之前，用户收不到
    // 任何邮件或微信，只能靠人工发现来源已停。停用即必须通知。
    const disabled = parserFailure || captcha;
    if (failures >= 3 || disabled) {
      const eventKey = `source_error:${binding.id}:${now.slice(0, 10)}`;
      // 同一段连续失败（自上次成功起）最多提醒 SOURCE_ERROR_REMINDERS_PER_STREAK 次。
      // 修不好的来源原本每天一封，两周攒下几十封一样的错误信，把真正的日报淹掉。
      statements.push(this.db.prepare(
        `INSERT INTO events(id,event_key,event_type,watch_profile_id,watch_binding_id,payload_json,status,created_at)
         SELECT ?,?,'source_error',?,?,?,'pending',?
         WHERE (
           SELECT COUNT(*) FROM events e
           WHERE e.watch_binding_id=? AND e.event_type='source_error' AND e.status<>'suppressed'
             AND e.created_at>COALESCE((SELECT b.last_success_at FROM watch_bindings b WHERE b.id=?),'')
         )<${SOURCE_ERROR_REMINDERS_PER_STREAK}
         ON CONFLICT DO NOTHING`,
      ).bind(crypto.randomUUID(), eventKey, binding.watch_profile_id, binding.id,
        JSON.stringify({
          sourceId: binding.source_id,
          bindingId: binding.id,
          profileName: binding.profile_name ?? null,
          monitorTarget: (binding.query ?? binding.target_url ?? binding.source_item_id ?? "").slice(0, 300),
          code,
          message: message.slice(0, 500),
          failures,
          httpStatus: httpStatus ?? null,
          disabled,
        }), now, binding.id, binding.id));
    }
    await this.db.batch(statements);
  }

  /**
   * A missing item page is an item lifecycle observation, not a source outage.
   * Keep the watch alive at a low cadence without degrading the source or
   * accumulating failure alerts; a later successful observation resumes the
   * binding's configured cadence naturally.
   */
  async deferTemporarilyUnavailableItem(bindingId: string, delayHours = 24): Promise<string> {
    const hours = Math.max(1, Math.min(Math.floor(delayHours), 24 * 30));
    const now = new Date().toISOString();
    const nextRunAt = new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
    await this.db.prepare(
      `UPDATE watch_bindings SET next_run_at=?,cooldown_until=NULL,consecutive_failures=0,
       last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`,
    ).bind(nextRunAt, now, bindingId).run();
    return nextRunAt;
  }

  /**
   * 单件商品下架（煤炉删除/暂停出售、乐天 404）满 days 天仍未恢复，就暂停这条监控（2026-10-16 定）。
   * 煤炉卖家可以暂停出售再原链接恢复、事务局删除可申诉一周内撤回，所以先每天看一次；
   * 过了期限还看不到就算结束，暂停而不删除，历史价格保留，页面上点「恢复」即可再盯。
   * 起算点取「商品变成看不到」和「用户最近一次手动恢复这条来源」两者中较晚的那个，
   * 否则用户手动恢复后的第一轮就会立刻又被暂停。
   */
  async pauseLongUnavailableItem(bindingId: string, days: number): Promise<boolean> {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
    const binding = await this.db.prepare(
      `SELECT b.watch_profile_id,b.source_id FROM watch_bindings b
       WHERE b.id=? AND b.enabled=1
         AND EXISTS (SELECT 1 FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
                     WHERE m.watch_binding_id=b.id AND l.availability='unavailable' AND l.last_changed_at<=?)
         AND NOT EXISTS (SELECT 1 FROM watch_profile_changes c
                         WHERE c.watch_profile_id=b.watch_profile_id AND c.source_id=b.source_id
                           AND c.field='source_enabled' AND c.after_value='巡回中' AND c.changed_at>?)`,
    ).bind(bindingId, cutoff, cutoff).first<{ watch_profile_id: string; source_id: string }>();
    if (!binding) return false;
    await this.db.batch([
      this.db.prepare("UPDATE watch_bindings SET enabled=0,updated_at=? WHERE id=? AND enabled=1").bind(now, bindingId),
      this.db.prepare(
        `INSERT INTO watch_profile_changes(id,watch_profile_id,source_id,field,before_value,after_value,changed_at)
         VALUES(?,?,?,'source_enabled','巡回中',?,?)`,
      ).bind(crypto.randomUUID(), binding.watch_profile_id, binding.source_id, `已暂停（商品下架满 ${days} 天未恢复，自动暂停）`, now),
    ]);
    return true;
  }

  async markBindingListingUnavailable(bindingId: string): Promise<{
    listingId: string;
    previous: ListingState;
    current: ListingState;
    observedAt: string;
  } | null> {
    const listing = await this.db.prepare(
      `SELECT l.id,l.current_price,l.original_price,l.price_basis,l.currency,l.item_condition,l.availability,l.state_hash
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id=? ORDER BY m.last_seen_at DESC LIMIT 1`,
    ).bind(bindingId).first<{
      id: string;
      current_price: number | null;
      original_price: number | null;
      price_basis: NormalizedListing["priceBasis"];
      currency: string;
      item_condition: string;
      availability: string;
      state_hash: string | null;
    }>();
    if (!listing || listing.availability === "unavailable") return null;
    const now = new Date().toISOString();
    const stateHash = await stableStateHash({
      price: listing.current_price ?? undefined,
      originalPrice: listing.original_price ?? undefined,
      availability: "unavailable",
      condition: listing.item_condition,
    });
    await this.db.batch([
      this.db.prepare(
        "UPDATE listings SET availability='unavailable',state_hash=?,last_changed_at=?,last_seen_at=? WHERE id=?",
      ).bind(stateHash, now, now, listing.id),
      this.db.prepare(
        `INSERT INTO listing_snapshots(id,listing_id,watch_binding_id,price,original_price,price_basis,currency,
         availability,item_condition,state_hash,observed_at) VALUES(?,?,?,?,?,?,?,'unavailable',?,?,?)`,
      ).bind(crypto.randomUUID(), listing.id, bindingId, listing.current_price, listing.original_price,
        listing.price_basis, listing.currency, listing.item_condition, stateHash, now),
    ]);
    return {
      listingId: listing.id,
      previous: {
        price: listing.current_price ?? undefined,
        availability: listing.availability as NormalizedListing["availability"],
        stateHash: listing.state_hash ?? undefined,
      },
      current: {
        price: listing.current_price ?? undefined,
        availability: "unavailable",
        stateHash,
      },
      observedAt: now,
    };
  }

  /**
   * 原子占用一个当日邮件配额。并发投递方各自竞争 UPDATE 的 WHERE emails_sent < limit，
   * 计数在发送前占位（失败也不释放：上游配额同样已被消耗，且避免失败重试风暴）。
   */
}
