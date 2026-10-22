import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { sourcePolicy } from "@/lib/source-policy";
import { profileChangeStatements } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const [binding, policy] = await Promise.all([env.DB.prepare(
    `SELECT b.enabled,b.source_id,b.watch_profile_id,p.enabled profile_enabled,s.enabled source_enabled FROM watch_bindings b
     JOIN watch_profiles p ON p.id=b.watch_profile_id JOIN source_registry s ON s.id=b.source_id WHERE b.id=?`,
  ).bind(id).first<{ enabled: number; source_id: string; watch_profile_id: string; profile_enabled: number; source_enabled: number }>(),
  sourcePolicy()]);
  if (!binding) return apiError("watch_binding_not_found", 404);
  if (!binding.profile_enabled) return apiError("watch_profile_paused", 409);
  if (!binding.source_enabled) return apiError("source_disabled", 409);
  if (!policy.get(binding.source_id)?.monitoringAllowed) return apiError("source_monitoring_not_allowed", 409);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE watch_bindings SET enabled=1,next_run_at=?,cooldown_until=NULL,updated_at=? WHERE id=?")
      .bind(now, now, id),
    ...profileChangeStatements(env.DB, binding.watch_profile_id, [{
      field: "source_enabled", sourceId: binding.source_id,
      before: Number(binding.enabled) === 1 ? "巡回中" : "已暂停", after: "巡回中",
    }], now),
  ]);
  return Response.json({ resumed: true });
}
