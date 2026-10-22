import { AdapterError, classifySurugayaSearchHtml } from "@jpgr/adapters";
import type { AdapterContext, NormalizedListing, SearchRequest, SearchResult, SourceAdapter } from "@jpgr/core";

const MAX_DETAIL_ENRICHMENTS = 5;
const MAX_EXACT_QUERY_RESPONSE_BYTES = 2_000_000;

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a rejected exact-query response is best-effort.
  }
}

async function bounded404Html(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_EXACT_QUERY_RESPONSE_BYTES) {
    await discard(response);
    throw new AdapterError("骏河屋 404 页面超过 2 MB 安全上限", "response_too_large", 404, false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXACT_QUERY_RESPONSE_BYTES) {
        await reader.cancel("response_too_large");
        throw new AdapterError("骏河屋 404 页面超过 2 MB 安全上限", "response_too_large", 404, false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function searchSurugayaDirect(
  adapter: SourceAdapter,
  request: SearchRequest,
  context: AdapterContext,
  options: {
    enrichSoldOutPrices?: boolean;
    routeWarning?: string;
  } = {},
): Promise<SearchResult> {
  const upstreamFetch = context.fetch;
  const exactFetch: typeof fetch = async (input, init) => {
    const response = await upstreamFetch(input, init);
    if (response.status !== 404) return response;
    const html = await bounded404Html(response);
    if (classifySurugayaSearchHtml(html).kind === "verified_empty") {
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("content-type") ?? "text/html; charset=utf-8",
          "X-JPGR-Upstream-Status": "404",
          "X-JPGR-Collection-Outcome": "verified_empty",
        },
      });
    }
    throw new AdapterError(
      "骏河屋完整关键词搜索未命中 (404)",
      "surugaya_exact_query_not_found",
      404,
      false,
    );
  };
  const result = await adapter.search(request, { ...context, fetch: exactFetch });
  const exactProductSearch = request.sourceConfig?.searchMode === "exact_product";
  const candidates = options.enrichSoldOutPrices !== false
    && result.listings.length <= MAX_DETAIL_ENRICHMENTS && adapter.getItem
    ? result.listings.filter((listing) => exactProductSearch
      || (listing.availability === "sold_out" && listing.currentPrice === undefined))
    : [];
  const detailResults = await Promise.allSettled(
    candidates.map((listing) => adapter.getItem!(listing.sourceItemId, { ...context, fetch: upstreamFetch })),
  );
  const detailsById = new Map<string, NormalizedListing>();
  for (const detailResult of detailResults) {
    if (detailResult.status !== "fulfilled") continue;
    const detail = detailResult.value;
    detailsById.set(detail.sourceItemId, detail);
  }
  let officialListPriceCount = 0;
  let soldOutPriceCount = 0;
  const listings = result.listings.map((listing) => {
    const detail = detailsById.get(listing.sourceItemId);
    if (!detail) return listing;
    if (detail.originalPrice !== undefined) officialListPriceCount += 1;
    if (listing.availability === "sold_out"
      && listing.currentPrice === undefined
      && detail.currentPrice !== undefined) {
      soldOutPriceCount += 1;
    }
    const detailImages = detail.facts?.imageUrls;
    const searchImages = listing.facts?.imageUrls;
    const facts = listing.facts || detail.facts
      ? {
          ...listing.facts,
          ...detail.facts,
          ...((detailImages?.length ?? 0) > 0
            ? { imageUrls: detailImages }
            : (searchImages?.length ?? 0) > 0
              ? { imageUrls: searchImages }
              : {}),
        }
      : undefined;
    return {
      ...listing,
      ...detail,
      currentPrice: detail.currentPrice ?? listing.currentPrice,
      originalPrice: detail.originalPrice ?? listing.originalPrice,
      availability: listing.availability === "sold_out"
        ? "sold_out" as const
        : detail.availability === "unknown"
          ? listing.availability
          : detail.availability,
      imageUrl: detail.imageUrl ?? listing.imageUrl,
      ...(facts ? { facts } : { facts: undefined }),
      rawMetadata: {
        ...listing.rawMetadata,
        ...detail.rawMetadata,
        detailHydrated: true,
        ...(listing.availability === "sold_out"
          && listing.currentPrice === undefined
          && detail.currentPrice !== undefined
          ? { priceHydratedFrom: "detail" }
          : {}),
        ...(detail.originalPrice !== undefined ? { referencePriceHydratedFrom: "detail" } : {}),
      },
    };
  });
  const enrichmentWarnings = [
    ...(officialListPriceCount > 0
      ? [`已从商品详情取得 ${officialListPriceCount} 件商品的「定价」参考；与当前二手标价分开记录`]
      : []),
    ...(soldOutPriceCount > 0
      ? [`已从商品详情补充 ${soldOutPriceCount} 件售罄商品的最后标价；不会标记为当前有货`]
      : []),
  ];
  return {
    ...result,
    listings,
    warnings: [
      ...result.warnings,
      ...enrichmentWarnings,
      options.routeWarning ?? "Cloudflare 直连按完整关键词请求；不会改写或缩短搜索词",
    ],
  };
}
