import "server-only";
import { apiError } from "./api-mutation";
import { getEnv } from "./cloudflare";

/**
 * 日报逐件标注（不想看 / 还想看）。主站收件箱（/api/watch-profiles/[id]/digest-labels）和
 * 手机 App 的列表标注（/api/device/labels）共用这一份写法：结论按「档案 + 来源 + 商品号」存，
 * 商品信息以日报载荷为准，不信前端传来的标题——Claude 之后读的就是这份快照。
 */

export type DigestVerdict = "hide" | "keep";

export interface DigestItem {
  sourceId: string;
  sourceItemId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  price: number | null;
  auction: boolean;
}

export async function keywordProfile(id: string): Promise<{ id: string; name: string } | Response> {
  const profile = await getEnv().DB.prepare("SELECT id,name,dossier_kind FROM watch_profiles WHERE id=?")
    .bind(id).first<{ id: string; name: string; dossier_kind: string }>();
  if (!profile) return apiError("watch_profile_not_found", 404);
  if (profile.dossier_kind !== "keyword") return apiError("digest_labels_require_keyword_dossier", 409);
  return { id: profile.id, name: profile.name };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 日报里实际逐件展示的商品。建档存量（category=baseline）在邮件里只汇总成回执、不逐件出现，
 * 用户没见过它们，不拿来标。没有来源商品号的旧载荷条目也跳过（结论要按商品存）。
 */
export function digestItems(payloadJson: string): DigestItem[] {
  let items: unknown;
  try {
    items = (JSON.parse(payloadJson) as { items?: unknown }).items;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items.flatMap((value): DigestItem[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const sourceId = text(item.sourceId);
    const sourceItemId = text(item.sourceItemId);
    if (!sourceId || !sourceItemId || item.category === "baseline") return [];
    return [{
      sourceId,
      sourceItemId,
      title: text(item.title) ?? "未命名商品",
      url: text(item.url),
      imageUrl: text(item.imageUrl),
      price: typeof item.price === "number" && Number.isFinite(item.price) ? item.price : null,
      auction: item.auction !== undefined && item.auction !== null && item.auction !== false,
    }];
  });
}

/** 已送达的日报（邮件发出、推到了飞书），或两个推送开关都关、只在收件箱里看的（suppressed，2026-10-16）。 */
export async function digestPayload(profileId: string, eventId: string): Promise<string | null> {
  const row = await getEnv().DB.prepare(
    `SELECT payload_json FROM events
     WHERE id=? AND watch_profile_id=? AND event_type='daily_digest' AND status IN ('sent','suppressed')`,
  ).bind(eventId, profileId).first<{ payload_json: string }>();
  return row?.payload_json ?? null;
}

/** 写一条结论；verdict=undo 时删掉。返回 null 表示成功，否则是要直接回给前端的错误。 */
export async function saveDigestLabel(input: {
  profileId: string;
  digestEventId: string;
  sourceId: string;
  sourceItemId: string;
  verdict: DigestVerdict | "undo";
}): Promise<Response | null> {
  const env = getEnv();
  if (input.verdict === "undo") {
    await env.DB.prepare(
      "DELETE FROM digest_item_labels WHERE watch_profile_id=? AND source_id=? AND source_item_id=?",
    ).bind(input.profileId, input.sourceId, input.sourceItemId).run();
    return null;
  }
  const payload = await digestPayload(input.profileId, input.digestEventId);
  if (payload === null) return apiError("digest_not_found", 404);
  const item = digestItems(payload)
    .find((entry) => entry.sourceId === input.sourceId && entry.sourceItemId === input.sourceItemId);
  if (!item) return apiError("digest_item_not_found", 404);
  // 改判（不想看 ↔ 还想看）时清掉 reviewed_at：结论变了，Claude 要重新看一眼。
  await env.DB.prepare(
    `INSERT INTO digest_item_labels(watch_profile_id,source_id,source_item_id,verdict,title,url,image_url,price,digest_event_id,labeled_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (watch_profile_id,source_id,source_item_id) DO UPDATE SET
       verdict=excluded.verdict,title=excluded.title,url=excluded.url,image_url=excluded.image_url,
       price=excluded.price,digest_event_id=excluded.digest_event_id,labeled_at=excluded.labeled_at,
       reviewed_at=CASE WHEN digest_item_labels.verdict=excluded.verdict THEN digest_item_labels.reviewed_at END`,
  ).bind(
    input.profileId,
    input.sourceId,
    input.sourceItemId,
    input.verdict,
    item.title.slice(0, 1000),
    item.url,
    item.imageUrl,
    item.price === null ? null : Math.round(item.price),
    input.digestEventId,
    new Date().toISOString(),
  ).run();
  return null;
}
