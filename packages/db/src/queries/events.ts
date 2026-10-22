/**
 * 监控事件：事件批量落库、规则命中判定、强提醒排程。
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
import { ListingRepository } from "./listings";

export abstract class EventRepository extends ListingRepository {
  async insertEventBatch(
    binding: WatchBindingRow,
    groups: readonly { listingId: string; events: readonly EventCandidate[] }[],
  ): Promise<number> {
    const candidates = groups.flatMap(({ listingId, events }) => events.map((event) => ({ listingId, event })));
    if (candidates.length === 0) return 0;
    const createdAt = new Date().toISOString();
    const restockMedianActiveDays = candidates.some(({ event }) => event.type === "restock")
      ? await this.profileMedianObservedActiveDurationDays(binding.watch_profile_id)
      : undefined;
    // 分片语句先全部建好再一次性 batch：逐片 await 会把一次关键词轮询的
    // 避免数据库往返数放大到分片数量级。
    const existingLegacyIds = new Map<string, string>();
    const legacyKeyResults = await this.db.batch<{ id: string; event_key: string }>(
      chunks([...new Set(candidates.map(({ event }) => event.eventKey))], SQL_ID_CHUNK_SIZE)
        .map((keyChunk) => this.db.prepare(
          `SELECT id,event_key FROM events WHERE event_key IN (${keyChunk.map(() => "?").join(",")})`,
        ).bind(...keyChunk)),
    );
    legacyKeyResults.forEach((result) => result.results
      .forEach((row) => existingLegacyIds.set(row.event_key, row.id)));

    let v2Enabled = false;
    let rule: MonitorRuleRow | null = null;
    try {
      const flag = await this.db.prepare(
        "SELECT enabled FROM runtime_feature_flags WHERE flag_key='monitor_rules_v2'",
      ).first<{ enabled: number }>();
      v2Enabled = flag?.enabled === 1;
      if (v2Enabled) {
        rule = await this.db.prepare(
          `SELECT * FROM monitor_rules
           WHERE watch_profile_id=? AND valid_to IS NULL
           ORDER BY version DESC LIMIT 1`,
        ).bind(binding.watch_profile_id).first<MonitorRuleRow>();
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
    }

    // 一次调用只解析出一条 rule（按 binding.watch_profile_id 取最新版本），因此
    // listing 行与落地成本配置整批共用，不再随候选事件逐条重查。
    const listings = new Map<string, MonitorListingRow>();
    let landedCost: MonitorLandedCostContext | null = null;
    if (v2Enabled && rule && monitorRuleScopeUsable(rule) && monitorRuleAcceptsSource(rule, binding.source_id)) {
      const listingResults = await this.db.batch<MonitorListingRow>(
        chunks([...new Set(candidates.map(({ listingId }) => listingId))], SQL_ID_CHUNK_SIZE)
          .map((idChunk) => this.db.prepare(
            `SELECT l.id,l.first_seen_at,l.last_changed_at,l.current_price,l.currency,l.item_condition,l.availability,
                    l.price_basis,l.product_facts_json,
                    s.health_status source_health_status
             FROM listings l LEFT JOIN source_registry s ON s.id=l.source_id
             WHERE l.id IN (${idChunk.map(() => "?").join(",")})`,
          ).bind(...idChunk)),
      );
      listingResults.forEach((result) => result.results.forEach((row) => listings.set(row.id, row)));

      if (
        parsedStringArray(rule.event_types_json).includes("product.offer_below_target_landed_cost")
        && candidates.some(({ event }) => isPriceTargetTrigger(event.type))
      ) {
        // 老库没有 landed cost 相关表，"no such table" 必须继续被容忍。这三次读取
        // 刻意不与上面的 listing batch 合并：batch 是一个事务，缺表会连带把已经
        // 取到的 listing 行一起回滚掉。
        try {
          const flag = await this.db.prepare(
            "SELECT enabled FROM runtime_feature_flags WHERE flag_key='landed_cost_v1'",
          ).first<{ enabled: number }>();
          if (flag?.enabled === 1) {
            const target = await this.db.prepare(
              "SELECT * FROM monitor_rule_landed_cost_targets WHERE monitor_rule_id=?",
            ).bind(rule.id).first<MonitorRuleLandedCostTargetRow>();
            const profile = target
              ? await this.db.prepare("SELECT * FROM cost_profiles WHERE id=?")
                .bind(target.cost_profile_id).first<CostProfileRow>()
              : null;
            if (target && profile) landedCost = { target, profile };
          }
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
        }
      }
    }

    const legacyStatements: OperationalPreparedStatement[] = [];
    const monitorStatements: OperationalPreparedStatement[] = [];
    for (const { listingId, event } of candidates) {
      const legacyPayload = event.type === "restock" && restockMedianActiveDays !== undefined
        ? { ...event.payload, medianObservedActiveDurationDays: restockMedianActiveDays }
        : event.payload;
      const legacyId = existingLegacyIds.get(event.eventKey) ?? crypto.randomUUID();
      let legacyStatus: "pending" | "suppressed" = "pending";
      let deliveryNotBefore: string | null = null;

      if (v2Enabled && rule) {
        const prepared = await this.prepareMonitorEvent(rule, binding, listingId, event, legacyId, createdAt, {
          listing: listings.get(listingId) ?? null,
          landedCost,
        });
        if (prepared.kind === "suppressed") {
          legacyStatus = "suppressed";
        } else if (prepared.kind === "recorded") {
          legacyStatus = prepared.suppressLegacy ? "suppressed" : "pending";
          deliveryNotBefore = prepared.deliveryNotBefore;
          prepared.records.forEach((record) => monitorStatements.push(this.db.prepare(
              `INSERT INTO monitor_events(
                id,event_key,event_type,monitor_rule_id,rule_key,rule_version,
                watch_profile_id,watch_binding_id,subject_type,subject_id,listing_id,product_variant_id,
                payload_json,evidence_hash,notification_eligibility,suppression_reason,legacy_event_id,
                occurred_at,detected_at,created_at
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT DO NOTHING`,
            ).bind(
              crypto.randomUUID(),
              record.decision.eventKey,
              record.decision.eventType,
              rule.id,
              rule.rule_key,
              rule.version,
              binding.watch_profile_id,
              binding.id,
              record.subjectType,
              record.subjectId,
              listingId,
              rule.scope_type === "variant" && rule.scope_identity_status === "bound" ? rule.scope_id : null,
              record.payloadJson,
              record.decision.evidenceHash,
              record.decision.notificationEligibility,
              record.decision.suppressionReason,
              legacyId,
              record.occurredAt,
              createdAt,
              createdAt,
            )));
        }
      }

      legacyStatements.push(this.db.prepare(
        `INSERT INTO events (
          id,event_key,event_type,semantic_event_type,watch_profile_id,watch_binding_id,listing_id,
          payload_json,status,created_at,delivery_not_before
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        legacyId,
        event.eventKey,
        storedEventType(event.type),
        event.type,
        binding.watch_profile_id,
        binding.id,
        listingId,
        JSON.stringify(legacyPayload),
        legacyStatus,
        createdAt,
        deliveryNotBefore,
      ));
    }
    const results = await this.db.batch([...legacyStatements, ...monitorStatements]);
    return results.slice(0, legacyStatements.length)
      .reduce((total, result) => total + Number(result.meta.changes > 0), 0);
  }

  private async profileMedianObservedActiveDurationDays(profileId: string): Promise<number | undefined> {
    const rows = await this.db.prepare(
      `WITH profile_listings AS (
         SELECT DISTINCT l.id,l.source_id,l.source_item_id,l.canonical_url,l.title,l.image_url,l.seller_name,
                l.source_listed_at,l.first_seen_at,l.last_seen_at,l.current_price,l.availability,l.item_condition
         FROM watch_listing_matches match
         JOIN watch_bindings binding ON binding.id=match.watch_binding_id
         JOIN listings l ON l.id=match.listing_id
         WHERE binding.watch_profile_id=?
       ),
       ranked_snapshots AS (
         SELECT snapshot.id,snapshot.listing_id,snapshot.price,snapshot.availability,
                snapshot.item_condition,snapshot.observed_at,
                ROW_NUMBER() OVER (
                  PARTITION BY snapshot.listing_id
                  ORDER BY snapshot.observed_at DESC,snapshot.id DESC
                ) row_number
         FROM listing_snapshots snapshot
         JOIN profile_listings listing ON listing.id=snapshot.listing_id
       )
       SELECT listing.id,listing.source_id,listing.source_item_id,listing.canonical_url,listing.title,
              listing.image_url,listing.seller_name,listing.source_listed_at,listing.first_seen_at,
              listing.last_seen_at,listing.current_price,listing.availability,listing.item_condition,
              snapshot.id snapshot_id,snapshot.price snapshot_price,
              snapshot.availability snapshot_availability,snapshot.item_condition snapshot_condition,
              snapshot.observed_at snapshot_observed_at
       FROM profile_listings listing
       LEFT JOIN ranked_snapshots snapshot ON snapshot.listing_id=listing.id AND snapshot.row_number<=100
       ORDER BY listing.id,snapshot.observed_at`,
    ).bind(profileId).all<{
      id: string;
      source_id: SourceId;
      source_item_id: string;
      canonical_url: string;
      title: string;
      image_url: string | null;
      seller_name: string | null;
      source_listed_at: string | null;
      first_seen_at: string;
      last_seen_at: string;
      current_price: number | null;
      availability: NormalizedListing["availability"];
      item_condition: NormalizedListing["condition"];
      snapshot_id: string | null;
      snapshot_price: number | null;
      snapshot_availability: NormalizedListing["availability"] | null;
      snapshot_condition: NormalizedListing["condition"] | null;
      snapshot_observed_at: string | null;
    }>();
    const listings = new Map<string, {
      row: (typeof rows.results)[number];
      observations: Array<{
        evidenceId: string;
        evidenceKind: "operational_snapshot";
        observedAt: string;
        price?: number;
        availability: NormalizedListing["availability"];
        condition: NormalizedListing["condition"];
      }>;
    }>();
    for (const row of rows.results) {
      const entry = listings.get(row.id) ?? { row, observations: [] };
      if (row.snapshot_id && row.snapshot_observed_at && row.snapshot_availability && row.snapshot_condition) {
        entry.observations.push({
          evidenceId: row.snapshot_id,
          evidenceKind: "operational_snapshot",
          observedAt: row.snapshot_observed_at,
          ...(row.snapshot_price === null ? {} : { price: row.snapshot_price }),
          availability: row.snapshot_availability,
          condition: row.snapshot_condition,
        });
      }
      listings.set(row.id, entry);
    }
    const lifecycle = buildProductLifecycleIntelligence([...listings.values()].map(({ row, observations }) => ({
      membershipId: row.id,
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      canonicalUrl: row.canonical_url,
      title: row.title,
      ...(row.image_url ? { imageUrl: row.image_url } : {}),
      ...(row.seller_name ? { sellerName: row.seller_name } : {}),
      ...(row.source_listed_at ? { sourceListedAt: row.source_listed_at } : {}),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      ...(row.current_price === null ? {} : { currentPrice: row.current_price }),
      availability: row.availability,
      condition: row.item_condition,
      observations,
    })));
    return lifecycle.medianObservedActiveDurationDays;
  }

  private async prepareMonitorEvent(
    rule: MonitorRuleRow,
    binding: WatchBindingRow,
    listingId: string,
    event: EventCandidate,
    legacyEventId: string,
    detectedAt: string,
    // listing 与 landedCost 由 insertEventBatch 整批预取后传入，见那里的说明。
    context: { listing: MonitorListingRow | null; landedCost: MonitorLandedCostContext | null },
  ): Promise<
    | { kind: "legacy_only" }
    | { kind: "suppressed" }
    | {
      kind: "recorded";
      suppressLegacy: boolean;
      deliveryNotBefore: string | null;
      records: Array<{
        decision: MonitorEventInsertDecision;
        subjectType: "listing" | "variant" | "market";
        subjectId: string;
        payloadJson: string;
        occurredAt: string;
      }>;
    }
  > {
    // A pending variant scope is not a durable product identity. Keep the
    // compatibility notification path alive, but do not mint a V2 fact whose
    // product_variant_id would actually be a watch-profile placeholder.
    if (!monitorRuleScopeUsable(rule)) {
      return { kind: "legacy_only" };
    }
    // 热度上升（点赞 / 评论涨了）没有 V2 事实类型，也不受规则里的品相、来源健康等筛选：
    // 这件商品是用户亲手挑来盯的，照旧通知路径发。
    if (event.type === "interest_rise") return { kind: "legacy_only" };
    const primaryEventType = canonicalMonitorEventType(event.type);
    if (!primaryEventType) return { kind: "suppressed" };
    const configuredEvents = parsedStringArray(rule.event_types_json);
    if (!monitorRuleAcceptsSource(rule, binding.source_id)) {
      return { kind: "suppressed" };
    }

    const listing = context.listing;
    if (!listing) return { kind: "suppressed" };

    const conditions = parsedStringArray(rule.conditions_json);
    const completenessFilters = parsedStringArray(rule.completeness_json);
    const completeness = listingCompleteness(listing.product_facts_json);
    if (
      (conditions.length > 0 && !conditions.includes(listing.item_condition))
      || (completenessFilters.length > 0 && !completenessFilters.includes(completeness))
      || (rule.stale_source_policy === "exclude" && listing.source_health_status !== "healthy")
    ) {
      return { kind: "suppressed" };
    }

    const occurredAt = event.type === "new_listing" ? listing.first_seen_at : listing.last_changed_at;
    const selected: Array<{ eventType: MonitorEventType; eventPayload: Record<string, unknown> }> = [];
    const addSelected = (eventType: MonitorEventType, eventPayload: Record<string, unknown>) => {
      if (configuredEvents.includes(eventType) && !selected.some((item) => item.eventType === eventType)) {
        selected.push({ eventType, eventPayload });
      }
    };
    addSelected(primaryEventType, event.payload);
    // 目标价与落地成本目标此前只在 new_listing 分支判定，于是"已存在半年的商品降到
    // 目标价以下"永远不会触发用户配置的目标事件。降价与跨越目标价同样要参与判定。
    const priceTargetTrigger = isPriceTargetTrigger(event.type);
    if (priceTargetTrigger) {
      if (
        rule.target_listing_price !== null
        && listing.current_price !== null
        && listing.current_price <= rule.target_listing_price
        // 进行中拍卖的当前出价会一路上涨：开拍价 ¥1000 的拍卖不代表能以 ¥1000 买到，
        // 据此发"达到目标价"是假告警。
        && listing.price_basis !== "auction_current_bid"
      ) {
        addSelected("product.offer_below_target_listing_price", {
          newPrice: listing.current_price,
          targetPrice: rule.target_listing_price,
          trigger: event.type,
        });
      }
    }
    // "首次出现即符合品相 / 齐套"本身就是 new_listing 语义，保持不变。
    if (event.type === "new_listing") {
      if (conditions.length > 0 && conditions.includes(listing.item_condition)) {
        addSelected("product.condition_match_seen", {
          condition: listing.item_condition,
          trigger: "new_comparable_offer",
        });
      }
      if (completeness === "complete") {
        addSelected("product.complete_set_seen", {
          completeness,
          trigger: "new_comparable_offer",
        });
      }
    }
    // 落地成本目标：同样要覆盖降价路径。原先还额外要求 scope_type === 'variant'，
    // 但单品监控建的 rule 是 'listing' scope，两个条件相乘导致该功能在生产里不可达。
    if (priceTargetTrigger) {
      const landed = context.landedCost;
      if (landed && configuredEvents.includes("product.offer_below_target_landed_cost")) {
        const estimate = buildLandedCostEstimate({
          currency: listing.currency,
          ...(listing.current_price === null ? {} : { listingPriceJpy: listing.current_price }),
          ...extractLandedCostListingFacts({ facts: parsedObject(listing.product_facts_json) }),
        }, costProfileFromRow(landed.profile));
        if (landedCostMeetsTarget(estimate, landed.target.target_landed_cost_jpy)) {
          addSelected("product.offer_below_target_landed_cost", {
            trigger: event.type,
            targetLandedCostJpy: landed.target.target_landed_cost_jpy,
            thresholdPolicy: landedCostThresholdPolicy(estimate),
            costProfileId: landed.profile.id,
            costProfileVersion: landed.profile.version,
            landedCostJpy: estimate.landedCostJpy,
            missingFacts: estimate.missingFacts,
            weightSource: estimate.weightSource,
          });
        }
      }
    }
    if (selected.length === 0) return { kind: "suppressed" };

    const records: Array<{
      decision: MonitorEventInsertDecision;
      subjectType: "listing" | "variant" | "market";
      subjectId: string;
      payloadJson: string;
      occurredAt: string;
    }> = [];
    for (const candidate of selected) {
      const subjectType = candidate.eventType.startsWith("listing.") ? "listing" : rule.scope_type;
      const subjectId = subjectType === "listing" ? listingId : rule.scope_id;
      const payload = {
        ...candidate.eventPayload,
        legacyEventType: event.type,
        legacyEventId,
        ruleVersion: rule.version,
        sourceHealthStatus: listing.source_health_status,
        staleSourcePolicy: rule.stale_source_policy,
        condition: listing.item_condition,
        completeness,
        availability: listing.availability,
      };
      const evidenceHash = await stableStateHash({
        eventType: candidate.eventType,
        listingId,
        payload: candidate.eventPayload,
      });
      const eventKeyHash = await stableStateHash({
        ruleKey: rule.rule_key,
        ruleVersion: rule.version,
        eventType: candidate.eventType,
        subjectType,
        subjectId,
        listingId,
        occurredAt,
        evidenceHash,
      });
      const maxWindowMinutes = Math.max(rule.dedupe_window_minutes, rule.cooldown_minutes);
      const cutoff = new Date(Date.parse(detectedAt) - maxWindowMinutes * 60_000).toISOString();
      const recent = maxWindowMinutes > 0 ? await this.db.prepare(
        `SELECT evidence_hash,detected_at,payload_json FROM monitor_events
         WHERE monitor_rule_id=? AND event_type=? AND subject_type=? AND subject_id=?
           AND notification_eligibility IN ('instant','digest','quiet_hours')
           AND detected_at>=?
         ORDER BY detected_at DESC LIMIT 20`,
      ).bind(rule.id, candidate.eventType, subjectType, subjectId, cutoff).all<{
        evidence_hash: string;
        detected_at: string;
        payload_json: string;
      }>() : { results: [] };
      const detectedTime = Date.parse(detectedAt);
      const duplicate = recent.results.some((row) => row.evidence_hash === evidenceHash
        && detectedTime - Date.parse(row.detected_at) <= rule.dedupe_window_minutes * 60_000);
      // 可用性变化的冷却按目标状态分桶：补货与售罄不共享同一个冷却窗口，
      // 否则"售罄→补货"的第二段会被第一段的冷却吞掉。
      const candidateAvailability = typeof candidate.eventPayload.currentAvailability === "string"
        ? candidate.eventPayload.currentAvailability
        : undefined;
      const cooldownPeers = candidate.eventType === "listing.availability_changed" && candidateAvailability
        ? recent.results.filter((row) => {
            try {
              return (JSON.parse(row.payload_json) as { currentAvailability?: unknown }).currentAvailability === candidateAvailability;
            } catch {
              return true;
            }
          })
        : recent.results;
      const coolingDown = rule.cooldown_minutes > 0 && cooldownPeers.some((row) =>
        detectedTime - Date.parse(row.detected_at) <= rule.cooldown_minutes * 60_000);
      // 大幅降价（≥10%）或达到目标价时豁免冷却：更深的降价正是用户最想立即知道的。
      const payloadNewPrice = typeof candidate.eventPayload.newPrice === "number" ? candidate.eventPayload.newPrice : undefined;
      const payloadOldPrice = typeof candidate.eventPayload.oldPrice === "number" ? candidate.eventPayload.oldPrice : undefined;
      const bypassCooldown = payloadNewPrice !== undefined && (
        (payloadOldPrice !== undefined && payloadNewPrice <= payloadOldPrice * 0.9)
        || (rule.target_listing_price !== null && payloadNewPrice <= rule.target_listing_price)
      );
      const quietUntil = quietHoursNotBefore(detectedAt, rule.quiet_hours_start, rule.quiet_hours_end);
      // 冷却不再丢弃事件而是延后投递；只有 dedupe 命中（同证据重复）才真正压制。
      const cooldownUntil = coolingDown && !duplicate && !bypassCooldown
        ? new Date(Date.parse(cooldownPeers[0]?.detected_at ?? detectedAt) + rule.cooldown_minutes * 60_000).toISOString()
        : null;
      const deferUntil = [quietUntil, cooldownUntil]
        .filter((value): value is string => Boolean(value))
        .sort()
        .pop() ?? null;
      // 精确同款档案的"发现新报价"仍走摘要，但某一条已命中商品的价格/库存
      // 变化是时效事件，不能被父规则的 digest 模式拖到下一轮汇总。
      const effectiveDeliveryMode = rule.scope_type === "variant" && candidate.eventType.startsWith("listing.")
        ? "instant"
        : rule.delivery_mode;
      const notificationEligibility = duplicate
        ? "cooldown"
        : deferUntil
          ? "quiet_hours"
          : effectiveDeliveryMode;
      const suppressionReason = duplicate ? "dedupe_window" : null;
      records.push({
        decision: {
          eventType: candidate.eventType,
          eventKey: `me_${eventKeyHash}`,
          evidenceHash,
          notificationEligibility,
          suppressionReason,
          deliveryNotBefore: notificationEligibility === "quiet_hours" ? deferUntil : null,
        },
        subjectType,
        subjectId,
        payloadJson: JSON.stringify(payload),
        occurredAt,
      });
    }
    const deliverable = records.filter((record) => record.decision.notificationEligibility !== "cooldown");
    return {
      kind: "recorded",
      suppressLegacy: deliverable.length === 0,
      deliveryNotBefore: deliverable.find((record) => record.decision.deliveryNotBefore)?.decision.deliveryNotBefore ?? null,
      records,
    };
  }

  async insertEvents(binding: WatchBindingRow, listingId: string, events: EventCandidate[]): Promise<number> {
    return this.insertEventBatch(binding, [{ listingId, events }]);
  }

  async scheduleStrongTargetPriceReminders(binding: WatchBindingRow, input: {
    listingId: string;
    currentPrice: number;
    previousPrice?: number;
    targetPrice: number;
    detectedAt: string;
    policy: StrongReminderPolicy;
  }): Promise<number> {
    const deliveryTimes = strongReminderDeliveryTimes(input.detectedAt, input.policy);
    if (deliveryTimes.length === 0) return 0;
    const statements = deliveryTimes.map((deliveryAt, index) => {
      const sequence = index + 1;
      const payload = JSON.stringify({
        oldPrice: input.previousPrice ?? input.currentPrice,
        newPrice: input.currentPrice,
        targetPrice: input.targetPrice,
        firstConfirmedHit: true,
        strongReminder: {
          sequence,
          total: deliveryTimes.length,
          intervalMinutes: input.policy.intervalMinutes,
          emailOnlyRepeat: sequence > 1,
        },
      });
      return this.db.prepare(
        `INSERT INTO events(
           id,event_key,event_type,semantic_event_type,watch_profile_id,watch_binding_id,listing_id,
           payload_json,status,created_at,delivery_not_before
         ) VALUES(?,?,'target_price','target_price',?,?,?,?,'pending',?,?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        `strong_target_price:${binding.id}:${input.listingId}:${input.targetPrice}:${sequence}`,
        binding.watch_profile_id,
        binding.id,
        input.listingId,
        payload,
        input.detectedAt,
        sequence === 1 ? null : deliveryAt,
      );
    });
    const results = await this.db.batch(statements);
    return results.reduce((total, result) => total + Number(result.meta.changes > 0), 0);
  }

}
