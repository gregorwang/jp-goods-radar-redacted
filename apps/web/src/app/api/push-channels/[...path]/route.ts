import { apiError, denyMutation, readJsonBody } from "@/lib/api-mutation";
import { relayFetch } from "@/lib/push-relay";

/**
 * 「推送」页的操作，原样转给 push-relay：
 *   POST   groups            加群
 *   PATCH  groups/:id        改名 / 开关 / 勾 IP / 换地址
 *   DELETE groups/:id        删群
 *   POST   groups/:id/test   试发
 *   POST   owner             自用私聊开关
 */
type Context = { params: Promise<{ path: string[] }> };

const ALLOWED = /^(owner|groups|groups\/[0-9a-f-]{36}|groups\/[0-9a-f-]{36}\/test)$/u;

async function forward(request: Request, context: Context, withBody: boolean): Promise<Response> {
  const denied = await denyMutation(request);
  if (denied) return denied;
  const path = (await context.params).path.join("/");
  if (!ALLOWED.test(path)) return apiError("not_found", 404);
  let body: unknown;
  if (withBody) {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    body = parsed.value;
  }
  return relayFetch(`/feishu/${path}`, { method: request.method, ...(withBody ? { body } : {}) });
}

export async function POST(request: Request, context: Context) {
  return forward(request, context, !(await context.params).path.includes("test"));
}

export async function PATCH(request: Request, context: Context) {
  return forward(request, context, true);
}

export async function DELETE(request: Request, context: Context) {
  return forward(request, context, false);
}
