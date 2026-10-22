import {
  DIGEST_PRICE_REFERENCES,
  MONITOR_DELIVERY_MODES,
  MONITOR_EVENT_TYPES,
  MONITOR_STALE_SOURCE_POLICIES,
  PRICE_REFERENCE_KINDS,
  PRICE_SHIPPING_STATUSES,
  PRICE_TAX_STATUSES,
  PRODUCT_COMPLETENESS_FILTERS,
  PRODUCT_DISPLAY_FACT_GROUPS,
  parseRakutenIchibaItemUrl,
  parseSourceItemUrl,
  SOURCE_IDS,
  WATCH_DOSSIER_KINDS,
} from "@jpgr/core";
import { z } from "zod";

export const sourceIdSchema = z.enum(SOURCE_IDS);

const sourceHosts: Record<(typeof SOURCE_IDS)[number], readonly string[]> = {
  rakuten_ichiba: ["item.rakuten.co.jp", "search.rakuten.co.jp", "hb.afl.rakuten.co.jp"],
  rakuten_books: ["books.rakuten.co.jp", "hb.afl.rakuten.co.jp"],
  yahoo_shopping: ["store.shopping.yahoo.co.jp", "shopping.yahoo.co.jp"],
  yahoo_auctions_jp: ["auctions.yahoo.co.jp"],
  yahoo_fleamarket_jp: ["paypayfleamarket.yahoo.co.jp"],
  amazon_jp: ["amazon.co.jp", "www.amazon.co.jp"],
  ebay: ["ebay.com", "www.ebay.com"],
  mercari_jp: ["jp.mercari.com"],
  surugaya: ["suruga-ya.jp", "www.suruga-ya.jp"],
  charaon: ["charaon.jp", "www.charaon.jp"],
  cospa: ["cospa.com", "www.cospa.com"],
  animate: ["animate-onlineshop.jp", "www.animate-onlineshop.jp"],
  amiami: ["www.amiami.com", "www.amiami.jp"],
};

const availabilitySchema = z.enum(["available", "sold_out", "unavailable", "preorder", "backorder", "unknown"]);

const productIdentifiersSchema = z.object({
  jan: z.string().trim().min(1).max(32).optional(),
  isbn: z.string().trim().min(1).max(32).optional(),
  asin: z.string().trim().min(1).max(32).optional(),
  sku: z.string().trim().min(1).max(160).optional(),
  modelNumber: z.string().trim().min(1).max(160).optional(),
  sourceCatalogId: z.string().trim().min(1).max(160).optional(),
}).strict();

const productDisplayFactBaseShape = {
  key: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
  label: z.string().trim().min(1).max(80),
  group: z.enum(PRODUCT_DISPLAY_FACT_GROUPS),
};

export const productDisplayFactSchema = z.discriminatedUnion("kind", [
  z.object({
    ...productDisplayFactBaseShape,
    kind: z.literal("text"),
    value: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    ...productDisplayFactBaseShape,
    kind: z.literal("list"),
    values: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  }).strict(),
]);

const productDisplayFactsSchema = z.array(productDisplayFactSchema).max(40).superRefine((facts, context) => {
  const keys = new Set<string>();
  facts.forEach((fact, index) => {
    if (keys.has(fact.key)) {
      context.addIssue({ code: "custom", path: [index, "key"], message: "扩展商品字段 key 不能重复" });
    }
    keys.add(fact.key);
  });
});

export const listingPriceContextSchema = z.object({
  taxStatus: z.enum(PRICE_TAX_STATUSES),
  shippingStatus: z.enum(PRICE_SHIPPING_STATUSES),
}).strict();

export const priceReferenceFactSchema = listingPriceContextSchema.extend({
  kind: z.enum(PRICE_REFERENCE_KINDS),
  amountJpy: z.number().int().positive().max(1_000_000_000),
  currency: z.literal("JPY"),
  sourceLabel: z.string().trim().min(1).max(200),
}).strict();

const priceReferenceFactsSchema = z.array(priceReferenceFactSchema).max(12).superRefine((facts, context) => {
  const keys = new Set<string>();
  facts.forEach((fact, index) => {
    const key = `${fact.kind}:${fact.amountJpy}:${fact.sourceLabel}`;
    if (keys.has(key)) {
      context.addIssue({ code: "custom", path: [index], message: "参考价格事实不能重复" });
    }
    keys.add(key);
  });
});

export const productFactsSchema = z.object({
  identifiers: productIdentifiersSchema.optional(),
  brand: z.string().trim().min(1).max(200).optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  distributor: z.string().trim().min(1).max(200).optional(),
  workTitle: z.string().trim().min(1).max(300).optional(),
  series: z.string().trim().min(1).max(300).optional(),
  characters: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  categoryPath: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  tags: z.array(z.string().trim().min(1).max(200)).max(80).optional(),
  releaseDate: z.string().trim().min(1).max(40).optional(),
  preorderDeadline: z.string().trim().min(1).max(40).optional(),
  imageUrls: z.array(z.url({ protocol: /^https$/ })).max(30).optional(),
  specifications: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(1_000),
  }).strict()).max(50).optional(),
  variants: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(300),
    availability: availabilitySchema.optional(),
    priceJpy: z.number().int().nonnegative().optional(),
  }).strict()).max(100).optional(),
  displayFacts: productDisplayFactsSchema.optional(),
  priceContext: listingPriceContextSchema.optional(),
  priceReferences: priceReferenceFactsSchema.optional(),
  sourceAvailabilityLabel: z.string().trim().min(1).max(200).optional(),
  sourceConditionLabel: z.string().trim().min(1).max(200).optional(),
  provenance: z.record(z.string(), z.object({
    method: z.enum(["official_api", "internal_api", "json_ld", "html", "managed_api"]),
    sourceLabel: z.string().trim().min(1).max(200).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict()).optional(),
}).strict();

