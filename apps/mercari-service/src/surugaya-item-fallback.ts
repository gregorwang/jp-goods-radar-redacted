import { surugayaAdapter } from "../../../packages/adapters/src/surugaya/index.js";
import { AdapterError } from "../../../packages/adapters/src/http.js";
import type { AdapterContext, NormalizedListing, SourceAdapter } from "../../../packages/core/src/index.js";

const SEARCH_FALLBACK_CODES = new Set([
  "surugaya_blocked",
  "captcha",
  "login_required",
  "surugaya_short_html",
  "surugaya_unexpected_redirect",
  "surugaya_schema_changed",
  "request_timeout",
]);

function sourceItemId(value: string): string {
  return value.match(/\/product\/detail\/([^/?#]+)/)?.[1] ?? value.trim();
}

export async function getSurugayaItemWithSearchFallback(
  value: string,
  context: AdapterContext,
  adapter: SourceAdapter = surugayaAdapter,
): Promise<NormalizedListing> {
  if (!adapter.getItem) throw new AdapterError("骏河屋商品详情适配器不可用", "item_lookup_unsupported");
  try {
    return await adapter.getItem(value, context);
  } catch (error) {
    if (!(error instanceof AdapterError) || !SEARCH_FALLBACK_CODES.has(error.code)) throw error;
    const expectedId = sourceItemId(value);
    try {
      const result = await adapter.search({
        query: expectedId,
        filters: { page: 1, pageSize: 30, inStockOnly: false, sort: "newest" },
        sourceConfig: { pages: 1 },
      }, context);
      const exact = result.listings.find((listing) => listing.sourceItemId === expectedId);
      if (!exact) throw error;
      return {
        ...exact,
        rawMetadata: {
          ...exact.rawMetadata,
          itemLookupMethod: "search_exact_id",
          detailErrorCode: error.code,
        },
      };
    } catch {
      throw error;
    }
  }
}
