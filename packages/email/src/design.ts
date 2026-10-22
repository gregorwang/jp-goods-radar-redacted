/**
 * 邮件的设计语言：
 * 白底 + 发丝线，宋体标题，数字用 Cormorant，墨色胶囊主按钮 + 下划线次按钮，
 * 天蓝只做点缀（上架时间、品牌点），荧光笔底色标「便宜」，橙红只给「贵了」和「拍卖」。
 *
 * 邮件客户端的限制决定了写法：全部内联样式 + 表格布局；Gmail / QQ 邮箱不加载网络字体，
 * 所以字体栈都要有系统字体兜底。最显眼的头图（功能名 + 半模糊大字 + 树叶光影）
 * 做成图片，任何客户端里都一样，见 MAIL_HEADERS。
 */

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);

export const INK = "#111111";
export const INK2 = "#4a4a4a";
export const MUTE = "#6b6b6b";
export const LINE = "#e6e6e6";
export const LINE_SOFT = "#efefef";
export const MIST = "#f4f6f7";
export const SKY = "#45bfe8";
export const SKY_TEXT = "#1a7ca3";
export const MARKER = "#f1ea8c";
export const LEMON = "#e8e15d";
export const ALERT = "#c24e1c";
export const ALERT_TEXT = "#a8431a";

export const SERIF = "'Noto Serif SC','Songti SC','STSong','SimSun',serif";
export const SANS = "'Noto Sans SC','PingFang SC','Microsoft YaHei',Arial,sans-serif";
/** 价格和统计数字。Cormorant 只在支持网络字体的客户端（苹果邮件等）生效，其余退到 Georgia。 */
export const NUM = "'Cormorant Garamond',Georgia,'Times New Roman',serif";

/**
 * 头图静态资源：放在主站 apps/web/public/art/mail，随 push 自动部署。
 */
export type MailAudience = "owner";
const ASSET_BASES: Record<MailAudience, string> = {
  owner: "https://eru.example.com/art/mail",
};

/**
 * 头图文案。图片由 scripts/mail-headers/render.mjs 渲染（文案与这里一一对应），
 * 改字要重新出图并把文件名里的版本号 +1，旧邮件里的图才不会跟着变。
 * alt 写全功能名和那句说明：图片被拦截时读者照样知道这是哪个功能的信。
 */
export const MAIL_HEADERS = {
  "keyword-digest": "关键词巡回：按你设的关键词，汇总今天各平台新上架的商品，并附上成交价参考",
  "keyword-new": "关键词上新：你关注的关键词有新商品上架",
  receipt: "建档完成：已记下各平台目前在售的商品，从明天起只发新上架的",
  exact: "精确同款雷达：你指定的那一件出现了，已核对是同一款",
  "exact-image-hold": "精确同款雷达：这几件标题对上了，但商品图和参考图不同，下单前先看图",
  "exact-suspect": "精确同款雷达：有几件很接近但还不能确认，每件下面写明了差在哪",
  weekly: "精确同款周报：本周所有档案的新同款、降价和到价情况",
  item: "商品雷达：你在盯的商品有了新变化：降价、补货或到达目标价",
  confirm: "确认邮箱：点下面的按钮完成订阅，之后每晚收到一封关键词巡回日报",
  "confirm-intake": "确认邮箱：确认后登记才算提交，结果也会寄到这个邮箱",
  login: "登录：点下面的按钮登录，链接 30 分钟内有效",
  "intake-find": "找货结果：你登记的那件，我们找到的在售和已售记录都在下面",
  "intake-bootleg": "盗版查询结果：你登记的那件，我们查到的结果都在下面",
  "intake-price": "行情分析结果：你登记的那件，近期的在售和成交价格都在下面",
} as const;
export type MailHeader = keyof typeof MAIL_HEADERS;
const HEADER_VERSION = "v1";

/** 页脚插入点：需要在页脚追加内容时插在这个标记前面。 */
export const FOOTER_MARKER = "<!--jpgr:footer-->";

export interface ShellOptions {
  /** 没有头图时显示在品牌右侧的小标题；有头图时只用于纯文本兜底。 */
  eyebrow: string;
  title: string;
  subtitle?: string;
  content: string;
  preview?: string;
  footerNote?: string;
  header?: MailHeader;
  audience?: MailAudience;
}

function brandRow(eyebrow: string): string {
  return `<tr><td style="padding:26px 40px;border-bottom:1px solid ${LINE}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>`
    + `<td valign="middle" style="font-family:${SERIF};font-size:16px;line-height:22px;letter-spacing:.14em;color:${INK}"><span style="display:inline-block;width:6px;height:6px;margin:0 10px 3px 0;border-radius:50%;background:${SKY};vertical-align:middle"></span>格银西里尔</td>`
    + `<td align="right" valign="middle" style="font-family:${SERIF};font-size:12px;line-height:18px;letter-spacing:.16em;color:${INK2}">${escapeHtml(eyebrow)}</td>`
    + `</tr></table></td></tr>`;
}

