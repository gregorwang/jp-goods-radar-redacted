import { apiError, denyMutation, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { profileChangeStatements } from "@/lib/profile-change-log";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const id = await routeId(context);
  const db = getEnv().DB;
  const binding = await db.prepare("SELECT watch_profile_id,source_id,enabled FROM watch_bindings WHERE id=?")
    .bind(id).first<{ watch_profile_id: string; source_id: string; enabled: number | string }>();
  if (!binding) return apiError("watch_binding_not_found", 404);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE watch_bindings SET enabled=0,updated_at=? WHERE id=?").bind(now, id),
    ...profileChangeStatements(db, binding.watch_profile_id, [{
      field: "source_enabled", sourceId: binding.source_id,
      before: Number(binding.enabled) === 1 ? "巡回中" : "已暂停", after: "已暂停",
    }], now),
  ]);
  return Response.json({ paused: true });
}
