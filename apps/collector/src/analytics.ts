import {
  ingestAnalyticsAiProcessingBatch,
  ingestAnalyticsSearchRun,
  ingestOperationalListingBundle,
  ingestProductIdentityProjection,
  marketSubscriptionKey,
  normalizeAnalyticsQuery,
  readLatestAiListingSemantics,
  type AnalyticsMarketScopeVersion,
  type AnalyticsSearchRun,
  type AnalyticsSourceCapture,
  type AnalyticsSourceGroup,
  type AnalyticsSourceHealthEvidence,
  type OperationalListingBundle,
  type ProductIdentityProjection,
} from "@jpgr/analytics";
import {
  assessProductMatch,
  effectiveItemIntervalMinutes,
  buildProductSearchPlan,
  productIdentity,
  productFingerprintNameConflicts,
  searchCandidateEvidence,
  SOURCE_IDS,
  type IngestAnalyticsJob,
  type NormalizedListing,
  type SearchFilters,
  type SearchResult,
  type SearchRouteOutcome,
  type SourceId,
  isParserFailureCode,
} from "@jpgr/core";
import type {
  OperationalDatabase,
  OperationalPreparedStatement,
  WatchBindingRow,
} from "@jpgr/db";
import {
  aiEnrichmentPersistenceSchema,
  aiEnrichmentLookupRequestSchema,
  normalizedListingSchema,
  productFingerprintSchema,
} from "@jpgr/validation";
import type { RuntimeEnv as Env } from "./runtime-env";

interface AnalyticsOutboxRow {
  id: string;
  kind: "preview_search" | "watch_market" | "ai_enrichment" | "listing_backfill" | "product_identity";
  reference_id: string;
  payload_json: string | null;
  status: "pending" | "queued" | "processing" | "succeeded" | "failed" | "skipped";
  attempts: number;
}

const ANALYTICS_OUTBOX_MAX_ATTEMPTS = 4;
const ANALYTICS_OUTBOX_PROCESSING_LEASE_MS = 8 * 60_000;

interface SearchHistoryRow {
  id: string;
  query: string;
  filters_json: string;
  search_mode: "keyword" | "exact_product";
  target_json: string | null;
  plan_json: string | null;
  deep_search: number;
  status: "success" | "partial" | "empty" | "failed";
  result_count: number;
  searched_at: string;
}

interface SearchSnapshotRow {
  source_id: string;
  group_json: string;
}

interface SourceCaptureRow {
  id: string;
  source_id: string;
  ordinal: number;
  request_url: string;
  response_url: string | null;
  request_method: string;
  response_status: number | null;
  content_type: string | null;
  payload_kind: AnalyticsSourceCapture["payloadKind"];
  raw_payload: string | null;
  payload_bytes: number;
  content_hash: string;
  captured_at: string;
  duration_ms: number;
  truncated: number;
  error_message: string | null;
}

interface OperationalListingRow {
  id: string;
  source_id: SourceId;
  source_item_id: string;
  identity_scope: NormalizedListing["identityScope"];
  canonical_url: string;
  title: string;
  description_excerpt: string | null;
  image_url: string | null;
  seller_name: string | null;
  shop_name: string | null;
  currency: string;
  current_price: number | null;
  original_price: number | null;
  price_basis: NormalizedListing["priceBasis"];
  item_condition: NormalizedListing["condition"];
  availability: NormalizedListing["availability"];
  source_listed_at: string | null;
  source_updated_at: string | null;
  last_seen_at: string;
  raw_metadata_json: string;
  product_facts_json: string;
}

interface OperationalSnapshotRow {
  id: string;
  watch_binding_id: string | null;
  price: number | null;
  original_price: number | null;
  price_basis: NormalizedListing["priceBasis"] | null;
  currency: string;
  availability: string;
  item_condition: string;
  state_hash: string | null;
  observed_at: string;
  content_hash: string | null;
  product_facts_json: string;
}

type AnalyticsEnv = Env & { ANALYTICS_DB: Hyperdrive };
type RoutedMarketResult = SearchResult & { requestRoute?: string; routeOutcome?: SearchRouteOutcome };

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("analytics_json_object_required");
  return value as Record<string, unknown>;
}

function parsedRecord(value: string): Record<string, unknown> {
  return recordValue(JSON.parse(value) as unknown);
}

