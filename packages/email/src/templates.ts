import { digestExtrasFromPayload, formatJpy, type DigestExtras, type EventType, type NormalizedListing, type SourceId } from "@jpgr/core";
import { BUNDLE_CATEGORY_ID, groupSameTitle, organizeByCategory, statPrices, type GroupableItem } from "./listing-groups";
import {
  ALERT_TEXT, INK, INK2, LINE, LINE_SOFT, MIST, MUTE, NUM, SERIF, SKY_TEXT,
  emailShell, inkButton, lineLink, marker, noteRow, pill, priceHtml, sectionHead, statRow, tag,
} from "./design";

const brandName = "格银西里尔";
// 疑似同款分区靠用户判定收敛：邮件本身写不了库，只能把人带到能标掉的那一页。
const suspectVerdictUrl = "https://eru.example.com/changes";
// 邮件底部只放浓缩版声明，完整条款放网页。
const legalNoticeUrl = "https://example.com/disclaimer/";
// 基线回执里「查看全部 N 件」指向完整清单页（/list/<日报事件编号>），
// 登录后可看。事件编号是随机 UUID，别人猜不到。
const listingSiteOrigin = "https://example.com";

export function listingPageUrl(eventId: unknown): string | undefined {
  return typeof eventId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(eventId)
    ? `${listingSiteOrigin}/list/${eventId}`
    : undefined;
}
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
const subjectText = (value: string, max = 200) => value.replace(/\s+/gu, " ").trim().slice(0, max);

const sourceLabels: Record<SourceId, string> = {
  amiami: "AmiAmi（あみあみ）",
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  yahoo_shopping: "Yahoo! Shopping",
  yahoo_auctions_jp: "Yahoo!オークション",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  amazon_jp: "Amazon Japan",
  ebay: "eBay",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate 通贩",
};

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function sourceLabel(value: unknown): string {
  return typeof value === "string" && value in sourceLabels
    ? sourceLabels[value as SourceId]
    : String(value ?? "未知来源");
}

function productImage(imageUrl: string | undefined, title: string, width: number): string {
  if (!imageUrl) return "";
  return `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;background:${MIST}" />`;
}

/** 旧名字留着，模板里到处在用：墨色胶囊主按钮。 */
const actionButton = (url: string | undefined, label: string) => inkButton(url, label);

/** 价格变化之类的几行明细：一行一条，发丝线隔开。 */
function detailPanel(rows: string[]): string {
  if (rows.length === 0) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:20px 0 0;border-collapse:collapse">${rows.map((row) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE_SOFT};font-size:13px;line-height:21px;color:${INK2}">${escapeHtml(row)}</td></tr>`).join("")}</table>`;
}

/** 单件提醒的脚注：只说一件读者用得上的事。 */
const listingFootNote = "价格和状态以商品页面为准，邮件发出后可能已经变化。";
/** 关键词日报的脚注：每个平台只翻搜索结果的前几页。 */
const limitedWindowNote = "每个平台只看搜索结果的前几页，不是平台上的全部商品。";

const availabilityLabels: Record<string, string> = {
  available: "在售",
  sold_out: "售罄",
  unavailable: "已下架",
  preorder: "预约",
  backorder: "候货",
  unknown: "状态未知",
};

