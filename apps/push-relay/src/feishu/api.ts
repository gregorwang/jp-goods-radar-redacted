/**
 * 飞书开放平台调用（自建应用身份）。
 *
 * 额度：基础免费版每月 1 万次（2026-10-13 用户确认），超了返回 429 / 99991403，当月剩下的日子全停。
 * 计数的：上传图片、发消息、加急等业务接口；不计数的：换 tenant_access_token、事件推送、回调里直接返回的卡片。
 * 每次计数的调用前都先过 spend()，由调用方（PushHub）记账、到线就拒绝。
 */

const BASE = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 10_000;

/**
 * 群自定义机器人（webhook）发卡片。**不算 API 额度**（官方单列的例外），频率限制是每个机器人 100 条 / 分钟、5 条 / 秒。
 * 签名：sign = base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = ""))。
 * 卡片里的图可以用应用上传的 image_key（2026-10-13 实测，同一租户）。
 */
export async function sendWebhookCard(url: string, secret: string | undefined, card: unknown): Promise<void> {
  const body: Record<string, unknown> = { msg_type: "interactive", card };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${timestamp}\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(0)));
    body.timestamp = timestamp;
    body.sign = btoa(String.fromCharCode(...signature));
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let result: { code?: number; msg?: string; StatusCode?: number };
  try {
    result = JSON.parse(text) as typeof result;
  } catch {
    throw new FeishuError(`webhook 返回不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, null, response.status);
  }
  const code = result.code ?? result.StatusCode ?? -1;
  if (code !== 0) throw new FeishuError(`webhook 失败：${code} ${result.msg ?? ""}`.trim(), code, response.status);
}

export class FeishuError extends Error {
  constructor(message: string, readonly code: number | null, readonly httpStatus: number | null) {
    super(message);
    this.name = "FeishuError";
  }
}

export interface FeishuRecipient {
  type: "chat_id" | "open_id";
  id: string;
}

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  /** 记一次计数调用；返回 false 表示额度到线、不许再调。 */
  spend: (kind: string) => boolean;
  /** tenant_access_token 缓存（DO 里存着，跨请求复用）。 */
  loadToken: () => { token: string; expiresAt: number } | null;
  saveToken: (token: string, expiresAt: number) => void;
}

export class FeishuClient {
  constructor(private readonly options: FeishuClientOptions) {}

  private async token(force = false): Promise<string> {
    const cached = force ? null : this.options.loadToken();
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
    const response = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuError(`换 token 失败：${body.msg ?? response.status}`, body.code ?? null, response.status);
    }
    this.options.saveToken(body.tenant_access_token, Date.now() + (body.expire ?? 7200) * 1_000);
    return body.tenant_access_token;
  }

  private async call<T>(kind: string, path: string, init: { method: string; json?: unknown; form?: FormData }): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token(attempt > 0);
      // 拿到 token 之后、真正调业务接口之前才记账：换 token 失败（10-13 晚被封 21001）不算飞书的额度，以前照记，白涨了约 60 次。
      if (!this.options.spend(kind)) throw new FeishuError("本月飞书调用额度已到安全线，停发", null, null);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (init.json !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
      const response = await fetch(`${BASE}${path}`, {
        method: init.method,
        headers,
        body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
      const text = await response.text();
      let body: { code?: number; msg?: string; data?: T };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new FeishuError(`飞书返回不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, null, response.status);
      }
      // 99991663 / 99991661 / 99991668：token 失效，换一个再试一次。
      if (attempt === 0 && (body.code === 99991663 || body.code === 99991661 || body.code === 99991668)) continue;
      if (body.code !== 0) throw new FeishuError(`${path} 失败：${body.code} ${body.msg ?? ""}`.trim(), body.code ?? null, response.status);
      return body.data as T;
    }
    throw new FeishuError(`${path} 失败：token 一直无效`, null, null);
  }

  async uploadImage(png: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([png], { type: "image/png" }), "grid.png");
    const data = await this.call<{ image_key?: string }>("image", "/im/v1/images", { method: "POST", form });
    if (!data?.image_key) throw new FeishuError("上传图片没返回 image_key", null, null);
    return data.image_key;
  }

  /**
   * 发一张卡片，返回 message_id。私聊要按会话号（chat_id，oc_ 开头）发：
   * 按 open_id 私发会被拒成 230101 "Sending messages to users is temporarily unavailable"（2026-10-13 实测，文字也一样）。
   */
  async sendCard(to: FeishuRecipient, card: unknown): Promise<string> {
    const data = await this.call<{ message_id?: string }>("message", `/im/v1/messages?receive_id_type=${to.type}`, {
      method: "POST",
      json: { receive_id: to.id, msg_type: "interactive", content: JSON.stringify(card) },
    });
    return data?.message_id ?? "";
  }

  async sendText(to: FeishuRecipient, text: string): Promise<string> {
    const data = await this.call<{ message_id?: string }>("message", `/im/v1/messages?receive_id_type=${to.type}`, {
      method: "POST",
      json: { receive_id: to.id, msg_type: "text", content: JSON.stringify({ text }) },
    });
    return data?.message_id ?? "";
  }
}
