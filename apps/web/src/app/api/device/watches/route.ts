import { listingWatchOptionsSchema } from "@jpgr/validation";
import { z } from "zod";
import { readJsonBody } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { deviceUnauthorized } from "@/lib/device-auth";
import { ACTIVE_ITEM_WATCH_LIMIT, startItemWatch, stopItemWatch } from "@/lib/listing-watch";

/**
 * 手机 App 上的「等降价」：给推送里的某件商品建单品档案（和主站商品页同一份建法，lib/listing-watch.ts），
 * 降价时照旧走邮件通知（2026-10-12 用户定：降价低频，不做手机推送）。
 * 同时在盯的上限见 lib/listing-watch.ts 的 ACTIVE_ITEM_WATCH_LIMIT。
 * DELETE：不等了（暂停这个单品档案，和主站「暂停」同一组语句）。
 */
const itemSchema = z.object({
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(300),
}).strict();

async function readItem(request: Request): Promise<z.infer<typeof itemSchema> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = itemSchema.safeParse(body.value);
  if (!parsed.success) return privateJson({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  return parsed.data;
}

export async function GET(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const rows = await getEnv().DB.prepare(
    `SELECT b.source_id,b.source_item_id,b.enabled binding_enabled,p.enabled profile_enabled
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     WHERE b.kind='item' AND b.source_item_id IS NOT NULL`,
  ).all<{ source_id: string; source_item_id: string; binding_enabled: number | string; profile_enabled: number | string }>();
  const items = rows.results.map((row) => ({
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    active: Number(row.binding_enabled) === 1 && Number(row.profile_enabled) === 1,
  }));
  return privateJson({ limit: ACTIVE_ITEM_WATCH_LIMIT, active: items.filter((item) => item.active).length, items });
}

export async function POST(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const item = await readItem(request);
  if (item instanceof Response) return item;
  return startItemWatch(item.sourceId, item.sourceItemId, listingWatchOptionsSchema.parse({}));
}

export async function DELETE(request: Request) {
  const denied = await deviceUnauthorized(request);
  if (denied) return denied;
  const item = await readItem(request);
  if (item instanceof Response) return item;
  return stopItemWatch(item.sourceId, item.sourceItemId);
}
