import {
  resolveGeminiSchedulerLimits,
  LISTING_ENRICHMENT_MODEL,
  LISTING_ENRICHMENT_PROMPT_VERSION,
  LISTING_IDENTITY_CONTRACT_VERSION,
  SEARCH_OVERVIEW_MODEL,
  SEARCH_OVERVIEW_PROMPT_VERSION,
  listingEnrichmentProviderRequest,
  listingSemanticProjection,
  parseGeminiRetryDelaySeconds,
  parseListingEnrichmentBatchPartial,
  parseListingIdentityBatch,
  parseSearchOverview,
  safeGeminiTransportError,
  parseProductTargetExtraction,
  PRODUCT_TARGET_MODEL,
  PRODUCT_TARGET_PROMPT_VERSION,
  productTargetProviderRequest,
  searchOverviewProviderRequest,
  takeGeminiTokenBudgetBatch,
} from "@jpgr/ai";
import { readLatestAiListingSemantics } from "@jpgr/analytics";
import {
  type ConfirmPriceDropJob,
  assessProductMatch,
  candidateKey,
  currentTargetPriceEvent,
  describeProductMatchDifference,
  describeProductMatchUnconfirmed,
  evaluateListingEvents,
  KEYWORD_RULE_FALLBACK_REASON,
  listingForDeterministicState,
  newListingDiscoveryKind,
  productTargetExtractionIsEmpty,
  PRODUCT_MATCH_VERSION,
  readBoundedResponseText,
  sha256Hex,
  strongReminderPolicyFromSourceConfig,
  validComparablePrice,
  type GeminiJob,
  type NormalizedListing,
  type ProductFingerprint,
  type ProductMatchRelation,
} from "@jpgr/core";
import { getAdapter } from "@jpgr/adapters";
import {
  RadarRepository,
  type OperationalDatabase,
  type OperationalPreparedStatement,
  type OperationalResult,
  type WatchBindingRow,
} from "@jpgr/db";
import {
  listingEnrichmentBatchRequestSchema,
  listingEnrichmentRequestSchema,
  listingEnrichmentSchema,
  normalizedListingSchema,
  productFingerprintSchema,
  productTargetExtractionRequestSchema,
  productTargetExtractionSchema,
  searchOverviewRequestSchema,
  searchOverviewSchema,
  type ListingEnrichment,
  type ListingEnrichmentBatchRequest,
  type ListingEnrichmentRequest,
  type SearchOverview,
  type ProductTargetExtraction,
  type ProductTargetExtractionRequest,
  type SearchOverviewRequest,
} from "@jpgr/validation";
import type { RuntimeEnv as Env } from "./runtime-env";
import { monitorQueueFor } from "./monitor-queue";
import { z } from "zod";
import { enqueueAiEnrichmentPayload } from "./analytics";
import {
  EXACT_IDENTITY_REASON_TEXT,
  exactProductIdentityDecision,
  materializeProductIdentitiesForAiJob,
  materializeProductIdentityForExactWatch,
} from "./product-identity";
import {
  fetchGeminiWithFallbackKey,
  geminiKeySlots,
  routeGeminiProviderRequest,
  type GeminiKeySlot,
} from "./gemini-gateway";

const KEYWORD_PROMPT_VERSION = "keyword-relevance:v4";
// v3：精确搜索身份判断契约变了（candidateKey 回声、严格批次校验、
// 身份与展示字段分开）。不升版就会命中 v2 的 dedupe_key，新契约永远跑不到。
// 这是精确搜索自己的版本号，不要以为改 listing-semantics 就能作废它的缓存。
export const PRODUCT_SEARCH_PROMPT_VERSION = "product-search-relevance:v3";
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
/**
 * 租约必须明显长过一次执行的最坏耗时，否则会踩进一个会自我放大的循环。
 *
 * 一次执行光等模型就允许 `LISTING_PROVIDER_TIMEOUT_MILLISECONDS`（90 秒），前后还有
 * payload 加载、缓存查询、限流预约、解析和 persistChunk 的批量写入，全都是跨 Hyperdrive
 * 的往返。租约原先是 3 分钟，留给这些的余量只有 90 秒。租约一过期，每分钟跑的
 * `recoverGeminiJobs` 就把它当成卡死的任务重新入队，而 `claimJob` 允许重领过期租约——
 * 于是第二个执行开始处理同一个任务，第一个还在等模型。同一批商品被重复问一遍
 * （账单照付，AI Gateway 那边每次都是成功的），两个执行互相覆盖，谁的结果都落不了库，
 * 消息量还翻倍，把本就串行的判定队列堵得更死。越慢→租约越容易过期→重复越多→越慢。
 *
 * 2026-09-21 就是这个循环被越过临界点：爱蜜莉雅 7 个判定任务同时压进单车道，
 * 最后集体进死信，当天整封行情日报没发。跑了两个月没事不代表安全，只代表
 * 一直没到临界点——关键词越多、撞在同一分钟的概率越大，越容易翻车。
 *
 * 代价是真正卡死的任务要多等几分钟才被巡检捞回，这远比重复调用和雪崩便宜。
 */
const JOB_LEASE_MILLISECONDS = 10 * 60_000;
const RESERVATION_WINDOW_MILLISECONDS = 60_000;
const MAX_ITEM_PARSE_ATTEMPTS = 3;
const MAX_TRANSIENT_ATTEMPTS = 10;
/**
 * 一条队列消息投递失败，不等于整个判定任务该死。
 *
 * 队列的 max_retries 是按**单条消息**计数的，而一个分批任务要靠许多条消息才跑得完
 * （每次只处理一个 token 预算内的批次，剩下的重新入队）。这类任务真正的驱动力是
 * `recoverGeminiJobs`——它每分钟把 queued/processing 的任务重新排上。所以消息耗尽时
 * 先把任务退回 queued 交还给巡检，只有反复复活仍然推不动才真的判死。
 *
 * 2026-09-21：爱蜜莉雅当天 7 个判定任务里 5 个被这一击钉死（animate 只有 6 件商品、
 * rakuten 20 件，都远没到跑不动的量），而 `failed` 恰好不在 recoverGeminiJobs 的扫描
 * 范围内，自愈从此看不见它们，189 件商品的判定永久停在未决。当天整封行情关键词日报
 * 没有发出，数据库里只留下 `queue_dead_lettered:...`，既没有上游状态也没有错误原因——
 * 因为执行是被运行时中断的，代码里每一条会留痕的错误路径都没走到；AI Gateway 那边
 * 每次调用都是成功的。判定悄悄丢了一整天，系统没有任何一处说出来。
 */
const MAX_DEAD_LETTER_REVIVALS = 12;
const INLINE_JOB_PAYLOAD_BYTES = 1_500_000;
const JOB_PAYLOAD_CHUNK_BYTES = 500_000;
/**
 * 必须小于数据库的 `idle_in_transaction_session_timeout`（生产是 60 秒）。
 *
 * 等模型返回的这段时间里连接是「事务开着但没有语句在跑」，PostgreSQL 数到
 * idle 超时就会直接把连接杀掉。原先这里是 90 秒，比 60 秒大——于是任何一次
 * 超过一分钟的模型调用，结果都注定写不回去：模型正常返回（AI Gateway 每次
 * 都记成功），代码回头要写库时连接已经死了，连把错误记下来都失败，消息重试
 * 耗尽进死信，数据库里只剩一行没有上游状态也没有原因的 `queue_dead_lettered`。
 *
 * 2026-09-21 就是这么丢掉一整天的：故障窗口里 PostgreSQL 持续打出
 * `terminating connection due to idle-in-transaction timeout`，而同一小时
 * Worker 执行 154 次全部 outcome=ok。件数越多越容易中招——cospa 3 件、
 * 雅虎二手 1 件几秒就回来，安全；charaon 39 件、mercari 68 件要几十秒，踩线。
 *
 * 55 秒留 5 秒余量。真有超过这个数的慢响应，现在会走 requeueTransient 重试
 * 并留下错误原因，而不是被数据库无声掐断。调大它之前先调大数据库那一侧，
 * 这两个数字永远是一对。
 */
const LISTING_PROVIDER_TIMEOUT_MILLISECONDS = 55_000;
const MARKET_CLAIM_ORPHAN_MILLISECONDS = 5 * 60_000;
const MARKET_CLAIM_COMPLETED_HOLD_MILLISECONDS = 15 * 60_000;

type GeminiEnv = Env & { GEMINI_QUEUE: Queue<GeminiJob> };
type ItemState = "pending" | "ready" | "failed";

