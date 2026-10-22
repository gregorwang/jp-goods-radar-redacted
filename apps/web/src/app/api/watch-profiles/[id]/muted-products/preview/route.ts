import { normalizeMutedProductTermGroups } from "@jpgr/core";
import { mutedProductPreviewSchema } from "@jpgr/validation";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import {
  MUTED_PRODUCT_EXAMPLE_LIMIT,
  listingsMatching,
  mutedProductProfile,
  recentProfileListings,
} from "@/lib/muted-products";

type Context = { params: Promise<{ id: string }> };

/**
 * 保存之前先预演：过去 30 天这个档案采到的商品里，这组词会挡掉哪些。
 * 和采集侧用同一个匹配函数（mutedProductTitleMatches），页面上说挡掉几件，采集时就挡掉几件。
 * 用 POST 只是为了带词组；它不写任何东西。
 */
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = mutedProductPreviewSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const profile = await mutedProductProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const termGroups = normalizeMutedProductTermGroups(parsed.data.termGroups);
  if (termGroups.length === 0) return apiError("muted_product_terms_required");
  const recent = await recentProfileListings(profile.id);
  const matched = listingsMatching(recent, termGroups);
  return Response.json({
    recentTotal: recent.length,
    matchedTotal: matched.length,
    examples: matched.slice(0, MUTED_PRODUCT_EXAMPLE_LIMIT),
  });
}
