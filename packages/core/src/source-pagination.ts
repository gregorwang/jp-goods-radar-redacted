import type { SourceId } from "./types.js";

export interface SourcePaginationPolicy {
  /** How the upstream exposes a subsequent result window. */
  mode: "page" | "cursor" | "session_page" | "single_page";
  /** Hard safety ceiling for numeric pages or pages consumed by one observation. */
  maxPage: number;
  /** Pages collected into one scheduled market observation by default. */
  marketDefaultPages: number;
}

/**
 * Pagination is deliberately source-specific. These are collection budgets,
 * not claims that the source exposes complete inventory.
 */
export const SOURCE_PAGINATION_POLICIES = {
  rakuten_ichiba: { mode: "page", maxPage: 100, marketDefaultPages: 5 },
  rakuten_books: { mode: "page", maxPage: 100, marketDefaultPages: 5 },
  yahoo_shopping: { mode: "session_page", maxPage: 3, marketDefaultPages: 3 },
  yahoo_auctions_jp: { mode: "page", maxPage: 100, marketDefaultPages: 2 },
  yahoo_fleamarket_jp: { mode: "page", maxPage: 100, marketDefaultPages: 2 },
  amazon_jp: { mode: "page", maxPage: 100, marketDefaultPages: 2 },
  ebay: { mode: "single_page", maxPage: 1, marketDefaultPages: 1 },
  mercari_jp: { mode: "cursor", maxPage: 100, marketDefaultPages: 4 },
  surugaya: { mode: "page", maxPage: 2, marketDefaultPages: 2 },
  charaon: { mode: "page", maxPage: 100, marketDefaultPages: 3 },
  cospa: { mode: "single_page", maxPage: 1, marketDefaultPages: 1 },
  animate: { mode: "page", maxPage: 100, marketDefaultPages: 4 },
  amiami: { mode: "page", maxPage: 100, marketDefaultPages: 2 },
} as const satisfies Record<SourceId, SourcePaginationPolicy>;

export function sourcePaginationPolicy(sourceId: SourceId): SourcePaginationPolicy {
  return SOURCE_PAGINATION_POLICIES[sourceId];
}

export function marketPageBudget(sourceId: SourceId, requested?: unknown): number {
  const policy = sourcePaginationPolicy(sourceId);
  const parsed = typeof requested === "number" ? requested : Number(requested);
  const pages = Number.isInteger(parsed) && parsed > 0 ? parsed : policy.marketDefaultPages;
  return Math.max(1, Math.min(pages, policy.maxPage));
}

export function numericPageToken(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) return fallback;
  return parsed;
}