interface GeminiJobRow {
  id: string;
  kind: "listing_enrichment" | "keyword_enrichment" | "search_overview" | "market_analysis" | "product_target";
  status: "staging" | "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed";
  dedupe_key: string;
  model: string;
  prompt_version: string;
  payload_json: string;
  result_json: string | null;
  total_items: number;
  completed_items: number;
  failed_items: number;
  binding_id: string | null;
  watch_run_id: string | null;
  trigger_type: string | null;
  scan_started_at: string | null;
  attempt_count: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  upstream_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const listingJobPayloadSchema = z.object({
  query: z.string().max(500),
  /**
   * 声明了身份判断契约的任务走严格校验（回声 candidateKey、拒收结构错误）。
   * 缺省不声明，关键词与行情链路的旧任务照旧跑。
   */
  contract: z.string().min(1).max(80).optional(),
  items: z.array(listingEnrichmentRequestSchema).min(1).max(1_000),
  inputHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(1_000),
  relevanceContext: z.object({
    targetLabel: z.string().max(200).optional(),
    targetDescription: z.string().max(1_000).optional(),
    includeTerms: z.array(z.string().max(180)).max(100).optional(),
    excludeTerms: z.array(z.string().max(180)).max(100).optional(),
  }).strict().optional(),
  keyword: z.object({
    bindingId: z.string().min(1).max(200),
    watchRunId: z.string().min(1).max(200),
    trigger: z.enum(["cron", "manual", "retry", "confirmation"]),
    scanStartedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    baselineCompleted: z.boolean(),
    /** 采集这一轮时该绑定的上新水位线，用于区分"新上架"与"我们第一次看见"。 */
    watermark: z.string().max(80).optional(),
    listings: z.array(normalizedListingSchema).min(1).max(1_000),
    searchMode: z.enum(["keyword", "exact_product"]).default("keyword"),
    productTarget: productFingerprintSchema.optional(),
    matchRelations: z.array(z.enum([
      "exact", "probable_exact", "variant", "bundle", "related", "irrelevant", "uncertain",
    ])).max(1_000).optional(),
    matcherVersion: z.string().min(1).max(100).optional(),
  }).strict().optional(),
  market: z.object({
    subscriptionKey: z.string().min(1).max(400),
    scopeVersionId: z.string().min(1).max(200).optional(),
    bindingId: z.string().min(1).max(200),
    watchRunId: z.string().min(1).max(200),
    trigger: z.enum(["cron", "manual", "retry", "confirmation", "analysis_backfill"]),
    scanStartedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    events: z.array(z.object({
      kind: z.enum(["new", "changed"]),
      firstSeenRunId: z.string().min(1).max(200),
      firstSeenAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    }).strict()).min(1).max(1_000),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.items.length !== value.inputHashes.length) {
    context.addIssue({ code: "custom", path: ["inputHashes"], message: "Input hash count mismatch" });
  }
  if (value.keyword && value.keyword.listings.length !== value.items.length) {
    context.addIssue({ code: "custom", path: ["keyword", "listings"], message: "Keyword listing count mismatch" });
  }
  if (value.keyword?.searchMode === "exact_product") {
    if (!value.keyword.productTarget) {
      context.addIssue({ code: "custom", path: ["keyword", "productTarget"], message: "Exact-product target missing" });
    }
    if (!value.keyword.matchRelations || value.keyword.matchRelations.length !== value.items.length) {
      context.addIssue({ code: "custom", path: ["keyword", "matchRelations"], message: "Exact-product relation count mismatch" });
    }
  }
  if (value.market && value.market.events.length !== value.items.length) {
    context.addIssue({ code: "custom", path: ["market", "events"], message: "Market event count mismatch" });
  }
});

type ListingJobPayload = z.infer<typeof listingJobPayloadSchema>;

const jobResultSchema = z.object({
  items: z.array(listingEnrichmentSchema.nullable()).max(1_000),
  states: z.array(z.enum(["pending", "ready", "failed"])).max(1_000),
  parseAttempts: z.array(z.number().int().min(0).max(MAX_ITEM_PARSE_ATTEMPTS)).max(1_000),
  // 模型等待超时后本任务的批量上限，见 `shrinkBatchAfterTimeout`。旧任务没有这个字段。
  batchCap: z.number().int().min(1).max(1_000).optional(),
}).strict();

type JobResult = z.infer<typeof jobResultSchema>;

const searchOverviewJobPayloadSchema = z.object({
  input: searchOverviewRequestSchema,
}).strict();

const searchOverviewJobResultSchema = z.object({
  overview: searchOverviewSchema,
}).strict();

type SearchOverviewJobPayload = z.infer<typeof searchOverviewJobPayloadSchema>;

const productTargetJobPayloadSchema = z.object({
  input: productTargetExtractionRequestSchema,
}).strict();
const productTargetJobResultSchema = z.object({
  extraction: productTargetExtractionSchema,
}).strict();
type ProductTargetJobPayload = z.infer<typeof productTargetJobPayloadSchema>;

const payloadManifestSchema = z.object({
  storage: z.literal("chunks"),
  count: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export interface KeywordGeminiJobInput {
  bindingId: string;
  watchRunId: string;
  trigger: "cron" | "manual" | "retry" | "confirmation";
  scanStartedAt: string;
  baselineCompleted: boolean;
  /** 采集这一轮时的上新水位线；来源不提供上架时间时为 undefined。 */
  watermark?: string;
  query: string;
  targetLabel?: string;
  targetDescription?: string;
  listings: readonly NormalizedListing[];
  includeTerms: readonly string[];
  excludeTerms: readonly string[];
  searchMode?: "keyword" | "exact_product";
  productTarget?: ProductFingerprint;
  matchRelations?: readonly ProductMatchRelation[];
  matcherVersion?: string;
}

export interface MarketGeminiJobInput {
  subscriptionKey: string;
  scopeVersionId?: string;
  bindingId: string;
  watchRunId: string;
  trigger: "cron" | "manual" | "retry" | "confirmation" | "analysis_backfill";
  scanStartedAt: string;
  query: string;
  targetLabel?: string;
  targetDescription?: string;
  includeTerms: readonly string[];
  excludeTerms: readonly string[];
  items: readonly {
    listing: NormalizedListing;
    kind: "new" | "changed";
    firstSeenRunId: string;
    firstSeenAt: string;
  }[];
}

export interface MarketGeminiEnqueueResult {
  jobId: string | null;
  claimedItems: number;
}

export interface ProductSearchGeminiJobInput {
  query: string;
  target?: ProductFingerprint;
  listings: readonly NormalizedListing[];
}

export interface ProductSearchGeminiEnqueueResult {
  jobId: string | null;
  candidateKeys: string[];
  skippedItems: number;
}

export interface KeywordGeminiEnqueueResult {
  jobId: string | null;
  queuedItems: number;
  skippedItems: number;
}

export interface GeminiProcessResult {
  deliverPendingEmails: boolean;
}

/**
 * 详情跟踪的准入条件。来源支持单品查询只是必要条件：Mercari Shops 这类商品
 * 搜索得到、详情接口却查不到，把它们排进跟踪只会每天固定失败一次，也会白白
 * 排队一次注定失败的降价二次确认。
 */
export function itemLookupSupportedFor(sourceId: Parameters<typeof getAdapter>[0], sourceItemId: string): boolean {
  const adapter = getAdapter(sourceId);
  return Boolean(adapter?.getItem) && adapter?.canGetItem?.(sourceItemId) !== false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function jsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (current.length > 0 && currentBytes + characterBytes > maxBytes) {
      chunks.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(character);
    currentBytes += characterBytes;
  }
  if (current.length > 0) chunks.push(current.join(""));
  return chunks;
}

async function storedPayload(payload: unknown): Promise<{ databaseValue: string; chunks: string[] }> {
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength <= INLINE_JOB_PAYLOAD_BYTES) {
    return { databaseValue: serialized, chunks: [] };
  }
  const chunks = splitUtf8(serialized, JOB_PAYLOAD_CHUNK_BYTES);
  return {
    databaseValue: JSON.stringify({
      storage: "chunks",
      count: chunks.length,
      contentHash: await sha256Hex(serialized),
    }),
    chunks,
  };
}

async function writePayloadChunks(env: GeminiEnv, jobId: string, chunks: readonly string[]): Promise<void> {
  for (const [index, chunk] of chunks.entries()) {
    await env.DB.prepare(
      "INSERT INTO gemini_job_payload_chunks(job_id,chunk_index,payload_chunk) VALUES(?,?,?)",
    ).bind(jobId, index, chunk).run();
  }
}

async function loadJobPayload(env: GeminiEnv, row: GeminiJobRow): Promise<unknown> {
  const manifest = payloadManifestSchema.safeParse(jsonValue(row.payload_json));
  if (!manifest.success) return jsonValue(row.payload_json);
  const chunks = await env.DB.prepare(
    "SELECT chunk_index,payload_chunk FROM gemini_job_payload_chunks WHERE job_id=? ORDER BY chunk_index",
  ).bind(row.id).all<{ chunk_index: number; payload_chunk: string }>();
  if (chunks.results.length !== manifest.data.count
      || chunks.results.some((chunk, index) => chunk.chunk_index !== index)) {
    throw new Error("gemini_job_payload_chunks_incomplete");
  }
  const serialized = chunks.results.map((chunk) => chunk.payload_chunk).join("");
  if (await sha256Hex(serialized) !== manifest.data.contentHash) {
    throw new Error("gemini_job_payload_hash_mismatch");
  }
  return jsonValue(serialized);
}

async function runStatementBatches(
  db: OperationalDatabase,
  statements: readonly OperationalPreparedStatement[],
): Promise<OperationalResult<unknown>[]> {
  const results: OperationalResult<unknown>[] = [];
  for (let offset = 0; offset < statements.length; offset += 100) {
    results.push(...await db.batch(statements.slice(offset, offset + 100)));
  }
  return results;
}

async function marketCleaningClaimKey(
  subscriptionKey: string,
  item: Pick<ListingEnrichmentRequest, "sourceId" | "sourceItemId">,
  model: string = LISTING_ENRICHMENT_MODEL.model,
  promptVersion: string = LISTING_ENRICHMENT_PROMPT_VERSION,
  scopeVersionId = "legacy",
): Promise<string> {
  return sha256Hex(JSON.stringify({
    subscriptionKey,
    scopeVersionId,
    sourceId: item.sourceId,
    sourceItemId: item.sourceItemId,
    model,
    promptVersion,
  }));
}

async function pruneReclaimableMarketClaims(env: GeminiEnv): Promise<void> {
  const orphanCutoff = new Date(Date.now() - MARKET_CLAIM_ORPHAN_MILLISECONDS).toISOString();
  const terminalCutoff = new Date(Date.now() - MARKET_CLAIM_COMPLETED_HOLD_MILLISECONDS).toISOString();
  await env.DB.prepare(
    `DELETE FROM market_listing_cleaning_claims
     WHERE (job_id IS NULL AND updated_at<=?)
        OR (job_id IS NOT NULL AND updated_at<=? AND NOT EXISTS (
          SELECT 1 FROM gemini_jobs job
          WHERE job.id=market_listing_cleaning_claims.job_id
            AND job.status IN ('staging','queued','processing','waiting_rate_limit')
        ))`,
  ).bind(orphanCutoff, terminalCutoff).run();
}

async function synchronizeActiveMarketClaims(env: GeminiEnv, subscriptionKey: string): Promise<void> {
  const active = await env.DB.prepare(
    `SELECT * FROM gemini_jobs
     WHERE kind='listing_enrichment'
       AND model=? AND prompt_version=?
       AND status IN ('staging','queued','processing','waiting_rate_limit')
     ORDER BY created_at,id`,
  ).bind(LISTING_ENRICHMENT_MODEL.model, LISTING_ENRICHMENT_PROMPT_VERSION).all<GeminiJobRow>();
  const createdAt = nowIso();
  const statements: OperationalPreparedStatement[] = [];
  for (const row of active.results) {
    let parsed: ReturnType<typeof listingJobPayloadSchema.safeParse>;
    try {
      parsed = listingJobPayloadSchema.safeParse(await loadJobPayload(env, row));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "market_cleaning_claim_sync_skipped",
        jobId: row.id,
        error: safeJobError(error),
      }));
      continue;
    }
    if (!parsed.success || parsed.data.market?.subscriptionKey !== subscriptionKey) continue;
    for (const item of parsed.data.items) {
      const claimKey = await marketCleaningClaimKey(subscriptionKey, item, undefined, undefined, parsed.data.market.scopeVersionId);
      statements.push(env.DB.prepare(
        `INSERT INTO market_listing_cleaning_claims(
           claim_key,subscription_key,source_id,source_item_id,model,prompt_version,
           job_id,status,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,'active',?,?)
         ON CONFLICT(claim_key) DO UPDATE SET
           job_id=excluded.job_id,status='active',updated_at=excluded.updated_at
         WHERE market_listing_cleaning_claims.job_id IS NULL`,
      ).bind(
        claimKey,
        subscriptionKey,
        item.sourceId,
        item.sourceItemId,
        LISTING_ENRICHMENT_MODEL.model,
        LISTING_ENRICHMENT_PROMPT_VERSION,
        row.id,
        createdAt,
        createdAt,
      ));
    }
  }
  await runStatementBatches(env.DB, statements);
}

async function claimMarketItems(
  env: GeminiEnv,
  subscriptionKey: string,
  scopeVersionId: string | undefined,
  items: readonly ListingEnrichmentRequest[],
): Promise<{ indexes: number[]; claimKeys: string[] }> {
  await pruneReclaimableMarketClaims(env);
  await synchronizeActiveMarketClaims(env, subscriptionKey);
  const unique = new Map<string, { index: number; item: ListingEnrichmentRequest }>();
  for (const [index, item] of items.entries()) {
    const claimKey = await marketCleaningClaimKey(subscriptionKey, item, undefined, undefined, scopeVersionId);
    if (!unique.has(claimKey)) unique.set(claimKey, { index, item });
  }
  const claimedAt = nowIso();
  const candidates = [...unique.entries()];
  const results = await runStatementBatches(env.DB, candidates.map(([claimKey, candidate]) => (
    env.DB.prepare(
      `INSERT INTO market_listing_cleaning_claims(
         claim_key,subscription_key,source_id,source_item_id,model,prompt_version,
         job_id,status,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,NULL,'active',?,?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      claimKey,
      subscriptionKey,
      candidate.item.sourceId,
      candidate.item.sourceItemId,
      LISTING_ENRICHMENT_MODEL.model,
      LISTING_ENRICHMENT_PROMPT_VERSION,
      claimedAt,
      claimedAt,
    )
  )));
  const indexes: number[] = [];
  const claimKeys: string[] = [];
  results.forEach((result, index) => {
    if (Number(result.meta.changes) === 0) return;
    indexes.push(candidates[index]![1].index);
    claimKeys.push(candidates[index]![0]);
  });
  return { indexes, claimKeys };
}

async function enforceMarketClaimOwnership(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ListingJobPayload,
  result: JobResult,
): Promise<number> {
  const market = payload.market;
  if (!market) return 0;
  const updatedAt = nowIso();
  const claimKeys = await Promise.all(payload.items.map((item) => (
    marketCleaningClaimKey(market.subscriptionKey, item, row.model, row.prompt_version, market.scopeVersionId)
  )));
  await runStatementBatches(env.DB, payload.items.map((item, index) => (
    env.DB.prepare(
      `INSERT INTO market_listing_cleaning_claims(
         claim_key,subscription_key,source_id,source_item_id,model,prompt_version,
         job_id,status,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(claim_key) DO UPDATE SET
         job_id=excluded.job_id,status='active',updated_at=excluded.updated_at
       WHERE market_listing_cleaning_claims.job_id IS NULL`,
    ).bind(
      claimKeys[index]!,
      market.subscriptionKey,
      item.sourceId,
      item.sourceItemId,
      row.model,
      row.prompt_version,
      row.id,
      updatedAt,
      updatedAt,
    )
  )));
  const owners = new Map<string, string | null>();
  for (let offset = 0; offset < claimKeys.length; offset += 80) {
    const chunk = claimKeys.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT claim_key,job_id FROM market_listing_cleaning_claims WHERE claim_key IN (${placeholders})`,
    ).bind(...chunk).all<{ claim_key: string; job_id: string | null }>();
    rows.results.forEach((owner) => owners.set(owner.claim_key, owner.job_id));
  }
  let skipped = 0;
  claimKeys.forEach((claimKey, index) => {
    const owner = owners.get(claimKey);
    if (!owner || owner === row.id) return;
    if (result.states[index] === "pending") {
      result.states[index] = "failed";
      result.items[index] = null;
    }
    skipped += 1;
  });
  return skipped;
}

function safeJobError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/https?:\/\/\S+/gu, "[redacted-url]")
    .replace(/[A-Za-z0-9_-]{40,}/gu, "[redacted-value]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500) || "gemini_job_failed";
}

function initialResult(total: number): JobResult {
  return {
    items: Array.from({ length: total }, () => null),
    states: Array.from({ length: total }, () => "pending" as const),
    parseAttempts: Array.from({ length: total }, () => 0),
  };
}

function resultFromRow(row: GeminiJobRow): JobResult {
  const parsed = row.result_json ? jobResultSchema.safeParse(JSON.parse(row.result_json) as unknown) : null;
  if (!parsed?.success || parsed.data.items.length !== row.total_items
      || parsed.data.states.length !== row.total_items || parsed.data.parseAttempts.length !== row.total_items) {
    throw new Error("gemini_job_result_invalid");
  }
  return parsed.data;
}

function resultCounts(result: JobResult): { completed: number; failed: number } {
  return {
    completed: result.states.filter((state) => state === "ready").length,
    failed: result.states.filter((state) => state === "failed").length,
  };
}

async function cachedResult(
  env: GeminiEnv,
  items: readonly ListingEnrichmentRequest[],
  inputHashes: readonly string[],
  promptVersion: string,
): Promise<JobResult> {
  const result = initialResult(items.length);
  try {
    const cached = await readLatestAiListingSemantics(
      env.ANALYTICS_DB.connectionString,
      items.map((item, index) => ({
        sourceId: item.sourceId,
        sourceItemId: item.sourceItemId,
        inputHash: inputHashes[index]!,
      })),
      LISTING_ENRICHMENT_MODEL.model,
      promptVersion,
    );
    const byHash = new Map(cached.map((item) => [item.inputHash, item.output]));
    inputHashes.forEach((hash, index) => {
      const parsed = listingEnrichmentSchema.safeParse(byHash.get(hash));
      if (!parsed.success) return;
      result.items[index] = parsed.data;
      result.states[index] = "ready";
    });
  } catch (error) {
    // Postgres 不可用不能挡住任务本身，但也不能默默吞掉：这条缓存是唯一挡在
    // 全量重清洗前面的东西，静默失效的表现就是账单翻倍而日志一片干净。
    console.warn(JSON.stringify({
      event: "gemini_listing_cache_unavailable",
      items: items.length,
      promptVersion,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: safeJobError(error),
    }));
  }
  return result;
}

async function enqueueJobMessage(env: GeminiEnv, jobId: string, delaySeconds?: number): Promise<boolean> {
  try {
    const queuedAt = nowIso();
    await env.GEMINI_QUEUE.send(
      {
        type: "gemini_job",
        // A Gemini job can intentionally enqueue several continuation messages.
        // The dispatch id deduplicates Cloudflare redelivery without suppressing
        // the next legitimate chunk of the same durable job.
        idempotencyKey: `gemini_job:${jobId}:${crypto.randomUUID()}`,
        jobId,
        queuedAt,
      } satisfies GeminiJob,
      delaySeconds === undefined ? { contentType: "json" } : { contentType: "json", delaySeconds },
    );
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "gemini_job_dispatch_failed",
      jobId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: safeJobError(error),
    }));
    return false;
  }
}

