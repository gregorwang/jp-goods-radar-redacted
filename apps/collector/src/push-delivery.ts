/**
 * 飞书 / App 推送渠道，以及「档案决定发到哪」的收尾（docs/常用/自用推送渠道-总览.md）。
 *
 * 每个档案两个开关（watch_profiles.notify_email / notify_feishu，2026-10-14 起，在档案页上点）：
 * - 开了飞书：关键词日报、精确同款上新、降价等商品变化交给推送服务（push-relay），它再发到勾了这个档案的群和你的私聊；
 * - 只开飞书：不发邮件；推送服务回报飞书一个群、私聊都没收到，或者迟迟没回音，就补一封邮件，邮件开头写明原因；
 * - 两个都关：只巡回、不通知，这些通知直接作废；
 * - 开了邮件：照常发邮件，和飞书互不影响。
 * 来源故障、精确同款周报不属于单个档案，不受开关管，照发邮件。
 *
 * runtime_feature_flags.owner_push_v1.enabled 是推送这一路的总闸：关着时一概不推，只开飞书的档案也改发邮件。
 *
 * 取件、认领、重试、放弃走通知登记簿的共用循环（notice-channel.ts），这里只有飞书自己的事：
 * 卡片长什么样、怎么交给推送服务、问推送服务发没发到、没发到时补邮件。
 * 通道启用时间之前的事件不投（notification_channels 里的 owner_push）；失败有次数和 3 天年龄上限。
 */
import type { PendingPushRow, RadarRepository } from "@jpgr/db";
import { digestExtrasFromPayload } from "@jpgr/core";
import { groupSameTitle, sourceLabel } from "@jpgr/email";
import { ChannelSendError, runNoticeChannel } from "./notice-channel";
import type { RuntimeEnv as Env } from "./runtime-env";

export const OWNER_PUSH_FLAG = "owner_push_v1";
const PUSH_DELIVERY_LIMIT = 20;
const OUTCOME_BATCH = 100;
const CHANNEL_ACTIVATION_GRACE_MS = 5 * 60 * 1_000;
/** 和 packages/notifications/src/hermes.ts 的 DEFAULT_TIMEOUT_MS 一样。 */
const PUBLISH_TIMEOUT_MS = 8_000;
/** 一条推送最多带几张卡片（同名折叠之后）；超过的只在 groupTotal 里体现。还受下面的字节上限约束。 */
const MAX_PUSH_ITEMS = 120;
/** push-relay 单条上限 512 KiB（hub.ts MAX_MESSAGE_BYTES），留点余量。 */
const MAX_MESSAGE_BYTES = 480 * 1024;

/**
 * push-relay 与本 Worker 同账号：用 workers.dev 网址直接 fetch 会被拦成 `404 error code: 1042`，
 * 所以只走服务绑定 PUSH_RELAY。PUSH_PUBLISH_TOKEN 和 push-relay 的同名 secret 成对。
 */
type PushEnv = Env & { PUSH_RELAY?: Fetcher; PUSH_PUBLISH_TOKEN?: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 推送这一路的总闸（owner_push_v1.enabled）。读不出来当关着：只开飞书的档案就照发邮件。 */
export async function ownerPushEnabled(env: Env): Promise<boolean> {
  try {
    const flag = await env.DB.prepare("SELECT enabled FROM runtime_feature_flags WHERE flag_key=?")
      .bind(OWNER_PUSH_FLAG).first<{ enabled: number | string }>();
    return Number(flag?.enabled) === 1;
  } catch {
    return false;
  }
}

/**
 * 发邮件之前、以及每分钟各跑一次，按档案开关收尾：
 * 1. 问推送服务飞书结果；
 * 2. 只开飞书、飞书送到了的，通知记成已发出；
 * 3. 只开飞书、却没送到的，补一行邮件（带原因）；
 * 4. 两个开关都关的档案，通知作废。
 * 每一步失败都只记日志——多一封邮件好过一封都没有。返回补了几封邮件。
 */
export async function routeDossierNotifications(env: Env, repository: RadarRepository): Promise<number> {
  const pushEnabled = await ownerPushEnabled(env);
  let returnedCount = 0;
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(JSON.stringify({
        event: "dossier_routing_failed",
        step: name,
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }));
    }
  };
  if (pushEnabled) await step("outcomes", () => collectPushOutcomes(env, repository));
  await step("settle", () => repository.settleFeishuOnlyNotices());
  await step("fallback", async () => {
    const returned = await repository.fallBackToEmail(pushEnabled);
    returnedCount = returned.length;
    if (returned.length > 0) {
      console.warn(JSON.stringify({
        event: "owner_push_returned_to_email",
        notices: returned.length,
        reasons: [...new Set(returned.map((entry) => entry.reason))].slice(0, 5),
      }));
    }
  });
  await step("silence", () => repository.suppressSilencedDossierNotices());
  return returnedCount;
}