export const normalizedListingSchema = z.object({
  sourceId: sourceIdSchema,
  sourceItemId: z.string().trim().min(1).max(300),
  identityScope: z.enum(["listing", "catalog", "offer"]),
  canonicalUrl: z.url({ protocol: /^https$/ }),
  title: z.string().trim().min(1).max(1_000),
  descriptionExcerpt: z.string().max(2_500).optional(),
  imageUrl: z.url({ protocol: /^https$/ }).optional(),
  sellerName: z.string().trim().min(1).max(300).optional(),
  shopName: z.string().trim().min(1).max(300).optional(),
  currency: z.string().trim().min(3).max(8),
  currentPrice: z.number().int().nonnegative().optional(),
  originalPrice: z.number().int().nonnegative().optional(),
  priceBasis: z.enum(["listing_price", "catalog_price", "offer_price", "auction_current_bid"]),
  condition: z.enum(["new", "used", "collectible", "refurbished", "unknown"]),
  availability: availabilitySchema,
  sourceListedAt: z.string().trim().min(1).max(80).optional(),
  sourceUpdatedAt: z.string().trim().min(1).max(80).optional(),
  facts: productFactsSchema.optional(),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (!isAllowedSourceUrl(value.sourceId, value.canonicalUrl)) {
    context.addIssue({ code: "custom", path: ["canonicalUrl"], message: "商品链接与声明的来源不匹配" });
  }
});

export const searchResultSchema = z.object({
  sourceId: sourceIdSchema,
  listings: z.array(normalizedListingSchema).max(500),
  coverage: z.enum(["complete", "rolling_window", "best_effort", "unknown"]),
  nextCursor: z.string().max(500).optional(),
  totalAvailable: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string().max(500)).max(30),
  parserVersion: z.string().trim().min(1).max(200),
  fetchedAt: z.string().trim().min(1).max(80),
  requestEvidence: z.object({
    availabilityMode: z.enum(["purchasable", "all", "sold_out"]),
    requestedStatuses: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    rawResultCount: z.number().int().nonnegative(),
    normalizedResultCount: z.number().int().nonnegative(),
    pagesFetched: z.number().int().positive(),
    keywordRawResultCount: z.number().int().nonnegative().optional(),
    liveDetailResultCount: z.number().int().nonnegative().optional(),
    anchorCandidateCount: z.number().int().nonnegative().optional(),
    parserAcceptedCount: z.number().int().nonnegative().optional(),
    parserRejectedCount: z.number().int().nonnegative().optional(),
    collectionOutcome: z.enum(["items", "verified_empty"]).optional(),
  }).strict().optional(),
}).strict();

