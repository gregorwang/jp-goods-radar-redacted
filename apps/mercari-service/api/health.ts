import { runtimeMeta } from "../src/response.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";

export default function handler(request: VercelRequest, response: VercelResponse): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ ok: false, error: { code: "method_not_allowed", message: "仅支持 GET" }, meta: runtimeMeta() });
    return;
  }
  // 公开端点只回存活性：来源清单与能力标识会暴露本服务实际抓取哪些站点。
  response.status(200).json({
    ok: true,
    service: "jp-goods-radar-source-adapter",
    configured: true,
    meta: runtimeMeta(),
  });
}