/** 飞书没送到、补发邮件时写在邮件最上面的那句话。 */
export function pushFallbackNotice(reason: string): string {
  return `这个档案只开了飞书推送，但飞书没送到（${reason}），所以这次改用邮件发给你。`;
}

/**
 * 问推送服务：交给它的那几条，飞书发出去没有。
 * delivered = 至少一个群或你的私聊收到；failed = 一个都没收到（没有群收这个档案、私聊没开、飞书报错、额度到线）。
 * 推送服务还是旧版本（没有 /outcomes）就什么都不记，靠 20 分钟超时补邮件。
 */
async function collectPushOutcomes(env: Env, repository: RadarRepository): Promise<void> {
  const pushEnv = env as PushEnv;
  if (!pushEnv.PUSH_RELAY || !pushEnv.PUSH_PUBLISH_TOKEN) return;
  const rows = await repository.noticesAwaitingOutcome("feishu", OUTCOME_BATCH);
  if (rows.length === 0) return;
  const response = await pushEnv.PUSH_RELAY.fetch("https://push-relay/outcomes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Token": pushEnv.PUSH_PUBLISH_TOKEN },
    body: JSON.stringify({ ids: rows.map((row) => Number(row.remote_id)) }),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`push-relay outcomes ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = record(await response.json());
  const outcomes = new Map<number, { status: string; error: string | null }>();
  for (const raw of Array.isArray(body.outcomes) ? body.outcomes : []) {
    const entry = record(raw);
    const id = finite(entry.id);
    if (id !== undefined && typeof entry.status === "string") {
      outcomes.set(id, { status: entry.status, error: typeof entry.error === "string" ? entry.error : null });
    }
  }
  for (const row of rows) {
    const outcome = outcomes.get(Number(row.remote_id));
    if (!outcome || outcome.status === "pending") continue;
    if (outcome.status === "delivered") await repository.recordNoticeOutcome(row.delivery_id, "delivered", null);
    else await repository.recordNoticeOutcome(row.delivery_id, "failed", outcome.error ?? (outcome.status === "unknown" ? "推送服务里查不到这一条" : "飞书没送到"));
  }
}

export interface PushSales {
  /** 「同款行情」（提供方确认同款的统计）或「同款成交」（逐条核对过标题的成交）。 */
  label: string;
  median: number;
  n: number;
  /** 本件比参考价：便宜 / 贵 / 持平。拍卖不比（当前出价不是成交价）。 */
  verdict?: "cheaper" | "pricier" | "even";
  verdictText?: string;
}

/** 和日报邮件同一口径（packages/email/src/templates.ts 的 comparisonSegment / enrichmentView）。 */
function verdictOf(ratio: number): Pick<PushSales, "verdict" | "verdictText"> {
  if (Math.abs(ratio - 1) < 0.03) return { verdict: "even", verdictText: "基本持平" };
  if (ratio < 1) return { verdict: "cheaper", verdictText: `便宜 ${Math.round((1 - ratio) * 100)}%` };
  if (ratio < 2) return { verdict: "pricier", verdictText: `贵 ${Math.round((ratio - 1) * 100)}%` };
  return { verdict: "pricier", verdictText: `是 ${(Math.round(ratio * 10) / 10).toString()} 倍` };
}

/** 只用邮件里也会出现的两种可靠证据；配不准就不带（日报邮件同一条规矩）。 */
function salesOf(item: Record<string, unknown>, price: number | null, auction: boolean): PushSales | undefined {
  const picked = record(record(record(item.enrichment).market).picked);
  const p50 = finite(picked.p50);
  const n = finite(picked.n);
  if (picked.tier === "same_product" && p50 !== undefined && n !== undefined && p50 > 0) {
    const sales: PushSales = { label: "同款行情", median: Math.round(p50), n };
    return price !== null && !auction ? { ...sales, ...verdictOf(price / p50) } : sales;
  }
  const verified = (Array.isArray(item.verifiedSales) ? item.verifiedSales : [])
    .map((entry) => finite(record(entry).priceJpy))
    .filter((value): value is number => value !== undefined && value > 0)
    .slice(0, 3)
    .sort((left, right) => left - right);
  if (verified.length === 0) return undefined;
  const middle = verified.length % 2 === 1
    ? verified[(verified.length - 1) / 2]!
    : (verified[verified.length / 2 - 1]! + verified[verified.length / 2]!) / 2;
  const sales: PushSales = { label: "同款成交", median: Math.round(middle), n: verified.length };
  return price !== null && !auction ? { ...sales, ...verdictOf(price / middle) } : sales;
}

export interface PushItem {
  sourceId: string;
  /** 来源商品号：App 标注、「等降价」按它找商品。 */
  sourceItemId?: string;
  sourceLabel: string;
  title: string;
  price: number | null;
  auction: boolean;
  bidCount?: number;
  auctionEndsAt?: string;
  bundle: boolean;
  recovered: boolean;
  imageUrl?: string;
  url?: string;
  listedAt?: string;
  updatedAt?: string;
  sales?: PushSales;
  /** 精确同款里没确认的那几件：判定档位（高度疑似 / 证据不足…）和差在哪，和邮件里「疑似同款」同一口径。 */
  tag?: string;
  note?: string;
  /** 同名折叠进这张卡的其他卖家，已按价格排好。 */
  others: Array<{ sourceId: string; sourceItemId?: string; sourceLabel: string; price: number | null; auction: boolean; url?: string }>;
}

/** 商品变化：降价 / 涨价 / 到目标价 / 补货 / 卖掉了。价格来自事件载荷，和降价邮件同一份。 */
export interface PushChange {
  type: string;
  oldPrice?: number;
  newPrice?: number;
}

export interface PushMessage {
  eventKey: string;
  /**
   * hourly_digest：关键词日报（名字沿用，每天一轮的也是它）；exact_match：精确同款上新；listing_change：商品变化。
   * 推送服务按它排版，App 只认得 hourly_digest 的样子（其余照样能显示标题和价格）。
   */
  kind: "hourly_digest" | "exact_match" | "listing_change";
  /** events.id：飞书卡片上的「不想看」按它写 digest_item_labels（和 App 标注同一个接口，只对关键词日报）。 */
  digestEventId: string;
  profileId: string;
  profileName: string;
  createdAt: string;
  /** 这一轮的新货件数（不含建档存量）；精确同款是确认同款件数；商品变化是 1。 */
  total: number;
  /** 同名折叠后的卡片数；items 最多 MAX_PUSH_ITEMS 张。 */
  groupTotal: number;
  failedSources: string[];
  items: PushItem[];
  /** 精确同款：items 末尾跟着的疑似同款件数（这份档案把邮件门槛放宽了才会有）。 */
  suspectTotal?: number;
  change?: PushChange;
}

const SUSPECT_LABELS: Record<string, string> = {
  probable_exact: "高度疑似",
  uncertain: "证据不足",
  related: "相关",
  bundle: "疑似套装",
};

/**
 * 把一封日报的载荷整理成手机要显示的样子。排序、同名折叠在这里做完（规则只有一份：
 * packages/email/src/listing-groups.ts），App 只管照顺序显示。没有新货（只有建档存量）返回 null。
 */
export function pushMessageFromDigest(row: PendingPushRow): PushMessage | null {
  const payload = record(JSON.parse(row.payload_json));
  const exact = payload.kind === "exact_product_new_listing";
  const showSales = digestExtrasFromPayload(payload.digestExtras).showSales;
  const scanSummary = payload.kind === "keyword_scan_summary";
  const discoveries = (Array.isArray(payload.items) ? payload.items : [])
    .map(record)
    .filter((item) => !(scanSummary && item.category === "baseline"))
    .map((item, index) => {
      const price = finite(item.price) ?? null;
      const auctionFacts = item.auction !== undefined && item.auction !== null && item.auction !== false ? record(item.auction) : undefined;
      const auction = auctionFacts !== undefined || item.sourceId === "yahoo_auctions_jp";
      const url = httpUrl(item.url);
      const bidCount = finite(auctionFacts?.bidCount);
      return {
        sourceId: String(item.sourceId ?? ""),
        ...(typeof item.sourceItemId === "string" && item.sourceItemId ? { sourceItemId: item.sourceItemId } : {}),
        sourceLabel: sourceLabel(item.sourceId),
        title: String(item.title ?? "未命名商品").replace(/\s+/gu, " ").trim().slice(0, 300),
        price,
        auction,
        ...(bidCount !== undefined ? { bidCount } : {}),
        ...(typeof auctionFacts?.endsAt === "string" ? { auctionEndsAt: auctionFacts.endsAt } : {}),
        bundle: record(item.enrichment).is_bundle === true,
        recovered: scanSummary && item.category === "recovered",
        ...(httpUrl(item.imageUrl) ? { imageUrl: httpUrl(item.imageUrl) } : {}),
        ...(url ? { url } : {}),
        ...(typeof item.listedAt === "string" ? { listedAt: item.listedAt } : {}),
        ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
        ...(showSales && salesOf(item, price, auction) ? { sales: salesOf(item, price, auction) } : {}),
        identity: url ?? `#${index}`,
      };
    });
  // 精确同款：没确认的那几件跟在后面，带档位和差在哪（只有档案把邮件门槛放宽了，日报里才有它们）。
  const suspects: PushItem[] = exact
    ? (Array.isArray(payload.suspects) ? payload.suspects : []).slice(0, 24).map(record).map((item) => {
      const url = httpUrl(item.url);
      const reason = String(item.reason ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, 160);
      return {
        sourceId: String(item.sourceId ?? ""),
        ...(typeof item.sourceItemId === "string" && item.sourceItemId ? { sourceItemId: item.sourceItemId } : {}),
        sourceLabel: sourceLabel(item.sourceId),
        title: String(item.title ?? "未命名商品").replace(/\s+/gu, " ").trim().slice(0, 300),
        price: finite(item.price) ?? null,
        auction: item.sourceId === "yahoo_auctions_jp",
        bundle: false,
        recovered: false,
        ...(httpUrl(item.imageUrl) ? { imageUrl: httpUrl(item.imageUrl) } : {}),
        ...(url ? { url } : {}),
        tag: SUSPECT_LABELS[String(item.relation ?? "uncertain")] ?? "证据不足",
        ...(reason ? { note: reason } : {}),
        others: [],
      };
    })
    : [];
  const suspectTotal = exact ? Math.max(suspects.length, finite(payload.suspectTotal) ?? 0) : 0;
  if (discoveries.length === 0 && suspects.length === 0) return null;

  const groups = groupSameTitle(discoveries);
  const items: PushItem[] = groups.slice(0, MAX_PUSH_ITEMS).map((group) => {
    const [lead, ...rest] = group.items;
    const { identity: _identity, ...card } = lead!;
    return {
      ...card,
      others: rest.slice(0, 10).map((other) => ({
        sourceId: other.sourceId,
        ...(other.sourceItemId ? { sourceItemId: other.sourceItemId } : {}),
        sourceLabel: other.sourceLabel,
        price: other.price,
        auction: other.auction,
        ...(other.url ? { url: other.url } : {}),
      })),
    };
  });
  const message: PushMessage = {
    eventKey: `digest:${row.event_key}`,
    kind: exact ? "exact_match" : "hourly_digest",
    digestEventId: row.event_id,
    profileId: row.profile_id,
    profileName: String(payload.profileName ?? row.profile_name ?? "关键词雷达"),
    createdAt: row.event_created_at,
    total: discoveries.length,
    groupTotal: groups.length,
    failedSources: (Array.isArray(payload.failedSources) ? payload.failedSources : []).map(sourceLabel),
    items: [...items, ...suspects],
    ...(suspectTotal > 0 ? { suspectTotal } : {}),
  };
  // relay 单条上限 512 KiB：超了就从后往前去掉卡片，groupTotal 照实写，App 会提示"还有 N 张没带上"。
  while (message.items.length > 1 && new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) {
    message.items.pop();
  }
  return message;
}

