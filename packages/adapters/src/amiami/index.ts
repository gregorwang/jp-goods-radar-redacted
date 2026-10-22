import {
  filterListings, numericPageToken, parseSourceItemUrl, readBoundedResponseText,
  searchAvailabilityMode, type AdapterContext, type Availability, type NormalizedListing,
  type ProductFacts, type SearchRequest, type SearchResult, type SourceAdapter,
} from "../../../core/src/index.js";
import { AdapterError, list, record, text } from "../http.js";
import { stripHtml } from "../html.js";

export const AMIAMI_PARSER_VERSION = "amiami-json-ja-v1";
const API = "https://api.amiami.com/api/v1.0/";
const CODE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u;
const MAX_PAGE = 100;

function price(value: unknown): number | undefined {
  // null/empty/zero are missing prices, never free offers.
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000_000 ? number : undefined;
}

function flag(value: unknown): boolean { return value === 1 || value === "1"; }
function code(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate && candidate.length <= 100 && CODE.test(candidate) ? candidate : undefined;
}

function image(value: unknown): string | undefined {
  const path = text(value);
  if (!path) return undefined;
  try {
    const url = new URL(path, "https://img.amiami.com");
    return url.protocol === "https:" && url.hostname === "img.amiami.com" && !url.username && !url.password && !url.port
      ? url.href : undefined;
  } catch { return undefined; }
}

export function amiamiItemUrl(id: string, offer = false): string {
  const url = new URL("https://www.amiami.com/eng/detail/");
  url.searchParams.set(offer ? "scode" : "gcode", id);
  return url.href;
}

function availability(item: Record<string, unknown>, currentPrice: number | undefined, detail: boolean): Availability {
  const stock = detail ? item.stock : item.stock_flg;
  if (flag(item.order_closed_flg) || stock === 0 || stock === "0") return "sold_out";
  // Generic soldout_flg/instock_flg in used details describe the new catalog
  // entry. Live used offers have stock=1 while soldout_flg=1, instock_flg=0.
  if (currentPrice === undefined) return "unknown";
  if (flag(item.preorderitem) || flag(item.list_preorder_available)) return "preorder";
  if (flag(item.backorderitem) || flag(item.list_backorder_available)) return "backorder";
  if (detail ? flag(item.stock) : flag(item.instock_flg)) return "available";
  return "unknown";
}

function names(value: unknown): string[] {
  return list(value).map((entry) => text(record(entry).name)).filter((name): name is string => Boolean(name));
}

