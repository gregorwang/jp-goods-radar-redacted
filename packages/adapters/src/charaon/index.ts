import { filterListings, numericPageToken, searchAvailabilityMode, type Availability, type NormalizedListing, type ProductSpecification, type SearchRequest, type SearchResult, type SourceAdapter } from "../../../core/src/index.js";
import { ParserStructureError, uniqueListings } from "../http.js";
import { decodeHtmlEntities, fetchPublicHtml, jsonLdObjects, metaContent, normalizeJapaneseDate, parseYenText, stripHtml, uniqueStrings } from "../html.js";

export const CHARAON_PARSER_VERSION = "charaon-html-v1";

const CHARAON_HOSTS = ["www.charaon.jp", "charaon.jp"] as const;
const CHARAON_POLICY = {
  label: "CharaON",
  allowedHosts: CHARAON_HOSTS,
  allowedPath: (pathname: string) => pathname === "/SHOP/list.php" || /^\/SHOP\/[A-Za-z0-9_-]+\.html$/.test(pathname),
  minBytes: 2_000,
  maxBytes: 2_000_000,
  timeoutMs: 15_000,
};

function stockAvailability(label?: string): Availability {
  if (!label) return "unknown";
  if (/[○△]/u.test(label)) return "available";
  if (/[×✕]/u.test(label) || /品切れ|売り切れ/u.test(label)) return "sold_out";
  if (/予約/u.test(label)) return "preorder";
  return "unknown";
}

function productAvailability(value?: string): Availability {
  if (!value) return "unknown";
  if (/InStock/i.test(value)) return "available";
  if (/PreOrder/i.test(value)) return "preorder";
  if (/OutOfStock|SoldOut/i.test(value)) return "sold_out";
  return "unknown";
}

function searchUrl(request: SearchRequest): URL {
  const url = new URL("https://www.charaon.jp/SHOP/list.php");
  url.searchParams.set("Search", request.query);
  url.searchParams.set("SortKey", request.filters.sort === "price_asc" ? "prceup"
    : request.filters.sort === "price_desc" ? "prcedown" : request.filters.sort === "newest" ? "new" : "normal");
  url.searchParams.set("PAGE", String(numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 100)));
  return url;
}