function parsedRecordOrEmpty(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function requiredBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function sourceHealthEvidence(value: unknown): AnalyticsSourceHealthEvidence | undefined {
  if (value === undefined) return undefined;
  const raw = recordValue(value);
  const state = requiredString(raw.state, "analytics_source_health_state_missing");
  if (!["healthy", "empty", "suspected_degradation", "failed", "disabled", "cooldown"].includes(state)) {
    throw new Error("analytics_source_health_state_invalid");
  }
  const cursorTerminationReason = requiredString(
    raw.cursorTerminationReason,
    "analytics_source_health_cursor_missing",
  );
  if (!["exhausted", "budget_reached", "not_applicable", "unknown"].includes(cursorTerminationReason)) {
    throw new Error("analytics_source_health_cursor_invalid");
  }
  const freshnessSlaMinutes = nonNegativeInteger(
    raw.freshnessSlaMinutes,
    "analytics_source_health_freshness_invalid",
  );
  if (freshnessSlaMinutes === 0) throw new Error("analytics_source_health_freshness_invalid");
  return {
    state: state as AnalyticsSourceHealthEvidence["state"],
    requestSucceeded: requiredBoolean(raw.requestSucceeded, "analytics_source_health_request_invalid"),
    parseSucceeded: requiredBoolean(raw.parseSucceeded, "analytics_source_health_parse_invalid"),
    rawResultCount: nonNegativeInteger(raw.rawResultCount, "analytics_source_health_raw_count_invalid"),
    normalizedResultCount: nonNegativeInteger(raw.normalizedResultCount, "analytics_source_health_result_count_invalid"),
    pageDepth: nonNegativeInteger(raw.pageDepth, "analytics_source_health_page_depth_invalid"),
    cursorTerminationReason: cursorTerminationReason as AnalyticsSourceHealthEvidence["cursorTerminationReason"],
    abnormalEmpty: requiredBoolean(raw.abnormalEmpty, "analytics_source_health_empty_invalid"),
    fieldTotal: nonNegativeInteger(raw.fieldTotal, "analytics_source_health_field_total_invalid"),
    fieldComplete: nonNegativeInteger(raw.fieldComplete, "analytics_source_health_field_complete_invalid"),
    captchaDetected: requiredBoolean(raw.captchaDetected, "analytics_source_health_captcha_invalid"),
    loginRequired: requiredBoolean(raw.loginRequired, "analytics_source_health_login_invalid"),
    blockedDetected: requiredBoolean(raw.blockedDetected, "analytics_source_health_blocked_invalid"),
    freshnessSlaMinutes,
    responseContentHash: optionalString(raw.responseContentHash),
    responseBytes: optionalNumber(raw.responseBytes),
    templateVersion: optionalString(raw.templateVersion),
    httpStatus: optionalNumber(raw.httpStatus),
  };
}

function marketScopeVersion(value: unknown): AnalyticsMarketScopeVersion | undefined {
  if (value === undefined) return undefined;
  const raw = recordValue(value);
  const definition = recordValue(raw.definition);
  if (definition.schemaVersion !== "market-scope-v1" || !Array.isArray(definition.sources)) {
    throw new Error("analytics_market_scope_definition_invalid");
  }
  const version = nonNegativeInteger(raw.version, "analytics_market_scope_version_invalid");
  if (version === 0) throw new Error("analytics_market_scope_version_invalid");
  return {
    id: requiredString(raw.id, "analytics_market_scope_id_missing"),
    subscriptionKey: requiredString(raw.subscriptionKey, "analytics_market_scope_subscription_missing"),
    version,
    scopeHash: requiredString(raw.scopeHash, "analytics_market_scope_hash_missing"),
    definition: definition as unknown as AnalyticsMarketScopeVersion["definition"],
    createdAt: requiredString(raw.createdAt, "analytics_market_scope_time_missing"),
  };
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

export function normalizedSnapshotListings(value: unknown): NormalizedListing[] {
  if (!Array.isArray(value)) throw new Error("analytics_listing_snapshot_invalid");
  const candidates = value.map((item) => {
    const record = recordValue(item);
    const { productKey, productMatchMethod, ...listing } = record;
    if (productKey !== undefined && (typeof productKey !== "string" || productKey.length === 0)) {
      throw new Error("analytics_listing_identity_invalid");
    }
    if (productMatchMethod !== undefined
      && !["identifier", "exact_title", "listing_identity"].includes(String(productMatchMethod))) {
      throw new Error("analytics_listing_identity_invalid");
    }
    const facts = optionalRecord(listing.facts);
    const imageUrls = facts?.imageUrls;
    return facts && Array.isArray(imageUrls) && imageUrls.length > 30
      ? { ...listing, facts: { ...facts, imageUrls: imageUrls.slice(0, 30) } }
      : listing;
  });
  const parsed = normalizedListingSchema.array().safeParse(candidates);
  if (!parsed.success) throw new Error("analytics_listing_snapshot_invalid");
  return parsed.data;
}

function analyticsSourceGroup(raw: Record<string, unknown>, expectedSourceId?: string): AnalyticsSourceGroup {
  const sourceId = raw.sourceId;
  const status = raw.status;
  if (typeof sourceId !== "string" || !SOURCE_IDS.includes(sourceId as SourceId) || (expectedSourceId && sourceId !== expectedSourceId)) {
    throw new Error("analytics_source_identity_invalid");
  }
  if (!["success", "empty", "failed", "disabled", "cooldown"].includes(String(status))) {
    throw new Error("analytics_source_status_invalid");
  }
  const parsedListings = normalizedSnapshotListings(raw.listings);
  const rawCandidateEvidence = optionalRecord(raw.candidateEvidence) ?? {};
  const candidateEvidence = Object.fromEntries(parsedListings.flatMap((listing) => {
    const evidence = optionalRecord(rawCandidateEvidence[listing.sourceItemId]);
    return evidence ? [[listing.sourceItemId, evidence] as const] : [];
  }));
  return {
    sourceId,
    status: status as AnalyticsSourceGroup["status"],
    listings: parsedListings.map((listing) => {
      const identity = productIdentity(listing);
      return {
        ...listing,
        productKey: identity?.key ?? `listing:${listing.sourceId}:${listing.sourceItemId}`,
        productMatchMethod: identity?.method ?? "listing_identity",
      };
    }),
    coverage: optionalString(raw.coverage),
    parserVersion: optionalString(raw.parserVersion),
    requestRoute: optionalString(raw.requestRoute),
    durationMs: optionalNumber(raw.durationMs),
    warnings: optionalStrings(raw.warnings),
    requestEvidence: optionalRecord(raw.requestEvidence),
    routeOutcome: optionalRecord(raw.routeOutcome),
    fieldCoverage: optionalRecord(raw.fieldCoverage),
    nextCursor: optionalString(raw.nextCursor),
    totalAvailable: optionalNumber(raw.totalAvailable),
    errorCode: optionalString(raw.errorCode),
    error: optionalString(raw.error)?.slice(0, 500),
    retryAt: optionalString(raw.retryAt),
    health: sourceHealthEvidence(raw.health),
    ...(Object.keys(candidateEvidence).length > 0 ? { candidateEvidence } : {}),
  };
}

function sourceGroup(row: SearchSnapshotRow): AnalyticsSourceGroup {
  return analyticsSourceGroup(parsedRecord(row.group_json), row.source_id);
}

/**
 * 历史索引候选可以显示在手动搜索里，但它不是本轮从来源观察到的新事实。
 * 只有详情页实时复核成功后才允许进入 analytics ingest；否则 ingest_search_run_v3
 * 会错误推进 source_listings.last_seen_at，让旧记录因被搜索而显得“刚刚出现”。
 */
function currentObservationGroup(group: AnalyticsSourceGroup): AnalyticsSourceGroup {
  const listings = group.listings.filter((listing) => {
    const evidence = group.candidateEvidence?.[listing.sourceItemId];
    return evidence?.historical !== true || evidence.liveVerified === true;
  });
  const included = new Set(listings.map((listing) => listing.sourceItemId));
  const candidateEvidence = group.candidateEvidence
    ? Object.fromEntries(Object.entries(group.candidateEvidence).filter(([sourceItemId]) => included.has(sourceItemId)))
    : undefined;
  const { candidateEvidence: _candidateEvidence, ...base } = group;
  return candidateEvidence && Object.keys(candidateEvidence).length > 0
    ? { ...base, listings, candidateEvidence }
    : { ...base, listings };
}

async function loadSourceCaptures(env: AnalyticsEnv, runId: string): Promise<AnalyticsSourceCapture[]> {
  const rows = await env.DB.prepare(
    `SELECT id,source_id,ordinal,request_url,response_url,request_method,response_status,
            content_type,payload_kind,raw_payload,payload_bytes,content_hash,captured_at,
            duration_ms,truncated,error_message
     FROM source_response_captures WHERE run_id=? ORDER BY source_id,ordinal`,
  ).bind(runId).all<SourceCaptureRow>();
  return rows.results.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    ordinal: row.ordinal,
    requestUrl: row.request_url,
    responseUrl: row.response_url ?? undefined,
    requestMethod: row.request_method,
    responseStatus: row.response_status ?? undefined,
    contentType: row.content_type ?? undefined,
    payloadKind: row.payload_kind,
    rawPayload: row.raw_payload ?? undefined,
    payloadBytes: row.payload_bytes,
    contentHash: row.content_hash,
    capturedAt: row.captured_at,
    durationMs: row.duration_ms,
    truncated: row.truncated === 1,
    error: row.error_message ?? undefined,
  }));
}
export function marketSourceHealthEvidence(
  binding: WatchBindingRow,
  result: RoutedMarketResult,
): AnalyticsSourceHealthEvidence {
  const rawResultCount = result.requestEvidence?.rawResultCount ?? result.listings.length;
  const pageDepth = result.requestEvidence?.pagesFetched ?? 1;
  return {
    state: result.listings.length > 0 ? "healthy" : "empty",
    requestSucceeded: true,
    parseSucceeded: true,
    rawResultCount,
    normalizedResultCount: result.listings.length,
    pageDepth,
    cursorTerminationReason: result.nextCursor ? "budget_reached" : "exhausted",
    abnormalEmpty: false,
    fieldTotal: 0,
    fieldComplete: 0,
    captchaDetected: false,
    loginRequired: false,
    blockedDetected: false,
    freshnessSlaMinutes: Math.max(60, effectiveItemIntervalMinutes(binding) * 2),
    templateVersion: result.parserVersion,
  };
}

