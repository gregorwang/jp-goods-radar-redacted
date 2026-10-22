/**
 * 飞书卡片（JSON 2.0）排版。只管"长什么样"，数据怎么来在 batch.ts，按钮点了怎么办在 hub.ts。
 *
 * 一张卡 = 这一小时所有 IP 的新货：
 *   标题栏   「爱蜜莉雅 5 · 赛车初音 4 · 鸣濑白羽 3」，副标题时间和件数，有低于行情的挂绿色标签
 *   每个 IP  小标题 → 一张拼好的九宫格图（点开放大）→ 每件一行：①标题 / 来源·上架时间 / 标签 | 价格 [不想看] [等降价]
 *   页脚     怎么用 + 下一轮几点
 * 通知栏和会话列表里显示的是 config.summary，所以那句话要一眼看出"值不值得现在点开"。
 *
 * 卡片上限：30 KB、组件约 200 个。一行 8 个组件，所以一张卡最多 MAX_ITEMS_PER_CARD 件，多了由 batch.ts 拆成几张。
 */

export const MAX_ITEMS_PER_CARD = 20;

export interface CardSales {
  label: string;
  median: number;
  n: number;
  verdict?: "cheaper" | "pricier" | "even";
  verdictText?: string;
}

export interface CardItem {
  /** 本节里的序号，和九宫格图上的数字一致。 */
  n: number;
  profileId: string;
  digestEventId?: string;
  sourceId: string;
  sourceItemId?: string;
  sourceLabel: string;
  title: string;
  price: number | null;
  auction: boolean;
  bidCount?: number;
  auctionEndsAt?: string;
  bundle: boolean;
  url?: string;
  imageUrl?: string;
  listedAt?: string;
  sales?: CardSales;
  /** 精确同款里没确认的那几件：判定档位和差在哪（collector 的 SUSPECT_LABELS，和邮件同一口径）。 */
  tag?: string;
  note?: string;
  /** 同名折叠进来的其他卖家数和最低价。 */
  others: number;
  othersMin?: number;
  hidden?: boolean;
  watching?: boolean;
}

export interface CardSection {
  profileId: string;
  name: string;
  /** 这个 IP 这一小时的新货件数（拆卡前的总数）。 */
  total: number;
  items: CardItem[];
  imageKey?: string;
  failedSources: string[];
  /** 一个 IP 拆到多张卡时的「续」标记。 */
  continued?: boolean;
}

export interface DigestCardModel {
  id: string;
  batchAt: string;
  sections: CardSection[];
  /** 整批（所有卡）每个 IP 的件数，标题栏用。 */
  counts: Array<{ name: string; total: number }>;
  part?: { index: number; count: number };
  cheaper: number;
  nextRunAt?: string;
  sample?: boolean;
  textOnly?: boolean;
  /** 精确同款上新 / 商品变化：一条通知一张卡，标题栏换成「确认同款」「降价」，不放按钮。没有就是每小时日报卡。 */
  alert?: AlertInfo;
}

export interface AlertInfo {
  kind: "exact_match" | "listing_change";
  /** 精确同款：确认同款几件、疑似几件。 */
  confirmed?: number;
  suspects?: number;
  /** 商品变化：price_drop / price_rise / target_price / restock / sold_out，和价格。 */
  change?: { type: string; oldPrice?: number; newPrice?: number };
}

const CHANGE_LABELS: Record<string, string> = {
  price_drop: "降价",
  price_rise: "涨价",
  target_price: "到目标价",
  restock: "补货",
  sold_out: "卖掉了",
};

function alertTitle(alert: AlertInfo, name: string): string {
  if (alert.kind === "exact_match") return `${(alert.confirmed ?? 0) > 0 ? "确认同款" : "疑似同款"} · ${name}`;
  return `${CHANGE_LABELS[alert.change?.type ?? ""] ?? "商品有变化"} · ${name}`;
}

