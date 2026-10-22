import {
  filterListings,
  searchAvailabilityMode,
  type AdapterContext,
  type NormalizedListing,
  type SearchRequest,
  type SearchResult,
} from "../../../core/src/index.js";
import { uniqueListings } from "../http.js";
import { createDpopSigner } from "./dpop.js";
import { buildMercariItemUrl } from "./item.js";
import { normalizeMercariListing } from "./normalize.js";
import { buildMercariSearchPayload, mercariInput } from "./payload.js";
import { mercariJson } from "./request.js";
import { mercariItemData, mercariSearchItems } from "./schema.js";

const SEARCH_URL = new URL("https://api.mercari.jp/v2/entities:search");
const MAX_HISTORY_ANCHORS = 12;

function historyItemIds(sourceConfig: Record<string, unknown> | undefined): string[] {
  const values = sourceConfig?.historyItemIds;
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && /^m\d{8,}$/i.test(value))
    .map((value) => value.toLowerCase()))]
    .slice(0, MAX_HISTORY_ANCHORS);
}

function compactSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function searchTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[\p{P}\p{S}\s]+/u)
    .map(compactSearchText)
    .filter((token) => token.length >= 2);
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

/**
 * Old sold listings can remain live while no longer appearing in Mercari's
 * rolling keyword index. Candidate IDs are therefore refreshed through the
 * official item endpoint and must still match the user's current query before
 * being returned.
 */
export function historyListingMatchesQuery(query: string, listing: Pick<NormalizedListing, "title" | "descriptionExcerpt">): boolean {
  const needle = compactSearchText(query);
  const haystack = compactSearchText(`${listing.title} ${listing.descriptionExcerpt ?? ""}`);
  if (!needle || !haystack) return false;
  if (haystack.includes(needle)) return true;
  if (haystack.length >= 8 && needle.includes(haystack)) return true;

  const queryTokens = [...new Set(searchTokens(query))];
  const tokenHits = queryTokens.filter((token) => haystack.includes(token)).length;
  const queryBigrams = bigrams(needle);
  const listingBigrams = bigrams(haystack);
  const commonBigrams = [...queryBigrams].filter((value) => listingBigrams.has(value)).length;
  const dice = queryBigrams.size + listingBigrams.size > 0
    ? (2 * commonBigrams) / (queryBigrams.size + listingBigrams.size)
    : 0;

  return (tokenHits >= 2 && commonBigrams >= 4 && dice >= 0.12)
    || (commonBigrams >= 8 && dice >= 0.24);
}

async function refreshHistoryAnchors(
  ids: readonly string[],
  query: string,
  context: AdapterContext,
  signer: Awaited<ReturnType<typeof createDpopSigner>>,
): Promise<{ listings: NormalizedListing[]; rawCount: number; failures: number }> {
  const listings: NormalizedListing[] = [];
  let rawCount = 0;
  let failures = 0;
  for (const id of ids) {
    const url = buildMercariItemUrl(id);
    try {
      const body = await mercariJson(context.fetch, signer, url, "GET", undefined, context.signal);
      rawCount += 1;
      const listing = normalizeMercariListing(mercariItemData(body));
      if (listing.availability === "sold_out" && historyListingMatchesQuery(query, listing)) listings.push(listing);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      failures += 1;
    }
  }
  return { listings, rawCount, failures };
}

export async function searchMercari(request: SearchRequest, context: AdapterContext): Promise<SearchResult> {
  const signer = await createDpopSigner();
  const input = mercariInput(request);
  const payload = buildMercariSearchPayload(input, signer.deviceUuid);
  const body = await mercariJson(context.fetch, signer, SEARCH_URL, "POST", payload, context.signal);
  const parsed = mercariSearchItems(body);
  const mode = searchAvailabilityMode(request.filters);
  const candidateIds = mode === "purchasable" ? [] : historyItemIds(request.sourceConfig);
  const refreshed = candidateIds.length
    ? await refreshHistoryAnchors(candidateIds, request.query, context, signer)
    : { listings: [], rawCount: 0, failures: 0 };
  const normalized = uniqueListings([
    ...parsed.items.map(normalizeMercariListing),
    ...refreshed.listings,
  ]);
  const listings = filterListings(normalized, request.filters);
  const warnings: string[] = [];
  if (listings.some((listing) => listing.rawMetadata?.saleMode === "auction")) {
    warnings.push("Mercari 搜索摘要已确认这些商品采用拍卖，但通常不提供普通拍卖 / 3 小时拍卖类型；打开单品详情后会用 auction_info 补全");
  }
  if (refreshed.listings.length > 0) {
    warnings.push(`${refreshed.listings.length} 个历史候选已用本次 Mercari 详情响应实时复核；本地候选索引未提供价格或状态`);
  }
  if (refreshed.failures > 0) warnings.push(`${refreshed.failures} 个历史候选的实时详情复核失败，未将其作为搜索结果`);
  if (listings.length === 0) warnings.push("suspicious_empty: 当前关键词索引与已实时复核候选均无匹配，未据此判定商品不存在");
  return {
    sourceId: "mercari_jp",
    listings,
    coverage: "rolling_window",
    nextCursor: parsed.nextPageToken,
    totalAvailable: parsed.totalAvailable,
    warnings,
    parserVersion: "mercari-internal-v2",
    fetchedAt: new Date().toISOString(),
    requestEvidence: {
      availabilityMode: mode,
      requestedStatuses: input.status,
      rawResultCount: parsed.items.length + refreshed.rawCount,
      normalizedResultCount: listings.length,
      pagesFetched: 1,
      keywordRawResultCount: parsed.items.length,
      liveDetailResultCount: refreshed.rawCount,
      anchorCandidateCount: candidateIds.length,
    },
  };
}
