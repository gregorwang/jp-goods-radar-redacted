import {
  resolveProductIdentityByCanonicalName,
  type ProductIdentityProjection,
} from "@jpgr/analytics";
import {
  EXACT_IDENTITY_REASON_TEXT,
  exactProductIdentityDecision,
  type ExactIdentityAiItemStatus,
  type ExactIdentityDecision,
  type ExactIdentityProcessingStatus,
  type ExactIdentityReasonCode,
  type ExactIdentitySaleRelation,
} from "./exact-identity-decision";
import {
  assessProductMatch,
  buildProductMatchCorpus,
  candidateKey,
  normalizeProductSearchText,
  productFingerprintNameConflicts,
  sha256Hex,
  type NormalizedListing,
  type ProductFingerprint,
  type ProductMatchCorpus,
  type ProductMatchDifference,
  type ProductMatchRelation,
  type ProductSearchPlan,
  type SearchCandidateEvidence,
  type SourceId,
} from "@jpgr/core";
import type { OperationalDatabase } from "@jpgr/db";
import { normalizedListingSchema, productFingerprintSchema } from "@jpgr/validation";
import { enqueueAnalyticsOutbox } from "./analytics";

export {
  EXACT_IDENTITY_REASON_TEXT,
  exactProductIdentityDecision,
  type ExactIdentityAiItemStatus,
  type ExactIdentityDecision,
  type ExactIdentityProcessingStatus,
  type ExactIdentityReasonCode,
  type ExactIdentitySaleRelation,
};
import type { RuntimeEnv as Env } from "./runtime-env";

export const PRODUCT_IDENTITY_VERSION = "product-identity-v1" as const;
export const PRODUCT_IDENTITY_RESOLUTION_VERSION = "canonical-name-resolution-v2" as const;
// v5：判定语义改变（计划 §10.2）。v4 下的 confirmed / rejected 是按 relation 短路
// 得到的，其中的 rejected 大量是「没找到证据」而不是「找到了反证」。
//
// v6：语义与 v5 完全相同，升版只为一件事——**v5 的 10 份投影一行也没生效**。
// 它们沿用了原任务的时间戳，被入库函数的 `valid_from >= v_projected_at` 一条挡掉了。
// 时间戳 bug 已修，但那 10 行 v5 投影记录还在，而补算条件正是按「有没有这个版本的
// 投影」判断的，继续用 v5 会让这 10 个任务永远被跳过。
//
// 选升版而不是删那 10 行：删掉就把「有过一次失败的迁移尝试」这个事实一并抹了。
// 这个仓库对历史的一贯做法是用版本关系向前表达，不是删掉重来（§10.4 第 6 条）。
export const PRODUCT_MEMBERSHIP_VERSION = "product-listing-membership-v6" as const;
export const PRODUCT_COMPARISON_PROFILE_VERSION = 1 as const;
export const PRODUCT_COMPARISON_RULE_VERSION = "product-comparison-rules-v1" as const;

interface ProductIdentityEnv {
  DB: OperationalDatabase;
  ANALYTICS_DB: Hyperdrive;
  MONITOR_QUEUE: Queue;
}

interface WorkflowTaskRow {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  plan_json: string;
  history_id: string | null;
  ai_job_id: string | null;
  completed_at: string | null;
  created_at: string;
}

interface WorkflowResultRow {
  source_id: SourceId;
  group_json: string;
}

interface GeminiProjectionRow {
  id: string;
  status: "staging" | "queued" | "processing" | "waiting_rate_limit" | "completed" | "partial" | "failed";
  model: string;
  prompt_version: string;
  result_json: string | null;
  completed_at: string | null;
  last_error: string | null;
}

interface AiManifest {
  candidateKeys?: string[];
  settledItems?: Array<Record<string, unknown> | null>;
  settledStates?: Array<"pending" | "ready" | "failed">;
}

interface StoredGroup {
  sourceId: SourceId;
  listings: unknown[];
  candidateEvidence?: Record<string, SearchCandidateEvidence>;
}

interface StoredAiResult {
  items?: Array<Record<string, unknown> | null>;
  states?: Array<"pending" | "ready" | "failed">;
}

