import type { QueryResultRow } from "pg";
import type {
  AnalyticsAiEnrichmentRecord,
  AnalyticsAiProcessingBatch,
  AnalyticsAiLookup,
  AnalyticsAiLookupResult,
  AnalyticsHistoricalListing,
  AnalyticsDiscoveryListing,
  AnalyticsOverview,
  AnalyticsSearchRun,
  AnalyticsSourceMetric,
  AnalyticsSubscriptionSnapshot,
  AnalyticsSummary,
  AnalyticsTrendPoint,
  MarketCleaningCandidate,
  MarketAnalysisDailyMetric,
  MarketAnalysisEvidence,
  OperationalListingBundle,
  ProductIdentityProjection,
} from "./types";

export * from "./types";

interface QueryResultLike<Row extends QueryResultRow> {
  rows: Row[];
}

export interface AnalyticsQueryClient {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResultLike<Row>>;
}

export function normalizeAnalyticsQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ja-JP");
}

export function marketSubscriptionKey(profileId: string, query: string): string {
  return `market:${profileId}:${normalizeAnalyticsQuery(query)}`;
}

async function withRuntimeClient<T>(connectionString: string, operation: (client: AnalyticsQueryClient) => Promise<T>): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE radar_analytics_runtime");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export interface ProductIdentityResolutionTarget extends Record<string, unknown> {
  canonicalName: string;
}

export interface ResolvedProductIdentity {
  canonicalProductId: string;
  canonicalHash: string;
  productVariantId: string;
  variantHash: string;
  identityVersion: string;
}

export interface ProductIdentityResolutionCandidate extends QueryResultRow {
  canonical_product_id: string;
  canonical_hash: string;
  variant_id: string;
  variant_hash: string;
  identity_version: string;
  canonical_name: string;
  target_fingerprint: Record<string, unknown>;
  updated_at: string;
  current_confirmed_count: number | string;
}

function normalizedResolutionValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? normalizeAnalyticsQuery(value)
    : undefined;
}

function normalizedResolutionField(field: string, value: unknown): string | undefined {
  const normalized = normalizedResolutionValue(value);
  if (!normalized) return undefined;
  if (field === "jan") return normalized.replace(/[\s-]/gu, "");
  if (field === "size") return normalized.replace(/ユニセックス|サイズ|\s/gu, "");
  if (field === "workTitle") return normalized.replace(/[\s:・･._\-‐‑‒–—―「」『』]/gu, "");
  return normalized;
}

function identityResolutionConflicts(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): string[] {
  const conflicts: string[] = [];
  for (const field of ["jan", "model", "workTitle", "productType", "size", "color"]) {
    const left = normalizedResolutionField(field, previous[field]);
    const right = normalizedResolutionField(field, incoming[field]);
    if (!left || !right || left === right) continue;
    // Legacy name parsers sometimes stored the generic category as the work.
    // It is missing identity evidence, not an authoritative conflicting work.
    if (field === "workTitle" && (
      left === normalizedResolutionField(field, previous.productType)
      || right === normalizedResolutionField(field, incoming.productType)
    )) continue;
    // A longer category label may merely qualify the same category.
    if (field === "productType" && (left.includes(right) || right.includes(left))) continue;
    conflicts.push(field);
  }
  return conflicts;
}

function identityResolutionCompatibility(
  candidate: ProductIdentityResolutionCandidate,
  target: ProductIdentityResolutionTarget,
): number {
  const weights: Record<string, number> = {
    jan: 100,
    model: 80,
    productType: 18,
    workTitle: 12,
    manufacturer: 12,
    series: 10,
    size: 10,
    color: 10,
  };
  let score = 0;
  for (const [field, weight] of Object.entries(weights)) {
    const left = normalizedResolutionField(field, candidate.target_fingerprint[field]);
    const right = normalizedResolutionField(field, target[field]);
    if (!left || !right) continue;
    score += left === right ? weight : -weight;
  }
  const candidateCharacters = Array.isArray(candidate.target_fingerprint.characters)
    ? candidate.target_fingerprint.characters.map(normalizedResolutionValue).filter((value): value is string => Boolean(value))
    : [];
  const targetCharacters = Array.isArray(target.characters)
    ? target.characters.map(normalizedResolutionValue).filter((value): value is string => Boolean(value))
    : [];
  if (candidateCharacters.length > 0 && targetCharacters.length > 0) {
    score += candidateCharacters.some((value) => targetCharacters.includes(value)) ? 24 : -24;
  }
  return score;
}

