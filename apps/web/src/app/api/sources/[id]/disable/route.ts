import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const now = new Date().toISOString();
  const [source] = await env.DB.batch([
    env.DB.prepare("UPDATE source_registry SET enabled=0,health_status='disabled',updated_at=? WHERE id=?").bind(now, id),
    env.DB.prepare("UPDATE watch_bindings SET enabled=0,updated_at=? WHERE source_id=?").bind(now, id),
  ]);
  return source?.meta.changes ? Response.json({ disabled: true }) : apiError("source_not_found", 404);
}
