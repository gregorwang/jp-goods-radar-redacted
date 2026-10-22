import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import {
  findExistingItemWatch,
  initialNextRunAt,
  itemScheduleSourceConfig,
  legacyIntervalMinutes,
  notificationColumns,
  type ExistingItemWatch,
} from "@/lib/monitoring";
import {
  canCreateItemPriceWatch,
  listingLifecycleKind,
  parseSourceItemUrl,
  restockOnlyItemWatch,
  itemScheduleConfig,
  type NormalizedListing,
  type RunBindingJob,
} from "@jpgr/core";
import {
  normalizedListingSchema,
  directItemWatchUrlSchema,
  previewItemWatchSchema,
  type DirectItemWatchUrlInput,
  type PreviewItemWatchInput,
} from "@jpgr/validation";
import { sourcePolicy } from "@/lib/source-policy";
import { initialMonitorRuleStatement } from "@/lib/monitor-rules";

type AppEnv = ReturnType<typeof getEnv>;

interface DirectItemContext {
  listing: NormalizedListing;
  requestedIntervalMinutes: number;
  itemScheduleMode?: import("@jpgr/core").ItemScheduleMode;
  itemScheduleMaxMinutes?: number;
  lifecycleKind: import("@jpgr/core").ListingLifecycleKind;
}

function errorDetail(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string") return undefined;
  return value.message.slice(0, 300);
}

async function resolveDirectItem(
  env: AppEnv,
  input: DirectItemWatchUrlInput,
): Promise<{ ok: true; value: PreviewItemWatchInput; context: DirectItemContext } | { ok: false; response: Response }> {
  const target = parseSourceItemUrl(input.targetUrl);
  if (!target) return { ok: false, response: apiError("invalid_item_url") };
  const response = await env.COLLECTOR.fetch("http://collector/internal/listing-detail-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: target.sourceId,
      sourceItemId: target.sourceItemId,
      targetUrl: target.canonicalUrl,
    }),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = response.status === 429
      ? "item_lookup_rate_limited"
      : response.status === 409
        ? "item_lookup_source_unavailable"
        : "item_lookup_failed";
    return {
      ok: false,
      response: Response.json(
        { error, upstreamStatus: response.status, message: errorDetail(payload) },
        { status: response.status === 429 ? 429 : response.status === 409 ? 409 : 502 },
      ),
    };
  }
  const listingValue = payload && typeof payload === "object" && "listing" in payload ? payload.listing : undefined;
  const listing = normalizedListingSchema.safeParse(listingValue);
  if (
    !listing.success
    || listing.data.sourceId !== target.sourceId
    || listing.data.sourceItemId !== target.sourceItemId
  ) {
    return { ok: false, response: apiError("item_identity_mismatch", 502) };
  }
  const watch = previewItemWatchSchema.safeParse({
    source: listing.data.sourceId,
    sourceItemId: listing.data.sourceItemId,
    targetUrl: listing.data.canonicalUrl,
    name: listing.data.title.slice(0, 120),
    identityScope: listing.data.identityScope,
    availability: listing.data.availability,
    intervalMinutes: input.intervalMinutes,
    itemScheduleMode: input.itemScheduleMode,
    itemScheduleMaxMinutes: input.itemScheduleMaxMinutes,
    nextRunAt: input.nextRunAt,
    minDropAmount: input.minDropAmount,
    ...(input.targetPrice === undefined ? {} : { targetPrice: input.targetPrice }),
    notifyPriceDrop: input.notifyPriceDrop,
    notifyRestock: input.notifyRestock,
    notifySoldOut: input.notifySoldOut,
  });
  if (!watch.success) return { ok: false, response: apiError("item_payload_invalid", 502) };
  return {
    ok: true,
    value: watch.data,
    context: {
      listing: listing.data,
      requestedIntervalMinutes: input.intervalMinutes,
      itemScheduleMode: input.itemScheduleMode,
      itemScheduleMaxMinutes: input.itemScheduleMaxMinutes,
      lifecycleKind: listingLifecycleKind({
        sourceId: listing.data.sourceId,
        identityScope: listing.data.identityScope,
      }),
    },
  };
}