export function marketAnalyticsRun(
  binding: WatchBindingRow,
  runId: string,
  result: RoutedMarketResult,
  filters: SearchFilters,
  durationMs: number,
  scopeVersion?: AnalyticsMarketScopeVersion,
): AnalyticsSearchRun {
  const isKeyword = binding.kind === "keyword";
  const query = isKeyword
    ? binding.query ?? ""
    : binding.target_url ?? binding.source_item_id ?? binding.id;
  const subscriptionKey = isKeyword ? marketSubscriptionKey(binding.watch_profile_id, query) : undefined;
  const sourceConfig = parsedRecordOrEmpty(binding.source_config_json);
  const targetResult = sourceConfig.searchMode === "exact_product"
    ? productFingerprintSchema.safeParse(sourceConfig.productTarget)
    : undefined;
  const exactPlan = targetResult?.success
    ? buildProductSearchPlan({ query, mode: "exact_product", target: targetResult.data })
    : undefined;
  const primaryVariant = exactPlan?.variants.find((variant) => variant.lane === "source_native");
  const candidateEvidence = exactPlan?.target && primaryVariant
    ? Object.fromEntries(result.listings.map((listing, index) => {
        const hits = [{
          variantId: primaryVariant.id,
          query: primaryVariant.query,
          kind: primaryVariant.kind,
          lane: "source_native" as const,
          upstreamRank: index + 1,
          weight: primaryVariant.weight,
          liveVerified: true,
        }];
        const evidence = searchCandidateEvidence(hits, assessProductMatch(listing, exactPlan.target!, hits));
        return [listing.sourceItemId, recordValue(evidence)] as const;
      }))
    : undefined;
  return {
    id: runId,
    origin: isKeyword ? "watch_keyword" : "watch_item",
    ...(subscriptionKey ? {
      subscriptionKey,
      subscriptionName: binding.profile_name ?? query,
      ...(scopeVersion ? { scopeVersion } : {}),
    } : {}),
    bindingId: binding.id,
    query,
    queryKey: subscriptionKey ?? normalizeAnalyticsQuery(query),
    filters: {
      ...filters,
      monitoringPurpose: binding.monitoring_purpose,
      scheduleIntervalMinutes: binding.schedule_interval_minutes,
      ...(exactPlan?.target ? {
        searchMode: "exact_product",
        target: exactPlan.target,
        searchPlan: exactPlan,
        deepSearch: false,
      } : {}),
    },
    status: result.listings.length > 0 ? "success" : "empty",
    resultCount: result.listings.length,
    searchedAt: result.fetchedAt,
    groups: [{
      sourceId: result.sourceId,
      status: result.listings.length > 0 ? "success" : "empty",
      listings: result.listings.map((listing) => {
        const identity = productIdentity(listing);
        return {
          ...listing,
          productKey: identity?.key ?? `listing:${listing.sourceId}:${listing.sourceItemId}`,
          productMatchMethod: identity?.method ?? "listing_identity",
        };
      }),
      coverage: result.coverage,
      parserVersion: result.parserVersion,
      requestRoute: result.requestRoute,
      warnings: result.warnings,
      requestEvidence: result.requestEvidence,
      routeOutcome: result.routeOutcome,
      nextCursor: result.nextCursor,
      totalAvailable: result.totalAvailable,
      durationMs,
      health: marketSourceHealthEvidence(binding, result),
      ...(candidateEvidence ? { candidateEvidence } : {}),
    }],
  };
}

