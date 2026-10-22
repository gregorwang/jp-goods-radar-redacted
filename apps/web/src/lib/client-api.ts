export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    throw new Error("请先登录");
  }
  // 响应不一定是 JSON：Cloudflare 的 5xx 中间页、Worker 异常的 502、OpenNext 错误页都是 HTML。
  // 直接 response.json() 会抛出 SyntaxError，操作者看到的是一句莫名其妙的解析错误。
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) as unknown : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `请求失败 (${response.status})`;
    throw new Error(message);
  }
  if (body === null && text) throw new Error("服务返回了非 JSON 响应");
  return body as T;
}

/** 把任意异常整理成可展示给操作者的一句话。 */
export function apiErrorMessage(reason: unknown, fallback = "读取失败"): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
