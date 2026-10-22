import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { itemScheduleSourceConfig, legacyIntervalMinutes, notificationColumns, resolveMonitoringPurpose } from "@/lib/monitoring";
import { itemScheduleConfig, itemSchedulePolicy, supportsAdaptiveItemSchedule } from "@jpgr/core";
import { sourcePolicy } from "@/lib/source-policy";
import { exactProductSourceConfig } from "@/lib/exact-product-watch";
import { keywordBaselineResetStatements } from "@jpgr/db";
import { intervalText, onOffText, profileChangeStatements, tokyoMinuteText, yenText } from "@/lib/profile-change-log";
import { bindingPatchUrlsMatchSource, sourceIdSchema, watchBindingPatchSchema } from "@jpgr/validation";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchBindingPatchSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const data = parsed.data;
  const id = await routeId(context);
  const env = getEnv();
  const binding = await env.DB.prepare(
    `SELECT b.watch_profile_id,b.source_id,b.kind,b.monitoring_purpose,b.query,b.search_url,b.target_url,
            b.source_config_json,b.enabled,b.schedule_interval_minutes,b.next_run_at,b.target_price,
            b.notify_new_listing,b.notify_price_drop,b.notify_price_rise,b.notify_restock,b.notify_sold_out,
            p.enabled profile_enabled,p.dossier_kind profile_dossier_kind,s.enabled source_enabled
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     JOIN source_registry s ON s.id=b.source_id WHERE b.id=?`,
  ).bind(id).first<{
    watch_profile_id: string;
    source_id: string;
    kind: "keyword" | "item";
    monitoring_purpose: "item_price" | "keyword_new_listing";
    query: string | null;
    search_url: string | null;
    target_url: string | null;
    source_config_json: string;
    schedule_interval_minutes: number;
    next_run_at: string;
    target_price: number | string | null;
    enabled: number;
    notify_new_listing: number;
    notify_price_drop: number;
    notify_price_rise: number;
    notify_restock: number;
    notify_sold_out: number;
    profile_enabled: number;
    profile_dossier_kind: "item" | "exact_product" | "keyword";
    source_enabled: number;
  }>();
  if (!binding) return apiError("watch_binding_not_found", 404);
  const itemScheduleSupported = supportsAdaptiveItemSchedule(binding);
  if (!itemScheduleSupported && (data.itemScheduleMode !== undefined || data.itemScheduleMaxMinutes !== undefined)) {
    return apiError("adaptive_schedule_requires_item_price_watch", 400);
  }
  const source = sourceIdSchema.safeParse(binding.source_id);
  if (!source.success) return apiError("binding_source_invalid", 409);
  if (!bindingPatchUrlsMatchSource(source.data, data)) return apiError("source_url_mismatch");
  const nextQuery = data.query !== undefined ? data.query : binding.query;
  const nextSearchUrl = data.searchUrl !== undefined ? data.searchUrl : binding.search_url;
  const nextTargetUrl = data.targetUrl !== undefined ? data.targetUrl : binding.target_url;
  if (binding.kind === "keyword" && !nextQuery && !nextSearchUrl) return apiError("keyword_binding_requires_query_or_url");
  if (binding.kind === "item" && !nextTargetUrl) return apiError("item_binding_requires_target_url");
  const nextPurpose = resolveMonitoringPurpose(binding.kind, data.monitoringPurpose ?? binding.monitoring_purpose);
  if (data.monitoringPurpose && data.monitoringPurpose !== nextPurpose) return apiError("monitoring_purpose_kind_mismatch");
  if (data.enabled === true && binding.enabled !== 1) {
    if (!binding.profile_enabled) return apiError("watch_profile_paused", 409);
    if (!binding.source_enabled) return apiError("source_disabled", 409);
    if (!(await sourcePolicy()).get(source.data)?.monitoringAllowed) return apiError("source_monitoring_not_allowed", 409);
  }
  const entries: [string, unknown][] = [];
  if (data.monitoringPurpose !== undefined) entries.push(["monitoring_purpose", nextPurpose]);
  if (data.query !== undefined) entries.push(["query", data.query]);
  if (data.searchUrl !== undefined) entries.push(["search_url", data.searchUrl]);
  if (data.targetUrl !== undefined) entries.push(["target_url", data.targetUrl]);
  if (data.intervalMinutes !== undefined) {
    entries.push(["interval_minutes", legacyIntervalMinutes(data.intervalMinutes)]);
    entries.push(["schedule_interval_minutes", data.intervalMinutes]);
  }
  if (data.nextRunAt !== undefined) entries.push(["next_run_at", data.nextRunAt]);
  let nextSourceConfig = data.sourceConfig === undefined
    ? undefined
    : binding.profile_dossier_kind === "exact_product"
      ? exactProductSourceConfig(data.sourceConfig)
      : data.sourceConfig;
  if (itemScheduleSupported) {
    const previousConfig = itemScheduleConfig(binding.source_config_json);
    const previousPolicy = itemSchedulePolicy(binding);
    const scheduleChanged = (data.intervalMinutes !== undefined && data.intervalMinutes !== binding.schedule_interval_minutes)
      || (data.itemScheduleMode !== undefined && data.itemScheduleMode !== previousPolicy.mode)
      || (data.itemScheduleMaxMinutes !== undefined && data.itemScheduleMaxMinutes !== previousPolicy.maxIntervalMinutes)
      || (data.nextRunAt !== undefined && data.nextRunAt !== binding.next_run_at);
    const interrupted = data.enabled !== undefined && Number(data.enabled) !== binding.enabled;
    const targetChanged = data.targetUrl !== undefined && data.targetUrl !== binding.target_url;
    if (nextSourceConfig !== undefined || scheduleChanged || interrupted || targetChanged) {
      // The caller can edit acquisition settings, but cannot supply scheduler history.
      nextSourceConfig = itemScheduleSourceConfig({
        ...(nextSourceConfig ?? previousConfig), itemSchedule: previousConfig.itemSchedule,
      }, { ...data, reset: scheduleChanged || interrupted || targetChanged || data.sourceConfig !== undefined });
    }
    if (scheduleChanged && data.nextRunAt === undefined) entries.push(["next_run_at", new Date().toISOString()]);
  }
  if (nextSourceConfig !== undefined) entries.push(["source_config_json", JSON.stringify(nextSourceConfig)]);
  if (data.targetPrice !== undefined) entries.push(["target_price", data.targetPrice]);
  if (data.minDropAmount !== undefined) entries.push(["min_drop_amount", data.minDropAmount]);
  const notificationPatchRequested = data.monitoringPurpose !== undefined
    || data.notifyNewListing !== undefined
    || data.notifyPriceDrop !== undefined
    || data.notifyPriceRise !== undefined
    || data.notifyRestock !== undefined
    || data.notifySoldOut !== undefined;
  if (notificationPatchRequested) {
    const purposeNotifications = notificationColumns(nextPurpose, {
      notifyNewListing: data.notifyNewListing ?? binding.notify_new_listing === 1,
      notifyPriceDrop: data.notifyPriceDrop ?? binding.notify_price_drop === 1,
      notifyPriceRise: data.notifyPriceRise ?? binding.notify_price_rise === 1,
      notifyRestock: data.notifyRestock ?? binding.notify_restock === 1,
      notifySoldOut: data.notifySoldOut ?? binding.notify_sold_out === 1,
    }, { exactProduct: binding.profile_dossier_kind === "exact_product", sourceId: binding.source_id });
    entries.push(
      ["notify_new_listing", purposeNotifications.notifyNewListing],
      ["notify_price_drop", purposeNotifications.notifyPriceDrop],
      ["notify_price_rise", purposeNotifications.notifyPriceRise],
      ["notify_restock", purposeNotifications.notifyRestock],
      ["notify_sold_out", purposeNotifications.notifySoldOut],
    );
  }
  if (data.enabled !== undefined) entries.push(["enabled", data.enabled ? 1 : 0]);
  if (data.enabled === true && binding.enabled !== 1) {
    entries.push(["next_run_at", new Date().toISOString()], ["cooldown_until", null]);
  }
  // 只改频率、没指定下次时间：原定的下次巡回照旧，只是不能比「从现在起一个新周期」更晚。
  // 以前这里一律改成「现在」，每点一次保存就当场全来源多跑一轮、多发一封日报（2026-10-16 加藤惠）。
  if (data.intervalMinutes !== undefined && data.intervalMinutes !== binding.schedule_interval_minutes
    && data.nextRunAt === undefined && !itemScheduleSupported) {
    const soonest = Date.now() + data.intervalMinutes * 60_000;
    if (!(Date.parse(binding.next_run_at) <= soonest)) entries.push(["next_run_at", new Date(soonest).toISOString()]);
  }
  if (!entries.length) return apiError("empty_patch");
  const deduplicated = [...new Map(entries).entries()] as [string, unknown][];
  const now = new Date().toISOString();
  deduplicated.push(["updated_at", now]);
  const searchRulesChanged = binding.kind === "keyword" && (
    (data.query !== undefined && data.query !== binding.query)
    || (data.searchUrl !== undefined && data.searchUrl !== binding.search_url)
    || (nextSourceConfig !== undefined && JSON.stringify(nextSourceConfig) !== binding.source_config_json)
    || (data.monitoringPurpose !== undefined && nextPurpose !== binding.monitoring_purpose)
  );
  const resetKeywordBaseline = searchRulesChanged && binding.profile_dossier_kind === "keyword";
  const changeSource = { sourceId: binding.source_id };
  const changes = profileChangeStatements(env.DB, binding.watch_profile_id, [
    ...(data.query !== undefined ? [{ ...changeSource, field: "query" as const, before: binding.query, after: data.query }] : []),
    ...(data.intervalMinutes !== undefined ? [{ ...changeSource, field: "interval" as const, before: intervalText(binding.schedule_interval_minutes), after: intervalText(data.intervalMinutes) }] : []),
    ...(data.nextRunAt !== undefined ? [{ ...changeSource, field: "next_run_at" as const, before: tokyoMinuteText(binding.next_run_at), after: tokyoMinuteText(data.nextRunAt) }] : []),
    ...(data.enabled !== undefined ? [{ ...changeSource, field: "source_enabled" as const, before: onOffText(binding.enabled, "巡回中", "已暂停"), after: onOffText(data.enabled, "巡回中", "已暂停") }] : []),
    ...(data.targetPrice !== undefined ? [{ ...changeSource, field: "target_price" as const, before: yenText(binding.target_price), after: yenText(data.targetPrice) }] : []),
    ...(binding.profile_dossier_kind === "exact_product" && nextSourceConfig !== undefined
      && JSON.stringify(nextSourceConfig) !== binding.source_config_json
      ? [{ ...changeSource, field: "product_target" as const, before: "原条件", after: "已修改" }] : []),
  ], now);
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE watch_bindings SET ${deduplicated.map(([column]) => `${column}=?`).join(",")} WHERE id=?`)
      .bind(...deduplicated.map(([, value]) => value), id),
    ...(resetKeywordBaseline ? keywordBaselineResetStatements(env.DB, {
      profileId: binding.watch_profile_id,
      bindingId: id,
      resetAt: now,
    }) : []),
    ...changes,
  ]);
  return result?.meta.changes
    ? Response.json({ updated: true, baselineReset: resetKeywordBaseline })
    : apiError("watch_binding_not_found", 404);
}

export async function DELETE(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const result = await getEnv().DB.prepare("DELETE FROM watch_bindings WHERE id=?").bind(await routeId(context)).run();
  return result.meta.changes ? Response.json({ deleted: true }) : apiError("watch_binding_not_found", 404);
}