/** 商品变化（降价、涨价、到目标价、补货、卖掉了）：一件商品一条。 */
export function pushMessageFromListing(row: PendingPushRow): PushMessage | null {
  if (!row.source_id || !row.title) return null;
  const payload = record(JSON.parse(row.payload_json));
  const oldPrice = finite(payload.oldPrice);
  const newPrice = finite(payload.newPrice) ?? finite(row.current_price);
  const url = httpUrl(row.canonical_url);
  const auction = row.price_basis === "auction_current_bid";
  return {
    eventKey: `event:${row.event_key}`,
    kind: "listing_change",
    digestEventId: row.event_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    createdAt: row.event_created_at,
    total: 1,
    groupTotal: 1,
    failedSources: [],
    items: [{
      sourceId: row.source_id,
      ...(row.source_item_id ? { sourceItemId: row.source_item_id } : {}),
      sourceLabel: sourceLabel(row.source_id),
      title: row.title.replace(/\s+/gu, " ").trim().slice(0, 300),
      price: newPrice ?? null,
      auction,
      bundle: false,
      recovered: false,
      ...(httpUrl(row.image_url) ? { imageUrl: httpUrl(row.image_url) } : {}),
      ...(url ? { url } : {}),
      others: [],
    }],
    change: {
      type: row.event_type,
      ...(oldPrice !== undefined ? { oldPrice } : {}),
      ...(newPrice !== undefined ? { newPrice } : {}),
    },
  };
}

