import { unauthorized } from "@/lib/api-auth";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";
import { relayFetch } from "@/lib/push-relay";

/**
 * 「推送」页的全部数据：飞书私聊开没开、各个群（push-relay /feishu/status），
 * 以及所有档案：什么类型、开没开飞书（watch_profiles.notify_feishu，在档案页上改，这里只展示）。
 * 群勾选里没开飞书的档案是灰的：勾着也不会发，打开飞书后接着按勾选发。
 */
export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  const [status, profiles] = await Promise.all([
    relayFetch("/feishu/status"),
    getEnv().DB.prepare(
      `SELECT id,name,dossier_kind,enabled,notify_feishu FROM watch_profiles
       ORDER BY CASE dossier_kind WHEN 'keyword' THEN 0 WHEN 'exact_product' THEN 1 ELSE 2 END,enabled DESC,name`,
    ).all<{ id: string; name: string; dossier_kind: string; enabled: number | string; notify_feishu: number | string }>(),
  ]);
  if (!status.ok) return status;
  return privateJson({
    feishu: await status.json(),
    profiles: profiles.results.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.dossier_kind,
      enabled: Number(row.enabled) === 1,
      feishu: Number(row.notify_feishu) === 1,
    })),
  });
}
