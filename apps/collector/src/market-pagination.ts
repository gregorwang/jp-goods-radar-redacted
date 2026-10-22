import { newListingPageCovered, type SearchRequest, type SearchResult } from "@jpgr/core";
import type { RoutedSearchResult } from "./source-execution";

type RequestEvidence = NonNullable<SearchResult["requestEvidence"]>;

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
}

/**
 * 合并多次请求的取数证据。可选计数一律用 sumOptional：全部来源都没给出时必须保持缺失，
 * 折成 0 会把"未知"写成"确实为 0"，并被原样持久化进分析库。
 * normalizedResultCount 缺省时按各页求和，调用方去重后应传入真实条数。
 */
export function mergedRequestEvidence(
  results: readonly SearchResult[],
  normalizedResultCount?: number,
): RequestEvidence | undefined {
  const evidence = results.map((result) => result.requestEvidence).filter((value): value is RequestEvidence => value !== undefined);
  if (!evidence.length) return undefined;
  const requestedStatuses = [...new Set(evidence.flatMap((value) => value.requestedStatuses ?? []))];
  const keywordRawResultCount = sumOptional(evidence.map((value) => value.keywordRawResultCount));
  const liveDetailResultCount = sumOptional(evidence.map((value) => value.liveDetailResultCount));
  const anchorCandidateCount = sumOptional(evidence.map((value) => value.anchorCandidateCount));
  const parserAcceptedCount = sumOptional(evidence.map((value) => value.parserAcceptedCount));
  const parserRejectedCount = sumOptional(evidence.map((value) => value.parserRejectedCount));
  const collectionOutcome = evidence.some((value) => value.collectionOutcome === "items")
    ? "items" as const
    : evidence.every((value) => value.collectionOutcome === "verified_empty")
      ? "verified_empty" as const
      : undefined;
  return {
    availabilityMode: evidence[0]!.availabilityMode,
    ...(requestedStatuses.length ? { requestedStatuses } : {}),
    rawResultCount: evidence.reduce((total, value) => total + value.rawResultCount, 0),
    normalizedResultCount: normalizedResultCount ?? evidence.reduce((total, value) => total + value.normalizedResultCount, 0),
    pagesFetched: evidence.reduce((total, value) => total + value.pagesFetched, 0),
    ...(keywordRawResultCount === undefined ? {} : { keywordRawResultCount }),
    ...(liveDetailResultCount === undefined ? {} : { liveDetailResultCount }),
    ...(anchorCandidateCount === undefined ? {} : { anchorCandidateCount }),
    ...(parserAcceptedCount === undefined ? {} : { parserAcceptedCount }),
    ...(parserRejectedCount === undefined ? {} : { parserRejectedCount }),
    ...(collectionOutcome ? { collectionOutcome } : {}),
  };
}

function singlePageConfig(sourceConfig: Record<string, unknown> | undefined, pageToken?: string): Record<string, unknown> {
  const { pageToken: _pageToken, pages: _pages, pageCount: _pageCount, ...stable } = sourceConfig ?? {};
  return {
    ...stable,
    pages: 1,
    pageCount: 1,
    ...(pageToken ? { pageToken } : {}),
  };
}

interface PageWindowOptions {
  aggregatePageKey?: "pages" | "pageCount";
  /** 返回 false 时立即停止翻页；用于窗口已经追平既有数据时提前收敛。 */
  continueAfterPage?: (result: RoutedSearchResult) => boolean;
  /** 预算耗尽但上游仍有后续页时的提示语。 */
  budgetWarning?: (pagesFetched: number) => string;
  /**
   * 上游重复返回同一个游标时的处理方式。
   * 行情观察要求窗口可比，游标不前进说明分页参数没有生效，必须失败关闭（默认）。
   * 新品窗口相反：已经读到的页仍然是有效证据，丢掉整轮反而更糟，停下并标记截断即可。
   */
  repeatedCursor?: "throw" | "stop";
}