export async function markGeminiJobDeadLettered(
  env: Pick<GeminiEnv, "DB">,
  jobId: string,
  deadLetterQueueName: string,
): Promise<void> {
  const now = nowIso();
  const row = await env.DB.prepare(
    "SELECT status,attempt_count,total_items,completed_items FROM gemini_jobs WHERE id=?",
  ).bind(jobId).first<Pick<GeminiJobRow, "status" | "attempt_count" | "total_items" | "completed_items">>();
  if (!row || ["completed", "partial", "failed"].includes(row.status)) return;
  const attempts = Number(row.attempt_count ?? 0);
  const totalItems = Number(row.total_items ?? 0);
  const completedItems = Number(row.completed_items ?? 0);
  // attempt_count 数的是「领取过几次」，正常的分批推进也会把它顶上去——一个 68 件的
  // 任务光跑完就要好几次。所以阈值必须区分推不动和跑得慢：一件都没判出来的才是
  // 真的推不动，有进展的给足余量。2026-09-21 第一版没分：charaon 用了 13 次才跑完
  // 39 件（差一点就被 12 次掐死），mercari 判到 37/68 时撞上上限被判死，剩下 31 件
  // 再没人看过一眼。
  const revivalLimit = completedItems === 0 ? MAX_DEAD_LETTER_REVIVALS : MAX_DEAD_LETTER_REVIVALS * 4;
  if (attempts < revivalLimit) {
    // 退回 queued 而不是终结。updated_at 停在此刻，于是它落在 recoverGeminiJobs
    // 的扫描窗口（queued 且静默满两分钟）之外，两分钟后由巡检重新排上——
    // 这里不立刻再投一条消息，那只会立刻再被同样的原因打断一次。
    // 清洗认领要留着：任务还没结束，这些条目仍归它所有。
    await env.DB.prepare(
      `UPDATE gemini_jobs
       SET status='queued',lease_expires_at=NULL,next_attempt_at=NULL,last_error=?,updated_at=?
       WHERE id=? AND status NOT IN ('completed','partial','failed')`,
    ).bind(
      `queue_delivery_exhausted:${deadLetterQueueName}（第 ${attempts} 次投递被中断，已退回重排）`.slice(0, 500),
      now,
      jobId,
    ).run();
    console.warn(JSON.stringify({
      event: "gemini_job_revived_from_dead_letter",
      jobId,
      queue: deadLetterQueueName,
      attemptCount: attempts,
      totalItems,
      completedItems,
    }));
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM market_listing_cleaning_claims WHERE job_id=?").bind(jobId),
    env.DB.prepare(
      `UPDATE gemini_jobs
       SET status='failed',last_error=?,lease_expires_at=NULL,next_attempt_at=NULL,
           updated_at=?,completed_at=COALESCE(completed_at,?)
       WHERE id=? AND status NOT IN ('completed','partial','failed')`,
    ).bind(
      `queue_dead_lettered:${deadLetterQueueName}（复活 ${attempts} 次仍未跑完，${completedItems}/${totalItems} 件已判定）`
        .slice(0, 500),
      now,
      now,
      jobId,
    ),
  ]);
  // 判死一个判定任务 = 这批商品当天不会再被看一眼。这是最后一道留痕，
  // 上面那条 warn 只说明它还在重试，这条才意味着有东西真的丢了。
  console.error(JSON.stringify({
    event: "gemini_job_dead_lettered",
    jobId,
    queue: deadLetterQueueName,
    attemptCount: attempts,
    totalItems,
    completedItems,
    abandonedItems: Math.max(0, totalItems - completedItems),
  }));
}

async function existingJob(env: GeminiEnv, kind: GeminiJobRow["kind"], dedupeKey: string): Promise<GeminiJobRow | null> {
  return env.DB.prepare("SELECT * FROM gemini_jobs WHERE kind=? AND dedupe_key=?")
    .bind(kind, dedupeKey).first<GeminiJobRow>();
}

