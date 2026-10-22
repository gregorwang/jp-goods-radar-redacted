import { unauthorized } from "@/lib/api-auth";
import { routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const env = getEnv();
  const bindingId = await routeId(context);
  const result = await env.DB.prepare(
    `SELECT l.id,l.source_id,l.source_item_id,l.canonical_url,l.title,l.image_url,
     l.current_price,l.original_price,l.currency,l.availability,l.item_condition,
     l.source_listed_at,l.last_changed_at,
     m.first_seen_at match_first_seen_at,m.last_seen_at match_last_seen_at,m.new_listing_notified_at,
     m.tracking_status,m.tracking_interval_minutes,m.tracking_next_run_at,m.tracking_last_run_at,
     m.tracking_last_success_at,m.tracking_last_error_code,m.tracking_last_error_message,
     m.tracking_terminal_reason,
     CASE
       WHEN m.new_listing_notified_at IS NOT NULL THEN 'notified'
       WHEN EXISTS (
         SELECT 1 FROM events e
         WHERE e.watch_binding_id=m.watch_binding_id
           AND e.listing_id=m.listing_id
           AND e.event_type='new_listing'
       ) THEN 'detected'
       ELSE 'baseline'
     END match_stage
     FROM watch_listing_matches m JOIN listings l ON l.id=m.listing_id
     WHERE m.watch_binding_id=?
       -- 与上新闸门保持同一口径：只排除终局状态。库存状态未知的来源
       -- （Yahoo! Shopping 搜索页没有库存字段）不能被整体挡在证据页之外。
       AND l.availability NOT IN ('sold_out','unavailable')
     ORDER BY m.first_seen_at DESC,l.last_changed_at DESC LIMIT 200`,
  ).bind(bindingId).all();
  return Response.json({ items: result.results, trackingEnabled: false });
}