function normalize(item: Record<string, unknown>, embedded: Record<string, unknown>, detail: boolean, requestedId?: string): NormalizedListing {
  const gcode = code(item.gcode);
  const title = detail ? text(item.sname_simple_j) ?? text(item.gname) : text(item.gname);
  if (!gcode || !title) throw new AdapterError("AmiAmi 商品缺少编号或标题", "parser_structure_error");
  const scode = code(item.scode);
  const requestedOffer = Boolean(requestedId && requestedId !== gcode);
  if (requestedOffer && scode !== requestedId) {
    throw new AdapterError("AmiAmi 返回了不同的品相报价，无法确认原报价状态", "amiami_offer_mismatch", 409, false);
  }
  const currentPrice = price(detail ? item.price : item.min_price);
  const used = flag(item.condition_flg) || /-R(?:[A-Z0-9]*)$/u.test(gcode);
  const state = availability(item, currentPrice, detail);
  const description = [text(item.memo), text(item.spec), text(item.remarks)].filter(Boolean).join("\n\n");
  const images = [...new Set([image(item.main_image_url), image(item.thumb_url),
    ...list(embedded.review_images).map((value) => image(record(value).image_url))].filter((value): value is string => Boolean(value)))].slice(0, 30);
  const conditionLabel = used
    ? text(item.sname)?.match(/^\((Pre-owned[^)]*)\)/iu)?.[1] ?? "中古"
    : "新品";
  const variants: NonNullable<ProductFacts["variants"]> = [];
  if (detail && scode && used) variants.push({ name: "品相", value: `${conditionLabel} · ${scode}`, priceJpy: currentPrice });
  for (const value of list(embedded.other_items)) {
    const offer = record(value);
    const id = code(offer.scode);
    if (!id || id === scode) continue;
    variants.push({ name: "品相", value: `${text(offer.condition) ?? "中古"} · ${id}`.slice(0, 300), priceJpy: price(offer.price) });
  }
  const referencePrice = price(item.c_price_taxed);
  const facts: ProductFacts = {
    identifiers: { sourceCatalogId: gcode, ...(scode ? { sku: scode } : {}), ...(text(item.jancode) ? { jan: text(item.jancode) } : {}) },
    brand: text(item.maker_name)?.slice(0, 200),
    workTitle: names(embedded.original_titles)[0]?.slice(0, 300),
    series: names(embedded.series_titles)[0]?.slice(0, 300),
    characters: names(embedded.character_names).slice(0, 40).map((value) => value.slice(0, 200)),
    releaseDate: text(item.releasedate)?.slice(0, 40),
    imageUrls: images,
    specifications: text(item.spec) ? [{ name: "商品仕様", value: stripHtml(String(item.spec)).slice(0, 1000) }] : undefined,
    variants: variants.length ? variants.slice(0, 100) : undefined,
    priceContext: { taxStatus: "included", shippingStatus: "separate" },
    // Retain reference pricing without mistaking it for a live used offer.
    priceReferences: referencePrice ? [{ kind: "source_compare_at", amountJpy: referencePrice, currency: "JPY", sourceLabel: "参考価格", taxStatus: "included", shippingStatus: "unknown" }] : undefined,
    sourceAvailabilityLabel: ({ available: "販売中", preorder: "予約", backorder: "取り寄せ", sold_out: "販売終了・在庫なし", unknown: "在庫状態未確認", unavailable: "取扱なし" } satisfies Record<Availability, string>)[state],
    sourceConditionLabel: conditionLabel.slice(0, 200),
    provenance: { identifiers: { method: "internal_api" }, specifications: { method: "internal_api" }, imageUrls: { method: "internal_api" } },
  };
  return {
    sourceId: "amiami", sourceItemId: requestedOffer ? requestedId! : gcode,
    identityScope: requestedOffer ? "offer" : "catalog",
    canonicalUrl: amiamiItemUrl(requestedOffer ? requestedId! : gcode, requestedOffer),
    title: title.slice(0, 1000), descriptionExcerpt: description ? stripHtml(description).slice(0, 2500) : undefined,
    imageUrl: images[0], shopName: "あみあみ", currency: "JPY", currentPrice,
    priceBasis: requestedOffer ? "offer_price" : "catalog_price", condition: used ? "used" : "new", availability: state, facts,
    rawMetadata: { parserVersion: AMIAMI_PARSER_VERSION, sourceLanguage: "ja", detailLanguage: detail ? "mixed" : "ja", description: description || null,
      priceRange: { min: price(item.min_price) ?? null, max: price(item.max_price) ?? null }, item, ...(detail ? { embedded } : {}) },
  };
}

