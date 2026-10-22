import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import { adapterFailure, authRejected, invalidBody, methodNotAllowed, runtimeMeta } from "../src/response.js";
import { fixedSourceSearchBodySchema } from "../src/schemas.js";
import { fixedSourceAdapter } from "../src/source-dispatch.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response);
  const authFailure = await verifyServiceRequest(request, "source.search.v1", request.body);
  if (authFailure) return authRejected(response, authFailure);
  const parsed = fixedSourceSearchBodySchema.safeParse(request.body);
  if (!parsed.success) return invalidBody(response, parsed.error);
  const adapter = fixedSourceAdapter(parsed.data.sourceId);
  try {
    const result = await adapter.search(parsed.data.request, {
      fetch,
      secrets: {},
      signal: AbortSignal.timeout(20_000),
    });
    response.status(200).json({ ok: true, data: result, meta: runtimeMeta() });
  } catch (error) {
    adapterFailure(response, error, adapter.id);
  }
}
