import type { NormalizedListing } from "../../../core/src/index.js";
import { sha256Hex } from "../../../core/src/index.js";
import { decodeHtmlEntities, parseYenText } from "../html.js";
import { SURUGAYA_PARSER_VERSION } from "./selectors.js";

export interface SurugayaParsedItem {
  href?: string;
  title?: string;
  imageUrl?: string;
  normalPriceText?: string;
  marketplacePriceText?: string;
  soldOutText?: string;
  category?: string;
}

export async function normalizeSurugayaItem(item: SurugayaParsedItem): Promise<NormalizedListing | undefined> {
  if (!item.href || !item.title) return undefined;
  // HTMLRewriter text and JSON-LD names can still contain entity references.
  // Decode after text chunks are joined; decoded angle brackets are title text.
  const title = decodeHtmlEntities(item.title).normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!title) return undefined;
  const url = new URL(item.href, "https://www.suruga-ya.jp");
  if (url.hostname !== "www.suruga-ya.jp" || !url.pathname.startsWith("/product/detail/")) return undefined;
  url.search = "";
  url.hash = "";
  // 来源允许列表同时接受 /product/detail/xxx 与 /product/detail/xxx/，
  // 必须先去掉尾部斜杠再取 ID，否则同一商品会得到两个身份（直取 ID 与 sha256）。
  url.pathname = url.pathname.replace(/\/+$/, "");
  const directId = url.pathname.match(/^\/product\/detail\/([^/]+)$/)?.[1];
  const canonicalUrl = url.href;
  const sourceItemId = directId ?? await sha256Hex(canonicalUrl);
  // 只挂在 Marketplace 的商品没有 price_teika 区块。若价格只认自营价，这类商品会以
  // currentPrice: undefined + availability: "unknown" 落库，被 onlyInStock 与价格区间
  // 过滤直接丢弃——即使调用方显式要求了 includeMarketplace。故按自营价优先回退到寄卖价，
  // 并记录本次价格取自哪一侧，供下游区分自营价与寄卖价。
  const teikaPrice = parseYenText(item.normalPriceText);
  const marketplacePrice = parseYenText(item.marketplacePriceText);
  const currentPrice = teikaPrice ?? marketplacePrice;
  const soldOut = item.soldOutText?.includes("品切れ") ?? false;
  const imageUrl = item.imageUrl ? decodeHtmlEntities(item.imageUrl.trim()) : undefined;
  return {
    sourceId: "surugaya",
    sourceItemId,
    identityScope: "listing",
    canonicalUrl,
    title,
    imageUrl: imageUrl?.startsWith("https://") ? imageUrl : undefined,
    currency: "JPY",
    currentPrice,
    priceBasis: "listing_price",
    condition: "used",
    // A structured offer price can remain on an archived detail page after the
    // item sells out. Explicit stock evidence must therefore win over price.
    availability: soldOut ? "sold_out" : currentPrice !== undefined ? "available" : "unknown",
    rawMetadata: {
      marketplacePrice: marketplacePrice ?? null,
      priceSource: teikaPrice !== undefined ? "teika" : marketplacePrice !== undefined ? "marketplace" : "none",
      category: item.category ? decodeHtmlEntities(item.category).normalize("NFKC").replace(/\s+/gu, " ").trim() : undefined,
      sourceConditionLabel: "中古",
      parserVersion: SURUGAYA_PARSER_VERSION,
    },
  };
}
