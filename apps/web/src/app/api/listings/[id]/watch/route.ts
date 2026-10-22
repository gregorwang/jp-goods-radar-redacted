import { denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { createListingWatch } from "@/lib/listing-watch";
import { listingWatchOptionsSchema } from "@jpgr/validation";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = listingWatchOptionsSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  return createListingWatch(await routeId(context), parsed.data);
}
