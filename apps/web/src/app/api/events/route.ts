import { unauthorized } from "@/lib/api-auth";
import { getEnv } from "@/lib/cloudflare";

const productEventTypes = ["new_listing", "price_drop", "price_rise", "interest_rise", "target_price", "restock", "sold_out"] as const;
const eventTypes = new Set([
  ...productEventTypes,
  "source_error",
  "daily_digest",
  "watch_completed",
  "morning_digest",
  "weekly_market_digest",
]);
const monitorEventTypes = new Set([
  "listing.price_changed",
  "listing.availability_changed",
  "product.new_comparable_offer",
  "product.offer_below_target_listing_price",
  "product.offer_below_target_landed_cost",
  "product.condition_match_seen",
  "product.complete_set_seen",
]);
const statuses = new Set(["pending", "sending", "sent", "failed", "suppressed"]);
const views = new Set(["changes", "deliveries", "system"]);
const pageSize = 40;

interface EventQueryRow {
  id: string;
  event_type: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  payload_json: string;
  listing_id: string | null;
  title: string | null;
  canonical_url: string | null;
  image_url: string | null;
  source_item_id: string | null;
  source_id: string | null;
  source_display_name: string | null;
  seller_name: string | null;
  shop_name: string | null;
  current_price: number | null;
  original_price: number | null;
  item_condition: string | null;
  availability: string | null;
  item_watch_profile_id: string | null;
  watch_profile_id?: string | null;
  dossier_kind?: "item" | "exact_product" | "keyword" | null;
  monitor_rule_id?: string | null;
  rule_version?: number | null;
  evidence_hash?: string | null;
  occurred_at?: string | null;
  detected_at?: string | null;
  notification_eligibility?: string | null;
  suppression_reason?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  attempts: number | null;
  last_error: string | null;
}

interface SummaryRow {
  today_product_changes: number | string;
  pending_deliveries: number | string;
  failed_deliveries: number | string;
  sent_today: number | string;
}

interface SourceOptionRow {
  id: string;
  display_name: string;
}

function japanDayStart(now = Date.now()): string {
  const offset = 9 * 60 * 60 * 1_000;
  const local = new Date(now + offset);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset).toISOString();
}

interface AuditRunRow {
  id: string;
  trigger_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  result_count: number;
  new_count: number;
  changed_count: number;
  coverage: string;
  error_code: string | null;
  error_message: string | null;
  source_id: string;
  watch_binding_id: string;
  source_display_name: string;
  raw_result_count: number | null;
}

/** 用户已经在「疑似同款」上做过判定的候选。前端据此把按钮切成已标掉态，
 *  并说明它为什么不会再出现在摘要里。 */
interface CandidateDismissalRow {
  watch_binding_id: string;
  source_id: string;
  source_item_id: string;
  reason: "not_same_product" | "too_expensive";
  created_at: string;
}

interface AuditListingRow {
  watch_run_id: string;
  ordinal: number;
  decision_status: "pending" | "confirmed" | "rejected" | "uncertain";
  decision_reason: string | null;
  match_relation: string | null;
  is_purchasable: number;
  observed_at: string;
  source_id: string;
  source_item_id: string;
  canonical_url: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  currency: string;
  price_basis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid";
  availability: string;
  item_condition: string;
  first_observed_at: string;
  observation_count: number;
  is_first_observation: number;
}

