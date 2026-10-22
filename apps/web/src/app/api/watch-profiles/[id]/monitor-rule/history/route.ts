import type { MonitorRuleRow } from "@jpgr/db";
import { unauthorized } from "@/lib/api-auth";
import { apiError, routeId } from "@/lib/api-mutation";
import { getEnv } from "@/lib/cloudflare";
import { monitorRuleView } from "@/lib/monitor-rules";
import type { MonitorRuleHistoryResponse } from "@/lib/monitor-rule-contract";

type HistoryRow = MonitorRuleRow & {
  historical_cost_target: number | null;
  historical_cost_profile_id: string | null;
  historical_cost_profile_version: number | null;
  historical_cost_profile_name: string | null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await unauthorized();
  if (denied) return denied;
  const profileId = await routeId(context);
  const cursor = new URL(request.url).searchParams.get("beforeVersion");
  const beforeVersion = cursor === null ? null : Number(cursor);
  if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) {
    return apiError("历史版本页码无效", 400);
  }
  const db = getEnv().DB;
  const profile = await db.prepare("SELECT id FROM watch_profiles WHERE id=?").bind(profileId).first();
  if (!profile) return apiError("watch_profile_not_found", 404);

  const pageSize = 20;
  const rows = await db.prepare(
    `SELECT rule.*,target.target_landed_cost_jpy historical_cost_target,
            cost.id historical_cost_profile_id,cost.version historical_cost_profile_version,
            cost.name historical_cost_profile_name
     FROM monitor_rules rule
     LEFT JOIN monitor_rule_landed_cost_targets target ON target.monitor_rule_id=rule.id
     LEFT JOIN cost_profiles cost ON cost.id=target.cost_profile_id
     WHERE rule.watch_profile_id=? ${beforeVersion === null ? "" : "AND rule.version<?"}
     ORDER BY rule.version DESC LIMIT ?`,
  ).bind(profileId, ...(beforeVersion === null ? [] : [beforeVersion]), pageSize + 1).all<HistoryRow>();
  const page = rows.results.slice(0, pageSize);
  const body: MonitorRuleHistoryResponse = {
    versions: page.map((row) => ({
      ...monitorRuleView(row, row.historical_cost_target !== null && row.historical_cost_profile_id !== null
        && row.historical_cost_profile_version !== null && row.historical_cost_profile_name !== null ? {
          targetLandedCostJpy: row.historical_cost_target,
          costProfileId: row.historical_cost_profile_id,
          costProfileVersion: row.historical_cost_profile_version,
          costProfileName: row.historical_cost_profile_name,
        } : null),
      validTo: row.valid_to,
    })),
    nextBeforeVersion: rows.results.length > pageSize ? page[page.length - 1].version : null,
  };
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
