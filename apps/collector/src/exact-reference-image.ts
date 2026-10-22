/**
 * 精确同款按参考图找货（docs/进行中/精确同款参考图-交接-20261009.md，调研和门槛出处见
 * docs/研究/精确同款按参考图找货-调研-20261009.md）。
 *
 * 文字判定（含 AI 复核）全部落定之后、这一轮的日报生成之前（index.ts 的 finalizeKeywordDigest），
 * 把漏斗筛剩的候选交给 Modal 上的 apps/image-dedup 和用户给的参考图比一比，再按用户 10-09 定的规则分流：
 *
 *   | 标题（文字判定） | 图片   | 怎么发                                   |
 *   | 对上（confirmed）| 对上   | 马上发（照旧进这一轮的日报）              |
 *   | 没对上（uncertain）| 对上 | 马上发：改判 confirmed，理由写"参考图"    |
 *   | 对上            | 没对上 | 攒到晚上统一发一封（北京时间 21:00）       |
 *   | 没对上          | 没对上 | 不发（仍是 uncertain，写清图片也不像）     |
 *
 * 「〇〇様専用」（给某位买家留的挂牌，别人买不了）直接排除，不送图片、不发。
 *
 * 什么时候整段不做、一切照旧只看文字（AGENTS.md §4 的判定在 exact-identity-decision.ts，这里不改它）：
 *   - 开关 runtime_feature_flags.exact_reference_image_v1 关着（默认关，关着时 $0）；
 *   - 档案没有参考图；
 *   - Modal 调不通、超时、额度用完——绝不能因为看图失败把候选卡住或不发信。
 *
 * 不新造状态：结果落到已有的 decision_status，分数落到 image_sim / image_inliers / image_verdict 列。
 */
import { evaluateListingEvents, sha256Hex } from "@jpgr/core";
import { RadarRepository, type OperationalPreparedStatement, type WatchBindingRow } from "@jpgr/db";
import { exactDiscoveryNotificationsEnabled, itemLookupSupportedFor } from "./gemini-jobs";
import type { RuntimeEnv as Env } from "./runtime-env";

type ScoringEnv = Env & { IMAGE_DEDUP_URL?: string; IMAGE_DEDUP_TOKEN?: string };

export const EXACT_REFERENCE_IMAGE_FLAG = "exact_reference_image_v1";

/**
 * 图片对上的门槛（10-09 在 7 个档案上实测定的起步值，交接 §3）。看"细节点"为主、"整体相似度"为辅：
 * - 细节点 ≥100：硬盒、画册、色纸、娃娃的真品都在 150 以上，最像的非真品 ≤69；
 * - 整体相似度 ≥0.90 且细节点 ≥30：接住毛绒（真品细节点只有 31～140，但整体 0.82～0.97，不相干的 ≤0.64）。
 * 衣服叠起来拍（59～62 点、0.71）会算没对上；标题对上的话它晚上照样发，不会丢。
 * 上线后用"已售同款"（来源状态 sold_out 且标题对上的，免费的真品样本）回测再调。
 */
export const IMAGE_MATCH_INLIERS = 100;
export const IMAGE_MATCH_SIM = 0.9;
export const IMAGE_MATCH_SIM_MIN_INLIERS = 30;
/** 一轮最多送几件。漏斗剩下的通常几件到十几件；钱由开机次数定，这个上限只防异常。 */
const MAX_CANDIDATES = 40;
/**
 * 等 Modal 的总时长。必须小于 PG 角色 jpgr_app 的 idle_in_transaction_session_timeout（3 分钟，
 * 见 docs/常用/行情邮件未送达-排查手册-20260922.md §三）。正常一次 30～60 秒（含冷启动）。
 * 超时就当这一轮没看图，只看文字。
 */
