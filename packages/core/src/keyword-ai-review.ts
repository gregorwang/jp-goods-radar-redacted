import {
  keywordRuleTermAlternatives,
  keywordRuleText,
  keywordRuleTextMatches,
  type KeywordRuleText,
} from "./search.js";

/**
 * 关键词档案的 AI 复核：用 AI 已经下过的结论反过来做两件事。
 *
 *  1. 补词：AI 反复拒掉、且从没出现在任何已确认商品里的词，建议加进排除词。
 *     有把握的事交给硬规则做，AI 只管真正模糊的那部分（AGENTS.md §4）。
 *  2. 抽查：AI 没放行、但标题里带着"这个档案独有的词"（作品名、同作品角色名）的商品，
 *     是最可能被误杀的那一小撮，挑出来给人看一眼。
 *
 * 两件事用的是同一份词频：只出现在被拒商品里的词是补词候选，
 * 几乎只出现在已确认商品里的词是误杀信号。
 *
 * 这里不调用模型，也不做任何"自动加词"：排除词一旦加错，真品会在硬规则那一层
 * 被无声挡掉，连 AI 都轮不到看，所以每一个词都由人点。
 */

export type KeywordAiRelevance = "relevant" | "irrelevant" | "uncertain";

/**
 * AI 放弃判定、采集侧按关键词规则放行时写进观察记录的判定理由（ai_relevance 为空）。
 * 复核页靠这句原文把这批商品认出来，两边必须用同一个常量。
 */
export const KEYWORD_RULE_FALLBACK_REASON = "AI 没能判定，已按关键词规则放行（未经 AI 复核）";

export interface KeywordAiReviewItem {
  key: string;
  title: string;
  /** 和硬规则匹配时看到的一样：标题 + 描述摘要 + 店名 + 卖家名。 */
  text: string;
  aiRelevance: KeywordAiRelevance;
}

export interface KeywordExclusionSuggestion {
  term: string;
  /** 近期 AI 拒掉、而当前排除词还拦不住的商品里，有多少件含这个词。 */
  blockedCount: number;
  exampleKeys: string[];
}

export interface KeywordSeriesSignal {
  term: string;
  /** 近期已确认商品里有多少件的标题含这个词。 */
  confirmedCount: number;
}

