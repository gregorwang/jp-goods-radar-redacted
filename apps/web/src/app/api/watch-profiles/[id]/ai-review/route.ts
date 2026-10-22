import {
  KEYWORD_RULE_FALLBACK_REASON,
  keywordRuleTermAlternatives,
  keywordRuleText,
  keywordRuleTextMatches,
  keywordSeriesSignalHits,
  keywordSeriesSignals,
  suggestKeywordExclusionTerms,
  type KeywordAiRelevance,
  type KeywordAiReviewItem,
  type KeywordSeriesSignal,
} from "@jpgr/core";
import { keywordAiReviewSchema } from "@jpgr/validation";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };

const REVIEW_WINDOW_DAYS = 30;
const QUEUE_LIMIT = 100;
const RECENT_REVIEWS_LIMIT = 30;

interface ProfileRow {
  id: string;
  name: string;
  dossier_kind: string;
  include_terms_json: string;
  exclude_terms_json: string;
}

interface ObservationRow {
  watch_binding_id: string;
  source_id: string;
  source_name: string | null;
  source_item_id: string;
  title: string;
  canonical_url: string;
  image_url: string | null;
  current_price: number | null;
  is_purchasable: number;
  observed_at: string;
  decision_reason: string | null;
  /** 为空：AI 没判出来、按关键词规则放行的那批（decision_reason 是 KEYWORD_RULE_FALLBACK_REASON）。 */
  ai_relevance: KeywordAiRelevance | null;
  description_excerpt: string | null;
  shop_name: string | null;
  seller_name: string | null;
}

interface ConfirmedRow {
  watch_profile_id: string;
  title: string;
  description_excerpt: string | null;
  shop_name: string | null;
  seller_name: string | null;
}

interface ReviewRow {
  watch_binding_id: string;
  source_id: string;
  source_item_id: string;
  verdict: "ai_correct" | "ai_wrong";
  created_at: string;
}

function stringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function itemKey(bindingId: string, sourceId: string, sourceItemId: string): string {
  return `${bindingId}\u0000${sourceId}\u0000${sourceItemId}`;
}

/** 和 filterListings 拼 searchable 的顺序一致：标题、描述、店名、卖家名。 */
function ruleText(row: { title: string; description_excerpt: string | null; shop_name: string | null; seller_name: string | null }) {
  return `${row.title} ${row.description_excerpt ?? ""} ${row.shop_name ?? ""} ${row.seller_name ?? ""}`;
}

type QueueFlag = { kind: "ai_uncertain" | "series_signal" | "rule_fallback"; terms: KeywordSeriesSignal[] };
type QueueEntry = ReturnType<typeof listingView> & { flag: QueueFlag };

function listingView(row: ObservationRow) {
  return {
    bindingId: row.watch_binding_id,
    sourceId: row.source_id,
    sourceName: row.source_name ?? row.source_id,
    sourceItemId: row.source_item_id,
    title: row.title,
    url: row.canonical_url,
    imageUrl: row.image_url,
    price: row.current_price === null ? null : Number(row.current_price),
    purchasable: Number(row.is_purchasable) === 1,
    observedAt: row.observed_at,
    aiRelevance: row.ai_relevance,
    aiReason: row.decision_reason,
  };
}