/** 一条待推的通知 → 推给推送服务的样子。没有可推的内容（只有建档存量等）返回 null。 */
export function pushMessageFor(row: PendingPushRow): PushMessage | null {
  return row.event_type === "daily_digest" ? pushMessageFromDigest(row) : pushMessageFromListing(row);
}

async function publish(env: PushEnv, message: PushMessage): Promise<{ id: number; httpStatus: number }> {
  if (!env.PUSH_RELAY || !env.PUSH_PUBLISH_TOKEN) throw new ChannelSendError("PUSH_RELAY 或 PUSH_PUBLISH_TOKEN 没配", null);
  const response = await env.PUSH_RELAY.fetch("https://push-relay/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Token": env.PUSH_PUBLISH_TOKEN },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });
  const text = (await response.text()).slice(0, 500);
  if (!response.ok) throw new ChannelSendError(`push-relay ${response.status}: ${text}`, response.status);
  const id = finite(record(JSON.parse(text)).id);
  if (id === undefined) throw new ChannelSendError(`push-relay 返回里没有 id: ${text}`, response.status);
  return { id, httpStatus: response.status };
}

/**
 * 推飞书：开了飞书的档案里、能发飞书的通知交给推送服务。推送服务按 eventKey 幂等，同一份重投不会推两次。
 * 「收下」不等于「送到」：送没送到由 routeDossierNotifications 每分钟去问。
 */
