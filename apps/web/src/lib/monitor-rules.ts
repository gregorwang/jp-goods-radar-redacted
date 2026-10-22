import "server-only";

import type { MonitorEventType, MonitorScopeType, WatchDossierKind } from "@jpgr/core";
import { monitorRuleKey } from "@jpgr/core";
import type {
  MonitorRuleRow,
  OperationalDatabase,
  OperationalPreparedStatement,
} from "@jpgr/db";
import type { MonitorRuleView } from "@/lib/monitor-rule-contract";
export { monitorRuleNeedsNewListingCandidate } from "@/lib/monitor-rule-events";

function stringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function monitorRuleView(
  row: MonitorRuleRow,
  landedTarget?: {
    targetLandedCostJpy: number;
    costProfileId: string;
    costProfileVersion: number;
    costProfileName: string;
  } | null,
): MonitorRuleView {
  return {
    id: row.id,
    ruleKey: row.rule_key,
    version: row.version,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeIdentityStatus: row.scope_identity_status,
    eventTypes: stringArray(row.event_types_json) as MonitorEventType[],
    sourceAllow: stringArray(row.source_allow_json),
    sourceDeny: stringArray(row.source_deny_json),
    conditions: stringArray(row.conditions_json),
    completeness: stringArray(row.completeness_json),
    targetListingPrice: row.target_listing_price,
    targetLandedCost: landedTarget?.targetLandedCostJpy ?? row.target_landed_cost,
    landedCostProfile: landedTarget ? {
      id: landedTarget.costProfileId,
      version: landedTarget.costProfileVersion,
      name: landedTarget.costProfileName,
    } : null,
    deliveryMode: row.delivery_mode,
    quietHours: row.quiet_hours_start && row.quiet_hours_end
      ? { start: row.quiet_hours_start, end: row.quiet_hours_end }
      : null,
    timezone: row.timezone,
    dedupeWindowMinutes: row.dedupe_window_minutes,
    cooldownMinutes: row.cooldown_minutes,
    staleSourcePolicy: row.stale_source_policy,
    enabled: row.enabled === 1,
    validFrom: row.valid_from,
    createdBy: row.created_by,
  };
}

export function initialMonitorRuleStatement(
  db: OperationalDatabase,
  input: {
    profileId: string;
    dossierKind: WatchDossierKind;
    now: string;
    productVariantId?: string;
    listingId?: string;
    targetListingPrice?: number;
    eventTypes?: MonitorEventType[];
  },
): OperationalPreparedStatement {
  const scopeType: MonitorScopeType = input.dossierKind === "item"
    ? "listing"
    : input.dossierKind === "exact_product"
      ? "variant"
      : "market";
  const stableScopeId = scopeType === "listing"
    ? input.listingId
    : scopeType === "variant"
      ? input.productVariantId
      : input.profileId;
  const eventTypes: MonitorEventType[] = input.eventTypes ?? (input.dossierKind === "item"
    ? [
        "listing.price_changed",
        "listing.availability_changed",
        ...(input.targetListingPrice === undefined ? [] : ["product.offer_below_target_listing_price" as const]),
      ]
    : input.dossierKind === "exact_product"
      ? ["product.new_comparable_offer", "listing.price_changed"]
      : input.dossierKind === "keyword"
        ? ["product.new_comparable_offer"]
      : []);
  const id = crypto.randomUUID();
  const ruleKey = monitorRuleKey(input.profileId);
  return db.prepare(
    `INSERT INTO monitor_rules(
      id,rule_key,version,watch_profile_id,scope_type,scope_id,scope_identity_status,
      event_types_json,target_listing_price,delivery_mode,enabled,valid_from,created_at,created_by
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    ruleKey,
    1,
    input.profileId,
    scopeType,
    stableScopeId ?? input.profileId,
    stableScopeId ? "bound" : "pending",
    JSON.stringify(eventTypes),
    input.targetListingPrice ?? null,
    input.dossierKind === "item" ? "instant" : "digest",
    1,
    input.now,
    input.now,
    "user",
  );
}