async function requestJson(path: "items" | "item", params: Record<string, string>, context: AdapterContext): Promise<Record<string, unknown>> {
  const url = new URL(path, API);
  // /items defaults to Japanese. lang=eng changes keyword matching, not only
  // the presentation language. Keep the user's Japanese query verbatim.
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const timeout = AbortSignal.timeout(25_000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  let response: Response;
  let body: string;
  try {
    response = await context.fetch(url, { method: "GET", signal, redirect: "manual", headers: {
      Accept: "application/json", "X-User-Key": "amiami_dev", Referer: "https://www.amiami.com/", Origin: "https://www.amiami.com",
    } });
    body = await readBoundedResponseText(response, 1_700_000);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(signal.aborted ? "AmiAmi 请求超时" : "AmiAmi 连接或响应读取失败", signal.aborted ? "request_timeout" : "amiami_transport_error", undefined, true);
  }
  let data: Record<string, unknown>;
  try { data = record(JSON.parse(body)); } catch {
    throw new AdapterError(`AmiAmi 返回非 JSON 响应 (${response.status})`, response.ok ? "parser_structure_error" : `http_${response.status}`, response.status, response.status === 429 || response.status >= 500);
  }
  if (!response.ok || data.RSuccess !== true) {
    const value = record(data.RValue);
    const detail = (text(value.ErrorMessage) ?? text(data.RMessage) ?? "响应格式异常").replace(/\s+/gu, " ").slice(0, 300);
    throw new AdapterError(`AmiAmi (${response.status})：${detail}`, response.ok ? "amiami_api_error" : `http_${response.status}`, response.status, response.status === 429 || response.status >= 500);
  }
  return data;
}

export async function searchAmiami(request: SearchRequest, context: AdapterContext): Promise<SearchResult> {
  const page = numericPageToken(request.sourceConfig?.pageToken, numericPageToken(request.filters.page, 1, MAX_PAGE), MAX_PAGE);
  const pageSize = Math.max(1, Math.min(50, Math.trunc(request.filters.pageSize ?? 20)));
  const params: Record<string, string> = { s_keywords: request.query, pagecnt: String(page), pagemax: String(pageSize), s_sortkey: request.filters.sort === "relevance" ? "recommend" : "regtimed" };
  if (request.filters.conditions?.length === 1 && request.filters.conditions[0] === "used") params.s_st_condition_flg = "1";
  const data = await requestJson("items", params, context);
  const total = record(data.search_result).total_results;
  if (!Array.isArray(data.items) || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new AdapterError("AmiAmi 搜索响应结构发生变化", "parser_structure_error");
  }
  const raw = data.items.map((item) => normalize(record(item), {}, false));
  const listings = filterListings(raw, request.filters);
  const warnings = ["日文关键词搜索；中古目录价格为当前最低报价，单品详情保留品相报价。"];
  if (request.filters.sort === "price_asc" || request.filters.sort === "price_desc") {
    listings.sort((a, b) => request.filters.sort === "price_asc" ? (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity) : (b.currentPrice ?? -Infinity) - (a.currentPrice ?? -Infinity));
    warnings.push("价格排序仅作用于本页；上游按最近更新返回。");
  }
  return { sourceId: "amiami", listings, coverage: "rolling_window", totalAvailable: total,
    nextCursor: raw.length === pageSize && page * pageSize < total && page < MAX_PAGE ? String(page + 1) : undefined,
    warnings, parserVersion: AMIAMI_PARSER_VERSION, fetchedAt: new Date().toISOString(),
    requestEvidence: { availabilityMode: searchAvailabilityMode(request.filters), rawResultCount: raw.length, normalizedResultCount: listings.length,
      parserAcceptedCount: raw.length, parserRejectedCount: 0, pagesFetched: 1, collectionOutcome: total === 0 && raw.length === 0 ? "verified_empty" : "items" },
  };
}

export async function getAmiamiItem(value: string, context: AdapterContext): Promise<NormalizedListing> {
  const parsed = parseSourceItemUrl(value);
  const id = code(value) ?? (parsed?.sourceId === "amiami" ? parsed.sourceItemId : undefined);
  if (!id) throw new AdapterError("请输入有效的 AmiAmi 商品编号或商品链接", "invalid_item_id");
  const offer = /-R[A-Z0-9]+$/u.test(id);
  const data = await requestJson("item", { [offer ? "scode" : "gcode"]: id }, context);
  if (!data.item || typeof data.item !== "object") throw new AdapterError("AmiAmi 商品详情不存在", "item_not_found", 404, false);
  if (!offer && record(data.item).gcode !== id) throw new AdapterError("AmiAmi 返回了不同的商品目录", "amiami_catalog_mismatch", 409, false);
  return normalize(record(data.item), record(data._embedded), true, id);
}

export const amiamiAdapter: SourceAdapter = {
  id: "amiami", transport: "internal_api", parserVersion: AMIAMI_PARSER_VERSION, coverage: "rolling_window", healthcheckQuery: "千反田える",
  capabilities: { keywordSearch: true, itemLookup: true, newestSort: true, priceFilter: true, conditionFilter: true, supportsUsed: true, supportsSoldOut: true, historySearchSupported: false },
  fieldProfile: { required: ["sourceItemId", "canonicalUrl", "title"], optional: ["currentPrice", "imageUrl", "availability", "facts.identifiers.jan", "facts.brand", "facts.releaseDate", "facts.specifications"] },
  search: searchAmiami, getItem: getAmiamiItem,
};