function headerImage(header: MailHeader, audience: MailAudience): string {
  const src = `${ASSET_BASES[audience]}/header-${header}-${HEADER_VERSION}.png`;
  return `<tr><td style="padding:0;border-bottom:1px solid ${LINE}"><img src="${src}" width="640" alt="${escapeHtml(`格银西里尔 · ${MAIL_HEADERS[header]}`)}" style="display:block;width:100%;max-width:640px;height:auto;border:0;font-family:${SERIF};font-size:16px;line-height:24px;color:${INK}"></td></tr>`;
}

export function emailShell(options: ShellOptions): string {
  const audience = options.audience ?? "owner";
  const footerNote = options.footerNote ?? "你收到这封邮件，是因为你在格银西里尔关注的商品有了变化。";
  const fonts = ASSET_BASES[audience];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`
    + `<style>@font-face{font-family:'Cormorant Garamond';font-weight:400;src:url(${fonts}/cormorant-garamond-latin.woff2) format('woff2')}@font-face{font-family:'Jost';font-weight:300;src:url(${fonts}/jost-latin.woff2) format('woff2')}</style></head>`
    + `<body style="margin:0;padding:0;background:#ffffff;color:${INK};font-family:${SANS};-webkit-text-size-adjust:100%">`
    + `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${escapeHtml(options.preview ?? options.title)}</span>`
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;background:#ffffff"><tr><td align="center">`
    + `<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:640px;background:#ffffff">`
    + (options.header ? headerImage(options.header, audience) : brandRow(options.eyebrow))
    // 标题留空 = 头图已经把这封信是什么说清了（确认邮箱、登录），正文直接开始。
    + (options.title ? `<tr><td style="padding:34px 40px 0;text-align:left"><h1 style="margin:0;font-family:${SERIF};font-size:28px;line-height:40px;font-weight:400;letter-spacing:.08em;color:${INK}">${escapeHtml(options.title)}</h1>`
      + (options.subtitle ? `<p style="margin:10px 0 0;font-size:13px;line-height:22px;letter-spacing:.06em;color:${INK2}">${escapeHtml(options.subtitle)}</p>` : "")
      + `</td></tr>` : "")
    + `<tr><td style="padding:${options.title ? 24 : 32}px 40px 40px;text-align:left;font-size:14px;line-height:24px;color:${INK}">${options.content}</td></tr>`
    + FOOTER_MARKER
    + `<tr><td style="padding:26px 40px 36px;border-top:1px solid ${LINE};text-align:left"><p style="margin:0;font-family:${SERIF};font-size:14px;line-height:22px;letter-spacing:.14em;color:${INK}">格银西里尔</p><p style="margin:8px 0 0;font-size:12px;line-height:20px;letter-spacing:.04em;color:${MUTE}">${escapeHtml(footerNote)}</p></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

/** 墨色胶囊主按钮。 */
export function inkButton(url: string | undefined, label: string, margin = "28px 0 0"): string {
  if (!url) return "";
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:${margin}"><tr><td bgcolor="${INK}" style="border-radius:999px;background:${INK}"><a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 32px;color:#ffffff;font-family:${SANS};font-size:14px;line-height:22px;letter-spacing:.16em;text-decoration:none">${escapeHtml(label)} →</a></td></tr></table>`;
}

/** 下划线次按钮 / 正文链接。 */
export function lineLink(url: string, label: string, color = INK): string {
  return `<a href="${escapeHtml(url)}" style="color:${color};text-decoration:none;border-bottom:1px solid ${color === INK ? INK : color}">${escapeHtml(label)}</a>`;
}

/** 发丝线圆角小签：来源、判定档位。 */
export function pill(label: string, muted = false): string {
  return `<span style="display:inline-block;padding:0 9px;border:1px solid ${muted ? LINE : "#cfcfcf"};border-radius:999px;font-size:11px;line-height:20px;letter-spacing:.08em;color:${muted ? MUTE : INK2};white-space:nowrap">${escapeHtml(label)}</span>`;
}

/** 方角标签：警惕（拍卖、占位价）/ 打包 / 商品性质。 */
export function tag(label: string, tone: "alert" | "bundle" | "kind"): string {
  const colors = tone === "alert"
    ? `border:1px solid ${ALERT};color:${ALERT_TEXT};background:#ffffff`
    : tone === "bundle"
      ? `border:1px solid ${LEMON};color:#6b6420;background:#fdfbe4`
      : `border:1px solid #cdebf6;color:${SKY_TEXT};background:#eef5f8`;
  return `<span style="display:inline-block;margin:0 6px 0 0;padding:0 7px;${colors};font-size:11px;line-height:19px;letter-spacing:.1em;vertical-align:middle;white-space:nowrap">${escapeHtml(label)}</span>`;
}

