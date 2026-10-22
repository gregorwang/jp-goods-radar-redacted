import type { SourceId } from "@jpgr/core";
import {
  groups,
  parseConfigCadence,
  parseConfigJson,
  parseConfigSources,
  strings,
} from "@/lib/exact-product-config";

/**
 * 关键词雷达的“配置单”：和精确同款雷达同一套用法，把 JSON 翻译成建档表单的各个字段。
 * 只负责填表，不直接建档；表单里没有对应能力的字段放进 ignored 让用户知道。
 */
export interface KeywordRadarConfigFill {
  name: string;
  query: string;
  maxPrice: string;
  includeTerms: string;
  excludeTerms: string;
  intervalMinutes?: string;
  sources?: SourceId[];
  ignored: string[];
}

const KNOWN_KEYS = new Set(["name", "query", "keyword", "max_price", "include_groups", "exclude_terms", "cadence", "sources"]);

export function parseKeywordRadarConfig(
  text: string,
  availableIntervals: readonly string[],
): KeywordRadarConfigFill {
  const raw = parseConfigJson(text);

  const query = strings(raw.query)[0] ?? strings(raw.keyword)[0] ?? "";
  if (!query) {
    if (raw.canonical_name !== undefined) throw new Error("这是精确同款雷达的配置单，请切换到「精确同款雷达」再粘贴。");
    throw new Error("配置单缺少 query（日文关键词）。");
  }

  const ignored: string[] = [];
  const name = strings(raw.name)[0] ?? query;

  const maxPrice = typeof raw.max_price === "number" && Number.isFinite(raw.max_price) && raw.max_price > 0
    ? String(Math.round(raw.max_price))
    : "";
  if (raw.max_price !== undefined && !maxPrice) ignored.push(`max_price「${String(raw.max_price)}」：预算上限必须是正数日元`);

  const intervalMinutes = parseConfigCadence(raw, availableIntervals, ignored);
  const sources = parseConfigSources(raw, ignored);

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) ignored.push(`${key}：关键词雷达表单没有对应的设置`);
  }

  return {
    name: name.slice(0, 120),
    query: query.slice(0, 200),
    maxPrice,
    includeTerms: groups(raw.include_groups),
    excludeTerms: groups(raw.exclude_terms),
    ...(intervalMinutes ? { intervalMinutes } : {}),
    ...(sources ? { sources } : {}),
    ignored,
  };
}

/** 给外部 AI 用的提示词：让它按关键词雷达表单能识别的格式输出配置单。 */
export const KEYWORD_RADAR_CONFIG_PROMPT = `请帮我为日本二手/零售平台的“关键词雷达”写一份配置单。关键词雷达会定时在各平台搜索一个关键词，把首次出现的新商品发给我。我会告诉你想关注的作品、角色或商品类别。

只输出一段 JSON，不要任何解释，不要 Markdown 代码块。格式如下：
{
  "name": "雷达名称，给我自己看的，中文也可以，例如：爱蜜莉雅毛绒上新",
  "query": "在平台搜索框里输入的日文关键词，2~3 个词，例如 エミリア ぬいぐるみ",
  "max_price": 预算上限数字,
  "include_groups": [["必须出现的词", "它的别名/写法变体"], ["另一组必须出现的词"]],
  "exclude_terms": ["容易混进来但我不要的东西，例如 同名的人、其他作品、不要的品类"],
  "cadence": { "minutes": 1440 },
  "sources": { "enabled": ["mercari", "yahoo_fleamarket", "yahoo_auction", "surugaya"] }
}

规则：
1. query 是搜索词，要短，太长会搜不到东西；更细的条件放进 include_groups。
2. include_groups 是“每一组都必须出现在商品标题里”，同一组里放同义写法（日文、片假名、英文、简称）。组数越少越不容易漏，只放真正必须的。
3. exclude_terms 是“出现任意一个就排除”，放同名但不相关的东西，不要放 include_groups 里的词。
4. 我没说预算就删掉 max_price。
5. cadence.minutes 只能是 30、60、180、240、360、720、1440 之一；不急的话用 1440（每天一次）。
6. sources.enabled 只能从这些里选：mercari、yahoo_fleamarket、yahoo_auction、yahoo_shopping、surugaya、amiami、amazon、rakuten、animate、cospa、charaon、ebay。
7. query、include_groups、exclude_terms 都用商品在日本平台上实际出现的写法（日文/片假名/英文），不要写中文。

我要关注的是：`;
