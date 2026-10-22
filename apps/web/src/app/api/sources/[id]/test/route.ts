import { denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const response = await getEnv().COLLECTOR.fetch(
    `http://collector/internal/test-source/${encodeURIComponent(await routeId(context))}`,
    { method: "POST" },
  );
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
}
