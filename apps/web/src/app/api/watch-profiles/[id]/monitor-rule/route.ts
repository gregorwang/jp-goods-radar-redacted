import type { MonitorEventType, OfferTrackingPolicy, SuspectNoticePolicy, WatchDossierKind } from "@jpgr/core";
import { monitorRuleKey } from "@jpgr/core";
import type {
  MonitorRuleRow,
  OperationalDatabase,
  OperationalPreparedStatement,
} from "@jpgr/db";
import { monitorRuleSchema } from "@jpgr/validation";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { monitorRuleView } from "@/lib/monitor-rules";
import { onOffText, profileChangeStatements, yenText, type ProfileChange } from "@/lib/profile-change-log";
import { monitorRuleNeedsNewListingCandidate } from "@/lib/monitor-rule-events";

type Context = { params: Promise<{ id: string }> };

interface ProfileRow {
  id: string;
  dossier_kind: WatchDossierKind;
  product_variant_id: string | null;
  offer_tracking_policy: OfferTrackingPolicy;
  suspect_notice_policy: SuspectNoticePolicy;
}

interface LandedTargetViewRow {
  target_landed_cost_jpy: number;
  cost_profile_id: string;
  cost_profile_version: number;
  cost_profile_name: string;
}

async function landedTargetView(db: OperationalDatabase, ruleId: string): Promise<{
  targetLandedCostJpy: number;
  costProfileId: string;
  costProfileVersion: number;
  costProfileName: string;
} | null> {
  const row = await db.prepare(
    `SELECT target.target_landed_cost_jpy,target.cost_profile_id,
            profile.version cost_profile_version,profile.name cost_profile_name
     FROM monitor_rule_landed_cost_targets target
     JOIN cost_profiles profile ON profile.id=target.cost_profile_id
     WHERE target.monitor_rule_id=?`,
  ).bind(ruleId).first<LandedTargetViewRow>();
  return row ? {
    targetLandedCostJpy: row.target_landed_cost_jpy,
    costProfileId: row.cost_profile_id,
    costProfileVersion: row.cost_profile_version,
    costProfileName: row.cost_profile_name,
  } : null;
}

const allowedEvents = {
  item: new Set<MonitorEventType>([
    "listing.price_changed",
    "listing.availability_changed",
    "product.offer_below_target_listing_price",
  ]),
  exact_product: new Set<MonitorEventType>([
    "product.new_comparable_offer",
    "listing.price_changed",
    "product.offer_below_target_listing_price",
    "product.condition_match_seen",
    "product.complete_set_seen",
  ]),
  keyword: new Set<MonitorEventType>(["product.new_comparable_offer"]),
} satisfies Record<WatchDossierKind, ReadonlySet<MonitorEventType>>;

