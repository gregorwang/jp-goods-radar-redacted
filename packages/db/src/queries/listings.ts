/**
 * 商品与匹配：水位线、关键词规则排除、落库、观测记录、匹配判定。
 */
/**
 * 本文件是 `RadarRepository` 的一部分。
 *
 * 拆分方式：各组按继承链串起来（见 `packages/db/src/repository.ts` 顶部说明），
 * 因此方法体与原文件逐字相同，`this.db` 与跨方法调用都照旧可用。
 * 新增方法时若要调用别组的方法，那一组必须排在本组**之前**，否则 typecheck 会报错。
 */
import type { Availability, EventCandidate, ListingState, MonitorEventType, MutedProductRule, NormalizedListing, SourceId, StrongReminderPolicy } from "@jpgr/core";
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
  parseMutedProductTermGroups,
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
import { RunRepository } from "./runs";

export abstract class ListingRepository extends RunRepository {
  async previousTypicalCount(bindingId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT CAST(ROUND(AVG(result_count)) AS INTEGER) typical_count FROM (
         SELECT result_count FROM watch_runs WHERE watch_binding_id = ? AND status = 'success'
         ORDER BY started_at DESC LIMIT 5
       )`,
    ).bind(bindingId).first<{ typical_count: number | null }>();
    return Number(row?.typical_count ?? 0);
  }

  async knownSourceItemIds(bindingId: string): Promise<string[]> {
    const result = await this.db.prepare(
      `SELECT l.source_item_id FROM watch_listing_matches m
       JOIN listings l ON l.id=m.listing_id WHERE m.watch_binding_id=?
       UNION
       SELECT o.source_item_id FROM watch_run_listing_observations o
       WHERE o.watch_binding_id=?`,
    ).bind(bindingId, bindingId).all<{ source_item_id: string }>();
    return result.results.map((row) => row.source_item_id);
  }

  /**
   * 推进上新窗口的覆盖锚点。
   *
   * 水位线用 GREATEST 保证单调不回退：某一轮窗口恰好没带上架时间时保持原值，
   * 而不是被清空导致下一轮把整段历史重新当成新品。锚定时间只写一次。
   *
   * anchorAttempts 与 anchoredAt 是分开的：截断的锚定轮只累加尝试次数而不落锁，
   * 下一轮还会用锚定预算重来；够深或用完重试上界时才带上 anchoredAt。
   */
  async advanceNewListingWatermark(
    bindingId: string,
    input: { watermark?: string; anchoredAt?: string; anchorAttempts?: number },
  ): Promise<void> {
    if (input.watermark === undefined && input.anchoredAt === undefined && input.anchorAttempts === undefined) return;
    // 占位符必须显式标注类型：`$1 IS NULL` 里 PostgreSQL 无从推断参数类型，
    // 预编译阶段就会以 `could not determine data type of parameter $1` 失败，
    // 把整轮采集连带拖挂。COALESCE / 比较运算能从另一侧推断，仍统一写明以免再踩。
    await this.db.prepare(
      `UPDATE watch_bindings
       SET new_listing_watermark=CASE
             WHEN ?::text IS NULL THEN new_listing_watermark
             WHEN new_listing_watermark IS NULL OR new_listing_watermark < ?::text THEN ?::text
             ELSE new_listing_watermark END,
           new_listing_anchored_at=COALESCE(new_listing_anchored_at,?::text),
           new_listing_anchor_attempts=COALESCE(?::int,new_listing_anchor_attempts),
           updated_at=?
       WHERE id=?`,
    ).bind(
      input.watermark ?? null,
      input.watermark ?? null,
      input.watermark ?? null,
      input.anchoredAt ?? null,
      input.anchorAttempts ?? null,
      new Date().toISOString(),
      bindingId,
    ).run();
  }

  /** 档案里用户屏蔽掉的单品（packages/core/src/muted-products.ts）。 */
  async mutedProducts(profileId: string): Promise<MutedProductRule[]> {
    const result = await this.db.prepare(
      "SELECT id,term_groups_json FROM watch_profile_muted_products WHERE watch_profile_id=? ORDER BY created_at",
    ).bind(profileId).all<{ id: string; term_groups_json: string }>();
    return result.results
      .map((row) => ({ id: row.id, termGroups: parseMutedProductTermGroups(row.term_groups_json) }))
      .filter((rule) => rule.termGroups.length > 0);
  }

  async applyKeywordRuleExclusions(input: {
    runId: string;
    bindingId: string;
    sourceId: SourceId;
    sourceItemIds: readonly string[];
    reason: string;
  }): Promise<void> {
    const sourceItemIds = [...new Set(input.sourceItemIds)];
    if (sourceItemIds.length === 0) return;
    const now = new Date().toISOString();
    for (const ids of chunks(sourceItemIds, SQL_ID_CHUNK_SIZE)) {
      const placeholders = ids.map(() => "?").join(",");
      await this.db.prepare(
        `UPDATE watch_run_listing_observations
         SET decision_status='rejected',decision_reason=?,updated_at=?
         WHERE watch_run_id=? AND watch_binding_id=? AND source_id=?
           AND source_item_id IN (${placeholders})`,
      ).bind(input.reason.slice(0, 500), now, input.runId, input.bindingId, input.sourceId, ...ids).run();
    }
  }

  /**
   * 这一轮里每个来源最后一次运行的结果。`runStartedAt` 一并带出来，因为
   * 「还在跑」必须能分辨是真的在跑还是卡死了：一次被中途打断的采集会把
   * `running` 永久留在表里（没有哪条路径会回来改它），而摘要靠这个字段
   * 判断该不该继续等。2026-09-21 就是两条 12:35 的 running 把当天的摘要
   * 挂了 48 小时的重试，最后一封都没发出去。
   */
  async keywordScanMembers(bindingIds: readonly string[], scanStartedAt: string): Promise<Array<{
    bindingId: string;
    sourceId: SourceId;
    status: WatchRunResult["status"] | "running" | null;
    errorCode: string | null;
    runStartedAt: string | null;
  }>> {
    if (bindingIds.length === 0) return [];
    const placeholders = bindingIds.map(() => "?").join(",");
    const result = await this.db.prepare(
      `SELECT b.id binding_id,b.source_id,
       (SELECT r.status FROM watch_runs r
        WHERE r.watch_binding_id=b.id AND r.started_at>=?
        ORDER BY r.started_at DESC LIMIT 1) run_status,
       (SELECT r.error_code FROM watch_runs r
        WHERE r.watch_binding_id=b.id AND r.started_at>=?
        ORDER BY r.started_at DESC LIMIT 1) error_code,
       (SELECT r.started_at FROM watch_runs r
        WHERE r.watch_binding_id=b.id AND r.started_at>=?
        ORDER BY r.started_at DESC LIMIT 1) run_started_at
       FROM watch_bindings b WHERE b.id IN (${placeholders})`,
    ).bind(scanStartedAt, scanStartedAt, scanStartedAt, ...bindingIds).all<{
      binding_id: string;
      source_id: SourceId;
      run_status: WatchRunResult["status"] | "running" | null;
      error_code: string | null;
      run_started_at: string | null;
    }>();
    return result.results.map((row) => ({
      bindingId: row.binding_id,
      sourceId: row.source_id,
      status: row.run_status,
      errorCode: row.error_code,
      runStartedAt: row.run_started_at,
    }));
  }

  async findListing(sourceId: string, sourceItemId: string): Promise<ExistingListingRow | null> {
    return this.db.prepare(
      "SELECT id,current_price,availability,description_excerpt,state_hash,content_hash FROM listings WHERE source_id=? AND source_item_id=?",
    ).bind(sourceId, sourceItemId).first<ExistingListingRow>();
  }

  async findListingsWithMatchState(
    bindingId: string,
    keys: readonly { sourceId: string; sourceItemId: string }[],
  ): Promise<Map<string, { listing: ExistingListingRow; matched: boolean; knownItemWatch: boolean }>> {
    const result = new Map<string, { listing: ExistingListingRow; matched: boolean; knownItemWatch: boolean }>();
    const uniqueKeys = [...new Map(
      keys.map((key) => [`${key.sourceId}:${key.sourceItemId}`, key] as const),
    ).values()];
    for (const chunk of chunks(uniqueKeys, SQL_ID_CHUNK_SIZE)) {
      const predicate = chunk.map(() => "(l.source_id=? AND l.source_item_id=?)").join(" OR ");
      const rows = await this.db.prepare(
        `SELECT l.id,l.source_id,l.source_item_id,l.current_price,l.availability,l.description_excerpt,l.state_hash,l.content_hash,
          (SELECT 1 FROM watch_listing_matches m
           WHERE m.watch_binding_id=? AND m.listing_id=l.id) matched,
          -- "已有单品关注"只在那份关注真的还在跑的时候才算数。
          -- 这里认定成立，精确档案就把这条报价锁进 anchor_known 终局、不再排期；
          -- 如果那份单品监控其实已经停用或档案被关掉，去重就把跟踪交给了一个
          -- 不存在的人，两边都不再看它一眼。enabled 必须一起查。
          (SELECT 1 FROM watch_listing_matches item_match
           JOIN watch_bindings item_binding ON item_binding.id=item_match.watch_binding_id
           JOIN watch_profiles item_profile ON item_profile.id=item_binding.watch_profile_id
           WHERE item_match.listing_id=l.id AND item_binding.kind='item'
             AND item_binding.monitoring_purpose='item_price'
             AND item_binding.enabled=1 AND item_profile.enabled=1
             AND item_profile.dossier_kind='item' LIMIT 1) known_item_watch
         FROM listings l WHERE ${predicate}`,
      ).bind(
        bindingId,
        ...chunk.flatMap((key) => [key.sourceId, key.sourceItemId]),
      ).all<ExistingListingRow & {
        source_id: string;
        source_item_id: string;
        matched: number | null;
        known_item_watch: number | null;
      }>();
      for (const row of rows.results) {
        result.set(`${row.source_id}:${row.source_item_id}`, {
          listing: row,
          matched: row.matched === 1,
          knownItemWatch: row.known_item_watch === 1,
        });
      }
    }
    return result;
  }

  /**
   * 上一次详情补抓留在库里的东西。精确同款巡检在决定"这条候选要不要再拉一次详情页"
   * 之前读它：补抓结果本身已经落库，短窗口内重复抓同一条只是在烧上游配额和 IP 声誉。
   *
   * 返回的不只是水位，还有详情页才有的描述与结构化属性——跳过抓取时用它把本轮的
   * 搜索结果补厚，匹配器拿到的证据不会因为省了一次请求而变薄。
   */
  async storedListingDetails(
    keys: readonly { sourceId: string; sourceItemId: string }[],
  ): Promise<Map<string, StoredListingDetail>> {
    const result = new Map<string, StoredListingDetail>();
    const uniqueKeys = [...new Map(
      keys.map((key) => [`${key.sourceId}:${key.sourceItemId}`, key] as const),
    ).values()];
    for (const chunk of chunks(uniqueKeys, SQL_ID_CHUNK_SIZE)) {
      const predicate = chunk.map(() => "(source_id=? AND source_item_id=?)").join(" OR ");
      const rows = await this.db.prepare(
        `SELECT source_id,source_item_id,detail_hydrated_at,description_excerpt,product_facts_json
         FROM listings WHERE ${predicate}`,
      ).bind(
        ...chunk.flatMap((key) => [key.sourceId, key.sourceItemId]),
      ).all<{
        source_id: string;
        source_item_id: string;
        detail_hydrated_at: string | null;
        description_excerpt: string | null;
        product_facts_json: string | null;
      }>();
      for (const row of rows.results) {
        result.set(`${row.source_id}:${row.source_item_id}`, {
          detailHydratedAt: row.detail_hydrated_at,
          descriptionExcerpt: row.description_excerpt,
          facts: row.product_facts_json ? parsedObject(row.product_facts_json) : {},
        });
      }
    }
    return result;
  }

  async persistListing(
    binding: WatchBindingRow,
    listing: NormalizedListing,
    options: {
      linkToWatch?: boolean;
      prefetched?: { listing: ExistingListingRow | null; matched: boolean };
    } = {},
  ): Promise<{
    listingId: string;
    isNew: boolean;
    isNewMatch: boolean;
    changed: boolean;
    previous: ExistingListingRow | null;
    stateHash: string;
  }> {
    const now = new Date().toISOString();
    const previous = options.prefetched
      ? options.prefetched.listing
      : await this.findListing(listing.sourceId, listing.sourceItemId);
    const stateHash = await stableStateHash({
      price: listing.currentPrice,
      originalPrice: listing.originalPrice,
      availability: listing.availability,
      condition: listing.condition,
    });
    const incomingDescription = boundedDescriptionExcerpt(listing.descriptionExcerpt);
    const effectiveDescription = incomingDescription ?? previous?.description_excerpt ?? undefined;
    const contentHash = await stableStateHash({
      canonicalUrl: listing.canonicalUrl,
      title: listing.title,
      descriptionExcerpt: effectiveDescription,
      imageUrl: listing.imageUrl,
      sellerName: listing.sellerName,
      shopName: listing.shopName,
      sourceListedAt: listing.sourceListedAt,
      sourceUpdatedAt: listing.sourceUpdatedAt,
      facts: contentHashFacts(listing.facts),
    });
    const listingId = previous?.id ?? crypto.randomUUID();
    const linkToWatch = options.linkToWatch !== false;
    const previousMatch = previous && linkToWatch
      ? options.prefetched
        ? options.prefetched.matched
        : await this.db.prepare(
            "SELECT 1 matched FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?",
          ).bind(binding.id, listingId).first<{ matched: number }>()
      : null;
    const isNewMatch = linkToWatch && !previousMatch;
    const changed = !previous || previous.state_hash !== stateHash || previous.content_hash !== contentHash;
    const identifiers = {
      ...metadataRecord(listing.rawMetadata?.identifiers),
      ...listing.facts?.identifiers,
    };
    const factsJson = JSON.stringify(listing.facts ?? {});
    // 只有来自详情抓取的写入才推进水位；纯搜索结果写 null，交给 COALESCE 保留原值。
    const detailHydratedAt = listing.rawMetadata?.detailHydrated === true ? now : null;
    const imageUrlsJson = JSON.stringify(listing.facts?.imageUrls ?? (listing.imageUrl ? [listing.imageUrl] : []));

    const statements: OperationalPreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO listings (
          id, source_id, source_item_id, identity_scope, canonical_url, title, description_excerpt,
          image_url, seller_name, shop_name, currency, current_price, original_price, price_basis,
          item_condition, availability, source_listed_at, source_updated_at, first_seen_at, last_seen_at, last_changed_at,
          state_hash, raw_metadata_json, jan, isbn, model_number, source_catalog_id, brand, manufacturer,
          release_date, preorder_deadline, image_urls_json, product_facts_json, content_hash, detail_hydrated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, source_item_id) DO UPDATE SET
          canonical_url=excluded.canonical_url, title=excluded.title,
          description_excerpt=COALESCE(NULLIF(excluded.description_excerpt,''),listings.description_excerpt),
          image_url=excluded.image_url, seller_name=excluded.seller_name, shop_name=excluded.shop_name,
          current_price=excluded.current_price, original_price=excluded.original_price,
          item_condition=excluded.item_condition, availability=excluded.availability,
          source_listed_at=excluded.source_listed_at,source_updated_at=excluded.source_updated_at,last_seen_at=excluded.last_seen_at,
          last_changed_at=CASE WHEN listings.state_hash IS DISTINCT FROM excluded.state_hash OR listings.content_hash IS DISTINCT FROM excluded.content_hash
            THEN excluded.last_changed_at ELSE listings.last_changed_at END,
          state_hash=excluded.state_hash,raw_metadata_json=excluded.raw_metadata_json,jan=excluded.jan,isbn=excluded.isbn,
          model_number=excluded.model_number,source_catalog_id=excluded.source_catalog_id,brand=excluded.brand,
          manufacturer=excluded.manufacturer,release_date=excluded.release_date,preorder_deadline=excluded.preorder_deadline,
          image_urls_json=excluded.image_urls_json,product_facts_json=excluded.product_facts_json,content_hash=excluded.content_hash,
          detail_hydrated_at=COALESCE(excluded.detail_hydrated_at,listings.detail_hydrated_at)`,
      ).bind(
        listingId, listing.sourceId, listing.sourceItemId, listing.identityScope, listing.canonicalUrl, listing.title,
        incomingDescription ?? null, listing.imageUrl ?? null, listing.sellerName ?? null, listing.shopName ?? null,
        listing.currency, listing.currentPrice ?? null, listing.originalPrice ?? null, listing.priceBasis, listing.condition,
        listing.availability, listing.sourceListedAt ?? null, listing.sourceUpdatedAt ?? null, now, now, now, stateHash,
        JSON.stringify(listing.rawMetadata ?? {}), stringValue(identifiers.jan), stringValue(identifiers.isbn),
        stringValue(identifiers.modelNumber), stringValue(identifiers.sourceCatalogId), listing.facts?.brand ?? null,
        listing.facts?.manufacturer ?? null, listing.facts?.releaseDate ?? null, listing.facts?.preorderDeadline ?? null,
        imageUrlsJson, factsJson, contentHash, detailHydratedAt,
      ),
    ];

    if (linkToWatch) {
      statements.push(this.db.prepare(
        `INSERT INTO watch_listing_matches (
          watch_binding_id,listing_id,first_seen_at,last_seen_at,acceptance_reason,accepted_at
        ) VALUES (?,?,?,?,?,?)
        ON CONFLICT(watch_binding_id,listing_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
      ).bind(
        binding.id,
        listingId,
        now,
        now,
        binding.kind === "item" ? "direct_item" : "keyword_relevant",
        now,
      ));
    }

    if (changed) {
      statements.push(this.db.prepare(
        `INSERT INTO listing_snapshots (id,listing_id,watch_binding_id,price,original_price,price_basis,currency,
         availability,item_condition,state_hash,observed_at,content_hash,product_facts_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), listingId, linkToWatch ? binding.id : null, listing.currentPrice ?? null, listing.originalPrice ?? null,
        listing.priceBasis, listing.currency, listing.availability, listing.condition, stateHash, now, contentHash, factsJson));
    }
    await this.db.batch(statements);
    return { listingId, isNew: !previous, isNewMatch, changed, previous, stateHash };
  }

  /**
   * 单品巡回时记一次点赞 / 评论数（radar_core.listing_interest_observations），返回上一次记下的值。
   * 和上一行一样就不写；来源两个数都没给就什么都不做、返回 null。
   */
  async recordListingInterest(
    listingId: string,
    current: { likeCount?: number; commentCount?: number },
    observedAt: string,
  ): Promise<{ likeCount?: number; commentCount?: number } | null> {
    if (current.likeCount === undefined && current.commentCount === undefined) return null;
    const last = await this.db.prepare(
      `SELECT like_count,comment_count FROM listing_interest_observations
       WHERE listing_id=? ORDER BY observed_at DESC LIMIT 1`,
    ).bind(listingId).first<{ like_count: number | string | null; comment_count: number | string | null }>();
    const previous = last
      ? {
        ...(last.like_count === null ? {} : { likeCount: Number(last.like_count) }),
        ...(last.comment_count === null ? {} : { commentCount: Number(last.comment_count) }),
      }
      : null;
    if (!previous || previous.likeCount !== current.likeCount || previous.commentCount !== current.commentCount) {
      await this.db.prepare(
        `INSERT INTO listing_interest_observations(listing_id,observed_at,like_count,comment_count)
         VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
      ).bind(listingId, observedAt, current.likeCount ?? null, current.commentCount ?? null).run();
    }
    return previous;
  }

  async recordRunListingObservations(input: readonly {
    runId: string;
    bindingId: string;
    sourceId: string;
    sourceItemId: string;
    canonicalUrl: string;
    title: string;
    imageUrl?: string;
    currentPrice?: number;
    originalPrice?: number;
    currency: string;
    priceBasis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid";
    availability: string;
    itemCondition: string;
    sourceListedAt?: string;
    ordinal: number;
    observedAt: string;
    decisionStatus: "pending" | "confirmed" | "rejected" | "uncertain";
    decisionReason?: string;
    matchRelation?: string;
    purchasable: boolean;
  }[]): Promise<void> {
    if (input.length === 0) return;
    const now = new Date().toISOString();
    for (const rows of chunks(input, SQL_ID_CHUNK_SIZE)) {
      await this.db.batch(rows.map((row) => this.db.prepare(
        `INSERT INTO watch_run_listing_observations(
           watch_run_id,watch_binding_id,source_id,source_item_id,canonical_url,title,image_url,
           current_price,original_price,currency,price_basis,availability,item_condition,source_listed_at,ordinal,observed_at,
           decision_status,decision_reason,match_relation,is_purchasable,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(watch_run_id,source_id,source_item_id) DO UPDATE SET
           canonical_url=excluded.canonical_url,title=excluded.title,image_url=excluded.image_url,
           current_price=excluded.current_price,original_price=excluded.original_price,currency=excluded.currency,
           price_basis=excluded.price_basis,
           availability=excluded.availability,item_condition=excluded.item_condition,
           source_listed_at=excluded.source_listed_at,ordinal=excluded.ordinal,observed_at=excluded.observed_at,
           decision_status=excluded.decision_status,decision_reason=excluded.decision_reason,
           match_relation=excluded.match_relation,is_purchasable=excluded.is_purchasable,
           updated_at=excluded.updated_at`,
      ).bind(
        row.runId,
        row.bindingId,
        row.sourceId,
        row.sourceItemId,
        row.canonicalUrl,
        row.title,
        row.imageUrl ?? null,
        row.currentPrice ?? null,
        row.originalPrice ?? null,
        row.currency,
        row.priceBasis,
        row.availability,
        row.itemCondition,
        row.sourceListedAt ?? null,
        row.ordinal,
        row.observedAt,
        row.decisionStatus,
        row.decisionReason?.slice(0, 500) ?? null,
        row.matchRelation ?? null,
        row.purchasable ? 1 : 0,
        now,
        now,
      )));
    }
  }

  async recordKeywordRuleWarning(binding: WatchBindingRow, message: string): Promise<void> {
    // One record per dossier/day; a rule problem can affect every source.
    // 采集是成功的，只是筛完没剩下——这不是故障，只留在后台事件页，不发邮件
    // （生产中 AmiAmi「千反田える」为此连续两周每天一封）。
    await this.db.prepare(
      `INSERT INTO events(id,event_key,event_type,watch_profile_id,watch_binding_id,payload_json,status,created_at)
       VALUES(?,?,'source_error',?,?,?,'suppressed',?) ON CONFLICT DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      `keyword_rules_filtered_all:${binding.watch_profile_id}:${japanDayKey()}`,
      binding.watch_profile_id,
      binding.id,
      JSON.stringify({
        sourceId: binding.source_id,
        profileName: binding.profile_name,
        monitorTarget: binding.query ?? "",
        code: "keyword_rules_filtered_all",
        message,
      }),
      new Date().toISOString(),
    ).run();
  }

  async updateRunListingDecision(input: {
    runId: string;
    sourceId: string;
    sourceItemId: string;
    decisionStatus: "confirmed" | "rejected" | "uncertain";
    decisionReason?: string;
    matchRelation?: string;
    aiRelevance?: "relevant" | "irrelevant" | "uncertain";
    aiConfidence?: "high" | "medium" | "low";
  }): Promise<void> {
    // 模型的表态要落成列，不能只拼进 decision_reason。"AI 说不是"和"匹配器分数不够"
    // 在库里同分，摘要就没法把前者挡在邮件外——2026-09-06 那两封拉姆手办邮件正是
    // 这么发出去的（AGENTS.md §4）。
    await this.db.prepare(
      `UPDATE watch_run_listing_observations
       SET decision_status=?,decision_reason=?,match_relation=COALESCE(?,match_relation),
           ai_relevance=COALESCE(?,ai_relevance),ai_confidence=COALESCE(?,ai_confidence),updated_at=?
       WHERE watch_run_id=? AND source_id=? AND source_item_id=?`,
    ).bind(
      input.decisionStatus,
      input.decisionReason?.slice(0, 500) ?? null,
      input.matchRelation ?? null,
      input.aiRelevance ?? null,
      input.aiConfidence ?? null,
      new Date().toISOString(),
      input.runId,
      input.sourceId,
      input.sourceItemId,
    ).run();
  }

  async acceptListingMatch(input: {
    bindingId: string;
    listingId: string;
    /** image_reference：标题没能确认、商品图和用户给的参考图对上（apps/collector/src/exact-reference-image.ts）。 */
    acceptanceReason: "deterministic_exact" | "semantic_exact" | "keyword_relevant" | "image_reference";
    matcherVersion?: string;
    semanticPromptVersion?: string;
    currentRunId?: string;
  }): Promise<{ isNewMatch: boolean; recoveredMatch: boolean }> {
    const now = new Date().toISOString();
    const previous = await this.db.prepare(
      "SELECT 1 matched FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?",
    ).bind(input.bindingId, input.listingId).first<{ matched: number }>();
    // A rejected/pending observation is evidence, not a delivered discovery.
    // Keep prior notifications, confirmed matches and the original baseline
    // quiet, but let a corrected rule recover previously rejected discoveries.
    const previouslyAccepted = !previous && input.acceptanceReason === "keyword_relevant" && input.currentRunId
      ? await this.db.prepare(
          `SELECT 1 accepted FROM events
           WHERE watch_binding_id=? AND listing_id=? AND event_type='new_listing'
           UNION ALL
           SELECT 1 accepted FROM watch_run_listing_observations o
           JOIN listings l ON l.source_id=o.source_id AND l.source_item_id=o.source_item_id
           WHERE o.watch_binding_id=? AND l.id=? AND o.watch_run_id<>?
             AND (o.decision_status='confirmed' OR o.watch_run_id=(
               SELECT r.id FROM watch_runs r WHERE r.watch_binding_id=o.watch_binding_id
                 AND r.status='success' AND r.result_count>0
               ORDER BY r.started_at,r.id LIMIT 1
             ))
           LIMIT 1`,
        ).bind(input.bindingId, input.listingId, input.bindingId, input.listingId, input.currentRunId)
          .first<{ accepted: number }>()
      : null;
    const previouslyObserved = !previous && !previouslyAccepted && input.acceptanceReason === "keyword_relevant" && input.currentRunId
      ? await this.db.prepare(
          `SELECT 1 observed FROM watch_run_listing_observations o
           JOIN listings l ON l.source_id=o.source_id AND l.source_item_id=o.source_item_id
           JOIN watch_runs current_run ON current_run.id=?
           WHERE o.watch_binding_id=? AND l.id=? AND o.watch_run_id<>current_run.id
             AND o.observed_at<current_run.started_at LIMIT 1`,
        ).bind(input.currentRunId, input.bindingId, input.listingId).first<{ observed: number }>()
      : null;
    await this.db.prepare(
      `INSERT INTO watch_listing_matches (
        watch_binding_id,listing_id,first_seen_at,last_seen_at,acceptance_reason,matcher_version,semantic_prompt_version,accepted_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(watch_binding_id,listing_id) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,
        -- anchor_known 是"另有单品监控在盯"这个去重事实，不是判定结论。
        -- 走到这里说明那份单品监控已经不在了，把判定理由恢复成本轮的真实结论，
        -- 否则日报会继续按 acceptance_reason<>'anchor_known' 把它排除在外。
        acceptance_reason=CASE WHEN watch_listing_matches.acceptance_reason='anchor_known'
          THEN excluded.acceptance_reason ELSE watch_listing_matches.acceptance_reason END,
        matcher_version=COALESCE(watch_listing_matches.matcher_version,excluded.matcher_version),
        semantic_prompt_version=COALESCE(watch_listing_matches.semantic_prompt_version,excluded.semantic_prompt_version)`,
    ).bind(
      input.bindingId,
      input.listingId,
      now,
      now,
      input.acceptanceReason,
      input.matcherVersion ?? null,
      input.semanticPromptVersion ?? null,
      now,
    ).run();
    return { isNewMatch: !previous && !previouslyAccepted, recoveredMatch: Boolean(previouslyObserved) };
  }

  async acceptKnownOfferAnchor(bindingId: string, listingId: string): Promise<{ isNewMatch: false }> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO watch_listing_matches(
        watch_binding_id,listing_id,first_seen_at,last_seen_at,acceptance_reason,accepted_at,
       tracking_status,tracking_baseline_completed,tracking_ended_at,tracking_terminal_reason
       ) VALUES(?,?,?,?,?,?,'anchor_known',1,?,'known_offer_anchor')
       ON CONFLICT(watch_binding_id,listing_id) DO UPDATE SET
         last_seen_at=excluded.last_seen_at,acceptance_reason='anchor_known',
         tracking_status='anchor_known',tracking_next_run_at=NULL,tracking_cooldown_until=NULL,
         tracking_baseline_completed=1,tracking_ended_at=excluded.tracking_ended_at,
         tracking_terminal_reason='known_offer_anchor'`,
    ).bind(bindingId, listingId, now, now, "anchor_known", now, now).run();
    return { isNewMatch: false };
  }

}
