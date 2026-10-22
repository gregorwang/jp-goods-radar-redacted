import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const test = await env.COLLECTOR.fetch(`http://collector/internal/test-source/${encodeURIComponent(id)}`, { method: "POST" });
  if (!test.ok) return new Response(test.body, { status: test.status, headers: { "Content-Type": "application/json" } });
  const source = await env.DB.prepare("SELECT transport FROM source_registry WHERE id=?").bind(id).first<{ transport: string }>();
  if (!source) return apiError("source_not_found", 404);
  if (source.transport === "internal_api" || source.transport === "html_endpoint") {
    const probe = await env.COLLECTOR.fetch(`http://collector/internal/start-probe/${encodeURIComponent(id)}`, { method: "POST" });
    if (!probe.ok) return new Response(probe.body, { status: probe.status, headers: { "Content-Type": "application/json" } });
  }
  const result = await env.DB.prepare("UPDATE source_registry SET enabled=1,health_status='healthy',updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), id).run();
  return result.meta.changes ? Response.json({ enabled: true, probeStarted: source.transport !== "official_api" }) : apiError("source_not_found", 404);
}
