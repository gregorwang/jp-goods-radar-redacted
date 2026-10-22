import { denyMutation } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const response = await getEnv().COLLECTOR.fetch("http://collector/internal/qualify-p0", { method: "POST" });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
}
