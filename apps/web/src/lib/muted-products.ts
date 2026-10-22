import { mutedProductTitleMatches } from "@jpgr/core";
import { apiError } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

/** 预演和命中计数都按过去这么多天这个档案采到的商品算。 */
export const MUTED_PRODUCT_WINDOW_DAYS = 30;
export const MUTED_PRODUCT_EXAMPLE_LIMIT = 30;

export interface MutedProductProfile {
  id: string;
  name: string;
  include_terms_json: string;
  /** 档案的日文关键词：每件商品都有，标题点选时不列出来。 */
  query: string | null;
}

export interface RecentListing {
  sourceId: string;
  sourceName: string;
  sourceItemId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  price: number | null;
  purchasable: boolean;
  observedAt: string;
}

/** 屏蔽单品只对关键词档案有意义：精确同款有自己的「不是同款」判定。 */
export async function mutedProductProfile(id: string): Promise<MutedProductProfile | Response> {
  const profile = await getEnv().DB.prepare(
    `SELECT p.id,p.name,p.dossier_kind,p.include_terms_json,
     (SELECT b.query FROM watch_bindings b WHERE b.watch_profile_id=p.id AND b.kind='keyword' ORDER BY b.created_at LIMIT 1) query
     FROM watch_profiles p WHERE p.id=?`,
  ).bind(id).first<MutedProductProfile & { dossier_kind: string }>();
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (profile.dossier_kind !== "keyword") return apiError("muted_products_require_keyword_dossier", 409);
  return profile;
}

/** 这个档案近期采到的每件商品（同一件只取最近一次）。生产上赛车初音约 2400 行观察、几十毫秒。 */
export async function recentProfileListings(profileId: string): Promise<RecentListing[]> {
  const since = new Date(Date.now() - MUTED_PRODUCT_WINDOW_DAYS * 86_400_000).toISOString();
  const result = await getEnv().DB.prepare(
    `SELECT DISTINCT ON (o.source_id,o.source_item_id)
     o.source_id,s.display_name source_name,o.source_item_id,o.title,o.canonical_url,o.image_url,
     o.current_price,o.is_purchasable,o.observed_at
     FROM watch_run_listing_observations o
     JOIN watch_bindings b ON b.id=o.watch_binding_id
     LEFT JOIN source_registry s ON s.id=o.source_id
     WHERE b.watch_profile_id=? AND b.kind='keyword' AND o.observed_at>=?
     ORDER BY o.source_id,o.source_item_id,o.observed_at DESC`,
  ).bind(profileId, since).all<{
    source_id: string;
    source_name: string | null;
    source_item_id: string;
    title: string;
    canonical_url: string;
    image_url: string | null;
    current_price: number | string | null;
    is_purchasable: number | string;
    observed_at: string;
  }>();
  return result.results.map((row) => ({
    sourceId: row.source_id,
    sourceName: row.source_name ?? row.source_id,
    sourceItemId: row.source_item_id,
    title: row.title,
    url: row.canonical_url,
    imageUrl: row.image_url,
    price: row.current_price === null ? null : Number(row.current_price),
    purchasable: Number(row.is_purchasable) === 1,
    observedAt: row.observed_at,
  }));
}

export function listingsMatching(listings: readonly RecentListing[], termGroups: readonly string[]): RecentListing[] {
  return listings
    .filter((listing) => mutedProductTitleMatches(listing.title, termGroups))
    // 在售的、最近看到的排前面：用户最想确认的是"明天还会不会收到它"。
    .sort((left, right) => Number(right.purchasable) - Number(left.purchasable)
      || right.observedAt.localeCompare(left.observedAt));
}
