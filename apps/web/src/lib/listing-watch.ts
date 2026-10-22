import "server-only";
import { canCreateItemPriceWatch, listingLifecycleKind, restockOnlyItemWatch } from "@jpgr/core";
import type { listingWatchOptionsSchema } from "@jpgr/validation";
import type { z } from "zod";
import { apiError } from "./api-mutation";
import { privateJson } from "./api-response";
import { getEnv } from "./cloudflare";
import {
  findExistingItemWatch, initialNextRunAt, itemScheduleSourceConfig, legacyIntervalMinutes, notificationColumns, resetItemScheduleForProfile,
} from "./monitoring";
import { initialMonitorRuleStatement } from "./monitor-rules";
import { sourcePolicy } from "./source-policy";

/**
 * 给库里已有的一件商品建「等降价」单品档案。主站商品页（/api/listings/[id]/watch）和
 * 手机 App（/api/device/watches）共用这一份：同一件商品已经在盯就原样返回，不建第二个。
 */
export async function createListingWatch(
  listingId: string,
  options: z.output<typeof listingWatchOptionsSchema>,
): Promise<Response> {
  const env = getEnv();
  const listing = await env.DB.prepare("SELECT * FROM listings WHERE id=?")
    .bind(listingId).first<Record<string, unknown>>();
  if (!listing) return apiError("listing_not_found", 404);
  const sourceId = String(listing.source_id);
  const sourceItemId = String(listing.source_item_id);
  const existing = await findExistingItemWatch(env.DB, sourceId, sourceItemId);
  if (existing?.completed) return apiError("watch_profile_completed", 409);
  if (existing) return Response.json({
    profileId: existing.profileId,
    bindingId: existing.bindingId,
    paused: !existing.enabled,
    alreadyWatching: true,
  });
  if (!canCreateItemPriceWatch(String(listing.availability), String(listing.identity_scope), String(listing.source_id))) {
    return apiError("terminal_listing_requires_product_radar", 409);
  }
  const sourceRow = (await sourcePolicy()).get(String(listing.source_id));
  if (!sourceRow) return apiError("source_not_found", 404);
  const profileId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const now = new Date().toISOString();
  let value = options;
  const lifecycleKind = listingLifecycleKind({
    sourceId,
    identityScope: String(listing.identity_scope),
  });
  if (lifecycleKind === "auction") {
    value = { ...value, notifyPriceDrop: false, notifyRestock: false };
    delete value.targetPrice;
  } else if (lifecycleKind === "one_off") {
    value = { ...value, notifyRestock: false };
  }
  const notifications = notificationColumns("item_price", value, {
    restockOnly: restockOnlyItemWatch(String(listing.availability), String(listing.source_id)),
    sourceId: String(listing.source_id),
  });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO watch_profiles(id,name,dossier_kind,created_at,updated_at) VALUES(?,?,'item',?,?)")
        .bind(profileId, value.name ?? String(listing.title), now, now),
      env.DB.prepare(
        `INSERT INTO watch_bindings(
          id,watch_profile_id,source_id,kind,target_url,source_config_json,source_item_id,monitoring_purpose,
          interval_minutes,schedule_interval_minutes,next_run_at,baseline_completed,notify_new_listing,notify_price_drop,notify_price_rise,
          notify_restock,notify_sold_out,target_price,min_drop_amount,enabled,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(bindingId, profileId, sourceId, "item", listing.canonical_url,
        JSON.stringify(lifecycleKind === "auction" ? { itemId: sourceItemId, lifecycleKind }
          : itemScheduleSourceConfig({ itemId: sourceItemId, lifecycleKind }, value)), sourceItemId, "item_price", legacyIntervalMinutes(value.intervalMinutes),
        value.intervalMinutes, initialNextRunAt(value.nextRunAt), 1, notifications.notifyNewListing,
        notifications.notifyPriceDrop, notifications.notifyPriceRise, notifications.notifyRestock, notifications.notifySoldOut,
        value.targetPrice ?? null, value.minDropAmount, sourceRow.monitoringAllowed ? 1 : 0, now, now),
      env.DB.prepare(
        `INSERT INTO watch_listing_matches(
          watch_binding_id,listing_id,first_seen_at,last_seen_at,acceptance_reason,accepted_at
        ) VALUES(?,?,?,?,'direct_item',?)`,
      ).bind(bindingId, listingId, now, now, now),
      initialMonitorRuleStatement(env.DB, {
        profileId,
        dossierKind: "item",
        now,
        listingId,
        ...(value.targetPrice === undefined ? {} : { targetListingPrice: value.targetPrice }),
        eventTypes: [
          ...(notifications.notifyPriceDrop || notifications.notifyPriceRise ? ["listing.price_changed" as const] : []),
          ...(notifications.notifyRestock || notifications.notifySoldOut ? ["listing.availability_changed" as const] : []),
          ...(value.targetPrice === undefined ? [] : ["product.offer_below_target_listing_price" as const]),
        ],
      }),
    ]);
  } catch (error) {
    const raced = await findExistingItemWatch(env.DB, sourceId, sourceItemId);
    if (raced) return Response.json({
      profileId: raced.profileId,
      bindingId: raced.bindingId,
      paused: !raced.enabled,
      alreadyWatching: true,
    });
    throw error;
  }
  return Response.json({ profileId, bindingId, paused: !sourceRow.monitoringAllowed, alreadyWatching: false }, { status: 201 });
}

/**
 * 单品档案同时在盯的上限。单品复查要用 VPS 上的抓取额度，和每小时的关键词巡回共用、会被煤炉限流。
 * 手机 App 的「等降价」和收件箱的「盯住」共用这一个数。
 */
export const ACTIVE_ITEM_WATCH_LIMIT = 30;

async function activeItemWatchCount(): Promise<number> {
  const row = await getEnv().DB.prepare(
    `SELECT count(*) n FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     WHERE b.kind='item' AND b.enabled=1 AND p.enabled=1`,
  ).first<{ n: number | string }>();
  return Number(row?.n ?? 0);
}

/**
 * 按来源商品号盯一件商品：已经在盯就原样返回；以前点过「不盯了」就恢复原档案，不建第二个
 * （主站 resume 同一组语句）；都没有才新建。返回 { watching, paused? }。
 */
export async function startItemWatch(
  sourceId: string,
  sourceItemId: string,
  options: z.output<typeof listingWatchOptionsSchema>,
): Promise<Response> {
  const env = getEnv();
  const existing = await findExistingItemWatch(env.DB, sourceId, sourceItemId);
  if (existing?.completed) return apiError("watch_profile_completed", 409);
  if (existing?.enabled) return privateJson({ watching: true, alreadyWatching: true });
  if (await activeItemWatchCount() >= ACTIVE_ITEM_WATCH_LIMIT) return apiError("watch_limit_reached", 409);

  if (existing) {
    const source = (await sourcePolicy()).get(sourceId);
    if (!source?.monitoringAllowed) return apiError("source_monitoring_paused", 409);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE watch_profiles SET enabled=1,updated_at=? WHERE id=?").bind(now, existing.profileId),
      resetItemScheduleForProfile(env.DB, existing.profileId, true),
      env.DB.prepare(
        "UPDATE watch_bindings SET enabled=1,next_run_at=?,cooldown_until=NULL,updated_at=? WHERE id=? AND watch_profile_id=?",
      ).bind(now, now, existing.bindingId, existing.profileId),
    ]);
    return privateJson({ watching: true, resumed: true });
  }

  const listing = await env.DB.prepare("SELECT id FROM listings WHERE source_id=? AND source_item_id=? LIMIT 1")
    .bind(sourceId, sourceItemId).first<{ id: string }>();
  if (!listing) return apiError("listing_not_found", 404);
  const created = await createListingWatch(listing.id, options);
  if (!created.ok) return created;
  const result = await created.json() as { paused?: boolean };
  return privateJson({ watching: result.paused !== true, paused: result.paused === true }, { status: 201 });
}

/** 不盯了：暂停这个单品档案（和主站「暂停」同一组语句），记录都留着。 */
export async function stopItemWatch(sourceId: string, sourceItemId: string): Promise<Response> {
  const env = getEnv();
  const existing = await findExistingItemWatch(env.DB, sourceId, sourceItemId);
  if (!existing) return privateJson({ watching: false });
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE watch_profiles SET enabled=0,updated_at=? WHERE id=?").bind(now, existing.profileId),
    resetItemScheduleForProfile(env.DB, existing.profileId),
    env.DB.prepare("UPDATE watch_bindings SET enabled=0,updated_at=? WHERE watch_profile_id=?").bind(now, existing.profileId),
  ]);
  return privateJson({ watching: false });
}
