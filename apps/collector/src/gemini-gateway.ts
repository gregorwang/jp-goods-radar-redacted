const GOOGLE_AI_STUDIO_HOST = "generativelanguage.googleapis.com";
const GOOGLE_AI_STUDIO_PROVIDER = "google-ai-studio";

type AiGatewayBinding = {
  gateway: (id: string) => {
    getUrl: (provider?: string) => Promise<string>;
  };
};

type GeminiGatewayEnv = Env & {
  AI?: AiGatewayBinding;
  CF_AIG_TOKEN?: string;
  GEMINI_AI_GATEWAY_ID?: string;
  GOOGLE_AI_API_KEY?: string;
};

export interface GeminiProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface GeminiGatewayMetadata {
  jobId: string;
  kind: string;
}

function directGeminiPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== GOOGLE_AI_STUDIO_HOST
    || url.username || url.password || url.port || url.hash) {
    throw new Error("Gemini 请求地址不在 Google AI Studio 白名单内");
  }
  const match = url.pathname.match(/^\/(v1(?:beta)?)\/models\/([^/]+):generateContent$/u);
  if (!match?.[1] || !match[2]) throw new Error("Gemini 请求地址不是受支持的 generateContent 端点");
  return `${match[1]}/models/${match[2]}:generateContent`;
}

/**
 * 生产环境通过 Cloudflare AI Gateway 的原生 Google AI Studio 端点发送请求。
 * `env.AI.gateway().getUrl()` 只负责生成 provider-native URL；开启 Gateway
 * authentication 后，实际 HTTP 请求仍必须携带 `cf-aig-authorization`。
 * Google 凭据由 Gateway 后台保存的 BYOK 注入，不从 Worker 转发。
 *
 * 未配置 Gateway 时保留直连路径，供本地开发和显式回滚使用。
 */
export async function routeGeminiProviderRequest(
  rawEnv: Env,
  request: GeminiProviderRequest,
  metadata: GeminiGatewayMetadata,
): Promise<GeminiProviderRequest> {
  const env = rawEnv as GeminiGatewayEnv;
  const gatewayId = env.GEMINI_AI_GATEWAY_ID?.trim();
  if (!gatewayId) {
    if (!env.GOOGLE_AI_API_KEY?.trim()) throw new Error("Gemini 密钥未配置");
    return request;
  }
  if (!env.AI || typeof env.AI.gateway !== "function") {
    throw new Error(`AI Gateway ${gatewayId} 已启用，但 Worker AI binding 不可用`);
  }
  const gatewayToken = env.CF_AIG_TOKEN?.trim();
  if (!gatewayToken) throw new Error(`AI Gateway ${gatewayId} 已启用，但 CF_AIG_TOKEN 未配置`);

  const providerRoot = (await env.AI.gateway(gatewayId).getUrl(GOOGLE_AI_STUDIO_PROVIDER)).replace(/\/+$/u, "");
  const headers = { ...request.headers };
  // Gateway 使用后台保存的 Google BYOK。避免同时发送旧的 Worker secret，确保
  // 实际凭据和出口都由 Gateway 控制。
  delete headers["x-goog-api-key"];
  delete headers["X-Goog-Api-Key"];
  headers["cf-aig-authorization"] = `Bearer ${gatewayToken}`;
  headers["cf-aig-skip-cache"] = "true";
  headers["cf-aig-metadata"] = JSON.stringify({
    service: "jp-goods-radar-collector",
    job_id: metadata.jobId,
    job_kind: metadata.kind,
  });

  const url = `${providerRoot}/${directGeminiPath(request.url)}`;
  console.info(JSON.stringify({
    event: "gemini_provider_routed",
    provider: GOOGLE_AI_STUDIO_PROVIDER,
    gatewayId,
    jobId: metadata.jobId,
    kind: metadata.kind,
  }));
  return { ...request, url, headers };
}

/**
 * Gateway 后台保存的 Google AI Studio key。每个 key 是独立的免费额度，
 * 调度器按 key 分别记每分钟请求/Token 和 429 冷却。
 * - alias：请求时带的 `cf-aig-byok-alias`，null 表示 Gateway 的 default key
 * - provider：写进 gemini_provider_cooldowns.provider 的冷却键
 * - reservationPrefix：写进预约记录 id 的前缀，用来区分是哪个 key 的额度
 */
export interface GeminiKeySlot {
  alias: string | null;
  provider: string;
  reservationPrefix: string;
}

const PRIMARY_KEY_SLOT: GeminiKeySlot = { alias: null, provider: "google-ai-studio", reservationPrefix: "" };
const FALLBACK_KEY_SLOT: GeminiKeySlot = {
  alias: "google-2",
  provider: "google-ai-studio:google-2",
  reservationPrefix: "google-2:",
};

/** 按优先级返回可用的 key；直连模式没有别名可换，只有主 key。 */
export function geminiKeySlots(rawEnv: Env): GeminiKeySlot[] {
  return (rawEnv as GeminiGatewayEnv).GEMINI_AI_GATEWAY_ID?.trim()
    ? [PRIMARY_KEY_SLOT, FALLBACK_KEY_SLOT]
    : [PRIMARY_KEY_SLOT];
}

/**
 * 用调度器选中的 key 发请求。Google 按出口 IP 判定地区时会偶发 400，额度满时
 * 返回 429；遇到这两种状态立刻换另一个 key 再发一次。返回最终响应和实际用的
 * key，调用方据此把 429 冷却记在对应的 key 上。
 */
export async function fetchGeminiWithFallbackKey(
  providerRequest: GeminiProviderRequest,
  timeoutMilliseconds: number,
  metadata: GeminiGatewayMetadata,
  preferred: GeminiKeySlot,
): Promise<{ response: Response; slot: GeminiKeySlot }> {
  const send = (slot: GeminiKeySlot) => fetch(providerRequest.url, {
    method: "POST",
    headers: slot.alias
      ? { ...providerRequest.headers, "cf-aig-byok-alias": slot.alias }
      : providerRequest.headers,
    body: JSON.stringify(providerRequest.body),
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const first = await send(preferred);
  const viaGateway = "cf-aig-authorization" in providerRequest.headers;
  if (!viaGateway || (first.status !== 400 && first.status !== 429)) return { response: first, slot: preferred };
  const other = preferred === FALLBACK_KEY_SLOT ? PRIMARY_KEY_SLOT : FALLBACK_KEY_SLOT;
  await first.body?.cancel();
  console.warn(JSON.stringify({
    event: "gemini_fallback_key_used",
    firstStatus: first.status,
    from: preferred.alias ?? "default",
    to: other.alias ?? "default",
    jobId: metadata.jobId,
    kind: metadata.kind,
  }));
  return { response: await send(other), slot: other };
}