async function keywordProfile(id: string): Promise<ProfileRow | Response> {
  const profile = await getEnv().DB.prepare(
    "SELECT id,name,dossier_kind,include_terms_json,exclude_terms_json FROM watch_profiles WHERE id=?",
  ).bind(id).first<ProfileRow>();
  if (!profile) return apiError("watch_profile_not_found", 404);
  // 精确同款雷达有自己的「疑似同款」分区和送达门槛，这页只管关键词档案。
  if (profile.dossier_kind !== "keyword") return apiError("ai_review_requires_keyword_dossier", 409);
  return profile;
}

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const profile = await keywordProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const env = getEnv();
  const since = new Date(Date.now() - REVIEW_WINDOW_DAYS * 86_400_000).toISOString();

  const [observationResult, confirmedResult, reviewResult] = await Promise.all([
    // 每件商品只看最近一次 AI 表态：AI 先拒、后来又放行的，以放行为准。
    // ai_relevance 为空的是模型没给出有效输出，不是 AI 的结论，不进统计和补词；
    // 其中按关键词规则放行、已经进了日报的那批（理由是 KEYWORD_RULE_FALLBACK_REASON）
    // 单独进复核队列——它们没人筛过，最需要人看一眼。
    env.DB.prepare(
      `SELECT DISTINCT ON (o.watch_binding_id,o.source_id,o.source_item_id)
       o.watch_binding_id,o.source_id,s.display_name source_name,o.source_item_id,o.title,o.canonical_url,
       o.image_url,o.current_price,o.is_purchasable,o.observed_at,o.decision_reason,o.ai_relevance,
       LEFT(COALESCE(l.description_excerpt,''),300) description_excerpt,l.shop_name,l.seller_name
       FROM watch_run_listing_observations o
       JOIN watch_bindings b ON b.id=o.watch_binding_id
       LEFT JOIN source_registry s ON s.id=o.source_id
       LEFT JOIN listings l ON l.source_id=o.source_id AND l.source_item_id=o.source_item_id
       WHERE b.watch_profile_id=? AND b.kind='keyword' AND o.observed_at>=?
         AND (o.ai_relevance IS NOT NULL OR o.decision_reason=?)
       ORDER BY o.watch_binding_id,o.source_id,o.source_item_id,o.observed_at DESC`,
    ).bind(profile.id, since, KEYWORD_RULE_FALLBACK_REASON).all<ObservationRow>(),
    // 全部档案的已确认商品：本档案的用来查"加了这个词会不会误伤真品"，
    // 其他档案的用来认出"送料無料"这种哪儿都有的通用词。
    // 不读 watch_listing_matches：七月份规则还松的时候，爱蜜莉雅档案把 Michael Kors 的
    // Emilia 包、エミリアン 的衣服都收成了匹配，拿它当"真品"会把最该加的排除词全部判成误伤。
    // 这里只认 AI 最近一次判为相关的商品，加上用户在复核页改判为相关的。
    env.DB.prepare(
      `SELECT x.watch_profile_id,x.title,LEFT(COALESCE(l.description_excerpt,''),300) description_excerpt,
       l.shop_name,l.seller_name
       FROM (
         SELECT DISTINCT ON (o.watch_binding_id,o.source_id,o.source_item_id)
         b.watch_profile_id,o.source_id,o.source_item_id,o.title,o.ai_relevance
         FROM watch_run_listing_observations o JOIN watch_bindings b ON b.id=o.watch_binding_id
         WHERE o.ai_relevance IS NOT NULL
         ORDER BY o.watch_binding_id,o.source_id,o.source_item_id,o.observed_at DESC
       ) x
       LEFT JOIN listings l ON l.source_id=x.source_id AND l.source_item_id=x.source_item_id
       WHERE x.ai_relevance='relevant'
       UNION ALL
       SELECT b.watch_profile_id,l.title,LEFT(COALESCE(l.description_excerpt,''),300) description_excerpt,
       l.shop_name,l.seller_name
       FROM keyword_ai_reviews r JOIN watch_bindings b ON b.id=r.watch_binding_id
       JOIN listings l ON l.source_id=r.source_id AND l.source_item_id=r.source_item_id
       WHERE r.verdict='ai_wrong'`,
    ).all<ConfirmedRow>(),
    env.DB.prepare(
      `SELECT r.watch_binding_id,r.source_id,r.source_item_id,r.verdict,r.created_at
       FROM keyword_ai_reviews r JOIN watch_bindings b ON b.id=r.watch_binding_id
       WHERE b.watch_profile_id=? ORDER BY r.created_at DESC`,
    ).bind(profile.id).all<ReviewRow>(),
  ]);

  // 用户现在的排除词比 AI 过去的结论新。爱蜜莉雅档案 09-28 才把卡牌加进排除词，
  // 在那之前 AI 放行过一百多张卡；把这些旧结论当成"真品"，复核页就会以为卡牌是用户要的，
  // 反过来把 AI 按新规则正确拒掉的卡牌当"疑似误杀"推给人看。所以凡是命中当前排除词的，
  // 一律按当前规则算，不参与统计、信号、补词和复核队列。
  const excludeAlternatives = keywordRuleTermAlternatives(stringArray(profile.exclude_terms_json), true);
  const excludedNow = (row: Parameters<typeof ruleText>[0]) => {
    const text = keywordRuleText(ruleText(row));
    return excludeAlternatives.some((term) => keywordRuleTextMatches(text, term));
  };
  const observations = observationResult.results.filter((row) => !excludedNow(row));
  const aiJudged = observations.filter((row): row is ObservationRow & { ai_relevance: KeywordAiRelevance } => (
    row.ai_relevance !== null
  ));
  const byKey = new Map(observations.map((row) => [
    itemKey(row.watch_binding_id, row.source_id, row.source_item_id),
    row,
  ]));
  const judged: KeywordAiReviewItem[] = aiJudged.map((row) => ({
    key: itemKey(row.watch_binding_id, row.source_id, row.source_item_id),
    title: row.title,
    text: ruleText(row),
    aiRelevance: row.ai_relevance,
  }));
  const ownConfirmed = confirmedResult.results
    .filter((row) => row.watch_profile_id === profile.id && !excludedNow(row));
  const otherConfirmed = confirmedResult.results.filter((row) => row.watch_profile_id !== profile.id);
  const reviews = reviewResult.results;
  const reviewed = new Set(reviews.map((row) => itemKey(row.watch_binding_id, row.source_id, row.source_item_id)));

  const signals = keywordSeriesSignals({
    includeTerms: stringArray(profile.include_terms_json),
    judged,
    otherProfileTitles: otherConfirmed.map((row) => row.title),
  });
  const queue = observations
    .filter((row) => row.ai_relevance !== "relevant")
    .filter((row) => !reviewed.has(itemKey(row.watch_binding_id, row.source_id, row.source_item_id)))
    .flatMap((row): QueueEntry[] => {
      if (row.ai_relevance === null) return [{ ...listingView(row), flag: { kind: "rule_fallback", terms: [] } }];
      if (row.ai_relevance === "uncertain") return [{ ...listingView(row), flag: { kind: "ai_uncertain", terms: [] } }];
      const hits = keywordSeriesSignalHits(row.title, signals);
      return hits.length ? [{ ...listingView(row), flag: { kind: "series_signal", terms: hits.slice(0, 2) } }] : [];
    })
    .sort((left, right) => Number(right.purchasable) - Number(left.purchasable)
      || right.observedAt.localeCompare(left.observedAt))
    .slice(0, QUEUE_LIMIT);

  const suggestions = suggestKeywordExclusionTerms({
    excludeTerms: stringArray(profile.exclude_terms_json),
    judged,
    confirmedTexts: ownConfirmed.map(ruleText),
    otherProfileTexts: otherConfirmed.map(ruleText),
  }).map((suggestion) => ({
    term: suggestion.term,
    blockedCount: suggestion.blockedCount,
    examples: suggestion.exampleKeys.flatMap((key) => {
      const row = byKey.get(key);
      return row ? [{ title: row.title, url: row.canonical_url, aiReason: row.decision_reason }] : [];
    }),
  }));

  return Response.json({
    profile: { id: profile.id, name: profile.name, excludeTerms: stringArray(profile.exclude_terms_json) },
    windowDays: REVIEW_WINDOW_DAYS,
    stats: {
      aiRelevant: aiJudged.filter((row) => row.ai_relevance === "relevant").length,
      aiIrrelevant: aiJudged.filter((row) => row.ai_relevance === "irrelevant").length,
      aiUncertain: aiJudged.filter((row) => row.ai_relevance === "uncertain").length,
      ruleFallback: observations.filter((row) => row.ai_relevance === null).length,
      reviewed: reviews.length,
      aiWrong: reviews.filter((row) => row.verdict === "ai_wrong").length,
    },
    queue,
    recentReviews: reviews.slice(0, RECENT_REVIEWS_LIMIT).map((row) => {
      const observation = byKey.get(itemKey(row.watch_binding_id, row.source_id, row.source_item_id));
      return {
        bindingId: row.watch_binding_id,
        sourceId: row.source_id,
        sourceItemId: row.source_item_id,
        verdict: row.verdict,
        reviewedAt: row.created_at,
        title: observation?.title ?? row.source_item_id,
        url: observation?.canonical_url ?? null,
      };
    }),
    suggestions,
  });
}

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = keywordAiReviewSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const profile = await keywordProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const { bindingId, sourceId, sourceItemId, verdict } = parsed.data;
  const env = getEnv();

  const [binding, existing, listing, latest, latestAny] = await Promise.all([
    env.DB.prepare("SELECT id,source_id,kind FROM watch_bindings WHERE id=? AND watch_profile_id=?")
      .bind(bindingId, profile.id).first<{ id: string; source_id: string; kind: string }>(),
    env.DB.prepare(
      `SELECT verdict,match_created FROM keyword_ai_reviews
       WHERE watch_binding_id=? AND source_id=? AND source_item_id=?`,
    ).bind(bindingId, sourceId, sourceItemId).first<{ verdict: string; match_created: boolean }>(),
    env.DB.prepare("SELECT id FROM listings WHERE source_id=? AND source_item_id=?")
      .bind(sourceId, sourceItemId).first<{ id: string }>(),
    env.DB.prepare(
      `SELECT ai_relevance FROM watch_run_listing_observations
       WHERE watch_binding_id=? AND source_id=? AND source_item_id=? AND ai_relevance IS NOT NULL
       ORDER BY observed_at DESC LIMIT 1`,
    ).bind(bindingId, sourceId, sourceItemId).first<{ ai_relevance: string }>(),
    env.DB.prepare(
      `SELECT ai_relevance,decision_reason FROM watch_run_listing_observations
       WHERE watch_binding_id=? AND source_id=? AND source_item_id=?
       ORDER BY observed_at DESC LIMIT 1`,
    ).bind(bindingId, sourceId, sourceItemId).first<{ ai_relevance: string | null; decision_reason: string | null }>(),
  ]);
  if (!binding || binding.kind !== "keyword") return apiError("watch_binding_not_found", 404);
  if (binding.source_id !== sourceId) return apiError("source_does_not_belong_to_binding", 409);

  // 只撤掉复核页自己建的匹配；AI 本来就确认过的那一行不归这里管。
  const dropCreatedMatch = existing?.match_created && verdict !== "ai_wrong" && listing
    ? env.DB.prepare("DELETE FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?")
      .bind(bindingId, listing.id)
    : null;

  // 按关键词规则放行的商品，匹配是采集侧建的（AI 没判出来）。判「确实不是」就撤掉它，
  // 以后降价、售罄不再提醒，采集侧也不会再按规则放行它；撤销时原样恢复，且不再补发上新。
  const ruleFallback = latestAny?.ai_relevance === null && latestAny.decision_reason === KEYWORD_RULE_FALLBACK_REASON;
  const now = new Date().toISOString();
  const dropFallbackMatch = ruleFallback && verdict === "ai_correct" && listing
    ? env.DB.prepare("DELETE FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?")
      .bind(bindingId, listing.id)
    : null;
  const restoreFallbackMatch = ruleFallback && verdict === "undo" && existing?.verdict === "ai_correct" && listing
    ? env.DB.prepare(
      `INSERT INTO watch_listing_matches (
        watch_binding_id,listing_id,first_seen_at,last_seen_at,new_listing_notified_at,acceptance_reason,accepted_at
      ) VALUES (?,?,?,?,?,'keyword_relevant',?)
      ON CONFLICT (watch_binding_id,listing_id) DO NOTHING`,
    ).bind(bindingId, listing.id, now, now, now, now)
    : null;

  if (verdict === "undo") {
    await env.DB.batch([
      ...(dropCreatedMatch ? [dropCreatedMatch] : []),
      ...(restoreFallbackMatch ? [restoreFallbackMatch] : []),
      env.DB.prepare(
        "DELETE FROM keyword_ai_reviews WHERE watch_binding_id=? AND source_id=? AND source_item_id=?",
      ).bind(bindingId, sourceId, sourceItemId),
    ]);
    return Response.json({ updated: true });
  }

  let matchCreated = false;
  if (verdict === "ai_wrong") {
    if (existing?.match_created) {
      matchCreated = true;
    } else if (listing) {
      // 用户就是在复核页上看到它的，不需要再发一次上新通知：直接记成已通知。
      // 之后降价、售罄、补货按已确认商品照常提醒——采集侧读 keyword_ai_reviews，
      // 不再采信 AI 对这条商品的否定。
      const inserted = await env.DB.prepare(
        `INSERT INTO watch_listing_matches (
          watch_binding_id,listing_id,first_seen_at,last_seen_at,new_listing_notified_at,acceptance_reason,accepted_at
        ) VALUES (?,?,?,?,?,'keyword_relevant',?)
        ON CONFLICT (watch_binding_id,listing_id) DO NOTHING`,
      ).bind(bindingId, listing.id, now, now, now, now).run();
      matchCreated = inserted.meta.changes > 0;
    }
  }
  await env.DB.batch([
    ...(dropCreatedMatch ? [dropCreatedMatch] : []),
    ...(dropFallbackMatch ? [dropFallbackMatch] : []),
    env.DB.prepare(
      `INSERT INTO keyword_ai_reviews(watch_binding_id,source_id,source_item_id,verdict,ai_relevance,match_created,created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT (watch_binding_id,source_id,source_item_id)
       DO UPDATE SET verdict=excluded.verdict,ai_relevance=excluded.ai_relevance,
         match_created=excluded.match_created,created_at=excluded.created_at`,
    ).bind(bindingId, sourceId, sourceItemId, verdict, latest?.ai_relevance ?? null, matchCreated, now),
  ]);
  return Response.json({ updated: true, matchCreated });
}
