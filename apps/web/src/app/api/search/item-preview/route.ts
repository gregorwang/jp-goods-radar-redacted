import { denyMutation } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { previewListingDetailSchema } from "@jpgr/validation";

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = previewListingDetailSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const response = await getEnv().COLLECTOR.fetch("http://collector/internal/listing-detail-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