async function monitorChangesResponse(input: {
  type: string | null;
  source: string | null;
  watchProfileId: string | null;
  cursor: { createdAt: string; id: string } | null;
  dayStart: string;
}) {
  const clauses: string[] = [];
  const values: string[] = [];
  if (input.type && monitorEventTypes.has(input.type)) {
    clauses.push("me.event_type=?");
    values.push(input.type);
  }
  if (input.source && /^[a-z0-9_-]{1,80}$/.test(input.source)) {
    clauses.push("l.source_id=?");
    values.push(input.source);
  }
  if (input.watchProfileId && input.watchProfileId.length <= 100) {
    clauses.push("me.watch_profile_id=?");
    values.push(input.watchProfileId);
  }
  const countFilter = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageClauses = [...clauses];
  const pageValues = [...values];
  if (input.cursor) {
    pageClauses.push("(me.detected_at < ? OR (me.detected_at = ? AND me.id < ?))");
    pageValues.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
  }
  const pageFilter = pageClauses.length ? `WHERE ${pageClauses.join(" AND ")}` : "";
  const joins = `FROM monitor_events me
    LEFT JOIN listings l ON l.id=me.listing_id
    LEFT JOIN source_registry s ON s.id=l.source_id
    LEFT JOIN events legacy ON legacy.id=me.legacy_event_id
    LEFT JOIN watch_profiles wp ON wp.id=me.watch_profile_id`;
  const env = getEnv();
  const [rows, count, summary, sources] = await Promise.all([
    env.DB.prepare(
      `SELECT me.id,me.event_type,me.notification_eligibility status,
       me.detected_at created_at,legacy.sent_at,me.payload_json,
       l.id listing_id,l.title,l.canonical_url,l.image_url,l.source_item_id,l.seller_name,l.shop_name,
       l.source_id,COALESCE(s.display_name,l.source_id) source_display_name,
       l.current_price,l.original_price,l.item_condition,l.availability,
       me.watch_profile_id item_watch_profile_id,me.watch_profile_id,wp.dossier_kind,
       me.monitor_rule_id,me.rule_version,me.evidence_hash,me.occurred_at,me.detected_at,
       me.notification_eligibility,me.suppression_reason,me.subject_type,me.subject_id,
       (SELECT d.attempts FROM notice_deliveries d WHERE d.event_id=legacy.id ORDER BY d.updated_at DESC LIMIT 1) attempts,
       (SELECT COALESCE(d.outcome_error,d.last_error) FROM notice_deliveries d WHERE d.event_id=legacy.id ORDER BY d.updated_at DESC LIMIT 1) last_error
       ${joins} ${pageFilter}
       ORDER BY me.detected_at DESC,me.id DESC LIMIT ?`,
    ).bind(...pageValues, pageSize + 1).all<EventQueryRow>(),
    env.DB.prepare(`SELECT COUNT(*) count ${joins} ${countFilter}`)
      .bind(...values).first<{ count: number | string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) count ${joins} WHERE ${[...clauses, "me.detected_at>=?"].join(" AND ")}`,
    ).bind(...values, input.dayStart).first<{ count: number | string }>(),
    env.DB.prepare("SELECT id,display_name FROM source_registry ORDER BY display_name").all<SourceOptionRow>(),
  ]);
  const hasMore = rows.results.length > pageSize;
  const items = rows.results.slice(0, pageSize);
  const last = hasMore ? items.at(-1) : undefined;
  const auditClauses: string[] = [];
  const auditValues: string[] = [];
  if (input.watchProfileId) {
    auditClauses.push("b.watch_profile_id=?");
    auditValues.push(input.watchProfileId);
  } else {
    auditClauses.push("1=0");
  }
  if (input.source && /^[a-z0-9_-]{1,80}$/.test(input.source)) {
    auditClauses.push("b.source_id=?");
    auditValues.push(input.source);
  }
  const auditRuns = await env.DB.prepare(
    `SELECT r.id,r.trigger_type,r.status,r.started_at,r.finished_at,r.result_count,r.new_count,
            r.changed_count,r.coverage,r.error_code,r.error_message,b.source_id,b.id watch_binding_id,
            COALESCE(s.display_name,b.source_id) source_display_name,h.raw_result_count
     FROM watch_runs r
     JOIN watch_bindings b ON b.id=r.watch_binding_id
     LEFT JOIN source_registry s ON s.id=b.source_id
     LEFT JOIN source_health_snapshots h ON h.watch_run_id=r.id
     WHERE ${auditClauses.join(" AND ")}
     ORDER BY r.started_at DESC,r.id DESC LIMIT 30`,
  ).bind(...auditValues).all<AuditRunRow>();
  const auditRunIds = auditRuns.results.map((run) => run.id);
  const auditListings = auditRunIds.length > 0
    ? await env.DB.prepare(
        `SELECT o.watch_run_id,o.ordinal,o.decision_status,o.decision_reason,o.match_relation,
                o.is_purchasable,o.observed_at,o.source_id,o.source_item_id,o.canonical_url,
                o.title,o.image_url,o.current_price,o.currency,o.price_basis,o.availability,o.item_condition,
                (SELECT MIN(history.observed_at) FROM watch_run_listing_observations history
                 WHERE history.watch_binding_id=o.watch_binding_id
                   AND history.source_id=o.source_id AND history.source_item_id=o.source_item_id) first_observed_at,
                (SELECT COUNT(*) FROM watch_run_listing_observations history
                 WHERE history.watch_binding_id=o.watch_binding_id
                   AND history.source_id=o.source_id AND history.source_item_id=o.source_item_id) observation_count,
                CASE WHEN EXISTS (
                  SELECT 1 FROM watch_run_listing_observations history
                  WHERE history.watch_binding_id=o.watch_binding_id
                    AND history.source_id=o.source_id AND history.source_item_id=o.source_item_id
                    AND history.created_at<o.created_at
                ) THEN 0 ELSE 1 END is_first_observation
         FROM watch_run_listing_observations o
         WHERE o.watch_run_id IN (${auditRunIds.map(() => "?").join(",")})
         ORDER BY o.observed_at DESC,o.ordinal,o.source_id,o.source_item_id`,
      ).bind(...auditRunIds).all<AuditListingRow>()
    : { results: [] as AuditListingRow[] };
  const auditBindingIds = [...new Set(auditRuns.results.map((run) => run.watch_binding_id))];
  const dismissals = auditBindingIds.length > 0
    ? await env.DB.prepare(
        `SELECT watch_binding_id,source_id,source_item_id,reason,created_at
         FROM watch_dismissed_candidates
         WHERE watch_binding_id IN (${auditBindingIds.map(() => "?").join(",")})
         LIMIT 2000`,
      ).bind(...auditBindingIds).all<CandidateDismissalRow>()
    : { results: [] as CandidateDismissalRow[] };
  const listingsByRun = new Map<string, AuditListingRow[]>();
  for (const listing of auditListings.results) {
    const runListings = listingsByRun.get(listing.watch_run_id) ?? [];
    runListings.push(listing);
    listingsByRun.set(listing.watch_run_id, runListings);
  }
  return Response.json({
    semanticsVersion: "monitor-events-v2",
    items,
    dismissals: dismissals.results,
    audits: auditRuns.results.map((run) => {
      const listings = listingsByRun.get(run.id) ?? [];
      return {
        ...run,
        listings,
        decisionCounts: listings.reduce((counts, listing) => ({
          ...counts,
          [listing.decision_status]: counts[listing.decision_status] + 1,
        }), { pending: 0, confirmed: 0, rejected: 0, uncertain: 0 }),
      };
    }),
    page: {
      total: Number(count?.count ?? 0),
      pageSize,
      hasMore,
      nextCursor: last ? `${last.created_at}|${last.id}` : null,
    },
    summary: {
      todayProductChanges: Number(summary?.count ?? 0),
      pendingDeliveries: 0,
      failedDeliveries: 0,
      sentToday: 0,
    },
    sources: sources.results,
  });
}

function cursorParts(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return Number.isFinite(Date.parse(createdAt)) && id.length > 0 && id.length <= 100
    ? { createdAt, id }
    : null;
}

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;

  const url = new URL(request.url);
  const requestedView = url.searchParams.get("view");
  const view = requestedView && views.has(requestedView) ? requestedView : "changes";
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const source = url.searchParams.get("source");
  const watchProfileId = url.searchParams.get("watch")?.slice(0, 100) ?? null;
  const cursor = cursorParts(url.searchParams.get("cursor"));

  const dayStart = japanDayStart();
  if (view === "changes") {
    return monitorChangesResponse({ type, source, watchProfileId, cursor, dayStart });
  }

  const clauses: string[] = [];
  const values: string[] = [];
  if (view === "deliveries") {
    clauses.push("e.status <> 'suppressed'");
    clauses.push(`(COALESCE(e.semantic_event_type,e.event_type)='daily_digest'
      OR COALESCE(e.semantic_event_type,e.event_type) <> 'new_listing'
      OR COALESCE(b.monitoring_purpose,'') <> 'keyword_new_listing')`);
  }
  if (view === "system") clauses.push("COALESCE(e.semantic_event_type,e.event_type)='source_error'");
  if (type && eventTypes.has(type)) {
    clauses.push("COALESCE(e.semantic_event_type,e.event_type)=?");
    values.push(type);
  }
  if (status && statuses.has(status)) {
    clauses.push("e.status=?");
    values.push(status);
  }
  if (source && /^[a-z0-9_-]{1,80}$/.test(source)) {
    clauses.push("COALESCE(l.source_id,b.source_id)=?");
    values.push(source);
  }

  const filterSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageClauses = [...clauses];
  const pageValues = [...values];
  if (cursor) {
    pageClauses.push("(e.created_at < ? OR (e.created_at = ? AND e.id < ?))");
    pageValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const pageFilterSql = pageClauses.length ? `WHERE ${pageClauses.join(" AND ")}` : "";
  const joins = `FROM events e
    LEFT JOIN listings l ON l.id=e.listing_id
    LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
    LEFT JOIN source_registry s ON s.id=COALESCE(l.source_id,b.source_id)`;

  const env = getEnv();
  const [result, countRow, summaryRow, sourceRows] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id,COALESCE(e.semantic_event_type,e.event_type) event_type,
       e.status,e.created_at,e.sent_at,e.payload_json,
       l.id listing_id,l.title,l.canonical_url,l.image_url,l.source_item_id,l.seller_name,l.shop_name,
       COALESCE(l.source_id,b.source_id) source_id,
       COALESCE(s.display_name,l.source_id,b.source_id) source_display_name,
       l.current_price,l.original_price,l.item_condition,l.availability,e.watch_profile_id,
       (SELECT item_binding.watch_profile_id
        FROM watch_bindings item_binding
        JOIN watch_profiles item_profile ON item_profile.id=item_binding.watch_profile_id
        WHERE item_binding.kind='item'
          AND item_binding.source_id=l.source_id
          AND item_binding.source_item_id=l.source_item_id
        ORDER BY item_profile.enabled DESC,item_binding.enabled DESC,item_binding.updated_at DESC
        LIMIT 1) item_watch_profile_id,
       (SELECT d.attempts FROM notice_deliveries d WHERE d.event_id=e.id ORDER BY d.updated_at DESC LIMIT 1) attempts,
       (SELECT COALESCE(d.outcome_error,d.last_error) FROM notice_deliveries d WHERE d.event_id=e.id ORDER BY d.updated_at DESC LIMIT 1) last_error
       ${joins} ${pageFilterSql}
       ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
    ).bind(...pageValues, pageSize + 1).all<EventQueryRow>(),
    env.DB.prepare(`SELECT COUNT(*) count ${joins} ${filterSql}`).bind(...values).first<{ count: number | string }>(),
    env.DB.prepare(
      `SELECT
       (SELECT COUNT(*) FROM monitor_events WHERE detected_at>=?) today_product_changes,
       SUM(CASE WHEN status IN ('pending','sending') THEN 1 ELSE 0 END) pending_deliveries,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_deliveries,
       SUM(CASE WHEN status='sent' AND sent_at>=? THEN 1 ELSE 0 END) sent_today
       FROM events`,
    ).bind(dayStart, dayStart).first<SummaryRow>(),
    env.DB.prepare("SELECT id,display_name FROM source_registry ORDER BY display_name").all<SourceOptionRow>(),
  ]);

  const hasMore = result.results.length > pageSize;
  const items = result.results.slice(0, pageSize);
  const last = hasMore ? items.at(-1) : undefined;

  return Response.json({
    items,
    page: {
      total: Number(countRow?.count ?? 0),
      pageSize,
      hasMore,
      nextCursor: last ? `${last.created_at}|${last.id}` : null,
    },
    summary: {
      todayProductChanges: Number(summaryRow?.today_product_changes ?? 0),
      pendingDeliveries: Number(summaryRow?.pending_deliveries ?? 0),
      failedDeliveries: Number(summaryRow?.failed_deliveries ?? 0),
      sentToday: Number(summaryRow?.sent_today ?? 0),
    },
    sources: sourceRows.results,
  });
}
