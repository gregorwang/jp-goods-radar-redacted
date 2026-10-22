import { filterListings, numericPageToken, searchAvailabilityMode, type Availability, type NormalizedListing, type ProductSpecification, type SearchRequest, type SearchResult, type SourceAdapter } from "../../../core/src/index.js";
import { ParserStructureError, uniqueListings } from "../http.js";
import { decodeHtmlEntities, fetchPublicHtml, metaContent, normalizeJapaneseDate, parseYenText, stripHtml, uniqueStrings } from "../html.js";

export const ANIMATE_PARSER_VERSION = "animate-html-v3";

const ANIMATE_IMAGE_HOST = "tc-animate.techorus-cdn.com";
const MAX_PRODUCT_IMAGES = 25;

const ANIMATE_POLICY = {
  label: "Animate",
  allowedHosts: ["www.animate-onlineshop.jp", "animate-onlineshop.jp"] as const,
  allowedPath: (pathname: string) => pathname === "/products/list.php" || /^\/pn\/[^/]+\/pd\/[0-9]+\/$/.test(pathname),
  minBytes: 2_000,
  maxBytes: 2_000_000,
  timeoutMs: 20_000,
};

function availabilityFromLabel(label?: string): Availability {
  if (!label) return "unknown";
  if (/予約受付中|好評受付中/u.test(label)) return "preorder";
  if (/在庫あり|残りわずか/u.test(label)) return "available";
  if (/取り寄せ|お取り寄せ/u.test(label)) return "backorder";
  if (/販売終了|品切れ|売り切れ/u.test(label)) return "sold_out";
  if (/販売停止/u.test(label)) return "unavailable";
  if (/予約開始待ち/u.test(label)) return "preorder";
  return "unknown";
}

function searchUrl(request: SearchRequest): URL {
  const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 100);
  const pageSize = Math.min(Math.max(request.filters.pageSize ?? 30, 1), 100);
  const url = new URL("https://www.animate-onlineshop.jp/products/list.php");
  url.searchParams.set("mode", "search");
  url.searchParams.set("smt", request.query);
  if (request.filters.sort === "newest") url.searchParams.set("t", "n");
  url.searchParams.set("sl", String(pageSize));
  if (page > 1) url.searchParams.set("pageno", String(page));
  return url;
}