const SCORE_DEADLINE_MS = 150_000;
const POLL_INTERVAL_MS = 5_000;
/** 晚上那封在 UTC 13:00 = 北京时间 21:00 发（用户："白天要做别的事，挑个垃圾时间发"）。 */
export const EVENING_RELEASE_UTC_HOUR = 13;
/** 攒到晚上的事件在 payload_json 里带这个标记；早上的日报跳过它们，晚上那封只收它们。 */
export const IMAGE_HOLD_PAYLOAD_MARK = `"deliveryHold":"image_mismatch"`;

/** 「〇〇様専用」「〇〇さん専用」「専用出品」：给某位买家留的挂牌。「専用ケース」这种配件说明不算。 */
const RESERVED_FOR_BUYER = /(様|さま|さん|サマ)\s*(専用|せんよう)|専用\s*(出品|ページ)/u;

export function reservedForBuyer(title: string): boolean {
  return RESERVED_FOR_BUYER.test(title.normalize("NFKC"));
}

export interface ReferenceScore {
  sim: number;
  inliers: number;
}

/** 多张参考图时取最好的那张：先看能不能对上，再看细节点、整体相似度。 */
export function bestReferenceScore(refs: readonly ReferenceScore[]): (ReferenceScore & { match: boolean }) | null {
  const scored = refs.map((ref) => ({ ...ref, match: imageMatches(ref) }));
  scored.sort((a, b) => Number(b.match) - Number(a.match) || b.inliers - a.inliers || b.sim - a.sim);
  return scored[0] ?? null;
}

export function imageMatches(score: ReferenceScore): boolean {
  return score.inliers >= IMAGE_MATCH_INLIERS
    || (score.sim >= IMAGE_MATCH_SIM && score.inliers >= IMAGE_MATCH_SIM_MIN_INLIERS);
}

/** 下一个北京时间 21:00（UTC 13:00）。已经过了今天的就是明天的。 */
export function nextEveningRelease(now: Date): string {
  const release = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), EVENING_RELEASE_UTC_HOUR));
  if (release.getTime() <= now.getTime()) release.setUTCDate(release.getUTCDate() + 1);
  return release.toISOString();
}

function scoreText(score: ReferenceScore): string {
  return `整体相似度 ${score.sim.toFixed(2)}、${score.inliers} 个细节点对上`;
}

interface FunnelRow {
  watch_run_id: string;
  watch_binding_id: string;
  source_id: string;
  source_item_id: string;
  canonical_url: string;
  title: string;
  image_url: string | null;
  decision_status: "confirmed" | "uncertain";
  decision_reason: string | null;
  listing_id: string;
  current_price: number | null;
  availability: string;
  state_hash: string | null;
  matched: number;
}

interface PendingDiscovery {
  id: string;
  watch_binding_id: string;
  listing_id: string;
  payload_json: string;
  delivery_not_before: string | null;
}

