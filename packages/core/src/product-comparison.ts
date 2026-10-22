import type { Availability, ItemCondition, NormalizedListing } from "./types.js";

export type ProductIdentityMethod = "identifier" | "exact_title";

export interface ProductIdentity {
  key: string;
  method: ProductIdentityMethod;
}

export interface ComparableListingGroup {
  identity: ProductIdentity;
  condition: ItemCondition;
  listings: NormalizedListing[];
}

const availabilityOrder: Record<Availability, number> = {
  available: 0,
  preorder: 1,
  backorder: 2,
  unknown: 3,
  unavailable: 4,
  sold_out: 5,
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{8,20}$/.test(normalized) ? normalized : undefined;
}

function listingIdentifier(listing: NormalizedListing): string | undefined {
  const identifiers = {
    ...metadataRecord(listing.rawMetadata?.identifiers),
    ...listing.facts?.identifiers,
  };
  for (const name of ["jan", "isbn", "asin", "modelNumber"] as const) {
    const value = normalizedIdentifier(identifiers[name]);
    if (value) return `${name}:${value}`;
  }
  if (listing.identityScope === "catalog") {
    // 必须带 sourceId 前缀：目录号只在各自站内唯一。Animate 与 CharaON 都用纯数字
    // 商品号，一次 9 位数字碰撞就会把两个毫不相干的商品合并成同一"商品"，
    // 进而污染跨来源比价集合与参考价中位数。
    const value = normalizedIdentifier(listing.sourceItemId);
    if (value) return `catalog:${listing.sourceId}:${value}`;
  }
  return undefined;
}

/**
 * Exact-title comparison intentionally does not remove words such as volume,
 * edition, bonus or condition. This keeps ambiguous merchandise separate.
 */
export function exactProductTitleKey(title: string): string | undefined {
  const normalized = title
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
  return normalized.length >= 8 ? normalized : undefined;
}

export function productIdentity(listing: NormalizedListing): ProductIdentity | undefined {
  const identifier = listingIdentifier(listing);
  if (identifier) return { key: identifier, method: "identifier" };
  const title = exactProductTitleKey(listing.title);
  return title ? { key: `title:${title}`, method: "exact_title" } : undefined;
}

export function compareListingAvailability(left: NormalizedListing, right: NormalizedListing): number {
  return availabilityOrder[left.availability] - availabilityOrder[right.availability];
}

export function compareListingPrices(left: NormalizedListing, right: NormalizedListing): number {
  const availability = compareListingAvailability(left, right);
  if (availability !== 0) return availability;
  if (left.currentPrice === undefined && right.currentPrice !== undefined) return 1;
  if (left.currentPrice !== undefined && right.currentPrice === undefined) return -1;
  return (left.currentPrice ?? 0) - (right.currentPrice ?? 0);
}

export function groupComparableListings(listings: readonly NormalizedListing[]): ComparableListingGroup[] {
  const groups = new Map<string, ComparableListingGroup>();
  for (const listing of listings) {
    const identity = productIdentity(listing);
    const fallback: ProductIdentity = {
      key: `listing:${listing.sourceId}:${listing.sourceItemId}`,
      method: "exact_title",
    };
    const resolved = identity ?? fallback;
    const groupKey = `${resolved.key}|condition:${listing.condition}`;
    const group = groups.get(groupKey);
    if (group) group.listings.push(listing);
    else groups.set(groupKey, { identity: resolved, condition: listing.condition, listings: [listing] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    listings: [...group.listings].sort(compareListingPrices),
  }));
}