export function isAllowedSourceUrl(source: (typeof SOURCE_IDS)[number] | "auto", value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (source === "auto") return Object.values(sourceHosts).some((hosts) => hosts.includes(url.hostname));
    return sourceHosts[source].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateBindingUrls(value: { source: (typeof SOURCE_IDS)[number]; searchUrl?: string | null; targetUrl?: string | null }, context: z.RefinementCtx): void {
  if (value.searchUrl && !isAllowedSourceUrl(value.source, value.searchUrl)) {
    context.addIssue({ code: "custom", message: "搜索 URL 不在该来源的安全域名列表", path: ["searchUrl"] });
  }
  if (value.targetUrl && !isAllowedSourceUrl(value.source, value.targetUrl)) {
    context.addIssue({ code: "custom", message: "商品 URL 不在该来源的安全域名列表", path: ["targetUrl"] });
  }
}

export const productFingerprintSchema = z.object({
  referenceUrl: z.url({ protocol: /^https$/ }).max(500).optional(),
  canonicalName: z.string().trim().min(1).max(200).optional(),
  workTitle: z.string().trim().max(160).optional(),
  characters: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
  productType: z.string().trim().max(100).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  series: z.string().trim().max(160).optional(),
  model: z.string().trim().max(100).optional(),
  jan: z.string().trim().regex(/^\d{8,14}$/, "JAN 必须是 8 至 14 位数字").optional(),
  size: z.string().trim().max(80).optional(),
  color: z.string().trim().max(80).optional(),
  /**
   * 版本与限定标记（♭ / Fes. Fine / レーシングVer. / F：NEX限定 …）。
   * 这是这个领域真正的判别符，此前指纹里根本没有槽位可放。
   */
  edition: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
  /** 指纹是否来自 AI 抽取；true 时计划构建不再用启发式覆盖它。 */
  aiExtracted: z.boolean().optional(),
  aliases: z.array(z.string().trim().min(1).max(160)).max(12).default([]),
  recallQueries: z.array(z.string().trim().min(1).max(200)).max(4).default([]),
  requiredTermGroups: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  supportingTermGroups: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  excludedTerms: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
}).strict().superRefine((value, context) => {
  if (value.referenceUrl && !isAllowedSourceUrl("auto", value.referenceUrl)) {
    context.addIssue({ code: "custom", message: "锚点链接不属于已接入来源", path: ["referenceUrl"] });
  }
});

export const productTargetExtractionRequestSchema = z.object({
  canonicalName: z.string().trim().min(1).max(200),
}).strict();

export const productTargetExtractionSchema = z.object({
  workTitle: z.string().trim().max(160).nullable().catch(null),
  characters: z.array(z.string().trim().min(1).max(100)).max(8).catch([]),
  productType: z.string().trim().max(100).nullable().catch(null),
  edition: z.array(z.string().trim().min(1).max(100)).max(8).catch([]),
  size: z.string().trim().max(80).nullable().catch(null),
  color: z.string().trim().max(80).nullable().catch(null),
  manufacturer: z.string().trim().max(120).nullable().catch(null),
  series: z.string().trim().max(160).nullable().catch(null),
  recallQueries: z.array(z.string().trim().min(1).max(60)).max(4).catch([]),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
}).passthrough();

export type ProductTargetExtraction = z.infer<typeof productTargetExtractionSchema>;
export type ProductTargetExtractionRequest = z.infer<typeof productTargetExtractionRequestSchema>;

export const searchPreviewSchema = z.object({
  query: z.string().trim().min(1).max(200),
  mode: z.enum(["keyword", "exact_product"]).default("keyword"),
  execution: z.enum(["sync", "workflow"]).default("sync"),
  target: productFingerprintSchema.optional(),
  searchSessionId: z.string().uuid().optional(),
  sources: z.array(sourceIdSchema).min(1).max(11).refine((sources) => new Set(sources).size === sources.length, {
    message: "搜索来源不能重复",
  }),
  minPrice: z.number().int().nonnegative().optional(),
  maxPrice: z.number().int().nonnegative().optional(),
  conditions: z.array(z.enum(["new", "used", "collectible", "refurbished", "unknown"])).optional(),
  inStockOnly: z.boolean().default(false),
  availabilityMode: z.enum(["purchasable", "all", "sold_out"]).default("all"),
  sourcePageTokens: z.partialRecord(sourceIdSchema, z.string().trim().min(1).max(500)).optional(),
}).superRefine((value, context) => {
  if (value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice) {
    context.addIssue({ code: "custom", message: "最低价不能高于最高价", path: ["minPrice"] });
  }
  const pageTokenSources = Object.keys(value.sourcePageTokens ?? {});
  if (pageTokenSources.length > 0 && !value.searchSessionId) {
    context.addIssue({ code: "custom", message: "加载下一页必须归入原搜索会话", path: ["searchSessionId"] });
  }
  for (const sourceId of pageTokenSources) {
    if (!value.sources.includes(sourceId as (typeof value.sources)[number])) {
      context.addIssue({ code: "custom", message: "分页游标来源必须包含在本次来源中", path: ["sourcePageTokens", sourceId] });
    }
  }
});

export type SearchPreviewInput = z.infer<typeof searchPreviewSchema>;

export const monitoringPurposeSchema = z.enum(["item_price", "keyword_new_listing"]);
export const watchDossierKindSchema = z.enum(WATCH_DOSSIER_KINDS);
export const offerTrackingPolicySchema = z.enum(["search_window", "all_confirmed_offers"]);
export const suspectNoticePolicySchema = z.enum(["confirmed_only", "strong_suspects", "all_suspects"]);
const scheduleIntervalSchema = z.number().int().min(30).max(1440);
const nextRunAtSchema = z.string().trim().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "下一次巡回时间格式无效",
});

function validateMonitoringPurpose(
  value: { kind: "keyword" | "item"; monitoringPurpose?: z.infer<typeof monitoringPurposeSchema> },
  context: z.RefinementCtx,
) {
  if (value.kind === "item" && value.monitoringPurpose && value.monitoringPurpose !== "item_price") {
    context.addIssue({ code: "custom", message: "单品绑定只能用于价格与库存监控", path: ["monitoringPurpose"] });
  }
  if (value.kind === "keyword" && value.monitoringPurpose === "item_price") {
    context.addIssue({ code: "custom", message: "关键词绑定不能使用单品价格监控", path: ["monitoringPurpose"] });
  }
}

const profileBindingSchema = z.object({
  source: sourceIdSchema,
  kind: z.enum(["keyword", "item"]),
  monitoringPurpose: monitoringPurposeSchema.optional(),
  query: z.string().trim().max(200).optional(),
  searchUrl: z.url({ protocol: /^https$/ }).optional(),
  targetUrl: z.url({ protocol: /^https$/ }).optional(),
  intervalMinutes: scheduleIntervalSchema.default(60),
  nextRunAt: nextRunAtSchema.optional(),
  sourceConfig: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, context) => {
  validateBindingUrls(value, context);
  validateMonitoringPurpose(value, context);
  if (value.kind === "keyword" && !value.query && !value.searchUrl) context.addIssue({ code: "custom", message: "关键词订阅需要 query 或 searchUrl", path: ["query"] });
  if (value.kind === "item" && !value.targetUrl) context.addIssue({ code: "custom", message: "单品监控需要 targetUrl", path: ["targetUrl"] });
});

function inferredDossierKind(binding: z.infer<typeof profileBindingSchema>) {
  if (binding.kind === "item") return "item" as const;
  if (binding.sourceConfig.searchMode === "exact_product") return "exact_product" as const;
  return "keyword" as const;
}

const watchProfileObjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dossierKind: watchDossierKindSchema.optional(),
  productVariantId: z.string().trim().regex(/^pv_[a-f0-9]{16,64}$/).optional(),
  productIdentitySearchHistoryId: z.uuid().optional(),
  offerTrackingPolicy: offerTrackingPolicySchema.optional(),
  suspectNoticePolicy: suspectNoticePolicySchema.optional(),
  knownOffers: z.array(z.object({
    source: sourceIdSchema,
    sourceItemId: z.string().trim().min(1).max(300),
  }).strict()).max(100).default([])
    .refine((offers) => new Set(offers.map((offer) => `${offer.source}:${offer.sourceItemId}`)).size === offers.length, "已知报价不能重复"),
  description: z.string().trim().max(500).optional(),
  defaultMaxPrice: z.number().int().nonnegative().optional(),
  includeTerms: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  excludeTerms: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  bindings: z.array(profileBindingSchema).min(1).max(80),
});