async function insertListingJob(
  env: GeminiEnv,
  input: {
    kind: "listing_enrichment" | "keyword_enrichment";
    dedupeKey: string;
    promptVersion: string;
    payload: ListingJobPayload;
    result: JobResult;
  },
): Promise<GeminiJobRow> {
  const found = await existingJob(env, input.kind, input.dedupeKey);
  if (found) return found;
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const counts = resultCounts(input.result);
  const needsFinalization = input.kind === "keyword_enrichment";
  const terminal = counts.completed === input.payload.items.length && !needsFinalization;
  const payloadStorage = await storedPayload(input.payload);
  let inserted = false;
  try {
    await env.DB.prepare(
      `INSERT INTO gemini_jobs(
         id,kind,status,dedupe_key,model,prompt_version,payload_json,result_json,
         total_items,completed_items,failed_items,binding_id,watch_run_id,trigger_type,
         scan_started_at,created_at,updated_at,completed_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      input.kind,
      payloadStorage.chunks.length > 0 ? "staging" : terminal ? "completed" : "queued",
      input.dedupeKey,
      LISTING_ENRICHMENT_MODEL.model,
      input.promptVersion,
      payloadStorage.databaseValue,
      JSON.stringify(input.result),
      input.payload.items.length,
      counts.completed,
      counts.failed,
      input.payload.keyword?.bindingId ?? input.payload.market?.bindingId ?? null,
      input.payload.keyword?.watchRunId ?? input.payload.market?.watchRunId ?? null,
      input.payload.keyword?.trigger ?? input.payload.market?.trigger ?? null,
      input.payload.keyword?.scanStartedAt ?? input.payload.market?.scanStartedAt ?? null,
      createdAt,
      createdAt,
      terminal ? createdAt : null,
    ).run();
    inserted = true;
    if (payloadStorage.chunks.length > 0) {
      await writePayloadChunks(env, id, payloadStorage.chunks);
      await env.DB.prepare(
        "UPDATE gemini_jobs SET status=?,updated_at=?,completed_at=? WHERE id=? AND status='staging'",
      ).bind(terminal ? "completed" : "queued", nowIso(), terminal ? nowIso() : null, id).run();
    }
  } catch (error) {
    if (inserted) await env.DB.prepare("DELETE FROM gemini_jobs WHERE id=?").bind(id).run().catch(() => undefined);
    const raced = await existingJob(env, input.kind, input.dedupeKey);
    if (raced) return raced;
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=?").bind(id).first<GeminiJobRow>();
  if (!row) throw new Error("gemini_job_insert_failed");
  if (!terminal) await enqueueJobMessage(env, id);
  return row;
}

async function insertSingleJob(
  env: GeminiEnv,
  input: {
    kind: "search_overview" | "product_target";
    dedupeKey: string;
    promptVersion: string;
    payload: SearchOverviewJobPayload | ProductTargetJobPayload;
  },
): Promise<GeminiJobRow> {
  const found = await existingJob(env, input.kind, input.dedupeKey);
  if (found) return found;
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const payloadStorage = await storedPayload(input.payload);
  let inserted = false;
  try {
    await env.DB.prepare(
      `INSERT INTO gemini_jobs(
         id,kind,status,dedupe_key,model,prompt_version,payload_json,
         total_items,completed_items,failed_items,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,0,0,0,?,?)`,
    ).bind(
      id,
      input.kind,
      payloadStorage.chunks.length > 0 ? "staging" : "queued",
      input.dedupeKey,
      LISTING_ENRICHMENT_MODEL.model,
      input.promptVersion,
      payloadStorage.databaseValue,
      createdAt,
      createdAt,
    ).run();
    inserted = true;
    if (payloadStorage.chunks.length > 0) {
      await writePayloadChunks(env, id, payloadStorage.chunks);
      await env.DB.prepare(
        "UPDATE gemini_jobs SET status='queued',updated_at=? WHERE id=? AND status='staging'",
      ).bind(nowIso(), id).run();
    }
  } catch (error) {
    if (inserted) await env.DB.prepare("DELETE FROM gemini_jobs WHERE id=?").bind(id).run().catch(() => undefined);
    const raced = await existingJob(env, input.kind, input.dedupeKey);
    if (raced) return raced;
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=?").bind(id).first<GeminiJobRow>();
  if (!row) throw new Error("gemini_job_insert_failed");
  await enqueueJobMessage(env, id);
  return row;
}

export async function createListingGeminiJob(
  env: GeminiEnv,
  request: ListingEnrichmentBatchRequest,
): Promise<GeminiJobRow> {
  const inputHashes = await Promise.all(request.items.map((item) => (
    sha256Hex(JSON.stringify({ query: request.query, input: listingSemanticProjection(item) }))
  )));
  const payload: ListingJobPayload = { query: request.query, items: request.items, inputHashes };
  const result = initialResult(request.items.length);
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: "listing_enrichment",
    model: LISTING_ENRICHMENT_MODEL.model,
    promptVersion: LISTING_ENRICHMENT_PROMPT_VERSION,
    query: request.query,
    inputHashes,
  }));
  return insertListingJob(env, {
    kind: "listing_enrichment",
    dedupeKey,
    promptVersion: LISTING_ENRICHMENT_PROMPT_VERSION,
    payload,
    result,
  });
}

type ListingDerivativePreparation =
  | { kind: "accepted"; listing: NormalizedListing; request: ListingEnrichmentRequest }
  | { kind: "rejected"; issuePaths: string[] };

function listingIssuePaths(issues: readonly { path: PropertyKey[] }[]): string[] {
  return [...new Set(issues.slice(0, 8).map((issue) => issue.path.map(String).join(".") || "listing"))];
}

function prepareListingDerivative(listing: NormalizedListing): ListingDerivativePreparation {
  const facts = listing.facts ? {
    ...listing.facts,
    characters: listing.facts.characters?.slice(0, 40),
    categoryPath: listing.facts.categoryPath?.slice(0, 20),
    tags: listing.facts.tags?.slice(0, 80),
    imageUrls: listing.facts.imageUrls?.slice(0, 30),
    specifications: listing.facts.specifications?.slice(0, 50),
    variants: listing.facts.variants?.slice(0, 100),
    displayFacts: listing.facts.displayFacts?.slice(0, 40).map((fact) => fact.kind === "list"
      ? { ...fact, values: fact.values.slice(0, 20) }
      : fact),
  } : undefined;
  const normalized = normalizedListingSchema.safeParse({
    ...listing,
    // rawMetadata 整体丢掉是为了不给清洗模型送它用不上的字节，但 detailHydrated
    // 这一位必须留下：精确同款路径**不**在采集时落库（index.ts 排完 AI 任务就
    // return 了），listings 的唯一写入点是本文件下面的 persistListing，而它靠这一位
    // 推进 listings.detail_hydrated_at。抹掉它，水位永远是 NULL，
    // EXACT_PRODUCT_DETAIL_HYDRATION_TTL_MS 那道去重就恒不成立——2026-09-07 到
    // 09-08 之间就是这样：详情请求照发，水位 0 行，去重完全没生效。
    rawMetadata: listing.rawMetadata?.detailHydrated === true ? { detailHydrated: true } : undefined,
    facts,
  });
  if (!normalized.success) return { kind: "rejected", issuePaths: listingIssuePaths(normalized.error.issues) };
  const request = listingEnrichmentRequestSchema.safeParse({
    ...normalized.data,
    sourceConditionLabel: facts?.sourceConditionLabel,
    category: facts?.categoryPath?.at(-1),
  });
  if (!request.success) return { kind: "rejected", issuePaths: listingIssuePaths(request.error.issues) };
  return { kind: "accepted", listing: normalized.data, request: request.data };
}

function productSearchEnrichmentRequest(listing: NormalizedListing): ListingEnrichmentRequest | undefined {
  const prepared = prepareListingDerivative(listing);
  return prepared.kind === "accepted" ? prepared.request : undefined;
}

function productSearchRelevanceContext(target: ProductFingerprint) {
  const facts = [
    ["具体商品名", target.canonicalName],
    ["作品", target.workTitle],
    ["角色", target.characters.join("、") || undefined],
    ["品类", target.productType],
    ["厂商", target.manufacturer],
    ["系列", target.series],
    ["型号", target.model],
    ["JAN", target.jan],
    ["尺寸", target.size],
    ["颜色", target.color],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const targetDescription = [
    `用户提交的完整商品名“${target.canonicalName ?? ""}”是目标身份的权威输入；下面的结构化字段可能由启发式拆分得到，只能辅助判断，不能覆盖完整商品名。`,
    "这里判断的是同一个具体商品身份，不是宽泛的作品或角色相关性。",
    "只有角色、品类、厂商、系列、型号、尺寸、颜色与限定版本不存在冲突，且商品文本足以连接到目标时才判 relevant。",
    "不同角色、不同型号、尺寸或颜色、其他厂商或系列、套装、替代版本以及仅同作品的周边应判 irrelevant；证据不足时判 uncertain。",
    ...(target.requiredTermGroups?.length
      ? [`卖家标题必须命中以下每个身份组（组内“|”是别名）：${target.requiredTermGroups.join("；")}`]
      : []),
    ...(target.supportingTermGroups?.length
      ? [`残缺标题至少应命中一组辅助证据：${target.supportingTermGroups.join("；")}`]
      : []),
    ...(target.excludedTerms.length
      ? [`命中以下冲突版本应判 irrelevant：${target.excludedTerms.join("、")}`]
      : []),
    ...facts.map(([name, value]) => `${name}：${value}`),
  ].join("\n").slice(0, 1_000);
  return {
    targetLabel: `具体同款：${target.canonicalName ?? target.characters[0] ?? target.workTitle ?? "目标商品"}`.slice(0, 200),
    targetDescription,
    includeTerms: [...new Set([
      target.canonicalName,
      target.workTitle,
      ...target.characters,
      target.productType,
      target.manufacturer,
      target.series,
      target.model,
      target.jan,
      target.size,
      target.color,
      ...target.aliases,
      ...(target.recallQueries ?? []),
      ...(target.requiredTermGroups ?? []),
      ...(target.supportingTermGroups ?? []),
    ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().slice(0, 180)))].slice(0, 100),
    excludeTerms: [...new Set(target.excludedTerms.map((value) => value.trim().slice(0, 180)).filter(Boolean))].slice(0, 100),
  };
}

export async function enqueueProductSearchGeminiJob(
  env: GeminiEnv,
  input: ProductSearchGeminiJobInput,
): Promise<ProductSearchGeminiEnqueueResult> {
  const accepted: Array<{ key: string; item: ListingEnrichmentRequest }> = [];
  const seen = new Set<string>();
  for (const listing of input.listings) {
    const key = candidateKey(listing.sourceId, listing.sourceItemId);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = productSearchEnrichmentRequest(listing);
    if (item) accepted.push({ key, item });
  }
  if (accepted.length === 0) {
    return { jobId: null, candidateKeys: [], skippedItems: input.listings.length };
  }
  const relevanceContext = input.target ? productSearchRelevanceContext(input.target) : undefined;
  // 精确搜索走独立的身份判断契约（计划 §11）：要求模型回声 candidateKey，
  // 并用严格批次校验收库。关键词监控不声明这个契约，旧协议不变。
  const identityContract = input.target !== undefined;
  const items = accepted.map((entry) => entry.item);
  const inputHashes = await Promise.all(items.map((item) => sha256Hex(JSON.stringify({
    query: input.query,
    relevanceContext,
    input: listingSemanticProjection(item),
  }))));
  const payload: ListingJobPayload = {
    query: input.query,
    items,
    inputHashes,
    relevanceContext,
    ...(identityContract ? { contract: LISTING_IDENTITY_CONTRACT_VERSION } : {}),
  };
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: input.target ? "product_search_enrichment" : "keyword_search_enrichment",
    ...(identityContract ? { contract: LISTING_IDENTITY_CONTRACT_VERSION } : {}),
    model: LISTING_ENRICHMENT_MODEL.model,
    promptVersion: input.target ? PRODUCT_SEARCH_PROMPT_VERSION : LISTING_ENRICHMENT_PROMPT_VERSION,
    query: input.query,
    relevanceContext,
    inputHashes,
  }));
  const row = await insertListingJob(env, {
    kind: "listing_enrichment",
    dedupeKey,
    promptVersion: input.target ? PRODUCT_SEARCH_PROMPT_VERSION : LISTING_ENRICHMENT_PROMPT_VERSION,
    payload,
    result: initialResult(items.length),
  });
  return {
    jobId: row.id,
    candidateKeys: accepted.map((entry) => entry.key),
    skippedItems: input.listings.length - accepted.length,
  };
}

export async function enqueueKeywordGeminiJob(
  env: GeminiEnv,
  input: KeywordGeminiJobInput,
): Promise<KeywordGeminiEnqueueResult> {
  const exactProduct = input.searchMode === "exact_product";
  if (exactProduct && (!input.productTarget || input.matchRelations?.length !== input.listings.length)) {
    throw new Error("exact_product_watch_context_invalid");
  }
  const context = exactProduct && input.productTarget
    ? productSearchRelevanceContext(input.productTarget)
    : {
        ...(input.targetLabel?.trim() ? { targetLabel: input.targetLabel.trim() } : {}),
        ...(input.targetDescription?.trim() ? { targetDescription: input.targetDescription.trim() } : {}),
        includeTerms: [...input.includeTerms],
        excludeTerms: [...input.excludeTerms],
      };
  const prepared = input.listings.map((listing, index) => ({ index, prepared: prepareListingDerivative(listing) }));
  const accepted = prepared.filter((entry): entry is {
    index: number;
    prepared: Extract<ListingDerivativePreparation, { kind: "accepted" }>;
  } => entry.prepared.kind === "accepted");
  const rejected = prepared.flatMap((entry) => (
    entry.prepared.kind === "rejected" ? [entry.prepared] : []
  ));
  if (rejected.length > 0) {
    console.warn(JSON.stringify({
      event: "keyword_derivative_items_rejected",
      bindingId: input.bindingId,
      watchRunId: input.watchRunId,
      rejectedItems: rejected.length,
      issuePaths: [...new Set(rejected.flatMap((entry) => entry.issuePaths))].slice(0, 12),
    }));
  }
  if (accepted.length === 0) {
    return { jobId: null, queuedItems: 0, skippedItems: input.listings.length };
  }
  const items = accepted.map((entry) => entry.prepared.request);
  const inputHashes = await Promise.all(items.map((item) => sha256Hex(JSON.stringify({
    query: input.query,
    relevanceContext: context,
    input: listingSemanticProjection(item),
  }))));
  const payload: ListingJobPayload = {
    query: input.query,
    items,
    inputHashes,
    relevanceContext: context,
    // 精确同款雷达走的是同一套身份裁决，就必须声明同一套契约。
    // 否则它拿到的是「引用可以为空」的提示词，却要过「没引用不能确认」的门，
    // 结果是整条链路再也确认不了任何商品。
    ...(exactProduct ? { contract: LISTING_IDENTITY_CONTRACT_VERSION } : {}),
    keyword: {
      bindingId: input.bindingId,
      watchRunId: input.watchRunId,
      trigger: input.trigger,
      scanStartedAt: input.scanStartedAt,
      baselineCompleted: input.baselineCompleted,
      ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
      listings: accepted.map((entry) => entry.prepared.listing),
      searchMode: exactProduct ? "exact_product" : "keyword",
      ...(exactProduct ? {
        productTarget: productFingerprintSchema.parse(input.productTarget),
        matchRelations: accepted.map((entry) => input.matchRelations?.[entry.index] ?? "uncertain"),
        matcherVersion: input.matcherVersion ?? PRODUCT_MATCH_VERSION,
      } : {}),
    },
  };
  const result = initialResult(items.length);
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: exactProduct ? "exact_product_watch_enrichment" : "keyword_enrichment",
    ...(exactProduct ? { contract: LISTING_IDENTITY_CONTRACT_VERSION } : {}),
    watchRunId: input.watchRunId,
    model: LISTING_ENRICHMENT_MODEL.model,
    promptVersion: exactProduct ? PRODUCT_SEARCH_PROMPT_VERSION : KEYWORD_PROMPT_VERSION,
    inputHashes,
  }));
  const row = await insertListingJob(env, {
    kind: "keyword_enrichment",
    dedupeKey,
    promptVersion: exactProduct ? PRODUCT_SEARCH_PROMPT_VERSION : KEYWORD_PROMPT_VERSION,
    payload,
    result,
  });
  return {
    jobId: row.id,
    queuedItems: accepted.length,
    skippedItems: input.listings.length - accepted.length,
  };
}

export async function enqueueMarketGeminiJob(
  env: GeminiEnv,
  input: MarketGeminiJobInput,
): Promise<MarketGeminiEnqueueResult> {
  if (input.items.length === 0 || input.items.length > 1_000) {
    throw new Error("market_enrichment_item_count_invalid");
  }
  const relevanceContext = {
    ...(input.targetLabel?.trim() ? { targetLabel: input.targetLabel.trim() } : {}),
    ...(input.targetDescription?.trim() ? { targetDescription: input.targetDescription.trim() } : {}),
    includeTerms: [...input.includeTerms],
    excludeTerms: [...input.excludeTerms],
  };
  const preparedItems = input.items.map((item) => prepareListingDerivative(item.listing));
  const allItems = preparedItems.map((item) => {
    if (item.kind === "rejected") throw new Error(`market_derivative_invalid:${item.issuePaths.join(",")}`);
    return item.request;
  });
  const claimed = await claimMarketItems(env, input.subscriptionKey, input.scopeVersionId, allItems);
  if (claimed.indexes.length === 0) return { jobId: null, claimedItems: 0 };
  const items = claimed.indexes.map((index) => allItems[index]!);
  const marketItems = claimed.indexes.map((index) => input.items[index]!);
  const inputHashes = await Promise.all(items.map((item) => sha256Hex(JSON.stringify({
    query: input.query,
    relevanceContext,
    marketSubscriptionKey: input.subscriptionKey,
    marketScopeVersionId: input.scopeVersionId,
    input: listingSemanticProjection(item),
  }))));
  const payload: ListingJobPayload = {
    query: input.query,
    items,
    inputHashes,
    relevanceContext,
    market: {
      subscriptionKey: input.subscriptionKey,
      ...(input.scopeVersionId ? { scopeVersionId: input.scopeVersionId } : {}),
      bindingId: input.bindingId,
      watchRunId: input.watchRunId,
      trigger: input.trigger,
      scanStartedAt: input.scanStartedAt,
      events: marketItems.map((item) => ({
        kind: item.kind,
        firstSeenRunId: item.firstSeenRunId,
        firstSeenAt: item.firstSeenAt,
      })),
    },
  };
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: "market_listing_enrichment",
    subscriptionKey: input.subscriptionKey,
    model: LISTING_ENRICHMENT_MODEL.model,
    promptVersion: LISTING_ENRICHMENT_PROMPT_VERSION,
    inputHashes,
    ...(input.trigger === "analysis_backfill" ? { backfillStartedAt: input.scanStartedAt } : {}),
  }));
  try {
    const row = await insertListingJob(env, {
      kind: "listing_enrichment",
      dedupeKey,
      promptVersion: LISTING_ENRICHMENT_PROMPT_VERSION,
      payload,
      result: initialResult(items.length),
    });
    const updatedAt = nowIso();
    await runStatementBatches(env.DB, claimed.claimKeys.map((claimKey) => (
      env.DB.prepare(
        "UPDATE market_listing_cleaning_claims SET job_id=?,status='active',updated_at=? WHERE claim_key=?",
      ).bind(row.id, updatedAt, claimKey)
    )));
    return { jobId: row.id, claimedItems: items.length };
  } catch (error) {
    await runStatementBatches(env.DB, claimed.claimKeys.map((claimKey) => (
      env.DB.prepare("DELETE FROM market_listing_cleaning_claims WHERE claim_key=? AND job_id IS NULL")
        .bind(claimKey)
    ))).catch(() => undefined);
    throw error;
  }
}

export async function createSearchOverviewGeminiJob(
  env: GeminiEnv,
  input: SearchOverviewRequest,
): Promise<GeminiJobRow> {
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: "search_overview",
    model: SEARCH_OVERVIEW_MODEL.model,
    promptVersion: SEARCH_OVERVIEW_PROMPT_VERSION,
    input,
  }));
  return insertSingleJob(env, {
    kind: "search_overview",
    dedupeKey,
    promptVersion: SEARCH_OVERVIEW_PROMPT_VERSION,
    payload: { input },
  });
}

/**
 * 目标商品名的结构化抽取任务。(kind, dedupe_key) 唯一索引即缓存：同一个商品名配同一个
 * prompt 版本永远命中同一行，所以每个档案实际只调用一次模型。
 */
export async function createProductTargetGeminiJob(
  env: GeminiEnv,
  input: ProductTargetExtractionRequest,
): Promise<GeminiJobRow> {
  const dedupeKey = await sha256Hex(JSON.stringify({
    kind: "product_target",
    model: PRODUCT_TARGET_MODEL.model,
    promptVersion: PRODUCT_TARGET_PROMPT_VERSION,
    input,
  }));
  return insertSingleJob(env, {
    kind: "product_target",
    dedupeKey,
    promptVersion: PRODUCT_TARGET_PROMPT_VERSION,
    payload: { input },
  });
}

/**
 * 存量档案的回填读口。抽取任务按 dedupe 缓存，所以这里"本轮建任务、下轮取结果"即可：
 * 第一次调用把任务排进队列并返回 undefined，任务完成后的任意一轮再调用就直接命中
 * 同一行拿到结果。模型每个商品名只会真正被调用一次。
 */
export async function readCompletedProductTargetExtraction(
  env: GeminiEnv,
  canonicalName: string,
): Promise<ProductTargetExtraction | undefined> {
  const row = await createProductTargetGeminiJob(env, { canonicalName });
  if (row.status !== "completed" || !row.result_json) return undefined;
  const parsed = productTargetJobResultSchema.safeParse(JSON.parse(row.result_json) as unknown);
  return parsed.success ? parsed.data.extraction : undefined;
}

export async function productTargetGeminiJobResponse(request: Request, env: GeminiEnv): Promise<Response> {
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = productTargetExtractionRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
    const row = await createProductTargetGeminiJob(env, parsed.data);
    return Response.json(publicSingleJob(row), { status: row.status === "completed" ? 200 : 202 });
  }
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return Response.json({ error: "invalid_job_id" }, { status: 400 });
  const row = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=? AND kind='product_target'")
    .bind(id).first<GeminiJobRow>();
  return row ? Response.json(publicSingleJob(row)) : Response.json({ error: "job_not_found" }, { status: 404 });
}

function publicListingJob(row: GeminiJobRow) {
  const result = resultFromRow(row);
  const itemStatuses = result.states.map((state) => {
    if (state === "ready") return "completed" as const;
    if (state === "failed") return "failed" as const;
    if (row.status === "waiting_rate_limit") return "waiting_rate_limit" as const;
    if (row.status === "processing") return "processing" as const;
    return "queued" as const;
  });
  return {
    jobId: row.id,
    status: row.status,
    items: result.items,
    itemStatuses,
    completedItems: row.completed_items,
    failedItems: row.failed_items,
    totalItems: row.total_items,
    model: row.model,
    promptVersion: row.prompt_version,
    providerCalled: row.attempt_count > 0,
    taskPersisted: true,
    nextAttemptAt: row.next_attempt_at,
    upstreamStatus: row.upstream_status,
    error: row.status === "failed" || row.status === "partial" ? row.last_error : null,
  };
}

export async function listingGeminiJobResponse(request: Request, env: GeminiEnv): Promise<Response> {
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = listingEnrichmentBatchRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
    const row = await createListingGeminiJob(env, parsed.data);
    return Response.json(publicListingJob(row), { status: row.status === "completed" ? 200 : 202 });
  }
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return Response.json({ error: "invalid_job_id" }, { status: 400 });
  const row = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=? AND kind='listing_enrichment'")
    .bind(id).first<GeminiJobRow>();
  return row ? Response.json(publicListingJob(row)) : Response.json({ error: "job_not_found" }, { status: 404 });
}

function publicSingleJob(row: GeminiJobRow) {
  const base = {
    jobId: row.id,
    status: row.status,
    model: row.model,
    promptVersion: row.prompt_version,
    providerCalled: row.attempt_count > 0,
    taskPersisted: true,
    nextAttemptAt: row.next_attempt_at,
    upstreamStatus: row.upstream_status,
    error: row.status === "failed" ? row.last_error : null,
  };
  const raw = row.result_json ? JSON.parse(row.result_json) as unknown : null;
  const parsed = raw ? searchOverviewJobResultSchema.safeParse(raw) : null;
  const extracted = raw ? productTargetJobResultSchema.safeParse(raw) : null;
  return {
    ...base,
    overview: parsed?.success ? parsed.data.overview : null,
    extraction: extracted?.success ? extracted.data.extraction : null,
  };
}

export async function searchOverviewGeminiJobResponse(request: Request, env: GeminiEnv): Promise<Response> {
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = searchOverviewRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
    const row = await createSearchOverviewGeminiJob(env, parsed.data);
    return Response.json(publicSingleJob(row), { status: row.status === "completed" ? 200 : 202 });
  }
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return Response.json({ error: "invalid_job_id" }, { status: 400 });
  const row = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=? AND kind='search_overview'")
    .bind(id).first<GeminiJobRow>();
  return row ? Response.json(publicSingleJob(row)) : Response.json({ error: "job_not_found" }, { status: 404 });
}

async function readBoundedResponse(response: Response): Promise<string> {
  return readBoundedResponseText(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
    "gemini_response_too_large",
  );
}

async function claimJob(env: GeminiEnv, row: GeminiJobRow): Promise<GeminiJobRow | null> {
  const now = nowIso();
  if (row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now()) {
    const delay = Math.max(1, Math.ceil((Date.parse(row.next_attempt_at) - Date.now()) / 1_000));
    await enqueueJobMessage(env, row.id, delay);
    return null;
  }
  const leaseExpiresAt = new Date(Date.now() + JOB_LEASE_MILLISECONDS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE gemini_jobs
     SET status='processing',attempt_count=attempt_count+1,lease_expires_at=?,next_attempt_at=NULL,updated_at=?
     WHERE id=? AND (
       status IN ('queued','waiting_rate_limit')
       OR (status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=?))
     )`,
  ).bind(leaseExpiresAt, now, row.id, now).run();
  if (Number(claimed.meta.changes) === 0) return null;
  return env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=?").bind(row.id).first<GeminiJobRow>();
}

type GeminiCapacityWait = {
  delaySeconds: number;
  reason: "provider_cooldown" | "request_window" | "token_window";
};

function geminiCapacityWaitMessage(reason: GeminiCapacityWait["reason"]): string {
  if (reason === "request_window") return "等待共享 Gemini 每分钟请求窗口恢复";
  if (reason === "provider_cooldown") return "等待共享 Gemini 429 冷却窗口恢复";
  return "等待共享 Gemini Token 窗口恢复";
}

/**
 * 按优先级给每个 Google key 单独算额度：主 key 有空就用主 key，满了或在 429
 * 冷却里就用 google-2；都不行才等，等最先恢复的那个。
 */
async function reserveGeminiCapacity(
  env: GeminiEnv,
  jobId: string,
  estimatedInputTokens: number,
): Promise<{ wait: GeminiCapacityWait } | { slot: GeminiKeySlot }> {
  const limits = resolveGeminiSchedulerLimits(env as unknown as Record<string, unknown>);
  const currentTime = Date.now();
  const currentIso = new Date(currentTime).toISOString();
  const cutoff = new Date(Date.now() - RESERVATION_WINDOW_MILLISECONDS).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gemini_token_reservations WHERE reserved_at<?").bind(cutoff),
    env.DB.prepare("DELETE FROM gemini_request_reservations WHERE reserved_at<?").bind(cutoff),
  ]);
  const waits: GeminiCapacityWait[] = [];
  for (const slot of geminiKeySlots(env)) {
    const wait = await keySlotCapacityWait(env, slot, limits, estimatedInputTokens, currentTime);
    if (wait) {
      waits.push(wait);
      continue;
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO gemini_token_reservations(id,job_id,estimated_input_tokens,reserved_at) VALUES(?,?,?,?)",
      ).bind(`${slot.reservationPrefix}${crypto.randomUUID()}`, jobId, estimatedInputTokens, currentIso),
      env.DB.prepare(
        "INSERT INTO gemini_request_reservations(id,job_id,reserved_at) VALUES(?,?,?)",
      ).bind(`${slot.reservationPrefix}${crypto.randomUUID()}`, jobId, currentIso),
    ]);
    return { slot };
  }
  return { wait: waits.reduce((soonest, wait) => wait.delaySeconds < soonest.delaySeconds ? wait : soonest) };
}