async function enqueueImmediateCheck(env: AppEnv, bindingId: string, queuedAt: string): Promise<boolean> {
  try {
    await env.MONITOR_QUEUE.send({
      type: "run_binding",
      idempotencyKey: `run_binding:${bindingId}:initial:${queuedAt}`,
      bindingId,
      trigger: "manual",
      queuedAt,
    } satisfies RunBindingJob);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "item_watch_initial_enqueue_failed",
      bindingId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return false;
  }
}

function directListingResponse(context: DirectItemContext) {
  return {
    sourceId: context.listing.sourceId,
    title: context.listing.title,
    availability: context.listing.availability,
    canonicalUrl: context.listing.canonicalUrl,
    currentPrice: context.listing.currentPrice ?? null,
    lifecycleKind: context.lifecycleKind,
  };
}

function directSourceConfig(context: DirectItemContext): Record<string, unknown> {
  const config = {
    itemId: context.listing.sourceItemId,
    lifecycleKind: context.lifecycleKind,
    ...(context.listing.sourceId === "cospa" ? { itemLookup: "target_url" } : {}),
    ...(context.listing.rawMetadata?.inventorySource === "public_item_microdata"
      ? { inventoryLookup: "source_runner_page" }
      : {}),
  };
  return context.lifecycleKind === "auction" ? config : itemScheduleSourceConfig(config, context);
}

