import "server-only";
import { apiError } from "./api-mutation";
import { getEnv } from "./cloudflare";
import type { DigestVerdict } from "./digest-labels";

/**
 * 收件箱的两份清单，主站「收件箱」页（/api/inbox）和手机 App（/api/device/labels、/api/device/excluded）共用：
 * - 推给我的：最近 DIGEST_WINDOW_DAYS 天关键词日报里逐件出现过的商品，同一件只出一次（取最新那封），带「不想看」结论。
 *   日报送达（sent）和两个推送开关都关、只巡回不通知（suppressed）的都算——后者用户只在收件箱里看（2026-10-16）。
 * - 排除词挡掉的：被排除词挡掉、没进日报的商品，带「挡错了」反馈。
 */
export const DIGEST_WINDOW_DAYS = 3;
export const EXCLUDED_WINDOW_DAYS = 7;

export interface DigestFeedItem {
  profileId: string;
  digestEventId: string;
  digestAt: string;
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
  listedAt: string | null;
  verdict: DigestVerdict | null;
}

export interface ExcludedFeedItem {
  profileId: string;
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
  listedAt: string;
  term: string;
  inTitle: boolean;
  wanted: boolean;
}

interface DigestRow {
  digest_event_id: string;
  digest_at: string;
  profile_id: string;
  source_id: string;
  source_name: string | null;
  source_item_id: string;
  title: string | null;
  url: string | null;
  image_url: string | null;
  price: string | number | null;
  auction: boolean | number | string | null;
  listed_at: string | null;
  verdict: DigestVerdict | null;
}

interface ExcludedRow {
  profile_id: string;
  source_id: string;
  source_name: string | null;
  source_item_id: string;
  title: string;
  url: string;
  image_url: string | null;
  price: number | string | null;
  price_basis: string;
  listed_at: string | null;
  first_seen_at: string;
  reason: string;
  verdict: DigestVerdict | null;
}

function yen(value: string | number | null): number | null {
  const price = value === null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(price) ? Math.round(price) : null;
}