function itemUrl(value: string): URL {
  const trimmed = value.trim();
  const id = trimmed.match(/\/pd\/([0-9]+)(?:[/?#]|$)/)?.[1] ?? (/^[0-9]{4,20}$/.test(trimmed) ? trimmed : undefined);
  if (!id) throw new ParserStructureError("Animate 商品 ID 格式无效");
  return new URL(`https://www.animate-onlineshop.jp/pn/_/pd/${id}/`);
}

export function parseAnimateSearchHtml(html: string): { listings: NormalizedListing[]; totalAvailable?: number } {
  const listStart = html.search(/<div\s+class=["']item_list["']/i);
  const searchArea = listStart >= 0 ? html.slice(listStart, Math.min(html.length, listStart + 1_500_000)) : html;
  const listings: NormalizedListing[] = [];
  for (const match of searchArea.matchAll(/<li[^>]*>([\s\S]*?\/pd\/([0-9]+)\/[\s\S]*?)<\/li>/gi)) {
    const block = match[1] ?? "";
    const sourceItemId = match[2];
    const link = block.match(/href=["']([^"']*\/pn\/[^"']*\/pd\/[0-9]+\/)["']/i);
    const titleValue = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+title=["']([^"']+)["']/i)?.[1];
    if (!sourceItemId || !link?.[1] || !titleValue) continue;
    const image = block.match(/<img[^>]+src=["'](https:\/\/tc-animate\.techorus-cdn\.com\/[^"']+)["']/i)?.[1];
    const priceLabel = block.match(/<p\s+class=["'][^"']*price[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const stockLabel = stripHtml(block.match(/<p\s+class=["'][^"']*stock[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "").replace(/^販売状況[：:]\s*/u, "");
    const category = stripHtml(block.match(/<p\s+class=["'][^"']*media[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "").replace(/^カテゴリ[：:]\s*/u, "");
    const releaseLabel = stripHtml(block.match(/<p\s+class=["'][^"']*release[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const releaseDate = normalizeJapaneseDate(releaseLabel);
    const canonicalUrl = `https://www.animate-onlineshop.jp/pn/_/pd/${sourceItemId}/`;
    const decodedImage = image ? decodeHtmlEntities(image) : undefined;
    listings.push({
      sourceId: "animate",
      sourceItemId,
      identityScope: "catalog",
      canonicalUrl,
      title: decodeHtmlEntities(titleValue).trim(),
      imageUrl: decodedImage,
      shopName: "Animate Online Shop",
      currency: "JPY",
      currentPrice: parseYenText(priceLabel),
      priceBasis: "catalog_price",
      condition: "new",
      availability: availabilityFromLabel(stockLabel),
      facts: {
        identifiers: { sourceCatalogId: sourceItemId },
        brand: "Animate",
        categoryPath: category ? [category] : undefined,
        releaseDate,
        imageUrls: decodedImage ? [decodedImage] : undefined,
        sourceAvailabilityLabel: stockLabel || undefined,
        sourceConditionLabel: "新品",
        provenance: { identifiers: { method: "html", sourceLabel: "商品链接" }, releaseDate: { method: "html" }, imageUrls: { method: "html" } },
      },
      rawMetadata: { category: category || null, sourceAvailabilityLabel: stockLabel || null, sourceConditionLabel: "新品", parserVersion: ANIMATE_PARSER_VERSION },
    });
  }
  const unique = uniqueListings(listings);
  const empty = /該当する商品がありません|検索結果はありません|商品が見つかりません/u.test(html);
  if (unique.length === 0 && !empty && /class=["']item_list["']/i.test(html)) {
    throw new ParserStructureError("Animate 商品列表结构发生变化");
  }
  // 件数只在结果区标题附近才可信：商品名里的 "3件セット"、导航角标与侧栏筛选计数都会被
  // 全文匹配抢先命中，而 totalAvailable 直接决定 hasMore 翻页游标，取错会提前截断或无限翻页。
  // 因此先把范围收敛到列表容器之前的窗口，再优先认带结果语义的写法，最后才退回裸件数
  // （现网结果页标题只输出 "120件"，所以裸件数这一档不能去掉）。
  const header = listStart >= 0 ? html.slice(Math.max(0, listStart - 4_000), listStart) : html.slice(0, 20_000);
  const totalMatch = header.match(/(?:全|検索結果(?:は)?)\s*([0-9,]+)\s*件|([0-9,]+)\s*件(?:中|の商品|見つかりました)/u)
    ?? header.match(/([0-9,]+)\s*件/u);
  const totalText = totalMatch?.[1] ?? totalMatch?.[2];
  const totalAvailable = totalText ? Number(totalText.replace(/,/g, "")) : undefined;
  return { listings: unique, totalAvailable: Number.isFinite(totalAvailable) ? totalAvailable : undefined };
}

function detailSpecifications(text: string): ProductSpecification[] {
  const result: ProductSpecification[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^([^：:]{1,30})[：:]\s*(.+)$/u);
    if (!match?.[1] || !match[2]) continue;
    if (/関連ワード/u.test(match[1])) continue;
    result.push({ name: match[1].trim(), value: match[2].trim() });
  }
  return result;
}

function validAnimateImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(decodeHtmlEntities(value), "https://www.animate-onlineshop.jp/");
    if (url.protocol !== "https:" || url.hostname !== ANIMATE_IMAGE_HOST) return undefined;
    if (url.pathname.endsWith("/resize_image.php") && !url.searchParams.get("image")?.trim()) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function productImageUrls(html: string): string[] {
  const galleryStart = html.search(/<div\b[^>]*class=["'][^"']*\bitem_images\b[^"']*["'][^>]*>/i);
  const galleryEnd = galleryStart >= 0
    ? html.slice(galleryStart).search(/<div\b[^>]*class=["'][^"']*\bitem_detail\b[^"']*["'][^>]*>/i)
    : -1;
  const gallery = galleryStart >= 0
    ? html.slice(galleryStart, galleryEnd > 0 ? galleryStart + galleryEnd : Math.min(html.length, galleryStart + 200_000))
    : "";
  const candidates = [
    ...[...gallery.matchAll(/(?:src|href|data-src|data-image|data-original)=["']([^"']+)["']/gi)]
      .map((entry) => entry[1]),
    metaContent(html, "og:image"),
  ];
  return uniqueStrings(candidates.map(validAnimateImageUrl)).slice(0, MAX_PRODUCT_IMAGES);
}

export function parseAnimateDetailHtml(html: string, requestedUrl: URL): NormalizedListing {
  const sourceItemId = requestedUrl.pathname.match(/\/pd\/([0-9]+)\//)?.[1];
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "")
    || metaContent(html, "og:title")?.replace(/\s*\|.*$/u, "").trim();
  if (!sourceItemId || !title) throw new ParserStructureError("Animate 商品详情缺少稳定 ID 或标题");
  const price = parseYenText(html.match(/class=["'][^"']*price\s+new_price[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]);
  const releaseLabel = stripHtml(html.match(/<p\s+class=["'][^"']*release[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const stockLabel = stripHtml(html.match(/<p\s+class=["'][^"']*stock[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  const detailHtml = html.match(/<section[^>]+id=["']item_productinfo["'][^>]*>[\s\S]*?<div\s+class=["'][^"']*detail_info[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/section>/i)?.[1] ?? "";
  const description = stripHtml(detailHtml);
  const jan = html.match(/JANコード[：:]\s*([0-9]{8,14})/u)?.[1];
  const manufacturer = description.match(/発売元[：:]\s*([^\n]+)/u)?.[1]?.trim();
  const distributor = description.match(/販売元[：:]\s*([^\n]+)/u)?.[1]?.trim();
  const specifications = detailSpecifications(description);
  const tags = uniqueStrings([...html.matchAll(/<div\s+class=["']items_label["'][^>]*>[\s\S]*?<a[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi)].map((entry) => stripHtml(entry[1] ?? "")));
  const images = productImageUrls(html);
  const releaseDate = normalizeJapaneseDate(releaseLabel);
  const preorderDeadline = normalizeJapaneseDate(html.match(/(?:予約締切|予約受付期間)[^0-9]*(20[0-9]{2}[^<\n]{0,30})/u)?.[1]);
  return {
    sourceId: "animate",
    sourceItemId,
    identityScope: "catalog",
    canonicalUrl: requestedUrl.href,
    title,
    descriptionExcerpt: description ? description.slice(0, 600) : metaContent(html, "og:description")?.slice(0, 600),
    imageUrl: images[0],
    shopName: "Animate Online Shop",
    currency: "JPY",
    currentPrice: price,
    priceBasis: "catalog_price",
    condition: "new",
    availability: availabilityFromLabel(stockLabel),
    facts: {
      identifiers: { jan, sourceCatalogId: sourceItemId },
      brand: "Animate",
      manufacturer,
      distributor,
      workTitle: tags[1] ?? tags[0],
      tags: tags.length ? tags : undefined,
      releaseDate,
      preorderDeadline,
      imageUrls: images.length ? images : undefined,
      specifications: specifications.length ? specifications : undefined,
      sourceAvailabilityLabel: stockLabel || undefined,
      sourceConditionLabel: "新品",
      provenance: {
        identifiers: { method: "html", sourceLabel: "JANコード" },
        releaseDate: { method: "html" },
        specifications: { method: "html" },
        imageUrls: { method: "html" },
      },
    },
    rawMetadata: { sourceAvailabilityLabel: stockLabel || null, sourceConditionLabel: "新品", releaseLabel: releaseLabel || null, parserVersion: ANIMATE_PARSER_VERSION },
  };
}

async function searchAnimate(request: SearchRequest, context: Parameters<SourceAdapter["search"]>[1]): Promise<SearchResult> {
  const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 100);
  const pageSize = Math.min(Math.max(request.filters.pageSize ?? 30, 1), 100);
  const fetched = await fetchPublicHtml(context.fetch, searchUrl(request), ANIMATE_POLICY, context.signal);
  const parsed = parseAnimateSearchHtml(fetched.html);
  let listings = filterListings(parsed.listings, request.filters);
  if (request.filters.inStockOnly) listings = listings.filter((item) => item.availability === "available" || item.availability === "preorder" || item.availability === "backorder");
  const hasMore = parsed.totalAvailable !== undefined && parsed.listings.length > 0
    && page * pageSize < parsed.totalAvailable && page < 100;
  return {
    sourceId: "animate",
    listings,
    coverage: "rolling_window",
    ...(hasMore ? { nextCursor: String(page + 1) } : {}),
    ...(parsed.totalAvailable === undefined ? {} : { totalAvailable: parsed.totalAvailable }),
    warnings: ["搜索覆盖 Animate 当前公开结果；JAN、厂商与规格在详情查询时补全"],
    parserVersion: ANIMATE_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount: parsed.listings.length,
      normalizedResultCount: listings.length,
      pagesFetched: 1,
    },
  };
}

export const animateAdapter: SourceAdapter = {
  id: "animate",
  transport: "html_endpoint",
  parserVersion: ANIMATE_PARSER_VERSION,
  coverage: "rolling_window",
  healthcheckQuery: "ガンダム",
  fieldProfile: {
    required: ["sourceItemId", "canonicalUrl", "title", "currentPrice", "imageUrl", "availability"],
    optional: ["facts.identifiers.jan", "facts.brand", "facts.manufacturer", "facts.workTitle", "facts.releaseDate", "facts.preorderDeadline", "facts.imageUrls", "facts.specifications"],
  },
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: true, priceFilter: true, conditionFilter: false, supportsUsed: false, supportsSoldOut: true, historySearchSupported: false },
  search: searchAnimate,
  async getItem(value, context) {
    const url = itemUrl(value);
    const fetched = await fetchPublicHtml(context.fetch, url, ANIMATE_POLICY, context.signal);
    return parseAnimateDetailHtml(fetched.html, fetched.finalUrl);
  },
};