export const watchProfileSchema = watchProfileObjectSchema.superRefine((value, context) => {
  const kinds = new Set(value.bindings.map(inferredDossierKind));
  if (kinds.size !== 1) {
    context.addIssue({ code: "custom", path: ["bindings"], message: "一份关注档案只能包含一种监控类型" });
    return;
  }
  const inferred = [...kinds][0]!;
  if (value.dossierKind && value.dossierKind !== inferred) {
    context.addIssue({ code: "custom", path: ["dossierKind"], message: "档案类型与绑定配置不一致" });
  }
  if (inferred !== "exact_product") {
    if (value.productVariantId !== undefined || value.productIdentitySearchHistoryId !== undefined
      || value.offerTrackingPolicy !== undefined || value.suspectNoticePolicy !== undefined
      || value.knownOffers.length > 0) {
      context.addIssue({ code: "custom", path: ["productVariantId"], message: "只有精确同款档案可以绑定稳定商品版本" });
    }
    return;
  }
  value.bindings.forEach((binding, index) => {
    if (binding.monitoringPurpose && binding.monitoringPurpose !== "keyword_new_listing") {
      context.addIssue({ code: "custom", path: ["bindings", index, "monitoringPurpose"], message: "精确同款雷达的父任务必须持续执行商品发现；命中商品会另行自动跟踪" });
    }
    const target = productFingerprintSchema.safeParse(binding.sourceConfig.productTarget);
    if (!target.success) {
      context.addIssue({ code: "custom", path: ["bindings", index, "sourceConfig", "productTarget"], message: "精确同款雷达缺少有效的商品指纹" });
    }
  });
});

export const watchProfilePatchSchema = watchProfileObjectSchema.omit({
  bindings: true,
  dossierKind: true,
  productVariantId: true,
  productIdentitySearchHistoryId: true,
  offerTrackingPolicy: true,
  suspectNoticePolicy: true,
  knownOffers: true,
}).partial().extend({
  enabled: z.boolean().optional(),
  /** 关键词档案的送达门槛：低于这个价的商品不进日报（null = 不限）。不改搜索范围，所以不重置基线。 */
  minListingPrice: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
});

export const watchListingTrackingActionSchema = z.object({
  action: z.enum(["track", "dismiss", "purchased"]),
}).strict();

/** 「疑似同款」候选的用户判定。候选还不是匹配，库里没有 listing_id 可用，
 *  所以按来源商品 ID 定位；`restore` 撤销之前的判定。 */
export const watchCandidateDismissalSchema = z.object({
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(200),
  reason: z.enum(["not_same_product", "too_expensive", "restore"]),
}).strict();

export type WatchCandidateDismissal = z.infer<typeof watchCandidateDismissalSchema>;

/** 关键词档案 AI 复核页上的一次判定；undo 撤销这条商品上的判定。 */
export const keywordAiReviewSchema = z.object({
  bindingId: z.string().min(1).max(200),
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(200),
  verdict: z.enum(["ai_correct", "ai_wrong", "undo"]),
}).strict();

export type KeywordAiReview = z.infer<typeof keywordAiReviewSchema>;

/** 屏蔽单品：每组都要在标题里命中，组内 `|` 分隔别名（packages/core/src/muted-products.ts）。 */
const mutedProductTermGroupsSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(6);

export const mutedProductPreviewSchema = z.object({
  termGroups: mutedProductTermGroupsSchema,
}).strict();

/** 日报标注：在某封已发出的日报里给一件商品下结论；undo 撤掉结论。商品信息由服务端从日报载荷里取。 */
export const digestItemLabelSchema = z.object({
  digestEventId: z.string().min(1).max(200),
  sourceId: z.string().min(1).max(80),
  sourceItemId: z.string().min(1).max(300),
  verdict: z.enum(["hide", "keep", "undo"]),
}).strict();

export const mutedProductCreateSchema = z.object({
  termGroups: mutedProductTermGroupsSchema,
  sample: z.object({
    title: z.string().max(500),
    url: z.string().url().max(2000).nullable(),
    imageUrl: z.string().url().max(2000).nullable(),
  }).strict().nullable(),
}).strict();

/**
 * 关键词日报附带的价格参考（packages/core/src/digest-extras.ts）。
 * applyTo=all_keyword 是一次性批量写入全部关键词档案，saveAsDefault 只改以后新建档案的默认值；
 * 两者都不是总开关，发信时仍然只看各档案自己的设置。
 */
export const digestExtrasUpdateSchema = z.object({
  priceReference: z.enum(DIGEST_PRICE_REFERENCES),
  showSales: z.boolean(),
  applyTo: z.enum(["this", "all_keyword"]).default("this"),
  saveAsDefault: z.boolean().default(false),
}).strict();

const monitorEventTypeSchema = z.enum(MONITOR_EVENT_TYPES);
const monitorDeliveryModeSchema = z.enum(MONITOR_DELIVERY_MODES);
const monitorStaleSourcePolicySchema = z.enum(MONITOR_STALE_SOURCE_POLICIES);
const monitorCompletenessSchema = z.enum(PRODUCT_COMPLETENESS_FILTERS);
const monitorConditionSchema = z.enum(["new", "used", "collectible", "refurbished", "unknown"]);
const quietHourSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "静默时间必须使用 HH:mm");

