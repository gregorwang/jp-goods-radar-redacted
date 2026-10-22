/**
 * 关键词日报每件商品下面附带的价格参考，按档案开关。
 *
 * 日报发信前调 teika-lookup 的 /enrich（apps/collector/src/listing-enrich.ts），拿回三样东西：
 * 按标题查到的官方定価、模型看标题估的「AI 预测价」、核对过标题的同款成交。有的档案
 * 根本用不着原价（2026-10-11：赛车初音只想知道上了什么新货），那几行就是噪音；AI 预测价还要
 * 唤醒 Modal 的 GPU，按开机秒数计费。所以开关管的是「请不请求」，不只是「显不显示」。
 *
 * 用户看到的是「原价」和「同款成交」两件事，不按接口分：官方定価和 AI 预测价都是为了回答
 * 「原价多少」。中间那档给信得过查到的定価、但不信模型估计的人。
 *
 * 每个档案一个设置，发信时只看自己档案的。「新档案默认值」只在建档时读一次，不是总开关。
 * 默认 = 全开 = 加开关之前的样子：这里管一封要发的邮件里多几行，不是发不发，
 * 不受 AGENTS.md §4「默认最严」约束，存量档案也不该一上线就少了内容。
 */

export const DIGEST_PRICE_REFERENCES = ["official_and_ai", "official_only", "off"] as const;
export type DigestPriceReference = (typeof DIGEST_PRICE_REFERENCES)[number];

export interface DigestExtras {
  /** 原价那一行：官方定価 + AI 预测价 / 只要官方定価 / 不显示。 */
  priceReference: DigestPriceReference;
  /** 同款行情、同款成交。 */
  showSales: boolean;
}

export const DEFAULT_DIGEST_EXTRAS: DigestExtras = { priceReference: "official_and_ai", showSales: true };

/** runtime_feature_flags 里存「新建关键词档案默认值」的那一行。 */
export const DIGEST_EXTRAS_DEFAULTS_FLAG = "keyword_digest_extras_defaults";

export function isDigestPriceReference(value: unknown): value is DigestPriceReference {
  return typeof value === "string" && (DIGEST_PRICE_REFERENCES as readonly string[]).includes(value);
}

/**
 * 从库里的两列读出设置。读不懂的值一律退回默认（全开）：宁可多显示几行，
 * 也不能因为一个脏值让整封日报的价格参考静默消失。
 */
export function digestExtrasFromColumns(priceReference: unknown, showSales: unknown): DigestExtras {
  return {
    priceReference: isDigestPriceReference(priceReference) ? priceReference : DEFAULT_DIGEST_EXTRAS.priceReference,
    showSales: showSales === null || showSales === undefined ? DEFAULT_DIGEST_EXTRAS.showSales : Number(showSales) !== 0,
  };
}

/**
 * 读日报载荷里的 `digestExtras`。加开关之前的载荷没有这个字段，按全开渲染——
 * 和它们当初发出去的样子一致。
 */
export function digestExtrasFromPayload(value: unknown): DigestExtras {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_DIGEST_EXTRAS;
  const record = value as Record<string, unknown>;
  return {
    priceReference: isDigestPriceReference(record.priceReference) ? record.priceReference : DEFAULT_DIGEST_EXTRAS.priceReference,
    showSales: typeof record.showSales === "boolean" ? record.showSales : DEFAULT_DIGEST_EXTRAS.showSales,
  };
}

/** 读 runtime_feature_flags.config_json 里的默认值；读不懂就用内置默认。 */
export function digestExtrasFromDefaultsConfig(configJson: unknown): DigestExtras {
  if (typeof configJson !== "string") return DEFAULT_DIGEST_EXTRAS;
  try {
    return digestExtrasFromPayload(JSON.parse(configJson));
  } catch {
    return DEFAULT_DIGEST_EXTRAS;
  }
}

/** 这套设置要不要调 /enrich、要不要让它估价。两项都关就整个不调。 */
export function digestEnrichPlan(extras: DigestExtras): { call: boolean; estimate: boolean; officialPrice: boolean; sales: boolean } {
  const officialPrice = extras.priceReference !== "off";
  return {
    call: officialPrice || extras.showSales,
    estimate: extras.priceReference === "official_and_ai",
    officialPrice,
    sales: extras.showSales,
  };
}
