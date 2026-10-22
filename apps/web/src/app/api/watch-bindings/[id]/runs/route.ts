import { unauthorized } from "@/lib/api-auth";
import { routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const result = await getEnv().DB.prepare(
    "SELECT * FROM watch_runs WHERE watch_binding_id=? ORDER BY started_at DESC LIMIT 100",
  ).bind(await routeId(context)).all();
  return Response.json({ items: result.results });
}