async function keySlotCapacityWait(
  env: GeminiEnv,
  slot: GeminiKeySlot,
  limits: ReturnType<typeof resolveGeminiSchedulerLimits>,
  estimatedInputTokens: number,
  currentTime: number,
): Promise<GeminiCapacityWait | null> {
  const cooldown = await env.DB.prepare(
    "SELECT cooldown_until FROM gemini_provider_cooldowns WHERE provider=?",
  ).bind(slot.provider).first<{ cooldown_until: string }>();
  if (cooldown && Date.parse(cooldown.cooldown_until) > currentTime) {
    return {
      delaySeconds: Math.max(1, Math.ceil((Date.parse(cooldown.cooldown_until) - currentTime) / 1_000) + 1),
      reason: "provider_cooldown",
    };
  }
  if (cooldown) {
    await env.DB.prepare("DELETE FROM gemini_provider_cooldowns WHERE provider=?")
      .bind(slot.provider).run();
  }
  // 预约记录 id 带 key 前缀；主 key 的 id 是不带冒号的 UUID。
  const [slotFilter, slotBinding] = slot.reservationPrefix
    ? ["id LIKE ?", `${slot.reservationPrefix}%`]
    : ["id NOT LIKE ?", "%:%"];
  const activeTokens = await env.DB.prepare(
    `SELECT COALESCE(SUM(estimated_input_tokens),0) total,MIN(reserved_at) oldest
     FROM gemini_token_reservations WHERE ${slotFilter}`,
  ).bind(slotBinding).first<{ total: number; oldest: string | null }>();
  const activeRequests = await env.DB.prepare(
    `SELECT count(*) count,MIN(reserved_at) oldest FROM gemini_request_reservations WHERE ${slotFilter}`,
  ).bind(slotBinding).first<{ count: number; oldest: string | null }>();
  const waits: GeminiCapacityWait[] = [];
  const totalTokens = Number(activeTokens?.total ?? 0);
  if (totalTokens > 0 && totalTokens + estimatedInputTokens > limits.tpmBudget) {
    const oldest = activeTokens?.oldest ? Date.parse(activeTokens.oldest) : currentTime;
    waits.push({
      delaySeconds: Math.max(1, Math.ceil((oldest + RESERVATION_WINDOW_MILLISECONDS - currentTime) / 1_000) + 1),
      reason: "token_window",
    });
  }
  if (Number(activeRequests?.count ?? 0) >= limits.rpmBudget) {
    const oldest = activeRequests?.oldest ? Date.parse(activeRequests.oldest) : currentTime;
    waits.push({
      delaySeconds: Math.max(1, Math.ceil((oldest + RESERVATION_WINDOW_MILLISECONDS - currentTime) / 1_000) + 1),
      reason: "request_window",
    });
  }
  if (waits.length === 0) return null;
  return waits.reduce((longest, wait) => wait.delaySeconds > longest.delaySeconds ? wait : longest);
}

