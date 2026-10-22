import type { ListingFieldName, NormalizedListing, SourceFieldProfile } from "./types.js";

export const PROBE_WINDOW_MS = 48 * 60 * 60 * 1_000;
export const PROBE_MIN_RUNS = 48;

export interface ProbeMetrics {
  startedAt?: string | null;
  totalRuns: number;
  successfulRuns: number;
  fieldTotal: number;
  fieldComplete: number;
  captchaRuns: number;
  cpuLimitRuns: number;
  loginRequiredRuns: number;
}

export interface ProbeDecision {
  status: "pending" | "running" | "passed" | "failed";
  elapsedMs: number;
  successRate: number;
  fieldCompletenessRate: number;
  reasons: string[];
}

export function evaluateProbeWindow(metrics: ProbeMetrics, now = Date.now()): ProbeDecision {
  if (!metrics.startedAt) {
    return { status: "pending", elapsedMs: 0, successRate: 0, fieldCompletenessRate: 0, reasons: ["探针尚未开始"] };
  }
  const elapsedMs = Math.max(0, now - Date.parse(metrics.startedAt));
  const successRate = metrics.totalRuns > 0 ? metrics.successfulRuns / metrics.totalRuns : 0;
  const fieldCompletenessRate = metrics.fieldTotal > 0 ? metrics.fieldComplete / metrics.fieldTotal : 0;
  if (elapsedMs < PROBE_WINDOW_MS) {
    return { status: "running", elapsedMs, successRate, fieldCompletenessRate, reasons: ["尚未连续运行 48 小时"] };
  }
  const reasons: string[] = [];
  if (metrics.totalRuns < PROBE_MIN_RUNS) reasons.push(`有效探针次数不足 ${PROBE_MIN_RUNS} 次`);
  if (successRate < 0.95) reasons.push("成功率低于 95%");
  if (fieldCompletenessRate < 0.98) reasons.push("关键字段解析率低于 98%");
  if (metrics.captchaRuns > 0) reasons.push("观测窗口出现 CAPTCHA");
  if (metrics.cpuLimitRuns > 0) reasons.push("观测窗口出现 CPU 超限");
  if (metrics.loginRequiredRuns > 0) reasons.push("来源存在登录依赖");
  return { status: reasons.length === 0 ? "passed" : "failed", elapsedMs, successRate, fieldCompletenessRate, reasons };
}

export const DEFAULT_REQUIRED_LISTING_FIELDS = [
  "sourceItemId",
  "canonicalUrl",
  "title",
  "currentPrice",
  "imageUrl",
  "availability",
] as const satisfies readonly ListingFieldName[];

function fieldValue(listing: NormalizedListing, field: ListingFieldName): unknown {
  switch (field) {
    case "sourceItemId": return listing.sourceItemId;
    case "canonicalUrl": return listing.canonicalUrl;
    case "title": return listing.title;
    case "currentPrice": return listing.currentPrice;
    case "imageUrl": return listing.imageUrl;
    case "availability": return listing.availability;
    case "facts.identifiers.jan": return listing.facts?.identifiers?.jan;
    case "facts.identifiers.isbn": return listing.facts?.identifiers?.isbn;
    case "facts.identifiers.asin": return listing.facts?.identifiers?.asin;
    case "facts.identifiers.sku": return listing.facts?.identifiers?.sku;
    case "facts.brand": return listing.facts?.brand;
    case "facts.manufacturer": return listing.facts?.manufacturer;
    case "facts.workTitle": return listing.facts?.workTitle;
    case "facts.releaseDate": return listing.facts?.releaseDate;
    case "facts.preorderDeadline": return listing.facts?.preorderDeadline;
    case "facts.imageUrls": return listing.facts?.imageUrls;
    case "facts.specifications": return listing.facts?.specifications;
    case "facts.displayFacts": return listing.facts?.displayFacts;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function present(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function fieldCompleteness(listings: readonly NormalizedListing[], fields: readonly ListingFieldName[]): { total: number; complete: number } {
  let complete = 0;
  for (const listing of listings) {
    for (const field of fields) if (present(fieldValue(listing, field))) complete += 1;
  }
  return { total: listings.length * fields.length, complete };
}

export function listingFieldCompleteness(
  listings: readonly NormalizedListing[],
  fields: readonly ListingFieldName[] = DEFAULT_REQUIRED_LISTING_FIELDS,
): { total: number; complete: number } {
  return fieldCompleteness(listings, fields);
}

export function listingFieldCoverage(
  listings: readonly NormalizedListing[],
  profile?: SourceFieldProfile,
): { required: { total: number; complete: number }; optional: { total: number; complete: number } } {
  const required = profile?.required ?? DEFAULT_REQUIRED_LISTING_FIELDS;
  return {
    required: fieldCompleteness(listings, required),
    optional: fieldCompleteness(listings, profile?.optional ?? []),
  };
}
