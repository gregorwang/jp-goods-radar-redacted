import { keywordRuleText, keywordRuleTextMatches } from "./search.js";

/**
 * 关键词档案的「屏蔽单品」。
 *
 * 景品、一番赏这类出货量巨大的商品，二手市场上每天都有新卖家挂出来；日报按链接去重，
 * 换个卖家就是新链接，于是同一件商品天天进邮件（2026-10-09：赛车初音一封 179 件里，
 * SPA 2025 景品手办一款就占了约 30 件）。
 *
 * 排除词治不了：同一件商品的标题写法有七八种，任一词命中就挡又会误伤别的商品。
 * 这里换成"几个词同时出现才算这件商品"：一条屏蔽 = 若干词组，每组都要在标题里命中，
 * 组内用 `|` 写别名（`ムチュート|Muchute`）。词由用户在后台从标题里点选，页面上先预演
 * 过去 30 天会挡掉哪些商品再保存——判断"是不是这件"是确定性的字面比对，代码做得对；
 * 词选得宽不宽，只有用户自己知道，所以由人点、由预演兜底（AGENTS.md §4）。
 *
 * 只比对标题：排除词会连店名、卖家名一起比，屏蔽单品如果也这样，一家店名里带「SPA」的
 * 店会被整店挡掉（docs/进行中/AI判定兜底与关键词硬规则-待办-20261008.md 第三节第 6 条）。
 */

export interface MutedProductRule {
  id: string;
  /** 每组都必须命中；组内 `|` 分隔别名。 */
  termGroups: readonly string[];
}

export const MUTED_PRODUCT_MAX_GROUPS = 6;
export const MUTED_PRODUCT_GROUP_MAX_LENGTH = 100;
/** 每个档案最多屏蔽多少件商品。到这个量级说明该收窄关键词本身了。 */
export const MUTED_PRODUCT_LIMIT_PER_PROFILE = 100;

function alternatives(group: string): string[] {
  return group.split(/[|｜]/).map((term) => term.trim()).filter(Boolean);
}

/** 存库前统一整理：去空白、去空组、去重，超长的组和超出上限的组直接丢掉。 */
export function normalizeMutedProductTermGroups(groups: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    const normalized = alternatives(group).join("|");
    if (!normalized || normalized.length > MUTED_PRODUCT_GROUP_MAX_LENGTH) continue;
    const key = normalized.normalize("NFKC").toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.slice(0, MUTED_PRODUCT_MAX_GROUPS);
}

export function mutedProductTitleMatches(title: string, termGroups: readonly string[]): boolean {
  if (termGroups.length === 0) return false;
  const text = keywordRuleText(title);
  return termGroups.every((group) => alternatives(group).some((term) => keywordRuleTextMatches(text, term)));
}

export function matchingMutedProduct<T extends MutedProductRule>(title: string, rules: readonly T[]): T | undefined {
  return rules.find((rule) => mutedProductTitleMatches(title, rule.termGroups));
}

/** 给人看的名字：`SPA + 2025`。 */
export function mutedProductLabel(termGroups: readonly string[]): string {
  return termGroups.map((group) => alternatives(group).join(" / ")).join(" + ");
}

export function parseMutedProductTermGroups(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const TITLE_SEPARATORS = /[\s【】[\]「」『』（）()〈〉《》<>/／|｜,，、。!！?？★☆♪#＃"'“”‘’〔〕≪≫◆◇■□●○※&＆=＝;；]+/u;
const TITLE_TOKEN_EDGE = /^[:：・･.\-‐~～*＊_+＋]+|[:：・･.\-‐~～*＊_+＋]+$/gu;
const MAX_TITLE_TOKEN_LENGTH = 30;

/**
 * 后台点选用的标题切词。和补词建议的切词不同，这里**保留**年份和短英文（`2025`、`SPA`）：
 * 区分同一系列不同年份的商品，靠的恰恰是这些。数字和文字粘在一起的（`2025Ver.`、
 * `レーシングミク2025`）拆开，免得点了「2025Ver.」却挡不住只写「2025」的标题。
 * `ignore` 里的词（档案的关键词本身）每件商品都有，点了等于屏蔽全部，不列出来。
 */
export function mutedProductTitleTokens(title: string, ignore: readonly string[] = []): string[] {
  const ignored = new Set(ignore.flatMap(alternatives).map((term) => keywordRuleText(term).compact));
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const piece of title.normalize("NFKC").split(TITLE_SEPARATORS)) {
    for (const part of piece.match(/\d+|\D+/gu) ?? []) {
      const token = part.replace(TITLE_TOKEN_EDGE, "");
      const length = Array.from(token).length;
      if (length < 2 || length > MAX_TITLE_TOKEN_LENGTH) continue;
      const compact = keywordRuleText(token).compact;
      if (compact.length < 2 || ignored.has(compact) || seen.has(compact)) continue;
      seen.add(compact);
      tokens.push(token);
    }
  }
  return tokens;
}
