import { unauthorized } from "@/lib/api-auth";
import { routeId } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { getEnv } from "@/lib/cloudflare";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const denied = await unauthorized();
  if (denied) return denied;
  // 价格曲线只需要最近的窗口。30 分钟频率的单品一年会积累约 17,500 条快照，
  // 无上限查询会把它们全部序列化进一个响应，并造成不必要的响应体与内存压力。
  const result = await getEnv().DB.prepare(
    `SELECT * FROM (
       SELECT id,price,original_price,currency,availability,item_condition,observed_at
       FROM listing_snapshots WHERE listing_id=? ORDER BY observed_at DESC LIMIT 500
     ) ORDER BY observed_at`,
  ).bind(await routeId(context)).all();
  return privateJson({ items: result.results });
}
