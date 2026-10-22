import type { AdapterContext } from "../../core/src/index.js";
import { AdapterError } from "./http.js";

export function rakutenRequestHeaders(context: AdapterContext, accessKey: string): HeadersInit {
  const configuredUrl = context.secrets.RAKUTEN_APPLICATION_URL;
  if (!configuredUrl) throw new AdapterError("Rakuten 应用 URL 未配置", "rakuten_application_url_missing");
  let applicationUrl: URL;
  try {
    applicationUrl = new URL(configuredUrl);
  } catch {
    throw new AdapterError("Rakuten 应用 URL 无效", "rakuten_application_url_invalid");
  }
  if (applicationUrl.protocol !== "https:") {
    throw new AdapterError("Rakuten 应用 URL 必须使用 HTTPS", "rakuten_application_url_invalid");
  }
  return {
    accessKey,
    Origin: applicationUrl.origin,
    Referer: applicationUrl.href,
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JP-Goods-Radar/0.1 (+${applicationUrl.origin}/)`,
  };
}

/**
 * 乐天开放 API 按应用配额限流（官方规则是每秒一次），超了直接返回 429。
 *
 * 请求间隔本身由 collector 的 `request-pacer.ts` 负责：乐天的 fetch 一律包了
 * `createPacedFetch`，同一次 Worker 调用里的乐天请求被串行化并留出固定间隔。
 * 这里只补它补不了的那一半——**真撞上 429 时把这一页救回来**。
 *
 * 为什么必须补：`collectMarketWindow` 的后续页失败是被容忍的（保留已采到的页、
 * 停止回溯、整轮仍报 success），所以一次 429 不会让整轮失败，只会让窗口静默地停在
 * 当前页。生产实测 09-05 路人女主的锚定轮就是这样只翻到第 1 页——8 页预算里第 2 页
 * 吃了 429，整轮仍报 success，锚定深度停在 30 条。
 *
 * 而且限流并不严格等价于"每秒一次"：同一天里间隔 0.27s 的请求拿到 200、
 * 间隔 1.06s 的却吃了 429（且那 1.06s 已经是 pacer 排出来的间隔）。Workers 的出口 IP
 * 是共享的，配额之外还叠了别的维度。所以拉间隔只能降低概率，落地必须能自己爬起来。
 */
const RAKUTEN_MIN_RETRY_DELAY_MS = 1_300;
const RAKUTEN_MAX_RETRY_DELAY_MS = 5_000;

function rakutenRetryDelayMs(error: AdapterError): number {
  const advertised = typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds * 1_000 : 0;
  return Math.min(Math.max(advertised, RAKUTEN_MIN_RETRY_DELAY_MS), RAKUTEN_MAX_RETRY_DELAY_MS);
}

/** 撞上乐天的应用配额时按 retry-after 退避重试一次，而不是把这一页丢给调用方静默吞掉。 */
export async function withRakutenRateLimit<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AdapterError) || error.status !== 429) throw error;
    await new Promise((resolve) => setTimeout(resolve, rakutenRetryDelayMs(error)));
    return await run();
  }
}
