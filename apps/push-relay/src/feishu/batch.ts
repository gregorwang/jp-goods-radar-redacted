/**
 * 把这一小时攒下的几条推送（每个 IP 每批巡回一条，collector 投来的 PushMessage）合成飞书卡片。
 *
 * 同一个 IP 的几条（煤炉那批 + 晚几分钟的雅虎拍卖那批 + 一手店每天那轮）并成一节；
 * 同一件商品出现两次只留一次。一节超过 MAX_ITEMS_PER_CARD 件就切开（每块各配一张九宫格图），
 * 再把这些块按顺序装进卡片，每张卡不超过 MAX_ITEMS_PER_CARD 件。
 */
import { MAX_ITEMS_PER_CARD, shortProfileName, type AlertInfo, type CardItem, type CardSection, type DigestCardModel } from "./card";

/** 一条一张卡的通知：精确同款上新、商品变化（降价等）。其余（hourly_digest、老消息没写 kind 的）按每小时日报合卡。 */
const ALERT_KINDS = new Set(["exact_match", "listing_change"]);
export const FEISHU_KINDS = new Set(["hourly_digest", ...ALERT_KINDS]);

export function isAlert(message: StoredPush): boolean {
  return typeof message.kind === "string" && ALERT_KINDS.has(message.kind);
}

interface StoredItem {
  sourceId?: unknown;
  sourceItemId?: unknown;
  sourceLabel?: unknown;
  title?: unknown;
  price?: unknown;
  auction?: unknown;
  bidCount?: unknown;
  auctionEndsAt?: unknown;
  bundle?: unknown;
  imageUrl?: unknown;
  url?: unknown;
  listedAt?: unknown;
  sales?: unknown;
  tag?: unknown;
  note?: unknown;
  others?: unknown;
}