async function scoreWithModal(
  env: ScoringEnv,
  references: readonly string[],
  candidates: readonly { url: string; imageUrl: string }[],
): Promise<Map<string, ReferenceScore[]>> {
  const deadline = Date.now() + SCORE_DEADLINE_MS;
  const headers = { Authorization: `Bearer ${env.IMAGE_DEDUP_TOKEN}`, "Content-Type": "application/json" };
  const start = await fetch(new URL("score", env.IMAGE_DEDUP_URL), {
    method: "POST",
    headers,
    body: JSON.stringify({ references, candidates }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!start.ok) throw new Error(`score_start_http_${start.status}: ${(await start.text()).slice(0, 200)}`);
  const { callId } = await start.json() as { callId?: string };
  if (!callId) throw new Error("score_start_without_call_id");
  while (Date.now() + POLL_INTERVAL_MS < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetch(new URL(`score/${encodeURIComponent(callId)}`, env.IMAGE_DEDUP_URL), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    // 还在算（202），或接口本身一时出错（部署中、限流）：下一次再问
    if (response.status === 202 || !response.ok) {
      await response.body?.cancel();
      continue;
    }
    const body = await response.json() as {
      status: string;
      error?: string;
      results?: { url: string; refs?: ReferenceScore[] }[];
      stats?: unknown;
    };
    if (body.status !== "done" || !body.results) throw new Error(body.error ?? `score_${body.status}`);
    console.log(JSON.stringify({ event: "exact_reference_image_modal_done", callId, stats: body.stats }));
    return new Map(body.results.map((row) => [row.url, (row.refs ?? []).filter((ref) =>
      Number.isFinite(ref.sim) && Number.isFinite(ref.inliers))]));
  }
  throw new Error(`score_timeout:${callId}`);
}

/**
 * 在这一轮的日报生成之前调用。任何一步失败都只是"这一轮没看图"：调用方接住异常、照常出日报。
 */
export async function applyExactReferenceImages(
  env: Env,
  input: { profileId: string; bindingIds: readonly string[]; scanStartedAt: string },
): Promise<void> {
  if (input.bindingIds.length === 0) return;
  const scoringEnv = env as ScoringEnv;
  const [profile, flag] = await Promise.all([
    env.DB.prepare("SELECT dossier_kind FROM watch_profiles WHERE id=?")
      .bind(input.profileId).first<{ dossier_kind: string }>(),
    env.DB.prepare("SELECT enabled FROM runtime_feature_flags WHERE flag_key=?")
      .bind(EXACT_REFERENCE_IMAGE_FLAG).first<{ enabled: number }>(),
  ]);
  if (profile?.dossier_kind !== "exact_product" || Number(flag?.enabled ?? 0) !== 1) return;
  if (!scoringEnv.IMAGE_DEDUP_URL || !scoringEnv.IMAGE_DEDUP_TOKEN) {
    console.warn(JSON.stringify({ event: "exact_reference_image_not_configured", profileId: input.profileId }));
    return;
  }
  const references = (await env.DB.prepare(
    "SELECT ordinal,image_base64 FROM watch_profile_reference_images WHERE watch_profile_id=? ORDER BY ordinal",
  ).bind(input.profileId).all<{ ordinal: number; image_base64: string }>()).results;
  if (references.length === 0) return;
  // 换了参考图就重新打分：旧分数是拿旧图算的，不能复用。
  const referenceKey = (await sha256Hex(references.map((ref) => ref.image_base64).join("|"))).slice(0, 16);

  const placeholders = input.bindingIds.map(() => "?").join(",");
  const [observations, discoveries, cachedScores] = await Promise.all([
    // 漏斗筛剩的：文字判定为确认同款或拿不准、当前可买。被判"无关"的（rejected）不进图片模型。
    env.DB.prepare(
      `SELECT o.watch_run_id,o.watch_binding_id,o.source_id,o.source_item_id,o.canonical_url,o.title,o.image_url,
       o.decision_status,o.decision_reason,l.id listing_id,l.current_price,l.availability,l.state_hash,
       CASE WHEN EXISTS (SELECT 1 FROM watch_listing_matches m
         WHERE m.watch_binding_id=o.watch_binding_id AND m.listing_id=l.id) THEN 1 ELSE 0 END matched
       FROM watch_run_listing_observations o
       JOIN listings l ON l.source_id=o.source_id AND l.source_item_id=o.source_item_id
       WHERE o.watch_binding_id IN (${placeholders}) AND o.observed_at>=?
         AND o.decision_status IN ('confirmed','uncertain') AND o.is_purchasable=1
       ORDER BY o.observed_at DESC LIMIT 500`,
    ).bind(...input.bindingIds, input.scanStartedAt).all<FunnelRow>(),
    // 这一轮新建、还没发出去的"确认同款上新"事件
    env.DB.prepare(
      `SELECT id,watch_binding_id,listing_id,payload_json,delivery_not_before FROM events
       WHERE watch_binding_id IN (${placeholders}) AND event_type='new_listing'
         AND status IN ('pending','failed') AND created_at>=?`,
    ).bind(...input.bindingIds, input.scanStartedAt).all<PendingDiscovery>(),
    // 同一件、同一张图、同一组参考图以前打过分的，直接复用，不再开机
    env.DB.prepare(
      `SELECT watch_binding_id,source_id,source_item_id,image_url,image_sim,image_inliers
       FROM watch_run_listing_observations
       WHERE watch_binding_id IN (${placeholders}) AND image_reference_key=? AND image_inliers IS NOT NULL`,
    ).bind(...input.bindingIds, referenceKey).all<{
      watch_binding_id: string;
      source_id: string;
      source_item_id: string;
      image_url: string | null;
      image_sim: number;
      image_inliers: number;
    }>(),
  ]);

  const eventByListing = new Map(discoveries.results.map((event) => [`${event.watch_binding_id}:${event.listing_id}`, event]));
  const cache = new Map(cachedScores.results.map((row) => [
    `${row.watch_binding_id}:${row.source_id}:${row.source_item_id}:${row.image_url ?? ""}`,
    { sim: Number(row.image_sim), inliers: Number(row.image_inliers) },
  ]));
  const seen = new Set<string>();
  const reserved: Array<{ row: FunnelRow; event?: PendingDiscovery }> = [];
  const funnel: Array<{ row: FunnelRow; event?: PendingDiscovery }> = [];
  for (const row of observations.results) {
    const key = `${row.watch_binding_id}:${row.source_id}:${row.source_item_id}`;
    if (seen.has(key)) continue; // 同一轮重跑过的，只看最新那次
    seen.add(key);
    const event = eventByListing.get(`${row.watch_binding_id}:${row.listing_id}`);
    // 确认同款但这一轮没有新事件 = 以前已经发过；拿不准但已经登记过匹配 = 以前看图改判过。都没有可分流的。
    if (row.decision_status === "confirmed" && !event) continue;
    if (row.decision_status === "uncertain" && Number(row.matched) === 1) continue;
    if (reservedForBuyer(row.title)) {
      reserved.push({ row, ...(event ? { event } : {}) });
      continue;
    }
    if (!row.image_url) continue; // 没图就只看文字
    funnel.push({ row, ...(event ? { event } : {}) });
  }
  // 标题已经对上、等着发的排前面：上限截断时先保住它们的分流
  funnel.sort((a, b) => Number(Boolean(b.event)) - Number(Boolean(a.event)));
  const candidates = funnel.slice(0, MAX_CANDIDATES);

  const now = new Date().toISOString();
  const statements: OperationalPreparedStatement[] = [];
  for (const { row, event } of reserved) {
    statements.push(env.DB.prepare(
      `UPDATE watch_run_listing_observations SET decision_status='rejected',decision_reason=?,updated_at=?
       WHERE watch_run_id=? AND source_id=? AND source_item_id=?`,
    ).bind(
      `标题写着「…専用」：卖家给某位买家留的挂牌，别人买不了，不发${row.decision_reason ? `（文字判定原为：${row.decision_reason}）` : ""}`.slice(0, 500),
      now, row.watch_run_id, row.source_id, row.source_item_id,
    ));
    if (event) {
      statements.push(env.DB.prepare(
        "UPDATE events SET status='suppressed' WHERE id=? AND status IN ('pending','failed')",
      ).bind(event.id));
    }
  }

  const scores = new Map<string, ReferenceScore>();
  const toScore: typeof candidates = [];
  for (const candidate of candidates) {
    const { row } = candidate;
    const cached = cache.get(`${row.watch_binding_id}:${row.source_id}:${row.source_item_id}:${row.image_url ?? ""}`);
    if (cached) scores.set(row.canonical_url, cached);
    else toScore.push(candidate);
  }
  let modalError: string | undefined;
  if (toScore.length > 0) {
    try {
      const results = await scoreWithModal(
        scoringEnv,
        references.map((ref) => ref.image_base64),
        // 同一个链接只送一次（一件商品被两个来源召回时链接相同）
        [...new Map(toScore.map(({ row }) => [row.canonical_url, { url: row.canonical_url, imageUrl: row.image_url! }])).values()],
      );
      for (const [url, refs] of results) {
        const best = bestReferenceScore(refs);
        if (best) scores.set(url, { sim: best.sim, inliers: best.inliers });
      }
    } catch (error) {
      // 看图失败 = 这一轮按开关关着处理：没分数的候选不动，文字判定照常发信
      modalError = error instanceof Error ? error.message.slice(0, 300) : "unknown";
      console.error(JSON.stringify({ event: "exact_reference_image_failed", profileId: input.profileId, error: modalError }));
    }
  }

  const release = nextEveningRelease(new Date());
  const promotions: Array<{ row: FunnelRow; score: ReferenceScore }> = [];
  let held = 0;
  let matchedConfirmed = 0;
  let mismatchedUncertain = 0;
  for (const { row, event } of candidates) {
    const score = scores.get(row.canonical_url);
    if (!score) continue;
    const match = imageMatches(score);
    let decisionStatus: string | null = null;
    let decisionReason: string | null = null;
    if (row.decision_status === "confirmed" && event) {
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      if (match) {
        matchedConfirmed += 1;
        decisionReason = `商品图与参考图一致（${scoreText(score)}）；${row.decision_reason ?? ""}`;
        payload.imageNote = `商品图与参考图一致（${score.inliers} 个细节点对上）`;
        statements.push(env.DB.prepare("UPDATE events SET payload_json=? WHERE id=? AND status IN ('pending','failed')")
          .bind(JSON.stringify(payload), event.id));
      } else {
        // 标题对上、图片没对上：可能是 AI 被相近的标题骗了（09-05 / 09-13 的 Fes. Fine），
        // 也可能只是官图和实拍的差别。不能否掉标题命中，但也不值得白天打扰——攒到晚上一封。
        held += 1;
        decisionReason = `标题判为同款，但商品图和参考图明显不同（${scoreText(score)}），攒到晚上统一发；${row.decision_reason ?? ""}`;
        payload.deliveryHold = "image_mismatch";
        payload.imageNote = `标题判为同款，但商品图和参考图明显不同（${scoreText(score)}）。可能是另一个版本，也可能只是官图和实拍的差别，下单前先看一眼图`;
        const notBefore = event.delivery_not_before && event.delivery_not_before > release ? event.delivery_not_before : release;
        statements.push(env.DB.prepare(
          "UPDATE events SET payload_json=?,delivery_not_before=? WHERE id=? AND status IN ('pending','failed')",
        ).bind(JSON.stringify(payload), notBefore, event.id));
      }
    } else if (row.decision_status === "uncertain") {
      if (match) {
        promotions.push({ row, score });
        decisionStatus = "confirmed";
        decisionReason = `商品图与参考图一致（${scoreText(score)}），标题没能确认：${row.decision_reason ?? "证据不足"}`;
      } else {
        mismatchedUncertain += 1;
        decisionReason = `商品图和参考图也不同（${scoreText(score)}）；${row.decision_reason ?? ""}`;
      }
    }
    statements.push(env.DB.prepare(
      `UPDATE watch_run_listing_observations
       SET image_sim=?::real,image_inliers=?::integer,image_verdict=?::text,image_reference_key=?::text,
           decision_status=COALESCE(?::text,decision_status),decision_reason=COALESCE(?::text,decision_reason),updated_at=?
       WHERE watch_run_id=? AND source_id=? AND source_item_id=?`,
    ).bind(
      score.sim, score.inliers, match ? "match" : "mismatch", referenceKey,
      decisionStatus, decisionReason?.replace(/；$/u, "").slice(0, 500) ?? null, now,
      row.watch_run_id, row.source_id, row.source_item_id,
    ));
  }
  if (statements.length > 0) await env.DB.batch(statements);

  // 标题没对上、图片对上：登记成确认同款，建一条上新事件，跟这一轮的日报一起马上发。
  let promoted = 0;
  if (promotions.length > 0) {
    const repository = new RadarRepository(env.DB);
    const bindings = new Map<string, WatchBindingRow | null>();
    const notify = new Map<string, boolean>();
    for (const { row, score } of promotions) {
      if (!bindings.has(row.watch_binding_id)) bindings.set(row.watch_binding_id, await repository.getBinding(row.watch_binding_id));
      const binding = bindings.get(row.watch_binding_id);
      if (!binding) continue;
      const accepted = await repository.acceptListingMatch({
        bindingId: binding.id,
        listingId: row.listing_id,
        acceptanceReason: "image_reference",
      });
      if (!accepted.isNewMatch) continue;
      if (binding.profile_offer_tracking_policy === "all_confirmed_offers") {
        await repository.activateExactProductListingTracking(
          binding,
          row.listing_id,
          itemLookupSupportedFor(binding.source_id, row.source_item_id),
        );
      }
      if (!notify.has(binding.id)) notify.set(binding.id, await exactDiscoveryNotificationsEnabled(env, binding));
      const events = evaluateListingEvents({
        bindingId: binding.id,
        listingId: row.listing_id,
        current: {
          ...(row.current_price === null ? {} : { price: Number(row.current_price) }),
          availability: row.availability as Parameters<typeof evaluateListingEvents>[0]["current"]["availability"],
          ...(row.state_hash ? { stateHash: row.state_hash } : {}),
        },
        isNewMatch: true,
        baselineCompleted: true,
        notifyInitial: true,
        notifyNewListing: notify.get(binding.id) ?? false,
        notifyPriceDrop: false,
        notifyRestock: false,
        notifySoldOut: false,
        minDropAmount: binding.min_drop_amount,
        observedAt: input.scanStartedAt,
      }).filter((event) => event.type === "new_listing")
        .map((event) => ({
          ...event,
          payload: { ...event.payload, imageNote: `标题没能确认是同款，但商品图和参考图一致（${score.inliers} 个细节点对上）` },
        }));
      if (events.length > 0) {
        await repository.insertEventBatch(binding, [{ listingId: row.listing_id, events }]);
        promoted += 1;
      }
    }
  }

  console.log(JSON.stringify({
    event: "exact_reference_image_applied",
    profileId: input.profileId,
    references: references.length,
    funnel: funnel.length,
    candidates: candidates.length,
    sentToModal: toScore.length,
    scored: scores.size,
    reserved: reserved.length,
    matchedConfirmed,
    held,
    promoted,
    mismatchedUncertain,
    ...(modalError ? { modalError } : {}),
  }));
}

/**
 * 晚上那封：到点（delivery_not_before 已过）的"标题对上、图片没对上"按档案各合成一封。
 * 每小时整点检查一次，所以错过 13:00 那一跳（部署、故障）下一个整点会补上。
 * 开关关掉以后已经攒下的照样会发——攒着不发就等于丢了。
 */
export async function releaseHeldExactImageDigests(env: Env): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT DISTINCT watch_profile_id FROM events
     WHERE status IN ('pending','failed') AND event_type='new_listing'
       AND delivery_not_before IS NOT NULL AND delivery_not_before<=?
       AND payload_json LIKE ?`,
  ).bind(new Date().toISOString(), `%${IMAGE_HOLD_PAYLOAD_MARK}%`).all<{ watch_profile_id: string | null }>();
  const repository = new RadarRepository(env.DB);
  let prepared = 0;
  for (const row of due.results) {
    if (!row.watch_profile_id) continue;
    const digestId = await repository.prepareExactImageHoldDigest({
      profileId: row.watch_profile_id,
      releasedAt: new Date().toISOString(),
      holdMark: IMAGE_HOLD_PAYLOAD_MARK,
    });
    if (digestId) prepared += 1;
  }
  if (prepared > 0) console.log(JSON.stringify({ event: "exact_image_hold_digests_prepared", count: prepared }));
  return prepared;
}
