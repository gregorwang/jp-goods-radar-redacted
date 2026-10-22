import { unauthorized } from "@/lib/api-auth";
import { validOrigin } from "@/lib/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasStoredSearchSnapshot } from "@/lib/search-run";
import { listingEnrichmentSchema, searchPreviewSchema, type ListingEnrichment } from "@jpgr/validation";

interface SearchHistoryRow {
  id: string;
  query: string;
  sources_json: string;
  filters_json: string;
  status: string;
  result_count: number;
  source_summary_json: string;
  searched_at: string;
  search_mode: "keyword" | "exact_product";
  target_json: string | null;
  plan_json: string | null;
  deep_search: number;
  session_updated_at: string | null;
  page_count?: number;
  has_snapshot?: boolean | number;
}

interface SearchSnapshotRow {
  page_sequence: number;
  group_json: string;
}

interface ProductSearchWorkflowTaskRow {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  input_json: string;
  plan_json: string;
  history_id: string | null;
  session_id: string | null;
  last_error: string | null;
  ai_job_id: string | null;
  ai_manifest_json: string | null;
  ai_error: string | null;
  created_at: string;
  updated_at: string;
}

interface GeminiJobSummaryRow {
  id: string;
  status: "staging" | "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed";
  model: string;
  prompt_version: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  upstream_status: number | null;
  last_error: string | null;
  result_json: string | null;
}

interface StoredSearchAiRow {
  ai_job_id: string | null;
  ai_manifest_json: string | null;
  ai_error: string | null;
  gemini_id: string | null;
  gemini_status: GeminiJobSummaryRow["status"] | null;
  gemini_model: string | null;
  gemini_prompt_version: string | null;
  gemini_total_items: number | null;
  gemini_completed_items: number | null;
  gemini_failed_items: number | null;
  gemini_upstream_status: number | null;
  gemini_last_error: string | null;
  gemini_result_json: string | null;
}

interface ProductSearchAiManifest {
  version: string;
  totalListings: number;
  directCandidates: number;
  reviewCandidates: number;
  queuedCandidates: number;
  manualOnlyCandidates: number;
  deterministicExcludedCandidates: number;
  skippedInvalidCandidates: number;
  /** 旧任务没有这个字段，读不到时按 0 处理。 */
  unreviewedUnresolvedCandidates?: number;
  /** 补详情后的二次复核。 */
  followUpStatus?: "not_needed" | "completed" | "unavailable";
  followUpCandidates?: number;
  followUpAppliedCandidates?: number;
  followUpHydratedCandidates?: number;
  followUpUnsupportedCandidates?: number;
  candidateKeys: string[];
  settlementStatus?: "completed" | "partial" | "failed" | "timed_out" | "not_needed" | "unavailable";
  settledModel?: string;
  settledPromptVersion?: string;
  settledItems?: Array<ListingEnrichment | null>;
  settledStates?: Array<"pending" | "ready" | "failed">;
  settlementError?: string;
}

