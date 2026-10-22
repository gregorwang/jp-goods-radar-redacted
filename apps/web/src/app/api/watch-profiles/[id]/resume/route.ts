import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { sourcePolicy } from "@/lib/source-policy";
import { planWatchProfileResume } from "@/lib/watch-profile-resume";
import { resetItemScheduleForProfile } from "@/lib/monitoring";
import { profileChangeStatements } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };

interface ResumeBindingRow {
  id: string;
  source_id: string;
  enabled: number;
}

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const [profile, bindingsResult, policy, completion] = await Promise.all([
    env.DB.prepare("SELECT id,enabled FROM watch_profiles WHERE id=?").bind(id).first<{ id: string; enabled: number | string }>(),
    env.DB.prepare(
      "SELECT id,source_id,enabled FROM watch_bindings WHERE watch_profile_id=? ORDER BY created_at,id",
    ).bind(id).all<ResumeBindingRow>(),
    sourcePolicy(),
    env.DB.prepare(
      `SELECT payload_json FROM events WHERE watch_profile_id=?
       AND COALESCE(semantic_event_type,event_type)='watch_completed'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).bind(id).first<{ payload_json: string }>(),
  ]);
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (completion) return apiError("watch_profile_completed", 409);
  if (bindingsResult.results.length === 0) return apiError("watch_profile_has_no_bindings", 409);

  const plan = planWatchProfileResume(
    bindingsResult.results.map((binding) => ({
      id: binding.id,
      sourceId: binding.source_id,
      enabled: binding.enabled === 1,
    })),
    policy,
  );
  if (plan.resumeIds.length === 0 && plan.alreadyActiveCount === 0) {
    return apiError("no_resumable_sources", 409);
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE watch_profiles SET enabled=1,updated_at=? WHERE id=?").bind(now, id),
    ...(plan.resumeIds.length > 0 ? [resetItemScheduleForProfile(env.DB, id, true)] : []),
    ...plan.resumeIds.map((bindingId) => env.DB.prepare(
      "UPDATE watch_bindings SET enabled=1,next_run_at=?,cooldown_until=NULL,updated_at=? WHERE id=? AND watch_profile_id=?",
    ).bind(now, now, bindingId, id)),
    ...profileChangeStatements(env.DB, id, [
      { field: "profile_enabled", before: Number(profile.enabled) === 1 ? "巡回中" : "已暂停", after: "巡回中" },
      ...plan.resumeIds.map((bindingId) => ({
        field: "source_enabled" as const,
        sourceId: bindingsResult.results.find((binding) => binding.id === bindingId)?.source_id ?? null,
        before: "已暂停",
        after: "巡回中",
      })),
    ], now),
  ]);
  return Response.json({
    resumedBindings: plan.resumeIds.length,
    alreadyActiveBindings: plan.alreadyActiveCount,
    skippedBindings: plan.skipped,
  });
}
