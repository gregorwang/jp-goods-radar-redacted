/**
 * 汇总：周报、关键词日报、晨报。
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
  digestEnrichPlan,
  digestExtrasFromColumns,
  evaluateProbeWindow,
  extractLandedCostListingFacts,
  isOneOffListingSource,
  landedCostMeetsTarget,
  landedCostThresholdPolicy,
  matchingMutedProduct,
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
  WeeklyExactReportItem,
  WeeklyExactReportProfile,
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
import { EventRepository } from "./events";

/**
 * 这件商品的价格是不是拍卖的当前出价。雅虎拍卖在 price_basis 上已经标好；
 * 煤炉拍卖目前 price_basis 仍记成 listing_price，拍卖事实只落在
 * product_facts_json 的 displayFacts（mercari.sale_mode / price_type / bid_count / auction_end_at）
 * 或原始元数据的 saleMode / priceType 里，所以几处都看。
 */
export function auctionFacts(
  priceBasis: string | null,
  rawMetadataJson: string | null,
  productFactsJson: string | null,
): { bidCount?: number; endsAt?: string } | null {
  const metadata = parsedObject(rawMetadataJson ?? "");
  const facts = new Map<string, string>();
  const displayFacts = parsedObject(productFactsJson ?? "").displayFacts;
  for (const fact of Array.isArray(displayFacts) ? displayFacts : []) {
    const record = metadataRecord(fact);
    if (typeof record.key === "string" && typeof record.value === "string") facts.set(record.key, record.value);
  }
  const auction = priceBasis === "auction_current_bid"
    || metadata.saleMode === "auction"
    || metadata.priceType === "current_bid"
    || facts.get("mercari.price_type") === "当前最高出价"
    || (facts.get("mercari.sale_mode") ?? "").includes("拍卖");
  if (!auction) return null;
  const bidCount = Number(metadata.bidCount ?? facts.get("mercari.bid_count")?.replace(/[^\d]/gu, "") ?? Number.NaN);
  const endsAt = [metadata.auctionEndAt, metadata.endTime, facts.get("mercari.auction_end_at")]
    .find((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)));
  return {
    ...(Number.isFinite(bidCount) && bidCount >= 0 ? { bidCount } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

/**
 * 精确同款按参考图打分后挂在上新事件上的那句话（apps/collector/src/exact-reference-image.ts）：
 * "商品图与参考图一致" / "标题判为同款，但商品图和参考图明显不同……"。邮件里跟在标题下面。
 * 开关关着时事件上没有这一项，日报载荷和以前一模一样。
 */
function eventImageNote(payloadJson: string): string | undefined {
  const note = parsedObject(payloadJson).imageNote;
  return typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : undefined;
}

export abstract class DigestRepository extends EventRepository {
  async suppressEvent(eventId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `UPDATE events SET status='suppressed',email_suppressed_at=COALESCE(email_suppressed_at,?)
       WHERE id=? AND status IN ('pending','failed','sending')`,
    ).bind(now, eventId).run();
  }

  /** Schedule one weekly event per enabled exact-product profile. */
  /**
   * 精确同款周报：所有启用中的精确同款档案合并成一封邮件。
   *
   * 用户要从周报里知道三件事：档案有没有在干活、有没有找到新同款、已经找到的同款
   * 有没有往好的价格走。三件事都是数得出来的，所以这里只算数字、挑商品，句子交给
   * 模板按固定规则拼——不调用 AI，不会编，也不会因为模型失败而发不出来。
   * 来源健康度不混进买家内容；每日体检的结论单独放在最底部（用户 2026-09-28 要求），
   * 以后周报发给其他用户时，这一块应只留给运营者。
   */
  async prepareWeeklyExactReport(scheduledAt = new Date().toISOString()): Promise<string | null> {
    const endedAt = new Date(scheduledAt).toISOString();
    const startedAt = new Date(Date.parse(endedAt) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const profiles = await this.db.prepare(
      `SELECT p.id,p.name,r.event_types_json,r.target_listing_price
       FROM watch_profiles p
       LEFT JOIN monitor_rules r ON r.watch_profile_id=p.id AND r.valid_to IS NULL
       WHERE p.enabled=1 AND p.dossier_kind='exact_product'
       ORDER BY p.created_at`,
    ).all<{ id: string; name: string; event_types_json: string | null; target_listing_price: number | string | null }>();
    // 体检是运维信息，放在周报最底部；读不出来也不能拖垮周报本身。
    const health = await this.weeklyHealthSummary(startedAt, endedAt).catch(() => undefined);
    if (profiles.results.length === 0 && !health?.findings.length) return null;

    const [checks, offers] = await Promise.all([
      this.db.prepare(
        `SELECT b.watch_profile_id profile_id,COUNT(*) checks
         FROM watch_runs run
         JOIN watch_bindings b ON b.id=run.watch_binding_id
         JOIN watch_profiles p ON p.id=b.watch_profile_id
         WHERE p.enabled=1 AND p.dossier_kind='exact_product'
           AND run.status='success' AND run.trigger_type<>'manual'
           AND run.started_at>=? AND run.started_at<?
         GROUP BY b.watch_profile_id`,
      ).bind(startedAt, endedAt).all<{ profile_id: string; checks: number | string }>(),
      // 每件确认同款的现价，以及一周前那一刻的价格与可购状态（窗口开始前的最后一张快照）。
      this.db.prepare(
        `SELECT b.watch_profile_id profile_id,l.source_id,l.title,l.canonical_url,l.current_price,
         l.price_basis,l.availability,m.first_seen_at,
         (SELECT ls.price FROM listing_snapshots ls
           WHERE ls.listing_id=l.id AND ls.observed_at<? ORDER BY ls.observed_at DESC LIMIT 1) price_week_ago,
         (SELECT ls.availability FROM listing_snapshots ls
           WHERE ls.listing_id=l.id AND ls.observed_at<? ORDER BY ls.observed_at DESC LIMIT 1) availability_week_ago
         FROM watch_listing_matches m
         JOIN watch_bindings b ON b.id=m.watch_binding_id
         JOIN watch_profiles p ON p.id=b.watch_profile_id
         JOIN listings l ON l.id=m.listing_id
         WHERE p.enabled=1 AND p.dossier_kind='exact_product'
           AND m.acceptance_reason<>'anchor_known'
           AND m.tracking_status NOT IN ('purchased','dismissed')
           AND l.currency='JPY'
           AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
             WHERE x.watch_binding_id=m.watch_binding_id AND x.source_id=l.source_id
               AND x.source_item_id=l.source_item_id AND x.reason='not_same_product')`,
      ).bind(startedAt, startedAt).all<{
        profile_id: string;
        source_id: SourceId;
        title: string;
        canonical_url: string;
        current_price: number | string | null;
        price_basis: string;
        availability: string;
        first_seen_at: string;
        price_week_ago: number | string | null;
        availability_week_ago: string | null;
      }>(),
    ]);

    const checkCounts = new Map(checks.results.map((row) => [row.profile_id, Number(row.checks)]));
    const purchasable = (availability: string | null) => ["available", "preorder", "backorder"].includes(availability ?? "");
    const numberOrNull = (value: number | string | null) => value === null ? null : Number(value);
    const byPrice = (left: WeeklyExactReportItem, right: WeeklyExactReportItem) => (left.price ?? Infinity) - (right.price ?? Infinity);
    const maxItems = 5;

    const reportProfiles: WeeklyExactReportProfile[] = profiles.results.map((profile) => {
      let eventTypes: unknown = [];
      try { eventTypes = JSON.parse(profile.event_types_json ?? "[]"); } catch { eventTypes = []; }
      const targetEnabled = Array.isArray(eventTypes) && eventTypes.includes("product.offer_below_target_listing_price");
      const targetPrice = targetEnabled ? numberOrNull(profile.target_listing_price) : null;
      const newOffers: WeeklyExactReportItem[] = [];
      const drops: WeeklyExactReportItem[] = [];
      const targetHits: WeeklyExactReportItem[] = [];
      const nowPrices: number[] = [];
      const weekAgoPrices: number[] = [];
      for (const row of offers.results) {
        if (row.profile_id !== profile.id) continue;
        const price = numberOrNull(row.current_price);
        const fixedPrice = row.price_basis !== "auction_current_bid";
        const availableNow = purchasable(row.availability);
        const item: WeeklyExactReportItem = {
          sourceId: row.source_id,
          title: row.title,
          url: row.canonical_url,
          price,
          available: availableNow,
          auction: !fixedPrice,
        };
        const isNew = row.first_seen_at >= startedAt && row.first_seen_at < endedAt;
        // 刚找到就已经卖掉的不算新情况：周报只列用户还来得及下手的。
        if (isNew && availableNow) newOffers.push(item);
        if (availableNow && fixedPrice && price !== null) {
          nowPrices.push(price);
          if (targetPrice !== null && price <= targetPrice) targetHits.push(item);
        }
        const priceWeekAgo = numberOrNull(row.price_week_ago);
        if (!isNew && fixedPrice && priceWeekAgo !== null && purchasable(row.availability_week_ago)) {
          weekAgoPrices.push(priceWeekAgo);
          if (availableNow && price !== null && price < priceWeekAgo) drops.push({ ...item, oldPrice: priceWeekAgo });
        }
      }
      newOffers.sort(byPrice);
      // 降得最多的排前面。
      drops.sort((left, right) => ((right.oldPrice ?? 0) - (right.price ?? 0)) - ((left.oldPrice ?? 0) - (left.price ?? 0)));
      targetHits.sort(byPrice);
      return {
        profileId: profile.id,
        profileName: profile.name,
        targetPrice,
        checks: checkCounts.get(profile.id) ?? 0,
        newOfferCount: newOffers.length,
        dropCount: drops.length,
        targetHitCount: targetHits.length,
        newOffers: newOffers.slice(0, maxItems),
        drops: drops.slice(0, maxItems),
        targetHits: targetHits.slice(0, maxItems),
        lowestNow: nowPrices.length > 0 ? Math.min(...nowPrices) : null,
        lowestWeekAgo: weekAgoPrices.length > 0 ? Math.min(...weekAgoPrices) : null,
      };
    });

    const payload: WeeklyExactReport = {
      kind: "weekly_exact_report",
      windowStartedAt: startedAt,
      windowEndedAt: endedAt,
      profiles: reportProfiles,
      ...(health ? { health } : {}),
    };
    // 每周一个 key：同一周重复触发不会发第二封。
    const digestKey = `weekly_exact_report:${startedAt.slice(0, 10)}`;
    await this.db.prepare(
      `INSERT INTO events(id,event_key,event_type,semantic_event_type,payload_json,status,created_at)
       VALUES(?,?,'daily_digest','weekly_market_digest',?,'pending',?) ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), digestKey, JSON.stringify(payload), new Date().toISOString()).run();
    return (await this.db.prepare("SELECT id FROM events WHERE event_key=?").bind(digestKey).first<{ id: string }>())?.id ?? null;
  }

  async prepareKeywordDigest(input: {
    profileId: string;
    bindingIds: readonly string[];
    initialBaselineBindingIds?: readonly string[];
    scanStartedAt: string;
    scanFinishedAt: string;
    digestKey: string;
    failedSources: readonly SourceId[];
    sourceIssues?: readonly {
      sourceId: SourceId;
      status: WatchRunResult["status"] | "running" | "not_started";
      errorCode?: string;
    }[];
    /**
     * 关键词日报的补充信息（原価 / 二手行情 / 一句话结论）。在所有读查询之后、
     * 写入 batch 之前调用，所以等待外部接口时不持有事务。返回值与输入同序，
     * 原样挂到对应条目上；调用方保证失败时不抛错。
     */
    enrichItems?: (items: {
      sourceId: SourceId;
      sourceItemId: string;
      title: string;
      url: string;
      price: number | null;
      /** 价格是拍卖当前出价，不是一口价；这种价格不能拿来比贵贱。 */
      isAuction: boolean;
    }[], options: {
      /** 要不要让提供方调估价模型（AI 预测价）。 */
      estimate: boolean;
      /** 要不要官方定価（关了就不做补查那一遍）。 */
      officialPrice: boolean;
      /** 要不要逐条核对同款成交。 */
      sales: boolean;
    }) => Promise<{
      status: "ok" | "failed" | "skipped";
      items: (Record<string, unknown> | null)[];
      verifiedSales?: ({ priceJpy: number; platform: string; title: string; url: string; seenAt?: string }[] | null)[];
      dataAsOf?: string;
      modelVersion?: string;
      estimateError?: string;
      error?: string;
    }>;
  }): Promise<string | null> {
    if (input.bindingIds.length === 0) return null;
    const placeholders = input.bindingIds.map(() => "?").join(",");
    const baselineBindingIds = input.initialBaselineBindingIds ?? [];
    const baselinePlaceholders = baselineBindingIds.map(() => "?").join(",");
    const [profile, candidates, baselineCandidates] = await Promise.all([
      this.db.prepare(
        `SELECT name,dossier_kind,suspect_notice_policy,min_listing_price,digest_price_reference,digest_show_sales
         FROM watch_profiles WHERE id=?`,
      ).bind(input.profileId).first<{
          name: string;
          dossier_kind: import("@jpgr/core").WatchDossierKind;
          suspect_notice_policy: import("@jpgr/core").SuspectNoticePolicy;
          min_listing_price: number | string | null;
          digest_price_reference: string | null;
          digest_show_sales: number | string | null;
        }>(),
      this.db.prepare(
        `SELECT e.id event_id,e.watch_binding_id,e.listing_id,l.source_id,l.source_item_id,l.title,l.canonical_url,
         l.current_price,l.image_url,l.price_basis,l.raw_metadata_json,l.product_facts_json,l.source_listed_at,l.source_updated_at,b.query,e.payload_json,
         (SELECT min(o.observed_at) FROM watch_run_listing_observations o
          WHERE o.watch_binding_id=e.watch_binding_id AND o.source_id=l.source_id
            AND o.source_item_id=l.source_item_id AND o.observed_at<?) previous_observed_at
         FROM events e JOIN watch_bindings b ON b.id=e.watch_binding_id
         JOIN listings l ON l.id=e.listing_id
         WHERE e.watch_profile_id=? AND e.watch_binding_id IN (${placeholders})
         AND e.event_type='new_listing' AND e.status IN ('pending','failed')
         AND e.created_at>=? AND e.created_at<=?
         -- 精确同款"标题对上、图片没对上"的攒到晚上那封发（collector 的 exact-reference-image.ts）
         AND e.payload_json NOT LIKE '%"deliveryHold":"image_mismatch"%'
         AND NOT EXISTS (SELECT 1 FROM notice_deliveries d WHERE d.event_id=e.id AND d.channel='email' AND d.status='sent')
         AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
          WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
            AND x.source_item_id=l.source_item_id)
         ORDER BY l.source_id,e.created_at,l.title
         LIMIT 2000`,
      ).bind(input.scanStartedAt, input.profileId, ...input.bindingIds, input.scanStartedAt, input.scanFinishedAt).all<{
        event_id: string;
        payload_json: string;
        previous_observed_at: string | null;
        watch_binding_id: string;
        listing_id: string;
        source_id: SourceId;
        source_item_id: string;
        title: string;
        canonical_url: string;
        current_price: number | null;
        price_basis: string | null;
        raw_metadata_json: string | null;
        product_facts_json: string | null;
        source_listed_at: string | null;
        source_updated_at: string | null;
        image_url: string | null;
        query: string | null;
      }>(),
      baselineBindingIds.length === 0
        ? Promise.resolve({ results: [] as Array<{
            watch_binding_id: string;
            listing_id: string;
            source_id: SourceId;
            source_item_id: string;
            title: string;
            canonical_url: string;
            current_price: number | null;
            price_basis: string | null;
            raw_metadata_json: string | null;
            product_facts_json: string | null;
            source_listed_at: string | null;
            source_updated_at: string | null;
            image_url: string | null;
            query: string | null;
          }> })
        : this.db.prepare(
          `SELECT m.watch_binding_id,m.listing_id,l.source_id,l.source_item_id,l.title,l.canonical_url,
           l.current_price,l.image_url,l.price_basis,l.raw_metadata_json,l.product_facts_json,l.source_listed_at,l.source_updated_at,b.query
           FROM watch_listing_matches m JOIN watch_bindings b ON b.id=m.watch_binding_id
           JOIN listings l ON l.id=m.listing_id
           WHERE b.watch_profile_id=? AND m.watch_binding_id IN (${baselinePlaceholders})
           AND m.first_seen_at>=? AND m.first_seen_at<=?
           ORDER BY l.source_id,m.first_seen_at,l.title
           LIMIT 2000`,
        ).bind(input.profileId, ...baselineBindingIds, input.scanStartedAt, input.scanFinishedAt).all<{
          watch_binding_id: string;
          listing_id: string;
          source_id: SourceId;
          source_item_id: string;
          title: string;
          canonical_url: string;
          current_price: number | null;
          price_basis: string | null;
          raw_metadata_json: string | null;
          product_facts_json: string | null;
          source_listed_at: string | null;
          source_updated_at: string | null;
          image_url: string | null;
          query: string | null;
        }>(),
    ]);
    const initialBaseline = baselineBindingIds.length > 0 && profile?.dossier_kind === "keyword";
    type SuspectRow = {
      source_id: SourceId;
      title: string;
      canonical_url: string;
      current_price: number | null;
      image_url: string | null;
      match_relation: string | null;
      decision_reason: string | null;
    };
    // 判定档位和送达门槛是两件事（AGENTS.md §4）。判定在上游已经做完了，
    // 这里只决定哪一档值得打扰人。门槛挂在每个档案上，因为同一个"高度疑似"，
    // 对求了三年的绝版是必须看，对随手加的便宜货是骚扰。
    //
    //   confirmed_only  默认。只发确认同款，本函数不查存疑候选。
    //   strong_suspects 模型看过、且没说“不是”的未决候选。
    //   all_suspects    模型看过的未决候选都发，包括它说“不是”但拿不出引用的那些。
    //
    // 两档都多了一条硬条件：`ai_relevance IS NOT NULL`。
    //
    // 判定语义改了之后，decision_status='uncertain' 不再等于“系统看过但没把握”。
    // 以前被 relation 短路硬拒的候选（related 且模型没表态、标题缩写、标题含套装词）
    // 现在全部落在 uncertain 里，其中大部分的真实状态是“压根没轮到复核”。
    // 把它们当「高度疑似」发出去是计划 §8.6 明令禁止的：未执行、模型坏输出、
    // 详情 unsupported 不能被包装成通知。模型没给出有效表态时 ai_relevance 为 NULL，
    // 这一列正好是“模型到底看没看过这条”的现成判据。
    //
    // rejected 也不再进任何一档。新规则下的 rejected 一定带着可核查的反证
    //（字段冲突、零身份重叠、模型引原文否定）——系统自己能排除的结果留在
    // 诊断里，不向用户转交选择题（§8.6）。
    //
    // 弱证据只在首次观察到时露出，避免同一批商品每轮重复打扰；但 probable_exact
    // 不受这条限制：生产中有标题与目标逐字相同、在售、被日复一日重复丢弃的商品
    // （2026-09-05 的 m83965697348 ¥28,500），只按首次露出会把这批存量继续埋着。
    // 这条例外靠用户判定收敛，不靠时间：一旦在网页端标掉（不是同款 / 太贵了），
    // watch_dismissed_candidates 就把它从这个分区里摘掉，此后不再重复。
    const suspectPolicy = profile?.dossier_kind === "exact_product"
      ? profile.suspect_notice_policy
      : "confirmed_only";
    const suspects = suspectPolicy === "confirmed_only"
      ? { results: [] as SuspectRow[] }
      : suspectPolicy === "strong_suspects"
      ? await this.db.prepare(
        `SELECT o.source_id,o.title,o.canonical_url,o.current_price,o.image_url,
         o.match_relation,o.decision_reason
         FROM watch_run_listing_observations o
         WHERE o.watch_binding_id IN (${placeholders})
         AND o.observed_at>=? AND o.observed_at<=?
         AND o.is_purchasable=1
         AND o.decision_status='uncertain'
         AND o.ai_relevance IS NOT NULL
         AND COALESCE(o.image_verdict,'')<>'mismatch'
         AND o.ai_relevance<>'irrelevant'
         AND (COALESCE(o.match_relation,'uncertain')='probable_exact'
          OR NOT EXISTS (SELECT 1 FROM watch_run_listing_observations p
           WHERE p.watch_binding_id=o.watch_binding_id AND p.source_id=o.source_id
             AND p.source_item_id=o.source_item_id AND p.observed_at<?))
         AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
          WHERE x.watch_binding_id=o.watch_binding_id AND x.source_id=o.source_id
            AND x.source_item_id=o.source_item_id)
         ORDER BY CASE COALESCE(o.match_relation,'uncertain')
          WHEN 'probable_exact' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'related' THEN 2 ELSE 3 END,
          o.source_id,o.title
         LIMIT 200`,
      ).bind(...input.bindingIds, input.scanStartedAt, input.scanFinishedAt, input.scanStartedAt)
        .all<SuspectRow>()
      : await this.db.prepare(
        `SELECT o.source_id,o.title,o.canonical_url,o.current_price,o.image_url,
         o.match_relation,o.decision_reason
         FROM watch_run_listing_observations o
         WHERE o.watch_binding_id IN (${placeholders})
         AND o.observed_at>=? AND o.observed_at<=?
         AND o.is_purchasable=1
         AND o.decision_status='uncertain'
         AND o.ai_relevance IS NOT NULL
         AND COALESCE(o.image_verdict,'')<>'mismatch'
         AND (COALESCE(o.match_relation,'uncertain')='probable_exact'
          OR NOT EXISTS (SELECT 1 FROM watch_run_listing_observations p
           WHERE p.watch_binding_id=o.watch_binding_id AND p.source_id=o.source_id
             AND p.source_item_id=o.source_item_id AND p.observed_at<?))
         AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
          WHERE x.watch_binding_id=o.watch_binding_id AND x.source_id=o.source_id
            AND x.source_item_id=o.source_item_id)
         ORDER BY CASE COALESCE(o.match_relation,'uncertain')
          WHEN 'probable_exact' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'related' THEN 2 ELSE 3 END,
          o.source_id,o.title
         LIMIT 200`,
      ).bind(...input.bindingIds, input.scanStartedAt, input.scanFinishedAt, input.scanStartedAt)
        .all<SuspectRow>();
    // 一件都没确认但有存疑候选时照样发信，前提是用户把送达门槛放到了那一档。
    // 默认的 confirmed_only 下 suspects 恒为空，这里自然回到"没确认就不发信"。
    if (candidates.results.length === 0
      && suspects.results.length === 0
      && (!initialBaseline || baselineCandidates.results.length === 0)) return null;

    // 同一件商品只进一次邮件（用户硬要求：重复会污染他整份数据）。
    // 事件层面已按「档案 + 商品」去重，但基线栏读的是 watch_listing_matches，
    // 生产中 07-28～09-05 有 26 件商品先后出现在两封已发邮件里。这里以已发/待发
    // 摘要里实际渲染过的链接为准兜底，与事件去重互相独立。
    const priorDigests = await this.db.prepare(
      `SELECT payload_json FROM events
       WHERE watch_profile_id=? AND event_type='daily_digest' AND event_key<>?
         AND status IN ('pending','sending','sent') AND created_at>=?`,
    ).bind(
      input.profileId,
      input.digestKey,
      new Date(Date.parse(input.scanStartedAt) - 180 * 24 * 60 * 60 * 1000).toISOString(),
    ).all<{ payload_json: string }>();
    const mailedUrls = new Set<string>();
    for (const row of priorDigests.results) {
      try {
        const items: unknown = (JSON.parse(row.payload_json) as { items?: unknown }).items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const url = (item as { url?: unknown } | null)?.url;
          if (typeof url === "string") mailedUrls.add(url);
        }
      } catch {
        continue;
      }
    }

    const keywordSummary = profile?.dossier_kind === "keyword";
    // 采集侧已经在 AI 之前挡掉了屏蔽的单品和低于最低价的商品；这里再过一遍，是为了让今天刚改的
    // 设置在今天这封日报里就生效（改之前已经采进来、正等着发的那批）。被滤掉的事件照样在下面
    // 统一收口成 suppressed，不会留到下一轮。
    const mutedProducts = keywordSummary ? await this.mutedProducts(input.profileId) : [];
    const minListingPrice = keywordSummary && profile?.min_listing_price !== null && profile?.min_listing_price !== undefined
      ? Number(profile.min_listing_price)
      : undefined;
    const notMuted = (item: { title: string; current_price: number | string | null }) => (
      mutedProducts.length === 0 || matchingMutedProduct(item.title, mutedProducts) === undefined
    ) && (minListingPrice === undefined || item.current_price === null || Number(item.current_price) >= minListingPrice);
    const discoveries = candidates.results.filter((item) => !mailedUrls.has(item.canonical_url) && notMuted(item)).map((item) => {
      const discoveryKind = discoveryKindOf(item.payload_json);
      // 来源自己给出的上架时间晚于水位线时，"新上架"是确定的，不该再被
      // "以前观察过这个 ID"的启发式改判成回收——后者只说明我们见过它，
      // 不说明它不是新挂出来的。
      const recovered = keywordSummary
        && discoveryKind !== "listed_new"
        && (Boolean(item.previous_observed_at) || discoveryKind === "recovered_match");
      return { ...item, category: recovered ? "recovered" as const : "new" as const };
    });
    // An explicit initial notification must not also appear in baseline counts.
    const discoveryKeys = new Set(discoveries.map((item) => `${item.watch_binding_id}:${item.listing_id}`));
    const baselineItems = baselineCandidates.results
      .filter((item) => !discoveryKeys.has(`${item.watch_binding_id}:${item.listing_id}`)
        && !mailedUrls.has(item.canonical_url) && notMuted(item))
      .map((item) => ({ ...item, category: "baseline" as const }));
    const sourceCounts = new Map<SourceId, number>();
    const digestItems = [...discoveries, ...baselineItems];
    if (digestItems.length === 0 && suspects.results.length === 0) {
      // 本轮商品全在更早的邮件里出现过：不发空信，但事件照常收口，免得下一轮再被捞起。
      if (candidates.results.length > 0) {
        await this.db.batch(chunks(candidates.results.map((item) => item.event_id), SQL_ID_CHUNK_SIZE)
          .map((ids) => this.db.prepare(
            `UPDATE events SET status='suppressed' WHERE id IN (${ids.map(() => "?").join(",")})
             AND status IN ('pending','failed')`,
          ).bind(...ids)));
      }
      return null;
    }
    for (const item of digestItems) {
      sourceCounts.set(item.source_id, (sourceCounts.get(item.source_id) ?? 0) + 1);
    }
    // 有多少放多少：曾经的 100 条上限把超出的商品静默丢掉（2026-09-23 找到 567 条只
    // 渲染 100 条），而这些事件照样被标成已发，之后再也不会出现。条数太多的正解是
    // 去重 / 聚合，不是截断。载荷里每一件都要留着：下一轮的 mailedUrls 按链接去重，
    // 邮件模板渲染时才做排序和同名折叠（docs/归档/关键词日报整理与基线回执-待做-20261007.md）。
    // 发现类优先于基线类，组内按来源轮转，避免某一家来源整段排在最后。
    const visibleItems = [
      ...interleaveBySource(discoveries),
      ...interleaveBySource(baselineItems),
    ];
    const auctions = visibleItems.map((item) => auctionFacts(item.price_basis, item.raw_metadata_json, item.product_facts_json));
    // 建档存量在邮件里只汇总成回执、不逐件展示，不必为它查补充信息（一封基线上千件，
    // 查了既拖慢这一轮，又把载荷撑到 2MB）。发现类排在 visibleItems 最前面，
    // 只查这一段，下标仍与 visibleItems 对齐。
    const enrichTargets = visibleItems.slice(0, discoveries.length);
    // 档案自己决定附带哪几样价格参考（packages/core/src/digest-extras.ts）。关掉的就不请求：
    // 原价关了不调估价模型，原价和成交都关了整个 /enrich 都不调。
    const digestExtras = digestExtrasFromColumns(profile?.digest_price_reference, profile?.digest_show_sales);
    const enrichPlan = digestEnrichPlan(digestExtras);
    const enrichment = keywordSummary && enrichPlan.call && input.enrichItems && enrichTargets.length > 0
      ? await input.enrichItems(enrichTargets.map((item, index) => ({
          sourceId: item.source_id,
          sourceItemId: item.source_item_id,
          title: item.title,
          url: item.canonical_url,
          price: item.current_price,
          isAuction: auctions[index] !== null,
        })), { estimate: enrichPlan.estimate, officialPrice: enrichPlan.officialPrice, sales: enrichPlan.sales })
      : undefined;
    const now = new Date().toISOString();
    const exactProduct = profile?.dossier_kind === "exact_product";
    const payload = JSON.stringify({
      kind: keywordSummary
        ? "keyword_scan_summary"
        : exactProduct ? "exact_product_new_listing" : "keyword_new_listing",
      day: japanDay(input.scanStartedAt),
      // 邮件里「不再推这件」要链到这个档案的屏蔽单品页。
      profileId: input.profileId,
      profileName: profile?.name ?? (exactProduct ? "精确同款雷达" : "关键词雷达"),
      query: digestItems[0]?.query ?? "",
      total: digestItems.length,
      ...(keywordSummary ? {
        baselineTotal: baselineItems.length,
        newTotal: discoveries.filter((item) => item.category === "new").length,
        recoveredTotal: discoveries.filter((item) => item.category === "recovered").length,
        baselineSourceIds: [...new Set(baselineItems.map((item) => item.source_id))],
        // 渲染时按它决定显示哪几行。存进载荷而不是渲染时再查档案：这封信发出去是什么样，
        // 以后回看（日报存档）也必须是什么样，不随档案后来改设置而变。
        digestExtras,
      } : {}),
      sourceCounts: [...sourceCounts].map(([sourceId, count]) => ({ sourceId, count })),
      failedSources: input.failedSources,
      sourceIssues: input.sourceIssues ?? [],
      items: visibleItems.map((item, index) => ({
        category: item.category,
        sourceId: item.source_id,
        sourceItemId: item.source_item_id,
        title: item.title,
        url: item.canonical_url,
        price: item.current_price,
        imageUrl: item.image_url,
        // 平台自己给的上架 / 最近更新时间（煤炉的「N時間前」就是更新时间，改价、改描述都会刷新）。
        ...(item.source_listed_at ? { listedAt: item.source_listed_at } : {}),
        ...(item.source_updated_at ? { updatedAt: item.source_updated_at } : {}),
        ...(auctions[index] ? { auction: auctions[index] } : {}),
        ...("payload_json" in item && eventImageNote(item.payload_json) ? { note: eventImageNote(item.payload_json) } : {}),
        ...(enrichment?.items[index] ? { enrichment: enrichment.items[index] } : {}),
        ...(enrichment?.verifiedSales?.[index]?.length ? { verifiedSales: enrichment.verifiedSales[index] } : {}),
      })),
      ...(enrichment ? {
        enrichment: {
          status: enrichment.status,
          ...(enrichment.dataAsOf ? { dataAsOf: enrichment.dataAsOf } : {}),
          ...(enrichment.modelVersion ? { modelVersion: enrichment.modelVersion } : {}),
          ...(enrichment.estimateError ? { estimateError: enrichment.estimateError } : {}),
          ...(enrichment.error ? { error: enrichment.error } : {}),
        },
      } : {}),
      suspectTotal: suspects.results.length,
      suspects: interleaveBySource(suspects.results)
        .slice(0, MAX_KEYWORD_DIGEST_SUSPECTS)
        .map((item) => ({
          sourceId: item.source_id,
          title: item.title,
          url: item.canonical_url,
          price: item.current_price,
          imageUrl: item.image_url,
          relation: item.match_relation ?? "uncertain",
          reason: item.decision_reason ?? "",
        })),
    });
    const eventIds = candidates.results.map((item) => item.event_id);
    const eventIdChunks = chunks(eventIds, SQL_ID_CHUNK_SIZE);
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO events(id,event_key,event_type,watch_profile_id,payload_json,status,created_at)
         VALUES(?,?,'daily_digest',?,?,'pending',?)
         ON CONFLICT DO NOTHING`,
      ).bind(crypto.randomUUID(), input.digestKey, input.profileId, payload, now),
      ...eventIdChunks.map((ids) => this.db.prepare(
          `UPDATE events SET status='suppressed' WHERE id IN (${ids.map(() => "?").join(",")})
           AND status IN ('pending','failed')`,
        ).bind(...ids)),
      ...discoveries.filter((item) => item.category === "recovered").map((item) => this.db.prepare(
        "UPDATE events SET payload_json=? WHERE id=?",
      ).bind(JSON.stringify({ ...JSON.parse(item.payload_json), discoveryKind: "recovered_match" }), item.event_id)),
      ...eventIdChunks.map((ids) => this.db.prepare(
          `UPDATE watch_listing_matches SET new_listing_notified_at=?
           WHERE EXISTS (SELECT 1 FROM events e
            WHERE e.id IN (${ids.map(() => "?").join(",")})
            AND e.watch_binding_id=watch_listing_matches.watch_binding_id
            AND e.listing_id=watch_listing_matches.listing_id)`,
        ).bind(now, ...ids)),
    ]);
    const digest = await this.db.prepare("SELECT id FROM events WHERE event_key=?")
      .bind(input.digestKey).first<{ id: string }>();
    return digest?.id ?? null;
  }

  /**
   * 精确同款"标题对上、图片没对上"攒到晚上的那封（北京时间 21:00，用户 10-09 定）。
   * 只收到点了的、带攒信标记的上新事件；早上那封日报已经把它们跳过了（prepareKeywordDigest）。
   * 从早上到晚上之间卖掉 / 下架的不再发。
   */
  async prepareExactImageHoldDigest(input: {
    profileId: string;
    releasedAt: string;
    holdMark: string;
  }): Promise<string | null> {
    const [profile, held] = await Promise.all([
      this.db.prepare("SELECT name FROM watch_profiles WHERE id=?").bind(input.profileId).first<{ name: string }>(),
      this.db.prepare(
        `SELECT e.id event_id,e.watch_binding_id,e.listing_id,e.payload_json,l.source_id,l.source_item_id,l.title,
         l.canonical_url,l.current_price,l.image_url,l.price_basis,l.raw_metadata_json,l.product_facts_json,
         l.source_listed_at,l.source_updated_at,l.availability
         FROM events e JOIN listings l ON l.id=e.listing_id
         WHERE e.watch_profile_id=? AND e.event_type='new_listing' AND e.status IN ('pending','failed')
         AND e.delivery_not_before IS NOT NULL AND e.delivery_not_before<=?
         AND e.payload_json LIKE ?
         AND NOT EXISTS (SELECT 1 FROM notice_deliveries d WHERE d.event_id=e.id AND d.channel='email' AND d.status='sent')
         AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
          WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
            AND x.source_item_id=l.source_item_id)
         ORDER BY l.source_id,e.created_at,l.title
         LIMIT 500`,
      ).bind(input.profileId, input.releasedAt, `%${input.holdMark}%`).all<{
        event_id: string;
        watch_binding_id: string;
        listing_id: string;
        payload_json: string;
        source_id: SourceId;
        source_item_id: string;
        title: string;
        canonical_url: string;
        current_price: number | null;
        image_url: string | null;
        price_basis: string | null;
        raw_metadata_json: string | null;
        product_facts_json: string | null;
        source_listed_at: string | null;
        source_updated_at: string | null;
        availability: string;
      }>(),
    ]);
    if (held.results.length === 0) return null;
    const allIds = held.results.map((item) => item.event_id);
    const items = interleaveBySource(held.results.filter((item) => !["sold_out", "unavailable"].includes(item.availability)));
    const suppressAll = chunks(allIds, SQL_ID_CHUNK_SIZE).map((ids) => this.db.prepare(
      `UPDATE events SET status='suppressed' WHERE id IN (${ids.map(() => "?").join(",")})
       AND status IN ('pending','failed')`,
    ).bind(...ids));
    if (items.length === 0) {
      // 白天全卖掉了：不发空信，事件照常收口
      await this.db.batch(suppressAll);
      return null;
    }
    const sourceCounts = new Map<SourceId, number>();
    for (const item of items) sourceCounts.set(item.source_id, (sourceCounts.get(item.source_id) ?? 0) + 1);
    const digestKey = `exact_image_hold_digest:${input.profileId}:${input.releasedAt.slice(0, 13)}`;
    const payload = JSON.stringify({
      kind: "exact_product_new_listing",
      imageHold: true,
      day: japanDay(input.releasedAt),
      profileName: profile?.name ?? "精确同款雷达",
      query: "",
      total: items.length,
      sourceCounts: [...sourceCounts].map(([sourceId, count]) => ({ sourceId, count })),
      failedSources: [],
      sourceIssues: [],
      items: items.map((item) => {
        const auction = auctionFacts(item.price_basis, item.raw_metadata_json, item.product_facts_json);
        const note = eventImageNote(item.payload_json);
        return {
          category: "new",
          sourceId: item.source_id,
          sourceItemId: item.source_item_id,
          title: item.title,
          url: item.canonical_url,
          price: item.current_price,
          imageUrl: item.image_url,
          ...(item.source_listed_at ? { listedAt: item.source_listed_at } : {}),
          ...(item.source_updated_at ? { updatedAt: item.source_updated_at } : {}),
          ...(auction ? { auction } : {}),
          ...(note ? { note } : {}),
        };
      }),
      suspectTotal: 0,
      suspects: [],
    });
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO events(id,event_key,event_type,watch_profile_id,payload_json,status,created_at)
         VALUES(?,?,'daily_digest',?,?,'pending',?)
         ON CONFLICT DO NOTHING`,
      ).bind(crypto.randomUUID(), digestKey, input.profileId, payload, now),
      ...suppressAll,
      ...chunks(allIds, SQL_ID_CHUNK_SIZE).map((ids) => this.db.prepare(
        `UPDATE watch_listing_matches SET new_listing_notified_at=?
         WHERE EXISTS (SELECT 1 FROM events e
          WHERE e.id IN (${ids.map(() => "?").join(",")})
          AND e.watch_binding_id=watch_listing_matches.watch_binding_id
          AND e.listing_id=watch_listing_matches.listing_id)`,
      ).bind(now, ...ids)),
    ]);
    const digest = await this.db.prepare("SELECT id FROM events WHERE event_key=?")
      .bind(digestKey).first<{ id: string }>();
    return digest?.id ?? null;
  }

  async prepareDailyDigest(): Promise<string | null> {
    const now = new Date().toISOString();
    const day = japanDay(now);
    // 只把"本次真正折叠进汇总"的事件按 id 精确标记 email_suppressed_at：
    // - 不再复用 daily_digest:{日} 作为唯一 key（同日第二次触发会因冲突丢失新事件）；
    // - 不改 events.status，Hermes 通道照常逐条投递（双通道独立）；
    // - 候选与标记使用同一集合，delivery_not_before 未到的事件不会被误吞；
    // - 只收邮件队列里真会发的（和 delivery.ts 的 pendingEmails 同一个「档案要不要邮件」），只开飞书的不收；
    //   收进来的那几份，邮件那一行记成 abandoned（folded_into_digest），不再单独重试。
    const candidates = await this.db.prepare(
      `SELECT e.id event_id,COALESCE(e.semantic_event_type,e.event_type) event_type,
       l.title,l.canonical_url,l.current_price,COALESCE(l.source_id,b.source_id) source_id
       FROM events e LEFT JOIN listings l ON l.id=e.listing_id LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
       LEFT JOIN watch_profiles rp ON rp.id=COALESCE(e.watch_profile_id,b.watch_profile_id,
  CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'profileId' END)
       LEFT JOIN notice_deliveries d ON d.event_id=e.id AND d.channel='email'
       WHERE e.status IN ('pending','failed') AND e.event_type <> 'daily_digest'
       AND e.email_suppressed_at IS NULL
       AND (e.delivery_not_before IS NULL OR e.delivery_not_before<=?)
       AND (e.event_type <> 'new_listing' OR COALESCE(b.monitoring_purpose,'') <> 'keyword_new_listing')
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
        WHERE x.watch_binding_id=e.watch_binding_id AND x.source_id=l.source_id
          AND x.source_item_id=l.source_item_id
          AND (x.reason='not_same_product' OR e.event_type='new_listing'))
       AND (
         (d.id IS NULL AND (
  rp.id IS NULL
  OR COALESCE(e.semantic_event_type,e.event_type) IN ('source_error','weekly_market_digest','morning_digest','new_listing')
  OR rp.notify_email=1
  OR (rp.notify_feishu=1 AND NOT COALESCE(
    (CASE WHEN e.event_type='daily_digest' THEN e.payload_json::jsonb->>'kind' END)
      IN ('keyword_scan_summary','keyword_new_listing','exact_product_new_listing')
    OR (e.event_type<>'daily_digest' AND e.listing_id IS NOT NULL
      AND COALESCE(e.semantic_event_type,e.event_type) IN ('price_drop','price_rise','target_price','restock','sold_out')),
    false))
))
         OR d.status IN ('pending','failed')
       )
       ORDER BY e.created_at ASC LIMIT 2000`,
    ).bind(now).all<{ event_id: string; event_type: string; title: string | null; canonical_url: string | null; current_price: number | null; source_id: string | null }>();
    if (candidates.results.length === 0) return null;
    const eventIds = candidates.results.map((row) => row.event_id);
    const eventKey = `daily_digest:${day}:${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const payload = JSON.stringify({
      day,
      total: eventIds.length,
      items: candidates.results.slice(0, 50).map((row) => ({ type: row.event_type, sourceId: row.source_id, title: row.title, url: row.canonical_url, price: row.current_price })),
    });
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO events(id,event_key,event_type,payload_json,status,created_at) VALUES(?,?,'daily_digest',?,'pending',?)`,
      ).bind(id, eventKey, payload, now),
      ...chunks(eventIds, SQL_ID_CHUNK_SIZE).map((ids) => this.db.prepare(
        `UPDATE events SET email_suppressed_at=? WHERE id IN (${ids.map(() => "?").join(",")})
         AND email_suppressed_at IS NULL`,
      ).bind(now, ...ids)),
      ...chunks(eventIds, SQL_ID_CHUNK_SIZE).map((ids) => this.db.prepare(
        `UPDATE notice_deliveries SET status='abandoned',last_error='folded_into_digest',next_attempt_at=NULL,updated_at=?
         WHERE channel='email' AND event_id IN (${ids.map(() => "?").join(",")})
         AND status IN ('pending','failed')`,
      ).bind(now, ...ids)),
    ]);
    return id;
  }

  async suppressRetiredMorningDigests(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(
      `UPDATE events
       SET status='suppressed',email_suppressed_at=COALESCE(email_suppressed_at,?)
       WHERE COALESCE(semantic_event_type,event_type)='morning_digest'
         AND status IN ('pending','failed','sending')`,
    ).bind(now).run();
    return Number(result.meta.changes ?? 0);
  }

}
