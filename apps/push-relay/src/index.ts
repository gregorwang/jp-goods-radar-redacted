import { decryptFeishu, feishuSignatureValid, tokenEquals } from "./feishu/crypto";
import { PushHub } from "./hub";

export { PushHub };

/**
 * 路由：
 *   GET  /connect                 WebSocket，手机用，Authorization: Bearer <PUSH_DEVICE_TOKEN>
 *   GET  /messages?after=&limit=  补发 / 拉历史，同上鉴权
 *   GET  /status                  连接数、最后投递 / 送达，同上鉴权
 *   GET  /rounds                  各档案最近一轮巡回（几点跑完、几件新货、下一轮几点），同上鉴权
 *   POST /test                    发一条测试推送（App 设置页的按钮、验收时的 curl），同上鉴权
 *   POST /publish                 只给 collector：服务绑定 + X-Internal-Token: <PUSH_PUBLISH_TOKEN>
 *   POST /round                   只给 collector：某档案跑完一轮（没新货也报），同上鉴权
 *   POST /outcomes                只给 collector：{ids:[消息编号…]} → 每条发到飞书的结果（delivered / failed / pending / unknown），同上鉴权
 *   POST /feishu                  飞书事件 + 卡片回调（同一个地址）。验 Verification Token，开了 Encrypt Key 就解密、验签
 *   POST /feishu/sample           马上发一张样卡到飞书（验收用），Bearer <PUSH_DEVICE_TOKEN>
 *   POST /feishu/ping             马上发一张状态卡，返回飞书 message_id 或飞书的报错（排查用），同上鉴权
 *   GET  /feishu/status           飞书这一路的状态（绑没绑接收人、开没开、本月用了多少次、各个群），同上鉴权
 *   /feishu/groups…、/feishu/owner 主站「推送」页管群和私聊开关，见 handleFeishuAdmin，同上鉴权
 * 其余一律 404；口令不对一律 401，不区分"没带"和"带错了"。日志里不打印口令。
 */

const encoder = new TextEncoder();

/** 常量时间比较：先各自取 SHA-256 拉成等长，再 timingSafeEqual。 */
async function tokenMatches(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32 || !given) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const unauthorized = () => new Response("unauthorized", { status: 401 });
const hub = (env: Env) => env.PUSH_HUB.get(env.PUSH_HUB.idFromName("owner"));

function testMessage(): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    eventKey: `test:${crypto.randomUUID()}`,
    kind: "test",
    profileId: "test",
    profileName: "测试推送",
    createdAt: now,
    total: 1,
    items: [{
      sourceId: "mercari_jp",
      sourceLabel: "Mercari",
      title: "这是一条测试推送，点开能看到这张卡片就说明通道是通的",
      price: 1234,
      auction: false,
      url: "https://jp.mercari.com/",
      listedAt: now,
    }],
  };
}

/**
 * 飞书推来的事件和回调。URL 校验要 1 秒内回 challenge；卡片回调 3 秒内回（PushHub 里转主站留了 2.2 秒）；
 * 事件不用等处理完，先回 200，处理放 waitUntil。
 */
async function handleFeishu(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 飞书后台只认 JSON：返回纯文字时它只会提示"返回数据不是合法的JSON格式"，看不出真正原因。
  const fail = (error: string, status: number) => Response.json({ error }, { status });
  if (request.method !== "POST") return fail("method not allowed", 405);
  const raw = await request.text();
  if (await feishuSignatureValid(request, raw, env.FEISHU_ENCRYPT_KEY) === false) return fail("signature mismatch", 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
    if (typeof body.encrypt === "string") {
      if (!env.FEISHU_ENCRYPT_KEY) return fail("encrypt key not configured", 400);
      body = JSON.parse(await decryptFeishu(body.encrypt, env.FEISHU_ENCRYPT_KEY)) as Record<string, unknown>;
    }
  } catch {
    return fail("invalid body or encrypt key mismatch", 400);
  }
  const header = (body.header ?? {}) as { token?: unknown; event_type?: unknown; event_id?: unknown };
  if (!await tokenEquals(header.token ?? body.token, env.FEISHU_VERIFICATION_TOKEN)) return fail("verification token mismatch", 401);
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });

  const event = (body.event ?? {}) as Record<string, unknown>;
  const eventId = typeof header.event_id === "string" ? header.event_id : undefined;
  switch (header.event_type) {
    case "card.action.trigger":
      return Response.json(await hub(env).feishuCardAction(event));
    case "im.message.receive_v1":
      ctx.waitUntil(hub(env).feishuMessage(event, eventId).catch((error) => {
        console.error(JSON.stringify({ event: "feishu_message_failed", error: String(error).slice(0, 300) }));
      }));
      return Response.json({});
    case "application.bot.menu_v6":
      ctx.waitUntil(hub(env).feishuMenu(event, eventId).catch((error) => {
        console.error(JSON.stringify({ event: "feishu_menu_failed", error: String(error).slice(0, 300) }));
      }));
      return Response.json({});
    default:
      return Response.json({});
  }
}

