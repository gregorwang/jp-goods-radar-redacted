import { z } from "zod";
import { denyMutation, readJsonBody } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { keywordProfile } from "@/lib/digest-labels";
import { setExcludedWanted } from "@/lib/inbox-feed";

/** 收件箱「排除词挡掉的」那一栏的「挡错了」，和手机 App 同一份写法（lib/inbox-feed.ts）。 */
const wantSchema = z.object({
  profileId: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(300),
  wanted: z.boolean(),
}).strict();

export async function POST(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = wantSchema.safeParse(body.value);
  if (!parsed.success) return privateJson({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const profile = await keywordProfile(parsed.data.profileId);
  if (profile instanceof Response) return profile;
  const failed = await setExcludedWanted(parsed.data);
  return failed ?? privateJson({ wanted: parsed.data.wanted });
}
