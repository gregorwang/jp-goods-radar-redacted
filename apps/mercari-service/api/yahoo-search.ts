import { AdapterError } from "../../../packages/adapters/src/http.js";
import { yahooShoppingAdapter } from "../../../packages/adapters/src/yahoo-shopping/index.js";
import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { verifyServiceRequest } from "../src/auth.js";
import {
  adapterFailure,
  authRejected,
  invalidBody,
  methodNotAllowed,
  runtimeMeta,
  unexpectedServiceFailure,
  type ServiceHandlerStage,
} from "../src/response.js";
import { yahooSearchBodySchema } from "../src/schemas.js";
import { searchYahooWithCache } from "../src/yahoo-runtime.js";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  let stage: ServiceHandlerStage = "method";
  try {
    if (request.method !== "POST") return methodNotAllowed(response);
    stage = "authentication";
    const authFailure = await verifyServiceRequest(request, "yahoo.search.v1", request.body);
    if (authFailure) return authRejected(response, authFailure);
    stage = "validation";
    const parsed = yahooSearchBodySchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(response, parsed.error);
    stage = "upstream_search";
    if (process.env.YAHOO_WEB_EXPERIMENTAL_ENABLED !== "true") {
      throw new AdapterError("Yahoo 实验来源功能开关未开启", "yahoo_experiment_disabled", 503);
    }
    const { result, cacheStatus } = await searchYahooWithCache(parsed.data, () => yahooShoppingAdapter.search(parsed.data, {
      fetch,
      secrets: {
        YAHOO_WEB_EXPERIMENTAL_ENABLED: process.env.YAHOO_WEB_EXPERIMENTAL_ENABLED,
        YAHOO_WEB_EXPERIMENTAL_MAX_PAGES: process.env.YAHOO_WEB_EXPERIMENTAL_MAX_PAGES,
        YAHOO_WEB_EXPERIMENTAL_DELAY_MS: process.env.YAHOO_WEB_EXPERIMENTAL_DELAY_MS,
      },
      signal: AbortSignal.timeout(15_000),
    }));
    stage = "response";
    response.status(200).json({ ok: true, data: result, meta: { ...runtimeMeta(), cacheStatus } });
  } catch (error) {
    if (stage === "upstream_search" && error instanceof AdapterError) {
      adapterFailure(response, error, "Yahoo! Shopping");
      return;
    }
    unexpectedServiceFailure(response, error, { sourceId: "yahoo_shopping", sourceLabel: "Yahoo! Shopping", stage });
  }
}
