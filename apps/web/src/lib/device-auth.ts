import "server-only";
import { getEnv } from "./cloudflare";
import { privateJson } from "./api-response";

/**
 * 自用手机 App（apps/android-push）专用的窄接口鉴权：`Authorization: Bearer <OWNER_DEVICE_TOKEN>`。
 * OWNER_DEVICE_TOKEN 和 push-relay 的 PUSH_DEVICE_TOKEN 是同一个值，App 只记一个口令。
 * 只放在 /api/device/* 上，那里只有标注和「等降价」两件事——不给手机开主站后台的其余接口。
 * 不带 Cookie、不看 Origin（App 不是浏览器）；口令不对一律 401。
 */
const encoder = new TextEncoder();

export async function deviceUnauthorized(request: Request): Promise<Response | null> {
  const expected = getEnv().OWNER_DEVICE_TOKEN;
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || expected.length < 32 || !given) return privateJson({ error: "unauthorized" }, { status: 401 });
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0 ? null : privateJson({ error: "unauthorized" }, { status: 401 });
}

/**
 * App 和飞书卡片上的标注只管这几个档案：开了飞书的关键词档案（watch_profiles.notify_feishu，2026-10-14 起按档案开关；
 * 以前是 owner_push_v1.config_json.profileIds 名单）。推送总闸 owner_push_v1 关着时一个都不管。
 */
export async function ownerPushProfileIds(): Promise<string[]> {
  const result = await getEnv().DB.prepare(
    `SELECT p.id FROM watch_profiles p
     WHERE p.dossier_kind='keyword' AND p.notify_feishu=1
     AND EXISTS (SELECT 1 FROM runtime_feature_flags f WHERE f.flag_key='owner_push_v1' AND f.enabled=1)
     ORDER BY p.name`,
  ).all<{ id: string }>();
  return result.results.map((row) => row.id);
}
