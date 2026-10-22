import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { findExistingItemWatch, initialNextRunAt, legacyIntervalMinutes, notificationColumns, resolveMonitoringPurpose } from "@/lib/monitoring";
import { watchBindingSchema } from "@jpgr/validation";
import { sourcePolicy } from "@/lib/source-policy";
import { exactProductSourceConfig } from "@/lib/exact-product-watch";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchBindingSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const env = getEnv();
  const profileId = await routeId(context);
  const [profile, policy] = await Promise.all([
    env.DB.prepare("SELECT id,dossier_kind FROM watch_profiles WHERE id=?")
      .bind(profileId).first<{ id: string; dossier_kind: "item" | "exact_product" | "keyword" }>(),
    sourcePolicy(),
  ]);
  const source = policy.get(parsed.data.source);
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (!source) return apiError("source_not_found", 404);
  const requestedDossierKind = parsed.data.kind === "item"
    ? "item"
    : parsed.data.sourceConfig.searchMode === "exact_product"
      ? "exact_product"
      : "keyword";
  if (profile.dossier_kind !== requestedDossierKind) return apiError("watch_dossier_kind_mismatch", 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const value = parsed.data;
  const purpose = resolveMonitoringPurpose(value.kind, value.monitoringPurpose);
  const notifications = notificationColumns(
    purpose,
    profile.dossier_kind === "exact_product" ? {} : value,
    { exactProduct: profile.dossier_kind === "exact_product", sourceId: value.source },
  );
  const sourceItemId = value.kind === "item" && typeof value.sourceConfig.itemId === "string"
    ? value.sourceConfig.itemId
    : null;
  const sourceConfig = profile.dossier_kind === "exact_product"
    ? exactProductSourceConfig(value.sourceConfig)
    : value.sourceConfig;
  if (sourceItemId) {
    const existing = await findExistingItemWatch(env.DB, value.source, sourceItemId);
    if (existing) return Response.json({ id: existing.bindingId, profileId: existing.profileId, paused: !existing.enabled, alreadyWatching: true });
  }
  try {
    await env.DB.prepare(
      `INSERT INTO watch_bindings(
        id,watch_profile_id,source_id,kind,query,search_url,target_url,source_config_json,source_item_id,
        monitoring_purpose,interval_minutes,schedule_interval_minutes,next_run_at,notify_initial,notify_new_listing,
        notify_price_drop,notify_price_rise,notify_restock,notify_sold_out,target_price,min_drop_amount,enabled,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, profileId, value.source, value.kind, value.query ?? null, value.searchUrl ?? null, value.targetUrl ?? null,
      JSON.stringify(sourceConfig), sourceItemId, purpose, legacyIntervalMinutes(value.intervalMinutes),
      value.intervalMinutes, initialNextRunAt(value.nextRunAt), profile.dossier_kind === "exact_product" ? 1 : 0,
      notifications.notifyNewListing,
      notifications.notifyPriceDrop, notifications.notifyPriceRise, notifications.notifyRestock, notifications.notifySoldOut,
      value.targetPrice ?? null, value.minDropAmount, source.monitoringAllowed ? 1 : 0, now, now).run();
  } catch (error) {
    const raced = sourceItemId ? await findExistingItemWatch(env.DB, value.source, sourceItemId) : null;
    if (raced) return Response.json({ id: raced.bindingId, profileId: raced.profileId, paused: !raced.enabled, alreadyWatching: true });
    throw error;
  }
  return Response.json({ id, paused: !source.monitoringAllowed, alreadyWatching: false }, { status: 201 });
}