function alertDetail(alert: AlertInfo): string {
  if (alert.kind === "exact_match") {
    return [
      (alert.confirmed ?? 0) > 0 ? `确认同款 ${alert.confirmed} 件` : "",
      (alert.suspects ?? 0) > 0 ? `疑似 ${alert.suspects} 件（未确认）` : "",
    ].filter(Boolean).join(" · ");
  }
  const change = alert.change;
  if (!change || change.oldPrice === undefined || change.newPrice === undefined) return "";
  const diff = change.newPrice - change.oldPrice;
  const word = diff < 0 ? `降 ${yen(-diff)}` : diff > 0 ? `涨 ${yen(diff)}` : "价格没变";
  return `${yen(change.oldPrice)} → ${yen(change.newPrice)}（${word}）`;
}

function alertColor(alert: AlertInfo): string {
  if (alert.kind === "exact_match") return (alert.confirmed ?? 0) > 0 ? "green" : "yellow";
  const type = alert.change?.type;
  return type === "price_drop" || type === "target_price" ? "green" : type === "sold_out" ? "grey" : "blue";
}

/** 列表里的序号做成和九宫格图上一样的深色小块，一眼对得上（① 这种圈数字太小，10-13 用户看不清）。 */
function badge(n: number, muted = false): string {
  return `<text_tag color='${muted ? "neutral" : "indigo"}'>${n}</text_tag>`;
}

/** 卡片里用中文短名；日文全称（Yahoo!オークション）太长，挤掉标题。 */
const SHORT_SOURCE: Record<string, string> = {
  mercari_jp: "煤炉",
  yahoo_auctions_jp: "雅虎拍卖",
  yahoo_fleamarket_jp: "雅虎闲置",
  surugaya: "骏河屋",
  rakuten_ichiba: "乐天",
  rakuten_books: "乐天图书",
  amazon_jp: "亚马逊",
  yahoo_shopping: "雅虎购物",
  amiami: "AmiAmi",
  animate: "Animate",
  charaon: "CharaON",
  cospa: "COSPA",
  ebay: "eBay",
};

function sourceName(item: CardItem): string {
  return SHORT_SOURCE[item.sourceId] ?? item.sourceLabel;
}

export function shortProfileName(name: string): string {
  const afterBar = name.split(/[｜|]/u).pop() ?? name;
  return afterBar.replace(/上新$/u, "").trim() || name;
}

export function yen(price: number): string {
  return `¥${Math.round(price).toLocaleString("en-US")}`;
}

/** 日本时间 HH:MM；withDate 时带 M/D。 */
export function jst(iso: string | undefined, withDate = false): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const date = new Date(time + 9 * 3_600_000);
  const hm = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return withDate ? `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${hm}` : hm;
}