/** 荧光笔底色：只用来标「比参考价便宜」这种好消息。 */
export function marker(text: string): string {
  return `<span style="background:${MARKER};color:${INK}">${escapeHtml(text)}</span>`;
}

/** 大号价格：数字用 Cormorant，「円」用正文字体。 */
export function priceHtml(value: number | null | undefined, size = 30, color = INK): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `<span style="font-size:14px;color:${MUTE}">价格未取得</span>`;
  }
  return `<span style="font-family:${NUM};font-size:${size}px;line-height:1;font-variant-numeric:lining-nums;color:${color};vertical-align:baseline">${Math.round(value).toLocaleString("ja-JP")}</span><span style="font-size:13px;color:${INK2}"> 円</span>`;
}

/** 一行状态说明：圆点 + 文字，上下发丝线。warn = 柠檬黄，info = 天蓝，error = 橙红。 */
export function noteRow(html: string, tone: "warn" | "info" | "error" = "warn"): string {
  const dot = tone === "warn" ? LEMON : tone === "info" ? SKY : ALERT;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 -1px;border-collapse:collapse"><tr><td width="18" valign="top" style="padding:16px 0 14px;border-top:1px solid ${LINE_SOFT};border-bottom:1px solid ${LINE_SOFT}"><span style="display:inline-block;width:7px;height:7px;margin-top:7px;border-radius:50%;background:${dot}"></span></td><td valign="top" style="padding:12px 0 12px;border-top:1px solid ${LINE_SOFT};border-bottom:1px solid ${LINE_SOFT};font-size:12px;line-height:21px;letter-spacing:.04em;color:${INK2}">${html}</td></tr></table>`;
}

/** 分节标题：小字标签 + 宋体标题 + 右侧说明，下面一条墨线。 */
export function sectionHead(label: string, title: string, side = "", margin = "36px 0 0"): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:${margin};border-collapse:collapse"><tr><td valign="bottom" style="padding:0 0 14px;border-bottom:1px solid ${INK}"><p style="margin:0;font-size:11px;line-height:16px;letter-spacing:.2em;color:${MUTE}">${escapeHtml(label)}</p><p style="margin:6px 0 0;font-family:${SERIF};font-size:20px;line-height:28px;letter-spacing:.1em;color:${INK}">${escapeHtml(title)}</p></td>${side ? `<td align="right" valign="bottom" style="padding:0 0 16px;border-bottom:1px solid ${INK};font-size:12px;line-height:18px;letter-spacing:.06em;color:${MUTE};white-space:nowrap">${escapeHtml(side)}</td>` : ""}</tr></table>`;
}

/** 一排大数字（首次发现 / 恢复识别 / 建档存量）。 */
export function statRow(stats: Array<{ value: number; label: string; unit?: string }>): string {
  const cells = stats.map((stat, index) => `<td valign="bottom" style="padding:0 ${index === stats.length - 1 ? 0 : 24}px 0 ${index === 0 ? 0 : 24}px;${index === 0 ? "" : "border-left:1px solid #d6d6d6;"}"><p style="margin:0;font-family:${NUM};font-size:44px;line-height:44px;font-variant-numeric:lining-nums;color:${INK}">${stat.value}${stat.unit ? `<span style="font-family:${SANS};font-size:14px;color:${MUTE}"> ${escapeHtml(stat.unit)}</span>` : ""}</p><p style="margin:6px 0 0;font-size:12px;line-height:18px;letter-spacing:.1em;color:${INK2};white-space:nowrap">${escapeHtml(stat.label)}</p></td>`).join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse"><tr>${cells}</tr></table>`;
}

/**
 * 在一封已经排好的运营者邮件最上面加一条柠檬色提示（头图上方），纯文本版也加在第一行。
 * 用于「这个档案只开了飞书，飞书没送到，所以改发邮件」（apps/collector/src/push-delivery.ts）。
 * 找不到外壳（不是 emailShell 排的）就只改纯文本。
 */
export function withTopNotice<T extends { html: string; text: string }>(mail: T, notice: string): T {
  const anchor = "max-width:640px;background:#ffffff\">";
  const at = mail.html.indexOf(anchor);
  const row = `<tr><td style="padding:12px 40px;background:#fdfbe4;border-bottom:1px solid ${LEMON};font-family:${SANS};font-size:13px;line-height:21px;color:#6b6420">${escapeHtml(notice)}</td></tr>`;
  return {
    ...mail,
    html: at < 0 ? mail.html : `${mail.html.slice(0, at + anchor.length)}${row}${mail.html.slice(at + anchor.length)}`,
    text: `${notice}\n\n${mail.text}`,
  };
}