interface DecisionDraft {
  sourceId: string;
  sourceItemId: string;
  decision: "confirmed" | "rejected" | "uncertain";
  decisionSource: "workflow_matcher" | "workflow_ai";
  relation: ProductMatchRelation;
  confidence: "high" | "medium" | "low";
  /** 解释档位的理由码与处理状态，随证据一起落库，供审计和界面读取。 */
  reasonCode: ExactIdentityReasonCode;
  processingStatus: ExactIdentityProcessingStatus;
  saleRelation: ExactIdentitySaleRelation;
  evidence: Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsedRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function normalizedIdentityString(value: string | undefined): string | undefined {
  const normalized = value ? normalizeProductSearchText(value) : "";
  return normalized || undefined;
}

function normalizedIdentityTarget(target: ProductFingerprint): Record<string, unknown> {
  const values = {
    canonicalName: normalizedIdentityString(target.canonicalName),
    workTitle: normalizedIdentityString(target.workTitle),
    characters: target.characters.map(normalizeProductSearchText).filter(Boolean).sort(),
    productType: normalizedIdentityString(target.productType),
    manufacturer: normalizedIdentityString(target.manufacturer),
    series: normalizedIdentityString(target.series),
    model: normalizedIdentityString(target.model),
    jan: normalizedIdentityString(target.jan)?.replace(/[\s-]/gu, ""),
    size: normalizedIdentityString(target.size),
    color: normalizedIdentityString(target.color),
    aliases: target.aliases.map(normalizeProductSearchText).filter(Boolean).sort(),
    excludedTerms: target.excludedTerms.map(normalizeProductSearchText).filter(Boolean).sort(),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function listingConfidence(evidence: SearchCandidateEvidence | undefined): "high" | "medium" | "low" {
  const confidence = evidence?.match?.confidence;
  return confidence === "high" || confidence === "medium" ? confidence : "low";
}

function relationValue(evidence: SearchCandidateEvidence | undefined): ProductMatchRelation {
  const relation = evidence?.match?.relation;
  return relation === "exact" || relation === "probable_exact" || relation === "variant"
    || relation === "bundle" || relation === "related" || relation === "irrelevant"
    ? relation
    : "uncertain";
}

function storedGroups(rows: readonly WorkflowResultRow[]): Array<StoredGroup & { listings: NormalizedListing[] }> {
  return rows.flatMap((row) => {
    const raw = parsedRecord(row.group_json);
    const sourceId = typeof raw.sourceId === "string" ? raw.sourceId as SourceId : row.source_id;
    const listings = Array.isArray(raw.listings)
      ? raw.listings.flatMap((value) => {
          const parsed = normalizedListingSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    const candidateEvidence = recordValue(raw.candidateEvidence) as Record<string, SearchCandidateEvidence>;
    return [{ sourceId, listings, candidateEvidence }];
  });
}

/**
 * 每条候选的模型处理结果**和处理状态**。
 *
 * 旧实现只返回 ready 的那些输出，于是「没送过模型」「送了但模型漏了这条」
 * 「送了但输出坏了」三件事在下游长得一模一样——都表现为 output === undefined，
 * 然后被同一条 relation 短路处理掉。计划 §9 要求这三件事分别表达，这里是起点。
 */
function aiOutcomes(
  manifest: AiManifest,
  job: GeminiProjectionRow | null,
): Map<string, { output?: Record<string, unknown>; status: ExactIdentityAiItemStatus }> {
  const keys = Array.isArray(manifest.candidateKeys)
    ? manifest.candidateKeys.filter((value): value is string => typeof value === "string")
    : [];
  const persistedResult = parsedRecord(job?.result_json ?? null) as StoredAiResult;
  const result: StoredAiResult = manifest.settledItems && manifest.settledStates
    ? { items: manifest.settledItems, states: manifest.settledStates }
    : persistedResult;
  const outcomes = new Map<string, { output?: Record<string, unknown>; status: ExactIdentityAiItemStatus }>();
  for (const [index, key] of keys.entries()) {
    const state = result.states?.[index];
    const item = result.items?.[index] ?? undefined;
    if (state === "ready" && item) {
      outcomes.set(key, { output: item, status: "ready" });
      continue;
    }
    // failed 是模型侧已经放弃的条目（解析连续失败）；pending 是这一轮根本没settle。
    outcomes.set(key, { status: state === "failed" ? "contract_error" : "missing" });
  }
  return outcomes;
}

/**
 * 判定草稿。
 *
 * 匹配结果**从冻结的商品文本重算**，不直接用 group_json 里存的那份。
 *
 * 存的那份是当时那个版本的匹配器算出来的**派生结果**，不是证据本身；
 * 证据是商品标题与详情原文，它们原样冻结在那里。匹配器新增了差异维度时
 * （例如候选多出来的版本 / 整盒标记），回放旧派生结果会把新规则量成“没效果”，
 * 定向重判（计划 §10.4）也就修不掉当时那批错误确认。
 *
 * 目标指纹仍然用任务冻结的那份，不重新抽取——否则重判的就不是同一件商品了。
 * 旧匹配结果不丢：它进入 evidence.previousMatch，两边不一致时可以审计到。
 */
async function decisionDrafts(
  groups: readonly (StoredGroup & { listings: NormalizedListing[] })[],
  manifest: AiManifest,
  job: GeminiProjectionRow | null,
  target?: ProductFingerprint,
): Promise<DecisionDraft[]> {
  const outcomes = aiOutcomes(manifest, job);
  const corpusByGroup = new Map<(typeof groups)[number], ProductMatchCorpus>();
  if (target) {
    for (const group of groups) corpusByGroup.set(group, buildProductMatchCorpus(group.listings, target));
  }
  const seen = new Set<string>();
  const drafts: DecisionDraft[] = [];
  for (const group of groups) {
    for (const listing of group.listings) {
      const key = candidateKey(listing.sourceId, listing.sourceItemId);
      if (seen.has(key)) continue;
      seen.add(key);
      const deterministic = group.candidateEvidence?.[listing.sourceItemId];
      const corpus = target ? corpusByGroup.get(group) : undefined;
      const recomputed = target
        ? assessProductMatch(listing, target, deterministic?.hits ?? [], corpus)
        : undefined;
      const effectiveMatch = recomputed ?? deterministic?.match;
      const relation = recomputed
        ? recomputed.relation
        : relationValue(deterministic);
      const outcome = outcomes.get(key);
      // 投影必须和通知路径用同一套判据，否则同一件商品会「发了邮件但档案里记为存疑」。
      const decision = exactProductIdentityDecision({
        relation,
        ...(outcome?.output ? { output: outcome.output } : {}),
        ...(effectiveMatch
          ? {
            match: {
              ...(effectiveMatch.difference ? { difference: effectiveMatch.difference } : {}),
              conflicts: effectiveMatch.conflicts,
              matchedFields: effectiveMatch.matchedFields,
            },
          }
          : {}),
        aiItemStatus: outcome?.status ?? "not_executed",
      });
      drafts.push({
        sourceId: listing.sourceId,
        sourceItemId: listing.sourceItemId,
        relation,
        ...decision,
        confidence: decision.decisionSource === "workflow_matcher"
          ? decision.confidence === "high" ? "high" : listingConfidence(deterministic)
          : decision.confidence,
        evidence: {
          deterministicMatch: effectiveMatch ?? null,
          // 重算结果与当时落库的那份不一致时保留旧值，否则不写——
          // 重判必须能看出是哪一步变了（计划 §10.4 第 5 条）。
          ...(recomputed && deterministic?.match && deterministic.match.relation !== recomputed.relation
            ? { previousMatch: deterministic.match }
            : {}),
          candidateEvidenceVersion: effectiveMatch?.version ?? null,
          reasonCode: decision.reasonCode,
          processingStatus: decision.processingStatus,
          saleRelation: decision.saleRelation,
          aiItemStatus: outcome?.status ?? "not_executed",
          aiJob: job ? {
            id: job.id,
            status: job.status,
            model: job.model,
            promptVersion: job.prompt_version,
            completedAt: job.completed_at,
          } : null,
          aiOutput: outcome?.output ?? null,
        },
      });
    }
  }
  return drafts.sort((left, right) => `${left.sourceId}:${left.sourceItemId}`
    .localeCompare(`${right.sourceId}:${right.sourceItemId}`));
}

async function productIdentity(env: ProductIdentityEnv, target: ProductFingerprint): Promise<{
  canonicalHash: string;
  variantHash: string;
  canonicalProductId: string;
  productVariantId: string;
  comparisonProfileId: string;
  identityVersion: string;
  resolution: "canonical_name" | "derived_hash";
}> {
  const conflicts = productFingerprintNameConflicts(target);
  if (conflicts.length > 0) {
    throw new Error(`product_identity_target_conflict:${conflicts.join(",")}`);
  }
  const normalized = normalizedIdentityTarget(target);
  const existing = target.canonicalName
    ? await resolveProductIdentityByCanonicalName(
        env.ANALYTICS_DB.connectionString,
        { ...normalized, canonicalName: target.canonicalName },
      )
    : undefined;
  if (existing) {
    return {
      canonicalHash: existing.canonicalHash,
      variantHash: existing.variantHash,
      canonicalProductId: existing.canonicalProductId,
      productVariantId: existing.productVariantId,
      comparisonProfileId: `cmp_${existing.productVariantId.slice(3)}_v${PRODUCT_COMPARISON_PROFILE_VERSION}`,
      identityVersion: existing.identityVersion,
      resolution: "canonical_name",
    };
  }
  // P0-B deliberately starts conservatively: if the target name still mixes a
  // canonical product and edition dimensions, one canonical concept maps to one
  // variant. A future human split can create narrower variants without merging
  // evidence that was never proven equivalent.
  const canonicalHash = await sha256Hex(JSON.stringify({ version: PRODUCT_IDENTITY_VERSION, normalized }));
  const variantHash = await sha256Hex(JSON.stringify({
    version: PRODUCT_IDENTITY_VERSION,
    canonicalHash,
    normalized,
  }));
  return {
    canonicalHash,
    variantHash,
    canonicalProductId: `cp_${canonicalHash.slice(0, 24)}`,
    productVariantId: `pv_${variantHash.slice(0, 24)}`,
    comparisonProfileId: `cmp_${variantHash.slice(0, 24)}_v${PRODUCT_COMPARISON_PROFILE_VERSION}`,
    identityVersion: PRODUCT_IDENTITY_VERSION,
    resolution: "derived_hash",
  };
}

function productIdentityDisplayName(target: ProductFingerprint, fallback: string): string {
  return target.canonicalName
    || [target.characters[0], target.productType, target.model].filter(Boolean).join(" ")
    || fallback;
}

async function buildProductIdentityProjection(input: {
  env: ProductIdentityEnv;
  workflowTaskId: string;
  searchHistoryId: string;
  target: ProductFingerprint;
  projectedAt: string;
  drafts: readonly DecisionDraft[];
  projectionSeed: Record<string, unknown>;
}): Promise<ProductIdentityProjection> {
  const identity = await productIdentity(input.env, input.target);
  const projectionHash = await sha256Hex(JSON.stringify({
    identityVersion: identity.identityVersion,
    identityResolutionVersion: PRODUCT_IDENTITY_RESOLUTION_VERSION,
    membershipVersion: PRODUCT_MEMBERSHIP_VERSION,
    ...input.projectionSeed,
    variantId: identity.productVariantId,
    decisions: input.drafts,
  }));
  const memberships: ProductIdentityProjection["memberships"] = await Promise.all(
    input.drafts.map(async (draft) => {
      const membershipHash = await sha256Hex(JSON.stringify({ projectionHash, ...draft }));
      return { id: `pm_${membershipHash.slice(0, 32)}`, ...draft };
    }),
  );
  const displayName = productIdentityDisplayName(input.target, identity.productVariantId);
  return {
    projectionId: `pip_${projectionHash.slice(0, 32)}`,
    projectionHash,
    workflowTaskId: input.workflowTaskId,
    searchHistoryId: input.searchHistoryId,
    identityVersion: identity.identityVersion,
    membershipVersion: PRODUCT_MEMBERSHIP_VERSION,
    projectedAt: input.projectedAt,
    canonicalProduct: {
      id: identity.canonicalProductId,
      identityHash: identity.canonicalHash,
      identityVersion: identity.identityVersion,
      canonicalName: displayName,
      ...(input.target.workTitle ? { workTitle: input.target.workTitle } : {}),
      characterNames: input.target.characters,
      ...(input.target.productType ? { productType: input.target.productType } : {}),
      ...(input.target.manufacturer ? { manufacturer: input.target.manufacturer } : {}),
      ...(input.target.series ? { series: input.target.series } : {}),
      targetFingerprint: recordValue(input.target),
    },
    productVariant: {
      id: identity.productVariantId,
      canonicalProductId: identity.canonicalProductId,
      identityHash: identity.variantHash,
      identityVersion: identity.identityVersion,
      variantName: displayName,
      ...(input.target.model ? { model: input.target.model } : {}),
      ...(input.target.jan ? { jan: input.target.jan } : {}),
      ...(input.target.size ? { size: input.target.size } : {}),
      attributes: {
        aliases: input.target.aliases,
        excludedTerms: input.target.excludedTerms,
        referenceUrl: input.target.referenceUrl ?? null,
        color: input.target.color ?? null,
        identityResolution: identity.resolution,
        identityResolutionVersion: PRODUCT_IDENTITY_RESOLUTION_VERSION,
      },
      targetFingerprint: recordValue(input.target),
    },
    comparisonProfile: {
      id: identity.comparisonProfileId,
      profileVersion: PRODUCT_COMPARISON_PROFILE_VERSION,
      ruleVersion: PRODUCT_COMPARISON_RULE_VERSION,
      name: "同款公开标价宽口径",
      conditionPolicy: "broad_public_asking_price",
      allowedConditions: ["new", "used", "collectible", "refurbished", "unknown"],
      allowedCompleteness: ["complete", "unknown"],
      allowedPriceBases: ["listing_price"],
      allowedOfficialStatuses: ["official", "unknown"],
    },
    memberships,
  };
}

async function persistProductIdentityProjection(
  env: ProductIdentityEnv,
  projection: ProductIdentityProjection,
): Promise<ProductIdentityProjection> {
  const existing = await env.DB.prepare(
    "SELECT projection_json FROM product_identity_projection_versions WHERE id=?",
  ).bind(projection.projectionId).first<{ projection_json: string }>();
  if (existing) return JSON.parse(existing.projection_json) as ProductIdentityProjection;

  const counts = projection.memberships.reduce((result, membership) => {
    result[membership.decision] += 1;
    return result;
  }, { confirmed: 0, rejected: 0, uncertain: 0 });
  const outboxId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO analytics_outbox(
         id,kind,reference_id,payload_json,status,created_at,updated_at
       ) VALUES(?,'product_identity',?,?,'pending',?,?)`,
    ).bind(
      outboxId,
      projection.projectionId,
      JSON.stringify(projection),
      projection.projectedAt,
      projection.projectedAt,
    ),
    env.DB.prepare(
      `INSERT INTO product_identity_projection_versions(
         id,projection_hash,workflow_task_id,search_history_id,canonical_product_id,
         product_variant_id,comparison_profile_id,identity_version,membership_version,
         projection_json,membership_count,confirmed_count,rejected_count,uncertain_count,
         analytics_outbox_id,projected_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      projection.projectionId,
      projection.projectionHash,
      projection.workflowTaskId,
      projection.searchHistoryId,
      projection.canonicalProduct.id,
      projection.productVariant.id,
      projection.comparisonProfile.id,
      projection.identityVersion,
      projection.membershipVersion,
      JSON.stringify(projection),
      projection.memberships.length,
      counts.confirmed,
      counts.rejected,
      counts.uncertain,
      outboxId,
      projection.projectedAt,
    ),
  ]);
  await enqueueAnalyticsOutbox(env as Env & { ANALYTICS_DB: Hyperdrive }, outboxId);
  return projection;
}

async function bindExactWatchProfileIdentity(input: {
  env: ProductIdentityEnv;
  bindingId: string;
  productVariantId: string;
  searchHistoryId: string;
  boundAt: string;
}): Promise<void> {
  const profile = await input.env.DB.prepare(
    `SELECT profile.id,profile.product_variant_id
     FROM watch_bindings AS binding
     JOIN watch_profiles AS profile ON profile.id=binding.watch_profile_id
     WHERE binding.id=? AND profile.dossier_kind='exact_product'`,
  ).bind(input.bindingId).first<{ id: string; product_variant_id: string | null }>();
  if (!profile) return;
  if (profile.product_variant_id && profile.product_variant_id !== input.productVariantId) {
    console.error("exact_watch_product_identity_conflict", JSON.stringify({
      bindingId: input.bindingId,
      profileId: profile.id,
      existingProductVariantId: profile.product_variant_id,
      projectedProductVariantId: input.productVariantId,
    }));
    return;
  }
  await input.env.DB.batch([
    input.env.DB.prepare(
      `UPDATE watch_profiles
       SET product_variant_id=COALESCE(product_variant_id,?),
           product_identity_search_history_id=?,
           updated_at=?
       WHERE id=? AND (product_variant_id IS NULL OR product_variant_id=?)`,
    ).bind(
      input.productVariantId,
      input.searchHistoryId,
      input.boundAt,
      profile.id,
      input.productVariantId,
    ),
    input.env.DB.prepare(
      `UPDATE monitor_rules
       SET scope_id=?,scope_identity_status='bound'
       WHERE watch_profile_id=? AND valid_to IS NULL
         AND scope_type='variant'
         AND (scope_identity_status='pending' OR scope_id=?)`,
    ).bind(input.productVariantId, profile.id, input.productVariantId),
  ]);
}

export async function materializeProductIdentityForExactWatch(input: {
  env: ProductIdentityEnv;
  bindingId: string;
  aiJobId: string;
  aiJobStatus: "completed" | "partial" | "failed";
  model: string;
  promptVersion: string;
  completedAt: string;
  watchRunId: string;
  target: ProductFingerprint;
  listings: readonly NormalizedListing[];
  matchRelations: readonly ProductMatchRelation[];
  matcherVersion: string;
  aiOutputs: readonly (Record<string, unknown> | null)[];
}): Promise<ProductIdentityProjection | undefined> {
  if (input.listings.length === 0
    || input.matchRelations.length !== input.listings.length
    || input.aiOutputs.length !== input.listings.length) {
    return undefined;
  }
  const drafts = input.listings.map((listing, index): DecisionDraft => {
    const relation = input.matchRelations[index] ?? "uncertain";
    const output = input.aiOutputs[index] ?? undefined;
    const assessment = assessProductMatch(listing, input.target);
    const decision = exactProductIdentityDecision({
      relation,
      ...(output ? { output } : {}),
      match: {
        ...(assessment.difference ? { difference: assessment.difference } : {}),
        conflicts: assessment.conflicts,
        matchedFields: assessment.matchedFields,
      },
      aiItemStatus: output ? "ready" : "not_executed",
    });
    return {
      sourceId: listing.sourceId,
      sourceItemId: listing.sourceItemId,
      relation,
      ...decision,
      evidence: {
        origin: "exact_product_watch",
        reasonCode: decision.reasonCode,
        processingStatus: decision.processingStatus,
        saleRelation: decision.saleRelation,
        deterministicMatch: {
          relation,
          conflicts: assessment.conflicts,
          version: input.matcherVersion,
        },
        aiJob: {
          id: input.aiJobId,
          status: input.aiJobStatus,
          model: input.model,
          promptVersion: input.promptVersion,
          completedAt: input.completedAt,
        },
        aiOutput: output ?? null,
      },
    };
  }).sort((left, right) => `${left.sourceId}:${left.sourceItemId}`
    .localeCompare(`${right.sourceId}:${right.sourceItemId}`));
  const projection = await buildProductIdentityProjection({
    env: input.env,
    workflowTaskId: `watch:${input.aiJobId}`,
    searchHistoryId: input.watchRunId,
    target: input.target,
    projectedAt: input.completedAt,
    drafts,
    projectionSeed: {
      origin: "exact_product_watch",
      aiJobId: input.aiJobId,
    },
  });
  const persisted = await persistProductIdentityProjection(input.env, projection);
  await bindExactWatchProfileIdentity({
    env: input.env,
    bindingId: input.bindingId,
    productVariantId: persisted.productVariant.id,
    searchHistoryId: persisted.searchHistoryId,
    boundAt: input.completedAt,
  });
  return persisted;
}

async function loadTask(env: ProductIdentityEnv, taskId: string) {
  const [task, results] = await Promise.all([
    env.DB.prepare(
      `SELECT id,status,plan_json,history_id,ai_job_id,completed_at,created_at
       FROM product_search_workflow_tasks WHERE id=?`,
    ).bind(taskId).first<WorkflowTaskRow>(),
    env.DB.prepare(
      `SELECT source_id,group_json FROM product_search_workflow_results
       WHERE task_id=? ORDER BY source_id`,
    ).bind(taskId).all<WorkflowResultRow>(),
  ]);
  if (!task || task.status !== "completed" || !task.history_id) return undefined;
  const plan = parsedRecord(task.plan_json) as unknown as ProductSearchPlan;
  const target = productFingerprintSchema.safeParse(plan.target);
  if (plan.mode !== "exact_product" || !target.success) return undefined;
  const manifestRow = await env.DB.prepare(
    "SELECT ai_manifest_json FROM product_search_workflow_tasks WHERE id=?",
  ).bind(taskId).first<{ ai_manifest_json: string | null }>();
  const job = task.ai_job_id
    ? await env.DB.prepare(
        `SELECT id,status,model,prompt_version,result_json,completed_at,last_error
         FROM gemini_jobs WHERE id=?`,
      ).bind(task.ai_job_id).first<GeminiProjectionRow>()
    : null;
  return {
    task,
    target: target.data,
    groups: storedGroups(results.results),
    manifest: parsedRecord(manifestRow?.ai_manifest_json ?? null) as AiManifest,
    job: job ?? null,
  };
}

export async function materializeProductIdentityForTask(
  env: ProductIdentityEnv,
  taskId: string,
): Promise<ProductIdentityProjection | undefined> {
  const loaded = await loadTask(env, taskId);
  if (!loaded) return undefined;
  const historyId = loaded.task.history_id;
  if (!historyId) return undefined;
  const drafts = await decisionDrafts(loaded.groups, loaded.manifest, loaded.job, loaded.target);
  // 首次投影用任务自己的完成时间；**重判用当下时间**。
  //
  // 重判是今天做出的新判断，只是用的是当时冻结的证据——时间戳属于判断，
  // 不属于证据。沿用原时间会被入库函数的
  // `valid_from >= v_projected_at → CONTINUE` 那道保护挡下来（它本来是用来防
  // “队列里的旧响应覆盖较新结果”的，见 §10.6），于是投影建了、成员判定却一动不动。
  const alreadyProjected = await env.DB.prepare(
    "SELECT 1 AS present FROM product_identity_projection_versions WHERE workflow_task_id=? LIMIT 1",
  ).bind(taskId).first<{ present: number }>();
  const projectedAt = alreadyProjected
    ? new Date().toISOString()
    : loaded.job?.completed_at ?? loaded.task.completed_at ?? loaded.task.created_at;
  const projection = await buildProductIdentityProjection({
    env,
    workflowTaskId: taskId,
    searchHistoryId: historyId,
    projectedAt,
    target: loaded.target,
    drafts,
    projectionSeed: {
      taskId,
    },
  });
  return persistProductIdentityProjection(env, projection);
}

export async function materializeProductIdentitiesForAiJob(
  env: ProductIdentityEnv,
  aiJobId: string,
): Promise<number> {
  const tasks = await env.DB.prepare(
    `SELECT id FROM product_search_workflow_tasks
     WHERE ai_job_id=? AND status='completed' ORDER BY created_at`,
  ).bind(aiJobId).all<{ id: string }>();
  let materialized = 0;
  for (const task of tasks.results) {
    if (await materializeProductIdentityForTask(env, task.id)) materialized += 1;
  }
  return materialized;
}

/**
 * 投影补算。接两类任务：
 *
 * 1. 从来没投影过的（原有行为）；
 * 2. **投影过、但用的是已经被取代的成员规则版本的**。
 *
 * 第二类就是计划 §10.4 的定向重判。把它做成按版本自愈而不是一次性脚本，
 * 是因为判定规则以后还会改：一次性脚本只能修这一次，版本条件能把
 * “旧规则算出来的判定还挂在当前视图里”这个类别的毛病永久关掉。
 *
 * 它不删任何东西：入库函数把旧判定置为非当前、写上 valid_to 与
 * supersedes_membership_id，旧 AI 批次原样留着；它也不覆盖人工判定
 * （入库函数对 decision_source='human' 直接跳过）；更不会重发通知
 * （通知读的是巡检观察表，不读这里的投影）。对应 §10.4 第 4、6、7、8 条。
 *
 * 条件看的是投影表（radar_core），不是成员表：采集库连接的角色没有
 * radar_analytics 的权限，跨 schema 查会在部署门禁上直接被 42501 挡下来。
 * 代价是：投影建了但被入库函数拒收时，这里会误以为已经迁完。
 * 所以重判必须带新时间戳（见 materializeProductIdentityForTask），
 * 把唯一一个会静默拒收的原因消掉。
 *
 * 每轮数量受 limit 约束，故意慢：快不是重点，
 * 每一批都能被观察到、出问题能及时停手才是。
 */
export async function backfillProductIdentityProjections(
  env: ProductIdentityEnv,
  limit = 30,
): Promise<{ scanned: number; materialized: number }> {
  const tasks = await env.DB.prepare(
    `SELECT task.id FROM product_search_workflow_tasks AS task
     LEFT JOIN gemini_jobs AS ai_job ON ai_job.id=task.ai_job_id
     WHERE task.status='completed' AND task.history_id IS NOT NULL
       AND task.plan_json::jsonb ->> 'mode'='exact_product'
       AND (
         NOT EXISTS (
           SELECT 1 FROM product_identity_projection_versions AS projection
           WHERE projection.workflow_task_id=task.id
             AND projection.projected_at >= COALESCE(ai_job.completed_at,task.completed_at,task.created_at)
         )
         OR NOT EXISTS (
           SELECT 1 FROM product_identity_projection_versions AS projection
           WHERE projection.workflow_task_id=task.id
             AND projection.membership_version=?
         )
       )
     ORDER BY task.created_at DESC LIMIT ?`,
  ).bind(PRODUCT_MEMBERSHIP_VERSION, Math.max(1, Math.min(Math.trunc(limit), 100))).all<{ id: string }>();
  let materialized = 0;
  for (const task of tasks.results) {
    if (await materializeProductIdentityForTask(env, task.id)) materialized += 1;
  }
  return { scanned: tasks.results.length, materialized };
}

/**
 * 定向重判（计划 §10.4）。
 *
 * 和 `backfillProductIdentityProjections` 的区别：那个只负责没投影过的任务，
 * 这个专门用来把**已经投影过**的任务按新规则再算一次。
 *
 * 它不删任何东西：旧判定由入库函数置为非当前并写上 supersedes，旧 AI 批次原样留着；
 * 也不触发任何通知：通知走的是巡检路径，不读这里的投影（§10.4 第 8 条）。
 */
export async function reprojectProductIdentities(
  env: ProductIdentityEnv,
  taskIds: readonly string[],
): Promise<{ requested: number; reprojected: number; skipped: string[] }> {
  const skipped: string[] = [];
  let reprojected = 0;
  for (const taskId of taskIds.slice(0, 20)) {
    const projection = await materializeProductIdentityForTask(env, taskId);
    if (projection) reprojected += 1;
    else skipped.push(taskId);
  }
  return { requested: taskIds.length, reprojected, skipped };
}

