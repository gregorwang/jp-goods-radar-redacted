import { watchCandidateDismissalSchema } from "@jpgr/validation";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };

/** 「疑似同款」分区的收敛出口。默认的送达门槛（confirmed_only）下这个分区
 *  根本不会出现；但用户把门槛放宽到 strong_suspects / all_suspects 后，未确认候选
 *  就会进邮件，而其中 probable_exact 一档每轮都重新出现（故意如此，否则存量真品
 *  永远埋在里面）。那就必须给用户一个说"我看过了"的地方，否则就成了重复打扰。 */
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const env = getEnv();
  const bindingId = await routeId(context);
  const result = await env.DB.prepare(
    `SELECT source_id,source_item_id,reason,created_at
     FROM watch_dismissed_candidates WHERE watch_binding_id=?
     ORDER BY created_at DESC LIMIT 500`,
  ).bind(bindingId).all();
  return Response.json({ items: result.results });
}

export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = watchCandidateDismissalSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  }
  const bindingId = await routeId(context);
  const env = getEnv();
  const binding = await env.DB.prepare(
    `SELECT b.id,b.source_id,p.dossier_kind FROM watch_bindings b
     JOIN watch_profiles p ON p.id=b.watch_profile_id WHERE b.id=?`,
  ).bind(bindingId).first<{ id: string; source_id: string; dossier_kind: string }>();
  if (!binding) return apiError("watch_binding_not_found", 404);
  // 关键词档案没有「疑似同款」这个概念，标掉在那里只会变成隐形的过滤器。
  if (binding.dossier_kind !== "exact_product") return apiError("candidate_dismissal_requires_exact_product", 409);

  const { sourceId, sourceItemId, reason } = parsed.data;
  if (sourceId !== binding.source_id) return apiError("source_does_not_belong_to_binding", 409);

  if (reason === "restore") {
    await env.DB.prepare(
      "DELETE FROM watch_dismissed_candidates WHERE watch_binding_id=? AND source_id=? AND source_item_id=?",
    ).bind(bindingId, sourceId, sourceItemId).run();
    return Response.json({ updated: true, dismissal: null });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO watch_dismissed_candidates(watch_binding_id,source_id,source_item_id,reason,created_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT (watch_binding_id,source_id,source_item_id)
     DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at`,
  ).bind(bindingId, sourceId, sourceItemId, reason, now).run();
  return Response.json({ updated: true, dismissal: { sourceId, sourceItemId, reason, createdAt: now } });
}
