import { z } from "zod";
import { parseSourceItemUrl } from "@jpgr/core";

const filtersSchema = z.object({
  minPrice: z.number().int().nonnegative().optional(),
  maxPrice: z.number().int().nonnegative().optional(),
  conditions: z.array(z.enum(["new", "used", "collectible", "refurbished", "unknown"])).max(5).optional(),
  inStockOnly: z.boolean().optional(),
  availabilityMode: z.enum(["purchasable", "all", "sold_out"]).optional(),
  page: z.number().int().min(1).max(15_001).optional(),
  pageSize: z.number().int().min(1).max(120).optional(),
  sort: z.enum(["newest", "relevance", "price_asc", "price_desc", "ending_soon", "ending_late", "bids_desc"]).optional(),
}).strict().refine(
  (value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice,
  { message: "最低价不能高于最高价", path: ["minPrice"] },
);

const baseSearchShape = {
  query: z.string().trim().min(1).max(200),
  filters: filtersSchema,
};

const surugayaSearchRequestSchema = z.object({
  ...baseSearchShape,
  sourceConfig: z.object({
    category: z.string().trim().max(100).optional(),
    includeMarketplace: z.boolean().optional(),
    pages: z.number().int().min(1).max(2).optional(),
    pageToken: z.union([z.string().regex(/^[12]$/u), z.number().int().min(1).max(2)]).optional(),
  }).strict().optional(),
}).strict();

const yahooShoppingSearchRequestSchema = z.object({
  ...baseSearchShape,
  query: z.string().trim().min(1).max(120),
  sourceConfig: z.object({
    categoryId: z.string().trim().regex(/^\d{1,20}$/u).optional(),
    pageCount: z.number().int().min(1).max(3).optional(),
    pages: z.number().int().min(1).max(3).optional(),
    pageToken: z.union([z.string().regex(/^[1-3]$/u), z.number().int().min(1).max(3)]).optional(),
  }).strict().optional(),
}).strict();

const yahooAuctionsSearchRequestSchema = z.object({
  ...baseSearchShape,
  sourceConfig: z.object({
    pageToken: z.union([z.string().regex(/^\d{1,5}$/u), z.number().int().min(1).max(15_001)]).optional(),
    minBidCount: z.number().int().nonnegative().optional(),
    maxBidCount: z.number().int().nonnegative().optional(),
    auctionConditionCodes: z.array(z.enum(["NEW", "USED10", "USED20", "USED40", "USED60", "USED80", "USED"])).max(7).optional(),
    categoryIds: z.array(z.number().int().nonnegative()).max(20).optional(),
    freeShipping: z.boolean().optional(),
    buyNow: z.boolean().optional(),
  }).strict().refine(
    (value) => value.minBidCount === undefined || value.maxBidCount === undefined || value.minBidCount <= value.maxBidCount,
    { message: "最低出价数不能高于最高出价数", path: ["minBidCount"] },
  ).optional(),
}).strict();

const yahooFleamarketSearchRequestSchema = z.object({
  ...baseSearchShape,
  sourceConfig: z.object({
    pageToken: z.union([z.string().regex(/^\d{1,3}$/u), z.number().int().min(1).max(100)]).optional(),
  }).strict().optional(),
}).strict();

const mercariSearchRequestSchema = z.object({
  ...baseSearchShape,
  sourceConfig: z.object({
    excludeKeyword: z.string().trim().max(200).optional(),
    itemConditionId: z.array(z.number().int().positive().max(100)).max(20).optional(),
    pageToken: z.string().trim().max(500).optional(),
    historyItemIds: z.array(z.string().trim().regex(/^m\d{8,}$/iu)).max(12).optional(),
  }).strict().optional(),
}).strict();

type ItemSourceId = "amiami" | "mercari_jp" | "rakuten_ichiba" | "surugaya" | "yahoo_auctions_jp" | "yahoo_fleamarket_jp";

function officialItemValue(sourceId: ItemSourceId, value: string): boolean {
  if (sourceId === "amiami") return (value.length <= 100 && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(value)) || parseSourceItemUrl(value)?.sourceId === "amiami";
  if (sourceId === "mercari_jp") {
    if (/^m\d{8,}$/iu.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "jp.mercari.com"
        && !url.username && !url.password && !url.port && !url.hash
        && /^\/(?:item|shops\/product)\/[^/?#]{1,300}\/?$/iu.test(url.pathname);
    } catch {
      return false;
    }
  }
  if (sourceId === "rakuten_ichiba") {
    return /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?:[^\/\\:\s\u0000-\u001f\u007f]{1,180}$/iu.test(value);
  }
  if (sourceId === "surugaya" && /^[A-Za-z0-9_-]{1,160}$/u.test(value)) return true;
  if (sourceId === "yahoo_auctions_jp" && /^[A-Za-z0-9]{8,16}$/u.test(value)) return true;
  if (sourceId === "yahoo_fleamarket_jp" && /^[A-Za-z0-9_-]{1,100}$/u.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    if (sourceId === "surugaya") {
      return url.hostname === "www.suruga-ya.jp" && /^\/product\/detail\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname);
    }
    if (sourceId === "yahoo_auctions_jp") {
      return url.hostname === "auctions.yahoo.co.jp" && !url.search
        && /^\/jp\/auction\/[A-Za-z0-9]{8,16}\/?$/u.test(url.pathname);
    }
    return url.hostname === "paypayfleamarket.yahoo.co.jp"
      && /^\/item\/[A-Za-z0-9_-]{1,100}\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

const itemTaskSchema = <T extends ItemSourceId>(sourceId: T) => z.object({
  sourceId: z.literal(sourceId),
  operation: z.literal("item"),
  urlOrId: z.string().trim().min(1).max(1_500).refine(
    (value) => officialItemValue(sourceId, value),
    "仅接受所选来源的商品 ID 或官方 HTTPS 商品链接",
  ),
}).strict();

export const createJobBodySchema = z.union([
  z.object({ sourceId: z.literal("amiami"), operation: z.literal("search"), request: yahooFleamarketSearchRequestSchema }).strict(),
  itemTaskSchema("amiami"),
  z.object({ sourceId: z.literal("mercari_jp"), operation: z.literal("search"), request: mercariSearchRequestSchema }).strict(),
  z.object({ sourceId: z.literal("surugaya"), operation: z.literal("search"), request: surugayaSearchRequestSchema }).strict(),
  z.object({ sourceId: z.literal("yahoo_shopping"), operation: z.literal("search"), request: yahooShoppingSearchRequestSchema }).strict(),
  z.object({ sourceId: z.literal("yahoo_auctions_jp"), operation: z.literal("search"), request: yahooAuctionsSearchRequestSchema }).strict(),
  z.object({ sourceId: z.literal("yahoo_fleamarket_jp"), operation: z.literal("search"), request: yahooFleamarketSearchRequestSchema }).strict(),
  itemTaskSchema("mercari_jp"),
  itemTaskSchema("rakuten_ichiba"),
  itemTaskSchema("surugaya"),
  itemTaskSchema("yahoo_auctions_jp"),
  itemTaskSchema("yahoo_fleamarket_jp"),
]);

export const jobStatusBodySchema = z.object({
  jobId: z.uuid(),
}).strict();

export type CreateJobBody = z.infer<typeof createJobBodySchema>;
export type JobStatusBody = z.infer<typeof jobStatusBodySchema>;
