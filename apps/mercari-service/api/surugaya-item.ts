import { surugayaAdapter } from "../../../packages/adapters/src/surugaya/index.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import { adapterFailure, authRejected, invalidBody, methodNotAllowed, runtimeMeta } from "../src/response.js";
import { surugayaItemBodySchema } from "../src/schemas.js";
import { getSurugayaItemWithSearchFallback } from "../src/surugaya-item-fallback.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response);
  const authFailure = await verifyServiceRequest(request, "surugaya.item.v1", request.body);
  if (authFailure) return authRejected(response, authFailure);
  const parsed = surugayaItemBodySchema.safeParse(request.body);
  if (!parsed.success) return invalidBody(response, parsed.error);

  try {
    const result = await getSurugayaItemWithSearchFallback(parsed.data.urlOrId, {
      fetch,
      secrets: {},
      signal: AbortSignal.timeout(20_000),
    }, surugayaAdapter);
    response.status(200).json({ ok: true, data: result, meta: runtimeMeta() });
  } catch (error) {
    adapterFailure(response, error, "骏河屋");
  }
}