export const monitorRuleSchema = z.object({
  eventTypes: z.array(monitorEventTypeSchema).max(MONITOR_EVENT_TYPES.length)
    .refine((values) => new Set(values).size === values.length, "事件类型不能重复"),
  sourceAllow: z.array(sourceIdSchema).max(SOURCE_IDS.length).default([])
    .refine((values) => new Set(values).size === values.length, "来源白名单不能重复"),
  sourceDeny: z.array(sourceIdSchema).max(SOURCE_IDS.length).default([])
    .refine((values) => new Set(values).size === values.length, "来源排除名单不能重复"),
  conditions: z.array(monitorConditionSchema).max(5).default([])
    .refine((values) => new Set(values).size === values.length, "品相条件不能重复"),
  completeness: z.array(monitorCompletenessSchema).max(3).default([])
    .refine((values) => new Set(values).size === values.length, "完整度条件不能重复"),
  targetListingPrice: z.number().int().nonnegative().nullable().default(null),
  targetLandedCost: z.number().int().nonnegative().nullable().default(null),
  costProfileId: z.string().trim().min(1).max(80).nullable().default(null),
  deliveryMode: monitorDeliveryModeSchema,
  quietHours: z.object({ start: quietHourSchema, end: quietHourSchema }).strict().nullable().default(null),
  timezone: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
  dedupeWindowMinutes: z.number().int().min(1).max(10_080).default(1440),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(180),
  staleSourcePolicy: monitorStaleSourcePolicySchema.default("annotate"),
  enabled: z.boolean().default(true),
  itemSignals: z.object({
    notifyPriceDrop: z.boolean(),
    notifyPriceRise: z.boolean(),
    notifyRestock: z.boolean(),
    notifySoldOut: z.boolean(),
    minDropAmount: z.number().int().nonnegative().max(10_000_000),
  }).strict().nullable().default(null),
  offerTrackingPolicy: offerTrackingPolicySchema.nullable().default(null),
  suspectNoticePolicy: suspectNoticePolicySchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  const denied = new Set(value.sourceDeny);
  value.sourceAllow.forEach((source, index) => {
    if (denied.has(source)) {
      context.addIssue({ code: "custom", path: ["sourceAllow", index], message: "同一来源不能同时允许和排除" });
    }
  });
  if (value.eventTypes.includes("product.offer_below_target_listing_price") && value.targetListingPrice === null) {
    context.addIssue({ code: "custom", path: ["targetListingPrice"], message: "启用目标标价事件时必须填写目标价" });
  }
  if (value.eventTypes.includes("product.offer_below_target_landed_cost")) {
    if (value.targetLandedCost === null) {
      context.addIssue({ code: "custom", path: ["targetLandedCost"], message: "启用目标到手价事件时必须填写目标日元金额" });
    }
    if (value.costProfileId === null) {
      context.addIssue({ code: "custom", path: ["costProfileId"], message: "启用目标到手价事件时必须固定成本档案版本" });
    }
  } else {
    if (value.targetLandedCost !== null) {
      context.addIssue({ code: "custom", path: ["targetLandedCost"], message: "未启用目标到手价事件时不能保存目标值" });
    }
    if (value.costProfileId !== null) {
      context.addIssue({ code: "custom", path: ["costProfileId"], message: "未启用目标到手价事件时不能绑定成本档案" });
    }
  }
  if (value.eventTypes.includes("product.condition_match_seen") && value.conditions.length === 0) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "启用品相命中事件时至少选择一种品相" });
  }
  if (value.eventTypes.includes("product.complete_set_seen") && !value.completeness.includes("complete")) {
    context.addIssue({ code: "custom", path: ["completeness"], message: "启用完整套装事件时必须选择完整" });
  }
});

export const watchBindingSchema = z.object({
  source: sourceIdSchema,
  kind: z.enum(["keyword", "item"]),
  monitoringPurpose: monitoringPurposeSchema.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  searchUrl: z.url({ protocol: /^https$/ }).optional(),
  targetUrl: z.url({ protocol: /^https$/ }).optional(),
  intervalMinutes: scheduleIntervalSchema.default(60),
  nextRunAt: nextRunAtSchema.optional(),
  sourceConfig: z.record(z.string(), z.unknown()).default({}),
  targetPrice: z.number().int().nonnegative().optional(),
  minDropAmount: z.number().int().nonnegative().default(100),
  notifyNewListing: z.boolean().default(true),
  notifyPriceDrop: z.boolean().default(true),
  // 同 notifySoldOut：不给默认值，由 notificationColumns 按来源判定。
  notifyPriceRise: z.boolean().optional(),
  notifyRestock: z.boolean().default(true),
  notifySoldOut: z.boolean().default(true),
}).superRefine((value, context) => {
  validateBindingUrls(value, context);
  validateMonitoringPurpose(value, context);
  if (value.kind === "keyword" && !value.query && !value.searchUrl) {
    context.addIssue({ code: "custom", message: "关键词订阅需要 query 或 searchUrl", path: ["query"] });
  }
  if (value.kind === "item" && !value.targetUrl) {
    context.addIssue({ code: "custom", message: "单品监控需要 targetUrl", path: ["targetUrl"] });
  }
});