export function selectProductIdentityResolutionCandidate(
  candidates: readonly ProductIdentityResolutionCandidate[],
  target: ProductIdentityResolutionTarget,
): ProductIdentityResolutionCandidate | undefined {
  const normalizedName = normalizeAnalyticsQuery(target.canonicalName);
  const ranked = candidates
    .filter((candidate) => normalizeAnalyticsQuery(candidate.canonical_name) === normalizedName)
    .filter((candidate) => identityResolutionConflicts(candidate.target_fingerprint, target).length === 0)
    .map((candidate) => ({ candidate, score: identityResolutionCompatibility(candidate, target) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  // Recency and membership volume are not identity evidence. Require at least
  // one smallest weighted field (10 points) to separate competing variants.
  if (!best || (ranked[1] && best.score - ranked[1].score < 10)) return undefined;
  return best.candidate;
}

export async function resolveProductIdentityByCanonicalName(
  connectionString: string,
  target: ProductIdentityResolutionTarget,
): Promise<ResolvedProductIdentity | undefined> {
  if (!normalizeAnalyticsQuery(target.canonicalName)) return undefined;
  return withRuntimeClient(connectionString, async (client) => {
    const result = await client.query<ProductIdentityResolutionCandidate>(
      `SELECT
         canonical.id AS canonical_product_id,
         canonical.identity_hash AS canonical_hash,
         variant.id AS variant_id,
         variant.identity_hash AS variant_hash,
         variant.identity_version,
         COALESCE(variant.target_fingerprint ->> 'canonicalName',variant.variant_name) AS canonical_name,
         variant.target_fingerprint,
         variant.updated_at::text,
         (
           SELECT count(*)::int
           FROM radar_analytics.product_listing_memberships AS membership
           WHERE membership.product_variant_id=variant.id
             AND membership.is_current
             AND membership.decision='confirmed'
         ) AS current_confirmed_count
       FROM radar_analytics.product_variants AS variant
       JOIN radar_analytics.canonical_products AS canonical
         ON canonical.id=variant.canonical_product_id
       ORDER BY variant.updated_at DESC,variant.id
       LIMIT 500`,
    );
    const candidate = selectProductIdentityResolutionCandidate(result.rows, target);
    return candidate ? {
      canonicalProductId: candidate.canonical_product_id,
      canonicalHash: candidate.canonical_hash,
      productVariantId: candidate.variant_id,
      variantHash: candidate.variant_hash,
      identityVersion: candidate.identity_version,
    } : undefined;
  });
}

export async function ingestAnalyticsSearchRun(connectionString: string, run: AnalyticsSearchRun): Promise<void> {
  await withRuntimeClient(connectionString, async (client) => {
    await client.query("SELECT radar_analytics.ingest_search_run_v3($1::jsonb)", [JSON.stringify(run)]);
    if (run.filters.searchMode === "exact_product") {
      await client.query("SELECT radar_analytics.ingest_search_product_relations($1::jsonb)", [JSON.stringify(run)]);
    }
    if ((run.captures?.length ?? 0) > 0) {
      await client.query("SELECT radar_analytics.ingest_source_response_captures($1::jsonb)", [JSON.stringify(run)]);
    }
    if (run.origin === "watch_keyword") {
      if (!run.subscriptionKey || !run.subscriptionName || !run.bindingId) {
        throw new Error("market_subscription_identity_required");
      }
      await client.query(
        `UPDATE radar_analytics.search_runs
         SET subscription_key=$2,subscription_name=$3,binding_id=$4
         WHERE id=$1::uuid AND origin='watch_keyword'`,
        [run.id, run.subscriptionKey, run.subscriptionName, run.bindingId],
      );
    }
  });
}

export async function ingestOperationalListingBundle(
  connectionString: string,
  bundle: OperationalListingBundle,
): Promise<void> {
  await withRuntimeClient(connectionString, async (client) => {
    await client.query(
      "SELECT radar_analytics.ingest_operational_listing_bundle($1::jsonb)",
      [JSON.stringify(bundle)],
    );
  });
}

export async function ingestAnalyticsAiEnrichments(
  connectionString: string,
  records: readonly AnalyticsAiEnrichmentRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await withRuntimeClient(connectionString, async (client) => {
    await client.query(
      "SELECT radar_analytics.ingest_ai_enrichments($1::jsonb)",
      [JSON.stringify({ records })],
    );
  });
}

export async function ingestAnalyticsAiProcessingBatch(
  connectionString: string,
  payload: AnalyticsAiProcessingBatch,
): Promise<void> {
  await withRuntimeClient(connectionString, async (client) => {
    await client.query(
      "SELECT radar_analytics.ingest_ai_processing_batch($1::jsonb)",
      [JSON.stringify(payload)],
    );
  });
}

export async function ingestProductIdentityProjection(
  connectionString: string,
  projection: ProductIdentityProjection,
): Promise<void> {
  await withRuntimeClient(connectionString, async (client) => {
    // Resolution and outbox ingestion happen at different times. Serialize
    // writes to these identities and recheck the latest fingerprints before
    // allowing the SQL projection to replace descriptive fields.
    for (const id of [projection.canonicalProduct.id, projection.productVariant.id].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [id]);
    }
    const canonical = await client.query<{ target_fingerprint: Record<string, unknown> } & QueryResultRow>(
      "SELECT target_fingerprint FROM radar_analytics.canonical_products WHERE id=$1 FOR UPDATE",
      [projection.canonicalProduct.id],
    );
    const variant = await client.query<{ target_fingerprint: Record<string, unknown> } & QueryResultRow>(
      "SELECT target_fingerprint FROM radar_analytics.product_variants WHERE id=$1 FOR UPDATE",
      [projection.productVariant.id],
    );
    for (const [rows, incoming] of [
      [canonical.rows, projection.canonicalProduct.targetFingerprint],
      [variant.rows, projection.productVariant.targetFingerprint],
    ] as const) {
      for (const { target_fingerprint: previous } of rows) {
        const conflicts = identityResolutionConflicts(previous, incoming);
        const previousName = normalizedResolutionValue(previous.canonicalName);
        const incomingName = normalizedResolutionValue(incoming.canonicalName);
        if (previousName && incomingName && previousName !== incomingName) conflicts.push("canonicalName");
        if (conflicts.length > 0) throw new Error(`product_identity_projection_conflict:${conflicts.join(",")}`);
      }
    }
    if (projection.workflowTaskId.startsWith("watch:")) {
      const dependencies = await client.query<{
        run_exists: boolean;
        resolved_count: number | string;
      } & QueryResultRow>(
        `SELECT
           EXISTS(
             SELECT 1 FROM radar_analytics.search_runs
             WHERE id=$2::uuid
           ) AS run_exists,
           (
             SELECT count(*)::int
             FROM jsonb_to_recordset($1::jsonb)
               AS membership("sourceId" text,"sourceItemId" text)
             JOIN radar_analytics.source_listings AS listing
               ON listing.source_id=membership."sourceId"
              AND listing.source_item_id=membership."sourceItemId"
           ) AS resolved_count`,
        [JSON.stringify(projection.memberships), projection.searchHistoryId],
      );
      const dependency = dependencies.rows[0];
      if (!dependency?.run_exists
          || Number(dependency.resolved_count) !== projection.memberships.length) {
        throw new Error("analytics_watch_identity_dependencies_pending");
      }
    }
    await client.query(
      "SELECT radar_analytics.ingest_product_identity_projection($1::jsonb)",
      [JSON.stringify(projection)],
    );
  });
}

interface AiLookupRow extends QueryResultRow {
  source_id: string;
  source_item_id: string;
  input_hash: string;
  output: Record<string, unknown>;
  created_at: string | Date;
}

export async function readLatestAiListingSemantics(
  connectionString: string,
  lookups: readonly AnalyticsAiLookup[],
  model: string,
  promptVersion: string,
): Promise<AnalyticsAiLookupResult[]> {
  if (lookups.length === 0) return [];
  return withRuntimeClient(connectionString, async (client) => {
    const result = await client.query<AiLookupRow>(
      `WITH requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS item("sourceId" text,"sourceItemId" text,"inputHash" text)
       )
       SELECT DISTINCT ON (listing.source_id,listing.source_item_id,requested."inputHash")
              listing.source_id,listing.source_item_id,enrichment.input_hash,
              enrichment.output,enrichment.created_at
       FROM requested
       JOIN radar_analytics.source_listings AS listing
         ON listing.source_id=requested."sourceId"
        AND listing.source_item_id=requested."sourceItemId"
       JOIN radar_analytics.ai_enrichments AS enrichment
         ON enrichment.source_listing_id=listing.id
        AND enrichment.purpose='listing_semantics'
        AND enrichment.model=$2
        AND enrichment.prompt_version=$3
        AND enrichment.input_hash=requested."inputHash"
       ORDER BY listing.source_id,listing.source_item_id,requested."inputHash",enrichment.created_at DESC,enrichment.id DESC`,
      [JSON.stringify(lookups), model, promptVersion],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      inputHash: row.input_hash,
      output: row.output,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  });
}

interface ListingSemanticsRow extends QueryResultRow {
  source_id: string;
  source_item_id: string;
  output: Record<string, unknown>;
}

/**
 * 每件商品最近一次的 listing_semantics 输出，不限模型与提示词版本。
 * 用途只是给原価接口拼短查询（作品 + 角色 + 品类 + 版本），拿到哪一版都比没有强。
 */
export async function readListingSemanticsByItem(
  connectionString: string,
  items: readonly { sourceId: string; sourceItemId: string }[],
): Promise<{ sourceId: string; sourceItemId: string; output: Record<string, unknown> }[]> {
  if (items.length === 0) return [];
  return withRuntimeClient(connectionString, async (client) => {
    const result = await client.query<ListingSemanticsRow>(
      `WITH requested AS (
         SELECT DISTINCT * FROM jsonb_to_recordset($1::jsonb) AS item("sourceId" text,"sourceItemId" text)
       )
       SELECT listing.source_id,listing.source_item_id,latest.output
       FROM requested
       JOIN radar_analytics.source_listings AS listing
         ON listing.source_id=requested."sourceId"
        AND listing.source_item_id=requested."sourceItemId"
       JOIN LATERAL (
         SELECT enrichment.output FROM radar_analytics.ai_enrichments AS enrichment
         WHERE enrichment.source_listing_id=listing.id AND enrichment.purpose='listing_semantics'
         ORDER BY enrichment.created_at DESC,enrichment.id DESC LIMIT 1
       ) AS latest ON true`,
      [JSON.stringify(items)],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      output: row.output,
    }));
  });
}

interface SummaryRow extends QueryResultRow {
  run_count: number;
  subscription_count: number;
  observed_listings: number;
  visible_listings: number;
  new_listings: number;
  left_visible_window: number;
}

interface TrendRow extends QueryResultRow {
  day: string;
  source_id: string | null;
  subscription_key: string;
  subscription_name: string;
  query: string;
  visible_count: number;
  new_count: number;
  left_visible_window: number;
  run_count: number;
  source_count: number;
  available_count: number;
  sold_out_count: number;
  priced_count: number;
  min_price_jpy: number | null;
  median_price_jpy: number | null;
  average_price_jpy: number | null;
  max_price_jpy: number | null;
  scope_version_id: string;
  scope_version: number;
  quality_grade: "A" | "B" | "C" | "D";
  interpretable: boolean;
  warmup: boolean;
  expected_source_count: number;
  successful_source_count: number;
  failed_source_count: number;
  stale_source_count: number;
  coverage_rate: number;
}

interface SubscriptionRow extends TrendRow {
  previous_visible: number | null;
  latest_day: string;
}

interface SourceMetricRow extends QueryResultRow {
  subscription_key: string;
  source_id: string;
  run_count: number;
  successful_runs: number;
  result_count: number;
  average_duration_ms: number | null;
  request_success_rate: number;
  parse_success_rate: number;
  abnormal_empty_runs: number;
  latest_state: string;
  latest_observed_at: string | Date | null;
  freshness_sla_minutes: number | null;
  fresh: boolean;
}

interface DiscoveryRow extends QueryResultRow {
  source_id: string;
  source_item_id: string;
  title: string;
  canonical_url: string;
  image_url: string | null;
  current_price_jpy: number | null;
  item_condition: string;
  availability: string;
  first_seen_at: string | Date;
  relevance: "relevant" | "uncertain";
  confidence: "high" | "medium" | "low";
  market_category: string | null;
  official_status: string | null;
}

function numeric(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumeric(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : numeric(value);
}

function trend(row: TrendRow): AnalyticsTrendPoint {
  return {
    day: row.day,
    sourceId: row.source_id,
    subscriptionKey: row.subscription_key,
    subscriptionName: row.subscription_name,
    query: row.query,
    visibleCount: numeric(row.visible_count),
    newCount: numeric(row.new_count),
    leftVisibleWindow: numeric(row.left_visible_window),
    runCount: numeric(row.run_count),
    sourceCount: numeric(row.source_count),
    availableCount: numeric(row.available_count),
    soldOutCount: numeric(row.sold_out_count),
    pricedCount: numeric(row.priced_count),
    minPrice: nullableNumeric(row.min_price_jpy),
    medianPrice: nullableNumeric(row.median_price_jpy),
    averagePrice: nullableNumeric(row.average_price_jpy),
    maxPrice: nullableNumeric(row.max_price_jpy),
    scopeVersionId: row.scope_version_id,
    scopeVersion: numeric(row.scope_version),
    qualityGrade: row.quality_grade,
    interpretable: row.interpretable,
    warmup: row.warmup,
    expectedSourceCount: numeric(row.expected_source_count),
    successfulSourceCount: numeric(row.successful_source_count),
    failedSourceCount: numeric(row.failed_source_count),
    staleSourceCount: numeric(row.stale_source_count),
    coverageRate: numeric(row.coverage_rate),
  };
}

export async function readAnalyticsOverview(
  client: AnalyticsQueryClient,
  input: { days: number; subscriptionKey?: string; sourceId?: string },
): Promise<AnalyticsOverview> {
  const days = Math.max(1, Math.min(Math.trunc(input.days), 365));
  const subscriptionKey = input.subscriptionKey?.trim() || "";
  const sourceId = input.sourceId?.trim() || "";
  const values = [days, subscriptionKey, sourceId];

  const summaryResult = await client.query<SummaryRow>(
    `WITH latest_scopes AS (
       SELECT DISTINCT ON (subscription_key) id,subscription_key
       FROM radar_analytics.market_scope_versions ORDER BY subscription_key,version DESC
     ), filtered_runs AS (
       SELECT run.id,run.subscription_key FROM radar_analytics.search_runs AS run
       JOIN latest_scopes scope ON scope.id=run.scope_version_id
       WHERE run.origin='watch_keyword' AND run.subscription_key IS NOT NULL
         AND run.searched_at >= now() - ($1::int * interval '1 day')
         AND ($2::text='' OR run.subscription_key=$2)
         AND ($3::text='' OR EXISTS (
           SELECT 1 FROM radar_analytics.search_run_sources source
           WHERE source.run_id=run.id AND source.source_id=$3
         ))
     ), metric_window AS (
       SELECT day,subscription_key,visible_count,new_count,left_visible_window
       FROM radar_analytics.market_scope_daily_metrics metric
       WHERE $3::text=''
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
       UNION ALL
       SELECT day,subscription_key,visible_count,new_count,left_visible_window
       FROM radar_analytics.market_scope_daily_source_metrics metric
       WHERE $3::text<>'' AND metric.source_id=$3
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
     ), latest_metrics AS (
       SELECT metric_window.*,
              row_number() OVER (PARTITION BY subscription_key ORDER BY day DESC) AS position
       FROM metric_window
     )
     SELECT (SELECT count(*)::int FROM filtered_runs) AS run_count,
            (SELECT count(DISTINCT subscription_key)::int FROM filtered_runs) AS subscription_count,
            (SELECT count(DISTINCT observation.source_listing_id)::int
             FROM radar_analytics.listing_observations observation
             JOIN filtered_runs run ON run.id=observation.run_id
             WHERE $3::text='' OR observation.source_id=$3) AS observed_listings,
            (SELECT coalesce(sum(visible_count),0)::int FROM latest_metrics WHERE position=1) AS visible_listings,
            (SELECT coalesce(sum(new_count),0)::int FROM metric_window) AS new_listings,
            (SELECT coalesce(sum(left_visible_window),0)::int FROM metric_window) AS left_visible_window`,
    values,
  );
  const trendResult = await client.query<TrendRow>(
    `WITH latest_scopes AS (
       SELECT DISTINCT ON (subscription_key) id,subscription_key
       FROM radar_analytics.market_scope_versions ORDER BY subscription_key,version DESC
     ), metric_window AS (
       SELECT day,subscription_key,subscription_name,query,NULL::text AS source_id,
               visible_count,new_count,left_visible_window,run_count,source_count,
               available_count,sold_out_count,priced_count,min_price_jpy,median_price_jpy,
               average_price_jpy,max_price_jpy,scope_version_id,scope_version,quality_grade,
               interpretable,warmup,expected_source_count,successful_source_count,
               failed_source_count,stale_source_count,coverage_rate
        FROM radar_analytics.market_scope_daily_metrics metric
        WHERE $3::text=''
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
        UNION ALL
        SELECT day,subscription_key,subscription_name,query,source_id,
               visible_count,new_count,left_visible_window,run_count,source_count,
               available_count,sold_out_count,priced_count,min_price_jpy,median_price_jpy,
               average_price_jpy,max_price_jpy,scope_version_id,scope_version,quality_grade,
               interpretable,warmup,expected_source_count,successful_source_count,
               failed_source_count,stale_source_count,coverage_rate
        FROM radar_analytics.market_scope_daily_source_metrics metric
        WHERE $3::text<>'' AND metric.source_id=$3
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
      )
      SELECT day::text,subscription_key,subscription_name,query,source_id,
             visible_count,new_count,left_visible_window,run_count,source_count,
             available_count,sold_out_count,priced_count,min_price_jpy,median_price_jpy,
             average_price_jpy,max_price_jpy,scope_version_id,scope_version,quality_grade,
             interpretable,warmup,expected_source_count,successful_source_count,
             failed_source_count,stale_source_count,coverage_rate
      FROM metric_window
      ORDER BY day ASC,subscription_name ASC LIMIT 1000`,
    values,
  );
  const subscriptionResult = await client.query<SubscriptionRow>(
    `WITH latest_scopes AS (
       SELECT DISTINCT ON (subscription_key) id,subscription_key
       FROM radar_analytics.market_scope_versions ORDER BY subscription_key,version DESC
     ), metric_window AS (
       SELECT day,subscription_key,subscription_name,query,NULL::text AS source_id,
               visible_count,new_count,left_visible_window,run_count,source_count,
               available_count,sold_out_count,priced_count,min_price_jpy,median_price_jpy,
               average_price_jpy,max_price_jpy,scope_version_id,scope_version,quality_grade,
               interpretable,warmup,expected_source_count,successful_source_count,
               failed_source_count,stale_source_count,coverage_rate
        FROM radar_analytics.market_scope_daily_metrics metric
        WHERE $3::text=''
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
        UNION ALL
        SELECT day,subscription_key,subscription_name,query,source_id,
               visible_count,new_count,left_visible_window,run_count,source_count,
               available_count,sold_out_count,priced_count,min_price_jpy,median_price_jpy,
               average_price_jpy,max_price_jpy,scope_version_id,scope_version,quality_grade,
               interpretable,warmup,expected_source_count,successful_source_count,
               failed_source_count,stale_source_count,coverage_rate
        FROM radar_analytics.market_scope_daily_source_metrics metric
        WHERE $3::text<>'' AND metric.source_id=$3
          AND metric.day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
          AND ($2::text='' OR metric.subscription_key=$2)
          AND EXISTS (SELECT 1 FROM latest_scopes scope WHERE scope.id=metric.scope_version_id)
      ), ranked AS (
        SELECT metric.*,
               row_number() OVER (PARTITION BY subscription_key ORDER BY day DESC) AS position
        FROM metric_window metric
      )
      SELECT latest.day::text AS latest_day,latest.source_id,latest.subscription_key,
             latest.subscription_name,latest.query,latest.visible_count,
             previous.visible_count AS previous_visible,latest.new_count,latest.left_visible_window,
             latest.run_count,latest.source_count,latest.available_count,latest.sold_out_count,
             latest.priced_count,latest.min_price_jpy,latest.median_price_jpy,
             latest.average_price_jpy,latest.max_price_jpy,latest.scope_version_id,
             latest.scope_version,latest.quality_grade,latest.interpretable,latest.warmup,
             latest.expected_source_count,latest.successful_source_count,latest.failed_source_count,
             latest.stale_source_count,latest.coverage_rate
      FROM ranked latest
      LEFT JOIN ranked previous ON previous.subscription_key=latest.subscription_key AND previous.position=2
      WHERE latest.position=1 ORDER BY latest.day DESC LIMIT 100`,
    values,
  );
  const sourceResult = await client.query<SourceMetricRow>(
    `WITH latest_scopes AS (
       SELECT DISTINCT ON (subscription_key) id,subscription_key
       FROM radar_analytics.market_scope_versions ORDER BY subscription_key,version DESC
     ), selected AS (
       SELECT run.subscription_key,source.source_id,source.status,source.result_count,source.duration_ms,
              health.request_succeeded,health.parse_succeeded,health.abnormal_empty,
              health.state,health.observed_at,health.freshness_sla_minutes,run.searched_at
       FROM radar_analytics.search_run_sources source
       JOIN radar_analytics.search_runs run ON run.id=source.run_id
       JOIN latest_scopes scope ON scope.id=run.scope_version_id
       LEFT JOIN radar_analytics.source_health_snapshots health
         ON health.run_id=run.id AND health.source_id=source.source_id
       WHERE run.origin='watch_keyword' AND run.subscription_key IS NOT NULL
         AND run.searched_at >= now() - ($1::int * interval '1 day')
         AND ($2::text='' OR run.subscription_key=$2)
         AND ($3::text='' OR source.source_id=$3)
     ), latest AS (
       SELECT DISTINCT ON (subscription_key,source_id) subscription_key,source_id,state,observed_at,freshness_sla_minutes
       FROM selected ORDER BY subscription_key,source_id,observed_at DESC NULLS LAST,searched_at DESC
     ), aggregate AS (
       SELECT subscription_key,source_id,count(*)::int AS run_count,
             count(*) FILTER (WHERE source.status IN ('success','empty'))::int AS successful_runs,
             coalesce(sum(result_count),0)::int AS result_count,round(avg(duration_ms))::int AS average_duration_ms,
             coalesce(avg(request_succeeded::int) FILTER (WHERE state NOT IN ('disabled','cooldown')),0) AS request_success_rate,
             coalesce(avg(parse_succeeded::int) FILTER (WHERE request_succeeded),0) AS parse_success_rate,
             count(*) FILTER (WHERE abnormal_empty)::int AS abnormal_empty_runs
       FROM selected source GROUP BY subscription_key,source_id
     )
     SELECT aggregate.*,COALESCE(latest.state,'failed') AS latest_state,latest.observed_at AS latest_observed_at,
            latest.freshness_sla_minutes,
            latest.observed_at IS NOT NULL AND now()-latest.observed_at <= latest.freshness_sla_minutes*interval '1 minute' AS fresh
     FROM aggregate JOIN latest USING (subscription_key,source_id)
     ORDER BY subscription_key,run_count DESC,source_id`,
    values,
  );
  const discoveryResult = await client.query<DiscoveryRow>(
    `WITH latest_scope AS (
       SELECT id FROM radar_analytics.market_scope_versions
       WHERE subscription_key=$2 ORDER BY version DESC LIMIT 1
     ), scope_first_seen AS (
       SELECT DISTINCT ON (observation.source_listing_id)
              observation.source_listing_id,run.searched_at AS first_seen_at
       FROM radar_analytics.listing_observations observation
       JOIN radar_analytics.search_runs run ON run.id=observation.run_id
       WHERE run.scope_version_id=(SELECT id FROM latest_scope)
       ORDER BY observation.source_listing_id,run.searched_at,run.id
     )
     SELECT listing.source_id,listing.source_item_id,listing.title,listing.canonical_url,
            listing.image_url,listing.current_price_jpy,listing.item_condition,listing.availability,
            scope_first_seen.first_seen_at,enrichment.output->>'relevance' AS relevance,enrichment.confidence,
            NULLIF(enrichment.output->>'marketCategory','') AS market_category,
            NULLIF(enrichment.output->>'officialStatus','') AS official_status
     FROM radar_analytics.keyword_listings keyword
     JOIN radar_analytics.source_listings listing ON listing.id=keyword.source_listing_id
     JOIN scope_first_seen ON scope_first_seen.source_listing_id=keyword.source_listing_id
     JOIN LATERAL (
       SELECT ai.output,ai.confidence FROM radar_analytics.ai_enrichments ai
       WHERE ai.source_listing_id=listing.id AND ai.purpose='listing_semantics'
         AND ai.metadata->>'marketSubscriptionKey'=$2
         AND ai.metadata->>'marketScopeVersionId'=(SELECT id FROM latest_scope)
       ORDER BY ai.created_at DESC,ai.id DESC LIMIT 1
     ) enrichment ON true
     WHERE $2::text<>'' AND keyword.query_key=$2
       AND timezone('Asia/Tokyo',scope_first_seen.first_seen_at)::date >=
           (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
       AND ($3::text='' OR listing.source_id=$3)
       AND enrichment.output->>'relevance' IN ('relevant','uncertain')
     ORDER BY scope_first_seen.first_seen_at DESC,listing.source_id,listing.source_item_id LIMIT 12`,
    values,
  );

  const rawSummary = summaryResult.rows[0];
  const summary: AnalyticsSummary = {
    runCount: numeric(rawSummary?.run_count),
    subscriptionCount: numeric(rawSummary?.subscription_count),
    observedListings: numeric(rawSummary?.observed_listings),
    visibleListings: numeric(rawSummary?.visible_listings),
    newListings: numeric(rawSummary?.new_listings),
    leftVisibleWindow: numeric(rawSummary?.left_visible_window),
  };
  const trends = trendResult.rows.map(trend);
  const subscriptions: AnalyticsSubscriptionSnapshot[] = subscriptionResult.rows.map((row) => {
    const point = trend({ ...row, day: row.latest_day });
    const { day, ...snapshot } = point;
    return { ...snapshot, latestDay: day, previousVisible: nullableNumeric(row.previous_visible) };
  });
  const sources: AnalyticsSourceMetric[] = sourceResult.rows.map((row) => ({
    subscriptionKey: row.subscription_key,
    sourceId: row.source_id,
    runCount: numeric(row.run_count),
    successfulRuns: numeric(row.successful_runs),
    resultCount: numeric(row.result_count),
    averageDurationMs: nullableNumeric(row.average_duration_ms),
    requestSuccessRate: numeric(row.request_success_rate),
    parseSuccessRate: numeric(row.parse_success_rate),
    abnormalEmptyRuns: numeric(row.abnormal_empty_runs),
    latestState: ["healthy", "empty", "suspected_degradation", "failed", "disabled", "cooldown"].includes(row.latest_state)
      ? row.latest_state as AnalyticsSourceMetric["latestState"]
      : "unknown",
    latestObservedAt: row.latest_observed_at ? iso(row.latest_observed_at) : null,
    freshnessSlaMinutes: nullableNumeric(row.freshness_sla_minutes),
    fresh: row.fresh,
  }));
  const discoveries: AnalyticsDiscoveryListing[] = discoveryResult.rows.map((row) => ({
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    title: row.title,
    canonicalUrl: row.canonical_url,
    imageUrl: row.image_url,
    currentPrice: nullableNumeric(row.current_price_jpy),
    condition: row.item_condition,
    availability: row.availability,
    firstSeenAt: iso(row.first_seen_at),
    relevance: row.relevance,
    confidence: row.confidence,
    category: row.market_category,
    officialStatus: row.official_status,
  }));
  return {
    generatedAt: new Date().toISOString(),
    days,
    subscriptionKey: subscriptionKey || null,
    sourceId: sourceId || null,
    summary,
    trends,
    subscriptions,
    categories: [],
    sources,
    discoveries,
  };
}

export async function getAnalyticsOverview(
  connectionString: string,
  input: { days: number; subscriptionKey?: string; sourceId?: string },
): Promise<AnalyticsOverview> {
  return withRuntimeClient(connectionString, (client) => readAnalyticsOverview(client, input));
}

interface MarketEvidenceHeaderRow extends QueryResultRow {
  scope_version_id: string;
  scope_version: number;
  subscription_name: string | null;
  query: string | null;
  run_count: number;
  successful_source_runs: number;
  source_count: number;
  evidence_started_at: string | Date | null;
  evidence_ended_at: string | Date | null;
  raw_new_listing_count: number;
  cleaned_new_listing_count: number;
  relevant_new_listing_count: number;
  irrelevant_new_listing_count: number;
  uncertain_new_listing_count: number;
  pending_cleaning_count: number;
}

interface MarketDailyFactRow extends QueryResultRow {
  day: string;
  source_id: string;
  quality_grade: "A" | "B" | "C" | "D";
  interpretable: boolean;
  warmup: boolean;
  expected_source_count: number;
  successful_source_count: number;
  failed_source_count: number;
  stale_source_count: number;
  coverage_rate: number;
  latest_state: AnalyticsSourceMetric["latestState"];
  visible_count: number;
  raw_new_count: number;
  cleaned_new_count: number;
  relevant_new_count: number;
  irrelevant_new_count: number;
  uncertain_new_count: number;
  left_visible_window: number;
  run_count: number;
  relevant_available_count: number;
  relevant_sold_out_count: number;
  relevant_priced_count: number;
  relevant_min_price: number | null;
  relevant_median_price: number | null;
  relevant_average_price: number | null;
  relevant_max_price: number | null;
  category_counts: Record<string, number> | string;
  condition_counts: Record<string, number> | string;
  official_status_counts: Record<string, number> | string;
  confidence_counts: Record<string, number> | string;
}

interface MarketCleaningCandidateRow extends QueryResultRow {
  first_seen_run_id: string;
  first_seen_at: string | Date;
  source_id: string;
  source_item_id: string;
  identity_scope: string;
  canonical_url: string;
  title: string;
  description_excerpt: string | null;
  image_url: string | null;
  seller_name: string | null;
  shop_name: string | null;
  currency: string;
  current_price_jpy: number | null;
  original_price_jpy: number | null;
  price_basis: string;
  item_condition: string;
  availability: string;
  source_listed_at: string | null;
  source_updated_at: string | null;
  facts: Record<string, unknown> | string;
  raw_metadata: Record<string, unknown> | string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonObject<T extends object>(value: T | string): T {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("analytics_json_object_required");
  }
  return parsed as T;
}

export async function readMarketCleaningCandidates(
  client: AnalyticsQueryClient,
  input: {
    days: number;
    subscriptionKey: string;
    sourceId?: string;
    cleaningProvider: string;
    cleaningModel: string;
    cleaningPromptVersion: string;
  },
): Promise<MarketCleaningCandidate[]> {
  const days = Math.max(1, Math.min(Math.trunc(input.days), 365));
  const subscriptionKey = input.subscriptionKey.trim();
  const sourceId = input.sourceId?.trim() || "";
  if (!subscriptionKey) throw new Error("market_analysis_subscription_required");
  const result = await client.query<MarketCleaningCandidateRow>(
    `WITH latest_scope AS (
       SELECT id,version FROM radar_analytics.market_scope_versions
       WHERE subscription_key=$2 ORDER BY version DESC LIMIT 1
     ), scope_first_seen AS (
       SELECT DISTINCT ON (observation.source_listing_id)
              observation.source_listing_id,run.id AS first_seen_run_id,run.searched_at AS first_seen_at
       FROM radar_analytics.listing_observations observation
       JOIN radar_analytics.search_runs run ON run.id=observation.run_id
       WHERE run.scope_version_id=(SELECT id FROM latest_scope)
       ORDER BY observation.source_listing_id,run.searched_at,run.id
     )
     SELECT scope_first_seen.first_seen_run_id::text,scope_first_seen.first_seen_at,
            listing.source_id,listing.source_item_id,listing.identity_scope,
            listing.canonical_url,listing.title,listing.description_excerpt,
            listing.image_url,listing.seller_name,listing.shop_name,listing.currency,
            listing.current_price_jpy,listing.original_price_jpy,listing.price_basis,
            listing.item_condition,listing.availability,listing.source_listed_at,
            listing.source_updated_at,listing.facts,listing.raw_metadata
     FROM radar_analytics.keyword_listings keyword
     JOIN radar_analytics.source_listings listing ON listing.id=keyword.source_listing_id
     JOIN scope_first_seen ON scope_first_seen.source_listing_id=keyword.source_listing_id
     WHERE keyword.query_key=$2
       AND timezone('Asia/Tokyo',scope_first_seen.first_seen_at)::date >=
           (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
       AND ($3::text='' OR listing.source_id=$3)
       AND NOT EXISTS (
         SELECT 1 FROM radar_analytics.ai_enrichments ai
         WHERE ai.source_listing_id=keyword.source_listing_id
           AND ai.purpose='listing_semantics'
            AND ai.provider=$4 AND ai.model=$5 AND ai.prompt_version=$6
            AND ai.metadata->>'marketSubscriptionKey'=$2
            AND ai.metadata->>'marketScopeVersionId'=(SELECT id FROM latest_scope)
       )
     ORDER BY scope_first_seen.first_seen_at,listing.source_id,listing.source_item_id`,
    [
      days,
      subscriptionKey,
      sourceId,
      input.cleaningProvider,
      input.cleaningModel,
      input.cleaningPromptVersion,
    ],
  );
  return result.rows.map((row) => ({
    firstSeenRunId: row.first_seen_run_id,
    firstSeenAt: iso(row.first_seen_at),
    listing: {
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      identityScope: row.identity_scope,
      canonicalUrl: row.canonical_url,
      title: row.title,
      ...(row.description_excerpt ? { descriptionExcerpt: row.description_excerpt } : {}),
      ...(row.image_url ? { imageUrl: row.image_url } : {}),
      ...(row.seller_name ? { sellerName: row.seller_name } : {}),
      ...(row.shop_name ? { shopName: row.shop_name } : {}),
      currency: row.currency,
      ...(row.current_price_jpy === null ? {} : { currentPrice: numeric(row.current_price_jpy) }),
      ...(row.original_price_jpy === null ? {} : { originalPrice: numeric(row.original_price_jpy) }),
      priceBasis: row.price_basis,
      condition: row.item_condition,
      availability: row.availability,
      ...(row.source_listed_at ? { sourceListedAt: row.source_listed_at } : {}),
      ...(row.source_updated_at ? { sourceUpdatedAt: row.source_updated_at } : {}),
      facts: jsonObject(row.facts),
      rawMetadata: jsonObject(row.raw_metadata),
    },
  }));
}

export async function getMarketCleaningCandidates(
  connectionString: string,
  input: {
    days: number;
    subscriptionKey: string;
    sourceId?: string;
    cleaningProvider: string;
    cleaningModel: string;
    cleaningPromptVersion: string;
  },
): Promise<MarketCleaningCandidate[]> {
  return withRuntimeClient(connectionString, (client) => readMarketCleaningCandidates(client, input));
}

export async function readMarketAnalysisEvidence(
  client: AnalyticsQueryClient,
  input: {
    days: number;
    subscriptionKey: string;
    sourceId?: string;
    cleaningProvider: string;
    cleaningModel: string;
    cleaningPromptVersion: string;
  },
): Promise<MarketAnalysisEvidence> {
  const days = Math.max(1, Math.min(Math.trunc(input.days), 365));
  const subscriptionKey = input.subscriptionKey.trim();
  const sourceId = input.sourceId?.trim() || "";
  if (!subscriptionKey) throw new Error("market_analysis_subscription_required");
  const values = [
    days,
    subscriptionKey,
    sourceId,
    input.cleaningProvider,
    input.cleaningModel,
    input.cleaningPromptVersion,
  ];

  const headerResult = await client.query<MarketEvidenceHeaderRow>(
    `WITH latest_scope AS (
       SELECT id,version FROM radar_analytics.market_scope_versions
       WHERE subscription_key=$2 ORDER BY version DESC LIMIT 1
     ), scope_first_seen AS (
       SELECT DISTINCT ON (observation.source_listing_id)
              observation.source_listing_id,run.id AS first_seen_run_id,run.searched_at AS first_seen_at
       FROM radar_analytics.listing_observations observation
       JOIN radar_analytics.search_runs run ON run.id=observation.run_id
       WHERE run.scope_version_id=(SELECT id FROM latest_scope)
       ORDER BY observation.source_listing_id,run.searched_at,run.id
     ), selected_runs AS (
       SELECT run.id,run.subscription_name,run.query,run.searched_at,source.source_id
       FROM radar_analytics.search_runs run
       JOIN radar_analytics.search_run_sources source ON source.run_id=run.id
        WHERE run.origin='watch_keyword' AND run.subscription_key=$2
          AND run.scope_version_id=(SELECT id FROM latest_scope)
         AND timezone('Asia/Tokyo',run.searched_at)::date >=
             (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
         AND source.status IN ('success','empty')
         AND ($3::text='' OR source.source_id=$3)
     ), cleaned_candidates AS (
       SELECT keyword.source_listing_id,enrichment.id AS enrichment_id,enrichment.output
       FROM radar_analytics.keyword_listings keyword
       JOIN radar_analytics.source_listings listing ON listing.id=keyword.source_listing_id
       JOIN scope_first_seen ON scope_first_seen.source_listing_id=keyword.source_listing_id
       LEFT JOIN LATERAL (
         SELECT ai.id,ai.output
         FROM radar_analytics.ai_enrichments ai
         WHERE ai.source_listing_id=keyword.source_listing_id
           AND ai.purpose='listing_semantics'
            AND ai.provider=$4 AND ai.model=$5 AND ai.prompt_version=$6
            AND ai.metadata->>'marketSubscriptionKey'=$2
            AND ai.metadata->>'marketScopeVersionId'=(SELECT id FROM latest_scope)
         ORDER BY CASE WHEN ai.metadata->>'marketEventKind'='new' THEN 0 ELSE 1 END,
                  ai.created_at ASC,ai.id ASC LIMIT 1
       ) enrichment ON true
       WHERE keyword.query_key=$2
          AND timezone('Asia/Tokyo',scope_first_seen.first_seen_at)::date >=
              (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
         AND ($3::text='' OR listing.source_id=$3)
     )
     SELECT
       (SELECT id FROM latest_scope) AS scope_version_id,
       (SELECT version FROM latest_scope)::int AS scope_version,
       (array_agg(coalesce(subscription_name,query) ORDER BY searched_at DESC))[1] AS subscription_name,
       (array_agg(query ORDER BY searched_at DESC))[1] AS query,
       count(DISTINCT id)::int AS run_count,
       count(*)::int AS successful_source_runs,
       count(DISTINCT source_id)::int AS source_count,
       min(searched_at) AS evidence_started_at,
       max(searched_at) AS evidence_ended_at,
       (SELECT count(*)::int FROM cleaned_candidates) AS raw_new_listing_count,
       (SELECT count(enrichment_id)::int FROM cleaned_candidates) AS cleaned_new_listing_count,
       (SELECT count(*)::int FROM cleaned_candidates
          WHERE enrichment_id IS NOT NULL AND output->>'relevance'='relevant') AS relevant_new_listing_count,
       (SELECT count(*)::int FROM cleaned_candidates
          WHERE enrichment_id IS NOT NULL AND output->>'relevance'='irrelevant') AS irrelevant_new_listing_count,
       (SELECT count(*)::int FROM cleaned_candidates
          WHERE enrichment_id IS NOT NULL AND output->>'relevance'='uncertain') AS uncertain_new_listing_count,
       (SELECT count(*)::int FROM cleaned_candidates WHERE enrichment_id IS NULL) AS pending_cleaning_count
     FROM selected_runs`,
    values,
  );

  const header = headerResult.rows[0];
  if (!header?.evidence_started_at || !header.evidence_ended_at || !header.query || !header.subscription_name) {
    throw new Error("market_analysis_evidence_missing");
  }
  const pendingCleaningCount = numeric(header.pending_cleaning_count);
  if (pendingCleaningCount > 0) {
    throw new Error(`market_analysis_cleaning_pending:${pendingCleaningCount}`);
  }

  const dailyResult = await client.query<MarketDailyFactRow>(
    `WITH latest_scope AS (
       SELECT id,version FROM radar_analytics.market_scope_versions
       WHERE subscription_key=$2 ORDER BY version DESC LIMIT 1
     ), scope_first_seen AS (
       SELECT DISTINCT ON (observation.source_listing_id)
              observation.source_listing_id,run.id AS first_seen_run_id,run.searched_at AS first_seen_at
       FROM radar_analytics.listing_observations observation
       JOIN radar_analytics.search_runs run ON run.id=observation.run_id
       WHERE run.scope_version_id=(SELECT id FROM latest_scope)
       ORDER BY observation.source_listing_id,run.searched_at,run.id
     ), metrics AS (
       SELECT day,source_id,quality_grade,interpretable,warmup,expected_source_count,
              successful_source_count,failed_source_count,stale_source_count,coverage_rate,
              latest_state,visible_count,left_visible_window,run_count
       FROM radar_analytics.market_scope_daily_source_metrics
       WHERE subscription_key=$2
          AND scope_version_id=(SELECT id FROM latest_scope)
         AND day >= (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
         AND ($3::text='' OR source_id=$3)
     ), facts AS (
       SELECT timezone('Asia/Tokyo',scope_first_seen.first_seen_at)::date AS day,
              listing.source_id,observation.price_jpy,observation.availability,
              enrichment.id AS enrichment_id,enrichment.output,enrichment.confidence
       FROM radar_analytics.keyword_listings keyword
       JOIN radar_analytics.source_listings listing ON listing.id=keyword.source_listing_id
       JOIN scope_first_seen ON scope_first_seen.source_listing_id=keyword.source_listing_id
       LEFT JOIN radar_analytics.listing_observations observation
         ON observation.run_id=scope_first_seen.first_seen_run_id
        AND observation.source_listing_id=keyword.source_listing_id
       LEFT JOIN LATERAL (
         SELECT ai.id,ai.output,ai.confidence
         FROM radar_analytics.ai_enrichments ai
         WHERE ai.source_listing_id=keyword.source_listing_id
           AND ai.purpose='listing_semantics'
            AND ai.provider=$4 AND ai.model=$5 AND ai.prompt_version=$6
            AND ai.metadata->>'marketSubscriptionKey'=$2
            AND ai.metadata->>'marketScopeVersionId'=(SELECT id FROM latest_scope)
         ORDER BY CASE WHEN ai.metadata->>'marketEventKind'='new' THEN 0 ELSE 1 END,
                  ai.created_at ASC,ai.id ASC LIMIT 1
       ) enrichment ON true
       WHERE keyword.query_key=$2
          AND timezone('Asia/Tokyo',scope_first_seen.first_seen_at)::date >=
              (timezone('Asia/Tokyo',now())::date - ($1::int - 1))
         AND ($3::text='' OR listing.source_id=$3)
     ), counts AS (
       SELECT day,source_id,
              count(*)::int AS raw_new_count,
              count(enrichment_id)::int AS cleaned_new_count,
              count(*) FILTER (WHERE output->>'relevance'='relevant')::int AS relevant_new_count,
              count(*) FILTER (WHERE output->>'relevance'='irrelevant')::int AS irrelevant_new_count,
              count(*) FILTER (WHERE output->>'relevance'='uncertain')::int AS uncertain_new_count,
              count(*) FILTER (WHERE output->>'relevance'='relevant'
                AND availability IN ('available','preorder','backorder'))::int AS relevant_available_count,
              count(*) FILTER (WHERE output->>'relevance'='relevant'
                AND availability='sold_out')::int AS relevant_sold_out_count,
              count(price_jpy) FILTER (WHERE output->>'relevance'='relevant')::int AS relevant_priced_count,
              min(price_jpy) FILTER (WHERE output->>'relevance'='relevant')::int AS relevant_min_price,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY price_jpy)
                FILTER (WHERE output->>'relevance'='relevant')::int AS relevant_median_price,
              round(avg(price_jpy) FILTER (WHERE output->>'relevance'='relevant'),2) AS relevant_average_price,
              max(price_jpy) FILTER (WHERE output->>'relevance'='relevant')::int AS relevant_max_price
       FROM facts GROUP BY day,source_id
     ), category_rollup AS (
       SELECT day,source_id,jsonb_object_agg(category,item_count ORDER BY category) AS values
       FROM (
         SELECT day,source_id,
                CASE WHEN output->>'marketCategory'=ANY(ARRAY[
                  '布偶／玩偶','手办／模型','徽章／挂件','亚克力制品','书籍／漫画','影像／音乐',
                  '服饰／布制品','文具／纸品','餐厨／生活杂货','卡牌','游戏／电子','其他'
                ]) THEN output->>'marketCategory' ELSE '其他' END AS category,
                count(*)::int AS item_count
         FROM facts WHERE output->>'relevance'='relevant'
         GROUP BY day,source_id,category
       ) grouped GROUP BY day,source_id
     ), condition_rollup AS (
       SELECT day,source_id,jsonb_object_agg(condition,item_count ORDER BY condition) AS values
       FROM (
         SELECT day,source_id,coalesce(nullif(output->>'normalizedCondition',''),'unknown') AS condition,
                count(*)::int AS item_count
         FROM facts WHERE output->>'relevance'='relevant'
         GROUP BY day,source_id,condition
       ) grouped GROUP BY day,source_id
     ), official_rollup AS (
       SELECT day,source_id,jsonb_object_agg(status,item_count ORDER BY status) AS values
       FROM (
         SELECT day,source_id,coalesce(nullif(output->>'officialStatus',''),'unknown') AS status,
                count(*)::int AS item_count
         FROM facts WHERE output->>'relevance'='relevant'
         GROUP BY day,source_id,status
       ) grouped GROUP BY day,source_id
     ), confidence_rollup AS (
       SELECT day,source_id,jsonb_object_agg(confidence,item_count ORDER BY confidence) AS values
       FROM (
         SELECT day,source_id,coalesce(confidence,'low') AS confidence,count(*)::int AS item_count
         FROM facts WHERE enrichment_id IS NOT NULL
         GROUP BY day,source_id,confidence
       ) grouped GROUP BY day,source_id
     )
     SELECT metrics.day::text,metrics.source_id,metrics.quality_grade,metrics.interpretable,
            metrics.warmup,metrics.expected_source_count,metrics.successful_source_count,
            metrics.failed_source_count,metrics.stale_source_count,metrics.coverage_rate,
            metrics.latest_state,metrics.visible_count,
            coalesce(counts.raw_new_count,0)::int AS raw_new_count,
            coalesce(counts.cleaned_new_count,0)::int AS cleaned_new_count,
            coalesce(counts.relevant_new_count,0)::int AS relevant_new_count,
            coalesce(counts.irrelevant_new_count,0)::int AS irrelevant_new_count,
            coalesce(counts.uncertain_new_count,0)::int AS uncertain_new_count,
            metrics.left_visible_window,metrics.run_count,
            coalesce(counts.relevant_available_count,0)::int AS relevant_available_count,
            coalesce(counts.relevant_sold_out_count,0)::int AS relevant_sold_out_count,
            coalesce(counts.relevant_priced_count,0)::int AS relevant_priced_count,
            counts.relevant_min_price,counts.relevant_median_price,
            counts.relevant_average_price,counts.relevant_max_price,
            coalesce(category_rollup.values,'{}'::jsonb) AS category_counts,
            coalesce(condition_rollup.values,'{}'::jsonb) AS condition_counts,
            coalesce(official_rollup.values,'{}'::jsonb) AS official_status_counts,
            coalesce(confidence_rollup.values,'{}'::jsonb) AS confidence_counts
     FROM metrics
     LEFT JOIN counts USING(day,source_id)
     LEFT JOIN category_rollup USING(day,source_id)
     LEFT JOIN condition_rollup USING(day,source_id)
     LEFT JOIN official_rollup USING(day,source_id)
     LEFT JOIN confidence_rollup USING(day,source_id)
     ORDER BY metrics.day ASC,metrics.source_id ASC`,
    values,
  );

  const countRecord = (value: Record<string, number> | string): Record<string, number> => {
    const object = jsonObject<Record<string, unknown>>(value as Record<string, unknown> | string);
    return Object.fromEntries(Object.entries(object).map(([key, count]) => [key, numeric(count as number)]));
  };
  const dailyBySource: MarketAnalysisDailyMetric[] = dailyResult.rows.map((row) => ({
    metricRef: `${row.day}:${row.source_id}`,
    day: row.day,
    sourceId: row.source_id,
    qualityGrade: row.quality_grade,
    interpretable: row.interpretable,
    warmup: row.warmup,
    expectedSourceCount: numeric(row.expected_source_count),
    successfulSourceCount: numeric(row.successful_source_count),
    failedSourceCount: numeric(row.failed_source_count),
    staleSourceCount: numeric(row.stale_source_count),
    coverageRate: numeric(row.coverage_rate),
    latestState: row.latest_state === "unknown" ? "failed" : row.latest_state,
    visibleCount: numeric(row.visible_count),
    rawNewCount: numeric(row.raw_new_count),
    cleanedNewCount: numeric(row.cleaned_new_count),
    relevantNewCount: numeric(row.relevant_new_count),
    irrelevantNewCount: numeric(row.irrelevant_new_count),
    uncertainNewCount: numeric(row.uncertain_new_count),
    leftVisibleWindow: numeric(row.left_visible_window),
    runCount: numeric(row.run_count),
    relevantAvailableCount: numeric(row.relevant_available_count),
    relevantSoldOutCount: numeric(row.relevant_sold_out_count),
    relevantPricedCount: numeric(row.relevant_priced_count),
    relevantMinPrice: nullableNumeric(row.relevant_min_price),
    relevantMedianPrice: nullableNumeric(row.relevant_median_price),
    relevantAveragePrice: nullableNumeric(row.relevant_average_price),
    relevantMaxPrice: nullableNumeric(row.relevant_max_price),
    categoryCounts: countRecord(row.category_counts),
    conditionCounts: countRecord(row.condition_counts),
    officialStatusCounts: countRecord(row.official_status_counts),
    confidenceCounts: countRecord(row.confidence_counts),
  }));
  return {
    subscriptionKey,
    subscriptionName: header.subscription_name,
    query: header.query,
    scopeVersionId: header.scope_version_id,
    scopeVersion: numeric(header.scope_version),
    days,
    sourceId: sourceId || null,
    evidenceStartedAt: iso(header.evidence_started_at),
    evidenceEndedAt: iso(header.evidence_ended_at),
    coverage: {
      runCount: numeric(header.run_count),
      successfulSourceRuns: numeric(header.successful_source_runs),
      sourceCount: numeric(header.source_count),
      rawNewListingCount: numeric(header.raw_new_listing_count),
      cleanedNewListingCount: numeric(header.cleaned_new_listing_count),
      relevantNewListingCount: numeric(header.relevant_new_listing_count),
      irrelevantNewListingCount: numeric(header.irrelevant_new_listing_count),
      uncertainNewListingCount: numeric(header.uncertain_new_listing_count),
      pendingCleaningCount,
      dailyFactCount: dailyBySource.length,
      cleaningProvider: input.cleaningProvider,
      cleaningModel: input.cleaningModel,
      cleaningPromptVersion: input.cleaningPromptVersion,
      truncated: false,
    },
    dailyBySource,
  };
}

export async function getMarketAnalysisEvidence(
  connectionString: string,
  input: {
    days: number;
    subscriptionKey: string;
    sourceId?: string;
    cleaningProvider: string;
    cleaningModel: string;
    cleaningPromptVersion: string;
  },
): Promise<MarketAnalysisEvidence> {
  return withRuntimeClient(connectionString, (client) => readMarketAnalysisEvidence(client, input));
}

interface HistoricalListingRow extends QueryResultRow {
  source_id: string;
  source_item_id: string;
  identity_scope: string;
  canonical_url: string;
  title: string;
  description_excerpt: string | null;
  image_url: string | null;
  seller_name: string | null;
  shop_name: string | null;
  currency: string;
  current_price_jpy: number | null;
  original_price_jpy: number | null;
  price_basis: string;
  item_condition: string;
  availability: string;
  facts: Record<string, unknown>;
  raw_metadata: Record<string, unknown>;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function findHistoricalProductListings(
  connectionString: string,
  input: { sourceIds: readonly string[]; terms: readonly string[]; limit?: number },
): Promise<AnalyticsHistoricalListing[]> {
  const terms = [...new Set(input.terms.map((term) => term.normalize("NFKC").trim()).filter(Boolean))].slice(0, 12);
  if (terms.length === 0) return [];
  return withRuntimeClient(connectionString, async (client) => {
    const result = await client.query<HistoricalListingRow>(
      "SELECT * FROM radar_analytics.search_historical_product_listings($1::text[],$2::text[],$3::integer)",
      [[...input.sourceIds], terms, Math.min(100, Math.max(1, input.limit ?? 30))],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      sourceItemId: row.source_item_id,
      identityScope: row.identity_scope,
      canonicalUrl: row.canonical_url,
      title: row.title,
      ...(row.description_excerpt ? { descriptionExcerpt: row.description_excerpt } : {}),
      ...(row.image_url ? { imageUrl: row.image_url } : {}),
      ...(row.seller_name ? { sellerName: row.seller_name } : {}),
      ...(row.shop_name ? { shopName: row.shop_name } : {}),
      currency: row.currency,
      ...(row.current_price_jpy === null ? {} : { currentPrice: row.current_price_jpy }),
      ...(row.original_price_jpy === null ? {} : { originalPrice: row.original_price_jpy }),
      priceBasis: row.price_basis,
      condition: row.item_condition,
      availability: row.availability,
      facts: row.facts,
      rawMetadata: row.raw_metadata,
      firstSeenAt: timestamp(row.first_seen_at),
      lastSeenAt: timestamp(row.last_seen_at),
    }));
  });
}
