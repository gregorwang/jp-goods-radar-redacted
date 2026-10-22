const textEncoder = new TextEncoder();

/**
 * 免费层级的硬上限。超过这两个数就是 429，不是配置问题。
 * 具体数字以 AI Studio 的 Rate limit 面板为准（官方文档不列每个模型的值）。
 */
export const GEMINI_FREE_TIER_TPM_LIMIT = 250_000;
export const GEMINI_FREE_TIER_RPM_LIMIT = 20;

/**
 * 模型自身的物理上限（gemini-3.5-flash-lite）：
 * 输入 1,048,576 token，输出 65,536 token。
 * 批量大小最终由**输出**上限决定，不是输入——见下面 listingMaxBatchItems 的说明。
 */
export const GEMINI_MODEL_INPUT_TOKEN_LIMIT = 1_048_576;
export const GEMINI_MODEL_OUTPUT_TOKEN_LIMIT = 65_536;

export interface GeminiSchedulerLimits {
  /** 每分钟输入 token 预算，滑动窗口按 `gemini_token_reservations` 记账。 */
  tpmBudget: number;
  /** 每分钟请求数预算，滑动窗口按 `gemini_request_reservations` 记账。 */
  rpmBudget: number;
  /** 单次请求的 token 预算，覆盖输入 + 每件的输出预留之和。 */
  requestTokenBudget: number;
  /** 每件商品预留多少输出 token。 */
  listingOutputTokenReserve: number;
  /** 单次请求最多塞几件商品。 */
  listingMaxBatchItems: number;
}

/**
 * 默认值全部来自 2026-09-09 的生产实测，不是拍的：
 *
 * | 量 | 实测 | 原来写死的值 |
 * |---|---|---|
 * | 输入 | 539 token/件 | — |
 * | 输出 | 462 token/件（P95 539，最大 619） | 每件预留 3,000（**超配 6.5 倍**） |
 * | 每批件数 | 输出上限允许约 105 件 | 硬编码 10 |
 *
 * 样本：1016 件商品的投影后载荷 + 88 件真实模型输出。
 *
 * **为什么 listingMaxBatchItems 是 32 而不是 100。**
 * 物理上限确实允许 100 件（65,536 ÷ 619 ≈ 105），但真正的约束不是 token，
 * 是**一次解析失败的影响面**：整条响应解析不出来时，这一批每一件都会消耗一次
 * `MAX_ITEM_PARSE_ATTEMPTS`（共 3 次）。批量 10 时一次失败牵连 10 件，
 * 批量 100 时牵连 100 件。32 是"请求数砍到 1/3"和"失败面可控"之间的取舍，
 * 而且对 32 件仍有 3.3 倍的输出余量（32 × 619 = 19,808 < 65,536）。
 * 想再往上推就调 `GEMINI_LISTING_MAX_BATCH_ITEMS`，上限 96。
 */
export const GEMINI_SCHEDULER_DEFAULTS: GeminiSchedulerLimits = {
  // 原来是 200,000，留了 50,000 空转。改成留 10,000。
  tpmBudget: 240_000,
  // 原来是 18。留 1 个给共用同一把 key 的其它任务（product_target）。
  rpmBudget: 19,
  // 原来是 80,000，只用掉输入上限的 7.6%。
  requestTokenBudget: 200_000,
  // 实测最大 619，取 2 倍冗余。原来是 3,000。
  listingOutputTokenReserve: 1_200,
  // 原来是 10。
  listingMaxBatchItems: 32,
};

function clampedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * 从环境变量读取，每个值都夹在物理上限内——**调错了也不会打爆免费额度**，
 * 最多是退回默认行为。这几个数以前写死在代码里，改一次要发一次版；
 * 现在它们是 `wrangler.jsonc` 里的 vars。
 *
 * `requestTokenBudget` 额外夹一层 `tpmBudget`：单次请求超过一整分钟的预算，
 * 滑动窗口就永远排不进去，任务会静默卡在 `waiting_rate_limit`。
 */
export function resolveGeminiSchedulerLimits(env: Record<string, unknown> = {}): GeminiSchedulerLimits {
  const tpmBudget = clampedInteger(
    env.GEMINI_TPM_BUDGET, GEMINI_SCHEDULER_DEFAULTS.tpmBudget, 10_000, GEMINI_FREE_TIER_TPM_LIMIT,
  );
  return {
    tpmBudget,
    rpmBudget: clampedInteger(
      env.GEMINI_RPM_BUDGET, GEMINI_SCHEDULER_DEFAULTS.rpmBudget, 1, GEMINI_FREE_TIER_RPM_LIMIT,
    ),
    requestTokenBudget: Math.min(tpmBudget, clampedInteger(
      env.GEMINI_REQUEST_TOKEN_BUDGET, GEMINI_SCHEDULER_DEFAULTS.requestTokenBudget,
      10_000, GEMINI_MODEL_INPUT_TOKEN_LIMIT,
    )),
    listingOutputTokenReserve: clampedInteger(
      env.GEMINI_LISTING_OUTPUT_TOKEN_RESERVE, GEMINI_SCHEDULER_DEFAULTS.listingOutputTokenReserve,
      200, 8_000,
    ),
    listingMaxBatchItems: clampedInteger(
      env.GEMINI_LISTING_MAX_BATCH_ITEMS, GEMINI_SCHEDULER_DEFAULTS.listingMaxBatchItems, 1, 96,
    ),
  };
}

