import { digestItemLabelSchema } from "@jpgr/validation";
import { denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { keywordProfile, saveDigestLabel } from "@/lib/digest-labels";

type Context = { params: Promise<{ id: string }> };

/** 收件箱「推给我的」那一栏的「不想看」/ 撤销。列表本身由 /api/inbox 给。 */
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = digestItemLabelSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const profile = await keywordProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const failed = await saveDigestLabel({ profileId: profile.id, ...parsed.data });
  return failed ?? Response.json({ updated: true });
}
