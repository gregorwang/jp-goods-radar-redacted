import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const result = await getEnv().DB.prepare(
    "UPDATE events SET status='suppressed' WHERE id=? AND status IN ('pending','failed')",
  ).bind(await routeId(context)).run();
  return result.meta.changes ? Response.json({ suppressed: true }) : apiError("event_not_suppressible", 409);
}