async function setGeminiProviderCooldown(
  env: GeminiEnv,
  provider: string,
  delaySeconds: number,
  upstreamStatus: number,
  error: string,
): Promise<void> {
  const updatedAt = nowIso();
  const cooldownUntil = new Date(Date.now() + delaySeconds * 1_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO gemini_provider_cooldowns(provider,cooldown_until,upstream_status,last_error,updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(provider) DO UPDATE SET
       cooldown_until=GREATEST(gemini_provider_cooldowns.cooldown_until,excluded.cooldown_until),
       upstream_status=excluded.upstream_status,
       last_error=excluded.last_error,
       updated_at=excluded.updated_at`,
  ).bind(provider, cooldownUntil, upstreamStatus, error.slice(0, 500), updatedAt).run();
  console.warn(JSON.stringify({
    event: "gemini_shared_provider_cooldown_started",
    provider,
    upstreamStatus,
    delaySeconds,
    cooldownUntil,
    error: error.slice(0, 300),
  }));
}

async function setWaiting(
  env: GeminiEnv,
  row: GeminiJobRow,
  delaySeconds: number,
  status: number | null,
  error: string,
): Promise<void> {
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
  await env.DB.prepare(
    `UPDATE gemini_jobs SET status='waiting_rate_limit',lease_expires_at=NULL,next_attempt_at=?,
       upstream_status=?,last_error=?,updated_at=? WHERE id=?`,
  ).bind(nextAttemptAt, status, error.slice(0, 500), nowIso(), row.id).run();
  await enqueueJobMessage(env, row.id, delaySeconds);
}

async function persistChunk(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ListingJobPayload,
  indexes: readonly number[],
  outputs: readonly (ListingEnrichment | null)[],
  responseText: string,
  providerStatus: number,
  estimatedInputTokens: number,
): Promise<void> {
  const observedAt = nowIso();
  const accepted = indexes.flatMap((sourceIndex, localIndex) => {
    const output = outputs[localIndex];
    if (!output) return [];
    const input = payload.items[sourceIndex]!;
    const listingCandidate: Record<string, unknown> = { ...input };
    delete listingCandidate.sourceConditionLabel;
    delete listingCandidate.category;
    const listing = normalizedListingSchema.parse(listingCandidate);
    const marketEvent = payload.market?.events[sourceIndex];
    return [{
      listing,
      purpose: "listing_semantics" as const,
      provider: LISTING_ENRICHMENT_MODEL.provider,
      model: LISTING_ENRICHMENT_MODEL.model,
      promptVersion: row.prompt_version,
      inputHash: payload.inputHashes[sourceIndex]!,
      input,
      output,
      evidence: {
        quotes: output.evidence,
        source: { sourceId: input.sourceId, sourceItemId: input.sourceItemId, canonicalUrl: input.canonicalUrl },
      },
      confidence: output.confidence,
      metadata: {
        transport: "cloudflare_queue",
        jobId: row.id,
        query: payload.query,
        ...(row.kind === "keyword_enrichment" ? { trigger: "keyword_new_listing" } : {}),
        ...(payload.market && marketEvent ? {
          trigger: "market_daily_cleaning",
          marketSubscriptionKey: payload.market.subscriptionKey,
          ...(payload.market.scopeVersionId ? { marketScopeVersionId: payload.market.scopeVersionId } : {}),
          marketBindingId: payload.market.bindingId,
          marketRunId: payload.market.watchRunId,
          marketEventKind: marketEvent.kind,
          marketFirstSeenRunId: marketEvent.firstSeenRunId,
          marketFirstSeenAt: marketEvent.firstSeenAt,
        } : {}),
      },
      observedAt,
    }];
  });
  const chunkInput = {
    query: payload.query,
    ...(payload.relevanceContext ? { relevanceContext: payload.relevanceContext } : {}),
    items: indexes.map((index) => payload.items[index]!),
  };
  const inputHash = await sha256Hex(JSON.stringify(chunkInput));
  const batchId = await sha256Hex(JSON.stringify({
    purpose: "listing_semantics",
    provider: LISTING_ENRICHMENT_MODEL.provider,
    model: LISTING_ENRICHMENT_MODEL.model,
    promptVersion: row.prompt_version,
    inputHash,
    responseText,
  }));
  await enqueueAiEnrichmentPayload(env, {
    batchId,
    batch: {
      purpose: "listing_semantics",
      provider: LISTING_ENRICHMENT_MODEL.provider,
      model: LISTING_ENRICHMENT_MODEL.model,
      promptVersion: row.prompt_version,
      inputHash,
      input: chunkInput,
      rawResponse: responseText,
      status: accepted.length === indexes.length ? "parsed" : accepted.length > 0 ? "partial" : "unparsed",
      metadata: {
        transport: "cloudflare_queue",
        jobId: row.id,
        providerStatus,
        estimatedInputTokens,
      },
      observedAt,
    },
    records: accepted,
  });
}

/**
 * 精确同款档案发不发"确认同款上新"：有监控规则时看规则里的事件类型，没有就看绑定上的开关。
 * 文字判定（下面的 finalizeKeywordJob）和参考图判定（exact-reference-image.ts）共用这一个判断。
 */
export async function exactDiscoveryNotificationsEnabled(
  env: Pick<GeminiEnv, "DB">,
  binding: WatchBindingRow,
): Promise<boolean> {
  const currentRule = await env.DB.prepare(
    `SELECT event_types_json FROM monitor_rules
     WHERE watch_profile_id=? AND valid_to IS NULL ORDER BY version DESC LIMIT 1`,
  ).bind(binding.watch_profile_id).first<{ event_types_json: string }>();
  if (currentRule === null) return binding.notify_new_listing === 1;
  const parsedRuleEvents = jsonValue(currentRule.event_types_json ?? "[]");
  const configuredRuleEvents = new Set(
    Array.isArray(parsedRuleEvents)
      ? parsedRuleEvents.filter((value): value is string => typeof value === "string")
      : [],
  );
  return [
    "product.new_comparable_offer",
    "product.condition_match_seen",
    "product.complete_set_seen",
  ].some((eventType) => configuredRuleEvents.has(eventType));
}

async function finalizeKeywordJob(
  env: GeminiEnv,
  payload: ListingJobPayload,
  result: JobResult,
): Promise<boolean> {
  const keyword = payload.keyword;
  if (!keyword) return false;
  const repository = new RadarRepository(env.DB);
  const binding = await repository.getBinding(keyword.bindingId);
  if (!binding) return false;
  const exactProductJob = keyword.searchMode === "exact_product";
  const rawSourceConfig = jsonValue(binding.source_config_json);
  const strongReminderPolicy = strongReminderPolicyFromSourceConfig(
    rawSourceConfig !== null && typeof rawSourceConfig === "object" && !Array.isArray(rawSourceConfig)
      ? rawSourceConfig as Record<string, unknown>
      : {},
  );
  const exactDiscoveryNotificationEnabled = exactProductJob
    ? await exactDiscoveryNotificationsEnabled(env, binding)
    : binding.notify_new_listing === 1;
  let newCount = 0;
  let changedCount = 0;
  const eventGroups: Array<{ listingId: string; events: ReturnType<typeof evaluateListingEvents> }> = [];
  const strongTargetReminders: Array<{
    listingId: string;
    currentPrice: number;
    previousPrice?: number;
    targetPrice: number;
  }> = [];
  const listingStates = await repository.findListingsWithMatchState(
    binding.id,
    keyword.listings.map((listing) => ({
      sourceId: listing.sourceId,
      sourceItemId: listing.sourceItemId,
    })),
  );
  // 用户在 AI 复核页上判"AI 判错了"的商品（keyword_ai_reviews）：此后不再采信 AI 对它们的否定。
  // AI 的结论按 inputHash 缓存，商品文本不变就会一直给出同一个错判，不在这里改口就永远拒下去。
  // 反过来，用户判"确实不是"的商品，AI 再放弃时也不按规则放行（见下面的 ruleFallback）。
  const userReviews = exactProductJob
    ? []
    : (await env.DB.prepare(
        "SELECT source_id,source_item_id,verdict FROM keyword_ai_reviews WHERE watch_binding_id=?",
      ).bind(binding.id).all<{ source_id: string; source_item_id: string; verdict: string }>()).results;
  const userOverturned = new Set(userReviews.filter((row) => row.verdict === "ai_wrong")
    .map((row) => `${row.source_id}:${row.source_item_id}`));
  const userRejected = new Set(userReviews.filter((row) => row.verdict === "ai_correct")
    .map((row) => `${row.source_id}:${row.source_item_id}`));
  for (const [index, rawListing] of keyword.listings.entries()) {
    const listing = listingForDeterministicState(rawListing);
    const exactProduct = exactProductJob;
    const listingState = listingStates.get(`${listing.sourceId}:${listing.sourceItemId}`);
    const stored = await repository.persistListing(binding, listing, {
      linkToWatch: false,
      prefetched: listingState ?? {
        listing: null,
        matched: false,
      },
    });
    let isNewMatch = stored.isNewMatch;
    let recoveredMatch = false;
    let itemLookupSupported = false;
    if (exactProduct) {
      const relation = keyword.matchRelations?.[index] ?? "uncertain";
      const deterministicExact = relation === "exact";
      // 差异只依赖目标名与商品文本，与候选集词频无关，因此这里重算与采集时一致。
      // 它既决定能否越过模型的自评置信度，也是写给用户看的那行理由。
      const assessment = keyword.productTarget
        ? assessProductMatch(listing, keyword.productTarget)
        : undefined;
      const difference = assessment?.difference;
      const differenceNote = describeProductMatchDifference(difference);
      const unconfirmedNote = describeProductMatchUnconfirmed(difference);
      const aiOutput = result.items[index] as unknown as Record<string, unknown> | undefined;
      const identityDecision = exactProductIdentityDecision({
        relation,
        ...(aiOutput ? { output: aiOutput } : {}),
        ...(assessment
          ? {
            match: {
              ...(difference ? { difference } : {}),
              conflicts: assessment.conflicts,
              matchedFields: assessment.matchedFields,
            },
          }
          : {}),
        // 这条链路的模型结果已经逐条 settle 过：有值就是 ready，
        // 没值代表这一轮没拿到有效输出，不能当成“不是同款”。
        aiItemStatus: aiOutput ? "ready" : result.states[index] === "failed" ? "contract_error" : "not_executed",
      });
      const identityConfirmed = identityDecision.decision === "confirmed";
      const semanticExact = !deterministicExact && identityConfirmed;
      if (!identityConfirmed) {
        await repository.updateRunListingDecision({
          runId: keyword.watchRunId,
          sourceId: listing.sourceId,
          sourceItemId: listing.sourceItemId,
          decisionStatus: identityDecision.decision,
          // 差异说明排在最前：用户要判断的是"这条和我的目标差在哪"，
          // "未达到语义复核门槛"这种机器话对他没有任何帮助。
          decisionReason: [
            differenceNote,
            result.items[index]?.relevanceReason,
            // 缺口必须写清楚。“同款关系 related”对用户没有任何意义，
            // “标题没写版本、详情还没读”才是这条记录的全部价值。
            EXACT_IDENTITY_REASON_TEXT[identityDecision.reasonCode],
          ].filter(Boolean).join("；").slice(0, 400),
          matchRelation: relation,
          aiRelevance: result.items[index]?.relevance,
          aiConfidence: result.items[index]?.confidence,
        });
        continue;
      }
      const knownOfferAnchor = listingState?.knownItemWatch === true;
      const accepted = knownOfferAnchor
        ? await repository.acceptKnownOfferAnchor(binding.id, stored.listingId)
        : await repository.acceptListingMatch({
            bindingId: binding.id,
            listingId: stored.listingId,
            acceptanceReason: deterministicExact ? "deterministic_exact" : "semantic_exact",
            matcherVersion: keyword.matcherVersion ?? PRODUCT_MATCH_VERSION,
            semanticPromptVersion: semanticExact ? PRODUCT_SEARCH_PROMPT_VERSION : undefined,
          });
      isNewMatch = accepted.isNewMatch;
      // 锚点报价交给它自己那份单品监控，这里不重复建跟踪任务——否则同一条链接
      // 会被两个任务各抓一次，也会发两封邮件。反过来，一旦那份单品监控不在了，
      // knownOfferAnchor 就为假，下面的激活会把这条报价从 anchor_known 接管回来。
      if (!knownOfferAnchor && binding.profile_offer_tracking_policy === "all_confirmed_offers") {
        await repository.activateExactProductListingTracking(
          binding,
          stored.listingId,
          itemLookupSupportedFor(binding.source_id, listing.sourceItemId),
        );
      }
      await repository.updateRunListingDecision({
        runId: keyword.watchRunId,
        sourceId: listing.sourceId,
        sourceItemId: listing.sourceItemId,
        decisionStatus: "confirmed",
        // 身份成立时不重复"身份要素全部命中"（decision_status 已经说明了），但那句
        // "尺寸 / 颜色商品未注明"必须跟出来：尺寸是软属性，缺失不拦身份，代价就是
        // 由用户在下单前自己核一眼。判定理由整条覆盖差异说明的话，这个代价就没人承担了。
        decisionReason: `${deterministicExact
          ? "确定性商品身份一致"
          : result.items[index]?.relevanceReason ?? "语义证据确认同款"}${knownOfferAnchor
          ? "；已有单品关注，作为已知报价去重"
          : ""}${listing.priceBasis === "auction_current_bid"
          ? " 当前价格为进行中拍卖出价，不作为可成交目标价。"
          : ""}${unconfirmedNote ? `；${unconfirmedNote}` : ""}`,
        matchRelation: relation,
        aiRelevance: result.items[index]?.relevance,
        aiConfidence: result.items[index]?.confidence,
      });
      itemLookupSupported = itemLookupSupportedFor(binding.source_id, listing.sourceItemId);
    } else {
      // irrelevant / uncertain 不写入匹配：商品保持未匹配，下轮扫描会重新送审。
      //
      // AI 彻底放弃的（state=failed：瞬时故障重试耗尽，或输出连续解析不出来）例外，
      // 按关键词规则放行。走到这里的商品已经过了档案的必须包含 / 排除词，AI 只是没能
      // 再筛一遍。C2C 和拍卖多是一次性挂牌，等第二天重新送审，往往已经卖掉了；
      // 实测 AI 在关键词档案里只拦掉 0.3%～10%，多是同名作者的书，混进来几件的代价
      // 远小于漏掉真品（AGENTS.md §4：误报的终局是漏报，但漏报本身也是终局）。
      // 邮件里按来源写明"N 件未经 AI 复核"，见 templates.ts 的 ai_judgement_incomplete。
      // 判定档位记为 uncertain，不冒充 AI 确认过。
      const aiRelevant = result.items[index]?.relevance === "relevant";
      const overturnedByUser = !aiRelevant && userOverturned.has(`${listing.sourceId}:${listing.sourceItemId}`);
      const ruleFallback = !aiRelevant && !overturnedByUser && result.states[index] === "failed"
        && !userRejected.has(`${listing.sourceId}:${listing.sourceItemId}`);
      if (!aiRelevant && !overturnedByUser && !ruleFallback) {
        await repository.updateRunListingDecision({
          runId: keyword.watchRunId,
          sourceId: listing.sourceId,
          sourceItemId: listing.sourceItemId,
          decisionStatus: result.items[index]?.relevance === "irrelevant" ? "rejected" : "uncertain",
          decisionReason: result.items[index]?.relevanceReason ?? "相关性证据不足",
          aiRelevance: result.items[index]?.relevance,
          aiConfidence: result.items[index]?.confidence,
        });
        continue;
      }
      const accepted = await repository.acceptListingMatch({
        bindingId: binding.id,
        listingId: stored.listingId,
        acceptanceReason: "keyword_relevant",
        currentRunId: keyword.watchRunId,
      });
      isNewMatch = accepted.isNewMatch;
      recoveredMatch = accepted.recoveredMatch;
      await repository.updateRunListingDecision({
        runId: keyword.watchRunId,
        sourceId: listing.sourceId,
        sourceItemId: listing.sourceItemId,
        decisionStatus: ruleFallback ? "uncertain" : "confirmed",
        decisionReason: ruleFallback
          ? KEYWORD_RULE_FALLBACK_REASON
          : overturnedByUser
          ? `你在 AI 复核里改判为相关（AI 原判：${result.items[index]?.relevanceReason ?? "证据不足"}）`
          : result.items[index]?.relevanceReason ?? "关键词相关性已确认",
        aiRelevance: result.items[index]?.relevance,
        aiConfidence: result.items[index]?.confidence,
      });
    }
    if (isNewMatch && !recoveredMatch && (exactProduct || keyword.baselineCompleted)) newCount += 1;
    if (stored.changed) changedCount += 1;
    const oldPrice = validComparablePrice(stored.previous?.current_price ?? undefined);
    const newPrice = validComparablePrice(listing.currentPrice);
    const droppedEnough = oldPrice !== undefined && newPrice !== undefined
      && newPrice < oldPrice && oldPrice - newPrice >= binding.min_drop_amount;
    const crossedTarget = binding.target_price !== null && oldPrice !== undefined && newPrice !== undefined
      && oldPrice > binding.target_price && newPrice <= binding.target_price;
    const purchasable = ["available", "preorder", "backorder"].includes(listing.availability);
    const newOfferTargetHit = exactProduct
      && binding.target_price !== null
      && newPrice !== undefined
      && newPrice <= binding.target_price
      && listing.priceBasis !== "auction_current_bid"
      && purchasable;
    if (
      exactProduct
      && !isNewMatch
      && itemLookupSupported
      && purchasable
      && ((binding.notify_price_drop === 1 && droppedEnough) || crossedTarget)
    ) {
      await monitorQueueFor(env, binding.source_id).send({
        type: "confirm_price_drop",
        idempotencyKey: `confirm_price_drop:${binding.id}:${stored.listingId}:${newPrice}`,
        bindingId: binding.id,
        listingId: stored.listingId,
        expectedOldPrice: oldPrice ?? 0,
        candidateNewPrice: newPrice ?? 0,
        queuedAt: nowIso(),
      } satisfies ConfirmPriceDropJob, { delaySeconds: 30 });
    }
    const events = evaluateListingEvents({
      bindingId: binding.id,
      listingId: stored.listingId,
      previous: stored.previous ? {
        price: validComparablePrice(stored.previous.current_price ?? undefined),
        availability: stored.previous.availability as NormalizedListing["availability"],
        stateHash: stored.previous.state_hash ?? undefined,
      } : undefined,
      current: { price: listing.currentPrice, availability: listing.availability, stateHash: stored.stateHash },
      isNewMatch,
      recoveredMatch,
      baselineCompleted: keyword.baselineCompleted,
      // An exact-product dossier is a discovery request for one concrete item:
      // confirmed offers from its first scan are discoveries, not a silent
      // market baseline. Keyword dossiers keep their baseline-only first run.
      notifyInitial: exactProduct || binding.notify_initial === 1,
      notifyNewListing: (
        exactProduct
          ? exactDiscoveryNotificationEnabled
          : binding.notify_new_listing === 1
      ),
      notifyPriceDrop: !exactProduct && binding.notify_price_drop === 1,
      notifyPriceRise: !exactProduct && binding.notify_price_rise === 1,
      notifyRestock: !exactProduct && binding.notify_restock === 1,
      notifySoldOut: !exactProduct && binding.notify_sold_out === 1,
      targetPrice: binding.target_price ?? undefined,
      minDropAmount: binding.min_drop_amount,
      observedAt: keyword.scanStartedAt,
      // "上新"混着两件事：市场真的新上架，和我们第一次看见。只有来源给出上架时间时
      // 前者才可知（生产中 8 个来源一条都没有），所以两者必须分开记录而不是共用一个词。
      discoveryKind: newListingDiscoveryKind({
        ...(listing.sourceListedAt === undefined ? {} : { sourceListedAt: listing.sourceListedAt }),
        ...(keyword.watermark === undefined ? {} : { watermark: keyword.watermark }),
      }),
    });
    // A confirmed offer below the configured target is recorded once for that
    // binding/listing/target tuple. Repeated daily scans remain evidence, but
    // do not turn the same unchanged bargain into a daily notification.
    if (newOfferTargetHit && binding.target_price !== null && newPrice !== undefined) {
      if (strongReminderPolicy.enabled) {
        strongTargetReminders.push({
          listingId: stored.listingId,
          currentPrice: newPrice,
          ...(oldPrice === undefined ? {} : { previousPrice: oldPrice }),
          targetPrice: binding.target_price,
        });
      } else {
        events.push(currentTargetPriceEvent({
          bindingId: binding.id,
          listingId: stored.listingId,
          currentPrice: newPrice,
          ...(oldPrice === undefined ? {} : { previousPrice: oldPrice }),
          targetPrice: binding.target_price,
        }));
      }
    }
    if (events.length > 0) eventGroups.push({ listingId: stored.listingId, events });
  }
  await repository.insertEventBatch(binding, eventGroups);
  const strongReminderDetectedAt = nowIso();
  for (const reminder of strongTargetReminders) {
    await repository.scheduleStrongTargetPriceReminders(binding, {
      ...reminder,
      detectedAt: strongReminderDetectedAt,
      policy: strongReminderPolicy,
    });
  }
  // AI 一条都没产出时不能标基线完成：这一轮没有写入任何匹配，标完成会让下一轮
  // 把整个窗口重新当成新品。让基线保持未完成，下一轮重新送审即可。
  // 关键词档案里 AI 放弃的条目已按规则写入匹配（见上面的 ruleFallback），算作写过。
  if (result.states.some((state) => state === "ready" || (!exactProductJob && state === "failed"))) {
    await repository.completeBinding(binding);
  } else {
    console.warn(JSON.stringify({
      event: "keyword_baseline_not_completed",
      bindingId: binding.id,
      watchRunId: keyword.watchRunId,
      items: result.states.length,
    }));
  }
  await env.DB.prepare(
    "UPDATE watch_runs SET new_count=GREATEST(new_count,?),changed_count=GREATEST(changed_count,?) WHERE id=?",
  ).bind(newCount, changedCount, keyword.watchRunId).run();
  if (keyword.trigger === "cron") return false;
  const scanFinishedAt = nowIso();
  await repository.prepareKeywordDigest({
    profileId: binding.watch_profile_id,
    bindingIds: [binding.id],
    scanStartedAt: keyword.scanStartedAt,
    scanFinishedAt,
    digestKey: `keyword_digest:${binding.watch_profile_id}:${keyword.scanStartedAt}`,
    failedSources: [],
  });
  return true;
}

async function finalizeMarketClaims(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ListingJobPayload,
  result: JobResult,
): Promise<void> {
  if (!payload.market) return;
  const updatedAt = nowIso();
  const statements: OperationalPreparedStatement[] = [];
  for (const [index, item] of payload.items.entries()) {
    const claimKey = await marketCleaningClaimKey(
      payload.market.subscriptionKey,
      item,
      row.model,
      row.prompt_version,
    );
    if (result.states[index] === "ready") {
      statements.push(env.DB.prepare(
        `UPDATE market_listing_cleaning_claims
         SET status='completed',job_id=?,updated_at=? WHERE claim_key=?`,
      ).bind(row.id, updatedAt, claimKey));
    } else {
      statements.push(env.DB.prepare(
        "DELETE FROM market_listing_cleaning_claims WHERE claim_key=? AND job_id=?",
      ).bind(claimKey, row.id));
    }
  }
  await runStatementBatches(env.DB, statements);
}

async function finishJob(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ListingJobPayload,
  result: JobResult,
  lastError: string | null = null,
): Promise<GeminiProcessResult> {
  const counts = resultCounts(result);
  const hasPending = result.states.some((state) => state === "pending");
  if (hasPending) throw new Error("gemini_job_finished_with_pending_items");
  const deliverPendingEmails = row.kind === "keyword_enrichment"
    ? await finalizeKeywordJob(env, payload, result)
    : false;
  await finalizeMarketClaims(env, row, payload, result);
  const status = counts.failed === 0 ? "completed" : counts.completed > 0 ? "partial" : "failed";
  const completedAt = nowIso();
  await env.DB.prepare(
    `UPDATE gemini_jobs SET status=?,result_json=?,completed_items=?,failed_items=?,lease_expires_at=NULL,
       next_attempt_at=NULL,last_error=?,updated_at=?,completed_at=? WHERE id=?`,
  ).bind(
    status,
    JSON.stringify(result),
    counts.completed,
    counts.failed,
    lastError,
    completedAt,
    completedAt,
    row.id,
  ).run();
  if (row.prompt_version === PRODUCT_SEARCH_PROMPT_VERSION) {
    try {
      if (payload.keyword?.searchMode === "exact_product"
          && payload.keyword.productTarget
          && payload.keyword.matchRelations) {
        await materializeProductIdentityForExactWatch({
          env,
          bindingId: payload.keyword.bindingId,
          aiJobId: row.id,
          aiJobStatus: status,
          model: row.model,
          promptVersion: row.prompt_version,
          completedAt,
          watchRunId: payload.keyword.watchRunId,
          target: payload.keyword.productTarget,
          listings: payload.keyword.listings,
          matchRelations: payload.keyword.matchRelations,
          matcherVersion: payload.keyword.matcherVersion ?? PRODUCT_MATCH_VERSION,
          aiOutputs: result.items,
        });
      }
      await materializeProductIdentitiesForAiJob(env, row.id);
    } catch (error) {
      // Product identity is a retryable derivative. The completed Gemini result
      // remains intact and the scheduled projection backfill will retry it.
      console.error("product_identity_projection_failed", JSON.stringify({
        jobId: row.id,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }
  return { deliverPendingEmails };
}

export async function backfillExactWatchProductIdentityProjections(
  env: GeminiEnv,
  limit = 10,
): Promise<{ scanned: number; materialized: number }> {
  const rows = await env.DB.prepare(
    `SELECT job.* FROM gemini_jobs AS job
     WHERE job.kind='keyword_enrichment'
       AND job.prompt_version=?
       AND job.status IN ('completed','partial','failed')
       AND job.completed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM product_identity_projection_versions AS projection
         WHERE projection.workflow_task_id='watch:' || job.id
           AND projection.projected_at >= job.completed_at
       )
     ORDER BY job.completed_at DESC,job.id DESC LIMIT ?`,
  ).bind(
    PRODUCT_SEARCH_PROMPT_VERSION,
    Math.max(1, Math.min(Math.trunc(limit), 100)),
  ).all<GeminiJobRow>();
  let materialized = 0;
  for (const row of rows.results) {
    try {
      const payload = listingJobPayloadSchema.parse(await loadJobPayload(env, row));
      if (payload.keyword?.searchMode !== "exact_product"
          || !payload.keyword.productTarget
          || !payload.keyword.matchRelations
          || !row.completed_at) {
        continue;
      }
      const projection = await materializeProductIdentityForExactWatch({
        env,
        bindingId: payload.keyword.bindingId,
        aiJobId: row.id,
        aiJobStatus: row.status as "completed" | "partial" | "failed",
        model: row.model,
        promptVersion: row.prompt_version,
        completedAt: row.completed_at,
        watchRunId: payload.keyword.watchRunId,
        target: payload.keyword.productTarget,
        listings: payload.keyword.listings,
        matchRelations: payload.keyword.matchRelations,
        matcherVersion: payload.keyword.matcherVersion ?? PRODUCT_MATCH_VERSION,
        aiOutputs: resultFromRow(row).items,
      });
      if (projection) materialized += 1;
    } catch (error) {
      console.error("exact_watch_product_identity_backfill_failed", JSON.stringify({
        jobId: row.id,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  }
  return { scanned: rows.results.length, materialized };
}

async function failPendingItems(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ListingJobPayload,
  result: JobResult,
  error: string,
  upstreamStatus: number | null,
): Promise<GeminiProcessResult> {
  result.states = result.states.map((state) => state === "pending" ? "failed" : state);
  await env.DB.prepare("UPDATE gemini_jobs SET upstream_status=? WHERE id=?")
    .bind(upstreamStatus, row.id).run();
  return finishJob(env, row, payload, result, error);
}

/**
 * 经 AI Gateway 转发时，Google 会按出口机房 IP 判定地区，偶发返回 400
 * （User location is not supported）。换个时间再发往往就过了，所以 400 和
 * 5xx/408 一样按临时故障退避重试；凭据由 Gateway BYOK 保管，不会是真正的
 * 请求错误。429 走单独的冷却逻辑，不在这里。
 */
function isTransientGeminiStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 400;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * 模型在 `LISTING_PROVIDER_TIMEOUT_MILLISECONDS` 内没答完，下一次就把这一批砍半。
 *
 * 2026-10-08 加藤惠的雅虎拍卖：33 件待判，每次都是同一批 32 件发出去、每次都在
 * 55 秒处被掐断，连续 5 次一件没判出来，日报跟着卡了 40 分钟。同一时间其它档案
 * 的小批次都正常——模型那阵子变慢，而批量不变，就只能反复撞同一面墙。
 *
 * 不靠放宽等待来解决：那个数字必须小于 `jpgr_app` 的 idle_in_transaction_session_timeout
 * （见 docs/常用/行情邮件未送达-排查手册-20260922.md 第三节）。上限只在本任务内生效，
 * 判出一批后也不恢复——同一阵慢的时候没必要再去试大批。
 */
function shrinkBatchAfterTimeout(row: GeminiJobRow, result: JobResult, sentItems: number): void {
  const batchCap = Math.max(1, Math.floor(sentItems / 2));
  result.batchCap = batchCap;
  console.warn(JSON.stringify({ event: "gemini_batch_shrunk_after_timeout", jobId: row.id, sentItems, batchCap }));
}

/**
 * 传入 `result` 时一并保存本次已就绪的条目（主要是从缓存复用的那部分）和批量上限。
 * 以前超时只改状态，复用的几十件每次都丢掉重来，后台看起来始终是 0/80，
 * 分不清是"一件都判不了"还是"只差最后一批"。
 */
async function requeueTransient(
  env: GeminiEnv,
  row: GeminiJobRow,
  status: number | null,
  error: string,
  result?: JobResult,
): Promise<void> {
  const delay = Math.min(3_600, 30 * (2 ** Math.min(row.attempt_count, 7)));
  const nextAttemptAt = new Date(Date.now() + delay * 1_000).toISOString();
  if (result) {
    const counts = resultCounts(result);
    await env.DB.prepare(
      `UPDATE gemini_jobs SET status='queued',result_json=?,completed_items=?,failed_items=?,lease_expires_at=NULL,
         next_attempt_at=?,upstream_status=?,last_error=?,updated_at=? WHERE id=?`,
    ).bind(
      JSON.stringify(result),
      counts.completed,
      counts.failed,
      nextAttemptAt,
      status,
      error.slice(0, 500),
      nowIso(),
      row.id,
    ).run();
  } else {
    await env.DB.prepare(
      `UPDATE gemini_jobs SET status='queued',lease_expires_at=NULL,next_attempt_at=?,upstream_status=?,
         last_error=?,updated_at=? WHERE id=?`,
    ).bind(nextAttemptAt, status, error.slice(0, 500), nowIso(), row.id).run();
  }
  await enqueueJobMessage(env, row.id, delay);
}

type SingleProviderCall =
  | { kind: "success"; responseText: string; status: number }
  | { kind: "deferred" }
  | { kind: "failed" };

async function failSingleJob(
  env: GeminiEnv,
  row: GeminiJobRow,
  error: string,
  upstreamStatus: number | null,
): Promise<void> {
  const completedAt = nowIso();
  await env.DB.prepare(
    `UPDATE gemini_jobs SET status='failed',lease_expires_at=NULL,next_attempt_at=NULL,upstream_status=?,
       last_error=?,updated_at=?,completed_at=? WHERE id=?`,
  ).bind(upstreamStatus, error.slice(0, 500), completedAt, completedAt, row.id).run();
}

async function callSingleGemini(
  env: GeminiEnv,
  row: GeminiJobRow,
  buildRequest: (apiKey: string) => { url: string; headers: Record<string, string>; body: unknown },
): Promise<SingleProviderCall> {
  const requestWithoutSecret = buildRequest("");
  const estimatedInputTokens = Math.max(1, Math.ceil(
    new TextEncoder().encode(JSON.stringify(requestWithoutSecret.body)).byteLength / 2,
  ));
  const capacity = await reserveGeminiCapacity(env, row.id, estimatedInputTokens);
  if ("wait" in capacity) {
    const capacityWait = capacity.wait;
    await setWaiting(
      env,
      row,
      capacityWait.delaySeconds,
      null,
      geminiCapacityWaitMessage(capacityWait.reason),
    );
    return { kind: "deferred" };
  }
  const apiKey = env.GOOGLE_AI_API_KEY?.trim() ?? "";
  let keySlot = capacity.slot;
  let response: Response;
  try {
    const providerRequest = await routeGeminiProviderRequest(env, buildRequest(apiKey), {
      jobId: row.id,
      kind: row.kind,
    });
    const sent = await fetchGeminiWithFallbackKey(providerRequest, 60_000, { jobId: row.id, kind: row.kind }, keySlot);
    response = sent.response;
    keySlot = sent.slot;
  } catch (error) {
    const message = safeJobError(error);
    if (row.attempt_count < MAX_TRANSIENT_ATTEMPTS) {
      await requeueTransient(env, row, null, message);
      return { kind: "deferred" };
    }
    await failSingleJob(env, row, message, null);
    return { kind: "failed" };
  }
  let responseText: string;
  try {
    responseText = await readBoundedResponse(response);
  } catch (error) {
    await failSingleJob(env, row, safeJobError(error), response.status);
    return { kind: "failed" };
  }
  if (response.status === 429) {
    const delay = parseGeminiRetryDelaySeconds(response.headers, responseText);
    const detail = safeGeminiTransportError(responseText);
    await setGeminiProviderCooldown(env, keySlot.provider, delay, response.status, detail);
    await setWaiting(
      env,
      row,
      delay,
      response.status,
      `Google AI HTTP 429：${detail}`,
    );
    return { kind: "deferred" };
  }
  if (!response.ok) {
    const message = `Google AI HTTP ${response.status}：${safeGeminiTransportError(responseText)}`;
    if (isTransientGeminiStatus(response.status) && row.attempt_count < MAX_TRANSIENT_ATTEMPTS) {
      await requeueTransient(env, row, response.status, message);
      return { kind: "deferred" };
    }
    await failSingleJob(env, row, message, response.status);
    return { kind: "failed" };
  }
  return { kind: "success", responseText, status: response.status };
}

async function completeSingleJob(env: GeminiEnv, row: GeminiJobRow, result: unknown, upstreamStatus: number): Promise<void> {
  const completedAt = nowIso();
  await env.DB.prepare(
    `UPDATE gemini_jobs SET status='completed',result_json=?,lease_expires_at=NULL,next_attempt_at=NULL,
       upstream_status=?,last_error=NULL,updated_at=?,completed_at=? WHERE id=?`,
  ).bind(JSON.stringify(result), upstreamStatus, completedAt, completedAt, row.id).run();
}

async function processSearchOverviewJob(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: SearchOverviewJobPayload,
): Promise<void> {
  const call = await callSingleGemini(env, row, (apiKey) => ({
    url: SEARCH_OVERVIEW_MODEL.url,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: searchOverviewProviderRequest(payload.input),
  }));
  if (call.kind !== "success") return;
  try {
    const overview: SearchOverview = parseSearchOverview(call.responseText);
    await completeSingleJob(env, row, { overview } satisfies z.infer<typeof searchOverviewJobResultSchema>, call.status);
  } catch (error) {
    await failSingleJob(env, row, safeJobError(error), call.status);
  }
}

async function processProductTargetJob(
  env: GeminiEnv,
  row: GeminiJobRow,
  payload: ProductTargetJobPayload,
): Promise<void> {
  const call = await callSingleGemini(env, row, (apiKey) => ({
    url: PRODUCT_TARGET_MODEL.url,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: productTargetProviderRequest(payload.input.canonicalName),
  }));
  if (call.kind !== "success") return;
  try {
    const extraction = parseProductTargetExtraction(call.responseText);
    // 抽取器的 schema 每个字段都挂了 `.catch()`，所以解析失败不会抛异常，只会得到一份
    // 全空的合法结果。把它记成 completed 等于把"没抽到"缓存成"抽到了空"：
    // (kind, dedupe_key) 唯一索引会让这个商品名永远读到这一行。记成 failed 才是实话，
    // 上游读不到结果时会保留启发式指纹，不会拿空值把指纹覆盖掉。
    if (productTargetExtractionIsEmpty(extraction)) {
      await failSingleJob(env, row, "product_target_extraction_empty", call.status);
      return;
    }
    await completeSingleJob(env, row, { extraction } satisfies z.infer<typeof productTargetJobResultSchema>, call.status);
  } catch (error) {
    await failSingleJob(env, row, safeJobError(error), call.status);
  }
}

export async function processGeminiJob(env: GeminiEnv, jobId: string): Promise<GeminiProcessResult> {
  const found = await env.DB.prepare("SELECT * FROM gemini_jobs WHERE id=?").bind(jobId).first<GeminiJobRow>();
  if (!found || ["completed", "partial", "failed"].includes(found.status)) return { deliverPendingEmails: false };
  const row = await claimJob(env, found);
  if (!row) return { deliverPendingEmails: false };
  if (row.kind === "market_analysis") {
    await failSingleJob(env, row, "market_analysis_retired", null);
    return { deliverPendingEmails: false };
  }
  if (row.kind === "search_overview") {
    try {
      const parsed = searchOverviewJobPayloadSchema.parse(await loadJobPayload(env, row));
      await processSearchOverviewJob(env, row, parsed);
    } catch (error) {
      await failSingleJob(env, row, safeJobError(error), null);
    }
    return { deliverPendingEmails: false };
  }
  if (row.kind === "product_target") {
    try {
      const parsed = productTargetJobPayloadSchema.parse(await loadJobPayload(env, row));
      await processProductTargetJob(env, row, parsed);
    } catch (error) {
      await failSingleJob(env, row, safeJobError(error), null);
    }
    return { deliverPendingEmails: false };
  }

  let payload: ListingJobPayload;
  let result: JobResult;
  try {
    payload = listingJobPayloadSchema.parse(await loadJobPayload(env, row));
    result = resultFromRow(row);
  } catch (error) {
    const message = safeJobError(error);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM market_listing_cleaning_claims WHERE job_id=?").bind(row.id),
      env.DB.prepare(
        "UPDATE gemini_jobs SET status='failed',last_error=?,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE id=?",
      ).bind(message, nowIso(), nowIso(), row.id),
    ]);
    return { deliverPendingEmails: false };
  }

  const deduplicatedItems = await enforceMarketClaimOwnership(env, row, payload, result);
  if (!result.states.includes("pending")) {
    return finishJob(
      env,
      row,
      payload,
      result,
      deduplicatedItems > 0 ? `${deduplicatedItems} 件已由其他清洗任务接管` : null,
    );
  }
  const cached = await cachedResult(env, payload.items, payload.inputHashes, row.prompt_version);
  let reusedFromCache = 0;
  cached.states.forEach((state, index) => {
    if (state !== "ready" || result.states[index] !== "pending") return;
    result.items[index] = cached.items[index] ?? null;
    result.states[index] = "ready";
    reusedFromCache += 1;
  });

  const pendingIndexes = result.states.flatMap((state, index) => state === "pending" ? [index] : []);
  // 巡检每轮都会把整个窗口重新派单——这是对的，价格、库存和事件都要靠这一轮的
  // 完整窗口算出来。省钱靠的是命中率：同一条商品语义没变就不该再问一次模型。
  // 命中率塌了就是账单要涨，所以它必须每次都留痕，而不是等月底看账单才发现。
  console.log(JSON.stringify({
    event: "gemini_listing_cache_outcome",
    jobId: row.id,
    kind: row.kind,
    bindingId: row.binding_id,
    promptVersion: row.prompt_version,
    totalItems: payload.items.length,
    reusedFromCache,
    pendingItems: pendingIndexes.length,
  }));
  if (pendingIndexes.length === 0) {
    return finishJob(
      env,
      row,
      payload,
      result,
      deduplicatedItems > 0 ? `${deduplicatedItems} 件已由其他清洗任务接管` : null,
    );
  }
  const pendingItems = pendingIndexes.map((index) => payload.items[index]!);
  // 批量大小、每件输出预留、单次请求 token 预算都来自 resolveGeminiSchedulerLimits，
  // 默认值是 2026-09-09 的实测值（输出 462 token/件，原先每件预留 3,000）。
  const limits = resolveGeminiSchedulerLimits(env as unknown as Record<string, unknown>);
  const selected = takeGeminiTokenBudgetBatch(
    pendingItems.slice(0, Math.min(limits.listingMaxBatchItems, result.batchCap ?? limits.listingMaxBatchItems)),
    (candidate) => listingEnrichmentProviderRequest(candidate, payload.query, payload.relevanceContext, {
      identityContract: payload.contract === LISTING_IDENTITY_CONTRACT_VERSION,
    }),
    limits.requestTokenBudget,
    limits.listingOutputTokenReserve,
  );
  const selectedIndexes = pendingIndexes.slice(0, selected.items.length);
  const capacity = await reserveGeminiCapacity(env, row.id, selected.estimatedInputTokens);
  if ("wait" in capacity) {
    const capacityWait = capacity.wait;
    await setWaiting(
      env,
      row,
      capacityWait.delaySeconds,
      null,
      geminiCapacityWaitMessage(capacityWait.reason),
    );
    return { deliverPendingEmails: false };
  }

  const apiKey = env.GOOGLE_AI_API_KEY?.trim() ?? "";
  let keySlot = capacity.slot;
  let response: Response;
  try {
    const providerRequest = await routeGeminiProviderRequest(env, {
      url: LISTING_ENRICHMENT_MODEL.url,
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: listingEnrichmentProviderRequest(selected.items, payload.query, payload.relevanceContext, {
        identityContract: payload.contract === LISTING_IDENTITY_CONTRACT_VERSION,
      }),
    }, {
      jobId: row.id,
      kind: row.kind,
    });
    const sent = await fetchGeminiWithFallbackKey(providerRequest, LISTING_PROVIDER_TIMEOUT_MILLISECONDS, {
      jobId: row.id,
      kind: row.kind,
    }, keySlot);
    response = sent.response;
    keySlot = sent.slot;
  } catch (error) {
    const message = safeJobError(error);
    if (isTimeoutError(error)) shrinkBatchAfterTimeout(row, result, selected.items.length);
    if (row.attempt_count < MAX_TRANSIENT_ATTEMPTS) {
      await requeueTransient(env, row, null, message, result);
      return { deliverPendingEmails: false };
    }
    return failPendingItems(env, row, payload, result, message, null);
  }

  let responseText: string;
  try {
    responseText = await readBoundedResponse(response);
  } catch (error) {
    return failPendingItems(env, row, payload, result, safeJobError(error), response.status);
  }
  if (response.status === 429) {
    const delay = parseGeminiRetryDelaySeconds(response.headers, responseText);
    const detail = safeGeminiTransportError(responseText);
    await setGeminiProviderCooldown(env, keySlot.provider, delay, response.status, detail);
    await setWaiting(env, row, delay, response.status, `Google AI HTTP 429：${detail}`);
    return { deliverPendingEmails: false };
  }
  if (!response.ok) {
    const detail = safeGeminiTransportError(responseText);
    const message = `Google AI HTTP ${response.status}：${detail}`;
    if (isTransientGeminiStatus(response.status) && row.attempt_count < MAX_TRANSIENT_ATTEMPTS) {
      await requeueTransient(env, row, response.status, message, result);
      return { deliverPendingEmails: false };
    }
    return failPendingItems(env, row, payload, result, message, response.status);
  }

  // 声明了身份契约的任务用稳定键绑定：重复 ID 两份都不采纳，多出来的 ID 不入库，
  // 结构错误不被洗成合法业务结论。其余链路继续用原来的宽松解析。
  const identityContract = payload.contract === LISTING_IDENTITY_CONTRACT_VERSION;
  const parsed = identityContract
    ? parseListingIdentityBatch(responseText, selected.items)
    : parseListingEnrichmentBatchPartial(responseText, selected.items);
  if (identityContract && "protocolErrors" in parsed && parsed.protocolErrors.length > 0) {
    console.warn(JSON.stringify({
      event: "listing_identity_contract_violation",
      jobId: row.id,
      batchStatus: parsed.batchStatus,
      protocolErrors: parsed.protocolErrors,
    }));
  }
  await persistChunk(
    env,
    row,
    payload,
    selectedIndexes,
    parsed.items,
    responseText,
    response.status,
    selected.estimatedInputTokens,
  );
  selectedIndexes.forEach((sourceIndex, localIndex) => {
    const output = parsed.items[localIndex];
    if (output) {
      result.items[sourceIndex] = output;
      result.states[sourceIndex] = "ready";
      return;
    }
    const attempts = Math.min(MAX_ITEM_PARSE_ATTEMPTS, result.parseAttempts[sourceIndex]! + 1);
    result.parseAttempts[sourceIndex] = attempts;
    if (attempts >= MAX_ITEM_PARSE_ATTEMPTS) result.states[sourceIndex] = "failed";
  });
  const counts = resultCounts(result);
  if (!result.states.includes("pending")) {
    const rejected = counts.failed > 0
      ? deduplicatedItems > 0
        ? `${counts.failed} 件未由本任务生成（其中 ${deduplicatedItems} 件已去重）`
        : `${counts.failed} 件模型输出无法解析`
      : null;
    return finishJob(env, row, payload, result, rejected);
  }
  // 这一批判出来了，把 attempt_count 归零。它是「领取过几次」，而退避
  // （`requeueTransient`：30×2^attempt，封顶 1 小时）和瞬时故障上限
  // （`MAX_TRANSIENT_ATTEMPTS`）都拿它当失败次数用——可分批任务每推进一批就要
  // 领取一次，于是任务越大、跑得越久，就越像「一直在失败」，被自己的退避冻住。
  //
  // 2026-09-21 的实测：mercari 那 68 件从 11:08 到 15:44 的四个半小时里只判完
  // 37 件（约两批），正是退避顶到 1 小时后每小时挪一批的节奏；rakuten 一批都没
  // 成过，attempt_count 一路撞上瞬时故障上限被判死，20 件一件没看。同一小时里
  // Worker 执行 154 次全部 outcome=ok，没有 CPU 超限也没有中断——任务不是被
  // 外部掐断的，是被自己的退避锁死的。
  //
  // 归零只发生在真有进展的时候：一批都判不出来就不重置，退避照常指数增长，
  // 该判死的仍然会判死。
  await env.DB.prepare(
    `UPDATE gemini_jobs SET status='queued',result_json=?,completed_items=?,failed_items=?,lease_expires_at=NULL,
       next_attempt_at=NULL,attempt_count=0,upstream_status=?,last_error=NULL,updated_at=? WHERE id=?`,
  ).bind(JSON.stringify(result), counts.completed, counts.failed, response.status, nowIso(), row.id).run();
  await enqueueJobMessage(env, row.id);
  return { deliverPendingEmails: false };
}

async function migrateHistoricalMarketCleaningToCurrentModel(env: GeminiEnv): Promise<number> {
  const migrationMarker = `历史市场清洗已迁移到 ${LISTING_ENRICHMENT_MODEL.model}`;
  const legacyBackfillMarker = `历史回填已迁移到 ${LISTING_ENRICHMENT_MODEL.model}`;
  const rows = await env.DB.prepare(
    `SELECT * FROM gemini_jobs
     WHERE kind='listing_enrichment' AND model<>?
       AND status IN ('queued','waiting_rate_limit','completed','partial','failed')
       AND (last_error IS NULL OR strpos(last_error,?)=0)
       AND (last_error IS NULL OR strpos(last_error,?)=0)
     ORDER BY created_at,id LIMIT 25`,
  ).bind(LISTING_ENRICHMENT_MODEL.model, migrationMarker, legacyBackfillMarker).all<GeminiJobRow>();
  let migrated = 0;
  for (const row of rows.results) {
    let payload: ListingJobPayload;
    try {
      payload = listingJobPayloadSchema.parse(await loadJobPayload(env, row));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "gemini_model_migration_skipped",
        jobId: row.id,
        error: safeJobError(error),
      }));
      continue;
    }
    if (!payload.market) continue;
    const dedupeKey = await sha256Hex(JSON.stringify({
      kind: "market_listing_enrichment_model_migration",
      predecessorJobId: row.id,
      model: LISTING_ENRICHMENT_MODEL.model,
      promptVersion: row.prompt_version,
      inputHashes: payload.inputHashes,
    }));
    const replacement = await insertListingJob(env, {
      kind: "listing_enrichment",
      dedupeKey,
      promptVersion: row.prompt_version,
      payload,
      result: initialResult(payload.items.length),
    });
    const wasActive = row.status === "queued" || row.status === "waiting_rate_limit";
    let resultJson = row.result_json;
    let completedItems = row.completed_items;
    let failedItems = row.failed_items;
    let status = row.status;
    if (wasActive) {
      const retiredResult = resultFromRow(row);
      retiredResult.states = retiredResult.states.map((state) => state === "pending" ? "failed" : state);
      const retiredCounts = resultCounts(retiredResult);
      resultJson = JSON.stringify(retiredResult);
      completedItems = retiredCounts.completed;
      failedItems = retiredCounts.failed;
      status = retiredCounts.completed > 0 ? "partial" : "failed";
    }
    const completedAt = nowIso();
    const migrationNote = `${migrationMarker}（任务 ${replacement.id}）`;
    const lastError = [migrationNote, row.last_error?.trim()].filter(Boolean).join("；").slice(0, 500);
    const retirement = await env.DB.batch([
      env.DB.prepare(
        `UPDATE gemini_jobs SET status=?,result_json=?,completed_items=?,failed_items=?,
           lease_expires_at=NULL,next_attempt_at=NULL,last_error=?,updated_at=?,completed_at=?
         WHERE id=? AND model<>? AND status=?
           AND (last_error IS NULL OR strpos(last_error,?)=0)
           AND (last_error IS NULL OR strpos(last_error,?)=0)`,
      ).bind(
        status,
        resultJson,
        completedItems,
        failedItems,
        lastError,
        completedAt,
        wasActive ? completedAt : row.completed_at ?? completedAt,
        row.id,
        LISTING_ENRICHMENT_MODEL.model,
        row.status,
        migrationMarker,
        legacyBackfillMarker,
      ),
      env.DB.prepare("DELETE FROM market_listing_cleaning_claims WHERE job_id=?").bind(row.id),
    ]);
    if (Number(retirement[0]?.meta.changes ?? 0) === 0) continue;
    migrated += 1;
    console.log(JSON.stringify({
      event: "gemini_historical_market_cleaning_model_migrated",
      predecessorJobId: row.id,
      replacementJobId: replacement.id,
      previousModel: row.model,
      model: LISTING_ENRICHMENT_MODEL.model,
      totalItems: payload.items.length,
    }));
  }
  return migrated;
}

export async function recoverGeminiJobs(env: GeminiEnv): Promise<number> {
  const migrated = await migrateHistoricalMarketCleaningToCurrentModel(env);
  const now = nowIso();
  const staleQueued = new Date(Date.now() - 2 * 60_000).toISOString();
  const abandonedStaging = new Date(Date.now() - 60 * 60_000).toISOString();
  const expiredTerminal = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare("DELETE FROM gemini_jobs WHERE status='staging' AND updated_at<=?")
    .bind(abandonedStaging).run();
  await env.DB.prepare(
    `DELETE FROM gemini_jobs WHERE id IN (
       SELECT id FROM gemini_jobs
       WHERE status IN ('completed','partial','failed') AND completed_at<=?
       ORDER BY completed_at LIMIT 25
     )`,
  ).bind(expiredTerminal).run();
  const rows = await env.DB.prepare(
    `SELECT id FROM gemini_jobs
     WHERE (status='waiting_rate_limit' AND next_attempt_at<=?)
        OR (status='queued' AND updated_at<=?)
        OR (status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=?))
     ORDER BY created_at LIMIT 25`,
  ).bind(now, staleQueued, now).all<{ id: string }>();
  let queued = 0;
  for (const row of rows.results) {
    if (await enqueueJobMessage(env, row.id)) {
      queued += 1;
      await env.DB.prepare("UPDATE gemini_jobs SET updated_at=? WHERE id=?").bind(nowIso(), row.id).run();
    }
  }
  return queued + migrated;
}

/**
 * 这一轮里判定没跑完就终结的任务。`pendingKeywordGeminiJobs` 数的是还在路上的，
 * 这里要的是另一件事：已经没有下文、但还有商品从没被看过一眼的——被判死的
 * （failed），以及模型输出反复解析不出来的（partial）。
 *
 * 日报原本只按抓取状态报「哪些源这轮不完整」。2026-09-21 抓取 7 个源全部成功、
 * 判定全军覆没，那封日报只要发出去就会显示一切正常，而 189 件商品没有一件被判过。
 * 抓回来不等于看过：缺了多少必须写在邮件里，否则用户只能靠「今天怎么这么少」去猜，
 * 而这次的实际结果是整整一天没人发现。
 */
export async function abandonedKeywordGeminiJobs(
  env: Pick<GeminiEnv, "DB">,
  bindingIds: readonly string[],
  scanStartedAt: string,
): Promise<Array<{ bindingId: string; totalItems: number; completedItems: number }>> {
  if (bindingIds.length === 0) return [];
  const placeholders = bindingIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT binding_id,total_items,completed_items FROM gemini_jobs
     WHERE kind='keyword_enrichment' AND binding_id IN (${placeholders}) AND scan_started_at>=?
       AND status IN ('failed','partial') AND completed_items<total_items`,
  ).bind(...bindingIds, scanStartedAt).all<{
    binding_id: string | null;
    total_items: number;
    completed_items: number;
  }>();
  return rows.results.flatMap((row) => row.binding_id
    ? [{
      bindingId: row.binding_id,
      totalItems: Number(row.total_items ?? 0),
      completedItems: Number(row.completed_items ?? 0),
    }]
    : []);
}

export async function pendingKeywordGeminiJobs(
  env: Pick<GeminiEnv, "DB">,
  bindingIds: readonly string[],
  scanStartedAt: string,
): Promise<number> {
  if (bindingIds.length === 0) return 0;
  const placeholders = bindingIds.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) count FROM gemini_jobs
     WHERE kind='keyword_enrichment' AND binding_id IN (${placeholders}) AND scan_started_at>=?
       AND status NOT IN ('completed','partial','failed')`,
  ).bind(...bindingIds, scanStartedAt).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