const TOKEN_SEPARATORS = /[\s【】[\]「」『』（）()〈〉《》<>/／|｜,，、。!！?？★☆♪#＃"'“”‘’〔〕≪≫]+/u;
const TOKEN_EDGE = /^[:：・･.\-‐~～*＊_+＋]+|[:：・･.\-‐~～*＊_+＋]+$/gu;
const NUMERIC_TOKEN = /^[\d.,%円~～\-]+$/u;
const ASCII_TOKEN = /^[\x00-\x7f]+$/;
const MAX_TOKEN_LENGTH = 24;

const SUGGESTION_MIN_BLOCKED = 3;
const SUGGESTION_LIMIT = 20;
const SIGNAL_MIN_CONFIRMED = 8;
const SIGNAL_MIN_PRECISION = 0.95;
const SIGNAL_MAX_OTHER_PROFILE_HITS = 2;

/**
 * 标题切词。日文标题没有分词，但卖家习惯用空格和括号隔开品牌、作品、角色、品类，
 * 按这些分隔符切出来的片段就是能直接拿去当排除词的那种"词"。
 * 纯 ASCII 的短片段（ver.、long、1/7）几乎全是通用词，直接丢掉。
 */
export function keywordTitleTokens(title: string): string[] {
  const tokens = keywordRuleText(title).searchable
    .split(TOKEN_SEPARATORS)
    .map((token) => token.replace(TOKEN_EDGE, ""))
    .filter((token) => {
      const length = Array.from(token).length;
      if (length < 2 || length > MAX_TOKEN_LENGTH) return false;
      if (NUMERIC_TOKEN.test(token)) return false;
      return !ASCII_TOKEN.test(token) || token.length >= 5;
    });
  return [...new Set(tokens)];
}

function documentFrequency(titles: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const token of keywordTitleTokens(title)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function anyMatches(texts: readonly KeywordRuleText[], term: string): boolean {
  return texts.some((text) => keywordRuleTextMatches(text, term));
}

function countMatches(texts: readonly KeywordRuleText[], term: string): number {
  let count = 0;
  for (const text of texts) if (keywordRuleTextMatches(text, term)) count += 1;
  return count;
}

/**
 * 补词建议。一个词要同时满足：
 *  - 近期至少 3 件 AI 拒掉、当前排除词又拦不住的商品含它；
 *  - 这个档案任何一件已确认商品（AI 最近一次判为相关的 + 用户在复核页改判为相关的）都不含它；
 *  - 其他档案的已确认商品也不含它——"送料無料""単行本"这种通用词就是在这一步被挡掉的，
 *    它们今天没误伤，不等于以后的真品标题里不会出现。
 * 然后按"新多拦几件"贪心挑，同一个品牌的几种写法只要拦的是不同商品就都留着。
 */
export function suggestKeywordExclusionTerms(input: {
  excludeTerms: readonly string[];
  judged: readonly KeywordAiReviewItem[];
  confirmedTexts: readonly string[];
  otherProfileTexts: readonly string[];
}): KeywordExclusionSuggestion[] {
  const excludeAlternatives = keywordRuleTermAlternatives(input.excludeTerms, true);
  const rejected = input.judged
    .filter((item) => item.aiRelevance === "irrelevant")
    .map((item) => ({ item, text: keywordRuleText(item.text) }))
    .filter(({ text }) => !excludeAlternatives.some((term) => keywordRuleTextMatches(text, term)));
  if (rejected.length < SUGGESTION_MIN_BLOCKED) return [];

  const ownConfirmed = [
    ...input.judged.filter((item) => item.aiRelevance === "relevant").map((item) => item.text),
    ...input.confirmedTexts,
  ].map(keywordRuleText);
  const others = input.otherProfileTexts.map(keywordRuleText);

  const candidates: { term: string; hits: Set<string> }[] = [];
  for (const [term, frequency] of documentFrequency(rejected.map(({ item }) => item.title))) {
    if (frequency < 2) continue;
    const hits = new Set(rejected
      .filter(({ text }) => keywordRuleTextMatches(text, term))
      .map(({ item }) => item.key));
    if (hits.size < SUGGESTION_MIN_BLOCKED) continue;
    if (anyMatches(ownConfirmed, term) || anyMatches(others, term)) continue;
    candidates.push({ term, hits });
  }

  const covered = new Set<string>();
  const picked: KeywordExclusionSuggestion[] = [];
  while (picked.length < SUGGESTION_LIMIT) {
    let best: (typeof candidates)[number] | undefined;
    let bestGain = 0;
    for (const candidate of candidates) {
      let gain = 0;
      for (const key of candidate.hits) if (!covered.has(key)) gain += 1;
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (!best || bestGain < SUGGESTION_MIN_BLOCKED) break;
    picked.push({
      term: best.term,
      blockedCount: best.hits.size,
      exampleKeys: [...best.hits].filter((key) => !covered.has(key)).slice(0, 3),
    });
    for (const key of best.hits) covered.add(key);
    candidates.splice(candidates.indexOf(best), 1);
  }
  return picked;
}

/**
 * 这个档案独有的词：近期已确认商品里频繁出现（≥8 件）、出现时 AI 几乎都放行（≥95%）、
 * 其他档案的已确认商品里又几乎见不到（≤2 件）。实测出来是作品名和同作品角色名，
 * 例如爱蜜莉雅档案的「リゼロ」「Re:ゼロから始める異世界生活」「スバル」。
 * 「フィギュア」「缶バッジ」这种各作品通用的品类词会被第三条挡掉，否则抽查队列全是噪音。
 */
export function keywordSeriesSignals(input: {
  includeTerms: readonly string[];
  judged: readonly KeywordAiReviewItem[];
  otherProfileTitles: readonly string[];
}): KeywordSeriesSignal[] {
  const includeAlternatives = keywordRuleTermAlternatives(input.includeTerms)
    .map((term) => keywordRuleText(term).compact)
    .filter(Boolean);
  const relevant = input.judged.filter((item) => item.aiRelevance === "relevant");
  const judgedTitles = input.judged
    .filter((item) => item.aiRelevance === "relevant" || item.aiRelevance === "irrelevant")
    .map((item) => ({ relevant: item.aiRelevance === "relevant", text: keywordRuleText(item.title) }));
  const others = input.otherProfileTitles.map(keywordRuleText);

  const signals: KeywordSeriesSignal[] = [];
  for (const [term, frequency] of documentFrequency(relevant.map((item) => item.title))) {
    if (frequency < SIGNAL_MIN_CONFIRMED) continue;
    if (Array.from(keywordRuleText(term).compact).length < 3) continue;
    // 包含词本身每件商品都有，拿它当信号等于把 AI 拒掉的全部列出来。
    if (includeAlternatives.some((alternative) => keywordRuleText(term).compact.includes(alternative))) continue;
    let judgedHits = 0;
    let relevantHits = 0;
    for (const title of judgedTitles) {
      if (!keywordRuleTextMatches(title.text, term)) continue;
      judgedHits += 1;
      if (title.relevant) relevantHits += 1;
    }
    if (judgedHits === 0 || relevantHits / judgedHits < SIGNAL_MIN_PRECISION) continue;
    if (countMatches(others, term) > SIGNAL_MAX_OTHER_PROFILE_HITS) continue;
    signals.push({ term, confirmedCount: frequency });
  }
  return signals.sort((left, right) => right.confirmedCount - left.confirmedCount);
}

/** 一件被 AI 拒掉的商品的标题里命中了哪些独有词，按在已确认商品里出现的次数排。 */
export function keywordSeriesSignalHits(
  title: string,
  signals: readonly KeywordSeriesSignal[],
): KeywordSeriesSignal[] {
  const text = keywordRuleText(title);
  return signals.filter((signal) => keywordRuleTextMatches(text, signal.term));
}
