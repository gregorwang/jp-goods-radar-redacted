import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const binding = await env.DB.prepare(
    `SELECT b.id,b.enabled,p.enabled profile_enabled,s.enabled source_enabled
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id JOIN source_registry s ON s.id=b.source_id
     WHERE b.id=?`,
  ).bind(id).first<{ id: string; enabled: number; profile_enabled: number; source_enabled: number }>();
  if (!binding) return apiError("watch_binding_not_found", 404);
  if (!binding.enabled || !binding.profile_enabled || !binding.source_enabled) return apiError("watch_binding_paused", 409);
  const response = await env.COLLECTOR.fetch(`http://collector/internal/run/${encodeURIComponent(id)}`, { method: "POST" });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
}
