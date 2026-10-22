import { filterListings, searchAvailabilityMode, type Availability, type NormalizedListing, type SearchRequest, type SearchResult, type SourceAdapter } from "../../../core/src/index.js";
import { ParserStructureError, uniqueListings } from "../http.js";
import { decodeHtmlEntities, fetchPublicHtml, metaContent, normalizeJapaneseDate, parseYenText, stripHtml, uniqueStrings } from "../html.js";

export const COSPA_PARSER_VERSION = "cospa-html-v2";

const COSPA_POLICY = {
  label: "COSPA",
  allowedHosts: ["www.cospa.com", "cospa.com"] as const,
  allowedPath: (pathname: string) => /^\/itemlist\/words\//.test(pathname)
    || /^\/(?:cospa|nijigencospa)\/detail\/id\/[0-9]+\/?$/.test(pathname),
  minBytes: 2_000,
  maxBytes: 2_000_000,
  timeoutMs: 15_000,
};

function sourceBrand(pathname: string): string {
  return pathname.startsWith("/nijigencospa/") ? "二次元COSPA" : "COSPA";
}

function availabilityFromLabel(label?: string): Availability {
  if (!label) return "unknown";
  if (/予約/u.test(label)) return "preorder";
  if (/品切れ|完売|在庫なし|販売終了/u.test(label)) return "sold_out";
  if (/販売中|在庫あり/u.test(label)) return "available";
  if (/取り寄せ/u.test(label)) return "backorder";
  return "unknown";
}

function searchUrl(request: SearchRequest): URL {
  const encoded = encodeURIComponent(request.query.trim()).replace(/%2F/gi, "%252F");
  return new URL(`https://www.cospa.com/itemlist/words/${encoded}`);
}

