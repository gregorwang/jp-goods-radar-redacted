import type { SourceId } from "@jpgr/core";

/**
 * 精确同款雷达的“配置单”：把一份 JSON 翻译成建档表单的各个字段。
 * 只负责填表，不直接建档——用户填完仍要看一眼再点“建立”。
 * 表单里没有对应能力的字段不会静默吞掉，而是放进 ignored 让用户知道。
 */
export interface ExactProductConfigFill {
  query: string;
  recallQueries: string;
  requiredGroups: string;
  supportingGroups: string;
  excludedTerms: string;
  targetPrice: string;
  strongReminder: boolean;
  intervalMinutes?: string;
  sources?: SourceId[];
  ignored: string[];
}

const SOURCE_ALIASES: Record<string, SourceId> = {
  mercari: "mercari_jp",
  mercari_jp: "mercari_jp",
  yahoo_fleamarket: "yahoo_fleamarket_jp",
  yahoo_fleamarket_jp: "yahoo_fleamarket_jp",
  paypay_fleamarket: "yahoo_fleamarket_jp",
  yahoo_auction: "yahoo_auctions_jp",
  yahoo_auctions: "yahoo_auctions_jp",
  yahoo_auctions_jp: "yahoo_auctions_jp",
  yahoo_shopping: "yahoo_shopping",
  surugaya: "surugaya",
  amiami: "amiami",
  amazon: "amazon_jp",
  amazon_jp: "amazon_jp",
  rakuten: "rakuten_ichiba",
  rakuten_ichiba: "rakuten_ichiba",
  animate: "animate",
  cospa: "cospa",
  charaon: "charaon",
  ebay: "ebay",
};

export const SECONDHAND_SOURCES: readonly SourceId[] = [
  "amiami",
  "yahoo_auctions_jp",
  "yahoo_fleamarket_jp",
  "mercari_jp",
  "surugaya",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

/** [["小木曽雪菜","雪菜"],["ぬいぐるみ"]] → "小木曽雪菜|雪菜, ぬいぐるみ" */
export function groups(value: unknown): string {
  if (!Array.isArray(value)) return strings(value).join(", ");
  return value
    .map((group) => strings(group).map((term) => term.replace(/[|,，、]/g, " ").trim()).filter(Boolean).join("|"))
    .filter(Boolean)
    .join(", ");
}

/** 配置单文本 → 最外层对象；格式不对直接报给用户。 */
export function parseConfigJson(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("配置单不是有效的 JSON，请检查括号、逗号和引号。");
  }
  if (!isRecord(raw)) throw new Error("配置单最外层必须是 { … } 对象。");
  return raw;
}

/** cadence.minutes → 表单里的频率选项；不在选项里的记入 ignored。 */
export function parseConfigCadence(
  raw: Record<string, unknown>,
  availableIntervals: readonly string[],
  ignored: string[],
): string | undefined {
  const cadence = isRecord(raw.cadence) ? raw.cadence : undefined;
  if (!cadence) return undefined;
  const minutes = String(cadence.minutes ?? "");
  if (availableIntervals.includes(minutes)) return minutes;
  ignored.push(`cadence.minutes「${minutes}」：只支持 ${availableIntervals.join("/")} 分钟`);
  return undefined;
}

/** sources.enabled / sources.mode → 来源 ID；没接入的来源记入 ignored。 */
export function parseConfigSources(raw: Record<string, unknown>, ignored: string[]): SourceId[] | undefined {
  const sourceConfig = isRecord(raw.sources) ? raw.sources : undefined;
  if (!sourceConfig) return undefined;
  let sources: SourceId[] | undefined;
  const enabled = strings(sourceConfig.enabled);
  if (enabled.length) {
    const mapped = new Set<SourceId>();
    for (const name of enabled) {
      const id = SOURCE_ALIASES[name.toLowerCase()];
      if (id) mapped.add(id);
      else ignored.push(`sources.enabled「${name}」：暂未接入这个来源`);
    }
    sources = [...mapped];
  } else if (sourceConfig.mode === "secondhand_priority") {
    sources = [...SECONDHAND_SOURCES];
  }
  if (enabled.length && sourceConfig.mode !== undefined) ignored.push("sources.mode：已按 enabled 列表选择来源");
  return sources;
}

