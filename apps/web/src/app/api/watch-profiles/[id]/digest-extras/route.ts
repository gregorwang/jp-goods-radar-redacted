import {
  DIGEST_EXTRAS_DEFAULTS_FLAG,
  digestExtrasFromColumns,
  digestExtrasFromDefaultsConfig,
} from "@jpgr/core";
import { digestExtrasUpdateSchema } from "@jpgr/validation";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { DIGEST_PRICE_REFERENCE_TEXT, onOffText, profileChangeStatements } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };

interface ProfileRow {
  dossier_kind: string;
  digest_price_reference: string | null;
  digest_show_sales: number | string | null;
}

/**
 * 关键词日报附带哪几样价格参考（packages/core/src/digest-extras.ts）。
 * 只有关键词档案有日报补充信息，精确同款、单品档案不适用。
 */
async function keywordProfile(id: string): Promise<ProfileRow | Response> {
  const profile = await getEnv().DB.prepare(
    "SELECT dossier_kind,digest_price_reference,digest_show_sales FROM watch_profiles WHERE id=?",
  ).bind(id).first<ProfileRow>();
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (profile.dossier_kind !== "keyword") return apiError("digest_extras_keyword_only", 409);
  return profile;
}

async function readState(id: string, profile: ProfileRow) {
  const env = getEnv();
  const [defaults, keywordCount] = await Promise.all([
    env.DB.prepare("SELECT config_json FROM runtime_feature_flags WHERE flag_key=?")
      .bind(DIGEST_EXTRAS_DEFAULTS_FLAG).first<{ config_json: string }>(),
    env.DB.prepare("SELECT COUNT(*) total FROM watch_profiles WHERE dossier_kind='keyword'")
      .first<{ total: number | string }>(),
  ]);
  return {
    profileId: id,
    current: digestExtrasFromColumns(profile.digest_price_reference, profile.digest_show_sales),
    defaults: digestExtrasFromDefaultsConfig(defaults?.config_json),
    keywordProfileCount: Number(keywordCount?.total ?? 0),
  };
}

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const profile = await keywordProfile(id);
  if (profile instanceof Response) return profile;
  return Response.json(await readState(id, profile));
}

export async function PUT(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = digestExtrasUpdateSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const id = await routeId(context);
  const profile = await keywordProfile(id);
  if (profile instanceof Response) return profile;
  const env = getEnv();
  const { priceReference, showSales, applyTo, saveAsDefault } = parsed.data;
  const now = new Date().toISOString();
  // 不动 updated_at：这是邮件的排版设置，不改搜索范围，不该让档案在列表里跳到最前面。
  const statements = [
    applyTo === "all_keyword"
      ? env.DB.prepare(
          "UPDATE watch_profiles SET digest_price_reference=?,digest_show_sales=? WHERE dossier_kind='keyword'",
        ).bind(priceReference, showSales ? 1 : 0)
      : env.DB.prepare(
          "UPDATE watch_profiles SET digest_price_reference=?,digest_show_sales=? WHERE id=?",
        ).bind(priceReference, showSales ? 1 : 0, id),
    ...(saveAsDefault ? [env.DB.prepare(
      `INSERT INTO runtime_feature_flags(flag_key,enabled,config_json,updated_at) VALUES(?,1,?,?)
       ON CONFLICT(flag_key) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`,
    ).bind(DIGEST_EXTRAS_DEFAULTS_FLAG, JSON.stringify({ schemaVersion: 1, priceReference, showSales }), now)] : []),
    // 「应用到全部」时只记在点按钮的这个档案上：别的档案的记录里凭空多一行，反而说不清是哪里改的。
    ...profileChangeStatements(env.DB, id, (() => {
      const before = digestExtrasFromColumns(profile.digest_price_reference, profile.digest_show_sales);
      const scope = applyTo === "all_keyword" ? "（同时应用到全部关键词档案）" : "";
      return [
        { field: "digest_price_reference" as const, before: DIGEST_PRICE_REFERENCE_TEXT[before.priceReference] ?? null, after: `${DIGEST_PRICE_REFERENCE_TEXT[priceReference] ?? priceReference}${scope}` },
        { field: "digest_show_sales" as const, before: onOffText(before.showSales, "显示", "不显示"), after: `${onOffText(showSales, "显示", "不显示")}${scope}` },
      ];
    })(), now),
  ];
  await env.DB.batch(statements);
  const updated = await keywordProfile(id);
  if (updated instanceof Response) return updated;
  return Response.json(await readState(id, updated));
}
