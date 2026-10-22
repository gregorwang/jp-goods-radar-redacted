import { unauthorized } from "@/lib/api-auth";
import { apiError, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };

// 一份精确同款档案下所有已确认的同款报价，跨来源合并成一张清单。
// 来源详情页按来源分开列；用户在"商品变化"里要回答的是"这个档案一共找到了哪几件、
// 每件现在是不是还在帮我等降价"，所以这里不按来源拆。
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const env = getEnv();
  const profileId = await routeId(context);
  const profile = await env.DB.prepare("SELECT dossier_kind FROM watch_profiles WHERE id=?")
    .bind(profileId).first<{ dossier_kind: string }>();
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (profile.dossier_kind !== "exact_product") return Response.json({ items: [], alertPolicy: null });
  // 同一件"在跟踪"的商品，等的东西可能完全不同：有目标价的档案只等降到目标价，
  // 没有的才是每次降价都提醒。界面必须说清楚在等哪一种，否则"等降价中"毫无意义。
  const rule = await env.DB.prepare(
    "SELECT event_types_json,target_listing_price FROM monitor_rules WHERE watch_profile_id=? AND valid_to IS NULL",
  ).bind(profileId).first<{ event_types_json: string; target_listing_price: number | null }>();
  const eventTypes = rule ? JSON.parse(rule.event_types_json) as unknown : [];
  const configured = Array.isArray(eventTypes) ? eventTypes : [];
  const targetPrice = rule?.target_listing_price ?? null;
  const alertPolicy = {
    targetPrice: configured.includes("product.offer_below_target_listing_price") ? targetPrice : null,
    everyDrop: configured.includes("listing.price_changed"),
  };

  const result = await env.DB.prepare(
    `SELECT m.watch_binding_id binding_id,l.id listing_id,l.source_id,
     COALESCE(s.display_name,l.source_id) source_display_name,
     l.canonical_url,l.title,l.image_url,l.current_price,l.price_basis,l.availability,l.item_condition,
     m.first_seen_at,m.tracking_status,m.tracking_next_run_at,m.tracking_last_success_at,
     m.tracking_last_error_message,
     -- 首次确认时的价格：取匹配建立之后的第一张价格快照，用来算"较首次降了多少"。
     (SELECT ls.price FROM listing_snapshots ls
       WHERE ls.listing_id=m.listing_id AND ls.price IS NOT NULL AND ls.observed_at>=m.first_seen_at
       ORDER BY ls.observed_at ASC LIMIT 1) first_price
     FROM watch_listing_matches m
     JOIN watch_bindings b ON b.id=m.watch_binding_id
     JOIN listings l ON l.id=m.listing_id
     LEFT JOIN source_registry s ON s.id=l.source_id
     WHERE b.watch_profile_id=?
       -- 用户判过"不是同款"的不算确认同款；"太贵了"仍在等降价，保留。
       AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
         WHERE x.watch_binding_id=m.watch_binding_id AND x.source_id=l.source_id
           AND x.source_item_id=l.source_item_id AND x.reason='not_same_product')
     ORDER BY m.first_seen_at DESC LIMIT 200`,
  ).bind(profileId).all();
  return Response.json({ items: result.results, alertPolicy });
}