export function marketAnalyticsFailureRun(
  binding: WatchBindingRow,
  runId: string,
  input: {
    filters?: SearchFilters;
    status: "failed" | "disabled" | "cooldown";
    errorCode: string;
    error: string;
    searchedAt: string;
    durationMs: number;
    parserVersion?: string;
    coverage?: AnalyticsSourceGroup["coverage"];
    httpStatus?: number;
    captchaDetected?: boolean;
    loginRequired?: boolean;
    abnormalEmpty?: boolean;
    scopeVersion?: AnalyticsMarketScopeVersion;
  },
): AnalyticsSearchRun {
  const query = binding.query ?? "";
  const subscriptionKey = marketSubscriptionKey(binding.watch_profile_id, query);
  const suspectedDegradation = input.abnormalEmpty === true
    || isParserFailureCode(input.errorCode);
  const requestSucceeded = input.httpStatus !== undefined
    ? input.httpStatus >= 200 && input.httpStatus < 400
    : suspectedDegradation;
  const state = input.status === "disabled"
    ? "disabled"
    : input.status === "cooldown"
      ? "cooldown"
      : suspectedDegradation ? "suspected_degradation" : "failed";
  return {
    id: runId,
    origin: "watch_keyword",
    subscriptionKey,
    subscriptionName: binding.profile_name ?? query,
    bindingId: binding.id,
    ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
    query,
    queryKey: subscriptionKey,
    filters: {
      ...(input.filters ?? {}),
      monitoringPurpose: binding.monitoring_purpose,
      scheduleIntervalMinutes: binding.schedule_interval_minutes,
    },
    status: "failed",
    resultCount: 0,
    searchedAt: input.searchedAt,
    groups: [{
      sourceId: binding.source_id,
      status: input.status,
      listings: [],
      coverage: input.coverage ?? "unknown",
      parserVersion: input.parserVersion,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
      error: input.error.slice(0, 500),
      health: {
        state,
        requestSucceeded,
        parseSucceeded: false,
        rawResultCount: 0,
        normalizedResultCount: 0,
        pageDepth: requestSucceeded ? 1 : 0,
        cursorTerminationReason: "unknown",
        abnormalEmpty: input.abnormalEmpty === true,
        fieldTotal: 0,
        fieldComplete: 0,
        captchaDetected: input.captchaDetected === true,
        loginRequired: input.loginRequired === true,
        blockedDetected: input.status === "failed" && (
          input.httpStatus === 403 || input.captchaDetected === true || input.loginRequired === true
        ),
        freshnessSlaMinutes: Math.max(60, binding.schedule_interval_minutes * 2),
        templateVersion: input.parserVersion,
        httpStatus: input.httpStatus,
      },
    }],
  };
}

