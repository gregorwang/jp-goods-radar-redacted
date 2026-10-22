import { isOneOffListingSource, trackedListingIntervalMinutes } from "@jpgr/core";
import { watchListingTrackingActionSchema } from "@jpgr/validation";
import { apiError, denyMutation, readJsonBody } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string; listingId: string }> };

export async function PATCH(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchListingTrackingActionSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const { id: bindingId, listingId } = await context.params;
  const env = getEnv();
  const row = await env.DB.prepare(
    `SELECT m.tracking_status,l.source_id,l.current_price,l.availability,l.state_hash,p.dossier_kind
     FROM watch_listing_matches m
     JOIN watch_bindings b ON b.id=m.watch_binding_id
     JOIN watch_profiles p ON p.id=b.watch_profile_id
     JOIN listings l ON l.id=m.listing_id
     WHERE m.watch_binding_id=? AND m.listing_id=?`,
  ).bind(bindingId, listingId).first<{
    tracking_status: string;
    source_id: string;
    current_price: number | null;
    availability: string;
    state_hash: string | null;
    dossier_kind: string;
  }>();
  if (!row) return apiError("watch_listing_match_not_found", 404);
  if (row.dossier_kind !== "exact_product") return apiError("listing_tracking_requires_exact_product", 409);

  const now = new Date().toISOString();
  const action = parsed.data.action;
  if (action === "track") {
    if (["yahoo_shopping", "ebay"].includes(row.source_id)) {
      return apiError("listing_detail_tracking_unsupported", 409);
    }
    if (isOneOffListingSource(row.source_id) && ["sold_out", "unavailable"].includes(row.availability)) {
      return apiError("terminal_one_off_listing_cannot_resume", 409);
    }
    const status = ["sold_out", "unavailable"].includes(row.availability) ? "waiting_restock" : "active";
    await env.DB.prepare(
      `UPDATE watch_listing_matches SET tracking_status=?,tracking_interval_minutes=?,
       tracking_next_run_at=?,tracking_started_at=COALESCE(tracking_started_at,?),
       tracking_baseline_completed=1,tracking_last_price=?,tracking_last_availability=?,
       tracking_last_state_hash=?,
       tracking_ended_at=NULL,tracking_terminal_reason=NULL,tracking_missing_observations=0,
       tracking_consecutive_failures=0,tracking_cooldown_until=NULL,
       tracking_last_error_code=NULL,tracking_last_error_message=NULL
       WHERE watch_binding_id=? AND listing_id=?`,
    ).bind(
      status,
      trackedListingIntervalMinutes(row.source_id),
      now,
      now,
      row.current_price,
      row.availability,
      row.state_hash,
      bindingId,
      listingId,
    ).run();
  } else {
    const status = action === "purchased" ? "purchased" : "dismissed";
    await env.DB.prepare(
      `UPDATE watch_listing_matches SET tracking_status=?,tracking_next_run_at=NULL,
       tracking_cooldown_until=NULL,tracking_ended_at=?,tracking_terminal_reason=?
       WHERE watch_binding_id=? AND listing_id=?`,
    ).bind(status, now, action === "purchased" ? "user_purchased" : "user_dismissed", bindingId, listingId).run();
  }
  const saved = await env.DB.prepare(
    `SELECT tracking_status,tracking_next_run_at,tracking_last_run_at,tracking_last_success_at,
     tracking_last_error_code,tracking_last_error_message,tracking_terminal_reason
     FROM watch_listing_matches WHERE watch_binding_id=? AND listing_id=?`,
  ).bind(bindingId, listingId).first();
  return Response.json({ updated: true, tracking: saved });
}
