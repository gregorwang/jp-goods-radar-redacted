import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const result = await env.DB.prepare(
    "UPDATE events SET status='pending',sent_at=NULL WHERE id=? AND status='failed'",
  ).bind(id).run();
  if (!result.meta.changes) return apiError("event_not_retryable", 409);
  return Response.json({ queued: true });
}