function normalized(value: readonly string[]): string[] {
  return [...value].sort((left, right) => left.localeCompare(right));
}

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const profileId = await routeId(context);
  const env = getEnv();
  const [profile, rule, flag, versions, itemBinding] = await Promise.all([
    env.DB.prepare(
      `SELECT id,dossier_kind,product_variant_id,offer_tracking_policy,suspect_notice_policy
       FROM watch_profiles WHERE id=?`,
    ).bind(profileId).first<ProfileRow>(),
    env.DB.prepare(
      `SELECT * FROM monitor_rules WHERE watch_profile_id=? AND valid_to IS NULL
       ORDER BY version DESC LIMIT 1`,
    ).bind(profileId).first<MonitorRuleRow>(),
    env.DB.prepare(
      "SELECT enabled FROM runtime_feature_flags WHERE flag_key='monitor_rules_v2'",
    ).first<{ enabled: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) count FROM monitor_rules WHERE watch_profile_id=?",
    ).bind(profileId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT notify_price_drop,notify_price_rise,notify_restock,notify_sold_out,min_drop_amount
       FROM watch_bindings WHERE watch_profile_id=? AND kind='item' ORDER BY created_at LIMIT 1`,
    ).bind(profileId).first<{
      notify_price_drop: number;
      notify_price_rise: number;
      notify_restock: number;
      notify_sold_out: number;
      min_drop_amount: number;
    }>(),
  ]);
  if (!profile) return apiError("watch_profile_not_found", 404);
  const landedTarget = rule ? await landedTargetView(env.DB, rule.id) : null;
  return Response.json({
    featureEnabled: flag?.enabled === 1,
    landedCostFeatureEnabled: false,
    dossierKind: profile.dossier_kind,
    productVariantId: profile.product_variant_id,
    offerTrackingPolicy: profile.offer_tracking_policy,
    suspectNoticePolicy: profile.suspect_notice_policy,
    currentCostProfile: null,
    rule: rule ? monitorRuleView(rule, landedTarget) : null,
    versionCount: Number(versions?.count ?? 0),
    itemSignals: itemBinding ? {
      notifyPriceDrop: itemBinding.notify_price_drop === 1,
      notifyPriceRise: itemBinding.notify_price_rise === 1,
      notifyRestock: itemBinding.notify_restock === 1,
      notifySoldOut: itemBinding.notify_sold_out === 1,
      minDropAmount: itemBinding.min_drop_amount,
    } : null,
  });
}

export async function PUT(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = monitorRuleSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("；"), issues: parsed.error.issues }, { status: 400 });
  }

  // Keep historical cost rules readable, but this monitor no longer creates
  // cross-border cost estimates or accepts the retired alert from older UIs.
  if (parsed.data.eventTypes.includes("product.offer_below_target_landed_cost")
    || parsed.data.targetLandedCost !== null || parsed.data.costProfileId !== null) {
    return apiError("到手成本提醒已移出监控策略，请刷新页面后使用目标标价提醒。", 400);
  }

  const profileId = await routeId(context);
  const env = getEnv();
  const [profile, current, flag, boundSources, listing, itemBinding] = await Promise.all([
    env.DB.prepare(
      `SELECT id,dossier_kind,product_variant_id,offer_tracking_policy,suspect_notice_policy
       FROM watch_profiles WHERE id=?`,
    ).bind(profileId).first<ProfileRow>(),
    env.DB.prepare(
      `SELECT * FROM monitor_rules WHERE watch_profile_id=? AND valid_to IS NULL
       ORDER BY version DESC LIMIT 1`,
    ).bind(profileId).first<MonitorRuleRow>(),
    env.DB.prepare(
      "SELECT enabled FROM runtime_feature_flags WHERE flag_key='monitor_rules_v2'",
    ).first<{ enabled: number }>(),
    env.DB.prepare(
      `SELECT DISTINCT b.source_id,s.display_name FROM watch_bindings b
       JOIN source_registry s ON s.id=b.source_id WHERE b.watch_profile_id=?`,
    ).bind(profileId).all<{ source_id: string; display_name: string }>(),
    env.DB.prepare(
      `SELECT listing.id FROM watch_bindings binding
       JOIN listings listing
         ON listing.source_id=binding.source_id AND listing.source_item_id=binding.source_item_id
       WHERE binding.watch_profile_id=? AND binding.kind='item'
       ORDER BY binding.created_at LIMIT 1`,
    ).bind(profileId).first<{ id: string }>(),
    env.DB.prepare(
      `SELECT notify_price_drop,notify_price_rise,notify_restock,notify_sold_out,min_drop_amount
       FROM watch_bindings WHERE watch_profile_id=? AND kind='item' ORDER BY created_at LIMIT 1`,
    ).bind(profileId).first<{
      notify_price_drop: number;
      notify_price_rise: number;
      notify_restock: number;
      notify_sold_out: number;
      min_drop_amount: number;
    }>(),
  ]);
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (flag?.enabled !== 1) return apiError("monitor_rules_v2_disabled", 409);

  const data = parsed.data;
  if (profile.dossier_kind === "item" && !data.itemSignals) return apiError("item_signals_required", 400);
  if (profile.dossier_kind !== "item" && data.itemSignals) return apiError("item_signals_not_allowed", 400);
  if (profile.dossier_kind === "exact_product" && data.offerTrackingPolicy === null) {
    return apiError("offer_tracking_policy_required", 400);
  }
  if (profile.dossier_kind !== "exact_product" && data.offerTrackingPolicy !== null) {
    return apiError("offer_tracking_policy_not_allowed", 400);
  }
  // 送达门槛只对精确同款档案有意义：关键词雷达根本没有「疑似同款」分区，
  // 允许它设只会变成一个什么都不做的隐形开关。
  if (profile.dossier_kind === "exact_product" && data.suspectNoticePolicy === null) {
    return apiError("suspect_notice_policy_required", 400);
  }
  if (profile.dossier_kind !== "exact_product" && data.suspectNoticePolicy !== null) {
    return apiError("suspect_notice_policy_not_allowed", 400);
  }
  if (data.eventTypes.some((eventType) => !allowedEvents[profile.dossier_kind].has(eventType))) {
    return apiError("monitor_event_not_allowed_for_dossier", 400);
  }
  const expectedDelivery = profile.dossier_kind === "item" ? "instant" : "digest";
  if (data.deliveryMode !== expectedDelivery) {
    return apiError(profile.dossier_kind === "item"
      ? "item_digest_delivery_not_available"
      : "radar_instant_delivery_not_available", 400);
  }
  if (data.deliveryMode === "digest" && data.quietHours !== null) {
    return apiError("digest_quiet_hours_not_available", 400);
  }
  const bound = new Set(boundSources.results.map((row) => row.source_id));
  if ([...data.sourceAllow, ...data.sourceDeny].some((source) => !bound.has(source))) {
    return apiError("monitor_rule_source_not_bound", 400);
  }

  const scopeType = profile.dossier_kind === "item"
    ? "listing"
    : profile.dossier_kind === "exact_product"
      ? "variant"
      : "market";
  const stableScopeId = scopeType === "listing"
    ? listing?.id
    : scopeType === "variant"
      ? profile.product_variant_id ?? undefined
      : profile.id;
  const scopeId = stableScopeId ?? profile.id;
  const identityStatus = stableScopeId ? "bound" : "pending";
  const currentLandedTarget = current ? await landedTargetView(env.DB, current.id) : null;
  const nextComparable = {
    scopeType,
    scopeId,
    identityStatus,
    eventTypes: normalized(data.eventTypes),
    sourceAllow: normalized(data.sourceAllow),
    sourceDeny: normalized(data.sourceDeny),
    conditions: normalized(data.conditions),
    completeness: normalized(data.completeness),
    targetListingPrice: data.targetListingPrice,
    targetLandedCost: data.targetLandedCost,
    costProfileId: data.costProfileId,
    deliveryMode: data.deliveryMode,
    quietHours: data.quietHours,
    timezone: data.timezone,
    dedupeWindowMinutes: data.dedupeWindowMinutes,
    cooldownMinutes: data.cooldownMinutes,
    staleSourcePolicy: data.staleSourcePolicy,
    enabled: data.enabled,
    itemSignals: data.itemSignals,
    offerTrackingPolicy: data.offerTrackingPolicy,
  };
  if (current) {
    const view = monitorRuleView(current, currentLandedTarget);
    const currentComparable = {
      scopeType: view.scopeType,
      scopeId: view.scopeId,
      identityStatus: view.scopeIdentityStatus,
      eventTypes: normalized(view.eventTypes),
      sourceAllow: normalized(view.sourceAllow),
      sourceDeny: normalized(view.sourceDeny),
      conditions: normalized(view.conditions),
      completeness: normalized(view.completeness),
      targetListingPrice: view.targetListingPrice,
      targetLandedCost: view.targetLandedCost,
      costProfileId: view.landedCostProfile?.id ?? null,
      deliveryMode: view.deliveryMode,
      quietHours: view.quietHours,
      timezone: view.timezone,
      dedupeWindowMinutes: view.dedupeWindowMinutes,
      cooldownMinutes: view.cooldownMinutes,
      staleSourcePolicy: view.staleSourcePolicy,
      enabled: view.enabled,
      itemSignals: itemBinding ? {
        notifyPriceDrop: itemBinding.notify_price_drop === 1,
        notifyPriceRise: itemBinding.notify_price_rise === 1,
        notifyRestock: itemBinding.notify_restock === 1,
        notifySoldOut: itemBinding.notify_sold_out === 1,
        minDropAmount: itemBinding.min_drop_amount,
      } : null,
      offerTrackingPolicy: profile.dossier_kind === "exact_product" ? profile.offer_tracking_policy : null,
    };
    if (JSON.stringify(currentComparable) === JSON.stringify(nextComparable)) {
      return Response.json({ updated: false, rule: view, versionCountUnchanged: true });
    }
  }

  const now = new Date().toISOString();
  const ruleId = crypto.randomUUID();
  const nextVersion = (current?.version ?? 0) + 1;
  const statements: OperationalPreparedStatement[] = [];
  if (current) {
    statements.push(env.DB.prepare(
      "UPDATE monitor_rules SET valid_to=? WHERE id=? AND valid_to IS NULL",
    ).bind(now, current.id));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO monitor_rules(
      id,rule_key,version,watch_profile_id,scope_type,scope_id,scope_identity_status,
      event_types_json,source_allow_json,source_deny_json,conditions_json,completeness_json,
      target_listing_price,target_landed_cost,delivery_mode,quiet_hours_start,quiet_hours_end,
      timezone,dedupe_window_minutes,cooldown_minutes,stale_source_policy,enabled,
      supersedes_rule_id,valid_from,created_at,created_by
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    ruleId,
    monitorRuleKey(profile.id),
    nextVersion,
    profile.id,
    scopeType,
    scopeId,
    identityStatus,
    JSON.stringify(data.eventTypes),
    JSON.stringify(data.sourceAllow),
    JSON.stringify(data.sourceDeny),
    JSON.stringify(data.conditions),
    JSON.stringify(data.completeness),
    data.targetListingPrice,
    data.deliveryMode,
    data.quietHours?.start ?? null,
    data.quietHours?.end ?? null,
    data.timezone,
    data.dedupeWindowMinutes,
    data.cooldownMinutes,
    data.staleSourcePolicy,
    data.enabled ? 1 : 0,
    current?.id ?? null,
    now,
    now,
    "user",
  ));

  if (profile.dossier_kind === "item") {
    const itemSignals = data.itemSignals!;
    statements.push(env.DB.prepare(
      `UPDATE watch_bindings SET
        notify_price_drop=?,notify_price_rise=?,notify_restock=?,notify_sold_out=?,min_drop_amount=?,target_price=?,updated_at=?
       WHERE watch_profile_id=? AND kind='item'`,
    ).bind(
      itemSignals.notifyPriceDrop ? 1 : 0,
      itemSignals.notifyPriceRise ? 1 : 0,
      itemSignals.notifyRestock ? 1 : 0,
      itemSignals.notifySoldOut ? 1 : 0,
      itemSignals.minDropAmount,
      data.targetListingPrice,
      now,
      profile.id,
    ));
  } else if (profile.dossier_kind === "exact_product") {
    const needsNewListingCandidate = monitorRuleNeedsNewListingCandidate(data.eventTypes);
    statements.push(env.DB.prepare(
      `UPDATE watch_bindings SET notify_new_listing=?,notify_price_drop=?,notify_restock=?,
       notify_sold_out=?,target_price=?,updated_at=? WHERE watch_profile_id=? AND kind='keyword'`,
    ).bind(
      needsNewListingCandidate ? 1 : 0,
      data.eventTypes.includes("listing.price_changed") ? 1 : 0,
      0,
      0,
      data.targetListingPrice,
      now,
      profile.id,
    ));
  } else {
    const needsNewListingCandidate = data.eventTypes.length > 0;
    statements.push(env.DB.prepare(
      "UPDATE watch_bindings SET notify_new_listing=?,updated_at=? WHERE watch_profile_id=? AND kind='keyword'",
    ).bind(needsNewListingCandidate ? 1 : 0, now, profile.id));
  }
  statements.push(env.DB.prepare(
    `UPDATE watch_profiles SET default_max_price=?,offer_tracking_policy=?,suspect_notice_policy=?,
     updated_at=? WHERE id=?`,
  ).bind(data.targetListingPrice, data.offerTrackingPolicy ?? "search_window",
    data.suspectNoticePolicy ?? "confirmed_only", now, profile.id));
  if (profile.dossier_kind === "exact_product" && data.offerTrackingPolicy === "search_window"
    && profile.offer_tracking_policy !== "search_window") {
    statements.push(env.DB.prepare(
      `UPDATE watch_listing_matches SET tracking_status='discovery_only',tracking_next_run_at=NULL,
       tracking_cooldown_until=NULL,tracking_ended_at=?,tracking_terminal_reason='policy_search_window'
       WHERE watch_binding_id IN (SELECT id FROM watch_bindings WHERE watch_profile_id=?)
         AND tracking_status IN ('active','unavailable_pending','waiting_restock','paused')`,
    ).bind(now, profile.id));
  }
  statements.push(...profileChangeStatements(env.DB, profile.id, monitorRuleChanges({
    before: current ? monitorRuleView(current, currentLandedTarget) : null,
    after: data,
    profile,
    sourceNames: new Map(boundSources.results.map((row) => [row.source_id, row.display_name])),
  }), now));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      && typeof error.code === "string" ? error.code : null;
    console.error(JSON.stringify({ event: "monitor_rule_save_failed", profileId, code }));
    return apiError(code === "23505"
      ? "规则版本冲突，修改未保存。请刷新后重试；若仍失败，请稍后再试。"
      : "规则保存失败，请稍后重试。刷新页面可核对当前生效的目标价。", code === "23505" ? 409 : 500);
  }

  const saved = await env.DB.prepare("SELECT * FROM monitor_rules WHERE id=?")
    .bind(ruleId).first<MonitorRuleRow>();
  if (!saved) return apiError("monitor_rule_persistence_failed", 500);
  const savedLandedTarget = await landedTargetView(env.DB, ruleId);
  return Response.json({ updated: true, rule: monitorRuleView(saved, savedLandedTarget) });
}

const EVENT_TEXT: Partial<Record<MonitorEventType, string>> = {
  "product.new_comparable_offer": "新商品 / 新同款",
  "listing.price_changed": "价格变化",
  "listing.availability_changed": "上下架",
  "product.offer_below_target_listing_price": "低于目标标价",
  "product.condition_match_seen": "符合品相",
  "product.complete_set_seen": "完整套装",
};

const SUSPECT_POLICY_TEXT: Record<SuspectNoticePolicy, string> = {
  confirmed_only: "只发确认同款",
  strong_suspects: "确认同款 + 高度疑似",
  all_suspects: "连相关商品一起发",
};

const OFFER_TRACKING_TEXT: Record<OfferTrackingPolicy, string> = {
  all_confirmed_offers: "持续检查全部确认同款",
  search_window: "只检查每轮巡回结果",
};

/** 「发生什么时提醒我」这一块里用户看得懂、会去改的几项；去重窗口这类固定值不记。 */
function monitorRuleChanges({ before, after, profile, sourceNames }: {
  before: ReturnType<typeof monitorRuleView> | null;
  after: {
    eventTypes: readonly MonitorEventType[];
    targetListingPrice: number | null;
    sourceDeny: readonly string[];
    enabled: boolean;
    quietHours: { start: string; end: string } | null;
    suspectNoticePolicy: SuspectNoticePolicy | null;
    offerTrackingPolicy: OfferTrackingPolicy | null;
  };
  profile: ProfileRow;
  sourceNames: Map<string, string>;
}): ProfileChange[] {
  const events = (types: readonly MonitorEventType[]) =>
    [...new Set(types.map((type) => EVENT_TEXT[type] ?? type))].sort().join("、") || "都不提醒";
  const denied = (ids: readonly string[]) => ids.length
    ? `${[...ids].map((id) => sourceNames.get(id) ?? id).sort().join("、")} 不参与`
    : "全部参与";
  const quiet = (hours: { start: string; end: string } | null) => hours ? `${hours.start}–${hours.end}` : "不静默";
  const changes: ProfileChange[] = [
    { field: "rule_events", before: before ? events(before.eventTypes) : null, after: events(after.eventTypes) },
    { field: "rule_target_price", before: yenText(before?.targetListingPrice), after: yenText(after.targetListingPrice) },
    { field: "rule_sources", before: before ? denied(before.sourceDeny) : null, after: denied(after.sourceDeny) },
    { field: "rule_enabled", before: before ? onOffText(before.enabled, "启用", "停用") : null, after: onOffText(after.enabled, "启用", "停用") },
  ];
  if (profile.dossier_kind === "item") {
    changes.push({ field: "rule_quiet_hours", before: before ? quiet(before.quietHours) : null, after: quiet(after.quietHours) });
  }
  if (profile.dossier_kind === "exact_product") {
    changes.push(
      { field: "rule_suspect_policy", before: SUSPECT_POLICY_TEXT[profile.suspect_notice_policy] ?? null, after: after.suspectNoticePolicy ? SUSPECT_POLICY_TEXT[after.suspectNoticePolicy] : null },
      { field: "rule_offer_tracking", before: OFFER_TRACKING_TEXT[profile.offer_tracking_policy] ?? null, after: after.offerTrackingPolicy ? OFFER_TRACKING_TEXT[after.offerTrackingPolicy] : null },
    );
  }
  return changes;
}