export interface StoredPush {
  id: number;
  kind?: unknown;
  total?: unknown;
  suspectTotal?: unknown;
  change?: unknown;
  profileId?: unknown;
  profileName?: unknown;
  digestEventId?: unknown;
  createdAt?: unknown;
  failedSources?: unknown;
  items?: unknown;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function toItem(raw: StoredItem, profileId: string, digestEventId: string | undefined): CardItem {
  const others = Array.isArray(raw.others) ? raw.others as Array<{ price?: unknown }> : [];
  const otherPrices = others.map((other) => num(other.price)).filter((price): price is number => price !== undefined);
  const sales = raw.sales && typeof raw.sales === "object" ? raw.sales as CardItem["sales"] : undefined;
  return {
    n: 0,
    profileId,
    ...(digestEventId ? { digestEventId } : {}),
    sourceId: str(raw.sourceId) ?? "",
    ...(str(raw.sourceItemId) ? { sourceItemId: str(raw.sourceItemId) } : {}),
    sourceLabel: str(raw.sourceLabel) ?? str(raw.sourceId) ?? "",
    title: str(raw.title) ?? "未命名商品",
    price: num(raw.price) ?? null,
    auction: raw.auction === true,
    ...(num(raw.bidCount) !== undefined ? { bidCount: num(raw.bidCount) } : {}),
    ...(str(raw.auctionEndsAt) ? { auctionEndsAt: str(raw.auctionEndsAt) } : {}),
    bundle: raw.bundle === true,
    ...(str(raw.url) ? { url: str(raw.url) } : {}),
    ...(str(raw.imageUrl) ? { imageUrl: str(raw.imageUrl) } : {}),
    ...(str(raw.listedAt) ? { listedAt: str(raw.listedAt) } : {}),
    ...(sales && typeof sales.median === "number" ? { sales } : {}),
    ...(str(raw.tag) ? { tag: str(raw.tag) } : {}),
    ...(str(raw.note) ? { note: str(raw.note) } : {}),
    others: others.length,
    ...(otherPrices.length > 0 ? { othersMin: Math.min(...otherPrices) } : {}),
  };
}

export interface PlannedCard {
  model: DigestCardModel;
  messageIds: number[];
}

export function planDigestCards(messages: StoredPush[], options: { batchAt: string; nextRunAt?: string; sample?: boolean }): PlannedCard[] {
  const sections = new Map<string, { section: CardSection; messageIds: Set<number>; seen: Set<string> }>();
  for (const message of messages) {
    const profileId = str(message.profileId) ?? "unknown";
    const digestEventId = str(message.digestEventId);
    let entry = sections.get(profileId);
    if (!entry) {
      entry = {
        section: { profileId, name: shortProfileName(str(message.profileName) ?? "关键词雷达"), total: 0, items: [], failedSources: [] },
        messageIds: new Set(),
        seen: new Set(),
      };
      sections.set(profileId, entry);
    }
    entry.messageIds.add(message.id);
    for (const failed of Array.isArray(message.failedSources) ? message.failedSources : []) {
      if (typeof failed === "string" && !entry.section.failedSources.includes(failed)) entry.section.failedSources.push(failed);
    }
    for (const raw of Array.isArray(message.items) ? message.items as StoredItem[] : []) {
      const item = toItem(raw, profileId, digestEventId);
      const key = `${item.sourceId}\u0000${item.sourceItemId ?? item.url ?? item.title}`;
      if (entry.seen.has(key)) continue;
      entry.seen.add(key);
      entry.section.items.push(item);
    }
  }

  const ordered = [...sections.values()]
    .filter((entry) => entry.section.items.length > 0)
    .sort((left, right) => left.section.name.localeCompare(right.section.name, "zh"));
  for (const entry of ordered) entry.section.total = entry.section.items.length;
  const counts = ordered.map((entry) => ({ name: entry.section.name, total: entry.section.total }));
  const cheaper = ordered.reduce(
    (sum, entry) => sum + entry.section.items.filter((item) => item.sales?.verdict === "cheaper").length,
    0,
  );

  // 一节切成不超过 MAX_ITEMS_PER_CARD 件的块，序号在块内从 1 开始（和这一块的九宫格图对应）。
  const pieces: Array<{ section: CardSection; messageIds: Set<number> }> = [];
  for (const entry of ordered) {
    for (let start = 0; start < entry.section.items.length; start += MAX_ITEMS_PER_CARD) {
      const items = entry.section.items.slice(start, start + MAX_ITEMS_PER_CARD).map((item, index) => ({ ...item, n: index + 1 }));
      pieces.push({ section: { ...entry.section, items, ...(start > 0 ? { continued: true } : {}) }, messageIds: entry.messageIds });
    }
  }

  const cards: Array<{ sections: CardSection[]; messageIds: Set<number> }> = [];
  for (const piece of pieces) {
    const last = cards[cards.length - 1];
    const used = last ? last.sections.reduce((sum, section) => sum + section.items.length, 0) : Number.POSITIVE_INFINITY;
    if (last && used + piece.section.items.length <= MAX_ITEMS_PER_CARD) {
      last.sections.push(piece.section);
      piece.messageIds.forEach((id) => last.messageIds.add(id));
    } else {
      cards.push({ sections: [piece.section], messageIds: new Set(piece.messageIds) });
    }
  }

  return cards.map((card, index) => ({
    model: {
      id: crypto.randomUUID(),
      batchAt: options.batchAt,
      sections: card.sections,
      counts,
      ...(cards.length > 1 ? { part: { index: index + 1, count: cards.length } } : {}),
      cheaper,
      ...(options.nextRunAt ? { nextRunAt: options.nextRunAt } : {}),
      ...(options.sample ? { sample: true } : {}),
    },
    messageIds: [...card.messageIds],
  }));
}

/**
 * 精确同款上新、商品变化：一条通知一张卡（不和每小时日报合并，标题栏直接写「确认同款」「降价」）。
 * 件数超过 MAX_ITEMS_PER_CARD 的只放前面那些（精确同款一轮很少超过几件）。
 */
export function planAlertCards(messages: StoredPush[], options: { batchAt: string }): PlannedCard[] {
  return messages.flatMap((message) => {
    const profileId = str(message.profileId) ?? "unknown";
    const name = shortProfileName(str(message.profileName) ?? "雷达");
    const items = (Array.isArray(message.items) ? message.items as StoredItem[] : [])
      .slice(0, MAX_ITEMS_PER_CARD)
      .map((raw, index) => ({ ...toItem(raw, profileId, undefined), n: index + 1 }));
    if (items.length === 0) return [];
    const change = message.change && typeof message.change === "object" ? message.change as Record<string, unknown> : undefined;
    const alert: AlertInfo = message.kind === "exact_match"
      ? { kind: "exact_match", confirmed: num(message.total) ?? 0, suspects: num(message.suspectTotal) ?? 0 }
      : {
        kind: "listing_change",
        change: {
          type: str(change?.type) ?? "",
          ...(num(change?.oldPrice) !== undefined ? { oldPrice: num(change?.oldPrice) } : {}),
          ...(num(change?.newPrice) !== undefined ? { newPrice: num(change?.newPrice) } : {}),
        },
      };
    const failedSources = (Array.isArray(message.failedSources) ? message.failedSources : [])
      .filter((value): value is string => typeof value === "string");
    const section: CardSection = { profileId, name, total: items.length, items, failedSources };
    return [{
      model: {
        id: crypto.randomUUID(),
        batchAt: options.batchAt,
        sections: [section],
        counts: [{ name, total: items.length }],
        cheaper: 0,
        alert,
      },
      messageIds: [message.id],
    }];
  });
}

/** 一批推送 → 飞书卡片：每小时日报合成几张，精确同款和商品变化各自一张。 */
export function planCards(messages: StoredPush[], options: { batchAt: string; nextRunAt?: string; sample?: boolean }): PlannedCard[] {
  return [
    ...planDigestCards(messages.filter((message) => !isAlert(message)), options),
    ...planAlertCards(messages.filter(isAlert), options),
  ];
}
