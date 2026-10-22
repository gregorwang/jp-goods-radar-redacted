import { z } from "zod";

const filtersSchema = z.object({
  minPrice: z.number().int().nonnegative().optional(),
  maxPrice: z.number().int().nonnegative().optional(),
  conditions: z.array(z.enum(["new", "used", "collectible", "refurbished", "unknown"])).max(5).optional(),
  inStockOnly: z.boolean().optional(),
  availabilityMode: z.enum(["purchasable", "all", "sold_out"]).optional(),
  page: z.number().int().min(1).max(20).optional(),
  pageSize: z.number().int().min(1).max(120).optional(),
  sort: z.enum(["newest", "relevance", "price_asc", "price_desc"]).optional(),
}).strict().refine((value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, {
  message: "最低价不能高于最高价",
  path: ["minPrice"],
});

const surugayaSourceConfigSchema = z.object({
  category: z.string().trim().max(100).optional(),
  includeMarketplace: z.boolean().optional(),
  pages: z.number().int().min(1).max(2).optional(),
  pageToken: z.string().regex(/^[12]$/).optional(),
}).strict();

const yahooSourceConfigSchema = z.object({
  categoryId: z.string().trim().regex(/^\d{1,20}$/, "Yahoo 类目 ID 必须是纯数字").optional(),
  pageCount: z.number().int().min(1).max(3).optional(),
  pageToken: z.string().regex(/^[1-3]$/).optional(),
}).strict();

export const mercariSearchBodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  filters: filtersSchema,
  sourceConfig: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const mercariItemBodySchema = z.object({
  urlOrId: z.string().trim().min(1).max(500).refine((value) => {
    if (/^m\d{8,}$/i.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "jp.mercari.com" && !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  }, "仅接受 Mercari 商品 ID 或官方 HTTPS 商品链接"),
}).strict();

export const surugayaSearchBodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  filters: filtersSchema,
  sourceConfig: surugayaSourceConfigSchema.optional(),
}).strict();

export const yahooSearchBodySchema = z.object({
  query: z.string().trim().min(1).max(120),
  filters: filtersSchema,
  sourceConfig: yahooSourceConfigSchema.optional(),
}).strict();

export const surugayaItemBodySchema = z.object({
  urlOrId: z.string().trim().min(1).max(500).refine((value) => {
    if (/^[A-Za-z0-9_-]+$/.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "www.suruga-ya.jp"
        && url.pathname.startsWith("/product/detail/") && !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  }, "仅接受骏河屋商品 ID 或官方 HTTPS 商品链接"),
}).strict();

export const fixedHtmlSourceIdSchema = z.enum(["charaon", "cospa", "animate"]);
export type FixedHtmlSourceId = z.infer<typeof fixedHtmlSourceIdSchema>;

export const fixedSourceSearchBodySchema = z.object({
  sourceId: fixedHtmlSourceIdSchema,
  request: z.object({
    query: z.string().trim().min(1).max(200),
    filters: filtersSchema,
    sourceConfig: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();

function fixedItemValue(sourceId: FixedHtmlSourceId, value: string): boolean {
  if (sourceId === "charaon" && /^[A-Za-z0-9_-]{2,80}$/.test(value)) return true;
  if ((sourceId === "cospa" || sourceId === "animate") && /^[0-9]{4,20}$/.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (sourceId === "charaon") return ["www.charaon.jp", "charaon.jp"].includes(url.hostname)
      && /^\/SHOP\/[A-Za-z0-9_-]+\.html$/.test(url.pathname);
    if (sourceId === "cospa") return ["www.cospa.com", "cospa.com"].includes(url.hostname)
      && /^\/(?:cospa|nijigencospa)\/detail\/id\/[0-9]+\/?$/.test(url.pathname);
    return ["www.animate-onlineshop.jp", "animate-onlineshop.jp"].includes(url.hostname)
      && /\/pd\/[0-9]+\/$/.test(url.pathname);
  } catch {
    return false;
  }
}

export const fixedSourceItemBodySchema = z.object({
  sourceId: fixedHtmlSourceIdSchema,
  urlOrId: z.string().trim().min(1).max(1_500),
}).strict().superRefine((value, context) => {
  if (!fixedItemValue(value.sourceId, value.urlOrId)) {
    context.addIssue({ code: "custom", path: ["urlOrId"], message: "仅接受所选来源的商品 ID 或官方 HTTPS 商品链接" });
  }
});
