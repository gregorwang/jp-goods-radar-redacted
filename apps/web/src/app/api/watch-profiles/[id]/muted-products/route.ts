import {
  MUTED_PRODUCT_LIMIT_PER_PROFILE,
  mutedProductLabel,
  mutedProductTitleTokens,
  normalizeMutedProductTermGroups,
  parseMutedProductTermGroups,
} from "@jpgr/core";
import { mutedProductCreateSchema } from "@jpgr/validation";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import {
  MUTED_PRODUCT_WINDOW_DAYS,
  listingsMatching,
  mutedProductProfile,
  recentProfileListings,
} from "@/lib/muted-products";

type Context = { params: Promise<{ id: string }> };

interface RuleRow {
  id: string;
  term_groups_json: string;
  sample_title: string | null;
  sample_url: string | null;
  sample_image_url: string | null;
  created_at: string;
}

function stringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 屏蔽单品页的数据：已经屏蔽的商品（各自过去 30 天挡掉多少件），
 * 以及从邮件点进来时那件商品本身（标题切成可点选的词）。
 */
export async function GET(request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const profile = await mutedProductProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const env = getEnv();
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("source");
  const sourceItemId = url.searchParams.get("item");

  const [rules, recent, sampleRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id,term_groups_json,sample_title,sample_url,sample_image_url,created_at
       FROM watch_profile_muted_products WHERE watch_profile_id=? ORDER BY created_at DESC`,
    ).bind(profile.id).all<RuleRow>(),
    recentProfileListings(profile.id),
    sourceId && sourceItemId
      ? env.DB.prepare(
        `SELECT l.source_id,s.display_name source_name,l.title,l.canonical_url,l.image_url,l.current_price
         FROM listings l LEFT JOIN source_registry s ON s.id=l.source_id
         WHERE l.source_id=? AND l.source_item_id=?`,
      ).bind(sourceId, sourceItemId).first<{
        source_id: string;
        source_name: string | null;
        title: string;
        canonical_url: string;
        image_url: string | null;
        current_price: number | string | null;
      }>()
      : Promise.resolve(null),
  ]);

  const ignore = [profile.query ?? "", ...stringArray(profile.include_terms_json)].filter(Boolean);
  return Response.json({
    profile: { id: profile.id, name: profile.name },
    windowDays: MUTED_PRODUCT_WINDOW_DAYS,
    recentTotal: recent.length,
    limit: MUTED_PRODUCT_LIMIT_PER_PROFILE,
    rules: rules.results.map((row) => {
      const termGroups = parseMutedProductTermGroups(row.term_groups_json);
      return {
        id: row.id,
        termGroups,
        label: mutedProductLabel(termGroups),
        sample: row.sample_title
          ? { title: row.sample_title, url: row.sample_url, imageUrl: row.sample_image_url }
          : null,
        createdAt: row.created_at,
        recentHits: listingsMatching(recent, termGroups).length,
      };
    }),
    sample: sampleRow ? {
      sourceName: sampleRow.source_name ?? sampleRow.source_id,
      title: sampleRow.title,
      url: sampleRow.canonical_url,
      imageUrl: sampleRow.image_url,
      price: sampleRow.current_price === null ? null : Number(sampleRow.current_price),
      tokens: mutedProductTitleTokens(sampleRow.title, ignore),
    } : null,
  });
}

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = mutedProductCreateSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const profile = await mutedProductProfile(await routeId(context));
  if (profile instanceof Response) return profile;
  const termGroups = normalizeMutedProductTermGroups(parsed.data.termGroups);
  if (termGroups.length === 0) return apiError("muted_product_terms_required");
  const env = getEnv();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) total FROM watch_profile_muted_products WHERE watch_profile_id=?",
  ).bind(profile.id).first<{ total: number | string }>();
  if (Number(count?.total ?? 0) >= MUTED_PRODUCT_LIMIT_PER_PROFILE) return apiError("muted_product_limit_reached", 409);

  const id = crypto.randomUUID();
  const sample = parsed.data.sample;
  await env.DB.prepare(
    `INSERT INTO watch_profile_muted_products(id,watch_profile_id,term_groups_json,sample_title,sample_url,sample_image_url,created_at)
     VALUES(?,?,?,?,?,?,?)`,
  ).bind(
    id,
    profile.id,
    JSON.stringify(termGroups),
    sample?.title ?? null,
    sample?.url ?? null,
    sample?.imageUrl ?? null,
    new Date().toISOString(),
  ).run();
  return Response.json({ id, termGroups, label: mutedProductLabel(termGroups) });
}

export async function DELETE(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const profileId = await routeId(context);
  const ruleId = new URL(request.url).searchParams.get("rule");
  if (!ruleId) return apiError("muted_product_rule_required");
  const result = await getEnv().DB.prepare(
    "DELETE FROM watch_profile_muted_products WHERE id=? AND watch_profile_id=?",
  ).bind(ruleId, profileId).run();
  if (Number(result.meta.changes ?? 0) === 0) return apiError("muted_product_not_found", 404);
  return Response.json({ deleted: true });
}