export function marketAnalyticsOutboxStatement(
  db: OperationalDatabase,
  outboxId: string,
  run: AnalyticsSearchRun,
  createdAt: string,
): OperationalPreparedStatement {
  return db.prepare(
    `INSERT INTO analytics_outbox(id,kind,reference_id,payload_json,status,created_at,updated_at)
     VALUES(?,'watch_market',?,?,'pending',?,?)
     ON CONFLICT(kind,reference_id) DO NOTHING`,
  ).bind(outboxId, run.id, JSON.stringify(run), createdAt, createdAt);
}

export function manualAnalyticsOutboxStatement(
  db: OperationalDatabase,
  outboxId: string,
  historyId: string,
  createdAt: string,
): OperationalPreparedStatement {
  return db.prepare(
    `INSERT INTO analytics_outbox(id,kind,reference_id,payload_json,status,created_at,updated_at)
     VALUES(?,'preview_search',?,NULL,'pending',?,?)
     ON CONFLICT(kind,reference_id) DO NOTHING`,
  ).bind(outboxId, historyId, createdAt, createdAt);
}

async function markOutboxPending(env: AnalyticsEnv, outboxId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "analytics_enqueue_failed";
  await env.DB.prepare(
    `UPDATE analytics_outbox SET status='pending',last_error=?,updated_at=?
     WHERE id=? AND status NOT IN ('succeeded','skipped') AND attempts<?`,
  ).bind(message.slice(0, 500), new Date().toISOString(), outboxId, ANALYTICS_OUTBOX_MAX_ATTEMPTS).run();
}

export async function enqueueAnalyticsOutbox(env: AnalyticsEnv, outboxId: string): Promise<boolean> {
  const queuedAt = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE analytics_outbox SET status='queued',queued_at=?,updated_at=?,last_error=NULL
     WHERE id=? AND status NOT IN ('succeeded','skipped') AND attempts<?`,
  ).bind(queuedAt, queuedAt, outboxId, ANALYTICS_OUTBOX_MAX_ATTEMPTS).run();
  if (claimed.meta.changes !== 1) return false;
  try {
    await env.MONITOR_QUEUE.send({
      type: "ingest_analytics",
      idempotencyKey: `ingest_analytics:${outboxId}`,
      outboxId,
      queuedAt,
    } satisfies IngestAnalyticsJob);
    return true;
  } catch (error) {
    await markOutboxPending(env, outboxId, error);
    return false;
  }
}
export async function enqueuePendingAnalytics(env: AnalyticsEnv, limit = 100): Promise<number> {
  const staleQueuedAt = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  const failedRetryAt = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  // 卡在 processing 的行（isolate 在最后一次重试中被杀）也必须能被重新驱动，
  // 否则该行永远丢失且无任何告警。
  const staleProcessingAt = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  const terminalizedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE analytics_outbox
     SET status='skipped',processed_at=?,updated_at=?,
         last_error='retry_exhausted:' || COALESCE(last_error,'unknown')
     WHERE status NOT IN ('succeeded','skipped') AND attempts>=?`,
  ).bind(terminalizedAt, terminalizedAt, ANALYTICS_OUTBOX_MAX_ATTEMPTS).run();
  const pending = await env.DB.prepare(
    `SELECT id FROM analytics_outbox
     WHERE attempts<?
       AND (status='pending'
        OR (status='failed' AND updated_at<?)
        OR (status='queued' AND queued_at<?)
        OR (status='processing' AND updated_at<?))
     ORDER BY CASE kind
       WHEN 'ai_enrichment' THEN 0
       WHEN 'watch_market' THEN 1
       WHEN 'preview_search' THEN 2
       ELSE 3 END,
       created_at ASC LIMIT ?`,
  ).bind(
    ANALYTICS_OUTBOX_MAX_ATTEMPTS,
    failedRetryAt,
    staleQueuedAt,
    staleProcessingAt,
    Math.max(1, Math.min(limit, 100)),
  ).all<{ id: string }>();
  let queued = 0;
  for (const row of pending.results) {
    if (await enqueueAnalyticsOutbox(env, row.id)) queued += 1;
  }
  return queued;
}