interface ProductIdentityProjectionSummaryRow {
  product_variant_id: string;
  canonical_product_id: string;
  comparison_profile_id: string;
  confirmed_count: number;
  rejected_count: number;
  uncertain_count: number;
  projected_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsedJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function searchAiReview(
  task: Pick<ProductSearchWorkflowTaskRow, "ai_job_id" | "ai_manifest_json" | "ai_error">,
  job: GeminiJobSummaryRow | null,
) {
  if (!task.ai_manifest_json) return undefined;
  const manifest = parsedJson<ProductSearchAiManifest | null>(task.ai_manifest_json, null);
  if (!manifest) return undefined;
  const legacyResult = parsedJson<{
    items?: unknown[];
    states?: Array<"pending" | "ready" | "failed">;
  }>(job?.result_json ?? "", {});
  const rawItems = manifest.settledItems ?? legacyResult.items ?? [];
  const items = Array.from({ length: manifest.queuedCandidates }, (_, index) => {
    const value = rawItems[index];
    if (value === null || value === undefined) return null;
    const parsed = listingEnrichmentSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  const states = manifest.settledStates ?? legacyResult.states ?? [];
  const itemStatuses = Array.from({ length: manifest.queuedCandidates }, (_, index) => (
    states[index] === "ready" && items[index] ? "completed" : states[index] === "failed" ? "failed" : "queued"
  ));
  const frozenStatus = manifest.settlementStatus === "timed_out" || manifest.settlementStatus === "unavailable"
    ? "unavailable"
    : manifest.settlementStatus;
  const status = frozenStatus
    ?? (task.ai_error ? "unavailable" : job?.status ?? (manifest.reviewCandidates === 0 ? "not_needed" : "unavailable"));
  const completedItems = itemStatuses.filter((value) => value === "completed").length;
  const failedItems = itemStatuses.filter((value) => value === "failed").length;
  return {
    selectionVersion: manifest.version,
    status,
    jobId: task.ai_job_id ?? undefined,
    candidateKeys: manifest.candidateKeys,
    totalCandidates: manifest.totalListings,
    directCandidates: manifest.directCandidates,
    reviewCandidates: manifest.reviewCandidates,
    queuedCandidates: manifest.queuedCandidates,
    manualOnlyCandidates: manifest.manualOnlyCandidates,
    deterministicExcludedCandidates: manifest.deterministicExcludedCandidates,
    skippedInvalidCandidates: manifest.skippedInvalidCandidates,
    // 程序没判完、本轮又没拿到复核名额的条数。它大于 0 就意味着本轮覆盖是 partial，
    // 界面不得写“全部商品已判定”（计划 §9.3）。
    unreviewedUnresolvedCandidates: manifest.unreviewedUnresolvedCandidates ?? 0,
    coverage: (manifest.unreviewedUnresolvedCandidates ?? 0) > 0 ? "partial" : "reviewed_queue_complete",
    // 拿到判断后的那一轮：补了多少条详情、重判了多少条、
    // 多少条因为来源不支持详情而停在未决（能力问题，不是身份结论）。
    followUp: {
      status: manifest.followUpStatus ?? "not_needed",
      hydratedCandidates: manifest.followUpHydratedCandidates ?? 0,
      reviewedCandidates: manifest.followUpCandidates ?? 0,
      appliedCandidates: manifest.followUpAppliedCandidates ?? 0,
      detailUnsupportedCandidates: manifest.followUpUnsupportedCandidates ?? 0,
    },
    model: manifest.settledModel ?? job?.model,
    promptVersion: manifest.settledPromptVersion ?? job?.prompt_version,
    completedItems: manifest.settledStates ? completedItems : job?.completed_items ?? completedItems,
    failedItems: manifest.settledStates ? failedItems : job?.failed_items ?? failedItems,
    totalItems: job?.total_items ?? manifest.queuedCandidates,
    items,
    itemStatuses,
    upstreamStatus: job?.upstream_status ?? undefined,
    error: manifest.settlementError ?? task.ai_error ?? job?.last_error ?? undefined,
  };
}

async function geminiJobSummary(jobId: string | null): Promise<GeminiJobSummaryRow | null> {
  if (!jobId) return null;
  return getEnv().DB.prepare(
    `SELECT id,status,model,prompt_version,total_items,completed_items,failed_items,
            upstream_status,last_error,result_json FROM gemini_jobs WHERE id=? AND kind='listing_enrichment'`,
  ).bind(jobId).first<GeminiJobSummaryRow>();
}

async function storedSearchAiReviews(historyId: string) {
  const rows = await getEnv().DB.prepare(
    `SELECT task.ai_job_id,task.ai_manifest_json,task.ai_error,
            job.id gemini_id,job.status gemini_status,job.model gemini_model,
            job.prompt_version gemini_prompt_version,job.total_items gemini_total_items,
            job.completed_items gemini_completed_items,job.failed_items gemini_failed_items,
            job.upstream_status gemini_upstream_status,job.last_error gemini_last_error,
            job.result_json gemini_result_json
     FROM product_search_workflow_tasks task
     JOIN search_history history ON history.id=task.history_id
     LEFT JOIN gemini_jobs job ON job.id=task.ai_job_id AND job.kind='listing_enrichment'
     WHERE COALESCE(history.session_id,history.id)=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
     ORDER BY history.page_sequence,task.created_at,task.id`,
  ).bind(historyId, historyId).all<StoredSearchAiRow>();
  return rows.results.flatMap((row) => {
    const job: GeminiJobSummaryRow | null = row.gemini_id && row.gemini_status && row.gemini_model
      && row.gemini_prompt_version
      ? {
          id: row.gemini_id,
          status: row.gemini_status,
          model: row.gemini_model,
          prompt_version: row.gemini_prompt_version,
          total_items: row.gemini_total_items ?? 0,
          completed_items: row.gemini_completed_items ?? 0,
          failed_items: row.gemini_failed_items ?? 0,
          upstream_status: row.gemini_upstream_status,
          last_error: row.gemini_last_error,
          result_json: row.gemini_result_json,
        }
      : null;
    const review = searchAiReview(row, job);
    return review ? [review] : [];
  });
}

async function storedProductIdentity(historyId: string) {
  const row = await getEnv().DB.prepare(
    `SELECT product_variant_id,canonical_product_id,comparison_profile_id,
            confirmed_count,rejected_count,uncertain_count,projected_at
     FROM product_identity_projection_versions
     WHERE search_history_id=? ORDER BY projected_at DESC,id DESC LIMIT 1`,
  ).bind(historyId).first<ProductIdentityProjectionSummaryRow>();
  return row ? {
    productVariantId: row.product_variant_id,
    canonicalProductId: row.canonical_product_id,
    comparisonProfileId: row.comparison_profile_id,
    confirmedCount: row.confirmed_count,
    rejectedCount: row.rejected_count,
    uncertainCount: row.uncertain_count,
    projectedAt: row.projected_at,
  } : undefined;
}

function historyItem(row: SearchHistoryRow) {
  return {
    id: row.id,
    query: row.query,
    sources: parsedJson<unknown[]>(row.sources_json, []),
    filters: parsedJson<Record<string, unknown>>(row.filters_json, {}),
    status: row.status,
    resultCount: row.result_count,
    sourceSummary: parsedJson<unknown[]>(row.source_summary_json, []),
    searchedAt: row.searched_at,
    updatedAt: row.session_updated_at ?? row.searched_at,
    pageCount: row.page_count ?? 1,
    mode: row.search_mode,
    target: row.target_json ? parsedJson<Record<string, unknown> | null>(row.target_json, null) : null,
    plan: row.plan_json ? parsedJson<Record<string, unknown> | null>(row.plan_json, null) : null,
    deepSearch: row.deep_search === 1,
    hasSnapshot: hasStoredSearchSnapshot(row.has_snapshot),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mergeRequestEvidence(currentValue: unknown, nextValue: unknown): Record<string, unknown> | undefined {
  const current = objectValue(currentValue);
  const next = objectValue(nextValue);
  if (Object.keys(current).length === 0) return Object.keys(next).length === 0 ? undefined : next;
  if (Object.keys(next).length === 0) return current;
  const merged: Record<string, unknown> = { ...current, ...next };
  for (const key of [
    "rawResultCount",
    "normalizedResultCount",
    "pagesFetched",
    "keywordRawResultCount",
    "liveDetailResultCount",
    "anchorCandidateCount",
    "parserAcceptedCount",
    "parserRejectedCount",
  ]) {
    const left = typeof current[key] === "number" ? current[key] : 0;
    const right = typeof next[key] === "number" ? next[key] : 0;
    if (left !== 0 || right !== 0 || key in current || key in next) merged[key] = left + right;
  }
  return merged;
}

function mergeSnapshotGroups(rows: readonly SearchSnapshotRow[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const next = parsedJson<Record<string, unknown>>(row.group_json, {});
    const sourceId = typeof next.sourceId === "string" ? next.sourceId : "";
    if (!sourceId || !Array.isArray(next.listings)) continue;
    const current = groups.get(sourceId);
    if (!current) {
      groups.set(sourceId, next);
      continue;
    }
    const listings = new Map<string, unknown>();
    for (const listing of [...(Array.isArray(current.listings) ? current.listings : []), ...next.listings]) {
      const item = objectValue(listing);
      const sourceItemId = typeof item.sourceItemId === "string" ? item.sourceItemId : "";
      if (sourceItemId) listings.set(sourceItemId, listing);
    }
    const combinedListings = [...listings.values()];
    const currentEvidence = objectValue(current.candidateEvidence);
    const nextEvidence = objectValue(next.candidateEvidence);
    const duration = (typeof current.durationMs === "number" ? current.durationMs : 0)
      + (typeof next.durationMs === "number" ? next.durationMs : 0);
    const requestEvidence = mergeRequestEvidence(current.requestEvidence, next.requestEvidence);
    if (requestEvidence) requestEvidence.normalizedResultCount = combinedListings.length;
    groups.set(sourceId, {
      ...current,
      ...next,
      status: combinedListings.length > 0 ? "success" : next.status,
      listings: combinedListings,
      warnings: [...new Set([...stringValues(current.warnings), ...stringValues(next.warnings)])],
      candidateEvidence: { ...currentEvidence, ...nextEvidence },
      durationMs: duration,
      requestEvidence,
      totalAvailable: Math.max(
        typeof current.totalAvailable === "number" ? current.totalAvailable : 0,
        typeof next.totalAvailable === "number" ? next.totalAvailable : 0,
      ) || undefined,
    });
  }
  return [...groups.values()];
}

async function storedHistory(historyId: string): Promise<{
  history: ReturnType<typeof historyItem>;
  groups: Record<string, unknown>[];
} | undefined> {
  const [history, snapshots] = await Promise.all([
    getEnv().DB.prepare(
      `SELECT id,query,sources_json,filters_json,status,result_count,source_summary_json,searched_at,
        search_mode,target_json,plan_json,deep_search,session_updated_at,
        (SELECT count(*) FROM search_history page WHERE COALESCE(page.session_id,page.id)=root.id) AS page_count,
        1 AS has_snapshot
       FROM search_history root
       WHERE root.id=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
         AND root.parent_history_id IS NULL`,
    ).bind(historyId, historyId).first<SearchHistoryRow>(),
    getEnv().DB.prepare(
      `SELECT history.page_sequence,snapshot.group_json
       FROM search_history history
       JOIN search_result_snapshots snapshot ON snapshot.search_history_id=history.id
       WHERE COALESCE(history.session_id,history.id)=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
       ORDER BY history.page_sequence,snapshot.source_id`,
    ).bind(historyId, historyId).all<SearchSnapshotRow>(),
  ]);
  if (!history || snapshots.results.length === 0) return undefined;
  return { history: historyItem(history), groups: mergeSnapshotGroups(snapshots.results) };
}

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const parameters = new URL(request.url).searchParams;
  const productIdentityHistoryId = parameters.get("productIdentityHistoryId");
  if (productIdentityHistoryId !== null) {
    if (!UUID.test(productIdentityHistoryId)) {
      return Response.json({ error: "invalid_history_id" }, { status: 400 });
    }
    return Response.json({ productIdentity: await storedProductIdentity(productIdentityHistoryId) });
  }
  const jobId = parameters.get("jobId");
  if (jobId !== null) {
    if (!UUID.test(jobId)) return Response.json({ error: "invalid_job_id" }, { status: 400 });
    const task = await getEnv().DB.prepare(
      `SELECT id,status,input_json,plan_json,history_id,session_id,last_error,
              ai_job_id,ai_manifest_json,ai_error,created_at,updated_at
       FROM product_search_workflow_tasks WHERE id=?`,
    ).bind(jobId).first<ProductSearchWorkflowTaskRow>();
    if (!task) return Response.json({ error: "search_job_not_found" }, { status: 404 });
    if (task.status === "queued" || task.status === "running") {
      return Response.json({ jobId, status: task.status, updatedAt: task.updated_at }, { status: 202 });
    }
    if (task.status === "failed") {
      return Response.json({ jobId, status: "failed", error: task.last_error ?? "后台搜索未完成" });
    }
    if (!task.history_id || !task.session_id) {
      return Response.json({ jobId, status: "failed", error: "搜索任务缺少结果索引" });
    }
    const [stored, sourceResults, aiJob, productIdentity] = await Promise.all([
      storedHistory(task.history_id),
      getEnv().DB.prepare(
        `SELECT source_id,group_json FROM product_search_workflow_results WHERE task_id=?`,
      ).bind(jobId).all<{ source_id: string; group_json: string }>(),
      geminiJobSummary(task.ai_job_id),
      storedProductIdentity(task.history_id),
    ]);
    if (!stored) return Response.json({ jobId, status: "running", updatedAt: task.updated_at }, { status: 202 });
    const groupsBySource = new Map(sourceResults.results.map((row) => [
      row.source_id,
      parsedJson<Record<string, unknown>>(row.group_json, {}),
    ]));
    const taskSources = stringValues(objectValue(parsedJson<Record<string, unknown>>(task.input_json, {})).sources);
    const taskGroups = taskSources.map((sourceId) => groupsBySource.get(sourceId)).filter((group): group is Record<string, unknown> => Boolean(group));
    if (taskGroups.length !== taskSources.length) {
      return Response.json({ jobId, status: "running", updatedAt: task.updated_at }, { status: 202 });
    }
    return Response.json({
      jobId,
      status: "completed",
      historyId: task.history_id,
      sessionId: task.session_id,
      searchedAt: stored.history.updatedAt,
      plan: parsedJson<Record<string, unknown>>(task.plan_json, {}),
      history: stored.history,
      groups: taskGroups,
      ai: searchAiReview(task, aiJob),
      productIdentity,
    });
  }
  const historyId = parameters.get("historyId");
  if (historyId !== null) {
    if (!UUID.test(historyId)) {
      return Response.json({ error: "invalid_history_id" }, { status: 400 });
    }
    const stored = await storedHistory(historyId);
    if (!stored) return Response.json({ error: "snapshot_not_available" }, { status: 404 });
    const [aiReviews, productIdentity] = await Promise.all([
      storedSearchAiReviews(stored.history.id),
      storedProductIdentity(stored.history.id),
    ]);
    return Response.json({ ...stored, ai: aiReviews[0], aiReviews, productIdentity });
  }
  const result = await getEnv().DB.prepare(
    `SELECT h.id,h.query,h.sources_json,h.filters_json,h.status,h.result_count,h.source_summary_json,h.searched_at,
       h.search_mode,h.target_json,h.plan_json,h.deep_search,h.session_updated_at,
       (SELECT count(*) FROM search_history page WHERE COALESCE(page.session_id,page.id)=h.id) AS page_count,
       EXISTS(
         SELECT 1 FROM search_history page
         JOIN search_result_snapshots snapshot ON snapshot.search_history_id=page.id
         WHERE COALESCE(page.session_id,page.id)=h.id
       ) AS has_snapshot
     FROM search_history h
     WHERE h.parent_history_id IS NULL
     ORDER BY h.searched_at DESC,h.id DESC LIMIT 30`,
  ).all<SearchHistoryRow>();
  return Response.json({
    items: result.results.map(historyItem),
  });
}

export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  if (!validOrigin(request)) return Response.json({ error: "invalid_origin" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = searchPreviewSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const response = await getEnv().COLLECTOR.fetch("http://collector/internal/search-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...parsed.data, execution: "workflow" }),
  });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
}
