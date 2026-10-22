/**
 * 商品跟踪：到期取件、预约、激活、完成、失联确认、暂停与下架。
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
import { QueueRepository } from "./queue";

export abstract class TrackedListingRepository extends QueueRepository {
  async dueTrackedListings(limit: number): Promise<TrackedListingRow[]> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `SELECT m.*,l.source_id,l.source_item_id,l.canonical_url,l.title,l.currency,
              l.current_price,l.original_price,l.price_basis,l.item_condition,l.availability,
              l.state_hash,l.content_hash,l.product_facts_json
       FROM watch_listing_matches m
       JOIN watch_bindings b ON b.id=m.watch_binding_id
       JOIN watch_profiles p ON p.id=b.watch_profile_id
       JOIN listings l ON l.id=m.listing_id
       WHERE p.dossier_kind='exact_product' AND p.enabled=1 AND b.enabled=1
         AND m.tracking_status IN ('active','unavailable_pending','waiting_restock')
         AND m.tracking_next_run_at IS NOT NULL AND m.tracking_next_run_at<=?
         AND (m.tracking_cooldown_until IS NULL OR m.tracking_cooldown_until<=?)
       ORDER BY m.tracking_next_run_at ASC LIMIT ?`,
    ).bind(now, now, limit).all<TrackedListingRow>();
    return result.results;
  }

  async getTrackedListing(bindingId: string, listingId: string): Promise<TrackedListingRow | null> {
    return this.db.prepare(
      `SELECT m.*,l.source_id,l.source_item_id,l.canonical_url,l.title,l.currency,
              l.current_price,l.original_price,l.price_basis,l.item_condition,l.availability,
              l.state_hash,l.content_hash,l.product_facts_json
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id=? AND m.listing_id=?`,
    ).bind(bindingId, listingId).first<TrackedListingRow>();
  }

  async reserveTrackedListing(tracked: TrackedListingRow): Promise<boolean> {
    if (!tracked.tracking_next_run_at) return false;
    const intervalMs = tracked.tracking_interval_minutes * 60_000;
    const now = Date.now();
    const scheduledAt = Date.parse(tracked.tracking_next_run_at);
    const base = Number.isFinite(scheduledAt) ? scheduledAt : now;
    const elapsed = Math.max(0, now - base);
    const periods = Math.floor(elapsed / intervalMs) + 1;
    const nextRunAt = new Date(base + periods * intervalMs).toISOString();
    const nowIso = new Date().toISOString();
    const result = await this.db.prepare(
      `UPDATE watch_listing_matches
       SET tracking_next_run_at=?,tracking_last_run_at=?
       WHERE watch_binding_id=? AND listing_id=? AND tracking_next_run_at=?
         AND tracking_status IN ('active','unavailable_pending','waiting_restock')`,
    ).bind(
      nextRunAt,
      nowIso,
      tracked.watch_binding_id,
      tracked.listing_id,
      tracked.tracking_next_run_at,
    ).run();
    return Number(result.meta.changes ?? 0) > 0;
  }

  async activateExactProductListingTracking(
    binding: WatchBindingRow,
    listingId: string,
    itemLookupSupported = true,
  ): Promise<TrackedListingRow["tracking_status"] | null> {
    if (binding.profile_dossier_kind !== "exact_product") return null;
    const current = await this.db.prepare(
      `SELECT m.tracking_status,m.tracking_next_run_at,l.current_price,l.availability,l.state_hash
       FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
       WHERE m.watch_binding_id=? AND m.listing_id=?`,
    ).bind(binding.id, listingId).first<{
      tracking_status: TrackedListingRow["tracking_status"];
      tracking_next_run_at: string | null;
      current_price: number | null;
      availability: Availability;
      state_hash: string | null;
    }>();
    // 发现任务只负责给首次确认的 match 建立子状态。已经在运行的子任务必须只由
    // 独立详情检查推进，不能因搜索页一轮缺货/消失就被静默终止。
    //
    // anchor_known 也要能回到这里。那个状态的意思是"这条报价另有一份单品监控在盯，
    // 精确档案不重复抓"，是一次去重，不是一个终局结论。一旦那份单品监控被停用或
    // 删掉，去重的前提就没了（findListingsWithMatchState 会随之不再认定 knownItemWatch），
    // 这条报价必须由精确档案自己接管，否则它会停在一个没人负责的终局里。
    if (!current || !["discovery_only", "paused", "anchor_known"].includes(current.tracking_status)) {
      return current?.tracking_status ?? null;
    }
    // 设了目标价的档案不建逐条盯价任务。这种档案要的是"每天那一轮搜索里，谁的价格
    // 已经低于目标价"——判定在搜索轮次里就做完了（gemini-jobs 的 newOfferTargetHit
    // 不要求价格先高后低，当轮命中即发）。再给每条确认同款建一个独立详情任务，
    // 拿到的是同一批商品的同一个价格，只是多打一遍上游：一个档案 18 条同款，
    // 就是每天 18 次多余请求，还得挨个承受商品售出后的 410 与来源封禁。
    // 没设目标价的档案才是真的在等降价，那些继续逐条盯。
    if (binding.target_price !== null) return current.tracking_status;
    const now = new Date().toISOString();
    // Candidate checks follow the cadence configured on the exact-product
    // dossier. Discovery and per-offer tracking are separate jobs, but one
    // schedule remains the user's source of truth.
    const interval = binding.schedule_interval_minutes;
    const oneOff = isOneOffListingSource(binding.source_id);
    const purchasable = ["available", "preorder", "backorder"].includes(current.availability);
    const terminalAtDiscovery = oneOff && ["sold_out", "unavailable"].includes(current.availability);
    const status: TrackedListingRow["tracking_status"] = !itemLookupSupported
      ? "paused"
      : terminalAtDiscovery
        ? "terminal"
        : purchasable || current.availability === "unknown"
          ? "active"
          : "waiting_restock";
    const nextRunAt = status === "active" || status === "waiting_restock"
      ? current.tracking_next_run_at ?? new Date(Date.now() + interval * 60_000).toISOString()
      : null;
    await this.db.prepare(
      `UPDATE watch_listing_matches SET
         tracking_status=?,tracking_interval_minutes=?,tracking_next_run_at=?,
         tracking_baseline_completed=1,tracking_last_price=?,tracking_last_availability=?,
         tracking_last_state_hash=?,tracking_started_at=COALESCE(tracking_started_at,?),
         tracking_ended_at=?,tracking_terminal_reason=?,
         tracking_last_error_code=?,tracking_last_error_message=?
       WHERE watch_binding_id=? AND listing_id=?
         AND tracking_status IN ('discovery_only','paused','anchor_known')`,
    ).bind(
      status,
      interval,
      nextRunAt,
      current.current_price,
      current.availability,
      current.state_hash,
      now,
      status === "terminal" ? now : null,
      status === "terminal" ? "already_terminal_when_discovered" : null,
      status === "paused" ? "item_lookup_unsupported" : null,
      status === "paused" ? "该来源暂不支持独立商品详情跟踪；发现流程仍会继续运行" : null,
      binding.id,
      listingId,
    ).run();
    return status;
  }

  async completeTrackedListing(
    tracked: TrackedListingRow,
    observation: { price: number | null; availability: Availability; stateHash: string },
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const oneOff = isOneOffListingSource(tracked.source_id);
    const terminal = oneOff && ["sold_out", "unavailable"].includes(observation.availability);
    const status: TrackedListingRow["tracking_status"] = terminal
      ? "terminal"
      : ["sold_out", "unavailable"].includes(observation.availability)
        ? "waiting_restock"
        : "active";
    const nextRunAt = status === "terminal"
      ? null
      : new Date(Date.now() + tracked.tracking_interval_minutes * 60_000).toISOString();
    const result = await this.db.prepare(
      `UPDATE watch_listing_matches SET tracking_status=?,tracking_next_run_at=?,
         tracking_last_success_at=?,tracking_baseline_completed=1,
         tracking_last_price=?,tracking_last_availability=?,tracking_last_state_hash=?,
         tracking_consecutive_failures=0,tracking_cooldown_until=NULL,
         tracking_last_error_code=NULL,tracking_last_error_message=NULL,
         tracking_missing_observations=0,tracking_ended_at=?,tracking_terminal_reason=?
       WHERE watch_binding_id=? AND listing_id=?
         AND tracking_status IN ('active','unavailable_pending','waiting_restock')`,
    ).bind(
      status,
      nextRunAt,
      now,
      observation.price,
      observation.availability,
      observation.stateHash,
      terminal ? now : null,
      terminal ? `confirmed_${observation.availability}` : null,
      tracked.watch_binding_id,
      tracked.listing_id,
    ).run();
    return Number(result.meta.changes ?? 0) > 0;
  }

  async recordTrackedListingMissing(tracked: TrackedListingRow): Promise<{ accepted: boolean; confirmed: boolean }> {
    const missing = tracked.tracking_missing_observations + 1;
    const confirmed = missing >= 2;
    const now = new Date().toISOString();
    const terminal = confirmed && isOneOffListingSource(tracked.source_id);
    const status: TrackedListingRow["tracking_status"] = !confirmed
      ? "unavailable_pending"
      : terminal
        ? "terminal"
        : "waiting_restock";
    const nextRunAt = terminal
      ? null
      : new Date(Date.now() + (confirmed ? tracked.tracking_interval_minutes : 15) * 60_000).toISOString();
    const result = await this.db.prepare(
      `UPDATE watch_listing_matches SET tracking_status=?,tracking_next_run_at=?,
         tracking_missing_observations=?,tracking_last_success_at=?,
         tracking_consecutive_failures=0,tracking_cooldown_until=NULL,
         tracking_last_error_code=?,tracking_last_error_message=?,
         tracking_ended_at=?,tracking_terminal_reason=?
       WHERE watch_binding_id=? AND listing_id=?
         AND tracking_status IN ('active','unavailable_pending','waiting_restock')`,
    ).bind(
      status,
      nextRunAt,
      missing,
      now,
      confirmed ? "item_missing_confirmed" : "item_missing_pending_confirmation",
      confirmed ? "商品详情连续两次不可访问，已确认下架状态" : "商品详情首次不可访问，将在 15 分钟后复核",
      terminal ? now : null,
      terminal ? "confirmed_missing" : null,
      tracked.watch_binding_id,
      tracked.listing_id,
    ).run();
    return { accepted: Number(result.meta.changes ?? 0) > 0, confirmed };
  }

  async failTrackedListing(
    tracked: TrackedListingRow,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ): Promise<void> {
    const failures = tracked.tracking_consecutive_failures + 1;
    const fallbackMinutes = failures >= 5 ? 12 * 60 : failures >= 3 ? 6 * 60 : failures >= 2 ? 2 * 60 : 60;
    const delayMinutes = Math.max(15, Math.ceil((retryAfterSeconds ?? fallbackMinutes * 60) / 60));
    const cooldown = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    await this.db.prepare(
      `UPDATE watch_listing_matches SET tracking_next_run_at=?,tracking_cooldown_until=?,
         tracking_consecutive_failures=tracking_consecutive_failures+1,
         tracking_last_error_code=?,tracking_last_error_message=?
       WHERE watch_binding_id=? AND listing_id=?
         AND tracking_status IN ('active','unavailable_pending','waiting_restock')`,
    ).bind(
      cooldown,
      cooldown,
      code,
      message.slice(0, 500),
      tracked.watch_binding_id,
      tracked.listing_id,
    ).run();
  }

  async pauseTrackedListing(tracked: TrackedListingRow, code: string, message: string): Promise<void> {
    await this.db.prepare(
      `UPDATE watch_listing_matches SET tracking_status='paused',tracking_next_run_at=NULL,
         tracking_cooldown_until=NULL,tracking_last_error_code=?,tracking_last_error_message=?
       WHERE watch_binding_id=? AND listing_id=?
         AND tracking_status IN ('active','unavailable_pending','waiting_restock')`,
    ).bind(code, message.slice(0, 500), tracked.watch_binding_id, tracked.listing_id).run();
  }

  async markTrackedListingUnavailable(tracked: TrackedListingRow): Promise<string> {
    const now = new Date().toISOString();
    const stateHash = await stableStateHash({
      price: tracked.current_price ?? undefined,
      originalPrice: tracked.original_price ?? undefined,
      availability: "unavailable",
      condition: tracked.item_condition,
    });
    const changed = tracked.availability !== "unavailable" || tracked.state_hash !== stateHash;
    const statements: OperationalPreparedStatement[] = [this.db.prepare(
      `UPDATE listings SET availability='unavailable',state_hash=?,last_seen_at=?,
         last_changed_at=CASE WHEN availability<>'unavailable' OR state_hash IS DISTINCT FROM ? THEN ? ELSE last_changed_at END
       WHERE id=?`,
    ).bind(stateHash, now, stateHash, now, tracked.listing_id)];
    statements.push(this.db.prepare(
      `UPDATE watch_listing_matches
       SET tracking_last_availability='unavailable',tracking_last_state_hash=?
       WHERE watch_binding_id=? AND listing_id=? AND tracking_missing_observations>=2
         AND tracking_status IN ('terminal','waiting_restock')`,
    ).bind(stateHash, tracked.watch_binding_id, tracked.listing_id));
    if (changed) {
      statements.push(this.db.prepare(
        `INSERT INTO listing_snapshots(
           id,listing_id,watch_binding_id,price,original_price,price_basis,currency,
           availability,item_condition,state_hash,observed_at,content_hash,product_facts_json
         ) VALUES(?,?,?,?,?,?,?,'unavailable',?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        tracked.listing_id,
        tracked.watch_binding_id,
        tracked.current_price,
        tracked.original_price,
        tracked.price_basis,
        tracked.currency,
        tracked.item_condition,
        stateHash,
        now,
        tracked.content_hash,
        tracked.product_facts_json,
      ));
    }
    await this.db.batch(statements);
    return stateHash;
  }

}