export async function markAnalyticsOutboxDeadLettered(
  env: Pick<AnalyticsEnv, "DB">,
  outboxId: string,
  deadLetterQueueName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE analytics_outbox
     SET status='skipped',processed_at=?,updated_at=?,last_error=?
     WHERE id=? AND status NOT IN ('succeeded','skipped')`,
  ).bind(now, now, `queue_dead_lettered:${deadLetterQueueName}`.slice(0, 500), outboxId).run();
}

export async function aiEnrichmentPersistenceResponse(
  request: Request,
  env: AnalyticsEnv,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = aiEnrichmentPersistenceSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_ai_enrichment", issues: parsed.error.issues }, { status: 400 });
  }
  const scheduled = await enqueueAiEnrichmentPayload(env, parsed.data);
  return Response.json({ accepted: true, ...scheduled }, { status: 202 });
}

export async function enqueueAiEnrichmentPayload(
  env: AnalyticsEnv,
  payload: unknown,
): Promise<{ queued: boolean; batchId: string }> {
  const data = aiEnrichmentPersistenceSchema.parse(payload);
  const existing = await env.DB.prepare(
    `SELECT id,status FROM analytics_outbox WHERE kind='ai_enrichment' AND reference_id=?`,
  ).bind(data.batchId).first<{ id: string; status: AnalyticsOutboxRow["status"] }>();
  const outboxId = existing?.id ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO analytics_outbox(id,kind,reference_id,payload_json,status,created_at,updated_at)
       VALUES(?,'ai_enrichment',?,?,'pending',?,?)`,
    ).bind(outboxId, data.batchId, JSON.stringify(data), createdAt, createdAt).run();
  }
  const queued = existing?.status === "succeeded" || await enqueueAnalyticsOutbox(env, outboxId);
  return { queued, batchId: data.batchId };
}

export async function latestAiEnrichmentResponse(request: Request, env: AnalyticsEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = aiEnrichmentLookupRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_ai_lookup", issues: parsed.error.issues }, { status: 400 });
  const items = await readLatestAiListingSemantics(
    env.ANALYTICS_DB.connectionString,
    parsed.data.items,
    parsed.data.model,
    parsed.data.promptVersion,
  );
  return Response.json({ items });
}

async function loadManualSearchRun(env: AnalyticsEnv, historyId: string): Promise<AnalyticsSearchRun> {
  const [history, snapshots] = await Promise.all([
    env.DB.prepare(
      `SELECT id,query,filters_json,search_mode,target_json,plan_json,deep_search,
              status,result_count,searched_at
       FROM search_history WHERE id=?`,
    ).bind(historyId).first<SearchHistoryRow>(),
    env.DB.prepare(
      `SELECT source_id,group_json FROM search_result_snapshots WHERE search_history_id=? ORDER BY source_id`,
    ).bind(historyId).all<SearchSnapshotRow>(),
  ]);
  if (!history) throw new Error("analytics_search_history_missing");
  if (snapshots.results.length === 0) throw new Error("analytics_search_snapshots_missing");
  const target = history.target_json ? parsedRecord(history.target_json) : undefined;
  const plan = history.plan_json ? parsedRecord(history.plan_json) : undefined;
  const groups = snapshots.results.map(sourceGroup).map(currentObservationGroup);
  return {
    id: history.id,
    origin: "manual_search",
    query: history.query,
    queryKey: normalizeAnalyticsQuery(history.query),
    filters: {
      ...parsedRecord(history.filters_json),
      searchMode: history.search_mode,
      deepSearch: history.deep_search === 1,
      ...(target ? { target } : {}),
      ...(plan ? { searchPlan: plan } : {}),
    },
    status: history.status,
    resultCount: groups.reduce((total, group) => total + group.listings.length, 0),
    searchedAt: history.searched_at,
    groups,
  };
}