/** @deprecated 用 `resolveGeminiSchedulerLimits(env)`；保留只为不改动其它调用点。 */
export const GEMINI_SCHEDULER_TPM_BUDGET = GEMINI_SCHEDULER_DEFAULTS.tpmBudget;
/** @deprecated 同上。 */
export const GEMINI_SCHEDULER_RPM_BUDGET = GEMINI_SCHEDULER_DEFAULTS.rpmBudget;
/** @deprecated 同上。 */
export const GEMINI_REQUEST_INPUT_TOKEN_BUDGET = GEMINI_SCHEDULER_DEFAULTS.requestTokenBudget;
/** @deprecated 同上。 */
export const GEMINI_LISTING_OUTPUT_TOKEN_RESERVE = GEMINI_SCHEDULER_DEFAULTS.listingOutputTokenReserve;
export const GEMINI_MAX_RETRY_DELAY_SECONDS = 86_400;

/**
 * Google does not expose a local tokenizer for the model alias. UTF-8 bytes / 2
 * is deliberately conservative for mixed Japanese, Chinese and JSON input.
 */
export function estimateGeminiInputTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(textEncoder.encode(serialized).byteLength / 2));
}

export function takeGeminiTokenBudgetBatch<T>(
  items: readonly T[],
  buildRequest: (candidate: readonly T[]) => unknown,
  tokenBudget = GEMINI_REQUEST_INPUT_TOKEN_BUDGET,
  estimatedOutputTokensPerItem = 0,
): { items: T[]; estimatedInputTokens: number } {
  if (items.length === 0) return { items: [], estimatedInputTokens: 0 };
  const selected: T[] = [];
  let estimatedInputTokens = 0;
  for (const item of items) {
    const candidate = [...selected, item];
    const candidateTokens = estimateGeminiInputTokens(buildRequest(candidate));
    const candidateBudgetTokens = candidateTokens + candidate.length * estimatedOutputTokensPerItem;
    if (selected.length > 0 && candidateBudgetTokens > tokenBudget) break;
    selected.push(item);
    estimatedInputTokens = candidateTokens;
    if (candidateBudgetTokens >= tokenBudget) break;
  }
  return { items: selected, estimatedInputTokens };
}

function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/u);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined;
}

function retryInfoSeconds(value: unknown): number[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(retryInfoSeconds);
  const record = value as Record<string, unknown>;
  const current = typeof record["@type"] === "string" && record["@type"].endsWith("google.rpc.RetryInfo")
    ? durationSeconds(record.retryDelay)
    : undefined;
  return [
    ...(current === undefined ? [] : [current]),
    ...Object.values(record).flatMap(retryInfoSeconds),
  ];
}

function retryAfterSeconds(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.max(1, Math.ceil(numeric));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(1, Math.ceil((timestamp - nowMs) / 1_000));
}

export function parseGeminiRetryDelaySeconds(
  headers: Pick<Headers, "get">,
  responseText: string,
  nowMs = Date.now(),
): number {
  const candidates: number[] = [];
  const headerDelay = retryAfterSeconds(headers.get("retry-after"), nowMs);
  if (headerDelay !== undefined) candidates.push(headerDelay);
  try {
    candidates.push(...retryInfoSeconds(JSON.parse(responseText) as unknown));
  } catch {
    // A bounded default is used when Google did not return its normal JSON error.
  }
  const delay = Math.max(60, ...candidates);
  return Math.min(GEMINI_MAX_RETRY_DELAY_SECONDS, delay);
}

function compact(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/((?:api[-_ ]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[redacted]")
    .replace(/https?:\/\/\S+/gu, "[redacted-url]")
    .replace(/[A-Za-z0-9_-]{40,}/gu, "[redacted-value]")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

export function safeGeminiTransportError(responseText: string): string {
  let candidate = responseText;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>).error;
      if (error !== null && typeof error === "object" && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") candidate = message;
      }
    }
  } catch {
    // Preserve a bounded plain-text transport error when JSON decoding fails.
  }
  return compact(candidate) || "响应正文为空";
}