function itemUrl(value: string): URL {
  const trimmed = value.trim();
  const match = trimmed.match(/\/(cospa|nijigencospa)\/detail\/id\/([0-9]+)(?:[/?#]|$)/i);
  const id = match?.[2] ?? (/^[0-9]{5,20}$/.test(trimmed) ? trimmed : undefined);
  const brand = match?.[1]?.toLowerCase() === "nijigencospa" ? "nijigencospa" : "cospa";
  if (!id) throw new ParserStructureError("COSPA 商品 ID 格式无效");
  return new URL(`https://www.cospa.com/${brand}/detail/id/${id}`);
}

function searchResultImage(block: string): string | undefined {
  const imageTagUrl = block.match(
    /<img[^>]+src=["'](https:\/\/www\.cospa\.com\/images\/items\/[^"']+)["']/i,
  )?.[1];
  if (imageTagUrl) return decodeHtmlEntities(imageTagUrl);

  // COSPA 的精简搜索响应不渲染 <img>，而是把同一张商品图写在链接的
  // inline background:url(...) 中。两种响应会由同一个公开搜索地址返回。
  const backgroundUrl = block.match(
    /background(?:-image)?\s*:\s*url\(\s*["']?(https:\/\/www\.cospa\.com\/images\/items\/[^)'"\s]+)["']?\s*\)/i,
  )?.[1];
  return backgroundUrl ? decodeHtmlEntities(backgroundUrl) : undefined;
}

export function parseCospaSearchHtml(html: string): { listings: NormalizedListing[]; totalAvailable?: number } {
  const listings: NormalizedListing[] = [];
  for (const match of html.matchAll(/<div\s+class=["']item_tn["'][^>]*>([\s\S]*?)<!--\s*\/\/商品情報\s*-->/gi)) {
    const block = match[1] ?? "";
    const link = block.match(/href=["'](https:\/\/www\.cospa\.com\/(cospa|nijigencospa)\/detail\/id\/([0-9]+))["']/i);
    const titleValue = block.match(/<a[^>]+href=["'][^"']*\/detail\/id\/[0-9]+["'][^>]+title=["']([^"']+)["']/i)?.[1];
    if (!link?.[1] || !link[2] || !link[3] || !titleValue) continue;
    const image = searchResultImage(block);
    const series = stripHtml(block.match(/<em[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
    const variants = stripHtml(block.match(/<div\s+class=["']itemsize["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
    const statusLabels = uniqueStrings([...block.matchAll(/<img[^>]+(?:alt|title)=["']([^"']+)["'][^>]*>/gi)].map((entry) => entry[1]));
    const availabilityLabel = statusLabels.join(" / ");
    const priceLabel = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1];
    const brand = sourceBrand(new URL(link[1]).pathname);
    listings.push({
      sourceId: "cospa",
      sourceItemId: link[3],
      identityScope: "catalog",
      canonicalUrl: link[1],
      title: decodeHtmlEntities(titleValue).trim(),
      imageUrl: image,
      shopName: brand,
      currency: "JPY",
      currentPrice: parseYenText(priceLabel),
      priceBasis: "catalog_price",
      condition: "new",
      availability: availabilityFromLabel(availabilityLabel),
      facts: {
        identifiers: { sourceCatalogId: link[3] },
        brand,
        workTitle: series || undefined,
        imageUrls: image ? [image] : undefined,
        variants: variants ? [{ name: "サイズ", value: variants.replace(/\s*\/\s*/g, " / ") }] : undefined,
        sourceAvailabilityLabel: availabilityLabel || undefined,
        sourceConditionLabel: "新品",
        provenance: { identifiers: { method: "html", sourceLabel: "商品链接" }, workTitle: { method: "html" }, imageUrls: { method: "html" } },
      },
      rawMetadata: { sourceAvailabilityLabel: availabilityLabel || null, sourceConditionLabel: "新品", parserVersion: COSPA_PARSER_VERSION },
    });
  }
  const unique = uniqueListings(listings);
  const empty = /商品が見つかりません|該当する商品はありません/u.test(html);
  if (unique.length === 0 && !empty && /id=["']itemlist_main["']|class=["']itemlist["']/i.test(html)) {
    throw new ParserStructureError("COSPA 商品列表结构发生变化");
  }
  const totalText = html.match(/([0-9,]+)\s*件の商品/u)?.[1] ?? html.match(/([0-9,]+)\s*件\s*の商品/u)?.[1];
  const totalAvailable = totalText ? Number(totalText.replace(/,/g, "")) : undefined;
  return { listings: unique, totalAvailable: Number.isFinite(totalAvailable) ? totalAvailable : undefined };
}

function detailText(html: string): { description?: string; specifications?: string } {
  const description = stripHtml(html.match(/<p[^>]+id=["']comment["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const specificationStart = html.search(/<h4[^>]*>\s*製品スペック/u);
  const specificationHtml = specificationStart >= 0 ? html.slice(specificationStart, specificationStart + 8_000) : "";
  const specifications = stripHtml(specificationHtml.match(/<h4[^>]*>[\s\S]*?<\/h4>([\s\S]*?)(?:<div[^>]+class=["']sns_wrap|<p[^>]+id=["']jancode)/i)?.[1] ?? "");
  return { description: description || undefined, specifications: specifications || undefined };
}

export function parseCospaDetailHtml(html: string, requestedUrl: URL): NormalizedListing {
  const sourceItemId = requestedUrl.pathname.match(/\/detail\/id\/([0-9]+)/)?.[1];
  const rawTitle = html.match(/<h1\s+class=["'][^"']*product_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = rawTitle ? stripHtml(rawTitle) : metaContent(html, "og:title")?.replace(/\s*\|.*$/u, "").trim();
  if (!sourceItemId || !title) throw new ParserStructureError("COSPA 商品详情缺少稳定 ID 或标题");
  const brand = sourceBrand(requestedUrl.pathname);
  const price = parseYenText(html.match(/class=["'][^"']*money[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
  const statusLabels = uniqueStrings([...html.matchAll(/<img[^>]+(?:alt|title)=["']([^"']*(?:予約商品|販売中|完売|品切れ)[^"']*)["'][^>]*>/gi)].map((entry) => entry[1]));
  const availabilityLabel = statusLabels.join(" / ");
  const images = uniqueStrings([
    metaContent(html, "og:image"),
    ...[...html.matchAll(/https:\/\/www\.cospa\.com\/images\/items\/(?:pc|large|detail)\/[^"'\s<>]+/gi)].map((entry) => entry[0]),
  ]);
  const codeText = stripHtml(html.match(/<p[^>]+id=["']jancode["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const jan = codeText.match(/(?:^|\D)([0-9]{13})(?:\D|$)/u)?.[1];
  const modelNumber = codeText.split("/").map((value) => value.trim()).find((value) => value !== jan && /[A-Za-z0-9-]{4,}/.test(value));
  const info = detailText(html);
  const releaseDate = normalizeJapaneseDate(html.match(/発売日[^0-9]*(20[0-9]{2}[^<\n]{0,30})/u)?.[1]);
  const preorderDeadline = normalizeJapaneseDate(html.match(/(?:予約受付期間|予約締切)[^0-9]*(20[0-9]{2}[^<\n]{0,30})/u)?.[1]);
  const series = title.match(/\[([^\]]+)\]\s*$/u)?.[1];
  const specs = info.specifications ? [{ name: "製品スペック", value: info.specifications.slice(0, 1_000) }] : undefined;
  return {
    sourceId: "cospa",
    sourceItemId,
    identityScope: "catalog",
    canonicalUrl: requestedUrl.href,
    title,
    descriptionExcerpt: info.description?.slice(0, 600),
    imageUrl: images[0],
    shopName: brand,
    currency: "JPY",
    currentPrice: price,
    priceBasis: "catalog_price",
    condition: "new",
    availability: availabilityFromLabel(availabilityLabel),
    facts: {
      identifiers: { jan, modelNumber, sourceCatalogId: sourceItemId },
      brand,
      manufacturer: "株式会社コスパ",
      series,
      releaseDate,
      preorderDeadline,
      imageUrls: images.length ? images : undefined,
      specifications: specs,
      sourceAvailabilityLabel: availabilityLabel || undefined,
      sourceConditionLabel: "新品",
      provenance: {
        identifiers: { method: "html", sourceLabel: "JAN/商品番号" },
        releaseDate: { method: "html" },
        specifications: { method: "html" },
        imageUrls: { method: "html" },
      },
    },
    rawMetadata: { sourceAvailabilityLabel: availabilityLabel || null, sourceConditionLabel: "新品", parserVersion: COSPA_PARSER_VERSION },
  };
}

async function searchCospa(request: SearchRequest, context: Parameters<SourceAdapter["search"]>[1]): Promise<SearchResult> {
  const fetched = await fetchPublicHtml(context.fetch, searchUrl(request), COSPA_POLICY, context.signal);
  const parsed = parseCospaSearchHtml(fetched.html);
  let listings = filterListings(parsed.listings, request.filters);
  if (request.filters.inStockOnly) listings = listings.filter((item) => item.availability === "available" || item.availability === "preorder");
  return {
    sourceId: "cospa",
    listings,
    coverage: "rolling_window",
    totalAvailable: parsed.totalAvailable,
    warnings: ["搜索覆盖 COSPA 门户当前公开结果；JAN、商品编号和规格在详情查询时补全"],
    parserVersion: COSPA_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount: parsed.listings.length,
      normalizedResultCount: listings.length,
      pagesFetched: 1,
    },
  };
}

export const cospaAdapter: SourceAdapter = {
  id: "cospa",
  transport: "html_endpoint",
  parserVersion: COSPA_PARSER_VERSION,
  coverage: "rolling_window",
  healthcheckQuery: "ガンダム",
  fieldProfile: {
    required: ["sourceItemId", "canonicalUrl", "title", "currentPrice", "imageUrl", "availability"],
    optional: ["facts.identifiers.jan", "facts.brand", "facts.workTitle", "facts.releaseDate", "facts.preorderDeadline", "facts.imageUrls", "facts.specifications"],
  },
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: false, priceFilter: true, conditionFilter: false, supportsUsed: false, supportsSoldOut: true, historySearchSupported: false },
  search: searchCospa,
  async getItem(value, context) {
    const url = itemUrl(value);
    const fetched = await fetchPublicHtml(context.fetch, url, COSPA_POLICY, context.signal);
    return parseCospaDetailHtml(fetched.html, fetched.finalUrl);
  },
};
