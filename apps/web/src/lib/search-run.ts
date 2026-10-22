import type {
  ItemCondition,
  NormalizedListing,
  ProductFingerprint,
  ProductSearchPlan,
  SearchAvailabilityMode,
  SearchCandidateEvidence,
  SearchMode,
  SearchRouteOutcome,
  SourceId,
  SourceRequestRoute,
} from "@jpgr/core";

export interface SearchRunGroup {
  sourceId: SourceId;
  status: "success" | "empty" | "failed" | "disabled" | "cooldown";
  listings: NormalizedListing[];
  coverage?: string;
  warnings?: string[];
  error?: string;
  errorCode?: string;
  retryAt?: string;
  requestRoute?: SourceRequestRoute;
  routeOutcome?: SearchRouteOutcome;
  durationMs?: number;
  nextCursor?: string;
  totalAvailable?: number;
  requestEvidence?: {
    availabilityMode: SearchAvailabilityMode;
    requestedStatuses?: string[];
    rawResultCount: number;
    normalizedResultCount: number;
    pagesFetched: number;
    keywordRawResultCount?: number;
    liveDetailResultCount?: number;
    anchorCandidateCount?: number;
  };
  candidateEvidence?: Record<string, SearchCandidateEvidence>;
}

export interface SearchHistoryItem {
  id: string;
  query: string;
  sources: SourceId[];
  filters: {
    minPrice?: number | null;
    maxPrice?: number | null;
    conditions?: ItemCondition[];
    inStockOnly?: boolean;
    availabilityMode?: SearchAvailabilityMode;
  };
  status: "success" | "partial" | "empty" | "failed";
  resultCount: number;
  sourceSummary: Array<{
    sourceId: SourceId;
    status: SearchRunGroup["status"];
    resultCount: number;
    error?: string | null;
    durationMs?: number | null;
  }>;
  searchedAt: string;
  updatedAt?: string;
  pageCount?: number;
  mode?: SearchMode;
  target?: ProductFingerprint | null;
  plan?: ProductSearchPlan | null;
  deepSearch?: boolean;
  hasSnapshot: boolean;
}

export interface RawSourceCapture {
  id: string;
  sourceId: SourceId;
  ordinal: number;
  requestUrl: string;
  responseUrl?: string | null;
  requestMethod: string;
  responseStatus: number | null;
  contentType: string | null;
  payloadKind: string;
  rawPayload: string | null;
  payloadBytes: number;
  contentHash: string;
  capturedAt: string;
  durationMs: number;
  truncated: boolean;
  error: string | null;
}

export type RawCaptureState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: RawSourceCapture[] };

/**
 * SQLite represents boolean projections as 0/1 while PostgreSQL returns a
 * native boolean. Search history is read through both runtimes during the
 * PostgreSQL cutover, so avoid treating a saved snapshot as absent merely
 * because its database representation changed.
 */
export function hasStoredSearchSnapshot(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

/**
 * Exact-product searches without a confirmed match start in the curated
 * related/review bucket. Irrelevant source fallbacks stay available in the
 * complete manual pool without flooding the default result view.
 */
export function initialSearchResultPresentation(
  mode: SearchMode,
  groups: readonly Pick<SearchRunGroup, "candidateEvidence" | "listings">[],
): {
  resultScope: "curated" | "manual";
  resultMatchBucket: "all" | "exact" | "related";
  needsManualReview: boolean;
} {
  const hasConfirmedExactMatch = mode === "exact_product" && groups.some((group) =>
    Object.values(group.candidateEvidence ?? {}).some((evidence) => evidence.match?.relation === "exact"),
  );
  const hasCandidates = groups.some((group) => group.listings.length > 0);
  const needsManualReview = mode === "exact_product" && hasCandidates && !hasConfirmedExactMatch;
  return {
    resultScope: "curated",
    resultMatchBucket: hasConfirmedExactMatch ? "exact" : needsManualReview ? "related" : "all",
    needsManualReview,
  };
}

export const sourceNames: Record<SourceId, string> = {
  amiami: "AmiAmi（あみあみ）",
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  yahoo_auctions_jp: "Yahoo!オークション（实验）",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate",
  yahoo_shopping: "Yahoo! Shopping（实验）",
  amazon_jp: "Amazon Japan",
  ebay: "eBay",
};

export const coverageNames: Record<string, string> = {
  complete: "完整结果",
  rolling_window: "最近上架窗口",
  best_effort: "尽力覆盖",
  unknown: "覆盖范围待确认",
};

export function searchRunStatus(group: SearchRunGroup): { label: string; tone: "good" | "warn" | "bad" } {
  const countLabel = group.totalAvailable !== undefined && group.totalAvailable > group.listings.length
    ? `已取 ${group.listings.length} / 上游 ${group.totalAvailable} 件`
    : `${group.listings.length} 件`;
  const recoveredByFallback = group.routeOutcome?.kind === "fallback_success"
    || (group.sourceId === "surugaya" && group.requestRoute === "managed_api");
  if (recoveredByFallback) {
    return { label: group.listings.length ? `${countLabel} · 兜底` : "兜底无匹配", tone: "warn" };
  }
  if (group.status === "success") return { label: countLabel, tone: "good" };
  if (group.status === "empty") return { label: "本次无匹配", tone: "warn" };
  if (group.status === "cooldown") return { label: "暂时休息", tone: "warn" };
  if (group.status === "disabled") return { label: "尚未开放", tone: "bad" };
  return { label: "本次失败", tone: "bad" };
}

export function searchHistoryStatus(status: SearchHistoryItem["status"]): { label: string; tone: "good" | "warn" | "bad" } {
  if (status === "success") return { label: "搜索完成", tone: "good" };
  if (status === "partial") return { label: "部分来源完成", tone: "warn" };
  if (status === "empty") return { label: "没有匹配", tone: "warn" };
  return { label: "来源失败", tone: "bad" };
}