export const watchBindingPatchSchema = z.object({
  itemScheduleMode: z.enum(["adaptive", "fixed"]).optional(),
  itemScheduleMaxMinutes: z.union([z.literal(1440), z.literal(2880), z.literal(4320)]).optional(),
  monitoringPurpose: monitoringPurposeSchema.optional(),
  query: z.string().trim().min(1).max(200).nullable().optional(),
  searchUrl: z.url({ protocol: /^https$/ }).nullable().optional(),
  targetUrl: z.url({ protocol: /^https$/ }).nullable().optional(),
  intervalMinutes: scheduleIntervalSchema.optional(),
  nextRunAt: nextRunAtSchema.optional(),
  sourceConfig: z.record(z.string(), z.unknown()).optional(),
  targetPrice: z.number().int().nonnegative().nullable().optional(),
  minDropAmount: z.number().int().nonnegative().optional(),
  notifyNewListing: z.boolean().optional(),
  notifyPriceDrop: z.boolean().optional(),
  // 同 notifySoldOut：不给默认值，由 notificationColumns 按来源判定。
  notifyPriceRise: z.boolean().optional(),
  notifyRestock: z.boolean().optional(),
  notifySoldOut: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).superRefine((value, context) => {
  for (const [key, url] of [["searchUrl", value.searchUrl], ["targetUrl", value.targetUrl]] as const) {
    if (url && !isAllowedSourceUrl("auto", url)) context.addIssue({ code: "custom", message: "URL 不在安全域名列表", path: [key] });
  }
});

export function bindingPatchUrlsMatchSource(
  source: (typeof SOURCE_IDS)[number],
  value: { searchUrl?: string | null; targetUrl?: string | null },
): boolean {
  return (!value.searchUrl || isAllowedSourceUrl(source, value.searchUrl))
    && (!value.targetUrl || isAllowedSourceUrl(source, value.targetUrl));
}

export const itemWatchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.union([sourceIdSchema, z.literal("auto")]),
  kind: z.literal("item"),
  targetUrl: z.url({ protocol: /^https$/ }),
  monitoringPurpose: z.literal("item_price").default("item_price"),
  intervalMinutes: scheduleIntervalSchema.default(180),
  nextRunAt: nextRunAtSchema.optional(),
  minDropAmount: z.number().int().nonnegative().default(100),
  targetPrice: z.number().int().nonnegative().optional(),
  notifyPriceDrop: z.boolean().default(true),
  // 同 notifySoldOut：不给默认值，由 notificationColumns 按来源判定。
  notifyPriceRise: z.boolean().optional(),
  notifyRestock: z.boolean().default(true),
  // 不给默认值：售出通知该不该开由来源的挂牌语义决定（见 notificationColumns），
  // 写死 false 会让一次性挂牌商品售出后永远不通知，而用户在界面上也改不到它。
  notifySoldOut: z.boolean().optional(),
}).superRefine((value, context) => {
  if (!isAllowedSourceUrl(value.source, value.targetUrl)) context.addIssue({ code: "custom", message: "商品 URL 不在安全域名列表", path: ["targetUrl"] });
});

export const rakutenItemWatchUrlSchema = z.object({
  targetUrl: z.url({ protocol: /^https$/ }).max(2_000),
  intervalMinutes: scheduleIntervalSchema.default(30),
  nextRunAt: nextRunAtSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!parseRakutenIchibaItemUrl(value.targetUrl)) {
    context.addIssue({
      code: "custom",
      message: "请粘贴 item.rakuten.co.jp 的乐天市场商品详情链接",
      path: ["targetUrl"],
    });
  }
});

export type RakutenItemWatchUrlInput = z.infer<typeof rakutenItemWatchUrlSchema>;

export const directItemWatchUrlSchema = z.object({
  itemScheduleMode: z.enum(["adaptive", "fixed"]).optional(),
  itemScheduleMaxMinutes: z.union([z.literal(1440), z.literal(2880), z.literal(4320)]).optional(),
  targetUrl: z.url({ protocol: /^https$/ }).max(2_000),
  intervalMinutes: scheduleIntervalSchema.default(30),
  nextRunAt: nextRunAtSchema.optional(),
  minDropAmount: z.number().int().nonnegative().max(10_000_000).default(100),
  targetPrice: z.number().int().nonnegative().max(100_000_000).optional(),
  notifyPriceDrop: z.boolean().default(true),
  // 同 notifySoldOut：不给默认值，由 notificationColumns 按来源判定。
  notifyPriceRise: z.boolean().optional(),
  notifyRestock: z.boolean().default(true),
  notifySoldOut: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (!parseSourceItemUrl(value.targetUrl)) {
    context.addIssue({
      code: "custom",
      message: "请粘贴已支持来源的商品详情链接",
      path: ["targetUrl"],
    });
  }
});

export type DirectItemWatchUrlInput = z.infer<typeof directItemWatchUrlSchema>;

export const listingWatchOptionsSchema = z.object({
  itemScheduleMode: z.enum(["adaptive", "fixed"]).optional(),
  itemScheduleMaxMinutes: z.union([z.literal(1440), z.literal(2880), z.literal(4320)]).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  monitoringPurpose: z.literal("item_price").default("item_price"),
  intervalMinutes: scheduleIntervalSchema.default(180),
  nextRunAt: nextRunAtSchema.optional(),
  minDropAmount: z.number().int().nonnegative().default(100),
  targetPrice: z.number().int().nonnegative().optional(),
  notifyPriceDrop: z.boolean().default(true),
  // 同 notifySoldOut：不给默认值，由 notificationColumns 按来源判定。
  notifyPriceRise: z.boolean().optional(),
  notifyRestock: z.boolean().default(true),
  // 同上：交给 notificationColumns 按来源判定。
  notifySoldOut: z.boolean().optional(),
});

