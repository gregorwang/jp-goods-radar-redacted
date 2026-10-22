/**
 * 管理端 JSON 响应统一带上不可缓存标记。next.config.ts 的 headers() 已对
 * /api/:path* 声明了同样的值，这里是纵深防御：鉴权失败与错误响应无论经由哪一层
 * 都必须携带 private, no-store。
 */
const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

export function privateJson(body: unknown, init?: ResponseInit): Response {
  const response = Response.json(body, init);
  for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
  return response;
}
