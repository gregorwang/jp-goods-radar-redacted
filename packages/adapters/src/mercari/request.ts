import { AdapterError, fetchJson } from "../http.js";
import type { DpopSigner } from "./dpop.js";
import {
  MercariBlockedError,
  MercariDpopError,
  MercariInvalidRequestError,
  MercariItemGoneError,
  MercariRateLimitError,
} from "./errors.js";

const ITEM_GONE_CODES = new Set(["InvisibleItemException", "ItemNotFound", "NotFound"]);
const ITEM_GONE_SUB_CODES = new Set(["404", "410"]);

/**
 * Mercari 用同一个 403 表达"被反爬拦下"和"这条商品没了"，只能靠错误体里的
 * 自有错误码区分。分不清的代价很实际：一条被卖家删除的商品会被当成来源封禁，
 * 每天重试不说，还会向上申请 12 小时的来源级冷却，把整个来源一起拖停。
 */
function isItemGone(error: AdapterError): boolean {
  return (error.upstreamCode !== undefined && ITEM_GONE_CODES.has(error.upstreamCode))
    || (error.upstreamSubCode !== undefined && ITEM_GONE_SUB_CODES.has(error.upstreamSubCode));
}

export async function mercariJson(
  fetcher: typeof fetch,
  signer: DpopSigner,
  url: URL,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const proof = await signer.createProof(method, url.href);
  try {
    return await fetchJson(fetcher, url, {
      method,
      signal,
      headers: {
        DPoP: proof,
        "X-Platform": "web",
        "X-Country-Code": "JP",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    if (error.status === 404 || error.status === 410 || isItemGone(error)) throw new MercariItemGoneError();
    if (error.status === 400 && error.upstreamCode === "InvalidArgument") throw new MercariInvalidRequestError();
    if (error.status === 400 || error.status === 401) throw new MercariDpopError("Mercari 拒绝了 DPoP 请求");
    if (error.status === 403) throw new MercariBlockedError();
    if (error.status === 429) throw new MercariRateLimitError(error.retryAfterSeconds);
    throw error;
  }
}
