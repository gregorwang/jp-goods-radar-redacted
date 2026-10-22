/**
 * 配额与计数：每日邮件名额、日计数器、托管 API 用量与计费、响应缓存。
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
import { HealthRepository } from "./health";

export abstract class QuotaRepository extends HealthRepository {
  async reserveEmailSlot(dailyLimit: number): Promise<boolean> {
    const day = japanDayKey();
    const now = new Date().toISOString();
    // day_utc 是历史列名（改名要迁移且没有收益），实际写入的是 JST 日历日。
    // reserveEmailSlot / incrementCounter / emailsSentToday 必须用同一个 key，
    // 任何一处退回 UTC 日都会让配额在日中途静默重置。
    await this.db.prepare(
      `INSERT INTO daily_counters (day_utc, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(day_utc) DO NOTHING`,
    ).bind(day, now, now).run();
    const result = await this.db.prepare(
      `UPDATE daily_counters SET emails_sent = emails_sent + 1, updated_at = ?
       WHERE day_utc = ? AND emails_sent < ?`,
    ).bind(now, day, dailyLimit).run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async incrementCounter(column: "queued_jobs" | "search_calls" | "detail_calls" | "emails_sent" | "emails_failed", amount = 1): Promise<void> {
    // 列名直接插入 SQL。类型是字面量联合，但编译期是唯一屏障 —— 任何 JS 调用方或
    // 一次类型放宽都会重新引入注入面，因此加一道运行时白名单。
    if (!DAILY_COUNTER_COLUMNS.has(column)) throw new Error("invalid_counter_column");
    const day = japanDayKey();
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO daily_counters (day_utc, ${column}, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day_utc) DO UPDATE SET
         ${column} = daily_counters.${column} + excluded.${column}, updated_at = excluded.updated_at`,
    ).bind(day, amount, now, now).run();
  }

  async managedApiUsage(provider: string, runtimeBudget = 40, emergencyReserve = 20): Promise<import("../types").ManagedApiUsage> {
    const monthUtc = new Date().toISOString().slice(0, 7);
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO managed_api_monthly_usage(provider,month_utc,runtime_budget,runtime_calls,emergency_reserve,updated_at)
       VALUES(?,?,?,0,?,?) ON CONFLICT(provider,month_utc) DO NOTHING`,
    ).bind(provider, monthUtc, runtimeBudget, emergencyReserve, now).run();
    const row = await this.db.prepare(
      `SELECT provider,month_utc,runtime_budget,runtime_calls,emergency_reserve
       FROM managed_api_monthly_usage WHERE provider=? AND month_utc=?`,
    ).bind(provider, monthUtc).first<{
      provider: string;
      month_utc: string;
      runtime_budget: number;
      runtime_calls: number;
      emergency_reserve: number;
    }>();
    if (!row) throw new Error("managed_api_usage_missing");
    return {
      provider: row.provider,
      monthUtc: row.month_utc,
      runtimeBudget: row.runtime_budget,
      runtimeCalls: row.runtime_calls,
      emergencyReserve: row.emergency_reserve,
    };
  }

  async reserveManagedApiCall(provider: string, runtimeBudget = 40, emergencyReserve = 20): Promise<boolean> {
    const usage = await this.managedApiUsage(provider, runtimeBudget, emergencyReserve);
    const result = await this.db.prepare(
      `UPDATE managed_api_monthly_usage SET runtime_calls=runtime_calls+1,updated_at=?
       WHERE provider=? AND month_utc=? AND runtime_calls<runtime_budget`,
    ).bind(new Date().toISOString(), provider, usage.monthUtc).run();
    return result.meta.changes === 1;
  }

  async latestManagedApiBillingUsage(provider: string): Promise<import("../types").ManagedApiBillingUsage | null> {
    const row = await this.db.prepare(
      `SELECT provider,period_started_at,period_ends_at,runtime_budget,runtime_calls,emergency_reserve,
              daily_day_jst,daily_budget,daily_runtime_calls
       FROM managed_api_billing_usage WHERE provider=? ORDER BY period_ends_at DESC LIMIT 1`,
    ).bind(provider).first<{
      provider: string;
      period_started_at: string;
      period_ends_at: string;
      runtime_budget: number;
      runtime_calls: number;
      emergency_reserve: number;
      daily_day_jst: string | null;
      daily_budget: number;
      daily_runtime_calls: number;
    }>();
    return row ? {
      provider: row.provider,
      periodStartedAt: row.period_started_at,
      periodEndsAt: row.period_ends_at,
      runtimeBudget: row.runtime_budget,
      runtimeCalls: row.runtime_calls,
      emergencyReserve: row.emergency_reserve,
      dailyDayJst: row.daily_day_jst,
      dailyBudget: row.daily_budget,
      dailyRuntimeCalls: row.daily_runtime_calls,
    } : null;
  }

  async reserveManagedApiBillingCall(input: {
    provider: string;
    periodStartedAt: string;
    periodEndsAt: string;
    runtimeBudget: number;
    emergencyReserve: number;
    dailyBudget?: number;
  }): Promise<import("../types").ManagedApiBillingUsage | null> {
    const now = new Date().toISOString();
    const dayJst = japanDayKey();
    const dailyBudget = Math.max(0, Math.floor(input.dailyBudget ?? input.runtimeBudget));
    await this.db.prepare(
      `INSERT INTO managed_api_billing_usage(
         provider,period_started_at,period_ends_at,runtime_budget,runtime_calls,emergency_reserve,
         daily_day_jst,daily_budget,daily_runtime_calls,updated_at
       ) VALUES(?,?,?,?,0,?,?,?,0,?)
       ON CONFLICT(provider,period_started_at) DO UPDATE SET
         period_ends_at=excluded.period_ends_at,
         runtime_budget=LEAST(managed_api_billing_usage.runtime_budget,excluded.runtime_budget),
         emergency_reserve=GREATEST(managed_api_billing_usage.emergency_reserve,excluded.emergency_reserve),
         daily_budget=CASE
           WHEN managed_api_billing_usage.daily_budget=0 THEN excluded.daily_budget
           ELSE LEAST(managed_api_billing_usage.daily_budget,excluded.daily_budget)
         END,
         updated_at=excluded.updated_at`,
    ).bind(
      input.provider,
      input.periodStartedAt,
      input.periodEndsAt,
      input.runtimeBudget,
      input.emergencyReserve,
      dayJst,
      dailyBudget,
      now,
    ).run();
    const result = await this.db.prepare(
      `UPDATE managed_api_billing_usage
       SET runtime_calls=runtime_calls+1,
           daily_runtime_calls=CASE WHEN daily_day_jst=? THEN daily_runtime_calls+1 ELSE 1 END,
           daily_day_jst=?,
           updated_at=?
       WHERE provider=? AND period_started_at=? AND runtime_calls<runtime_budget
         AND (daily_day_jst IS NULL OR daily_day_jst<>? OR daily_runtime_calls<daily_budget)`,
    ).bind(dayJst, dayJst, now, input.provider, input.periodStartedAt, dayJst).run();
    if (result.meta.changes !== 1) return null;
    const row = await this.db.prepare(
      `SELECT provider,period_started_at,period_ends_at,runtime_budget,runtime_calls,emergency_reserve,
              daily_day_jst,daily_budget,daily_runtime_calls
       FROM managed_api_billing_usage WHERE provider=? AND period_started_at=?`,
    ).bind(input.provider, input.periodStartedAt).first<{
      provider: string;
      period_started_at: string;
      period_ends_at: string;
      runtime_budget: number;
      runtime_calls: number;
      emergency_reserve: number;
      daily_day_jst: string | null;
      daily_budget: number;
      daily_runtime_calls: number;
    }>();
    return row ? {
      provider: row.provider,
      periodStartedAt: row.period_started_at,
      periodEndsAt: row.period_ends_at,
      runtimeBudget: row.runtime_budget,
      runtimeCalls: row.runtime_calls,
      emergencyReserve: row.emergency_reserve,
      dailyDayJst: row.daily_day_jst,
      dailyBudget: row.daily_budget,
      dailyRuntimeCalls: row.daily_runtime_calls,
    } : null;
  }

  async recordManagedApiBudgetWarning(input: {
    provider: string;
    sourceId: string;
    runtimeCalls: number;
    runtimeBudget: number;
    warningThreshold: number;
    message: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const eventKey = `source_error:managed_api:${input.provider}:${japanDayKey()}`;
    const result = await this.db.prepare(
      `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at)
       VALUES(?,?,'source_error',?,'pending',?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      eventKey,
      JSON.stringify({
        sourceId: input.sourceId,
        profileName: "托管 API 配额",
        code: `${input.provider}_budget_warning`,
        message: input.message.slice(0, 500),
        failures: 0,
        disabled: false,
        provider: input.provider,
        runtimeCalls: input.runtimeCalls,
        runtimeBudget: input.runtimeBudget,
        warningThreshold: input.warningThreshold,
      }),
      now,
    ).run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async managedApiCacheGet(provider: string, cacheKey: string): Promise<string | null> {
    const row = await this.db.prepare(
      "SELECT response_json FROM managed_api_cache WHERE provider=? AND cache_key=? AND expires_at>?",
    ).bind(provider, cacheKey, new Date().toISOString()).first<{ response_json: string }>();
    return row?.response_json ?? null;
  }

  async managedApiCachePut(provider: string, cacheKey: string, responseJson: string, expiresAt: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO managed_api_cache(provider,cache_key,response_json,expires_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(provider,cache_key) DO UPDATE SET response_json=excluded.response_json,
       expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    ).bind(provider, cacheKey, responseJson, expiresAt, now, now).run();
  }

}