/**
 * 主站「推送」页（经主站的服务绑定）：
 *   POST   /feishu/groups           加一个群 {name, webhookUrl, secret?, profileIds?}
 *   PATCH  /feishu/groups/:id       改 {name?, enabled?, profileIds?, webhookUrl?+secret?}
 *   DELETE /feishu/groups/:id
 *   POST   /feishu/groups/:id/test  试发
 *   POST   /feishu/owner            自用私聊开关 {enabled}
 * 列表在 GET /feishu/status 的 groups 里。填错了 400、飞书不收 502，都是 {error: "给人看的一句话"}。
 */
async function handleFeishuAdmin(request: Request, env: Env, target: { id: string | null; test: boolean } | null): Promise<Response> {
  let action: "create" | "update" | "delete" | "test" | "owner";
  if (target === null) action = "owner";
  else if (target.test) action = "test";
  else if (target.id === null) action = "create";
  else action = request.method === "DELETE" ? "delete" : "update";
  const method = { create: "POST", update: "PATCH", delete: "DELETE", test: "POST", owner: "POST" }[action];
  if (request.method !== method) return Response.json({ error: "method not allowed" }, { status: 405 });
  let input: Record<string, unknown> = {};
  if (action !== "delete" && action !== "test") {
    try {
      const body = await request.json() as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      input = body as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
  }
  const result = await hub(env).feishuAdmin(action, target?.id ?? null, input);
  return new Response(result.body, { status: result.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/u, "") || "/";

    if (path === "/feishu") return handleFeishu(request, env, ctx);

    if (path === "/round") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!await tokenMatches(request.headers.get("X-Internal-Token") ?? "", env.PUSH_PUBLISH_TOKEN)) return unauthorized();
      let round: unknown;
      try {
        round = await request.json();
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (!round || typeof round !== "object" || Array.isArray(round)) return new Response("invalid round", { status: 400 });
      try {
        return Response.json(await hub(env).publishRound(round as Record<string, unknown>));
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "round failed", { status: 400 });
      }
    }

    if (path === "/outcomes") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!await tokenMatches(request.headers.get("X-Internal-Token") ?? "", env.PUSH_PUBLISH_TOKEN)) return unauthorized();
      let ids: unknown;
      try {
        ids = ((await request.json()) as { ids?: unknown }).ids;
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => Number.isSafeInteger(id))) {
        return new Response("ids 要是整数数组（最多 500 个）", { status: 400 });
      }
      return Response.json({ outcomes: await hub(env).feishuOutcomes(ids as number[]) });
    }

    if (path === "/publish") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!await tokenMatches(request.headers.get("X-Internal-Token") ?? "", env.PUSH_PUBLISH_TOKEN)) return unauthorized();
      let message: unknown;
      try {
        message = await request.json();
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return new Response("invalid message", { status: 400 });
      try {
        const result = await hub(env).publish(message as Record<string, unknown>);
        console.log(JSON.stringify({ event: "push_published", ...result, kind: (message as { kind?: unknown }).kind }));
        return Response.json(result);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "publish failed", { status: 400 });
      }
    }

    const groupPath = /^\/feishu\/groups(?:\/([0-9a-f-]{36})(\/test)?)?$/u.exec(path);
    if (groupPath || path === "/feishu/owner") {
      if (!await tokenMatches(bearer(request), env.PUSH_DEVICE_TOKEN)) return unauthorized();
      return handleFeishuAdmin(request, env, path === "/feishu/owner" ? null : { id: groupPath?.[1] ?? null, test: Boolean(groupPath?.[2]) });
    }

    if (!["/connect", "/messages", "/status", "/rounds", "/test", "/feishu/sample", "/feishu/status", "/feishu/ping"].includes(path)) {
      return new Response("not found", { status: 404 });
    }
    if (!await tokenMatches(bearer(request), env.PUSH_DEVICE_TOKEN)) return unauthorized();

    if (path === "/feishu/status") return Response.json(await hub(env).feishuStatus());
    if (path === "/feishu/ping") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({ messageId: await hub(env).feishuPing() });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
      }
    }
    if (path === "/feishu/sample") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      await hub(env).feishuSample();
      return Response.json({ requested: true });
    }

    if (path === "/connect") return hub(env).fetch(request);
    if (path === "/messages") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const messages = await hub(env).messagesAfter(Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 50);
      return Response.json({ messages });
    }
    if (path === "/status") return Response.json(await hub(env).status());
    if (path === "/rounds") return Response.json({ rounds: await hub(env).rounds() });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const result = await hub(env).publish(testMessage());
    console.log(JSON.stringify({ event: "push_test_published", ...result }));
    return Response.json(result);
  },
} satisfies ExportedHandler<Env>;
