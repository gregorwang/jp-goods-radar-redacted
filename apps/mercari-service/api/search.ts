import { mercariAdapter } from "../../../packages/adapters/src/mercari/index.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import { adapterFailure, authRejected, invalidBody, methodNotAllowed, runtimeMeta } from "../src/response.js";
import { mercariSearchBodySchema } from "../src/schemas.js";
import { createMercariUpstreamCaptureRecorder } from "../src/upstream-capture.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response);
  // 先验签再校验：未认证调用不应能通过 400 的 issue 列表探明私有 schema；
  // 且签名必须绑定实际收到的请求体（parsed.data 经 zod trim 等变换后与
  // Collector 签名的原始载荷不再逐字节一致）。
  const authFailure = await verifyServiceRequest(request, "mercari.search.v1", request.body);
  if (authFailure) return authRejected(response, authFailure);
  const parsed = mercariSearchBodySchema.safeParse(request.body);
  if (!parsed.success) return invalidBody(response, parsed.error);

  const captureRecorder = createMercariUpstreamCaptureRecorder(fetch);
  try {
    const result = await mercariAdapter.search(parsed.data, {
      fetch: captureRecorder.fetch,
      secrets: {},
      signal: AbortSignal.timeout(8_000),
    });
    response.status(200).json({ ok: true, data: result, meta: runtimeMeta(await captureRecorder.flush()) });
  } catch (error) {
    adapterFailure(response, error, "Mercari", await captureRecorder.flush());
  }
}
