import { sourcePaginationPolicy } from "./source-pagination.js";
import type { NormalizedListing, SourceId } from "./types.js";

/**
 * 关键词上新的窗口策略。
 *
 * 上新采集用的是「回溯到重叠为止」：来源按最新在前返回结果，我们一直往回翻，
 * 直到翻到已经覆盖过的区间为止，那一页之后的东西本轮就不必再读。这个模式要成立
 * 需要来源按上架时间倒序，而生产里只有一部分来源满足：
 *
 * - mercari 按创建时间倒序，animate / charaon / amiami 按上架倒序：满足；
 * - rakuten_ichiba 按 `-updateTimestamp`、surugaya 按 `modificationTime`：按**更新**
 *   时间排序，老商品改一次价就会跳回第一页；
 * - yahoo_shopping 与 cospa 根本不支持排序，返回的是相关度序。
 *
 * 所以收敛条件不能是"撞上任意一个已知 ID 就停"——那样一个被顶上来的老商品就能
 * 把整轮回溯截断在第三位，真正的新品还在它下面。这里用的是集合判据而不是顺序判据：
 * 只要本页还存在「没见过」或「比水位线新」的商品就继续往回翻，整页都既见过、又不比
 * 水位线新时才停。这个规则对非单调的来源同样安全，最坏情况只是多翻几页。
 */

/** 判定一页是否已经完全落在既有覆盖范围内。 */
export function newListingPageCovered(input: {
  listings: readonly Pick<NormalizedListing, "sourceItemId" | "sourceListedAt">[];
  knownSourceItemIds: ReadonlySet<string>;
  /** 该绑定已覆盖到的最新上架时间；来源不提供上架时间时为 undefined。 */
  watermark?: string;
}): boolean {
  const watermarkTime = parseListedAt(input.watermark);
  return input.listings.every((listing) => {
    if (!input.knownSourceItemIds.has(listing.sourceItemId)) return false;
    if (watermarkTime === undefined) return true;
    const listedAt = parseListedAt(listing.sourceListedAt);
    return listedAt === undefined || listedAt <= watermarkTime;
  });
}

/**
 * 首次锚定要挖得比日常巡回深，否则"随便一抓 30 条"得到的不是语料锚点，
 * 而只是某一时刻最新的 30 条：比它更老的商品对系统永远是未知的，
 * 之后任何一次重排都会让老货看起来像上新。
 *
 * 同时也不能直接打满 maxPage（rakuten 是 100 页），锚定一次就要上百次请求。
 */
const ANCHOR_PAGE_FLOOR = 8;

/**
 * 锚定完成后日常巡回的页预算。它同时也是**锚定必须达到的最低深度**：
 * 锚定只挖到 D 页而日常要读 B 页（D < B）时，第 D+1..B 页那些从没被观察过的存量
 * 会在下一轮被集合判据全判成"没见过"，一次性冒充成上新。
 */
export function newListingDailyPageBudget(sourceId: SourceId): number {
  const policy = sourcePaginationPolicy(sourceId);
  return Math.max(1, Math.min(policy.marketDefaultPages, policy.maxPage));
}

export function newListingPageBudget(input: { sourceId: SourceId; anchored: boolean }): number {
  const policy = sourcePaginationPolicy(input.sourceId);
  if (input.anchored) return newListingDailyPageBudget(input.sourceId);
  return Math.max(1, Math.min(Math.max(policy.marketDefaultPages, ANCHOR_PAGE_FLOOR), policy.maxPage));
}

/**
 * 锚定轮最多重试几次就认账。
 *
 * 截断的锚定轮不该落锁（见 `newListingAnchorSettled`），但"永不落锁"会换来更坏的
 * 故障：未锚定的绑定一直走静默的锚定轮，那个来源就再也不会推任何上新。生产里
 * yahoo_shopping 的第 3 页至今一次都没成功过，正是这种绑定。所以重试要有上界：
 * 连续几轮都挖不到日常深度就接受既有深度，代价是一次性的假上新，而不是永久失声。
 */
export const NEW_LISTING_ANCHOR_MAX_ATTEMPTS = 3;

/**
 * 这一轮锚定能不能落锁。
 *
 * 落锁是不可逆的（`new_listing_anchored_at` 用 COALESCE 只写一次），所以判据要严：
 * 窗口没被截断（读到了收敛或上游没有下一页）说明覆盖是完整的；否则至少要够到日常
 * 深度才算数。两者都不满足就把锚定留给下一轮重来，直到用完重试上界。
 */
export function newListingAnchorSettled(input: {
  sourceId: SourceId;
  pagesFetched: number;
  windowTruncated: boolean;
  attempt: number;
}): boolean {
  if (!input.windowTruncated) return true;
  if (input.pagesFetched >= newListingDailyPageBudget(input.sourceId)) return true;
  return input.attempt >= NEW_LISTING_ANCHOR_MAX_ATTEMPTS;
}

/**
 * 推进水位线。只认本轮真实观察到的上架时间，且绝不回退：
 * 某一轮窗口恰好没带上架时间时，水位线保持原值而不是被清空。
 * 未来时间戳会被丢弃，否则一条错误数据能把水位线推到无限远、让之后所有商品都算"旧的"。
 *
 * 返回值统一归一化成 UTC ISO-8601（`Z` 结尾）。来源给的格式并不一致——雅虎跳蚤市场
 * 返回 `2026-09-04T22:42:38+09:00`，雅虎拍卖返回 `Z`——而落库后的单调性守卫是
 * **字符串比较**：混用偏移量和 Z 时，字典序和时间序会背离，守卫就可能把真正更新的
 * 水位线判成回退而丢掉。这里统一格式，让两侧的比较口径一致。
 */
export function nextNewListingWatermark(
  current: string | undefined,
  listings: readonly Pick<NormalizedListing, "sourceListedAt">[],
  now = Date.now(),
): string | undefined {
  const horizon = now + 24 * 60 * 60_000;
  let bestTime = parseListedAt(current);
  for (const listing of listings) {
    const listedAt = parseListedAt(listing.sourceListedAt);
    if (listedAt === undefined || listedAt > horizon) continue;
    if (bestTime === undefined || listedAt > bestTime) bestTime = listedAt;
  }
  return bestTime === undefined ? undefined : new Date(bestTime).toISOString();
}

/**
 * 单条商品的发现口径。摘要和后续分析需要区分"市场真的新上架"和"我们第一次看见"：
 * 只有来源提供上架时间时前者才可知，8 个来源在生产中一条上架时间都没有。
 */
export function newListingDiscoveryKind(input: {
  sourceListedAt?: string;
  watermark?: string;
}): "listed_new" | "newly_seen" {
  const listedAt = parseListedAt(input.sourceListedAt);
  if (listedAt === undefined) return "newly_seen";
  const watermarkTime = parseListedAt(input.watermark);
  if (watermarkTime === undefined) return "listed_new";
  return listedAt > watermarkTime ? "listed_new" : "newly_seen";
}

function parseListedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