export async function recentDigestItems(profileIds: readonly string[], maxRows: number): Promise<DigestFeedItem[]> {
  if (profileIds.length === 0) return [];
  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await getEnv().DB.prepare(
    `SELECT e.id digest_event_id,e.created_at digest_at,e.watch_profile_id profile_id,
     it->>'sourceId' source_id,s.display_name source_name,it->>'sourceItemId' source_item_id,
     it->>'title' title,it->>'url' url,it->>'imageUrl' image_url,it->>'price' price,
     (it->'auction' IS NOT NULL AND it->'auction'<>'null'::jsonb AND it->'auction'<>'false'::jsonb) auction,
     it->>'listedAt' listed_at,
     d.verdict
     FROM events e
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(e.payload_json::jsonb->'items')='array' THEN e.payload_json::jsonb->'items' ELSE '[]'::jsonb END
     ) it
     LEFT JOIN source_registry s ON s.id=it->>'sourceId'
     LEFT JOIN digest_item_labels d ON d.watch_profile_id=e.watch_profile_id
      AND d.source_id=it->>'sourceId' AND d.source_item_id=it->>'sourceItemId'
     WHERE e.watch_profile_id IN (SELECT jsonb_array_elements_text(?::jsonb))
     AND e.event_type='daily_digest' AND e.status IN ('sent','suppressed') AND e.created_at>=?
     AND (e.payload_json::jsonb->>'kind') IN ('keyword_scan_summary','keyword_new_listing')
     AND COALESCE(it->>'category','')<>'baseline'
     AND COALESCE(it->>'sourceItemId','')<>''
     ORDER BY e.created_at DESC LIMIT ?`,
  ).bind(JSON.stringify(profileIds), since, maxRows).all<DigestRow>();
  const seen = new Set<string>();
  return rows.results.flatMap((row) => {
    const key = `${row.profile_id}\u0000${row.source_id}\u0000${row.source_item_id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      profileId: row.profile_id,
      digestEventId: row.digest_event_id,
      digestAt: row.digest_at,
      sourceId: row.source_id,
      sourceName: row.source_name ?? row.source_id,
      sourceItemId: row.source_item_id,
      title: row.title ?? "未命名商品",
      url: row.url,
      imageUrl: row.image_url,
      price: yen(row.price),
      auction: row.auction === true || row.auction === 1 || row.auction === "true" || row.auction === "t",
      listedAt: row.listed_at,
      verdict: row.verdict,
    }];
  });
}

/**
 * 来源是采集记录 watch_run_listing_observations：被规则挡掉时 decision_reason 写成
 * 「命中排除词「X」（标题 / 只在说明或店名里）」（apps/collector/src/index.ts）。
 * 只列最近 EXCLUDED_WINDOW_DAYS 天上架（没有上架时间的按第一次看到）且还没卖掉的，一件只出一次。
 */
export async function recentExcludedItems(profileIds: readonly string[], maxRows: number): Promise<ExcludedFeedItem[]> {
  if (profileIds.length === 0) return [];
  const since = new Date(Date.now() - EXCLUDED_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await getEnv().DB.prepare(
    `SELECT * FROM (
       SELECT DISTINCT ON (b.watch_profile_id,o.source_id,o.source_item_id)
         b.watch_profile_id profile_id,o.source_id,s.display_name source_name,o.source_item_id,
         o.title,o.canonical_url url,o.image_url,o.current_price price,o.price_basis,
         o.source_listed_at listed_at,o.decision_reason reason,o.availability,
         MIN(o.observed_at) OVER (PARTITION BY b.watch_profile_id,o.source_id,o.source_item_id) first_seen_at,
         l.verdict
       FROM watch_run_listing_observations o
       JOIN watch_bindings b ON b.id=o.watch_binding_id
       LEFT JOIN source_registry s ON s.id=o.source_id
       LEFT JOIN digest_item_labels l ON l.watch_profile_id=b.watch_profile_id
        AND l.source_id=o.source_id AND l.source_item_id=o.source_item_id
       WHERE b.watch_profile_id IN (SELECT jsonb_array_elements_text(?::jsonb))
       AND o.observed_at>=?
       AND o.decision_status='rejected'
       AND o.decision_reason LIKE '命中排除词「%'
       ORDER BY b.watch_profile_id,o.source_id,o.source_item_id,o.observed_at DESC
     ) x
     WHERE x.availability<>'sold_out' AND COALESCE(x.listed_at,x.first_seen_at)>=?
     ORDER BY COALESCE(x.listed_at,x.first_seen_at) DESC
     LIMIT ?`,
  ).bind(JSON.stringify(profileIds), since, since, maxRows).all<ExcludedRow>();
  return rows.results.map((row) => ({
    profileId: row.profile_id,
    sourceId: row.source_id,
    sourceName: row.source_name ?? row.source_id,
    sourceItemId: row.source_item_id,
    title: row.title,
    url: row.url,
    imageUrl: row.image_url,
    price: yen(row.price),
    auction: row.price_basis === "auction_current_bid",
    listedAt: row.listed_at ?? row.first_seen_at,
    term: /命中排除词「(.+?)」/u.exec(row.reason)?.[1] ?? "",
    inTitle: row.reason.includes("（标题）"),
    wanted: row.verdict === "keep",
  }));
}

/**
 * 「挡错了」：记成一条「还想看」标注（digest_item_labels，不挂日报），说明这条排除词挡错了东西，之后据此收窄规则。
 * 不是第二种标注——日报标注只有「不想看」一种（用户 2026-10-12 定）。返回 null 表示成功。
 */
export async function setExcludedWanted(input: {
  profileId: string;
  sourceId: string;
  sourceItemId: string;
  wanted: boolean;
}): Promise<Response | null> {
  const env = getEnv();
  if (!input.wanted) {
    await env.DB.prepare(
      "DELETE FROM digest_item_labels WHERE watch_profile_id=? AND source_id=? AND source_item_id=? AND verdict='keep'",
    ).bind(input.profileId, input.sourceId, input.sourceItemId).run();
    return null;
  }
  // 商品信息以采集记录为准，不信前端传来的标题。
  const seen = await env.DB.prepare(
    `SELECT o.title,o.canonical_url,o.image_url,o.current_price
     FROM watch_run_listing_observations o JOIN watch_bindings b ON b.id=o.watch_binding_id
     WHERE b.watch_profile_id=? AND o.source_id=? AND o.source_item_id=?
     ORDER BY o.observed_at DESC LIMIT 1`,
  ).bind(input.profileId, input.sourceId, input.sourceItemId)
    .first<{ title: string; canonical_url: string; image_url: string | null; current_price: number | string | null }>();
  if (!seen) return apiError("listing_not_found", 404);
  await env.DB.prepare(
    `INSERT INTO digest_item_labels(watch_profile_id,source_id,source_item_id,verdict,title,url,image_url,price,digest_event_id,labeled_at)
     VALUES(?,?,?,'keep',?,?,?,?,NULL,?)
     ON CONFLICT (watch_profile_id,source_id,source_item_id) DO UPDATE SET
       verdict='keep',title=excluded.title,url=excluded.url,image_url=excluded.image_url,
       price=excluded.price,labeled_at=excluded.labeled_at,
       reviewed_at=CASE WHEN digest_item_labels.verdict='keep' THEN digest_item_labels.reviewed_at END`,
  ).bind(
    input.profileId,
    input.sourceId,
    input.sourceItemId,
    seen.title.slice(0, 1000),
    seen.canonical_url,
    seen.image_url,
    yen(seen.current_price),
    new Date().toISOString(),
  ).run();
  return null;
}
