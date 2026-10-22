import { digestItemLabelSchema } from "@jpgr/validation";
import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { deviceUnauthorized, ownerPushProfileIds } from "@/lib/device-auth";
import { keywordProfile, saveDigestLabel } from "@/lib/digest-labels";
import { DIGEST_WINDOW_DAYS, recentDigestItems } from "@/lib/inbox-feed";

/**
 * 手机 App 的列表标注（2026-10-12 用户要的：一个列表、每行旁边点一下，不要一件一件翻；只有「不想看」）。
 * GET：推送档案最近 DIGEST_WINDOW_DAYS 天送达的日报里逐件出现过的商品，同一件只出现一次（取最新那封），
 *      带上已有结论（查询和主站收件箱共用 lib/inbox-feed.ts）。POST：写一条结论，和主站标注页同一份写法（lib/digest-labels.ts）。
 */
const MAX_ROWS = 1500;

export async function GET(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const profileIds = await ownerPushProfileIds();
  if (profileIds.length === 0) return privateJson({ windowDays: DIGEST_WINDOW_DAYS, profiles: [], items: [] });
  const [profiles, items] = await Promise.all([
    getEnv().DB.prepare(
      "SELECT id,name FROM watch_profiles WHERE id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY name",
    ).bind(JSON.stringify(profileIds)).all<{ id: string; name: string }>(),
    recentDigestItems(profileIds, MAX_ROWS),
  ]);
  return privateJson({ windowDays: DIGEST_WINDOW_DAYS, profiles: profiles.results, items });
}

const deviceLabelSchema = digestItemLabelSchema.extend({ profileId: z.string().min(1).max(100) });

export async function POST(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = deviceLabelSchema.safeParse(body.value);
  if (!parsed.success) return privateJson({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  // App 上的标注只有「不想看」一种（2026-10-12 用户定：想看 / 不想看两套会互相打架）；没点就是可以留。
  if (parsed.data.verdict === "keep") return apiError("device_labels_hide_only", 400);
  if (!(await ownerPushProfileIds()).includes(parsed.data.profileId)) return apiError("watch_profile_not_found", 404);
  const profile = await keywordProfile(parsed.data.profileId);
  if (profile instanceof Response) return profile;
  const failed = await saveDigestLabel(parsed.data);
  return failed ?? privateJson({ updated: true });
}
