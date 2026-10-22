import { listingWatchOptionsSchema } from "@jpgr/validation";
import { z } from "zod";
import { unauthorized } from "@/lib/api-auth";
import { readJsonBody } from "@/lib/api-mutation";
import { privateJson } from "@/lib/api-response";
import { startItemWatch, stopItemWatch } from "@/lib/listing-watch";

/**
 * 收件箱「盯住」（2026-10-16 用户要的）：推过来的商品里自己看中的，点一下放进商品库建单品档案，
 * 之后每小时打开一次详情页，点赞 / 评论涨了发邮件「有人盯上了」，降价、卖掉照常提醒。
 * 和手机 App「等降价」是同一份建法（lib/listing-watch.ts），区别只是这里固定每小时查一次：
 * 默认的自适应频率在商品没变化时会慢慢放宽到一天以上，热度这件事等不了。
 * DELETE：不盯了（暂停这个单品档案）。
 */
const itemSchema = z.object({
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(300),
}).strict();

const HOURLY_FIXED = { intervalMinutes: 60, itemScheduleMode: "fixed" } as const;

async function readItem(request: Request): Promise<z.infer<typeof itemSchema> | Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = itemSchema.safeParse(body.value);
  if (!parsed.success) return privateJson({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  return parsed.data;
}

export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const item = await readItem(request);
  if (item instanceof Response) return item;
  return startItemWatch(item.sourceId, item.sourceItemId, listingWatchOptionsSchema.parse(HOURLY_FIXED));
}

export async function DELETE(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const item = await readItem(request);
  if (item instanceof Response) return item;
  return stopItemWatch(item.sourceId, item.sourceItemId);
}
