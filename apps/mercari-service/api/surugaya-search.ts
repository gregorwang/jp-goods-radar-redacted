import { AdapterError } from "../../../packages/adapters/src/http.js";
import { surugayaAdapter } from "../../../packages/adapters/src/surugaya/index.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import {
  adapterFailure,
  attachServiceCorrelation,
  authRejected,
  invalidBody,
  methodNotAllowed,
  runtimeMeta,
  serviceCorrelationId,
  unexpectedServiceFailure,
  type ServiceHandlerStage,
} from "../src/response.js";
import { surugayaSearchBodySchema } from "../src/schemas.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const startedAt = Date.now();
  const correlationId = serviceCorrelationId(request);
  attachServiceCorrelation(response, correlationId);
  let stage: ServiceHandlerStage = "method";
  try {
    if (request.method !== "POST") return methodNotAllowed(response);
    stage = "authentication";
    const authFailure = await verifyServiceRequest(request, "surugaya.search.v1", request.body);
    if (authFailure) return authRejected(response, authFailure);
    stage = "validation";
    const parsed = surugayaSearchBodySchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(response, parsed.error);
    stage = "upstream_search";
    const result = await surugayaAdapter.search(parsed.data, {
      fetch,
      secrets: {},
      signal: AbortSignal.timeout(20_000),
    });
    stage = "response";
    response.status(200).json({ ok: true, data: result, meta: runtimeMeta() });
    console.info(JSON.stringify({
      event: "source_service_request_completed",
      sourceId: "surugaya",
      operation: "search",
      correlationId,
      durationMs: Date.now() - startedAt,
      status: 200,
      resultCount: result.listings.length,
    }));
  } catch (error) {
    if (stage === "upstream_search" && error instanceof AdapterError) {
      console.warn(JSON.stringify({
        event: "source_service_request_failed",
        sourceId: "surugaya",
        operation: "search",
        correlationId,
        durationMs: Date.now() - startedAt,
        stage,
        errorCode: error.code,
        upstreamStatus: error.status ?? null,
        retryable: error.retryable,
      }));
      adapterFailure(response, error, "骏河屋");
      return;
    }
    unexpectedServiceFailure(response, error, {
      sourceId: "surugaya",
      sourceLabel: "骏河屋",
      stage,
      correlationId,
      durationMs: Date.now() - startedAt,
    });
  }
}
