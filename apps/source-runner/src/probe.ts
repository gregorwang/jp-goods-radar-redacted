import { executeRunnerTask } from "./execution";
import type { CreateJobBody } from "./schemas";
import { SOURCE_RUNNER_IDS, type SourceRunnerId } from "./source-policy";

const PROBE_TASKS = {
  amiami: { sourceId: "amiami", operation: "search", request: { query: "千反田える", filters: { pageSize: 3, availabilityMode: "all" } } },
  mercari_jp: {
    sourceId: "mercari_jp",
    operation: "search",
    request: {
      query: "千反田える",
      filters: { page: 1, pageSize: 5, availabilityMode: "all", sort: "newest" },
    },
  },
  rakuten_ichiba: {
    sourceId: "rakuten_ichiba",
    operation: "item",
    urlOrId: "gscraft:n0066",
  },
  yahoo_shopping: {
    sourceId: "yahoo_shopping",
    operation: "search",
    request: {
      query: "陶器",
      filters: { page: 1, pageSize: 5, availabilityMode: "all" },
      sourceConfig: { pageCount: 1 },
    },
  },
  yahoo_auctions_jp: {
    sourceId: "yahoo_auctions_jp",
    operation: "search",
    request: {
      query: "ポケモンカード",
      filters: { page: 1, pageSize: 5, inStockOnly: true, availabilityMode: "purchasable", sort: "relevance" },
    },
  },
  yahoo_fleamarket_jp: {
    sourceId: "yahoo_fleamarket_jp",
    operation: "search",
    request: { query: "リゼロ", filters: { page: 1, pageSize: 5, availabilityMode: "all" } },
  },
  surugaya: {
    sourceId: "surugaya",
    operation: "search",
    request: {
      query: "千反田える",
      filters: { page: 1, pageSize: 5, availabilityMode: "all" },
      sourceConfig: { pages: 1 },
    },
  },
} as const satisfies Record<SourceRunnerId, CreateJobBody>;

function selectedSources(value: string | undefined): readonly SourceRunnerId[] {
  if (!value || value === "all") return SOURCE_RUNNER_IDS;
  if ((SOURCE_RUNNER_IDS as readonly string[]).includes(value)) return [value as SourceRunnerId];
  throw new Error("probe_source_invalid");
}

let failed = false;
for (const sourceId of selectedSources(process.argv[2])) {
  const startedAt = Date.now();
  const outcome = await executeRunnerTask(PROBE_TASKS[sourceId]);
  const resultCount = outcome.ok && "listings" in outcome.result ? outcome.result.listings.length : null;
  console.info(JSON.stringify({
    sourceId,
    ok: outcome.ok,
    resultCount,
    errorCode: outcome.ok ? null : outcome.error.code,
    upstreamStatus: outcome.ok ? null : outcome.error.upstreamStatus,
    captures: outcome.captures.length,
    capturedBytes: outcome.captures.reduce((total, capture) => total + capture.payloadBytes, 0),
    truncatedCaptures: outcome.captures.filter((capture) => capture.truncated).length,
    durationMs: Date.now() - startedAt,
  }));
  if (!outcome.ok) failed = true;
}
if (failed) process.exitCode = 1;