export const previewItemWatchSchema = listingWatchOptionsSchema.extend({
  source: sourceIdSchema,
  sourceItemId: z.string().trim().min(1).max(300),
  targetUrl: z.url({ protocol: /^https$/ }),
  name: z.string().trim().min(1).max(120),
  identityScope: z.enum(["listing", "catalog", "offer"]),
  availability: availabilitySchema.or(z.literal("trading")),
}).superRefine((value, context) => {
  if (!isAllowedSourceUrl(value.source, value.targetUrl)) context.addIssue({ code: "custom", message: "商品 URL 不在该来源的安全域名列表", path: ["targetUrl"] });
});

export type PreviewItemWatchInput = z.infer<typeof previewItemWatchSchema>;

export const previewListingDetailSchema = z.object({
  source: sourceIdSchema,
  sourceItemId: z.string().trim().min(1).max(300),
  targetUrl: z.url({ protocol: /^https$/ }),
}).superRefine((value, context) => {
  if (!isAllowedSourceUrl(value.source, value.targetUrl)) {
    context.addIssue({ code: "custom", message: "商品 URL 不在该来源的安全域名列表", path: ["targetUrl"] });
  }
});

export const listingEnrichmentRequestSchema = normalizedListingSchema.safeExtend({
  sourceConditionLabel: z.string().trim().max(160).optional(),
  category: z.string().trim().max(160).optional(),
}).strict();

export const listingEnrichmentBatchRequestSchema = z.object({
  query: z.string().trim().max(500).default(""),
  items: z.array(listingEnrichmentRequestSchema).min(1).max(1_000),
}).strict();

const enrichmentText = z.string().trim().min(1).max(180);
const enrichmentTitle = z.string().trim().min(1).max(300);

export const MARKET_ANALYSIS_CATEGORIES = [
  "布偶／玩偶",
  "手办／模型",
  "徽章／挂件",
  "亚克力制品",
  "书籍／漫画",
  "影像／音乐",
  "服饰／布制品",
  "文具／纸品",
  "餐厨／生活杂货",
  "卡牌",
  "游戏／电子",
  "其他",
] as const;

export const marketAnalysisCategorySchema = z.enum(MARKET_ANALYSIS_CATEGORIES);

export const listingEnrichmentSchema = z.object({
  relevance: z.enum(["relevant", "irrelevant", "uncertain"]).catch("uncertain"),
  relevanceReason: enrichmentText.nullable().catch(null),
  translatedTitle: enrichmentTitle.nullable().catch(null),
  summary: enrichmentText.nullable().catch(null),
  normalizedCategory: enrichmentText.nullable().catch(null),
  marketCategory: marketAnalysisCategorySchema.catch("其他"),
  productType: enrichmentText.nullable().catch(null),
  workTitle: enrichmentText.nullable().catch(null),
  series: enrichmentText.nullable().catch(null),
  characters: z.array(enrichmentText).max(12).catch([]),
  officialStatus: z.enum(["official", "fanmade", "unknown"]).catch("unknown"),
  normalizedCondition: z.enum(["new", "used", "collectible", "refurbished", "unknown"]).catch("unknown"),
  conditionNotes: z.array(enrichmentText).max(8).catch([]),
  defects: z.array(enrichmentText).max(8).catch([]),
  missingParts: z.array(enrichmentText).max(8).catch([]),
  includedItems: z.array(enrichmentText).max(12).catch([]),
  editionOrModel: enrichmentText.nullable().catch(null),
  extraInfo: z.record(z.string().trim().min(1).max(80), z.string().trim().max(500)).catch({}),
  evidence: z.array(z.object({
    field: z.enum(["title", "description", "sourceCondition", "category"]),
    quote: z.string().trim().min(1).max(180),
  })).max(20).catch([]),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
}).passthrough();

export const listingEnrichmentBatchSchema = z.object({
  items: z.array(listingEnrichmentSchema.extend({
    index: z.number().int().min(0).max(999),
  }).passthrough()).min(1).max(1_000),
}).strict();

/**
 * 身份判断契约（M2 / 计划 §5.2、§5.4）。
 *
 * 和 `listingEnrichmentSchema` 的关键区别：**这里一个 `.catch()` 都没有**。
 * 缺 relevance 是 contract_error，不是自动 uncertain；非法枚举是 contract_error，
 * 不是默认 unknown 之后算成功。把无效输出洗成合法业务结论，等于让一次模型故障
 * 静悄悄变成一条「已排除」——计划 §13.3 第 1 条要求这条路走不通。
 *
 * `candidateKey` 是稳定绑定键（`sourceId:sourceItemId`），不是数组下标。批次错位时
 * 下标会把 A 商品的结论安到 B 商品头上，这个字段就是用来发现错位的。
 */
/**
 * 空字符串是「合法地没有值」，不是类型错误（计划 §5.4）。
 * 把它归一化成 null，而不是让整条判断因为一个空的 relevanceReason 作废。
 * 类型不对（数字、对象、数组）仍然是 contract_error。
 */
const identityText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  enrichmentText.nullable(),
);

const identityTextList = (max: number) => z.preprocess(
  (value) => (Array.isArray(value)
    ? value.filter((entry) => typeof entry !== "string" || entry.trim() !== "")
    : value),
  z.array(enrichmentText).max(max),
);