async function loadOperationalListingBundle(
  env: AnalyticsEnv,
  listingId: string,
): Promise<OperationalListingBundle> {
  const [row, snapshots] = await Promise.all([
    env.DB.prepare(
      `SELECT id,source_id,source_item_id,identity_scope,canonical_url,title,description_excerpt,
              image_url,seller_name,shop_name,currency,current_price,original_price,price_basis,
              item_condition,availability,source_listed_at,source_updated_at,last_seen_at,
              raw_metadata_json,product_facts_json
       FROM listings WHERE id=?`,
    ).bind(listingId).first<OperationalListingRow>(),
    env.DB.prepare(
      `SELECT id,watch_binding_id,price,original_price,price_basis,currency,availability,item_condition,
              state_hash,observed_at,content_hash,product_facts_json
       FROM listing_snapshots WHERE listing_id=? ORDER BY observed_at ASC`,
    ).bind(listingId).all<OperationalSnapshotRow>(),
  ]);
  if (!row) throw new Error("analytics_listing_backfill_missing");
  const candidate = {
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    identityScope: row.identity_scope,
    canonicalUrl: row.canonical_url,
    title: row.title,
    descriptionExcerpt: row.description_excerpt ?? undefined,
    imageUrl: row.image_url ?? undefined,
    sellerName: row.seller_name ?? undefined,
    shopName: row.shop_name ?? undefined,
    currency: row.currency,
    currentPrice: row.current_price ?? undefined,
    originalPrice: row.original_price ?? undefined,
    priceBasis: row.price_basis,
    condition: row.item_condition,
    availability: row.availability,
    sourceListedAt: row.source_listed_at ?? undefined,
    sourceUpdatedAt: row.source_updated_at ?? undefined,
    facts: parsedRecordOrEmpty(row.product_facts_json),
    rawMetadata: parsedRecordOrEmpty(row.raw_metadata_json),
  };
  const parsed = normalizedListingSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("analytics_listing_backfill_invalid");
  return {
    listing: parsed.data,
    observedAt: row.last_seen_at,
    snapshots: snapshots.results.map((snapshot) => ({
      id: snapshot.id,
      watchBindingId: snapshot.watch_binding_id ?? undefined,
      price: snapshot.price ?? undefined,
      originalPrice: snapshot.original_price ?? undefined,
      priceBasis: snapshot.price_basis ?? undefined,
      currency: snapshot.currency,
      availability: snapshot.availability,
      condition: snapshot.item_condition,
      stateHash: snapshot.state_hash ?? undefined,
      observedAt: snapshot.observed_at,
      contentHash: snapshot.content_hash ?? undefined,
      facts: parsedRecordOrEmpty(snapshot.product_facts_json),
    })),
  };
}

function parseAiEnrichmentPayload(payloadJson: string) {
  const parsed = aiEnrichmentPersistenceSchema.safeParse(JSON.parse(payloadJson) as unknown);
  if (!parsed.success) throw new Error("analytics_ai_enrichment_payload_invalid");
  return parsed.data;
}

function parseProductIdentityPayload(payloadJson: string): ProductIdentityProjection {
  const raw = parsedRecord(payloadJson);
  const canonical = recordValue(raw.canonicalProduct);
  const variant = recordValue(raw.productVariant);
  const profile = recordValue(raw.comparisonProfile);
  if (
    !requiredString(raw.projectionId, "product_identity_projection_id_missing").startsWith("pip_")
    || !requiredString(raw.projectionHash, "product_identity_projection_hash_missing").match(/^[0-9a-f]{64}$/u)
    || !requiredString(raw.workflowTaskId, "product_identity_workflow_missing")
    || !requiredString(raw.searchHistoryId, "product_identity_history_missing")
    || !requiredString(canonical.id, "product_identity_canonical_missing").startsWith("cp_")
    || !requiredString(variant.id, "product_identity_variant_missing").startsWith("pv_")
    || !requiredString(profile.id, "product_identity_profile_missing").startsWith("cmp_")
    || !Array.isArray(raw.memberships)
  ) {
    throw new Error("analytics_product_identity_payload_invalid");
  }
  // Outbox replay must obey the same target checks as fresh projections.
  for (const identity of [canonical, variant]) {
    const target = productFingerprintSchema.safeParse(identity.targetFingerprint);
    if (!target.success || productFingerprintNameConflicts(target.data).length > 0) {
      throw new Error("analytics_product_identity_target_conflict");
    }
  }
  return raw as unknown as ProductIdentityProjection;
}

export function parseMarketAnalyticsRun(payloadJson: string): AnalyticsSearchRun {
  const raw = parsedRecord(payloadJson);
  if (raw.origin !== "watch_keyword" && raw.origin !== "watch_item") throw new Error("analytics_market_origin_invalid");
  const origin = raw.origin;
  const status = requiredString(raw.status, "analytics_market_status_missing");
  if (!["success", "partial", "empty", "failed"].includes(status)) throw new Error("analytics_market_status_invalid");
  if (!Array.isArray(raw.groups)) throw new Error("analytics_market_groups_invalid");
  const searchedAt = requiredString(raw.searchedAt, "analytics_market_time_missing");
  if (!Number.isFinite(Date.parse(searchedAt))) throw new Error("analytics_market_time_invalid");
  const resultCount = raw.resultCount;
  if (!Number.isInteger(resultCount) || Number(resultCount) < 0) throw new Error("analytics_market_count_invalid");
  const scopeVersion = marketScopeVersion(raw.scopeVersion);
  const subscriptionKey = origin === "watch_keyword"
    ? requiredString(raw.subscriptionKey, "analytics_market_subscription_missing")
    : undefined;
  if (scopeVersion && scopeVersion.subscriptionKey !== subscriptionKey) {
    throw new Error("analytics_market_scope_subscription_mismatch");
  }
  return {
    id: requiredString(raw.id, "analytics_market_id_missing"),
    origin,
    query: requiredString(raw.query, "analytics_market_query_missing"),
    queryKey: requiredString(raw.queryKey, "analytics_market_query_key_missing"),
    ...(origin === "watch_keyword" ? {
      subscriptionKey: subscriptionKey!,
      subscriptionName: requiredString(raw.subscriptionName, "analytics_market_subscription_name_missing"),
      ...(scopeVersion ? { scopeVersion } : {}),
    } : {}),
    bindingId: requiredString(raw.bindingId, "analytics_market_binding_missing"),
    filters: recordValue(raw.filters),
    status: status as AnalyticsSearchRun["status"],
    resultCount: Number(resultCount),
    searchedAt,
    groups: raw.groups.map((group) => analyticsSourceGroup(recordValue(group))),
  };
}

