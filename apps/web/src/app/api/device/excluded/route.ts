import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { deviceUnauthorized, ownerPushProfileIds } from "@/lib/device-auth";
import { EXCLUDED_WINDOW_DAYS, recentExcludedItems, setExcludedWanted } from "@/lib/inbox-feed";

/**
 * 手机 App「被筛掉的」：推送档案里被排除词挡掉、没进推送的商品（2026-10-12 用户要的——加了排除词又怕漏，
 * 一天或一星期回头扫一眼）。查询和「挡错了」的写法跟主站收件箱共用 lib/inbox-feed.ts。
 *
 * POST：「其实想要」——记成一条「还想看」标注（digest_item_labels，不挂日报），
 * 说明这条排除词挡错了东西，之后据此收窄规则。
 */
const MAX_ROWS = 800;

export async function GET(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const profileIds = await ownerPushProfileIds();
  if (profileIds.length === 0) return privateJson({ windowDays: EXCLUDED_WINDOW_DAYS, profiles: [], items: [] });
  const [profiles, items] = await Promise.all([
    getEnv().DB.prepare(
      "SELECT id,name FROM watch_profiles WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY name",
    ).bind(JSON.stringify(profileIds)).all<{ id: string; name: string }>(),
    recentExcludedItems(profileIds, MAX_ROWS),
  ]);
  return privateJson({ windowDays: EXCLUDED_WINDOW_DAYS, profiles: profiles.results, items });
}

const wantSchema = z.object({
  profileId: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(300),
  wanted: z.boolean(),
}).strict();

export async function POST(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = wantSchema.safeParse(body.value);
  if (!parsed.success) return privateJson({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;
  if (!(await ownerPushProfileIds()).includes(input.profileId)) return apiError("watch_profile_not_found", 404);
  const failed = await setExcludedWanted(input);
  return failed ?? privateJson({ wanted: input.wanted });
}