export async function deliverPendingPushNotifications(env: Env, repository: RadarRepository): Promise<number> {
  if (!await ownerPushEnabled(env)) return 0;
  const enabledAt = await repository.ensureNoticeChannelEnabledAt(
    "owner_push",
    new Date(Date.now() - CHANNEL_ACTIVATION_GRACE_MS).toISOString(),
  );
  const run = await runNoticeChannel<PendingPushRow>(repository, {
    channel: "feishu",
    eventFollows: false,
    pending: () => repository.pendingFeishuNotices(enabledAt, PUSH_DELIVERY_LIMIT),
    async send(row) {
      const message = pushMessageFor(row);
      // 没有可推的新货（只有建档存量）：记成 skipped；只开飞书的档案由 settleFeishuOnlyNotices 记成已发出。
      if (!message) return { kind: "skipped", reason: "no_new_items" };
      const receipt = await publish(env as PushEnv, message);
      return {
        kind: "sent",
        remoteId: String(receipt.id),
        httpStatus: receipt.httpStatus,
        confirmed: false,
        log: { profileId: row.profile_id, kind: message.kind, items: message.total },
      };
    },
  });
  return run.sent;
}

/**
 * 一轮巡回跑完就告诉手机一声，没新货也报（没新货时不出日报、不推送，手机原本无从知道"跑了、只是没货"）。
 * App 首页顶上那行「上一轮几点跑完 · 几件新货 · 下一轮几点开跑」靠它；过了下一轮的时间还没收到，App 会提示巡回可能卡住了。
 * 只报开了飞书的档案。失败只记日志——这是状态提示，不值得重试，下一轮会再报。
 */
export async function publishKeywordRound(env: Env, repository: RadarRepository, input: {
  profileId: string;
  scanStartedAt: string;
  digestEventId: string | null;
  failedSources: readonly string[];
}): Promise<void> {
  const pushEnv = env as PushEnv;
  if (!pushEnv.PUSH_RELAY || !pushEnv.PUSH_PUBLISH_TOKEN) return;
  try {
    // 查开关也放在 try 里：它抛错会让整个日报收尾重跑（又唤醒一次估价 GPU），只为一条状态提示不值。
    // 只报开了飞书的档案：keywordRoundFacts 对没开的返回 null。
    if (!await ownerPushEnabled(env)) return;
    const now = new Date().toISOString();
    const facts = await repository.keywordRoundFacts(input.profileId, input.digestEventId, now);
    if (!facts) return;
    const response = await pushEnv.PUSH_RELAY.fetch("https://push-relay/round", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": pushEnv.PUSH_PUBLISH_TOKEN },
      body: JSON.stringify({
        profileId: input.profileId,
        profileName: facts.profile_name ?? "关键词雷达",
        scanStartedAt: input.scanStartedAt,
        finishedAt: now,
        newItems: Number(facts.new_items) || 0,
        failedSources: input.failedSources.map(sourceLabel),
        nextRunAt: facts.next_run_at,
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`push-relay ${response.status}: ${(await response.text()).slice(0, 200)}`);
  } catch (error) {
    console.error(JSON.stringify({
      event: "owner_push_round_failed",
      profileId: input.profileId,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
}