export function parseExactProductConfig(
  text: string,
  availableIntervals: readonly string[],
): ExactProductConfigFill {
  const raw = parseConfigJson(text);
  const ignored: string[] = [];
  const query = strings(raw.canonical_name)[0] ?? strings(raw.name)[0] ?? "";
  if (!query) throw new Error("配置单缺少 canonical_name 或 name（完整日文商品名）。");

  const titleQueries = strings(raw.title_queries);
  if (titleQueries.length > 4) ignored.push(`title_queries 只取前 4 条（多出 ${titleQueries.length - 4} 条）`);

  if (raw.purpose !== undefined && raw.purpose !== "exact_item_and_target_price") {
    ignored.push(`purpose「${String(raw.purpose)}」：精确同款雷达只有一种用途`);
  }

  const price = isRecord(raw.price) ? raw.price : {};
  const target = typeof price.target === "number" && Number.isFinite(price.target) && price.target > 0
    ? String(Math.round(price.target))
    : "";
  if (price.currency !== undefined && price.currency !== "JPY") ignored.push(`price.currency「${String(price.currency)}」：目标价只按日元计算`);
  const strongReminder = price.strong_alert === true && target !== "";
  if (price.strong_alert === true && !target) ignored.push("price.strong_alert：没有目标价时无法开启强提醒");
  if (price.secondary_alert_max !== undefined) ignored.push("price.secondary_alert_max：暂不支持第二档价格提醒");

  const intervalMinutes = parseConfigCadence(raw, availableIntervals, ignored);
  const sources = parseConfigSources(raw, ignored);

  if (raw.matching !== undefined) ignored.push("matching：同款判定规则由系统固定，不能逐项开关");

  return {
    query: query.slice(0, 200),
    recallQueries: titleQueries.slice(0, 4).join("\n"),
    requiredGroups: groups(raw.identity_groups),
    supportingGroups: groups(raw.evidence_groups),
    excludedTerms: groups(raw.exclude_terms),
    targetPrice: target,
    strongReminder,
    ...(intervalMinutes ? { intervalMinutes } : {}),
    ...(sources ? { sources } : {}),
    ignored,
  };
}

/** 给外部 AI 用的提示词：让它按本表单能识别的格式输出配置单。 */
export const EXACT_PRODUCT_CONFIG_PROMPT = `请帮我为日本二手/零售平台的“精确同款雷达”写一份配置单。我会告诉你想买的具体商品（最好附商品页链接或官方商品名）。

只输出一段 JSON，不要任何解释，不要 Markdown 代码块。格式如下：
{
  "canonical_name": "官方完整日文商品名，只写我要的那一件；套装里的单个角色不要把其他角色写进来",
  "title_queries": ["卖家可能用的短标题搜索词，日文，最多 4 条，每条 2~4 个词"],
  "identity_groups": [["必须出现的身份词", "它的别名/简写"], ["品类词", "品类简写"]],
  "evidence_groups": [["作品名", "作品英文名", "作品简称"], ["厂商名", "厂商片假名"]],
  "exclude_terms": ["同作品但不是这件商品的品类或版本，例如 フィギュア、アクリル、缶バッジ"],
  "price": { "currency": "JPY", "target": 目标价数字, "strong_alert": true或false },
  "cadence": { "minutes": 60 },
  "sources": { "enabled": ["mercari", "yahoo_fleamarket", "yahoo_auction", "surugaya"] }
}

规则：
1. identity_groups 是“每一组都必须命中”，只放能锁定这件商品的词（角色 + 品类/型号），组数越少越不容易漏；同一组里放同义写法。
2. evidence_groups 是“命中任一组就加分”，放作品名、厂商、系列名等辅助信息。
3. exclude_terms 放容易混进来的其他商品，不要放 identity_groups 里的词。
4. cadence.minutes 只能是 30、60、180、240、360、720、1440 之一。
5. sources.enabled 只能从这些里选：mercari、yahoo_fleamarket、yahoo_auction、yahoo_shopping、surugaya、amiami、amazon、rakuten、animate、cospa、charaon、ebay。
6. 我没说目标价就删掉 price；strong_alert 为 true 时必须有 target。
7. 所有词用商品在日本平台上实际出现的写法（日文/片假名/英文），不要写中文。

我要监控的商品是：`;
