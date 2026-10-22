import "server-only";
import { getEnv } from "./cloudflare";
import { privateJson } from "./api-response";

/**
 * 「推送」页调 push-relay（apps/push-relay）用：服务绑定 PUSH_RELAY + Bearer OWNER_DEVICE_TOKEN
 * （和 push-relay 的 PUSH_DEVICE_TOKEN 是同一个值）。push-relay 是手动发布的，没发布新版时这些地址会 404。
 */
const TIMEOUT_MS = 15_000;

export async function relayFetch(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const env = getEnv();
  let response: Response;
  try {
    response = await env.PUSH_RELAY.fetch(`https://push-relay${path}`, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OWNER_DEVICE_TOKEN}` },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return privateJson({ error: "推送服务没响应，稍后再试" }, { status: 502 });
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { error: response.status === 404 ? "推送服务还是旧版本，要先发布 push-relay" : `推送服务出错（${response.status}）` };
  }
  return privateJson(body, { status: response.ok ? 200 : response.status });
}
