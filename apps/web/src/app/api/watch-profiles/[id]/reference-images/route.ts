import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";

/**
 * 精确同款档案的参考图（1～2 张，docs/进行中/精确同款参考图-交接-20261009.md）。
 * 图由浏览器缩到长边 ≤1024 的 JPEG 后以 base64 上传，存在 radar_core.watch_profile_reference_images。
 * collector 只在开关 exact_reference_image_v1 开着时才拿它和候选商品图比；没有参考图的档案照旧只看标题。
 */
type Context = { params: Promise<{ id: string }> };

const MAX_REFERENCE_IMAGES = 2;
/** 与表上的 CHECK 一致；1024px 的 JPEG base64 后通常 0.1～0.5MB。 */
const MAX_BASE64_LENGTH = 2_000_000;
type ContentType = "image/jpeg" | "image/png" | "image/webp";

interface ReferenceImageRow {
  ordinal: number;
  content_type: string;
  image_base64: string;
  width: number | null;
  height: number | null;
  created_at: string;
}


/** 手工 psql 写进去的是 `now()::text`（`2026-10-12 01:27:24.9+00`），页面写的是 ISO；统一成 ISO。 */
function flagTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/u, "$1:00"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function exactProfile(id: string): Promise<boolean> {
  const profile = await getEnv().DB.prepare("SELECT dossier_kind FROM watch_profiles WHERE id=?")
    .bind(id).first<{ dossier_kind: string }>();
  return profile?.dossier_kind === "exact_product";
}

/** 只认真图片：文件头和声明的类型对得上。 */
function sniffContentType(base64: string): ContentType | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const bytes = Array.from(head, (char) => char.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const env = getEnv();
  const [rows, flag] = await Promise.all([
    env.DB.prepare(
      `SELECT ordinal,content_type,image_base64,width,height,created_at
       FROM watch_profile_reference_images WHERE watch_profile_id=? ORDER BY ordinal`,
    ).bind(id).all<ReferenceImageRow>(),
    // 看图整体开没开（花钱的开关，docs/成本/成本账本.md §5）。关着时参考图先存着，不起作用。
    env.DB.prepare("SELECT enabled,updated_at FROM runtime_feature_flags WHERE flag_key='exact_reference_image_v1'")
      .first<{ enabled: number; updated_at: string | null }>(),
  ]);
  return privateJson({
    maxImages: MAX_REFERENCE_IMAGES,
    scoringEnabled: Number(flag?.enabled ?? 0) === 1,
    scoringChangedAt: flagTimestamp(flag?.updated_at),
    images: rows.results.map((row) => ({
      ordinal: Number(row.ordinal),
      dataUrl: `data:${row.content_type};base64,${row.image_base64}`,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
    })),
  });
}

/** body: { dataBase64, contentType, width?, height?, ordinal? }。不给 ordinal 就放进第一个空位。 */
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const input = (body.value ?? {}) as Record<string, unknown>;
  const dataBase64 = typeof input.dataBase64 === "string" ? input.dataBase64.replace(/\s+/gu, "") : "";
  if (!dataBase64 || dataBase64.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataBase64)) {
    return apiError("参考图为空或超过 1.5MB，请换一张或缩小后再传");
  }
  const sniffed = sniffContentType(dataBase64);
  if (!sniffed || sniffed !== input.contentType) return apiError("只支持 JPEG、PNG、WebP 图片");
  const dimension = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10_000
    ? value
    : null);
  if (!await exactProfile(id)) return apiError("只有精确同款档案能设参考图", 404);
  const env = getEnv();
  const existing = await env.DB.prepare(
    "SELECT ordinal FROM watch_profile_reference_images WHERE watch_profile_id=?",
  ).bind(id).all<{ ordinal: number }>();
  const used = new Set(existing.results.map((row) => Number(row.ordinal)));
  const requested = typeof input.ordinal === "number" ? input.ordinal : undefined;
  const ordinal = requested ?? Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => index + 1)
    .find((value) => !used.has(value));
  if (ordinal === undefined) return apiError(`最多 ${MAX_REFERENCE_IMAGES} 张参考图，先删掉一张再传`, 409);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_REFERENCE_IMAGES) return apiError("invalid_ordinal");
  await env.DB.prepare(
    `INSERT INTO watch_profile_reference_images(watch_profile_id,ordinal,content_type,image_base64,width,height,created_at)
     VALUES(?,?::integer,?,?,?::integer,?::integer,?)
     ON CONFLICT (watch_profile_id,ordinal) DO UPDATE SET content_type=excluded.content_type,
       image_base64=excluded.image_base64,width=excluded.width,height=excluded.height,created_at=excluded.created_at`,
  ).bind(id, ordinal, sniffed, dataBase64, dimension(input.width), dimension(input.height), new Date().toISOString()).run();
  return privateJson({ ordinal });
}

/** ?ordinal=1|2 */
export async function DELETE(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const ordinal = Number(new URL(request.url).searchParams.get("ordinal"));
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_REFERENCE_IMAGES) return apiError("invalid_ordinal");
  await getEnv().DB.prepare(
    "DELETE FROM watch_profile_reference_images WHERE watch_profile_id=? AND ordinal=?::integer",
  ).bind(id, ordinal).run();
  return privateJson({ deleted: ordinal });
}

/** body: { scoringEnabled: boolean }。拨的是全局看图开关（花钱，docs/成本/成本账本.md §5），不是这一个档案的。 */
export async function PATCH(request: Request) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const enabled = (body.value as Record<string, unknown> | null)?.scoringEnabled;
  if (typeof enabled !== "boolean") return apiError("scoringEnabled_boolean_required");
  const changedAt = new Date().toISOString();
  await getEnv().DB.prepare(
    "UPDATE runtime_feature_flags SET enabled=?,updated_at=? WHERE flag_key='exact_reference_image_v1'",
  ).bind(enabled ? 1 : 0, changedAt).run();
  return privateJson({ scoringEnabled: enabled, scoringChangedAt: changedAt });
}