export const listingIdentityAssessmentSchema = z.object({
  candidateKey: z.string().trim().min(1).max(360).optional(),
  index: z.number().int().min(0).max(999).optional(),
  relevance: z.enum(["relevant", "irrelevant", "uncertain"]),
  relevanceReason: identityText,
  confidence: z.enum(["high", "medium", "low"]),
  productType: identityText,
  workTitle: identityText,
  series: identityText,
  characters: identityTextList(12),
  editionOrModel: identityText,
  officialStatus: z.enum(["official", "fanmade", "unknown"]),
  includedItems: identityTextList(12),
  missingParts: identityTextList(8),
  evidence: z.preprocess(
    // 引用是确认与拒绝的必要条件，但一条空引用不应该拖死其余几条。
    (value) => (Array.isArray(value)
      ? value.filter((entry) => entry !== null
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>).quote === "string"
        && ((entry as Record<string, unknown>).quote as string).trim() !== "")
      : value),
    z.array(z.object({
      field: z.enum(["title", "description", "sourceCondition", "category"]),
      quote: z.string().trim().min(1).max(180),
    })).max(20),
  ),
}).passthrough();

/**
 * 展示契约。这一半允许降级：翻译坏了用原文，分类坏了归「其他」。
 * 计划 §5.4「展示字段允许降级，但不得污染身份字段」——两个 schema 分开，
 * 就是这句话在代码里的样子。
 */
export const listingDisplayFieldsSchema = z.object({
  translatedTitle: enrichmentTitle.nullable().catch(null),
  summary: enrichmentText.nullable().catch(null),
  normalizedCategory: enrichmentText.nullable().catch(null),
  marketCategory: marketAnalysisCategorySchema.catch("其他"),
  normalizedCondition: z.enum(["new", "used", "collectible", "refurbished", "unknown"]).catch("unknown"),
  conditionNotes: z.array(enrichmentText).max(8).catch([]),
  defects: z.array(enrichmentText).max(8).catch([]),
  extraInfo: z.record(z.string().trim().min(1).max(80), z.string().trim().max(500)).catch({}),
}).passthrough();

export type ListingIdentityAssessment = z.infer<typeof listingIdentityAssessmentSchema>;
export type ListingDisplayFields = z.infer<typeof listingDisplayFieldsSchema>;

const aiEnrichmentEvidenceSchema = z.object({
  quotes: listingEnrichmentSchema.shape.evidence,
  source: z.object({
    sourceId: sourceIdSchema,
    sourceItemId: z.string().trim().min(1).max(300),
    canonicalUrl: z.url({ protocol: /^https$/ }),
  }).strict(),
}).strict();

export const aiEnrichmentPersistenceSchema = z.object({
  batchId: z.string().regex(/^[a-f0-9]{64}$/),
  batch: z.object({
    purpose: z.enum(["listing_facts", "listing_semantics"]),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    promptVersion: z.string().trim().min(1).max(120),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    input: z.record(z.string(), z.unknown()),
    rawResponse: z.string().max(1_000_000),
    status: z.enum(["parsed", "partial", "unparsed"]),
    metadata: z.record(z.string(), z.unknown()),
    observedAt: z.string().trim().refine((value) => Number.isFinite(Date.parse(value)), {
      message: "AI batch time is invalid",
    }),
  }).strict(),
  records: z.array(z.object({
    listing: normalizedListingSchema,
    purpose: z.enum(["listing_facts", "listing_semantics"]),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    promptVersion: z.string().trim().min(1).max(120),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    input: listingEnrichmentRequestSchema,
    output: listingEnrichmentSchema,
    evidence: aiEnrichmentEvidenceSchema,
    confidence: z.enum(["high", "medium", "low"]),
    metadata: z.record(z.string(), z.unknown()),
    observedAt: z.string().trim().refine((value) => Number.isFinite(Date.parse(value)), {
      message: "AI enrichment time is invalid",
    }),
  }).strict()).max(1_000),
}).strict();

export const aiEnrichmentLookupRequestSchema = z.object({
  model: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(120),
  items: z.array(z.object({
    sourceId: sourceIdSchema,
    sourceItemId: z.string().trim().min(1).max(300),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(200),
}).strict();

const searchOverviewItemSchema = z.object({
  sourceId: sourceIdSchema,
  title: z.string().trim().min(1).max(500),
  currentPrice: z.number().int().nonnegative().max(1_000_000_000).nullable(),
  availability: z.enum(["available", "sold_out", "unavailable", "preorder", "backorder", "unknown"]),
  condition: z.enum(["new", "used", "collectible", "refurbished", "unknown"]),
}).strict();

export const searchOverviewRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  totals: z.object({
    resultCount: z.number().int().nonnegative().max(5_000),
    purchasableCount: z.number().int().nonnegative().max(5_000),
    soldReferenceCount: z.number().int().nonnegative().max(5_000),
    comparableGroupCount: z.number().int().nonnegative().max(5_000),
    minPrice: z.number().int().nonnegative().max(1_000_000_000).nullable(),
    maxPrice: z.number().int().nonnegative().max(1_000_000_000).nullable(),
    sourceCounts: z.array(z.object({
      sourceId: sourceIdSchema,
      count: z.number().int().nonnegative().max(5_000),
    }).strict()).max(11),
  }).strict(),
  representativeItems: z.array(searchOverviewItemSchema).min(1).max(24),
}).strict();

export const searchOverviewSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  highlights: z.array(z.string().trim().min(1).max(120)).max(4),
}).strict();

export type ListingEnrichmentRequest = z.infer<typeof listingEnrichmentRequestSchema>;
export type ListingEnrichmentBatchRequest = z.infer<typeof listingEnrichmentBatchRequestSchema>;
export type ListingEnrichment = z.infer<typeof listingEnrichmentSchema>;
export type AiEnrichmentPersistence = z.infer<typeof aiEnrichmentPersistenceSchema>;
export type SearchOverviewRequest = z.infer<typeof searchOverviewRequestSchema>;
export type SearchOverview = z.infer<typeof searchOverviewSchema>;
