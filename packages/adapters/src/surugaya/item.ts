import type { AdapterContext, NormalizedListing } from "../../../core/src/index.js";
import { record, text } from "../http.js";
import { parseYenText, stripHtml } from "../html.js";
import { SurugayaParserError } from "./errors.js";
import { normalizeSurugayaItem } from "./normalize.js";
import { fetchSurugayaHtml } from "./request.js";

function itemUrl(value: string): URL {
  const id = value.match(/\/product\/detail\/([^/?#]+)/)?.[1] ?? value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new SurugayaParserError("骏河屋商品 ID 格式无效", "invalid_item_id");
  return new URL(`https://www.suruga-ya.jp/product/detail/${encodeURIComponent(id)}`);
}

function jsonLdProduct(html: string): Record<string, unknown> | undefined {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "null");
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const product = values.map(record).find((value) => value["@type"] === "Product");
      if (product) return product;
    } catch { /* Invalid JSON-LD falls through to HTML parsing. */ }
  }
  return undefined;
}

export async function getSurugayaItem(value: string, context: AdapterContext): Promise<NormalizedListing> {
  const url = itemUrl(value);
  const { html } = await fetchSurugayaHtml(context.fetch, url, context.signal);
  const product = jsonLdProduct(html);
  const offer = record(product?.offers);
  const title = text(product?.name) ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const image = Array.isArray(product?.image) ? text(product.image[0]) : text(product?.image);
  const structuredPriceText = text(offer.price);
  const htmlPriceText = html.match(/class=["'][^"']*price_teika[^"']*["'][^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1];
  const priceText = structuredPriceText ?? htmlPriceText;
  const availability = text(offer.availability);
  const description = text(product?.description);
  const soldOut = /OutOfStock/i.test(availability ?? "") || /品切れ/.test(html);
  const referenceListPrice = parseYenText(html.match(/定価[\s\S]{0,200}?([0-9][0-9,]*)\s*円/u)?.[1]);
  const normalized = await normalizeSurugayaItem({
    href: url.href,
    title,
    imageUrl: image,
    normalPriceText: priceText,
    soldOutText: soldOut ? "品切れ" : undefined,
  });
  if (!normalized) throw new SurugayaParserError("骏河屋商品详情结构无法解析", "surugaya_schema_changed");
  const descriptionExcerpt = description
    ? stripHtml(description).replace(/\s+/gu, " ").trim().slice(0, 2_500)
    : undefined;
  if (descriptionExcerpt) normalized.descriptionExcerpt = descriptionExcerpt;
  if (normalized.currentPrice === undefined && priceText) normalized.currentPrice = parseYenText(priceText);
  if (referenceListPrice !== undefined) normalized.originalPrice = referenceListPrice;
  const displayFacts = referenceListPrice === undefined
    ? undefined
    : [{ key: "list_price", label: "官方定价", group: "commerce" as const, kind: "text" as const, value: `￥${referenceListPrice.toLocaleString("ja-JP")}` }];
  normalized.facts = {
    ...normalized.facts,
    ...(displayFacts ? { displayFacts } : {}),
    ...(referenceListPrice === undefined ? {} : {
      priceReferences: [{
        kind: "official_list",
        amountJpy: referenceListPrice,
        currency: "JPY",
        taxStatus: "unknown",
        shippingStatus: "unknown",
        sourceLabel: "骏河屋商品详情「定価」",
      }],
    }),
    ...(soldOut ? { sourceAvailabilityLabel: "品切れ" } : {}),
    provenance: {
      ...normalized.facts?.provenance,
      ...(displayFacts ? { displayFacts: { method: "html" as const, sourceLabel: "骏河屋商品详情定价" } } : {}),
      ...(referenceListPrice === undefined ? {} : {
        priceReferences: { method: "html" as const, sourceLabel: "骏河屋商品详情「定価」" },
      }),
      ...(soldOut ? { sourceAvailabilityLabel: { method: availability ? "json_ld" as const : "html" as const, sourceLabel: "骏河屋商品详情库存状态" } } : {}),
    },
  };
  normalized.rawMetadata = {
    ...normalized.rawMetadata,
    offerAvailability: availability ?? null,
    referenceListPrice: referenceListPrice ?? null,
    priceEvidence: structuredPriceText ? "json_ld_offer" : htmlPriceText ? "html_price" : null,
  };
  return normalized;
}