/** Collects a bounded, comparable multi-page window inside one market run. */
export async function collectMarketWindow(
  request: SearchRequest,
  pageBudget: number,
  execute: (pageRequest: SearchRequest) => Promise<RoutedSearchResult>,
  options: PageWindowOptions = {},
): Promise<RoutedSearchResult> {
  const budget = Math.max(1, Math.trunc(pageBudget));
  if (options.aggregatePageKey) {
    const { pageToken: _pageToken, pages: _pages, pageCount: _pageCount, ...stableConfig } = request.sourceConfig ?? {};
    return execute({
      ...request,
      filters: { ...request.filters, page: 1 },
      sourceConfig: { ...stableConfig, [options.aggregatePageKey]: budget },
    });
  }

  const results: RoutedSearchResult[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let convergedEarly = false;

  // 逐页串行：翻页不引入并发，来源自身的页间等待与 request pacer 照常生效。
  for (let page = 0; page < budget; page += 1) {
    let result: RoutedSearchResult;
    try {
      result = await execute({
        ...request,
        filters: { ...request.filters, page: 1 },
        sourceConfig: singlePageConfig(request.sourceConfig, cursor),
      });
    } catch (error) {
      // 首页失败是来源真的不可用，照旧上抛。后续页失败只说明回溯没能走到底：
      // 前面已经拿到的页是有效观察，丢掉它们等于把一次成功采集判成失败，
      // 还会触发重试与来源冷却。页预算越深，踩中单页超时的概率越高——
      // 8 页锚定轮把这个概率放大了 8 倍，一页超时就报废整轮是不可接受的。
      if (page === 0) throw error;
      console.warn(JSON.stringify({
        event: "source_pagination_page_failed",
        sourceId: results[0]?.sourceId,
        pagesFetched: results.length,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      break;
    }
    results.push(result);
    if (options.continueAfterPage && !options.continueAfterPage(result)) {
      convergedEarly = true;
      break;
    }
    const next = result.nextCursor;
    if (!next) break;
    if (cursors.has(next)) {
      if (options.repeatedCursor !== "stop") throw new Error(`来源 ${result.sourceId} 返回了重复分页游标`);
      console.warn(JSON.stringify({
        event: "source_pagination_cursor_stalled",
        sourceId: result.sourceId,
        pagesFetched: results.length,
      }));
      break;
    }
    cursors.add(next);
    cursor = next;
  }

  const first = results[0];
  const last = results.at(-1);
  if (!first || !last) throw new Error("行情分页未返回任何结果");

  const seen = new Set<string>();
  const listings = results.flatMap((result) => result.listings).filter((listing) => {
    const key = `${listing.sourceId}:${listing.sourceItemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const totals = results.map((result) => result.totalAvailable).filter((value): value is number => value !== undefined);
  const warnings = [...new Set(results.flatMap((result) => result.warnings))];
  // 因为窗口已追平既有数据而提前停止时，后面的页本来就无须读取，不算预算截断。
  if (last.nextCursor && !convergedEarly) {
    warnings.push(options.budgetWarning?.(results.length)
      ?? `本次行情观察按安全预算读取 ${results.length} 页，上游仍有后续结果。`);
  }
  const requestEvidence = mergedRequestEvidence(results, listings.length);

  return {
    ...last,
    sourceId: first.sourceId,
    listings,
    coverage: first.coverage,
    ...(last.nextCursor ? { nextCursor: last.nextCursor } : { nextCursor: undefined }),
    ...(totals.length ? { totalAvailable: Math.max(...totals) } : { totalAvailable: undefined }),
    warnings,
    ...(requestEvidence ? { requestEvidence } : { requestEvidence: undefined }),
  };
}

/**
 * 新品监控的有界翻页：回溯到本页完全落入既有覆盖范围为止。
 *
 * 收敛判据见 `newListingPageCovered`——是集合判据而不是顺序判据。此前的实现是
 * "本页全是未观察过的 ID 才继续"，等价于"撞上任意一个已知 ID 就停"；对按更新时间
 * 排序的来源（rakuten `-updateTimestamp`、surugaya `modificationTime`），一个改过价
 * 而被顶回第一页的老商品就能把整轮回溯截断，真正的新品还在它下面永远读不到。
 *
 * 预算耗尽而收敛条件仍未满足时必须显式告知调用方（`windowTruncated`）：
 * 那说明本轮覆盖不完整，既要写进运行证据，也不能被当成"今天就这么多新品"。
 *
 * `exhaustive` 是首次锚定用的：那一轮要把预算读满，不能套用收敛判据。锚定时还没有
 * 水位线，判据退化成"整页都见过就停"，而历史上只读过一页的绑定，第一页恰恰全都见过
 * ——收敛立刻成立，深预算一页都用不上，锚定深度与日常巡回毫无区别。
 */
export async function collectNewListingWindow(
  request: SearchRequest,
  pageBudget: number,
  execute: (pageRequest: SearchRequest) => Promise<RoutedSearchResult>,
  window: { knownSourceItemIds: ReadonlySet<string>; watermark?: string; exhaustive?: boolean },
): Promise<RoutedSearchResult> {
  let covered = false;
  const result = await collectMarketWindow(request, pageBudget, execute, {
    continueAfterPage: (page) => {
      covered = window.exhaustive !== true && newListingPageCovered({
        listings: page.listings,
        knownSourceItemIds: window.knownSourceItemIds,
        ...(window.watermark === undefined ? {} : { watermark: window.watermark }),
      });
      return !covered && Boolean(page.nextCursor);
    },
    budgetWarning: (pagesFetched) => `本次新品窗口按安全预算读取 ${pagesFetched} 页，上游仍有后续结果，本轮覆盖已在此截断。`,
    repeatedCursor: "stop",
  });
  // 收敛条件没满足就停下，只可能是预算耗尽或上游没有下一页；后者不算截断。
  return { ...result, windowTruncated: !covered && Boolean(result.nextCursor) };
}
