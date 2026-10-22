import { mercariAdapter } from "../../../packages/adapters/src/mercari/index.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import { adapterFailure, authRejected, invalidBody, methodNotAllowed, runtimeMeta } from "../src/response.js";
import { mercariItemBodySchema } from "../src/schemas.js";
import { createMercariUpstreamCaptureRecorder } from "../src/upstream-capture.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response);
  const authFailure = await verifyServiceRequest(request, "mercari.item.v1", request.body);
  if (authFailure) return authRejected(response, authFailure);
  const parsed = mercariItemBodySchema.safeParse(request.body);
  if (!parsed.success) return invalidBody(response, parsed.error);

  const captureRecorder = createMercariUpstreamCaptureRecorder(fetch);
  try {
    if (!mercariAdapter.getItem) throw new Error("Mercari 商品详情适配器不可用");
    const result = await mercariAdapter.getItem(parsed.data.urlOrId, {
      fetch: captureRecorder.fetch,
      secrets: {},
      signal: AbortSignal.timeout(8_000),
    });
    response.status(200).json({ ok: true, data: result, meta: runtimeMeta(await captureRecorder.flush()) });
  } catch (error) {
    adapterFailure(response, error, "Mercari", await captureRecorder.flush());
  }
}