export async function ingestAnalyticsOutbox(env: AnalyticsEnv, job: IngestAnalyticsJob): Promise<void> {
  const outbox = await env.DB.prepare(
    `SELECT id,kind,reference_id,payload_json,status,attempts FROM analytics_outbox WHERE id=?`,
  ).bind(job.outboxId).first<AnalyticsOutboxRow>();
  if (!outbox || outbox.status === "succeeded" || outbox.status === "skipped") return;
  if (outbox.attempts >= ANALYTICS_OUTBOX_MAX_ATTEMPTS) {
    const terminalizedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE analytics_outbox
       SET status='skipped',processed_at=?,updated_at=?,
           last_error='retry_exhausted:' || COALESCE(last_error,'unknown')
       WHERE id=? AND status NOT IN ('succeeded','skipped')`,
    ).bind(terminalizedAt, terminalizedAt, outbox.id).run();
    return;
  }
  const processingAt = new Date().toISOString();
  const processingLeaseCutoff = new Date(
    Date.now() - ANALYTICS_OUTBOX_PROCESSING_LEASE_MS,
  ).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE analytics_outbox SET status='processing',attempts=attempts+1,updated_at=?
     WHERE id=? AND attempts<?
       AND (
         status IN ('pending','queued','failed')
         OR (status='processing' AND updated_at<?)
       )`,
  ).bind(
    processingAt,
    outbox.id,
    ANALYTICS_OUTBOX_MAX_ATTEMPTS,
    processingLeaseCutoff,
  ).run();
  if (claimed.meta.changes !== 1) {
    const current = await env.DB.prepare(
      "SELECT status FROM analytics_outbox WHERE id=?",
    ).bind(outbox.id).first<{ status: AnalyticsOutboxRow["status"] }>();
    if (!current || current.status === "succeeded" || current.status === "skipped") return;
    // Do not let the outer Queue receipt become completed while this outbox row
    // is still owned by another delivery. A later redelivery can reclaim it
    // after the lease if the first isolate dies.
    throw new Error("analytics_outbox_claim_busy");
  }
  try {
    if (outbox.kind === "ai_enrichment") {
      await ingestAnalyticsAiProcessingBatch(
        env.ANALYTICS_DB.connectionString,
        parseAiEnrichmentPayload(requiredString(outbox.payload_json, "analytics_ai_enrichment_payload_missing")),
      );
    } else if (outbox.kind === "product_identity") {
      await ingestProductIdentityProjection(
        env.ANALYTICS_DB.connectionString,
        parseProductIdentityPayload(requiredString(outbox.payload_json, "analytics_product_identity_payload_missing")),
      );
    } else if (outbox.kind === "listing_backfill") {
      await ingestOperationalListingBundle(
        env.ANALYTICS_DB.connectionString,
        await loadOperationalListingBundle(env, outbox.reference_id),
      );
    } else {
      const baseRun = outbox.kind === "watch_market"
        ? parseMarketAnalyticsRun(requiredString(outbox.payload_json, "analytics_market_payload_missing"))
        : await loadManualSearchRun(env, outbox.reference_id);
      const run = { ...baseRun, captures: await loadSourceCaptures(env, baseRun.id) };
      await ingestAnalyticsSearchRun(env.ANALYTICS_DB.connectionString, run);
    }
    const processedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE analytics_outbox SET status='succeeded',processed_at=?,updated_at=?,last_error=NULL WHERE id=?`,
    ).bind(processedAt, processedAt, outbox.id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "analytics_ingest_failed";
    if (message === "analytics_search_snapshots_missing" || message === "analytics_listing_backfill_missing") {
      const processedAt = new Date().toISOString();
      const reason = message === "analytics_search_snapshots_missing" ? "snapshot_not_available" : "listing_not_available";
      await env.DB.prepare(
        `UPDATE analytics_outbox SET status='skipped',processed_at=?,last_error=?,updated_at=? WHERE id=?`,
      ).bind(processedAt, reason, processedAt, outbox.id).run();
      return;
    }
    await env.DB.prepare(
      `UPDATE analytics_outbox SET status='failed',last_error=?,updated_at=? WHERE id=?`,
    ).bind(message.slice(0, 500), new Date().toISOString(), outbox.id).run();
    throw error;
  }
}
