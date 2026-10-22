import { z } from "zod";
import { unauthorized } from "@/lib/api-auth";
import { apiError, denyMutation, readJsonBody, routeId } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { relayFetch } from "@/lib/push-relay";
import { onOffText, profileChangeStatements } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };

/**
 * 这个档案的通知发到哪：邮件、飞书两个独立开关（watch_profiles.notify_email / notify_feishu，2026-10-14）。
 * 管这个档案的全部通知；两个都关 = 只巡回、不通知；只开飞书时飞书没送到会改发邮件（apps/collector/src/push-delivery.ts）。
 * collector 每轮现读，不用发版。
 *
 * GET 顺带回飞书那边能不能送到：自用私聊开没开、哪些开着的群勾了这个档案。推送服务没响应时 reach 为 null，页面照常能改开关。
 */
const inputSchema = z.object({
  notifyEmail: z.boolean(),
  notifyFeishu: z.boolean(),
}).strict();

interface ProfileRow {
  notify_email: number | string;
  notify_feishu: number | string;
}

interface RelayGroup {
  name: string;
  enabled: boolean;
  profileIds: string[] | null;
}

interface FeishuReach {
  /** 推送总闸 owner_push_v1 开着没有：关着时飞书一概不发，只开飞书的也改发邮件。 */
  pushEnabled: boolean;
  ownerPrivate: boolean;
  /** 开着、并且勾了这个档案（或勾了「全部」）的群名。 */
  groups: string[];
}

async function readProfile(id: string): Promise<ProfileRow | null> {
  return getEnv().DB.prepare("SELECT notify_email,notify_feishu FROM watch_profiles WHERE id=?")
    .bind(id).first<ProfileRow>();
}

async function feishuReach(id: string): Promise<FeishuReach | null> {
  const [flag, status] = await Promise.all([
    getEnv().DB.prepare("SELECT enabled FROM runtime_feature_flags WHERE flag_key='owner_push_v1'").first<{ enabled: number | string }>(),
    relayFetch("/feishu/status"),
  ]);
  if (!status.ok) return null;
  const body = await status.json() as { enabled?: unknown; groups?: unknown };
  const groups = Array.isArray(body.groups) ? body.groups as RelayGroup[] : [];
  return {
    pushEnabled: Number(flag?.enabled) === 1,
    ownerPrivate: body.enabled === true,
    groups: groups
      .filter((group) => group.enabled && (group.profileIds === null || group.profileIds.includes(id)))
      .map((group) => group.name),
  };
}

function view(id: string, row: ProfileRow, reach: FeishuReach | null) {
  return {
    profileId: id,
    notifyEmail: Number(row.notify_email) === 1,
    notifyFeishu: Number(row.notify_feishu) === 1,
    reach,
  };
}

export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const row = await readProfile(id);
  if (!row) return apiError("watch_profile_not_found", 404);
  return privateJson(view(id, row, await feishuReach(id).catch(() => null)));
}

export async function PUT(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = inputSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request");
  const id = await routeId(context);
  const before = await readProfile(id);
  if (!before) return apiError("watch_profile_not_found", 404);
  const db = getEnv().DB;
  // 不动 updated_at：这是通知去向，不改搜索范围，不该让档案在列表里跳到最前面。
  await db.batch([
    db.prepare("UPDATE watch_profiles SET notify_email=?,notify_feishu=? WHERE id=?")
      .bind(parsed.data.notifyEmail ? 1 : 0, parsed.data.notifyFeishu ? 1 : 0, id),
    ...profileChangeStatements(db, id, [
      { field: "notify_email", before: onOffText(before.notify_email), after: onOffText(parsed.data.notifyEmail) },
      { field: "notify_feishu", before: onOffText(before.notify_feishu), after: onOffText(parsed.data.notifyFeishu) },
    ], new Date().toISOString()),
  ]);
  const row = await readProfile(id);
  if (!row) return apiError("watch_profile_not_found", 404);
  return privateJson(view(id, row, await feishuReach(id).catch(() => null)));
}