function itemUrl(value: string): URL {
  const trimmed = value.trim();
  const id = trimmed.match(/\/SHOP\/([A-Za-z0-9_-]+)\.html(?:[?#]|$)/)?.[1] ?? trimmed;
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(id)) throw new ParserStructureError("CharaON 商品 ID 格式无效");
  return new URL(`https://www.charaon.jp/SHOP/${encodeURIComponent(id)}.html`);
}

export function parseCharaonSearchHtml(html: string): { listings: NormalizedListing[]; totalAvailable?: number; lastVisible?: number } {
  const listings: NormalizedListing[] = [];
  for (const match of html.matchAll(/<section\s+class=["']column4["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const block = match[1] ?? "";
    const href = block.match(/href=["']([^"']*\/SHOP\/([A-Za-z0-9_-]+)\.html)["']/i);
    const sourceItemId = href?.[2];
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+title=["']([^"']+)["']/i)
      ?? block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch?.[1] ? stripHtml(titleMatch[1]) : undefined;
    if (!sourceItemId || !title) continue;
    const image = block.match(/<img[^>]+src=["'](https:\/\/image1\.shopserve\.jp\/charaon\.jp\/[^"']+)["']/i)?.[1];
    const priceLabel = block.match(/class=["'][^"']*selling_price[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const stockLabel = stripHtml(block.match(/class=["'][^"']*sps-itemList-stockDisp[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const canonicalUrl = `https://www.charaon.jp/SHOP/${encodeURIComponent(sourceItemId)}.html`;
    listings.push({
      sourceId: "charaon",
      sourceItemId,
      identityScope: "catalog",
      canonicalUrl,
      title,
      imageUrl: image ? decodeHtmlEntities(image) : undefined,
      shopName: "きゃらON！",
      currency: "JPY",
      currentPrice: parseYenText(priceLabel),
      priceBasis: "catalog_price",
      condition: "new",
      availability: stockAvailability(stockLabel),
      facts: {
        identifiers: { sku: sourceItemId, sourceCatalogId: sourceItemId },
        brand: "CharaON",
        imageUrls: image ? [decodeHtmlEntities(image)] : undefined,
        sourceAvailabilityLabel: stockLabel || undefined,
        sourceConditionLabel: "新品",
        provenance: { identifiers: { method: "html", sourceLabel: "商品链接" }, imageUrls: { method: "html" } },
      },
      rawMetadata: { sourceAvailabilityLabel: stockLabel || null, sourceConditionLabel: "新品", parserVersion: CHARAON_PARSER_VERSION },
    });
  }
  const unique = uniqueListings(listings);
  const empty = /該当商品はありません/u.test(html);
  if (unique.length === 0 && !empty && /id=["']itemList["']|商品一覧/u.test(html)) {
    throw new ParserStructureError("CharaON 商品列表结构发生变化");
  }
  const totalText = html.match(/([0-9,]+)件中[0-9,]+件/u)?.[1];
  const totalAvailable = totalText ? Number(totalText.replace(/,/g, "")) : undefined;
  const lastVisibleText = html.match(/[0-9,]+件中\s*[0-9,]+件\s*[～〜~-]\s*([0-9,]+)件/u)?.[1];
  const lastVisible = lastVisibleText ? Number(lastVisibleText.replace(/,/g, "")) : undefined;
  return {
    listings: unique,
    totalAvailable: Number.isFinite(totalAvailable) ? totalAvailable : undefined,
    lastVisible: Number.isFinite(lastVisible) ? lastVisible : undefined,
  };
}

function detailSections(html: string): string[] {
  return [...html.matchAll(/<section\s+id=["']itemDetail-wrap["'][^>]*>[\s\S]*?<div\s+class=["']description["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/section>/gi)]
    .map((match) => stripHtml(match[1] ?? ""))
    .filter(Boolean);
}

function detailSpecifications(text: string): ProductSpecification[] {
  const specifications: ProductSpecification[] = [];
  for (const match of text.matchAll(/■\s*([^：:\n]+?)(?:[：:]\s*([^\n]+))?(?=\n|■|$)/gu)) {
    const name = match[1]?.trim();
    const value = match[2]?.trim() || "有";
    if (name) specifications.push({ name, value });
  }
  return specifications;
}

export function parseCharaonDetailHtml(html: string, requestedUrl: URL): NormalizedListing {
  const product = jsonLdObjects(html).find((entry) => entry["@type"] === "Product");
  const offerValue = product?.offers;
  const offer = Array.isArray(offerValue) ? offerValue[0] : offerValue;
  const offerRecord = offer !== null && typeof offer === "object" && !Array.isArray(offer) ? offer as Record<string, unknown> : {};
  const sourceItemId = typeof product?.sku === "string" ? product.sku : requestedUrl.pathname.match(/\/SHOP\/([A-Za-z0-9_-]+)\.html$/)?.[1];
  const title = typeof product?.name === "string" ? product.name.trim() : stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (!sourceItemId || !title) throw new ParserStructureError("CharaON 商品详情缺少稳定 ID 或标题");
  const sections = detailSections(html);
  const detailText = sections.find((value) => /発売日|サイズ|素\s*材|発売元|[0-9]{13}/u.test(value)) ?? metaContent(html, "description") ?? "";
  const jsonImage = typeof product?.image === "string" ? product.image : Array.isArray(product?.image) && typeof product.image[0] === "string" ? product.image[0] : undefined;
  const imageMatches = [...html.matchAll(/https:\/\/image1\.shopserve\.jp\/charaon\.jp\/pic-labo\/(?:llimg|timg)\/[A-Za-z0-9_.?=&-]+/gi)].map((match) => match[0]);
  const imageUrls = uniqueStrings([jsonImage, ...imageMatches]).slice(0, 30);
  const jan = detailText.match(/(?:^|\D)([0-9]{13})(?:\D|$)/u)?.[1];
  const releaseDate = normalizeJapaneseDate(detailText.match(/発売日\s*([^\n]+)/u)?.[1]);
  const manufacturer = detailText.match(/発売元[：:]\s*([^\n]+)/u)?.[1]?.trim();
  const specifications = detailSpecifications(detailText);
  const price = parseYenText(typeof offerRecord.price === "string" || typeof offerRecord.price === "number" ? String(offerRecord.price) : undefined);
  const availabilityLabel = typeof offerRecord.availability === "string" ? offerRecord.availability : undefined;
  const breadcrumb = jsonLdObjects(html).find((entry) => entry["@type"] === "BreadcrumbList");
  const categoryPath = Array.isArray(breadcrumb?.itemListElement)
    ? breadcrumb.itemListElement.flatMap((item): string[] => {
        const entry = item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
        return typeof entry.name === "string" && entry.name !== "TOP" ? [entry.name] : [];
      })
    : [];
  const availability = productAvailability(availabilityLabel);
  return {
    sourceId: "charaon",
    sourceItemId,
    identityScope: "catalog",
    canonicalUrl: requestedUrl.href,
    title: decodeHtmlEntities(title),
    descriptionExcerpt: detailText ? detailText.slice(0, 600) : undefined,
    imageUrl: imageUrls[0],
    shopName: "きゃらON！",
    currency: "JPY",
    currentPrice: price,
    priceBasis: "catalog_price",
    condition: "new",
    availability,
    facts: {
      identifiers: { jan, sku: sourceItemId, sourceCatalogId: sourceItemId },
      brand: "CharaON",
      manufacturer,
      workTitle: categoryPath.at(-1),
      categoryPath: categoryPath.length ? categoryPath : undefined,
      releaseDate,
      imageUrls: imageUrls.length ? imageUrls : undefined,
      specifications: specifications.length ? specifications : undefined,
      sourceAvailabilityLabel: availabilityLabel,
      sourceConditionLabel: "新品",
      provenance: {
        identifiers: { method: "html", sourceLabel: "商品详情" },
        releaseDate: { method: "html" },
        specifications: { method: "html" },
        imageUrls: { method: jsonImage ? "json_ld" : "html" },
      },
    },
    rawMetadata: { sourceAvailabilityLabel: availabilityLabel ?? null, sourceConditionLabel: "新品", parserVersion: CHARAON_PARSER_VERSION },
  };
}

async function searchCharaon(request: SearchRequest, context: Parameters<SourceAdapter["search"]>[1]): Promise<SearchResult> {
  const page = numericPageToken(request.sourceConfig?.pageToken ?? request.filters.page, 1, 100);
  const fetched = await fetchPublicHtml(context.fetch, searchUrl(request), CHARAON_POLICY, context.signal);
  const parsed = parseCharaonSearchHtml(fetched.html);
  let listings = filterListings(parsed.listings, request.filters);
  if (request.filters.inStockOnly) listings = listings.filter((item) => item.availability === "available" || item.availability === "preorder");
  const observedLast = parsed.lastVisible ?? page * parsed.listings.length;
  const hasMore = parsed.totalAvailable !== undefined && parsed.listings.length > 0
    && observedLast < parsed.totalAvailable && page < 100;
  return {
    sourceId: "charaon",
    listings,
    coverage: "rolling_window",
    ...(hasMore ? { nextCursor: String(page + 1) } : {}),
    ...(parsed.totalAvailable === undefined ? {} : { totalAvailable: parsed.totalAvailable }),
    warnings: ["搜索结果覆盖 CharaON 当前公开分页；详情字段仅在展开或监控时补全"],
    parserVersion: CHARAON_PARSER_VERSION,
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: searchAvailabilityMode(request.filters),
      rawResultCount: parsed.listings.length,
      normalizedResultCount: listings.length,
      pagesFetched: 1,
    },
  };
}

export const charaonAdapter: SourceAdapter = {
  id: "charaon",
  transport: "html_endpoint",
  parserVersion: CHARAON_PARSER_VERSION,
  coverage: "rolling_window",
  healthcheckQuery: "文豪",
  fieldProfile: {
    required: ["sourceItemId", "canonicalUrl", "title", "currentPrice", "imageUrl", "availability"],
    optional: ["facts.identifiers.jan", "facts.identifiers.sku", "facts.manufacturer", "facts.workTitle", "facts.releaseDate", "facts.imageUrls", "facts.specifications"],
  },
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: true, priceFilter: true, conditionFilter: false, supportsUsed: false, supportsSoldOut: true, historySearchSupported: false },
  search: searchCharaon,
  async getItem(value, context) {
    const url = itemUrl(value);
    const fetched = await fetchPublicHtml(context.fetch, url, CHARAON_POLICY, context.signal);
    return parseCharaonDetailHtml(fetched.html, fetched.finalUrl);
  },
};
