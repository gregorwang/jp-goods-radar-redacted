import type { NormalizedListing } from "../../../core/src/index.js";
import { uniqueListings } from "../http.js";
import { containsHtmlChallenge } from "../html.js";
import { SurugayaParserError } from "./errors.js";
import { normalizeSurugayaItem, type SurugayaParsedItem } from "./normalize.js";
import { SURUGAYA_SELECTORS } from "./selectors.js";

interface RewriterElement {
  getAttribute(name: string): string | null;
  onEndTag(callback: () => void): void;
}
interface RewriterTextChunk { text: string; }
interface RewriterDocumentEnd { }
interface RewriterLike {
  on(selector: string, handlers: { element?(element: RewriterElement): void; text?(chunk: RewriterTextChunk): void }): RewriterLike;
  onDocument(handlers: { end?(end: RewriterDocumentEnd): void }): RewriterLike;
  transform(response: Response): Response;
}
declare const HTMLRewriter: undefined | (new () => RewriterLike);

function addText(item: SurugayaParsedItem | undefined, key: keyof SurugayaParsedItem, chunk: string): void {
  if (!item) return;
  const existing = item[key];
  item[key] = `${typeof existing === "string" ? existing : ""}${chunk}`;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export type SurugayaSearchPageClassification =
  | { kind: "verified_empty"; evidence: "explicit_zero_count" }
  | { kind: "result_page" }
  | { kind: "unknown" };

export function classifySurugayaSearchHtml(html: string): SurugayaSearchPageClassification {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const normalSourcePage = /<html\b/i.test(html) && /駿河屋/u.test(title);
  if (!normalSourcePage || containsHtmlChallenge(html) || /ログインしてください|login required/iu.test(html)) {
    return { kind: "unknown" };
  }
  const visibleText = stripTags(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " "));
  const explicitZeroCount = /検索結果は\s*[0０]\s*件です/u.test(visibleText);
  if (explicitZeroCount && /該当件数|検索結果/u.test(visibleText)) {
    return { kind: "verified_empty", evidence: "explicit_zero_count" };
  }
  if (/id=["']search_result["']/i.test(html)
    || /<div\s+class=["'][^"']*\bitem\b[^"']*["'][^>]*>/i.test(html)) {
    return { kind: "result_page" };
  }
  return { kind: "unknown" };
}

export function parseSurugayaHtmlFallback(html: string): SurugayaParsedItem[] {
  const blocks = html.split(/<div\s+class=["'][^"']*\bitem\b[^"']*["'][^>]*>/i).slice(1);
  return blocks.map((block) => {
    const bounded = block.split(/<div\s+class=["'][^"']*\bitem\b[^"']*["'][^>]*>/i)[0]?.slice(0, 30_000) ?? "";
    const href = bounded.match(/href=["']([^"']*\/product\/detail\/[^"']+)["']/i)?.[1];
    const title = bounded.match(/class=["'][^"']*product-name[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const imageUrl = bounded.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    const normalPriceText = bounded.match(/class=["'][^"']*price_teika[^"']*["'][^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1];
    const marketplacePriceText = bounded.match(/class=["'][^"']*(?:makeplaTit|highlight-box)[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*text-red[^"']*["'][^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1];
    const soldOutText = bounded.match(/<p\s+class=["']price["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const category = bounded.match(/class=["'][^"']*background-kishu[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    return {
      href,
      // Entity decoding is shared with the Worker and detail paths in normalize.
      title: title ? title.replace(/<[^>]*>/g, " ") : undefined,
      imageUrl: imageUrl ? decodeEntities(imageUrl) : undefined,
      normalPriceText: normalPriceText ? stripTags(normalPriceText) : undefined,
      marketplacePriceText: marketplacePriceText ? stripTags(marketplacePriceText) : undefined,
      soldOutText: soldOutText ? stripTags(soldOutText) : undefined,
      category: category ? category.replace(/<[^>]*>/g, " ") : undefined,
    };
  }).filter((item) => item.href && item.title);
}

export async function parseSurugayaResponse(response: Response, validationHtml: string): Promise<NormalizedListing[]> {
  const classification = classifySurugayaSearchHtml(validationHtml);
  if (classification.kind === "verified_empty") return [];
  let parsed: SurugayaParsedItem[];
  if (typeof HTMLRewriter === "undefined") {
    parsed = parseSurugayaHtmlFallback(validationHtml);
  } else {
    parsed = [];
    let current: SurugayaParsedItem | undefined;
    const rewriter = new HTMLRewriter()
      .on(SURUGAYA_SELECTORS.item, { element(element) { current = {}; parsed.push(current); element.onEndTag(() => { current = undefined; }); } })
      .on(SURUGAYA_SELECTORS.detailLink, { element(element) { if (current && !current.href) current.href = element.getAttribute("href") ?? undefined; } })
      .on(SURUGAYA_SELECTORS.productName, { text(chunk) { addText(current, "title", chunk.text); } })
      .on(SURUGAYA_SELECTORS.thumbnail, { element(element) { if (current && !current.imageUrl) current.imageUrl = element.getAttribute("src") ?? undefined; } })
      .on(SURUGAYA_SELECTORS.normalPrice, { text(chunk) { addText(current, "normalPriceText", chunk.text); } })
      .on(SURUGAYA_SELECTORS.marketplacePrice, { text(chunk) { addText(current, "marketplacePriceText", chunk.text); } })
      .on(SURUGAYA_SELECTORS.soldOut, { text(chunk) { addText(current, "soldOutText", chunk.text); } })
      .on(".item_detail .background-kishu", { text(chunk) { addText(current, "category", chunk.text); } })
      .onDocument({ end() { /* Consuming the transformed stream completes all handlers. */ } });
    await rewriter.transform(response).arrayBuffer();
  }
  const normalized = await Promise.all(parsed.map(normalizeSurugayaItem));
  const listings = uniqueListings(normalized.filter((item): item is NormalizedListing => Boolean(item)));
  if (classification.kind === "result_page" && listings.length === 0) {
    throw new SurugayaParserError("骏河屋存在搜索结果容器，但商品选择器全部失效", "surugaya_schema_changed");
  }
  return listings;
}