async function activateExistingDirectWatch(
  env: AppEnv,
  existing: ExistingItemWatch,
  context: DirectItemContext,
  monitoringAllowed: boolean,
) {
  const now = new Date().toISOString();
  if (monitoringAllowed) {
    const saved = await env.DB.prepare("SELECT source_config_json FROM watch_bindings WHERE id=?")
      .bind(existing.bindingId).first<{ source_config_json: string }>();
    const savedConfig = itemScheduleConfig(saved?.source_config_json ?? "{}");
    const config = context.lifecycleKind === "auction" ? directSourceConfig(context)
      : itemScheduleSourceConfig({ ...directSourceConfig(context), itemSchedule: savedConfig.itemSchedule }, { ...context, reset: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE watch_profiles SET enabled=1,updated_at=? WHERE id=?")
        .bind(now, existing.profileId),
      env.DB.prepare(
        `UPDATE watch_bindings SET
          enabled=1,interval_minutes=?,schedule_interval_minutes=?,next_run_at=?,
          target_url=?,source_config_json=?,
          notify_initial=0,
          updated_at=?
         WHERE id=?`,
      ).bind(
        legacyIntervalMinutes(context.requestedIntervalMinutes),
        context.requestedIntervalMinutes,
        now,
        context.listing.canonicalUrl,
        JSON.stringify(config),
        now,
        existing.bindingId,
      ),
    ]);
  }
  const checkQueued = monitoringAllowed
    ? await enqueueImmediateCheck(env, existing.bindingId, now)
    : false;
  return Response.json({
    profileId: existing.profileId,
    bindingId: existing.bindingId,
    paused: !monitoringAllowed,
    alreadyWatching: true,
    resumed: monitoringAllowed && !existing.enabled,
    checkQueued,
    intervalMinutes: context.requestedIntervalMinutes,
    listing: directListingResponse(context),
  });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  const result = await getEnv().DB.prepare(
    `SELECT b.source_id,b.source_item_id,b.id binding_id,b.watch_profile_id,
            b.enabled binding_enabled,p.enabled profile_enabled,b.monitoring_purpose,
            b.schedule_interval_minutes,b.next_run_at
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     WHERE b.kind='item' AND b.source_item_id IS NOT NULL ORDER BY b.updated_at DESC`,
  ).all();
  return Response.json({ items: result.results });
}

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const env = getEnv();
  const directInput = directItemWatchUrlSchema.safeParse(body.value);
  let value: PreviewItemWatchInput;
  let directContext: DirectItemContext | undefined;
  if (directInput.success) {
    const resolved = await resolveDirectItem(env, directInput.data);
    if (!resolved.ok) return resolved.response;
    value = resolved.value;
    directContext = resolved.context;
  } else {
    const parsed = previewItemWatchSchema.safeParse(body.value);
    if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
    value = parsed.data;
  }
  if (value.source === "yahoo_shopping") return apiError("item_lookup_unsupported", 409);
  const [policy, existing] = await Promise.all([
    sourcePolicy(),
    findExistingItemWatch(env.DB, value.source, value.sourceItemId),
  ]);
  const source = policy.get(value.source);
  if (!source) return apiError("source_not_found", 404);
  if (existing?.completed) return apiError("watch_profile_completed", 409);
  if (existing && directContext) {
    return activateExistingDirectWatch(env, existing, directContext, source.monitoringAllowed);
  }
  if (existing) return Response.json({
    profileId: existing.profileId,
    bindingId: existing.bindingId,
    paused: !existing.enabled,
    alreadyWatching: true,
  });
  if (!canCreateItemPriceWatch(value.availability, value.identityScope, value.source)) {
    return apiError("terminal_listing_requires_product_radar", 409);
  }
  const profileId = crypto.randomUUID(); const bindingId = crypto.randomUUID(); const now = new Date().toISOString();
  if (directContext?.lifecycleKind === "auction") {
    value = { ...value, notifyPriceDrop: false, notifyRestock: false };
    delete value.targetPrice;
  } else if (directContext?.lifecycleKind === "one_off") {
    value = { ...value, notifyRestock: false };
  }
  const effectiveNotifications = notificationColumns("item_price", value, {
    restockOnly: restockOnlyItemWatch(value.availability, value.source),
    sourceId: value.source,
  });
  const notifyInitial = 0;
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO watch_profiles(id,name,dossier_kind,created_at,updated_at) VALUES(?,?,'item',?,?)").bind(profileId, value.name, now, now),
      env.DB.prepare(
        `INSERT INTO watch_bindings(
          id,watch_profile_id,source_id,kind,target_url,source_config_json,source_item_id,monitoring_purpose,
          interval_minutes,schedule_interval_minutes,next_run_at,notify_initial,notify_new_listing,notify_price_drop,notify_price_rise,notify_restock,
          notify_sold_out,target_price,min_drop_amount,enabled,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(bindingId, profileId, value.source, "item", value.targetUrl, JSON.stringify(
        directContext ? directSourceConfig(directContext)
          : value.source === "yahoo_auctions_jp" ? { itemId: value.sourceItemId }
          : itemScheduleSourceConfig({ itemId: value.sourceItemId }, value),
      ),
        value.sourceItemId, "item_price", legacyIntervalMinutes(value.intervalMinutes), value.intervalMinutes,
        initialNextRunAt(value.nextRunAt), notifyInitial, effectiveNotifications.notifyNewListing, effectiveNotifications.notifyPriceDrop,
        effectiveNotifications.notifyPriceRise,
        effectiveNotifications.notifyRestock, effectiveNotifications.notifySoldOut, value.targetPrice ?? null, value.minDropAmount,
        source.monitoringAllowed ? 1 : 0, now, now),
      initialMonitorRuleStatement(env.DB, {
        profileId,
        dossierKind: "item",
        now,
        ...(value.targetPrice === undefined ? {} : { targetListingPrice: value.targetPrice }),
        eventTypes: [
          ...(effectiveNotifications.notifyPriceDrop || effectiveNotifications.notifyPriceRise ? ["listing.price_changed" as const] : []),
          ...(effectiveNotifications.notifyRestock || effectiveNotifications.notifySoldOut ? ["listing.availability_changed" as const] : []),
          ...(value.targetPrice === undefined ? [] : ["product.offer_below_target_listing_price" as const]),
        ],
      }),
    ]);
  } catch (error) {
    const raced = await findExistingItemWatch(env.DB, value.source, value.sourceItemId);
    if (raced && directContext) {
      return activateExistingDirectWatch(env, raced, directContext, source.monitoringAllowed);
    }
    if (raced) return Response.json({
      profileId: raced.profileId,
      bindingId: raced.bindingId,
      paused: !raced.enabled,
      alreadyWatching: true,
    });
    throw error;
  }
  const checkQueued = source.monitoringAllowed && directContext
    ? await enqueueImmediateCheck(env, bindingId, now)
    : false;
  return Response.json({
    profileId,
    bindingId,
    paused: !source.monitoringAllowed,
    alreadyWatching: false,
    resumed: false,
    checkQueued,
    intervalMinutes: value.intervalMinutes,
    ...(directContext ? { listing: directListingResponse(directContext) } : {}),
  }, { status: 201 });
}
