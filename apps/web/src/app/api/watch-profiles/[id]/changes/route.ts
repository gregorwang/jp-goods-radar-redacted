import { unauthorized } from "@/lib/api-auth";
import { routeId } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { PROFILE_CHANGE_FIELDS } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };

interface ChangeRow {
  field: string;
  source_id: string | null;
  source_name: string | null;
  before_value: string | null;
  after_value: string | null;
  changed_at: string;
}

/**
 * 档案改动记录（lib/profile-change-log.ts）。同一次保存同步到多个来源会写多行，
 * 这里按「同一分钟、同一项、同样的前后值」合成一行再给页面，页面只管排版。
 */
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  const id = await routeId(context);
  const rows = await getEnv().DB.prepare(
    `SELECT c.field,c.source_id,s.display_name source_name,c.before_value,c.after_value,c.changed_at
     FROM watch_profile_changes c LEFT JOIN source_registry s ON s.id=c.source_id
     WHERE c.watch_profile_id=? ORDER BY c.changed_at DESC,c.id LIMIT 400`,
  ).bind(id).all<ChangeRow>();

  const groups = new Map<string, {
    field: string; label: string; before: string | null; after: string | null; changedAt: string; sources: string[];
  }>();
  for (const row of rows.results) {
    const key = [row.changed_at.slice(0, 16), row.field, row.before_value ?? "", row.after_value ?? ""].join("\u0000");
    const group = groups.get(key) ?? {
      field: row.field,
      label: PROFILE_CHANGE_FIELDS[row.field as keyof typeof PROFILE_CHANGE_FIELDS] ?? row.field,
      before: row.before_value,
      after: row.after_value,
      changedAt: row.changed_at,
      sources: [],
    };
    if (row.source_id) group.sources.push(row.source_name ?? row.source_id);
    groups.set(key, group);
  }
  return privateJson({ changes: [...groups.values()].slice(0, 60) });
}
