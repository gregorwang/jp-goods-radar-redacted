import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { keywordBaselineResetStatements } from "@jpgr/db";
import { watchProfilePatchSchema } from "@jpgr/validation";
import { watchLifecycle, type WatchCompletionEventRow } from "@/lib/watch-lifecycle";
import { relevancePatchExpandsScope } from "@/lib/watch-profile-scope";
import { resetItemScheduleForProfile } from "@/lib/monitoring";
import { onOffText, profileChangeStatements, termsText, yenText } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const [profileResult, bindingsResult, runsResult, completionResult] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT * FROM watch_profiles WHERE id=?").bind(id),
    env.DB.prepare(
      `SELECT b.*,s.display_name,s.health_status,s.credential_status,l.id listing_id,
       (SELECT COUNT(*) FROM watch_listing_matches m WHERE m.watch_binding_id=b.id) matched_listing_count
       FROM watch_bindings b JOIN source_registry s ON s.id=b.source_id
       LEFT JOIN listings l ON b.kind='item'
        AND l.source_id=b.source_id AND l.source_item_id=b.source_item_id
       WHERE b.watch_profile_id=? ORDER BY b.created_at`,
    ).bind(id),
    env.DB.prepare(
      `SELECT * FROM (
         SELECT r.*,ROW_NUMBER() OVER (
           PARTITION BY r.watch_binding_id ORDER BY r.started_at DESC
         ) history_rank
         FROM watch_runs r JOIN watch_bindings b ON b.id=r.watch_binding_id
         WHERE b.watch_profile_id=?
       ) ranked
       WHERE history_rank<=1
       ORDER BY watch_binding_id,started_at DESC`,
    ).bind(id),
    env.DB.prepare(
      `SELECT watch_profile_id,payload_json,created_at FROM events
       WHERE watch_profile_id=? AND COALESCE(semantic_event_type,event_type)='watch_completed'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).bind(id),
  ]);
  const rawProfile = profileResult?.results[0] ?? null;
  const profile = rawProfile ? (() => {
    const activeBindingCount = (bindingsResult?.results ?? []).filter((row) => Number(row.enabled) === 1).length;
    const lifecycle = watchLifecycle({
      enabled: Number(rawProfile.enabled),
      activeBindingCount,
      bindingCount: bindingsResult?.results.length ?? 0,
      completion: completionResult?.results[0] as unknown as WatchCompletionEventRow | undefined,
    });
    return { ...rawProfile, lifecycle_status: lifecycle.status, lifecycle_reason: lifecycle.reason };
  })() : null;
  if (!profile) return apiError("watch_profile_not_found", 404);

  const runs = (runsResult?.results ?? []).reduce<Record<string, Record<string, unknown>[]>>((grouped, row) => {
    const bindingId = typeof row.watch_binding_id === "string" ? row.watch_binding_id : "";
    if (!bindingId) return grouped;
    (grouped[bindingId] ??= []).push(row);
    return grouped;
  }, {});
  return Response.json({ profile, bindings: bindingsResult?.results ?? [], runs });
}

export async function PATCH(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchProfilePatchSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const id = await routeId(context);
  const env = getEnv();
  const [current, archived] = await Promise.all([
    env.DB.prepare(
      "SELECT dossier_kind,include_terms_json,exclude_terms_json,min_listing_price,enabled FROM watch_profiles WHERE id=?",
    ).bind(id).first<{
      dossier_kind: "item" | "exact_product" | "keyword";
      include_terms_json: string;
      exclude_terms_json: string;
      min_listing_price: number | string | null;
      enabled: number | string;
    }>(),
    env.DB.prepare(
      `SELECT id FROM events WHERE watch_profile_id=?
       AND COALESCE(semantic_event_type,event_type)='watch_completed'
       AND payload_json LIKE '%\"kind\":\"user_purchased\"%' LIMIT 1`,
    ).bind(id).first<{ id: string }>(),
  ]);
  if (!current) return apiError("watch_profile_not_found", 404);
  const entries: [string, unknown][] = [];
  const data = parsed.data;
  if (data.enabled === true && archived) return apiError("watch_profile_archived", 409);
  if (data.name !== undefined) entries.push(["name", data.name]);
  if (data.description !== undefined) entries.push(["description", data.description || null]);
  if (data.defaultMaxPrice !== undefined) entries.push(["default_max_price", data.defaultMaxPrice]);
  if (data.minListingPrice !== undefined) entries.push(["min_listing_price", data.minListingPrice || null]);
  if (data.includeTerms !== undefined) entries.push(["include_terms_json", JSON.stringify(data.includeTerms)]);
  if (data.excludeTerms !== undefined) entries.push(["exclude_terms_json", JSON.stringify(data.excludeTerms)]);
  if (data.enabled !== undefined) entries.push(["enabled", data.enabled ? 1 : 0]);
  if (!entries.length) return apiError("empty_patch");
  const now = new Date().toISOString();
  entries.push(["updated_at", now]);
  const relevanceRulesChanged = (data.includeTerms !== undefined
      && JSON.stringify(data.includeTerms) !== current.include_terms_json)
    || (data.excludeTerms !== undefined
      && JSON.stringify(data.excludeTerms) !== current.exclude_terms_json);
  const relevanceScopeExpanded = current.dossier_kind === "keyword" && relevanceRulesChanged && relevancePatchExpandsScope({
    currentIncludeTermsJson: current.include_terms_json,
    currentExcludeTermsJson: current.exclude_terms_json,
    ...(data.includeTerms === undefined ? {} : { nextIncludeTerms: data.includeTerms }),
    ...(data.excludeTerms === undefined ? {} : { nextExcludeTerms: data.excludeTerms }),
  });
  const statements = [
    env.DB.prepare(`UPDATE watch_profiles SET ${entries.map(([column]) => `${column}=?`).join(",")} WHERE id=?`)
      .bind(...entries.map(([, value]) => value), id),
    ...(relevanceScopeExpanded ? keywordBaselineResetStatements(env.DB, { profileId: id, resetAt: now }) : []),
    ...profileChangeStatements(env.DB, id, [
      ...(data.includeTerms !== undefined ? [{ field: "include_terms" as const, before: termsText(current.include_terms_json), after: termsText(data.includeTerms) }] : []),
      ...(data.excludeTerms !== undefined ? [{ field: "exclude_terms" as const, before: termsText(current.exclude_terms_json), after: termsText(data.excludeTerms) }] : []),
      ...(data.minListingPrice !== undefined ? [{ field: "min_listing_price" as const, before: yenText(current.min_listing_price), after: yenText(data.minListingPrice || null) }] : []),
      ...(data.enabled !== undefined ? [{ field: "profile_enabled" as const, before: onOffText(current.enabled, "巡回中", "已暂停"), after: onOffText(data.enabled, "巡回中", "已暂停") }] : []),
    ], now),
  ];
  if (data.enabled === false) {
    statements.push(resetItemScheduleForProfile(env.DB, id));
    statements.push(env.DB.prepare("UPDATE watch_bindings SET enabled=0,updated_at=? WHERE watch_profile_id=?")
      .bind(now, id));
  }
  await env.DB.batch(statements);
  return Response.json({ updated: true, baselineReset: relevanceScopeExpanded });
}

export async function DELETE(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const result = await getEnv().DB.prepare("DELETE FROM watch_profiles WHERE id=?").bind(await routeId(context)).run();
  return result.meta.changes ? Response.json({ deleted: true }) : apiError("watch_profile_not_found", 404);
}
