import { unauthorized } from "@/lib/api-auth";
import { apiError, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const [listing, snapshots, events, watches] = await Promise.all([
    env.DB.prepare("SELECT * FROM listings WHERE id=?").bind(id).first(),
    env.DB.prepare(
      `SELECT * FROM (
         SELECT * FROM listing_snapshots WHERE listing_id=? ORDER BY observed_at DESC LIMIT 100
       ) ORDER BY observed_at`,
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT id,COALESCE(semantic_event_type,event_type) event_type,status,created_at
       FROM events WHERE listing_id=? ORDER BY created_at DESC LIMIT 100`,
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT p.id profile_id,p.name,b.id binding_id,b.enabled,p.enabled profile_enabled,
              b.target_price,b.min_drop_amount,b.monitoring_purpose,b.schedule_interval_minutes,b.next_run_at
       FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
       JOIN listings l ON l.id=? AND b.kind='item'
        AND b.source_id=l.source_id AND b.source_item_id=l.source_item_id
       LIMIT 1`,
    ).bind(id).all(),
  ]);
  return listing ? Response.json({ listing, snapshots: snapshots.results, events: events.results, watches: watches.results }) : apiError("listing_not_found", 404);
}