/** 飞书 markdown 的特殊字符要转成实体，否则商品标题里的 * _ ~ [ ] 会把排版搅乱。 */
function escapeMd(text: string): string {
  const map: Record<string, string> = {
    "<": "&#60;", ">": "&#62;", "*": "&#42;", "_": "&#95;", "~": "&#126;", "[": "&#91;", "]": "&#93;",
    "`": "&#96;", "#": "&#35;", "\\": "&#92;", "$": "&#36;",
  };
  return text.replace(/[<>*_~[\]`#\\$]/gu, (char) => map[char] ?? char);
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const plain = (content: string) => ({ tag: "plain_text", content });

function callbackButton(text: string, type: string, value: Record<string, unknown>) {
  return {
    tag: "button",
    text: plain(text),
    type,
    size: "small",
    width: "default",
    behaviors: [{ type: "callback", value }],
  };
}

function itemTags(item: CardItem): string[] {
  const tags: string[] = [];
  if (item.sales?.verdict === "cheaper") {
    tags.push(`<text_tag color='green'>比${item.sales.label}${item.sales.verdictText ?? "便宜"}</text_tag>`);
  }
  if (item.bundle) tags.push("<text_tag color='neutral'>套装</text_tag>");
  if (item.tag) tags.push(`<text_tag color='orange'>${escapeMd(item.tag)}</text_tag>`);
  return tags;
}

/** 和这一轮同一天（日本时间）只写时分，否则带月日。 */
function listedLabel(listedAt: string, batchAt: string): string {
  return jst(listedAt, true).split(" ")[0] === jst(batchAt, true).split(" ")[0] ? jst(listedAt) : jst(listedAt, true);
}

function itemMeta(item: CardItem, batchAt: string): string {
  const parts = [sourceName(item)];
  if (item.listedAt) parts.push(`${listedLabel(item.listedAt, batchAt)} 上架`);
  if (item.auction && item.bidCount !== undefined) parts.push(`出价 ${item.bidCount} 次`);
  if (item.auction && item.auctionEndsAt) parts.push(`${jst(item.auctionEndsAt, true)} 截止`);
  if (item.others > 0) parts.push(`另有 ${item.others} 家${item.othersMin !== undefined ? ` ${yen(item.othersMin)} 起` : ""}`);
  if (item.sales && item.sales.verdict !== "cheaper") {
    parts.push(`${item.sales.label} ${yen(item.sales.median)}（${item.sales.n} 件）`);
  }
  return parts.join(" · ");
}

function itemRow(model: DigestCardModel, sectionIndex: number, itemIndex: number, raw: CardItem, view: CardView) {
  const cardId = model.id;
  // 「不想看」「在盯降价」是运营者自己的状态，群里永远按原样显示。
  const item = view.audience === "owner" ? raw : { ...raw, hidden: false, watching: false };
  const title = escapeMd(truncate(item.title, 48));
  const left = item.hidden
    ? `${badge(item.n, true)} <font color='grey'>~~${title}~~</font>\n<font color='grey'>已标「不想看」，之后用来总结排除词</font>`
    : [
      `${badge(item.n)} ${title}`,
      `<font color='grey'>${escapeMd(itemMeta(item, model.batchAt))}</font>`,
      item.note ? `<font color='grey'>${escapeMd(truncate(item.note, 120))}</font>` : "",
      itemTags(item).join(" "),
    ].filter(Boolean).join("\n");
  const titleBlock = { tag: "markdown", content: left, text_size: "normal" };
  const leftElements = item.url && !item.hidden
    ? [{
      tag: "interactive_container",
      width: "fill",
      padding: "0px",
      behaviors: [{ type: "open_url", default_url: item.url, pc_url: "", ios_url: "", android_url: "" }],
      elements: [titleBlock],
    }]
    : [titleBlock];

  const price = item.price === null
    ? "<font color='grey'>价格未知</font>"
    : item.hidden ? `<font color='grey'>${yen(item.price)}</font>` : `**${yen(item.price)}**`;
  const right: unknown[] = [{ tag: "markdown", content: price, text_align: "right", text_size: "normal" }];
  // 按钮只放在每小时日报卡上：「不想看」写的是关键词日报的标注，精确同款和商品变化用不上。
  if (view.audience === "owner" && !model.alert && item.sourceItemId && item.digestEventId) {
    right.push(callbackButton(item.hidden ? "撤销" : "不想看", "default", { k: "hide", c: cardId, s: sectionIndex, i: itemIndex }));
  }
  if (view.audience === "owner" && !model.alert && item.sourceItemId && !item.auction && !item.hidden) {
    right.push(callbackButton(item.watching ? "在盯降价" : "等降价", item.watching ? "primary" : "default", { k: "watch", c: cardId, s: sectionIndex, i: itemIndex }));
  }
  return {
    tag: "column_set",
    horizontal_spacing: "12px",
    margin: "10px 0px 0px 0px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, vertical_align: "top", elements: leftElements },
      { tag: "column", width: "auto", vertical_align: "top", vertical_spacing: "6px", elements: right },
    ],
  };
}

export function digestCardSummary(model: DigestCardModel): string {
  if (model.alert) {
    const name = model.sections[0]?.name ?? "";
    return [alertTitle(model.alert, name), alertDetail(model.alert)].filter(Boolean).join("｜");
  }
  const counts = model.counts.map((entry) => `${entry.name} ${entry.total}`).join(" · ");
  return model.cheaper > 0 ? `${counts}｜${model.cheaper} 件低于行情` : counts;
}

/**
 * owner：自用私聊，应用发，带「不想看」「等降价」回调按钮。
 * group：群自定义机器人（webhook）发。webhook 卡片的按钮不能回传，所以不放按钮；
 *        images=false 就是纯标题版（只有标题、价格、来源，点标题跳商品页），一次额度都不花。
 */
export interface CardView {
  audience: "owner" | "group";
  images: boolean;
}

const OWNER_VIEW: CardView = { audience: "owner", images: true };

export function buildDigestCard(model: DigestCardModel, view: CardView = OWNER_VIEW): Record<string, unknown> {
  const total = model.counts.reduce((sum, entry) => sum + entry.total, 0);
  const alert = model.alert;
  const subtitle = alert
    ? [jst(model.batchAt, true), alertDetail(alert)].filter(Boolean).join(" · ")
    : [
      `${jst(model.batchAt, true)} 这一轮`,
      `共 ${total} 件`,
      model.part && model.part.count > 1 ? `第 ${model.part.index}/${model.part.count} 张` : "",
    ].filter(Boolean).join(" · ");
  const tags: unknown[] = [];
  if (model.sample) tags.push({ tag: "text_tag", text: plain("样卡"), color: "neutral" });
  if (model.cheaper > 0) tags.push({ tag: "text_tag", text: plain(`${model.cheaper} 件低于行情`), color: "green" });

  const elements: unknown[] = [];
  model.sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) elements.push({ tag: "hr", margin: "12px 0px 4px 0px" });
    // 精确同款 / 商品变化的卡只有一节，标题栏已经写了是哪个档案，这里不再重复。
    const heading = alert
      ? ""
      : section.continued
        ? `**${escapeMd(section.name)}** <font color='grey'>· 续</font>`
        : `**${escapeMd(section.name)}** <font color='grey'>· ${section.total} 件新货</font>`;
    if (heading) elements.push({ tag: "markdown", content: heading, text_size: "heading", margin: "4px 0px 0px 0px" });
    if (section.failedSources.length > 0 && !section.continued) {
      elements.push({
        tag: "markdown",
        content: `<font color='orange'>这一轮没抓到：${escapeMd(section.failedSources.join("、"))}（下一轮会再试）</font>`,
        text_size: "notation",
      });
    }
    if (view.images && section.imageKey) {
      elements.push({
        tag: "img",
        img_key: section.imageKey,
        alt: plain(`${section.name} 这一轮的商品图`),
        preview: true,
        transparent: true,
        // fit_horizontal：宽度撑满、高度按比例，不裁图。这时不能再带 size（飞书报 img size is not allowed，10-13 踩过）。
        scale_type: "fit_horizontal",
        margin: "8px 0px 2px 0px",
      });
    }
    section.items.forEach((item, itemIndex) => elements.push(itemRow(model, sectionIndex, itemIndex, item, view)));
  });

  const footer = [
    "点标题打开商品页",
    !view.images ? "" : model.textOnly ? "本月飞书额度快用完，暂时不配图" : "点图片可以放大",
    alert?.kind === "exact_match" && (alert.suspects ?? 0) > 0 ? "标了档位的几件还没确认是同款，灰字写着差在哪" : "",
    !alert && model.nextRunAt ? `下一轮约 ${jst(model.nextRunAt)}` : "",
  ].filter(Boolean).join(" · ");
  elements.push({ tag: "markdown", content: `<font color='grey'>${footer}</font>`, text_size: "notation", margin: "14px 0px 0px 0px" });

  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: true, summary: { content: digestCardSummary(model) } },
    header: {
      title: plain(alert ? alertTitle(alert, model.sections[0]?.name ?? "") : model.counts.map((entry) => `${entry.name} ${entry.total}`).join(" · ")),
      subtitle: plain(subtitle),
      template: alert ? alertColor(alert) : "blue",
      text_tag_list: tags,
      padding: "12px 12px 12px 12px",
    },
    body: { direction: "vertical", padding: "8px 12px 14px 12px", elements },
  };
}

/** 主站「推送」页「试发」那一下：群里收到这张就说明地址和签名对了。 */
export function buildGroupTestCard(name: string, profiles: string[] | null): Record<string, unknown> {
  const scope = profiles === null ? "全部 IP（以后新加的也收）" : profiles.length > 0 ? profiles.map(escapeMd).join("、") : "还没勾任何 IP，暂时什么都不会收到";
  return {
    schema: "2.0",
    config: { summary: { content: "雷达推送：试发" } },
    header: { title: plain(`雷达推送 · ${name}`), subtitle: plain("试发"), template: "turquoise" },
    body: { direction: "vertical", elements: [{ tag: "markdown", content: `这个群接上了。以后每小时有新货就发到这里，收：**${scope}**` }] },
  };
}

export interface StatusCardModel {
  enabled: boolean;
  welcome: boolean;
  quotaUsed: number;
  quotaLimit: number;
  imageStopAt: number;
  rounds: Array<{ name: string; finishedAt?: string; newItems?: number; nextRunAt?: string }>;
  groups: { on: number; total: number };
}

export function buildStatusCard(model: StatusCardModel): Record<string, unknown> {
  const lines: string[] = [];
  if (model.welcome) lines.push("以后每小时巡回有新货，就把这一小时 4 个 IP 的新货合成一张卡片发在这里。");
  lines.push(model.enabled ? "私聊推送：**开着**" : "私聊推送：**已暂停**（只停这里；群和 App 不受影响）");
  if (model.groups.total > 0) lines.push(`群：${model.groups.on} / ${model.groups.total} 个开着<font color='grey'>（在主站「推送」页管）</font>`);
  lines.push(`本月飞书调用：${model.quotaUsed.toLocaleString("en-US")} / ${model.quotaLimit.toLocaleString("en-US")} 次`
    + `<font color='grey'>（到 ${model.imageStopAt.toLocaleString("en-US")} 次自动改成只发文字）</font>`);
  const roundLines = model.rounds.map((round) => {
    const parts = [`**${escapeMd(round.name)}**`];
    parts.push(round.finishedAt ? `${jst(round.finishedAt)} 跑完` : "最近没有巡回记录");
    if (round.newItems !== undefined) parts.push(`${round.newItems} 件新货`);
    if (round.nextRunAt) parts.push(`下一轮 ${jst(round.nextRunAt)}`);
    return parts.join(" · ");
  });
  const elements: unknown[] = [{ tag: "markdown", content: lines.join("\n") }];
  if (roundLines.length > 0) {
    elements.push({ tag: "hr", margin: "8px 0px 8px 0px" });
    elements.push({ tag: "markdown", content: roundLines.join("\n") });
  }
  elements.push({
    tag: "column_set",
    horizontal_spacing: "8px",
    margin: "12px 0px 0px 0px",
    columns: [
      { tag: "column", width: "auto", elements: [callbackButton(model.enabled ? "暂停私聊" : "恢复私聊", model.enabled ? "default" : "primary_filled", { k: "toggle" })] },
      { tag: "column", width: "auto", elements: [callbackButton("发一张样卡", "default", { k: "sample" })] },
    ],
  });
  elements.push({
    tag: "markdown",
    content: "<font color='grey'>随时给我发「状态」看这张卡，「暂停」「恢复」开关私聊推送。</font>",
    text_size: "notation",
    margin: "10px 0px 0px 0px",
  });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: model.enabled ? "雷达推送：私聊开着" : "雷达推送：私聊已暂停" } },
    header: { title: plain("雷达推送"), subtitle: plain("每小时新货 · 自用"), template: model.enabled ? "turquoise" : "grey" },
    body: { direction: "vertical", elements },
  };
}