function eventTypeLabel(value: unknown): string {
  const key = String(value ?? "");
  const labels: Record<string, string> = {
    new_listing: "新商品",
    price_drop: "价格下降",
    price_rise: "价格上涨",
    interest_rise: "有人盯上了",
    target_price: "达到目标价",
    restock: "恢复库存",
    sold_out: "已售出",
    source_error: "来源异常",
    watch_completed: "监控完成",
  };
  const label = labels[key] ?? key;
  return label || "状态变化";
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 「有人盯上了」那几行：评论排在点赞前面——有人评论多半是在砍价、问能不能出，离成交最近。 */
function interestChange(sourceId: string, detail: Record<string, unknown>): { headline: string; rows: string[] } | undefined {
  const likeLabel = sourceId === "yahoo_auctions_jp" ? "关注" : sourceId === "yahoo_fleamarket_jp" ? "收藏" : "いいね";
  const oldLikes = countValue(detail.oldLikeCount);
  const newLikes = countValue(detail.newLikeCount);
  const oldComments = countValue(detail.oldCommentCount);
  const newComments = countValue(detail.newCommentCount);
  const commentsRose = oldComments !== undefined && newComments !== undefined && newComments > oldComments;
  const likesRose = oldLikes !== undefined && newLikes !== undefined && newLikes > oldLikes;
  if (!commentsRose && !likesRose) return undefined;
  const rows: string[] = [];
  if (commentsRose) rows.push(`评论：${oldComments} → ${newComments} 条（多半有人在问价或砍价）`);
  if (likesRose) rows.push(`${likeLabel}：${oldLikes} → ${newLikes} 人`);
  if (!commentsRose && newComments !== undefined) rows.push(`评论：${newComments} 条`);
  if (!likesRose && newLikes !== undefined) rows.push(`${likeLabel}：${newLikes} 人`);
  const parts = [
    commentsRose ? `评论 +${newComments - oldComments}` : undefined,
    likesRose ? `${likeLabel} +${newLikes - oldLikes}` : undefined,
  ].filter(Boolean);
  return { headline: `有人盯上了 · ${parts.join(" ")}`, rows };
}

export function listingEmail(type: EventType, listing: NormalizedListing, detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const strongReminder = recordValue(detail.strongReminder);
  const strongSequence = typeof strongReminder.sequence === "number" && Number.isInteger(strongReminder.sequence)
    ? strongReminder.sequence
    : undefined;
  const strongTotal = typeof strongReminder.total === "number" && Number.isInteger(strongReminder.total)
    ? strongReminder.total
    : undefined;
  const strongLabel = strongSequence !== undefined && strongTotal !== undefined
    ? `强提醒 ${strongSequence}/${strongTotal}`
    : undefined;
  const initialAvailability = type === "restock" && detail.initialObservation === true;
  const confirmedMissing = type === "sold_out" && detail.currentAvailability === "unavailable";
  const labels: Partial<Record<EventType, string>> = {
    new_listing: "发现新商品",
    price_drop: "商品降价",
    price_rise: "商品涨价",
    interest_rise: "有人盯上了",
    target_price: "达到目标价",
    restock: "商品补货",
    sold_out: "商品售罄",
  };
  const label = detail.discoveryKind === "recovered_match" ? "恢复识别已有商品" : strongLabel ?? (initialAvailability
    ? "商品当前有货"
    : confirmedMissing
      ? "商品已下架（可能售出）"
      : labels[type] ?? "商品有变化");
  const title = escapeHtml(listing.title);
  const url = safeHttpUrl(listing.canonicalUrl);
  const image = productImage(safeHttpUrl(listing.imageUrl), listing.title, 180);
  const source = sourceLabel(listing.sourceId);
  const oldPrice = typeof detail.oldPrice === "number" ? detail.oldPrice : undefined;
  const newPrice = typeof detail.newPrice === "number" ? detail.newPrice : listing.currentPrice;
  const dropAmount = typeof detail.dropAmount === "number"
    ? detail.dropAmount
    : oldPrice !== undefined && newPrice !== undefined ? oldPrice - newPrice : undefined;
  const riseAmount = typeof detail.riseAmount === "number"
    ? detail.riseAmount
    : oldPrice !== undefined && newPrice !== undefined ? newPrice - oldPrice : undefined;
  const targetPrice = typeof detail.targetPrice === "number" ? detail.targetPrice : undefined;
  const previousAvailability = typeof detail.previousAvailability === "string" ? detail.previousAvailability : undefined;
  const dropPercent = oldPrice !== undefined && oldPrice > 0 && dropAmount !== undefined
    ? Math.round((dropAmount / oldPrice) * 1000) / 10
    : undefined;
  const risePercent = oldPrice !== undefined && oldPrice > 0 && riseAmount !== undefined
    ? Math.round((riseAmount / oldPrice) * 1000) / 10
    : undefined;
  const detailRows: string[] = [];
  if ((type === "price_drop" || type === "price_rise" || type === "target_price") && oldPrice !== undefined && newPrice !== undefined) {
    detailRows.push(`旧价格：${formatJpy(oldPrice)}`, `新价格：${formatJpy(newPrice)}`);
    if (dropAmount !== undefined && dropAmount > 0) {
      detailRows.push(`下降：${formatJpy(dropAmount)}${dropPercent !== undefined ? `（${dropPercent}%）` : ""}`);
    }
    if (type === "price_rise" && riseAmount !== undefined && riseAmount > 0) {
      detailRows.push(`上涨：${formatJpy(riseAmount)}${risePercent !== undefined ? `（${risePercent}%）` : ""}`);
    }
  }
  if (type === "target_price" && targetPrice !== undefined) detailRows.push(`目标价：${formatJpy(targetPrice)}`);
  const interest = type === "interest_rise" ? interestChange(listing.sourceId, detail) : undefined;
  if (interest) detailRows.push(...interest.rows);
  if (strongLabel) detailRows.push(`这是第 ${strongSequence}/${strongTotal} 次强提醒`);
  if (initialAvailability) {
    detailRows.push("首次检查：当前可购买");
  } else if (type === "restock" && previousAvailability) {
    detailRows.push(`此前状态：${availabilityLabels[previousAvailability] ?? previousAvailability}`);
    const medianActiveDays = typeof detail.medianObservedActiveDurationDays === "number"
      && Number.isFinite(detail.medianObservedActiveDurationDays)
      ? detail.medianObservedActiveDurationDays
      : undefined;
    if (medianActiveDays !== undefined) {
      detailRows.push(`以往同款一般挂 ${medianActiveDays} 天左右就下架`);
    }
  } else if (confirmedMissing) {
    detailRows.push("商品页连续两次打不开。平台不区分「卖掉了」和「卖家自己撤下」，所以只能说可能售出");
  }
  const detailHtml = detailPanel(detailRows);
  const detailText = detailRows.length > 0 ? `\n${detailRows.join("\n")}` : "";
  const subjectCore = strongLabel
    ? `[${strongLabel}] ${listing.title}${newPrice !== undefined ? `｜${formatJpy(newPrice)}` : ""}`
    : type === "price_drop" && dropAmount !== undefined && dropAmount > 0 && oldPrice !== undefined && newPrice !== undefined
    ? `[降价 ${formatJpy(dropAmount)}] ${listing.title}｜${formatJpy(oldPrice)} → ${formatJpy(newPrice)}`
    : type === "price_rise" && riseAmount !== undefined && riseAmount > 0 && oldPrice !== undefined && newPrice !== undefined
      ? `[涨价 ${formatJpy(riseAmount)}] ${listing.title}｜${formatJpy(oldPrice)} → ${formatJpy(newPrice)}`
    : interest
      ? `[${interest.headline}] ${listing.title}${newPrice !== undefined ? `｜${formatJpy(newPrice)}` : ""}`
    : `${label}：${listing.title}`;
  return {
    subject: `【${brandName}】${subjectText(subjectCore)}`,
    html: emailShell({
      eyebrow: `商品雷达 · ${label}`,
      title: strongLabel ? `确认同款已进入目标价` : type === "price_drop" ? `价格已降至 ${formatJpy(newPrice ?? listing.currentPrice)}` : label,
      subtitle: strongLabel ? `${source} · 请尽快确认是否购买` : type === "price_drop" ? "现在查看，别错过这次价格变化。"
        : interest ? `${source} · ${interest.headline}，想要就别等了` : source,
      preview: `${label}：${listing.title}`,
      header: "item",
      content: `${image ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px"><tr><td style="padding:0"><a href="${escapeHtml(url ?? "#")}" style="text-decoration:none">${image}</a></td></tr></table>` : ""}<p style="margin:0">${pill(source)}</p><h2 style="margin:12px 0 0;font-family:${SERIF};font-size:20px;line-height:32px;font-weight:400;letter-spacing:.04em;color:${INK}">${url ? `<a href="${escapeHtml(url)}" style="color:${INK};text-decoration:none">${title}</a>` : title}</h2><p style="margin:16px 0 0;line-height:36px">${type === "price_drop" && oldPrice !== undefined ? `<span style="font-size:13px;color:${MUTE}">原价 <span style="text-decoration:line-through">${formatJpy(oldPrice)}</span>　现价 </span>` : ""}${priceHtml(newPrice ?? listing.currentPrice, 36)}</p>${detailHtml}${actionButton(url, type === "price_drop" ? "立即查看商品" : "查看商品")}<p style="margin:26px 0 0;color:${MUTE};font-size:11px;line-height:18px">${listingFootNote}</p>`,
    }),
    text: `${label}\n来源：${source}\n${listing.title}\n${formatJpy(newPrice ?? listing.currentPrice)}${detailText}${url ? `\n${url}` : ""}\n\n${listingFootNote}`,
  };
}

function timeAgo(value: unknown, now: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (24 * 60))} 天前`;
}

/**
 * 平台自己给的时间（煤炉商品页的「N時間前」就是更新时间：改价、改描述都会刷新）。
 * 上架和更新差不到一小时就只说一个，差得多时两个都说——「今天刚改过价的老货」
 * 和「刚上架的新货」对买家是两回事。按发信那一刻算相对时间。
 */
function listingTiming(listedAt: unknown, updatedAt: unknown, now = Date.now()): string {
  const listed = timeAgo(listedAt, now);
  const updated = timeAgo(updatedAt, now);
  if (listed && updated && typeof listedAt === "string" && typeof updatedAt === "string"
    && Date.parse(updatedAt) - Date.parse(listedAt) >= 60 * 60_000) {
    return `${updated}更新 · ${listed}上架`;
  }
  if (listed) return `${listed}上架`;
  return updated ? `${updated}更新` : "";
}

type EnrichBadge = { label: string; tone: "alert" | "bundle" | "kind" };
/**
 * 一行补充信息拆成几段，每段有自己的视觉层级：
 * value = 关键数字（定価 / 测算值 / 成交价），cheaper / pricier / even = 本件相对参考价的结论，
 * note = 出处与附注。整行都是灰色小字时读者找不到重点——数字和结论必须一眼跳出来。
 */
type EnrichTone = "plain" | "value" | "ai" | "cheaper" | "pricier" | "even" | "note";
type EnrichSegment = { text: string; tone?: EnrichTone };
type EnrichRowKind = "auction" | "kind" | "official" | "ai" | "market";
type EnrichRow = { kind: EnrichRowKind; label: string; segments: EnrichSegment[]; links?: { price: string; platform: string; url: string }[] };
type EnrichView = { rows: EnrichRow[]; badges: EnrichBadge[]; auction: boolean };

const secondhandPlatformLabels: Record<string, string> = {
  mercari: "煤炉",
  yahoo_flea: "雅虎フリマ",
  yahoo_auction: "雅虎拍卖",
  yahoo_auctions: "雅虎拍卖",
  surugaya: "骏河屋",
  rakuma: "Rakuma",
};

const officialShopLabels: Record<string, string> = {
  amiami: "AmiAmi",
  kadokawa: "KADOKAWA",
  hobbysearch: "Hobby Search",
  aniplex: "ANIPLEX+",
  animate: "animate",
  goodsmile: "GOODSMILE",
};

/**
 * 定価对应的是哪一件官方商品——写出名字和链接，读者一眼就能看出配得对不对。
 * 优先用采集端核对过标题的 `jpgr_official_match`；旧日报没有这个字段，退回候选第一名（不算核对过）。
 */
function officialMatch(enrichment: Record<string, unknown>):
  { priceJpy: number; verified: boolean; link: { price: string; platform: string; url: string } } | undefined {
  const annotated = recordValue(enrichment.jpgr_official_match);
  const matched = Object.keys(annotated).length > 0
    ? { title: annotated.title, url: annotated.url, source: annotated.source, price: annotated.teika_jpy }
    : (() => {
      const first = Array.isArray(enrichment.teika_candidates) ? recordValue(enrichment.teika_candidates[0]) : {};
      return { title: first.title, url: first.source_url, source: first.source, price: first.teika_jpy };
    })();
  const title = typeof matched.title === "string" ? matched.title.trim() : "";
  const url = safeHttpUrl(matched.url);
  const priceJpy = finiteNumber(matched.price);
  if (!title || !url || priceJpy === undefined || priceJpy <= 0) return undefined;
  return {
    priceJpy,
    verified: annotated.verified === true,
    link: { price: title, platform: officialShopLabels[String(matched.source)] ?? String(matched.source ?? ""), url },
  };
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const yen = (value: number) => `${Math.round(value).toLocaleString("ja-JP")} 円`;

const trimmedRatio = (value: number) => value.toFixed(2).replace(/\.?0+$/u, "");

/** 本件价格 ÷ 参考价。便宜标绿、贵标橙红，差不到 3% 算持平。 */
function comparisonSegment(ratio: number, reference: string): EnrichSegment {
  if (Math.abs(ratio - 1) < 0.03) return { text: `与${reference}基本持平`, tone: "even" };
  if (ratio < 1) return { text: `比${reference}便宜 ${Math.round((1 - ratio) * 100)}%`, tone: "cheaper" };
  if (ratio < 2) return { text: `比${reference}贵 ${Math.round((ratio - 1) * 100)}%`, tone: "pricier" };
  return { text: `是${reference}的 ${trimmedRatio(ratio)} 倍`, tone: "pricier" };
}

function tokyoMinute(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  const tokyo = new Date(Date.parse(value) + 9 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${tokyo.getUTCMonth() + 1}月${tokyo.getUTCDate()}日 ${pad(tokyo.getUTCHours())}:${pad(tokyo.getUTCMinutes())}`;
}

/**
 * 补充信息（jp-market-databricks 的 /enrich）的数字全部由提供方算好，这里不重算任何价格，
 * 只把结构化字段排成「每个数字都说清出处」的几行：读者要能看出这个数是查到的
 *（官方定価）、模型算的（机器学习测算，带区间）还是统计出来的（核对过的同款成交），
 * 并且能点开成交记录自己核对。一句没有出处的「中位 X 円」没人有理由信。
 *
 * 档案关掉的那几样（digestExtras，packages/core/src/digest-extras.ts）整行不出现，
 * 连带依赖它们的结论也不出现：原价关了，就没有「疑似占位价」「远超参考价」这两个拿参考价比出来的标记。
 */
function enrichmentView(
  value: unknown,
  auctionValue: unknown,
  sourceId: unknown,
  verifiedSales: unknown,
  price: number | undefined,
  extras: DigestExtras,
): EnrichView {
  const enrichment = recordValue(value);
  const auctionFacts = auctionValue !== undefined && auctionValue !== null ? recordValue(auctionValue) : undefined;
  const flags = Array.isArray(enrichment.flags) ? enrichment.flags.map(String) : [];
  const auction = auctionFacts !== undefined || flags.includes("auction") || sourceId === "yahoo_auctions_jp";
  const rows: EnrichRow[] = [];
  const badges: EnrichBadge[] = [];

  if (auction) {
    const bidCount = finiteNumber(auctionFacts?.bidCount);
    const endsAt = tokyoMinute(auctionFacts?.endsAt);
    rows.push({
      kind: "auction",
      label: "拍卖",
      segments: [
        { text: "价格是当前出价，不是成交价", tone: "plain" },
        ...(bidCount !== undefined ? [{ text: bidCount > 0 ? ` · 已有 ${bidCount} 次出价` : " · 尚无出价", tone: "plain" as const }] : []),
        ...(endsAt ? [{ text: ` · ${endsAt} 截止`, tone: "value" as const }, { text: "（日本时间）", tone: "note" as const }] : []),
      ],
    });
    badges.push({ label: "拍卖", tone: "alert" });
  }
  if (Object.keys(enrichment).length === 0) return { rows, badges, auction };

  const showOfficial = extras.priceReference !== "off";
  const showAi = extras.priceReference === "official_and_ai";
  const showSales = extras.showSales;
  // 「打包 / 卡牌不比原价与行情」只提这封里真的会出现的那几样。
  const notCompared = [showOfficial ? "原价" : "", showSales ? "行情" : ""].filter(Boolean).join("与");
  const teika = recordValue(enrichment.teika);
  const lo = finiteNumber(teika.lo);
  const hi = finiteNumber(teika.hi);
  const match = officialMatch(enrichment);
  // 「官方定価」只认标题核对过的那一款（与同款成交同一把尺子，sale-evidence.ts）。
  // 提供方的 A 档只说明候选定価收敛，不说明配对了：2026-10-07 起 72 件 A 档里 35 件核对不过，
  // 1/7 比例手办配到 1,620 円的场景摆件配件、单个挂件配到 7 个装整盒，照样写成定価算了倍数。
  const confirmedOfficial = match?.verified === true && (teika.tier === "A" || teika.tier === "B")
    && lo !== undefined && hi !== undefined;
  // 提供方有 A 档时拿 A 档定価当「占位价 / 远超」的参考价；A 档没核对上，这个参考价就不可信，标记一起不要。
  const referenceUnreliable = !showOfficial || (teika.tier === "A" && !confirmedOfficial);
  if (!referenceUnreliable && flags.includes("placeholder")) badges.push({ label: "疑似占位价", tone: "alert" });
  if (!referenceUnreliable && flags.includes("extreme")) badges.push({ label: "远超参考价", tone: "alert" });

  const routeLabel = typeof enrichment.route_label === "string" ? enrichment.route_label : "";
  if (enrichment.is_bundle === true) {
    const packCount = finiteNumber(enrichment.pack_count);
    const perUnit = finiteNumber(enrichment.per_unit_jpy);
    rows.push({
      kind: "kind",
      label: "类型",
      segments: [
        ...(routeLabel && enrichment.route !== "single" && enrichment.route !== "multi"
          ? [{ text: `${routeLabel} · `, tone: "plain" as const }] : []),
        ...(packCount
          ? [
            { text: `打包 ${packCount} 件`, tone: "value" as const },
            ...(perUnit !== undefined && !auction ? [{ text: `，折合每件约 ${yen(perUnit)}`, tone: "plain" as const }] : []),
          ]
          : [{ text: "打包出售（标题中未写明件数）", tone: "plain" as const }]),
        ...(notCompared ? [{ text: `　打包商品不比${notCompared}`, tone: "note" as const }] : []),
      ],
    });
    badges.push({ label: "打包", tone: "bundle" });
  } else if (enrichment.route !== "single" && routeLabel) {
    rows.push({
      kind: "kind",
      label: "类型",
      segments: [
        { text: routeLabel, tone: "plain" },
        ...(enrichment.route === "card"
          ? notCompared ? [{ text: `　卡牌不比${notCompared}`, tone: "note" as const }] : []
          : showOfficial ? [{ text: "　此类商品没有单件官方定価", tone: "note" as const }] : []),
      ],
    });
    badges.push({ label: routeLabel.replace(/（.*$/u, "").slice(0, 12), tone: "kind" });
  }

  if (!showOfficial) {
    // 档案关掉了原价：定価、AI 预测一行都不写。
  } else if (teika.tier === "A" && lo !== undefined && hi !== undefined && match?.verified) {
    const ratioMin = finiteNumber(teika.ratio_min);
    const ratioMax = finiteNumber(teika.ratio_max);
    const ratio = ratioMin !== undefined && ratioMax !== undefined ? (ratioMin + ratioMax) / 2 : ratioMin;
    rows.push({
      kind: "official",
      label: "官方定価",
      segments: [
        { text: lo === hi ? yen(lo) : `${yen(lo)}～${yen(hi)}`, tone: "value" },
        ...(ratio !== undefined && !auction ? [{ text: "　" }, comparisonSegment(ratio, "定価")] : []),
        { text: "　已核对：", tone: "note" },
      ],
      links: [match.link],
    });
  } else if (teika.tier === "A" && lo !== undefined && hi !== undefined) {
    // 候选定価收敛，但标题对不上：只给人过目，不拿它算贵贱。
    rows.push({
      kind: "official",
      label: "官方定価",
      segments: match
        ? [
          { text: "最接近的一款 ", tone: "plain" },
          { text: yen(match.priceJpy), tone: "value" },
          { text: "　未核对上，仅供参考：", tone: "note" },
        ]
        : [
          { text: lo === hi ? yen(lo) : `${yen(lo)}～${yen(hi)}`, tone: "value" },
          { text: "　相近商品的定価，未核对上，仅供参考", tone: "note" },
        ],
      ...(match ? { links: [match.link] } : {}),
    });
  } else if (teika.tier === "B" && lo !== undefined && hi !== undefined) {
    const candidates = finiteNumber(teika.candidate_total) ?? finiteNumber(teika.n);
    const overHi = finiteNumber(teika.over_hi_ratio);
    const overHiSegments = overHi !== undefined && !auction
      ? [{ text: "　" }, { text: `是最贵一款的 ${trimmedRatio(overHi)} 倍`, tone: "pricier" as const }]
      : [];
    if (match?.verified) {
      // 标题核对过就是这一款：照确定定価写，可以算贵了多少。
      rows.push({
        kind: "official",
        label: "官方定価",
        segments: [
          { text: yen(match.priceJpy), tone: "value" },
          ...(price !== undefined && !auction ? [{ text: "　" }, comparisonSegment(price / match.priceJpy, "定価")] : []),
          { text: "　已核对：", tone: "note" },
        ],
        links: [match.link],
      });
    } else if (match) {
      // 没核对上：只写最接近的那一款给人过目，不拿它算贵贱。区间上限的反证照样成立。
      rows.push({
        kind: "official",
        label: "官方定価",
        segments: [
          { text: "最接近的一款 ", tone: "plain" },
          { text: yen(match.priceJpy), tone: "value" },
          ...overHiSegments,
          { text: `　相近${candidates ? ` ${candidates} 款` : "多款"}，未核对上，仅供参考：`, tone: "note" },
        ],
        links: [match.link],
      });
    } else {
      rows.push({
        kind: "official",
        label: "官方定価",
        segments: [
          { text: `${yen(lo)}～${yen(hi)}`, tone: "value" },
          { text: `　${candidates ? `${candidates} 款` : "多款"}可能对应，仅供参考`, tone: "note" },
          ...overHiSegments,
        ],
      });
    }
  }

  const estimate = recordValue(enrichment.estimate);
  const estimated = finiteNumber(estimate.estimate_jpy);
  const estimateLow = finiteNumber(estimate.low_jpy);
  const estimateHigh = finiteNumber(estimate.high_jpy);
  // 已经有核对过的官方定価，就不再摆一个模型猜的数和它打架。
  if (showAi && !confirmedOfficial && estimated !== undefined && estimateLow !== undefined && estimateHigh !== undefined) {
    // 模型测算只是参考：不拿它算贵贱，也不写「比测算值便宜 X%」（2026-10-11 用户定）。
    rows.push({
      kind: "ai",
      label: "AI 预测",
      segments: [
        { text: "机器学习模型根据标题预测价格 ", tone: "plain" },
        { text: yen(estimated), tone: "ai" },
        { text: `，区间 ${yen(estimateLow)}～${yen(estimateHigh)}（仅供参考）`, tone: "plain" },
      ],
    });
  }

  // 二手行情只用两种证据：提供方已确认同款（JAN / 以图搜图）的统计，和 collector
  // 逐条核对过标题的同款成交（sale-evidence.ts）。「标题相似」「同作品同品类」两档
  // 实测大量配错（2026-09-23），一律不进邮件；没有可靠证据时整行不出现，不写「样本不足」。
  const market = recordValue(enrichment.market);
  const picked = recordValue(market.picked);
  const median = finiteNumber(picked.p50);
  const sampleSize = finiteNumber(picked.n);
  if (showSales && picked.tier === "same_product" && median !== undefined && sampleSize !== undefined) {
    const vs = finiteNumber(picked.vs_market);
    rows.push({
      kind: "market",
      label: "同款行情",
      segments: [
        { text: `中位数 ${yen(median)}`, tone: "value" },
        ...(vs !== undefined && !auction ? [{ text: "　" }, comparisonSegment(vs + 1, "中位数")] : []),
        {
          text: picked.basis === "sold"
            ? `　近一年 ${sampleSize} 笔已确认同款的成交`
            : `　近 3 天 ${sampleSize} 件已确认同款的在售挂单`,
          tone: "note",
        },
      ],
    });
  }
  const sales = (showSales && Array.isArray(verifiedSales) ? verifiedSales : []).flatMap((entry) => {
    const sale = recordValue(entry);
    const salePrice = finiteNumber(sale.priceJpy);
    const url = safeHttpUrl(sale.url);
    return salePrice === undefined || !url ? [] : [{ price: salePrice, url, platform: String(sale.platform ?? "") }];
  }).slice(0, 3);
  if (sales.length > 0) {
    const prices = sales.map((sale) => sale.price).sort((left, right) => left - right);
    const middle = prices.length % 2 === 1
      ? prices[(prices.length - 1) / 2]!
      : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2;
    rows.push({
      kind: "market",
      label: "同款成交",
      segments: [
        ...(price !== undefined && !auction && middle > 0
          ? [comparisonSegment(price / middle, sales.length === 1 ? "这笔成交" : "这几笔成交")]
          : []),
        { text: `　${sales.length} 笔，标题已逐条核对，可点开查看：`, tone: "note" },
      ],
      links: sales.map((sale) => ({
        price: yen(sale.price),
        platform: secondhandPlatformLabels[sale.platform] ?? "",
        url: sale.url,
      })),
    });
  }
  return { rows, badges, auction };
}

/**
 * 数字（定価 / 测算值 / 成交价）用 Cormorant 放大，结论单独上色：便宜用荧光笔底色、
 * 贵了用橙红、持平用正文灰。整行都是灰色小字时读者找不到重点。
 */
const segmentStyles: Record<EnrichTone, string> = {
  plain: `color:${INK2};font-size:13px`,
  value: `font-family:${NUM};color:${INK};font-size:18px;font-variant-numeric:lining-nums`,
  ai: `font-family:${NUM};color:${SKY_TEXT};font-size:18px;font-variant-numeric:lining-nums`,
  cheaper: `background:#f1ea8c;color:${INK};font-size:13px`,
  pricier: `color:${ALERT_TEXT};font-size:13px`,
  even: `color:${INK2};font-size:13px`,
  note: `color:${MUTE};font-size:12px`,
};

/** 行标签统一用灰色小字，只有拍卖那一行用橙红提醒。 */
const rowLabelColors: Record<EnrichRowKind, string> = {
  auction: ALERT_TEXT,
  kind: MUTE,
  official: MUTE,
  ai: MUTE,
  market: MUTE,
};

/** 官方商品名太长时截短：链接点开就是全名，邮件里只要认得出是哪一款。 */
function shortTitle(title: string, max = 22): string {
  const chars = [...title];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : title;
}

function enrichmentHtml(view: EnrichView): string {
  if (view.rows.length === 0) return "";
  const rows = view.rows.map((row) => {
    const segments = row.segments.map((segment) =>
      `<span style="${segmentStyles[segment.tone ?? "plain"]}">${escapeHtml(segment.text)}</span>`).join("");
    // 成交行的链接文字是价格（放大的数字），定価行的链接文字是官方商品名（常规字号，免得长标题压过数字）。
    const links = (row.links ?? []).map((link) => row.kind === "official"
      ? `<a href="${escapeHtml(link.url)}" style="display:inline-block;margin:2px 12px 0 0;color:${INK2};font-size:12px;text-decoration:none;border-bottom:1px solid #9f9f9f">${escapeHtml(shortTitle(link.price))}</a>`
      : `<a href="${escapeHtml(link.url)}" style="display:inline-block;margin:2px 4px 0 0;color:${INK};font-family:${NUM};font-size:17px;text-decoration:none;border-bottom:1px solid ${INK}">${escapeHtml(link.price)}</a>${link.platform ? `<span style="color:${MUTE};font-size:11px;margin:0 14px 0 2px">${escapeHtml(link.platform)}</span>` : ""}`).join("");
    return `<tr><td width="68" valign="top" style="padding:5px 10px 5px 0;color:${rowLabelColors[row.kind]};font-size:12px;line-height:22px;letter-spacing:.06em;white-space:nowrap">${escapeHtml(row.label)}</td><td valign="top" style="padding:5px 0;line-height:21px">${segments}${links ? `<br>${links}` : ""}</td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:10px 0 0;border-collapse:collapse;border-top:1px solid ${LINE_SOFT}">${rows}</table>`;
}

function enrichmentBadgesHtml(view: EnrichView): string {
  return view.badges.map((badge) => tag(badge.label, badge.tone)).join("");
}

function enrichmentText(view: EnrichView): string {
  return view.rows.map((row) => `\n   ${row.label}：${row.segments.map((segment) => segment.text).join("").replace(/\s*　+\s*/gu, " · ").replace(/^ · /u, "").trim()}${(row.links ?? []).map((link) => ` ${link.price}${link.platform ? `（${link.platform}）` : ""} ${link.url}`).join("；")}`).join("");
}

/**
 * 关键词日报末尾的说明与免责声明。
 *
 * 主流做法是邮件里只放几行浓缩版、完整条款放网页；邮件客户端普遍不支持折叠，
 * 长篇条款放在邮件里只会把正文推远。这里压成三段：价格参考怎么来的、我们是谁 /
 * 责任边界、为什么收到这封信。每一句仍要对得上数据的真实口径，不写做不到的承诺。
 * 条目按当封邮件实际出现的内容取舍——没有价格参考就不解释价格参考。
 */
/**
 * 价格参考（/enrich）这一轮出了什么问题，说成一句人话。补充信息失败不挡发信，但不说出来，
 * 邮件只是悄悄少了几行，看起来和正常一模一样（2026-10-07 加藤惠整批超时就是这样没人知道）。
 */
function enrichmentIssue(meta: Record<string, unknown>, extras: DigestExtras): string | undefined {
  const error = typeof meta.error === "string" ? meta.error : "";
  const missing = [
    extras.priceReference !== "off" ? "官方定価" : "",
    extras.priceReference === "official_and_ai" ? "AI 预测价" : "",
    extras.showSales ? "同款成交" : "",
  ].filter(Boolean);
  const missingText = missing.length > 1
    ? `${missing.slice(0, -1).join("、")}和${missing[missing.length - 1]}`
    : missing[0] ?? "价格参考";
  if (meta.status === "failed" || (meta.status === "skipped" && error)) {
    const httpStatus = /^enrich_http_(\d+)/u.exec(error)?.[1];
    const cause = /timeout|timed out|aborted/iu.test(error) ? "价格接口等待超时"
      : /ENRICH_KEY/u.test(error) ? "价格接口的密钥没有配置"
      : httpStatus ? `价格接口返回错误 ${httpStatus}`
      : "价格接口调用出错";
    return `本轮价格参考没取到（${cause}），商品照常列出，只是没有${missingText}。`;
  }
  const estimateError = typeof meta.estimateError === "string" ? meta.estimateError : "";
  if (estimateError && extras.priceReference === "official_and_ai") {
    const cause = /timeout/iu.test(estimateError) ? "估价模型启动超时" : "估价模型调用出错";
    return `本轮 AI 预测价没取到（${cause}），${extras.showSales ? "官方定価和同款成交" : "官方定価"}照常显示。`;
  }
  return undefined;
}

function keywordDigestNotice(input: {
  profileName: string;
  day: string;
  /** 这封里有建档回执。 */
  hasReceipt: boolean;
  hasPriceReference: boolean;
  /** 档案开着哪几样价格参考：声明只解释这封里真的会出现的。 */
  extras: DigestExtras;
  /** 没能对应到官方商品库收录作品的件数（冰菓、WHITE ALBUM2 等库里一件都没有）。 */
  uncoveredCount: number;
  hasTiming: boolean;
  /** 邮件里有没有逐件列出的商品；纯建档回执没有。 */
  hasItems: boolean;
  dataAsOf: string;
}): { html: string; text: string } {
  const priceReferenceParts = [
    input.extras.priceReference !== "off" ? "「官方定価」来自厂商及正规零售商公开的商品信息" : "",
    input.extras.priceReference === "official_and_ai" ? "「AI 预测」由机器学习模型根据标题预测，区间为 80% 预测区间，仅供参考，不是厂商价格" : "",
    input.extras.showSales ? "「同款成交」为二手平台近一年的已售记录，只列出标题逐条核对一致的几笔" : "",
  ].filter(Boolean);
  const paragraphs = [
    [
      input.hasPriceReference && priceReferenceParts.length > 0
        ? `价格参考：${priceReferenceParts.join("；")}。`
        : "",
      // 说一次就够，不在每件商品下面重复；要说清是「库里没有这部作品」，不是「查不到这件商品」——
      // 后者会让人以为是非官方周边（docs/研究/原価锚点接入-交接-20260922.md §3.7）。
      input.hasPriceReference && input.extras.priceReference !== "off" && input.uncoveredCount > 0
        ? `其中 ${input.uncoveredCount} 件所属作品不在官方商品库的收录范围内（或没能从标题认出作品），因此没有官方定価，这不代表它不是官方商品。`
        : "",
      "标价为采集时的页面价格，不含代购费、国际运费及关税，商品可能已售出或改价，请以商品页面为准；拍卖件显示当前出价。",
      input.hasTiming ? "上架 / 更新时间取自平台公开信息。" : "",
      input.hasPriceReference && priceReferenceParts.length > 0 && input.dataAsOf ? `价格参考数据截至 ${input.dataAsOf}。` : "",
    ].filter(Boolean).join(""),
    "以上信息均为基于公开数据的自动整理与估算，仅供参考，不构成真伪、品相或价值的鉴定，也不构成购买建议。格银西里尔为独立运营的服务，与 Mercari、LINEヤフー、骏河屋、乐天等平台及相关版权方、厂商无隶属或合作关系，商标归各自权利人所有。交易在你与卖家或平台之间进行，相关风险由交易双方自行承担。",
    // 曾写作「首次建档时已在售的存量」，被读成了「已售出」（2026-10-07）。说「正在出售」。
    [
      input.hasItems ? "未加标记的商品为本档案首次发现，不代表当天上架。" : "",
      input.hasReceipt ? "建档回执里的商品是建档那一刻各平台正在出售的，作为以后比较的起点，不算新上架。" : "",
      `你收到本邮件，是因为设置了关键词档案「${input.profileName}」（${input.day} 巡回），可在格银西里尔网页端的监控设置中调整或停用。`,
    ].join(""),
  ];
  const html = `<div style="margin:36px 0 0;padding:20px 0 0;border-top:1px solid ${LINE};text-align:left">${paragraphs.map((paragraph) => `<p style="margin:0 0 10px;color:${MUTE};font-size:11px;line-height:19px;letter-spacing:.02em">${escapeHtml(paragraph)}</p>`).join("")}<p style="margin:14px 0 0;font-size:12px;line-height:20px;letter-spacing:.1em">${lineLink(legalNoticeUrl, "查看完整说明与免责声明 →")}</p></div>`;
  const text = `${paragraphs.join("\n\n")}\n\n完整说明与免责声明：${legalNoticeUrl}`;
  return { html, text };
}

/**
 * 建档回执：建档那一刻各平台在售的商品动辄上千件（2026-10-07 赛车初音 1008 件），
 * 没人看得完，也不该要求人看完。邮件里只说清楚「记下了多少、都是些什么、多少钱」，
 * 逐件的清单放到网页上（可折叠、可下载表格），不用附件——HTML 附件是钓鱼邮件的惯用手法。
 * 不写「预计每天发多少」：第一天说不准的数字不进邮件。
 */
function baselineReceipt(
  items: (GroupableItem & { source: string; title: string; url?: string; imageUrl?: string })[],
  options: { total: number; listingUrl?: string },
): { html: string; text: string } {
  const sourceCounts = new Map<string, number>();
  for (const item of items) sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1);
  const sources = [...sourceCounts].sort((left, right) => right[1] - left[1]).map(([name, count]) => `${name} ${count} 件`).join(" · ");
  const categories = organizeByCategory(items);
  const categoryStat = (category: (typeof categories)[number]) => category.id === BUNDLE_CATEGORY_ID
    ? "一件含多件，不算单价"
    : category.median !== null ? `中位价 ${formatJpy(category.median)}` : "无有效一口价";
  // 示例挑「在卖的人最多的几款」：比随手挑一件更能说明这个关键词底下是什么行情。
  const examples = categories
    .filter((category) => category.id !== BUNDLE_CATEGORY_ID)
    .flatMap((category) => category.groups)
    .filter((group) => group.items.length >= 2 && group.items[0]!.imageUrl)
    .sort((left, right) => right.items.length - left.items.length)
    .slice(0, 3);
  const exampleRange = (group: (typeof examples)[number]) => {
    const prices = statPrices(group.items);
    if (prices.length === 0) return "";
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    return low === high ? formatJpy(low) : `${formatJpy(low)}～${formatJpy(high)}`;
  };
  const lead = "这是建档那一刻各平台正在卖的商品，记下来作为以后比较的起点，不是新上架。从明天起，只有之后新挂出来的才会发给你。";

  const categoryRows = categories.map((category) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${LINE};color:${INK};font-size:14px;line-height:20px">${escapeHtml(category.label)}</td><td align="right" style="padding:10px 14px;border-bottom:1px solid ${LINE};white-space:nowrap"><span style="font-family:${NUM};font-size:20px;line-height:20px;color:${INK}">${category.count}</span><span style="font-size:12px;color:${INK2}"> 件</span></td><td align="right" style="padding:10px 0;border-bottom:1px solid ${LINE};color:${MUTE};font-size:12px;line-height:20px;white-space:nowrap">${escapeHtml(categoryStat(category))}</td></tr>`).join("");
  const exampleCards = examples.map((group) => {
    const head = group.items[0]!;
    const range = exampleRange(group);
    const image = productImage(head.imageUrl, head.title, 120);
    const title = head.url
      ? `<a href="${escapeHtml(head.url)}" style="color:${INK};text-decoration:none">${escapeHtml(head.title.slice(0, 60))}</a>`
      : escapeHtml(head.title.slice(0, 60));
    return `<div style="display:inline-block;vertical-align:top;width:31%;min-width:150px;max-width:180px;margin:0 2% 16px 0;font-size:13px;text-align:left">${image ? `<div style="max-width:120px">${image}</div>` : ""}<p style="margin:8px 0 0;color:${INK};font-size:12px;line-height:18px">${title}</p><p style="margin:4px 0 0;color:${INK2};font-size:12px;line-height:18px">${group.items.length} 个卖家${range ? ` · ${escapeHtml(range)}` : ""}</p></div>`;
  }).join("");
  const button = options.listingUrl
    ? `${inkButton(options.listingUrl, `查看全部 ${options.total} 件`, "24px 0 0")}<p style="margin:10px 0 0;color:${MUTE};font-size:11px;line-height:18px">网页上按品类分组、同名合并，可下载表格。用收这封邮件的邮箱登录网页即可查看，链接保存半年。</p>`
    : `<p style="margin:16px 0 0;color:${MUTE};font-size:12px;line-height:19px">逐件清单保存在后台记录中。</p>`;
  const html = `<p style="margin:0;font-size:12px;line-height:18px;letter-spacing:.2em;color:${MUTE}">建档回执</p><p style="margin:8px 0 0;font-family:${SERIF};font-size:22px;line-height:32px;letter-spacing:.06em;color:${INK}">记下各平台在售 <span style="font-family:${NUM};font-size:40px;line-height:32px">${options.total}</span> 件</p><p style="margin:12px 0 0;color:${INK2};font-size:13px;line-height:22px">${escapeHtml(lead)}</p><p style="margin:8px 0 0;color:${MUTE};font-size:12px;line-height:20px">${escapeHtml(sources)}</p>`
    + sectionHead("按品类", "各品类件数与中位价", "", "30px 0 0") + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse">${categoryRows}</table>`
    + `<p style="margin:8px 0 0;color:${MUTE};font-size:11px;line-height:18px">中位价只算一口价，不含拍卖当前出价和明显乱填的价格。</p>`
    + (exampleCards ? sectionHead("在卖的人最多", "在卖的人最多的几款", "", "30px 0 16px") + `<div style="font-size:0">${exampleCards}</div>` : "")
    + button;
  const text = [
    `建档回执：记下各平台在售 ${options.total} 件`,
    lead,
    sources,
    "",
    "按品类：",
    ...categories.map((category) => `- ${category.label} ${category.count} 件 · ${categoryStat(category)}`),
    "（中位价只算一口价，不含拍卖当前出价和明显乱填的价格。）",
    ...(examples.length > 0 ? ["", "在卖的人最多的几款：", ...examples.map((group) => {
      const range = exampleRange(group);
      return `- ${group.items[0]!.title}（${group.items.length} 个卖家${range ? ` · ${range}` : ""}）`;
    })] : []),
    "",
    options.listingUrl
      ? `查看全部 ${options.total} 件（用收信邮箱登录网页即可查看，链接保存半年）：${options.listingUrl}`
      : "逐件清单保存在后台记录中。",
  ].join("\n");
  return { html, text };
}

export function keywordDigestEmail(
  detail: Record<string, unknown>,
  /** 这封日报自己的事件编号：建档回执靠它生成「查看全部」链接。没有就不放链接。 */
  options: {
    eventId?: string;
    /** 收件人：运营者自己收的日报要把故障说出来。 */
    audience?: "owner";
  } = {},
): { subject: string; html: string; text: string } {
  const exactProduct = detail.kind === "exact_product_new_listing";
  // 精确同款"标题对上、图片没对上"攒到晚上发的那封（collector 的 exact-reference-image.ts）
  const imageHold = exactProduct && detail.imageHold === true;
  const scanSummary = detail.kind === "keyword_scan_summary";
  const initialBaseline = detail.kind === "keyword_initial_baseline";
  const profileName = String(detail.profileName ?? (exactProduct ? "精确同款雷达" : "关键词雷达"));
  const displayProfileName = exactProduct ? profileName.replace(/^同款\s*[·・]\s*/u, "") : profileName;
  const day = String(detail.day ?? new Date().toISOString().slice(0, 10));
  const total = Math.max(0, Number(detail.total ?? 0));
  const baselineTotal = Math.max(0, Number(detail.baselineTotal ?? (initialBaseline ? total : 0)));
  const newTotal = Math.max(0, Number(detail.newTotal ?? (initialBaseline ? 0 : total)));
  const recoveredTotal = Math.max(0, Number(detail.recoveredTotal ?? 0));
  const summaryCounts = [`首次发现 ${newTotal} 件`,
    ...(recoveredTotal > 0 ? [`恢复识别 ${recoveredTotal} 件`] : []),
    ...(baselineTotal > 0 ? [`建档存量 ${baselineTotal} 件`] : []),
  ].join(" · ");
  const baselineSources = (Array.isArray(detail.baselineSourceIds) ? detail.baselineSourceIds : []).map(sourceLabel).join("、");
  const rawItems = Array.isArray(detail.items) ? detail.items : [];
  // 档案关掉了哪几样价格参考。加开关之前的载荷没有这个字段，按全开渲染。
  const digestExtras = digestExtrasFromPayload(detail.digestExtras);
  const allItems = rawItems.map((value, index) => {
    const item = recordValue(value);
    const url = safeHttpUrl(item.url);
    return {
      source: sourceLabel(item.sourceId),
      // 建档时记下的在售存量不逐件列出，汇总成回执（各平台件数、品类概览、清单页链接）。
      baseline: scanSummary ? item.category === "baseline" : initialBaseline,
      // 关键词日报里几乎全是首次发现，这是默认状态，不再在每个标题前重复。
      // 只有例外（以前见过）才标出来，并把标题调灰。
      category: scanSummary && item.category === "recovered" ? "恢复识别" : "",
      categoryNote: scanSummary && item.category === "recovered" ? "以前采集过，这一轮才通过筛选" : "",
      timing: listingTiming(item.listedAt, item.updatedAt),
      title: String(item.title ?? "未命名商品"),
      // 精确同款看过参考图的那一句（"商品图与参考图一致" / "图和参考图明显不同"），没有就不显示
      note: String(item.note ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, 200),
      url,
      identity: url ?? `#${index}`,
      imageUrl: safeHttpUrl(item.imageUrl),
      price: typeof item.price === "number" && Number.isFinite(item.price) ? item.price : null,
      auction: item.auction !== undefined && item.auction !== null && item.auction !== false,
      bundle: recordValue(item.enrichment).is_bundle === true,
      enrich: enrichmentView(item.enrichment, item.auction, item.sourceId, item.verifiedSales,
        typeof item.price === "number" ? item.price : undefined, digestExtras),
      enriched: item.enrichment !== undefined && item.enrichment !== null,
    };
  });
  type DigestItem = (typeof allItems)[number];
  const items = allItems.filter((item) => !item.baseline);
  const baselineItems = allItems.filter((item) => item.baseline);
  // 单品在前、打包最后；一口价从低到高，拍卖排在一口价后面；同名的折成一张卡，
  // 补充信息只挂在代表那一件上，其余卖家只列价格和链接。载荷里每一件都还在，
  // 下一轮按链接去重不受影响。规则与完整清单页共用（listing-groups.ts）。
  const groups = groupSameTitle(items);
  const priceLabel = (item: DigestItem) => `${item.auction ? "拍 " : ""}${formatJpy(item.price)}`;
  // 只有一个其他卖家时，区间就是那条链接上的价格，不重复写。
  const othersRange = (others: DigestItem[]) => {
    const prices = others.length > 1 ? statPrices(others) : [];
    if (prices.length === 0) return "";
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    return low === high ? formatJpy(low) : `${formatJpy(low)}～${formatJpy(high)}`;
  };
  const receipt = baselineItems.length > 0
    ? baselineReceipt(baselineItems, { total: Math.max(baselineTotal, baselineItems.length), listingUrl: listingPageUrl(options.eventId) })
    : undefined;
  const enrichmentMeta = recordValue(detail.enrichment);
  const enrichedCount = items.filter((item) => item.enriched).length;
  // 疑似候选是否出现在邮件里，由档案自己的送达门槛决定（AGENTS.md §4）。
  // 默认的 confirmed_only 下上游根本不会传 suspects，这一整段自然不渲染；
  // 传了就说明用户主动把门槛放宽了，此时带上判定理由让他一眼判掉。
  const suspectRelationLabels: Record<string, string> = {
    probable_exact: "高度疑似",
    uncertain: "证据不足",
    related: "相关",
    bundle: "疑似套装",
  };
  const suspects = (Array.isArray(detail.suspects) ? detail.suspects.slice(0, 24) : []).map((value) => {
    const item = recordValue(value);
    return {
      source: sourceLabel(item.sourceId),
      label: suspectRelationLabels[String(item.relation ?? "uncertain")] ?? "证据不足",
      title: String(item.title ?? "未命名商品"),
      url: safeHttpUrl(item.url),
      price: typeof item.price === "number" ? item.price : undefined,
      reason: String(item.reason ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, 160),
    };
  });
  const suspectTotal = Math.max(suspects.length, Number(detail.suspectTotal ?? 0));
  const sourceCounts = (Array.isArray(detail.sourceCounts) ? detail.sourceCounts : []).map((value) => {
    const entry = recordValue(value);
    return `${sourceLabel(entry.sourceId)} ${Math.max(0, Number(entry.count ?? 0))} 件`;
  }).filter((value) => !value.endsWith(" 0 件"));
  // `failedSources` is the original payload and remains supported. Newer
  // collectors may provide per-source status so a successful fetch rejected
  // by a safety gate is not presented as an execution failure.
  const sourceIssues = (Array.isArray(detail.sourceIssues) ? detail.sourceIssues : [])
    .map((value) => {
      const issue = recordValue(value);
      const sourceId = issue.sourceId;
      const status = String(issue.status ?? issue.state ?? "failed");
      const code = String(issue.code ?? issue.errorCode ?? "");
      return { sourceId, status, code, label: sourceLabel(sourceId) };
    })
    .filter((issue) => issue.sourceId !== undefined && issue.sourceId !== null);
  const explicitIssueSourceIds = new Set(sourceIssues.map((issue) => String(issue.sourceId)));
  const legacyFailedSources = (Array.isArray(detail.failedSources) ? detail.failedSources : [])
    .filter((sourceId) => !explicitIssueSourceIds.has(String(sourceId)))
    .map(sourceLabel)
    .filter(Boolean);
  const rejectedSources = sourceIssues
    .filter((issue) => issue.status === "rejected" || issue.code === "suspected_source_degradation")
    .map((issue) => issue.label)
    .filter(Boolean);
  // 关键词档案里 AI 没判完的条目已按关键词规则放行（collector 的 ruleFallback），
  // 这不是"没完成"，而是"少筛了一道"——单独写一行，告诉读者可能混进同名无关商品。
  // 精确同款不放行，仍按未完成处理。errorCode 形如 ai_judgement_incomplete:未判件数/总件数。
  const unreviewedSources = exactProduct ? [] : sourceIssues.flatMap((issue) => {
    const match = /^ai_judgement_incomplete:(\d+)\/\d+$/u.exec(issue.code);
    return match && issue.label ? [`${issue.label} ${match[1]} 件`] : [];
  });
  const incompleteSources = [
    ...legacyFailedSources,
    ...sourceIssues
      .filter((issue) => issue.status !== "rejected" && issue.code !== "suspected_source_degradation"
        && !(!exactProduct && issue.code.startsWith("ai_judgement_incomplete:"))
        && !["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(issue.code))
      .map((issue) => issue.label)
      .filter(Boolean),
  ];
  const itemRows = groups.map(({ items: [item, ...others] }) => {
    if (!item) return "";
    const titleColor = item.category ? MUTE : INK;
    const linkedTitle = item.url
      ? `<a href="${escapeHtml(item.url)}" style="color:${titleColor};text-decoration:none">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);
    const image = productImage(item.imageUrl, item.title, 240);
    // 三栏：左 = 来源 / 上架 / 更新，中 = 商品图，右 = 价格。标题和价格参考放在下面占满整行。
    // 二次元周边先看图、图打动了才看价格和细节，所以图放正中、视线第一落点（2026-10-11 用户定）。
    // 用表格而不是 inline-block：手机上也不折行，QQ 邮箱 / Gmail App 都保持三栏。
    const timingLines = item.timing && !item.category
      ? item.timing.split(" · ").reverse().map((part) => `<p style="margin:6px 0 0;color:${SKY_TEXT};font-size:11px;line-height:16px;white-space:nowrap">${escapeHtml(part.replace(/ /gu, ""))}</p>`).join("")
      : "";
    const metaCell = `<p style="margin:0;color:${item.category ? MUTE : INK};font-size:11px;line-height:16px;white-space:nowrap">${escapeHtml(item.source)}</p>${timingLines}${item.category ? `<p style="margin:6px 0 0;color:${MUTE};font-size:12px;line-height:18px">${escapeHtml(item.category)} · ${escapeHtml(item.categoryNote)}</p>` : ""}`;
    const badges = enrichmentBadgesHtml(item.enrich);
    const priceCell = `${badges ? `<p style="margin:0 0 6px;line-height:22px">${badges}</p>` : ""}${item.enrich.auction ? `<p style="margin:0;color:${MUTE};font-size:12px;line-height:18px">当前出价</p>` : ""}<p style="margin:0;line-height:28px">${priceHtml(item.price, 20, item.category ? INK2 : INK)}</p>`;
    const headRow = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;border-collapse:collapse"><tr><td width="${image ? "24%" : "50%"}" valign="top" style="width:${image ? "24%" : "50%"};padding:0;font-size:14px;text-align:left">${metaCell}</td>${image ? `<td width="52%" valign="top" align="center" style="width:52%;padding:0 6px">${image}</td>` : ""}<td width="${image ? "24%" : "50%"}" valign="top" align="right" style="width:${image ? "24%" : "50%"};padding:0;font-size:14px;text-align:right">${priceCell}</td></tr></table>`;
    // 同名的其余卖家：邮件里做不了点击展开，只列价格 + 平台 + 链接，一件不漏。
    const range = othersRange(others);
    const othersHtml = others.length > 0
      ? `<p style="margin:14px 0 0;padding:10px 14px 12px;background:${MIST};color:${INK2};font-size:12px;line-height:22px;text-align:left"><span style="color:${INK}">同名另有 ${others.length} 件</span>${range ? ` · ${escapeHtml(range)}` : ""}<br>${others.map((other) => `${other.url ? `<a href="${escapeHtml(other.url)}" style="display:inline-block;margin:4px 4px 0 0;color:${INK};font-family:${NUM};font-size:16px;text-decoration:none;border-bottom:1px solid ${INK}">${escapeHtml(priceLabel(other))}</a>` : `<span style="display:inline-block;margin:4px 4px 0 0;font-family:${NUM};font-size:16px">${escapeHtml(priceLabel(other))}</span>`}<span style="margin:0 16px 0 2px;color:${MUTE};font-size:11px">${escapeHtml(other.source)}</span>`).join("")}</p>`
      : "";
    return `<div style="border-bottom:1px solid ${LINE};padding:18px 0 16px;font-size:14px;text-align:left">${headRow}<p style="margin:10px 0 0;color:${titleColor};font-size:14px;line-height:22px;letter-spacing:.02em">${linkedTitle}</p>${item.note ? `<p style="margin:4px 0 0;color:${imageHold ? ALERT_TEXT : INK2};font-size:12px;line-height:20px">${escapeHtml(item.note)}</p>` : ""}${enrichmentHtml(item.enrich)}${othersHtml}</div>`;
  }).join("");
  const textItems = groups.map(({ items: [item, ...others] }, index) => {
    if (!item) return "";
    const range = othersRange(others);
    const othersText = others.length > 0
      ? `\n   同名另有 ${others.length} 件${range ? `（${range}）` : ""}：${others.map((other) => `\n   - ${priceLabel(other)} ${other.source}${other.url ? ` ${other.url}` : ""}`).join("")}`
      : "";
    return `${index + 1}. ${item.category ? `【${item.category}：${item.categoryNote}】` : ""}${item.source}${item.timing ? `（${item.timing}）` : ""} · ${item.title} · ${item.enrich.auction ? "（当前出价）" : ""}${formatJpy(item.price)}${item.enrich.badges.map((badge) => ` [${badge.label}]`).join("")}${item.note ? `\n   ${item.note}` : ""}${enrichmentText(item.enrich)}${item.url ? `\n   ${item.url}` : ""}${othersText}`;
  }).join("\n");
  const dataAsOf = typeof enrichmentMeta.dataAsOf === "string" ? enrichmentMeta.dataAsOf.slice(0, 10) : "";
  const notice = scanSummary
    ? keywordDigestNotice({
      profileName: displayProfileName,
      day,
      hasReceipt: receipt !== undefined,
      hasPriceReference: enrichedCount > 0,
      extras: digestExtras,
      uncoveredCount: rawItems.filter((value, index) => {
        if (allItems[index]?.baseline) return false;
        const enrichment = recordValue(recordValue(value).enrichment);
        return Object.keys(enrichment).length > 0 && !recordValue(enrichment.ip).key;
      }).length,
      hasTiming: items.some((item) => item.timing),
      hasItems: items.length > 0,
      dataAsOf,
    })
    : undefined;
  const suspectRows = suspects.map((item) => {
    const linkedTitle = item.url
      ? `<a href="${escapeHtml(item.url)}" style="color:${INK2};text-decoration:none">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);
    return `<tr><td style="padding:16px 0;border-bottom:1px solid ${LINE_SOFT}"><p style="margin:0;line-height:22px">${pill(item.label)}<span style="margin:0 0 0 10px;color:${MUTE};font-size:12px">${escapeHtml(item.source)}</span></p><p style="margin:8px 0 0;color:${INK2};font-size:14px;line-height:23px">${linkedTitle}　<span style="font-family:${NUM};font-size:19px;color:${INK2}">${escapeHtml(formatJpy(item.price))}</span></p>${item.reason ? `<p style="margin:6px 0 0;color:${MUTE};font-size:12px;line-height:20px">${escapeHtml(item.reason)}</p>` : ""}</td></tr>`;
  }).join("");
  const suspectsHtml = suspects.length > 0
    ? `${sectionHead("未确认", `疑似同款 ${suspectTotal} 件`, "未确认，供过目", "44px 0 0")}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${suspectRows}${suspectTotal > suspects.length ? `<tr><td style="padding:12px 0;border-bottom:1px solid ${LINE_SOFT}"><p style="margin:0;color:${MUTE};font-size:12px;line-height:19px">另有 ${suspectTotal - suspects.length} 件疑似同款保存在后台记录中。</p></td></tr>` : ""}</table><p style="margin:14px 0 0;color:${MUTE};font-size:12px;line-height:20px">这些商品还没被判为确认同款。你把这份档案的邮件门槛放宽到了确认同款以外，所以它们出现在这里。判过的可以在${lineLink(suspectVerdictUrl, "商品变化", INK2)}里标「不是同款」或「太贵了」，之后不再重复出现；只想收确认同款的话，在监控策略里把门槛调回「只发确认同款」。</p>`
    : "";
  const suspectsText = suspects.length > 0
    ? `\n\n疑似同款 ${suspectTotal} 件（未确认，供过目）\n${suspects.map((item, index) => `${index + 1}. [${item.label}] ${item.source} · ${item.title} · ${formatJpy(item.price)}${item.reason ? `\n   ${item.reason}` : ""}${item.url ? `\n   ${item.url}` : ""}`).join("\n")}${suspectTotal > suspects.length ? `\n另有 ${suspectTotal - suspects.length} 件保存在后台记录中。` : ""}\n判过的可以在 ${suspectVerdictUrl} 里标「不是同款」或「太贵了」，之后不再重复出现；只想收确认同款的话，在监控策略里把门槛调回「只发确认同款」。`
    : "";
  const sourceSummary = sourceCounts.length > 0
    ? sourceCounts.join(" · ")
    : initialBaseline ? "本次未收录可购买商品" : `新增 ${total} 件`;
  const incompleteHtml = incompleteSources.length > 0
    ? noteRow(`${escapeHtml(incompleteSources.join("、"))} 这次没抓完，其他平台的结果照常列在下面。`, "error")
    : "";
  const rejectedHtml = rejectedSources.length > 0
    ? noteRow(`${escapeHtml(rejectedSources.join("、"))} 这次抓回来的数据没通过检查，先不放进来。`, "info")
    : "";
  const enrichIssue = enrichmentIssue(enrichmentMeta, digestExtras);
  const enrichIssueHtml = enrichIssue ? noteRow(escapeHtml(enrichIssue), "warn") : "";
  const unreviewedNote = unreviewedSources.length > 0
    ? `AI 这次没判完：${unreviewedSources.join("、")}，已只按关键词规则放行，可能混有同名的无关商品。`
    : "";
  const unreviewedHtml = unreviewedNote ? noteRow(escapeHtml(unreviewedNote), "warn") : "";
  const failureHtml = `${incompleteHtml}${unreviewedHtml}${rejectedHtml}${enrichIssueHtml}`;
  const failureText = [
    enrichIssue ? `\n${enrichIssue}` : "",
    unreviewedNote ? `\n${unreviewedNote}` : "",
    incompleteSources.length > 0 ? `\n${incompleteSources.join("、")} 这次没抓完，其他平台的结果照常列在下面。` : "",
    rejectedSources.length > 0 ? `\n${rejectedSources.join("、")} 这次抓回来的数据没通过检查，先不放进来。` : "",
  ].join("");
  // 新建档案的第一封只有建档存量，没有逐件商品：整封就是一张回执。
  const receiptOnly = receipt !== undefined && items.length === 0 && suspects.length === 0;
  const receiptHeadline = `建档完成，记下各平台在售 ${Math.max(baselineTotal, baselineItems.length)} 件，明天起只发新上架`;
  const digestLabel = receiptOnly ? "建档回执" : scanSummary ? "关键词巡回摘要" : initialBaseline ? "首次巡回完成"
    : imageHold ? "标题对上、图片不像"
    : exactProduct ? total === 0 && suspectTotal > 0 ? "疑似同款待判断" : "确认同款上新" : "关键词上新";
  const imageHoldNote = "这几件的标题被判为确认同款，但商品图和你给的参考图明显不同：可能是另一个版本（别的插画、别的服装），也可能只是官图和卖家实拍的差别。白天没打扰你，攒到现在一起发，下单前先看一眼图。";
  const windowNote = scanSummary
    ? `「首次发现」是这个档案第一次看到它，不一定是今天才上架；「恢复识别」是以前抓到过、这次才通过筛选的商品。${baselineSources ? `${baselineSources} 是这次第一次记下在售商品，下一轮起只报新上架。` : ""}`
    : initialBaseline
    ? "这次列的是开始监控时已经在卖的商品，不是今天新上架的；从下一轮起，只发新出现的商品。"
    : imageHold
      ? "标题判定和图片判定不一致的商品不会在白天单独打扰你；图片和参考图对上的确认同款照常当天发。"
    : exactProduct
      ? `「确认同款」指编号或型号对得上，或经 AI 核对过是同一件。每个平台只看搜索结果的前几页。${suspectTotal > 0 ? "没能确认的列在「疑似同款」里，下单前先核对。" : "默认只发确认同款，可以在档案的监控策略里放宽。"}`
      : limitedWindowNote;
  const subject = receiptOnly
    ? `【${brandName}】${subjectText(displayProfileName, 120)}：${receiptHeadline}`
    : scanSummary
    ? `【${brandName}】${subjectText(displayProfileName, 120)}：${summaryCounts}`
    : initialBaseline
    ? `【${brandName}】${subjectText(displayProfileName, 120)}：首次巡回完成，记下在售 ${baselineTotal} 件`
    : imageHold
    ? `【${brandName}】${subjectText(displayProfileName, 120)}：${total} 件标题判为同款、但商品图和参考图不同`
    // 一件都没确认但有存疑候选时，标题必须如实说出来：过去这种轮次直接不发信。
    : exactProduct && total === 0 && suspectTotal > 0
    ? `【${brandName}】${subjectText(displayProfileName, 120)}：${suspectTotal} 件疑似同款待你判断`
    : `【${brandName}】${subjectText(displayProfileName, 120)}：发现 ${total} 件新的${exactProduct ? "确认同款" : "商品"}${suspectTotal > 0 ? `，另有 ${suspectTotal} 件疑似` : ""}`;
  const subtitle = receiptOnly ? `${day} · 建档存量 ${Math.max(baselineTotal, baselineItems.length)} 件`
    : scanSummary ? `${day} · ${summaryCounts}` : initialBaseline
    ? `${day} · 在售 ${baselineTotal} 件${newTotal > 0 ? ` · 同轮新增 ${newTotal} 件` : ""}`
    : `${day} · 新增 ${total} 件${suspectTotal > 0 ? ` · 疑似 ${suspectTotal} 件` : ""}`;
  const metricLabel = scanSummary ? "本轮汇总（含建档存量与恢复识别）" : initialBaseline ? "首次收录" : "本轮新增";
  const metricTotal = initialBaseline ? baselineTotal : total;
  // 回执已经有自己的大数字和平台件数，纯回执时不再叠一张汇总卡。
  const stats = scanSummary
    ? [{ value: newTotal, label: "首次发现", unit: "件" },
      ...(recoveredTotal > 0 ? [{ value: recoveredTotal, label: "恢复识别", unit: "件" }] : []),
      ...(baselineTotal > 0 ? [{ value: baselineTotal, label: "建档存量", unit: "件" }] : [])]
    : initialBaseline
      ? [{ value: baselineTotal, label: "首次收录", unit: "件" }, ...(newTotal > 0 ? [{ value: newTotal, label: "同轮新增", unit: "件" }] : [])]
      : [{ value: total, label: exactProduct ? "确认同款" : "本轮新增", unit: "件" }, ...(suspectTotal > 0 ? [{ value: suspectTotal, label: "疑似同款", unit: "件" }] : [])];
  const metricHtml = receiptOnly ? "" : `${statRow(stats)}<p style="margin:14px 0 24px;color:${MUTE};font-size:12px;line-height:20px;letter-spacing:.06em">${escapeHtml(sourceSummary)}</p>`;
  const metricText = receiptOnly ? "" : `\n${metricLabel} ${metricTotal} 件\n${sourceSummary}`;
  // 同一轮既有回执又有逐件商品时，给商品单独起个头，免得和回执里的示例混在一起。
  const itemsHeading = items.length === 0 ? ""
    : receipt ? sectionHead("逐件列出", `以下逐件列出 ${items.length} 件`, "", "40px 0 0")
    : imageHold ? sectionHead("标题对上、图片不像", `这一批 ${items.length} 件`, "下单前先看图", "36px 0 0")
    : exactProduct ? sectionHead("确认同款", `确认同款 ${items.length} 件`, "", "36px 0 0")
    : sectionHead("新上架", `这一轮的新货 ${items.length} 件`, "单品在前 · 打包最后", "36px 0 0");
  const headerKind = receiptOnly ? "receipt" as const
    : scanSummary || initialBaseline ? "keyword-digest" as const
    : imageHold ? "exact-image-hold" as const
    : exactProduct ? total === 0 && suspectTotal > 0 ? "exact-suspect" as const : "exact" as const
    : "keyword-new" as const;
  const unlisted = total - allItems.length;
  return {
    subject,
    html: emailShell({
      eyebrow: digestLabel,
      title: displayProfileName,
      header: headerKind,
      audience: options.audience ?? "owner",
      footerNote: "日本二手市场的新货，每天替你看一遍。",
      subtitle,
      preview: receiptOnly ? `${displayProfileName}：${receiptHeadline}` : scanSummary ? `${displayProfileName}：${summaryCounts}` : initialBaseline ? `${displayProfileName}：首次巡回完成` : imageHold ? `${displayProfileName}：${total} 件标题判为同款、但图不像` : `${displayProfileName}：发现 ${total} 件新的商品`,
      content: `${metricHtml}${imageHold ? noteRow(escapeHtml(imageHoldNote), "warn") : ""}${failureHtml}${receipt ? `<div style="margin:${metricHtml ? 32 : 0}px 0 0">${receipt.html}</div>` : ""}${itemsHeading}${itemRows}${unlisted > 0 ? `<p style="margin:20px 0;color:${MUTE};font-size:13px;line-height:20px">另有 ${unlisted} 件保存在后台记录中。</p>` : ""}${suspectsHtml}${notice ? notice.html : `<p style="margin:28px 0 0;color:${MUTE};font-size:12px;line-height:20px">${windowNote}</p>`}`,
    }),
    text: `${digestLabel}\n${displayProfileName}\n${subtitle}${metricText}${imageHold ? `\n\n${imageHoldNote}` : ""}${failureText}${receipt ? `\n\n${receipt.text}` : ""}${textItems ? `\n\n${textItems}` : ""}${unlisted > 0 ? `\n\n另有 ${unlisted} 件保存在后台记录中。` : ""}${suspectsText}\n\n${notice ? notice.text : windowNote}`,
  };
}

const ROUTE_LABELS: Record<string, string> = {
  mercari_service: "东京主路（Vercel）",
  source_runner: "新加坡备用路（VPS）",
};

/**
 * 煤炉采集路线提醒（apps/collector/src/mercari-route.ts）。只发管理员；每段故障一封，
 * 所以正文要把"现在系统在干什么、你要不要动手"说清，原始错误放在最后给排查用。
 */
function routeAlertEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const kind = String(detail.routeAlert);
  // 管理员平时就叫它"煤炉"；标题要一眼认出是哪个来源。
  const source = detail.sourceId === "mercari_jp" ? "煤炉" : sourceLabel(detail.sourceId);
  const code = String(detail.code ?? "unknown").replace(/[\r\n]+/gu, " ").trim().slice(0, 120);
  const cooldownUntil = typeof detail.cooldownUntil === "string" && Number.isFinite(Date.parse(detail.cooldownUntil))
    ? new Date(detail.cooldownUntil).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour12: false })
    : undefined;
  const failures = Array.isArray(detail.routeFailures)
    ? detail.routeFailures.map((value) => {
      const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const label = ROUTE_LABELS[String(item.route)] ?? String(item.route ?? "未知路线");
      return `${label}：${String(item.message ?? item.code ?? "未知原因").slice(0, 500)}`;
    })
    : [];
  const platformForbidden = code.endsWith("_platform_forbidden");
  const copy = kind === "primary_recovered"
    ? {
      heading: `${source}主路已恢复`,
      tone: "#eef5f8",
      toneText: "#1a7ca3",
      lead: "东京主路（Vercel）重新请求成功，煤炉采集已经切回主路。",
      next: "不需要你做什么。",
    }
    : kind === "all_down"
    ? {
      heading: `${source}全线不通`,
      tone: "#fbefe9",
      toneText: "#a8431a",
      lead: "东京主路（Vercel）和新加坡备用路（VPS）这一次都失败了，这一轮煤炉采集没有拿到数据。",
      next: "每天跑一次的煤炉档案会在 2 小时后自动补跑一次。在任意一条路恢复之前，不会再重复发这封提醒。",
    }
    : {
      heading: `${source}主路故障，已切到备用路`,
      tone: "#fdfbe4",
      toneText: "#6b6420",
      lead: "东京主路（Vercel）这次请求失败，系统已自动改走新加坡备用路（VPS），这次采集照常完成。",
      next: `${cooldownUntil ? `日本时间 ${cooldownUntil} 之前，煤炉采集都直接走备用路，到时间后再试一次主路。` : ""}主路恢复时会再发一封通知。${platformForbidden ? "这次是 Vercel 平台自己拒绝了请求，不是煤炉封禁：请到 Vercel 后台检查防火墙、部署保护和项目状态。" : ""}`,
    };
  const failureHtml = failures.length > 0
    ? `<p style="margin:18px 0 6px;color:#111111;font-size:14px;line-height:23px"><strong>失败原因（排查用）</strong></p><pre style="margin:0;white-space:pre-wrap;background:#f4f6f7;padding:12px;color:#4a4a4a;font-size:12px;line-height:19px">${escapeHtml(failures.join("\n\n"))}</pre>`
    : "";
  return {
    subject: `【${brandName}】${copy.heading}`,
    html: emailShell({
      eyebrow: "采集路线提醒",
      title: copy.heading,
      subtitle: "只发给管理员",
      preview: copy.lead,
      content: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${copy.tone}" style="width:100%;background:${copy.tone}"><tr><td style="padding:14px 16px;color:${copy.toneText};font-size:14px;line-height:23px">${escapeHtml(copy.lead)}</td></tr></table><p style="margin:16px 0 0;color:#111111;font-size:14px;line-height:23px">${escapeHtml(copy.next)}</p>${failureHtml}<p style="margin:16px 0 0;color:#6b6b6b;font-size:12px;line-height:19px">错误码：${escapeHtml(code)}</p>`,
      footerNote: "同一段故障只提醒一次。",
    }),
    text: `${copy.heading}\n${copy.lead}\n${copy.next}${failures.length > 0 ? `\n\n失败原因：\n${failures.join("\n")}` : ""}\n错误码：${code}`,
  };
}

export function sourceErrorEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  if (typeof detail.routeAlert === "string") return routeAlertEmail(detail);
  const source = sourceLabel(detail.sourceId);
  const profileName = String(detail.profileName ?? "未命名监控").replace(/[\r\n]+/gu, " ").trim().slice(0, 160);
  const monitorTarget = String(detail.monitorTarget ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, 300);
  const code = String(detail.code ?? "unknown").replace(/[\r\n]+/gu, " ").trim().slice(0, 120);
  const message = String(detail.message ?? "来源连续失败");
  const failures = Number(detail.failures ?? 0);
  const targetHtml = monitorTarget ? `<p><strong>监控目标：</strong>${escapeHtml(monitorTarget)}</p>` : "";
  const targetText = monitorTarget ? `\n监控目标：${monitorTarget}` : "";
  if (["keyword_rules_filtered_all", "keyword_rules_excluded_all"].includes(code)) {
    const heading = code === "keyword_rules_excluded_all" ? "关键词筛选结果" : "关键词匹配提醒";
    return {
      subject: `【${brandName}】${heading}：${profileName}`,
      html: emailShell({
        eyebrow: "监控规则提醒",
        title: heading,
        subtitle: `${source} · ${profileName}`,
        preview: message,
        content: `${targetHtml}<p>${escapeHtml(message)}</p>`,
        footerNote: "本档案每天最多提醒一次。来源仍会按原计划继续采集。",
      }),
      text: `${heading}\n${source}\n监控：${profileName}${targetText}\n${message}\n本档案每天最多提醒一次，来源仍会按原计划继续采集。`,
    };
  }
  // parser 结构错误与 CAPTCHA 会在第一次失败就停用该来源及其全部绑定，
  // 必须在通知里说清需要人工恢复，否则监控静默中断而用户无从得知。
  const disabled = detail.disabled === true;
  const heading = disabled ? "来源已自动停用" : "来源连续故障";
  const disabledHtml = disabled
    ? `<p style="padding:10px 12px;background:#fbefe9;color:#a8431a"><strong>该来源与其下全部监控已自动停用</strong>，需要在来源页手动重新启用后才会继续采集。</p>`
    : "";
  const disabledText = disabled ? "\n该来源与其下全部监控已自动停用，需要在来源页手动重新启用。" : "";
  return {
    subject: `【${brandName}】${heading}：${source} · ${profileName}`,
    html: emailShell({
      eyebrow: "系统状态提醒",
      title: heading,
      subtitle: `${source} · ${profileName}`,
      preview: `${heading}：${source}`,
      content: `${disabledHtml}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fbefe9" style="width:100%;background:#fbefe9"><tr><td style="padding:14px 16px;color:#a8431a;font-size:13px;line-height:21px"><strong>错误码：${escapeHtml(code)}</strong><br>连续失败 ${failures} 次。</td></tr></table><p style="margin:18px 0 0;color:#111111;font-size:14px;line-height:23px"><strong>监控：</strong>${escapeHtml(profileName)}</p>${targetHtml}<pre style="margin:16px 0 0;white-space:pre-wrap;background:#f4f6f7;padding:12px;color:#4a4a4a;font-size:12px;line-height:19px">${escapeHtml(message)}</pre>`,
      footerNote: "系统已保留本次故障信息。修复或重新启用来源后，采集会继续进行。",
    }),
    text: `${heading}\n${source}${disabledText}\n监控：${profileName}${targetText}\n错误码：${code}\n连续失败 ${failures} 次\n${message}`,
  };
}

export function dailyDigestEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const total = Number(detail.total ?? 0);
  const day = String(detail.day ?? new Date().toISOString().slice(0, 10));
  const items = Array.isArray(detail.items) ? detail.items.slice(0, 50) : [];
  const normalized = items.map((value) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      type: String(item.type ?? "event"),
      source: sourceLabel(item.sourceId),
      title: String(item.title ?? "来源状态事件"),
      url: safeHttpUrl(item.url),
      price: typeof item.price === "number" ? item.price : undefined,
    };
  });
  const htmlItems = normalized.map((item) => {
    const title = item.url
      ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);
    return `<li style="margin:0 0 12px"><strong>${escapeHtml(item.type)}</strong> · ${escapeHtml(item.source)}<br>${title}${item.price === undefined ? "" : ` · ${formatJpy(item.price)}`}</li>`;
  }).join("");
  const textItems = normalized.map((item) => `- ${item.type} · ${item.source} · ${item.title}${item.price === undefined ? "" : ` · ${formatJpy(item.price)}`}${item.url ? `\n  ${item.url}` : ""}`).join("\n");
  return {
    subject: `【${brandName}】${day} 事件摘要（${total} 条）`,
    html: emailShell({
      eyebrow: "通知保护摘要",
      title: "今天的变化已合并",
      subtitle: `${day} · ${total} 条事件`,
      preview: `通知保护已合并 ${total} 条事件`,
      content: `<p style="margin:0 0 18px;color:#4a4a4a;font-size:14px;line-height:23px">今日事件达到通知保护阈值，剩余变化已合并在这封摘要中；完整记录仍保存在后台。</p><ol style="margin:0;padding-left:22px;color:#111111;font-size:14px;line-height:22px">${htmlItems}</ol>${total > normalized.length ? `<p style="margin:20px 0 0;color:#6b6b6b;font-size:13px">另有 ${total - normalized.length} 条，请在后台事件页查看。</p>` : ""}`,
    }),
    text: `通知保护摘要\n${day}\n剩余 ${total} 条事件已合并，完整记录保存在后台。\n\n${textItems}${total > normalized.length ? `\n\n另有 ${total - normalized.length} 条，请在后台查看。` : ""}`,
  };
}

export function watchCompletedEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const profileName = subjectText(String(detail.profileName ?? "单品监控"), 160);
  const title = subjectText(String(detail.title ?? "未命名商品"), 240);
  const source = sourceLabel(detail.sourceId);
  const url = safeHttpUrl(detail.url);
  const terminalDays = Math.max(0, Math.floor(Number(detail.terminalDays ?? 7)));
  const terminalAvailability = String(detail.terminalAvailability ?? "sold_out");
  const status = availabilityLabels[terminalAvailability] ?? terminalAvailability;
  // terminalDays=0：售出即结束，没有等待期。
  const duration = terminalDays === 0 ? "已" : `已连续 ${terminalDays} 天保持`;
  return {
    subject: `【${brandName}】监控已完成：${profileName}`,
    html: emailShell({
      eyebrow: "单品监控",
      title: "监控已完成",
      subtitle: `${source} · ${profileName}`,
      preview: `监控已完成：${profileName}`,
      content: `<p style="margin:0;color:#4a4a4a;font-size:14px;line-height:23px">该一次性挂牌${duration}<strong>${escapeHtml(status)}</strong>，不会再产生有效的降价或补货变化，因此系统已自动结束监控；历史记录仍会保留。</p><h2 style="margin:20px 0 0;color:#111111;font-size:20px;line-height:30px">${escapeHtml(title)}</h2>${actionButton(url, "查看最后记录")}`,
    }),
    text: `单品监控已完成\n${profileName}\n${source} · ${title}\n该一次性挂牌${duration}${status}，系统已自动结束监控；历史记录仍会保留。${url ? `\n${url}` : ""}`,
  };
}

export function morningDigestEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const day = subjectText(String(detail.day ?? new Date().toISOString().slice(0, 10)), 40);
  const total = Math.max(0, Number(detail.total ?? 0));
  const counts = (Array.isArray(detail.counts) ? detail.counts : []).map((value) => {
    const entry = recordValue(value);
    return {
      label: eventTypeLabel(entry.type),
      count: Math.max(0, Number(entry.count ?? 0)),
    };
  }).filter((entry) => entry.count > 0);
  const items = (Array.isArray(detail.items) ? detail.items.slice(0, 50) : []).map((value) => {
    const item = recordValue(value);
    return {
      type: eventTypeLabel(item.type),
      source: sourceLabel(item.sourceId),
      title: subjectText(String(item.title ?? eventTypeLabel(item.type)), 240),
      url: safeHttpUrl(item.url),
      price: typeof item.price === "number" ? item.price : undefined,
    };
  });
  const countSummary = counts.length > 0
    ? counts.map((entry) => `${entry.label} ${entry.count} 条`).join(" · ")
    : `共 ${total} 条变化`;
  const htmlItems = items.map((item) => {
    const title = item.url
      ? `<a href="${escapeHtml(item.url)}" style="color:#111111">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title);
    return `<li style="margin:0 0 12px"><strong>${escapeHtml(item.type)}</strong> · ${escapeHtml(item.source)}<br>${title}${item.price === undefined ? "" : ` · ${formatJpy(item.price)}`}</li>`;
  }).join("");
  const textItems = items.map((item) => `- ${item.type} · ${item.source} · ${item.title}${item.price === undefined ? "" : ` · ${formatJpy(item.price)}`}${item.url ? `\n  ${item.url}` : ""}`).join("\n");
  return {
    subject: `【${brandName}】${day} 早间雷达摘要（${total} 条）`,
    html: emailShell({
      eyebrow: "东京时间 09:00 · 主动摘要",
      title: `${day} 雷达晨报`,
      subtitle: countSummary,
      preview: `${day} 雷达晨报：${countSummary}`,
      content: `<ol style="margin:0;padding-left:22px;color:#111111;font-size:14px;line-height:22px">${htmlItems}</ol>${total > items.length ? `<p style="margin:20px 0 0;color:#6b6b6b;font-size:13px">另有 ${total - items.length} 条保存在后台变化记录中。</p>` : ""}`,
    }),
    text: `${day} 雷达晨报\n东京时间 09:00 主动摘要\n${countSummary}\n\n${textItems}${total > items.length ? `\n\n另有 ${total - items.length} 条保存在后台变化记录中。` : ""}`,
  };
}

/** Weekly exact-product market and collector health report. It is intentionally
 * tolerant of missing fields so a partial report still proves the job ran. */
interface WeeklyReportItemView {
  source: string;
  title: string;
  url: string | undefined;
  price: number | undefined;
  oldPrice: number | undefined;
  available: boolean;
  auction: boolean;
}

interface WeeklyReportProfileView {
  name: string;
  targetPrice: number | undefined;
  checks: number;
  newOfferCount: number;
  dropCount: number;
  targetHitCount: number;
  newOffers: WeeklyReportItemView[];
  drops: WeeklyReportItemView[];
  targetHits: WeeklyReportItemView[];
  lowestNow: number | undefined;
  lowestWeekAgo: number | undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function weeklyReportItems(value: unknown): WeeklyReportItemView[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const item = recordValue(entry);
    return {
      source: sourceLabel(item.sourceId),
      title: subjectText(String(item.title ?? "未命名商品"), 120),
      url: safeHttpUrl(item.url),
      price: optionalNumber(item.price),
      oldPrice: optionalNumber(item.oldPrice),
      available: item.available === true,
      auction: item.auction === true,
    };
  });
}

function tokyoMonthDay(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(date);
}

// 一行"最低价"说明，全部由数字拼出来：用户一眼看出价格往哪边走、离目标还差多少。
function weeklyLowestLine(profile: WeeklyReportProfileView): string {
  const parts: string[] = [];
  if (profile.targetPrice !== undefined) parts.push(`目标 ${formatJpy(profile.targetPrice)}`);
  if (profile.lowestNow === undefined) {
    parts.push("暂无一口价在售的同款");
  } else {
    let lowest = `当前最低 ${formatJpy(profile.lowestNow)}`;
    if (profile.lowestWeekAgo !== undefined && profile.lowestWeekAgo !== profile.lowestNow) {
      const delta = profile.lowestNow - profile.lowestWeekAgo;
      lowest += `（比一周前${delta < 0 ? "低" : "高"} ${formatJpy(Math.abs(delta))}）`;
    } else if (profile.lowestWeekAgo !== undefined) {
      lowest += "（与一周前相同）";
    }
    parts.push(lowest);
    if (profile.targetPrice !== undefined) {
      parts.push(profile.lowestNow <= profile.targetPrice ? "已达到目标价" : `离目标还差 ${formatJpy(profile.lowestNow - profile.targetPrice)}`);
    }
  }
  return parts.join(" · ");
}

function weeklyTargetCell(profile: WeeklyReportProfileView): string {
  if (profile.targetPrice === undefined) return "—";
  if (profile.lowestNow === undefined) return formatJpy(profile.targetPrice);
  return profile.lowestNow <= profile.targetPrice ? "已达到" : `差 ${formatJpy(profile.lowestNow - profile.targetPrice)}`;
}

interface WeeklyHealthView {
  completedRuns: number;
  days: number;
  findings: Array<{
    critical: boolean;
    title: string;
    detail: string;
    status: string;
    open: boolean;
  }>;
}

function weeklyHealthView(value: unknown): WeeklyHealthView | undefined {
  if (value === undefined || value === null) return undefined;
  const health = recordValue(value);
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    completedRuns: Number(health.completedRuns ?? 0),
    days: Number(health.days ?? 7),
    findings: (Array.isArray(health.findings) ? health.findings : []).map((entry) => {
      const finding = recordValue(entry);
      const firstSeen = Date.parse(String(finding.firstSeenAt ?? ""));
      const lastSeen = Date.parse(String(finding.lastSeenAt ?? ""));
      const lasting = Number.isFinite(firstSeen) && Number.isFinite(lastSeen)
        ? Math.floor((lastSeen - firstSeen) / dayMs) + 1
        : undefined;
      const open = !finding.resolvedAt;
      const source = typeof finding.sourceId === "string" ? `${sourceLabel(finding.sourceId)} · ` : "";
      return {
        critical: finding.severity === "critical",
        title: `${source}${String(finding.title ?? "")}`,
        detail: String(finding.detail ?? ""),
        status: [
          open ? "仍存在" : `已恢复（${tokyoMonthDay(finding.resolvedAt)}）`,
          `首次发现 ${tokyoMonthDay(finding.firstSeenAt)}`,
          ...(lasting === undefined ? [] : [`持续 ${lasting} 天`]),
        ].join(" · "),
        open,
      };
    }),
  };
}

export function weeklyExactReportEmail(detail: Record<string, unknown>): { subject: string; html: string; text: string } {
  const profiles: WeeklyReportProfileView[] = (Array.isArray(detail.profiles) ? detail.profiles : []).map((entry) => {
    const profile = recordValue(entry);
    return {
      name: subjectText(String(profile.profileName ?? "精确同款雷达"), 120),
      targetPrice: optionalNumber(profile.targetPrice),
      checks: Number(profile.checks ?? 0),
      newOfferCount: Number(profile.newOfferCount ?? 0),
      dropCount: Number(profile.dropCount ?? 0),
      targetHitCount: Number(profile.targetHitCount ?? 0),
      newOffers: weeklyReportItems(profile.newOffers),
      drops: weeklyReportItems(profile.drops),
      targetHits: weeklyReportItems(profile.targetHits),
      lowestNow: optionalNumber(profile.lowestNow),
      lowestWeekAgo: optionalNumber(profile.lowestWeekAgo),
    };
  });
  const window = `${tokyoMonthDay(detail.windowStartedAt)}–${tokyoMonthDay(detail.windowEndedAt)}`;
  // 有新情况 = 到目标价、降价、新同款三样占一样。排序也按这个重要程度。
  const withNews = profiles
    .filter((profile) => profile.targetHitCount + profile.dropCount + profile.newOfferCount > 0)
    .sort((left, right) => (right.targetHitCount - left.targetHitCount) || (right.dropCount - left.dropCount) || (right.newOfferCount - left.newOfferCount));
  const idle = profiles.length - withNews.length;
  const notChecked = profiles.filter((profile) => profile.checks === 0).length;
  const summary = [
    `${profiles.length} 个档案`,
    `${withNews.length} 个有新情况`,
    `${idle} 个本周没有变化`,
    ...(notChecked > 0 ? [`${notChecked} 个本周没有检查`] : []),
  ].join(" · ");

  const itemPrice = (item: WeeklyReportItemView) => item.price === undefined ? "价格待确认" : `${formatJpy(item.price)}${item.auction ? "（拍卖当前出价）" : ""}`;
  const itemLines = (profile: WeeklyReportProfileView) => [
    ...profile.targetHits.map((item) => ({ mark: "★ 到目标价", price: itemPrice(item), item })),
    ...profile.drops.map((item) => ({ mark: "↓ 降价", price: `${item.oldPrice === undefined ? "" : `${formatJpy(item.oldPrice)} → `}${itemPrice(item)}`, item })),
    ...profile.newOffers.map((item) => ({ mark: "＋ 新同款", price: itemPrice(item), item })),
  ];
  const moreNote = (profile: WeeklyReportProfileView) => {
    const hidden = (profile.targetHitCount - profile.targetHits.length) + (profile.dropCount - profile.drops.length) + (profile.newOfferCount - profile.newOffers.length);
    return hidden > 0 ? `另有 ${hidden} 件未列出` : "";
  };

  const cell = "padding:9px 6px;border-bottom:1px solid #efefef;font-size:13px;line-height:19px;color:#111111";
  const headCell = "padding:0 6px 8px;border-bottom:1px solid #9f9f9f;font-size:11px;line-height:16px;color:#6b6b6b;font-weight:400";
  const newsHtml = withNews.length === 0
    ? `<p style="margin:0;color:#4a4a4a;font-size:14px;line-height:22px">本周所有档案都没有新同款、降价或到目标价的商品。</p>`
    : withNews.map((profile) => {
        const lines = itemLines(profile).map(({ mark, price, item }) => `<tr><td valign="top" width="92" style="padding:7px 0;color:${mark.startsWith("★") ? "#a8431a" : mark.startsWith("↓") ? "#1a7ca3" : "#111111"};font-size:12px;line-height:19px;white-space:nowrap">${escapeHtml(mark)}</td><td valign="top" style="padding:7px 0 7px 8px;font-size:13px;line-height:19px;color:#111111"><strong style="font-weight:700">${escapeHtml(price)}</strong> · ${escapeHtml(item.source)}<br>${item.url ? `<a href="${escapeHtml(item.url)}" style="color:#111111;text-decoration:underline">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</td></tr>`).join("");
        const more = moreNote(profile);
        return `<div style="margin:0 0 22px;padding:16px 0 0;border-top:1px solid #e6e6e6;text-align:left"><p style="margin:0;color:#111111;font-size:16px;line-height:24px;font-weight:700">${escapeHtml(profile.name)}</p><p style="margin:4px 0 6px;color:#4a4a4a;font-size:12px;line-height:19px">${escapeHtml(weeklyLowestLine(profile))}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${lines}</table>${more ? `<p style="margin:4px 0 0;color:#6b6b6b;font-size:12px;line-height:18px">${escapeHtml(more)}</p>` : ""}</div>`;
      }).join("");
  const tableRows = profiles.map((profile) => `<tr><td style="${cell};text-align:left">${escapeHtml(profile.name)}</td><td align="right" style="${cell};${profile.checks === 0 ? "color:#a8431a;font-weight:700" : ""}">${profile.checks}</td><td align="right" style="${cell}">${profile.newOfferCount}</td><td align="right" style="${cell}">${profile.dropCount}</td><td align="right" style="${cell};white-space:nowrap">${escapeHtml(profile.lowestNow === undefined ? "—" : formatJpy(profile.lowestNow))}</td><td align="right" style="${cell};white-space:nowrap">${escapeHtml(weeklyTargetCell(profile))}</td></tr>`).join("");
  const tableHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 0;border-collapse:collapse"><tr><th align="left" style="${headCell}">档案</th><th align="right" style="${headCell}">本周检查</th><th align="right" style="${headCell}">新同款</th><th align="right" style="${headCell}">降价</th><th align="right" style="${headCell}">当前最低</th><th align="right" style="${headCell}">目标价</th></tr>${tableRows}</table><p style="margin:10px 0 0;color:#6b6b6b;font-size:12px;line-height:19px;text-align:left">"本周检查"是这一周自动检查成功的次数，是 0 说明这个档案这周没在工作。降价指和一周前相比，在售同款的一口价变低了；新同款只算本周找到、现在还在售的；当前最低不含拍卖出价。</p>`;
  const sectionTitle = (title: string) => `<h2 style="margin:30px 0 12px;color:#111111;font-size:18px;line-height:26px;font-weight:700;text-align:left">${escapeHtml(title)}</h2>`;

  const textNews = withNews.length === 0
    ? "本周所有档案都没有新同款、降价或到目标价的商品。"
    : withNews.map((profile) => {
        const lines = itemLines(profile).map(({ mark, price, item }) => `  ${mark}  ${price} · ${item.source}\n    ${item.title}${item.url ? `\n    ${item.url}` : ""}`).join("\n");
        const more = moreNote(profile);
        return `${profile.name}\n  ${weeklyLowestLine(profile)}\n${lines}${more ? `\n  ${more}` : ""}`;
      }).join("\n\n");
  const textTable = profiles.map((profile) => `- ${profile.name}：检查 ${profile.checks} 次 · 新同款 ${profile.newOfferCount} · 降价 ${profile.dropCount} · 当前最低 ${profile.lowestNow === undefined ? "—" : formatJpy(profile.lowestNow)} · 目标价 ${weeklyTargetCell(profile)}`).join("\n");

  // 系统体检：运维信息，和上面的买家内容用分隔线隔开。没有问题时只留一行。
  const health = weeklyHealthView(detail.health);
  const openFindings = health?.findings.filter((finding) => finding.open).length ?? 0;
  const healthSummary = health === undefined ? "" : [
    `本周体检完成 ${health.completedRuns}/${health.days} 天`,
    ...(health.findings.length === 0 ? ["没有发现问题"] : [
      `仍存在 ${openFindings} 项`,
      `本周已恢复 ${health.findings.length - openFindings} 项`,
    ]),
  ].join(" · ");
  const healthHtml = health === undefined ? "" : `<div style="margin:34px 0 0;padding:4px 0 0;border-top:2px solid #e6e6e6">${sectionTitle("系统体检（运维）")}<p style="margin:0 0 10px;color:#4a4a4a;font-size:13px;line-height:20px;text-align:left">${escapeHtml(healthSummary)}</p>${health.findings.map((finding) => `<div style="margin:0 0 12px;padding:0 0 0 10px;border-left:3px solid ${finding.critical ? "#a8431a" : finding.open ? "#e8e15d" : "#9f9f9f"};text-align:left"><p style="margin:0;color:${finding.open ? "#111111" : "#6b6b6b"};font-size:13px;line-height:20px;font-weight:700">${escapeHtml(finding.title)}</p><p style="margin:2px 0 0;color:#4a4a4a;font-size:12px;line-height:19px">${escapeHtml(finding.detail)}</p><p style="margin:2px 0 0;color:#6b6b6b;font-size:11px;line-height:17px">${escapeHtml(finding.status)}</p></div>`).join("")}${health.completedRuns < health.days ? `<p style="margin:6px 0 0;color:#6b6b6b;font-size:12px;line-height:19px;text-align:left">有 ${health.days - health.completedRuns} 天体检没有跑完，那几天的问题可能没被发现。</p>` : ""}</div>`;
  const healthText = health === undefined ? "" : `\n\n【系统体检（运维）】\n${healthSummary}${health.findings.map((finding) => `\n- ${finding.title}\n  ${finding.detail}\n  ${finding.status}`).join("")}`;

  return {
    subject: `【${brandName}】精确同款周报 ${window}：${withNews.length > 0 ? `${withNews.length} 个档案有新情况` : "本周没有新情况"}${openFindings > 0 ? `，体检 ${openFindings} 项待处理` : ""}`,
    html: emailShell({
      eyebrow: "精确同款周报",
      header: "weekly",
      title: "本周精确同款",
      subtitle: `${window} · ${summary}`,
      preview: summary,
      footerNote: "每周一早上发送，包含所有启用中的精确同款档案。",
      content: `${sectionTitle("有新情况的档案")}${newsHtml}${sectionTitle("全部档案一览")}${tableHtml}${actionButton(suspectVerdictUrl, "打开商品变化")}${healthHtml}`,
    }),
    text: `精确同款周报 ${window}\n${summary}\n\n【有新情况的档案】\n${textNews}\n\n【全部档案一览】\n${textTable}\n\n"本周检查"是这一周自动检查成功的次数，是 0 说明这个档案这周没在工作。\n打开商品变化：${suspectVerdictUrl}${healthText}`,
  };
}

export function finalAcceptanceEmail(detail: { completedAt: string; checks: Array<{ label: string; evidence?: unknown }> }): { subject: string; html: string; text: string } {
  const completedAt = new Date(detail.completedAt).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour12: false });
  const htmlChecks = detail.checks.map((check) => `<li style="margin:0 0 8px">${escapeHtml(check.label)}</li>`).join("");
  const textChecks = detail.checks.map((check) => `- ${check.label}`).join("\n");
  return {
    subject: `【${brandName}】v4 最终验收全部通过`,
    html: emailShell({
      eyebrow: "系统验收",
      title: "v4 最终阶段完成",
      subtitle: `${completedAt}（日本时间）`,
      preview: "v4 最终验收全部通过",
      content: `<p style="margin:0;color:#4a4a4a;font-size:14px;line-height:23px">当前版本全部验收项已有证据并通过，包含 Mercari、骏河屋与连续 48 小时稳定性结果。</p><ol style="margin:18px 0 0;padding-left:22px;color:#111111;font-size:14px;line-height:22px">${htmlChecks}</ol>`,
    }),
    text: `v4 最终阶段完成\n当前版本全部验收项已有证据并通过。\n完成时间：${completedAt}（日本时间）\n\n${textChecks}`,
  };
}
