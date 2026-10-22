import type { NormalizedListing, SourceId } from "./types.js";

// v5：查询生成从「边生成边占坑」改成「先构造全部合法候选、再排序分配名额」，
// 并新增 purpose / anchors 两个字段。旧计划的名额分配结果与新版不同（JAN 以前
// 根本排不进去），不升版就会拿旧计划继续跑。
export const PRODUCT_SEARCH_PLAN_VERSION = "product-search-plan-v5";
export const PRODUCT_MATCH_VERSION = "product-match-v9";
export const PRODUCT_SEARCH_INTENT_VERSION = "named-product-intent-v4";
export const PRODUCT_SEARCH_AI_REVIEW_VERSION = "product-search-ai-review-v2";
export const PRODUCT_SEARCH_AI_REVIEW_LIMIT = 24;
// 复核名额是漏报的直接来源：冴えカノ 这类周边繁多的系列一轮就有 20+ 候选，名额只有 8
// 时，标题与目标逐字相同的在售商品会被挤到名额外，标一句"未达到语义复核门槛"丢掉
// （2026-09-05 生产实例 mercari m11562761890 ¥40,000）。按 §4 宁可多花几个 token。
export const PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT = 16;

export type SearchMode = "keyword" | "exact_product";
export type SearchQueryKind = "original" | "identifier" | "edition" | "manufacturer" | "series" | "size" | "alias" | "web_site";
export type ProductSearchIntentKind = "keyword" | "named_product" | "fingerprint";
export type CandidateLane = "source_native" | "historical_index" | "web_search";
export type ProductMatchRelation = "exact" | "probable_exact" | "variant" | "bundle" | "related" | "irrelevant" | "uncertain";

export interface ProductFingerprint {
  referenceUrl?: string;
  /** The one concrete Japanese product name supplied by the user. */
  canonicalName?: string;
  workTitle?: string;
  characters: string[];
  productType?: string;
  manufacturer?: string;
  series?: string;
  model?: string;
  jan?: string;
  size?: string;
  color?: string;
  /**
   * 版本与限定标记：`♭`、`Fes. Fine`、`レーシングVer.`、`F：NEX限定`、`一番くじ`。
   * 这个领域绝大多数"同作品同品类但不是同一件商品"都只差在这里。旧解析器把这些词
   * 和 新品/中古 一起当品相噪音删掉（productNameQualifier），于是判别符先被自毁，
   * 再由累加打分把兄弟款推过门槛。
   */
  edition: string[];
  /**
   * true 表示这份指纹来自 AI 抽取而不是正则启发式。计划构建时必须原样信任它：
   * 启发式会把 初音ミク / 高木さん 填进 workTitle、把 A3プリモアート 填进 characters，
   * 再拿这些错值去覆盖抽取结果，等于白抽一次。
   */
  aiExtracted?: boolean;
  aliases: string[];
  /** Explicit short marketplace queries used to recall incomplete seller titles. */
  recallQueries?: string[];
  /** Every group must match; aliases inside one group are separated by `|`. */
  requiredTermGroups?: string[];
  /** At least one group must match before an abbreviated title can be promoted for semantic review. */
  supportingTermGroups?: string[];
  excludedTerms: string[];
}

export interface SearchQueryVariant {
  id: string;
  query: string;
  kind: SearchQueryKind;
  weight: number;
  /** web_search 只出现在 2026-10 网页补漏下线前保存的旧计划里。 */
  lane: "source_native" | "web_search";
  /** 查询用途（计划 §6.1）。旧计划没有这两个字段，读不到时按 precise 处理。 */
  purpose?: PlannedQueryPurpose;
  /** 这条查询保留下来的身份锚点。 */
  anchors?: string[];
}

export interface ProductSearchPlan {
  version: typeof PRODUCT_SEARCH_PLAN_VERSION;
  intentVersion: typeof PRODUCT_SEARCH_INTENT_VERSION;
  intentKind: ProductSearchIntentKind;
  mode: SearchMode;
  originalQuery: string;
  target?: ProductFingerprint;
  variants: SearchQueryVariant[];
  /** 网页补漏（OpenWebNinja）已于 2026-10 下线，新计划恒为 false；字段留给历史记录。 */
  deepSearch: boolean;
  warnings: string[];
}

export interface CandidateHit {
  variantId: string;
  query: string;
  kind: SearchQueryKind;
  lane: CandidateLane;
  upstreamRank: number;
  weight: number;
  liveVerified: boolean;
}

/**
 * 商品身份是靠**差异**判定的，不是靠相似度。累加式打分只会回答"有多像"，
 * 而任意两个兄弟款共享的那一半名字（作品 + 品类）稳定值 60~90 分，区别的那一半
 * 若记 0 分而不是负分，兄弟款就会被系统性地推进"确认同款"区间。
 *
 * 这里把"目标有而候选没有"单独记下来：它既是降档依据，也是给用户看的那行人话。
 * 按 AGENTS.md §4，缺失只降档、不丢弃。
 */
export interface ProductMatchDifference {
  /** 目标身份要素中，候选文本确实命中的。 */
  matched: string[];
  /** 目标有、候选没有的身份要素——负证据。 */
  missing: string[];
  /** 双方都有值但明确不同的字段。 */
  conflicting: string[];
  /**
   * 目标声明了、候选既没证实也没反证的软属性（尺寸 / 颜色）。
   * 它不参与身份判定——`missing` 才是负证据——只用来在差异说明里提醒用户自己核对。
   */
  unconfirmed?: string[];
  /**
   * **候选有、目标没有**的区分性标记。
   *
   * 这一栏是 2026-09-12 拿 T5 的真实数据回放时被逼出来的。目标是
   * 「冴えない彼女の育てかた Fine トレーディング 加藤恵 缶バッジ」，而下面这些全部被判成了确认同款：
   *
   *   バレンタインver. / 夏のお出かけver. / 秋のお出かけver. / バースデー2021ver.
   *   10個入りBOX / 9個入りBOX（整盒，不是单枚）
   *
   * 原因是旧模型里“身份已证明”等于“目标的每个词候选都有”——候选**多出来**的
   * 词根本没被建模。但一个比目标更具体的候选并没有被证明是同一件商品：
   * 它同样可能是兄弟款。这正是计划 §13.2 给 T5 写的验收要求：
   * 「不能仅共同词命中就全部确认到同款」。
   *
   * 只收录程序有把握的两类：版本 / 活动标记，以及销售单位标记。
   * 品相词（新品 / 中古 / 未開封）不算，它不改变商品身份。
   */
  extraDistinguishers?: string[];
  /**
   * `missing` 里属于纯符号版本标记（`♭`）的那几个。它们是目标与兄弟款之间唯一的
   * 字面区别：候选文本里没有它，模型的引用也就不可能包含它，所以模型的"同款"不能
   * 单独让它确认，只能降到 uncertain。
   */
  missingVersionMarkers?: string[];
  /**
   * 目标品类是已知品类词，候选文本里却既没有它、也没有它的基础词（`ミニ色紙` → `色紙`）。
   * 理由同上：候选没写这个品类，模型的引用就不可能证明它卖的是这个品类。
   * 2026-10-12 一张 `レーシングミク2017 和装 ステッカー` 被模型自己写成「贴纸」，
   * 却仍判 relevant，确认成了 `ミニ色紙` 的同款。
   */
  missingProductType?: string;
}

/**
 * 同一轮候选集里的词频。一个在 20 条候选里出现 18 次的词（作品名、品类）没有判别力，
 * 出现 2 次的词（画师、版本、限定标记）才是答案。按批内逆文档频率加权，
 * 等于让每个商品自己校准"什么才算区别"，不依赖任何词表。
 */
export interface ProductMatchCorpus {
  documentCount: number;
  /** matchKey(词) -> 包含该词的候选数量。 */
  documentFrequency: Record<string, number>;
}

export interface ProductMatchAssessment {
  version: typeof PRODUCT_MATCH_VERSION;
  relation: ProductMatchRelation;
  score: number;
  confidence: "high" | "medium" | "low";
  matchedFields: string[];
  conflicts: string[];
  reasons: string[];
  difference?: ProductMatchDifference;
}

export interface SearchCandidateEvidence {
  hits: CandidateHit[];
  fusedScore: number;
  bestRank: number;
  historical: boolean;
  liveVerified: boolean;
  match?: ProductMatchAssessment;
}

const bundlePattern = /(?:セット|まとめ(?:売り)?|詰め合わせ|コンプリート|全種|\bset\b|\blot\b)/iu;

/**
 * 候选标题里的区分性标记。每条都是程序能指得出来的字面特征，
 * 不做语义推断——能不能接受这个差异，交给语义复核去判。
 */
const DISTINGUISHER_PATTERNS: readonly RegExp[] = [
  // 版本 / 活动标记：バレンタインver. / 夏のお出かけver. / 制服Ver
  /[^\s【】「」\[\]]{1,14}(?:ver|Ver|VER)\.?/gu,
  // 周年 / 生日等带年份的活动：バースデー2021 / 10周年
  /[^\s【】「」\[\]]{0,10}(?:20\d{2}|\d{1,2}周年)/gu,
  // 销售单位：10個入りBOX / 1BOX / コンプリート
  /\d{1,3}\s*個入り(?:BOX|ボックス)?/giu,
  /\bBOX\b/giu,
  // 店铺 / 活动限定：マルイ限定 / アニメイト限定
  /[^\s【】「」\[\]]{1,12}限定/gu,
];

/**
 * 找出候选有、目标没有的区分性标记。
 *
 * 它不是反证（“另一个活动”和“同一件商品的卖家补充描述”在字面上分不开），
 * 所以不能拿它直接拒绝；但它足以说明“文本还没有证明身份”，因此阻止确定性确认。
 */
function candidateExtraDistinguishers(listingText: string, target: ProductFingerprint): string[] {
  const targetText = compact([
    target.canonicalName,
    target.workTitle,
    ...target.characters,
    target.productType,
    target.series,
    target.manufacturer,
    ...target.edition,
    ...target.aliases,
  ].filter(Boolean).join(" "));
  const found: string[] = [];
  for (const pattern of DISTINGUISHER_PATTERNS) {
    for (const match of listingText.matchAll(pattern)) {
      const value = match[0]?.trim();
      if (!value) continue;
      const key = compact(value);
      // 目标自己就写了这个标记（比如目标就是 BOX），它不是差异。
      if (!key || targetText.includes(key)) continue;
      found.push(value);
    }
  }
  return uniqueTerms(found).slice(0, 6);
}

export function normalizeProductSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(/\s+/g, " ");
}

/**
 * 身份比对用的紧凑形式：打掉标点、括号、引号、记号与空白。
 *
 * 必须把引号类字符也打掉：用户输入「… “加藤恵” 私服Ver.」时，旧实现会把
 * “加藤恵”（带全角引号）当成一个整词去商品标题里找，找不到就记一条「缺失」。
 * 2026-09-12 实测：一条标题逐字相同的候选，得分 100、作品/品类/尺寸/版本/角色
 * 全部命中，却因为这一对引号被判成「待定·需要详情」。引号不是身份。
 */
function compact(value: string): string {
  return normalizeProductSearchText(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** 按 NFKC 去重、不经过 compact——给纯符号的值用，uniqueTerms 会把它们整个丢掉。 */
function uniqueRawValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))];
}

function uniqueTerms(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw?.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!value) continue;
    const key = compact(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/**
 * 发出去的查询串里不带表记噪音。
 *
 * 引号、括号、书名号、星号这些既不是商品身份，平台也不保证它们有检索含义
 * （Mercari 只提供正式的「除外キーワード」字段，没有公开 `"..."` / `-` / `OR`
 * 运算符）。带着它们搜，等于凭空多一个卖家必须写对的字符。
 */
function searchableQueryPart(value: string): string {
  return value
    .replace(/[“”‘’"'「」『』【】（）()［］[\]〈〉《》★☆◆◇■□●○※]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedQuery(parts: readonly (string | undefined)[]): string {
  return uniqueTerms(parts.map((part) => (part === undefined ? part : searchableQueryPart(part))))
    .join(" ").slice(0, 200).trim();
}

function normalizedIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  return normalized && /^[A-Z0-9]{4,24}$/.test(normalized) ? normalized : undefined;
}

const namedProductTypes = [
  "抱き枕カバー",
  "アクリルスタンド",
  "アクリルキーホルダー",
  "アクリルパネル",
  "キャラファイングラフ",
  "プリモアート",
  "キーホルダー",
  "ミニ色紙",
  "色紙",
  "ぬいぐるみ",
  "マスコット",
  "フィギュア",
  "タペストリー",
  "缶バッジ",
  "ステッカー",
  "プラモデル",
  "ストラップ",
  "電子書籍",
  "公式アートブック",
  "アートブック",
  "ファンブック",
  "ガイドブック",
  "設定資料集",
  "公式資料集",
  "イラスト集",
  "原画集",
  "Blu-ray",
  "ブルーレイ",
  "写真集",
  "画集",
  "図録",
  "パンフレット",
  "ムック",
  "書籍",
  "コミック",
  "ポスター",
  "カード",
  "パーカー",
  "ドール",
  "バッグ",
  "DVD",
] as const;

const namedColors = [
  "グレー",
  "ブラック",
  "ホワイト",
  "ネイビー",
  "ベージュ",
  "ブラウン",
  "ピンク",
  "パープル",
  "オレンジ",
  "イエロー",
  "グリーン",
  "ブルー",
  "レッド",
  "シルバー",
  "ゴールド",
  "灰色",
  "黒",
  "白",
  "紺",
  "茶",
  "桃",
  "紫",
  "橙",
  "黄",
  "緑",
  "青",
  "赤",
  "銀",
  "金",
] as const;

function containsJapanese(value: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
}

/** `編` / `篇` after a run marks a work arc, so the run before it is a title. */
const workArcMarker = /^[編篇]/u;
const katakanaRun = /^[\p{Script=Katakana}ー]/u;

/**
 * A katakana product type must end its katakana run. `カード` inside
 * `カードキャプター` names a work and `クリアカード編` names its arc; reading
 * either as the product category turns every later step — history recall,
 * category scoring, derived aliases — into a search for the wrong kind of
 * object. Returning no category is the safe outcome when the name does not
 * clearly state one.
 */
function productTypeReadsAsCategory(normalized: string, type: string): boolean {
  const katakanaOnly = /^[\p{Script=Katakana}ー]+$/u.test(type);
  for (let index = normalized.indexOf(type); index >= 0; index = normalized.indexOf(type, index + 1)) {
    const after = normalized.slice(index + type.length);
    if (workArcMarker.test(after)) continue;
    if (katakanaOnly && katakanaRun.test(after)) continue;
    return true;
  }
  return false;
}

function detectedProductType(canonicalName: string): string | undefined {
  const normalized = normalizeProductSearchText(canonicalName);
  // Longest match wins so `アクリルキーホルダー` is never reduced to `キーホルダー`
  // merely because of where each sits in the table.
  return [...namedProductTypes]
    .filter((value) => productTypeReadsAsCategory(normalized, normalizeProductSearchText(value)))
    .sort((left, right) => right.length - left.length)[0];
}

/** Reject explicit category contradictions, not missing title evidence. */
export function productFingerprintNameConflicts(target: ProductFingerprint): string[] {
  if (!target.canonicalName || !target.productType || bundlePattern.test(target.canonicalName)) return [];
  const namedType = detectedProductType(target.canonicalName);
  const suppliedType = detectedProductType(target.productType);
  if (!namedType || !suppliedType || compact(target.canonicalName).includes(compact(suppliedType))) return [];
  const family = (value: string): string => {
    if (/ブック|資料集|イラスト集|原画集|写真集|画集|図録|パンフレット|ムック|書籍|コミック/u.test(value)) return "book";
    if (/ぬいぐるみ|マスコット/u.test(value)) return "plush";
    if (/Blu-ray|ブルーレイ/iu.test(value)) return "blu-ray";
    return compact(value);
  };
  return family(namedType) === family(suppliedType) ? [] : ["productType"];
}

function isGenericProductDescriptor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeProductSearchText(value);
  if (namedProductTypes.some((type) => normalized === normalizeProductSearchText(type))) return true;
  return /(?:book|ブック|ガイド|パンフレット|カタログ|図録|画集|写真集|資料集|原画集|イラスト集|書籍|コミック|漫画|雑誌|ムック|ぬいぐるみ|マスコット|フィギュア|キーホルダー|ストラップ|缶バッジ|カード|ポスター|タペストリー|パーカー|バッグ|ドール|blu-?ray|dvd)$/iu.test(normalized);
}

function detectedSize(canonicalName: string): string | undefined {
  const normalized = canonicalName.normalize("NFKC");
  return normalized.match(/(?:ユニセックス\s*)?(?:XXXL|3XL|XXL|2XL|XL|XS|S|M|L)\s*サイズ/iu)?.[0]
    ?.replace(/\s+/gu, "")
    ?? normalized.match(/(?:A|B)\d{1,2}/iu)?.[0]?.toUpperCase()
    ?? normalized.match(/(?:約|全長|サイズ[:：]?\s*)?\d+(?:\.\d+)?\s*(?:cm|mm)/iu)?.[0]
      ?.replace(/\s+/gu, "");
}

function detectedColor(canonicalName: string): string | undefined {
  const normalized = normalizeProductSearchText(canonicalName);
  return namedColors.find((value) => normalized.includes(normalizeProductSearchText(value)));
}

function namedProductReductions(
  canonicalName: string,
  productType: string | undefined,
  character: string | undefined,
): string[] {
  // Without a recognized product type we cannot safely tell an identity token
  // from a generic noun at the end of the title. Keep such reductions local
  // instead of turning them into marketplace queries or match evidence.
  if (!productType) return [];
  const segments = canonicalName.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  if (segments.length < 2) return [];
  const reductions: string[] = [];
  const suffix = segments.slice(-Math.min(3, segments.length - 1)).join(" ");
  if (suffix && compact(suffix) !== compact(canonicalName)) reductions.push(suffix);
  const shortSuffix = segments.slice(-2).join(" ");
  if (shortSuffix && compact(shortSuffix) !== compact(canonicalName)) reductions.push(shortSuffix);
  if (productType) {
    const withoutType = shortSuffix.replace(new RegExp(productType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ")
      .replace(/\s+/g, " ")
      .trim();
    if (withoutType && compact(withoutType) !== compact(canonicalName)) reductions.push(withoutType);
  }
  const identityAnchors = uniqueTerms([productType, character]);
  return uniqueTerms(reductions)
    // A source-native alias must retain the whole locally known identity. A
    // product-type-only reduction such as `ぬいぐるみ` turns strict product
    // search into a broad marketplace browse on sources that use OR matching
    // or recommendation fallbacks.
    .filter((reduction) => identityAnchors.length === 0
      || identityAnchors.every((anchor) => includesValue(reduction, anchor)))
    .slice(0, 3);
}

function quotedProductSegment(segment: string): string | undefined {
  const match = segment.match(/^[「『【\[](.+)[」』】\]]$/u);
  return match?.[1]?.trim() || undefined;
}

function productNameQualifier(segment: string): boolean {
  return /(?:限定|特典|先行|予約|未開封|新品|中古|セット|まとめ売り|描き下ろし|ver(?:sion)?\.?|版)$/iu.test(segment);
}

function likelyNamedWorkOrEvent(value: string | undefined): boolean {
  return Boolean(value && /(?:展|展覧会|博覧会|フェア|祭|劇場版|映画版|舞台版)$/u.test(value));
}

/**
 * Build a conservative product identity from one concrete Japanese name.
 * It only derives facts present in the name and never invents a model or JAN.
 */
export function fingerprintFromJapaneseProductName(canonicalName: string): ProductFingerprint {
  const normalizedName = canonicalName.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 200);
  const productType = detectedProductType(normalizedName);
  const size = detectedSize(normalizedName);
  const color = detectedColor(normalizedName);
  const segments = normalizedName.split(/\s+/u).filter(Boolean);
  const edition = segments.filter((segment) => /(?:ver(?:sion)?\.?|限定版|通常版|初回版|[^★\s]{2,}限定)$/iu.test(segment));
  const identitySegments = segments.filter((segment) => {
    if (productType && normalizeProductSearchText(segment).includes(normalizeProductSearchText(productType))) return false;
    if (size && compact(segment) === compact(size)) return false;
    if (color && compact(segment) === compact(color)) return false;
    return containsJapanese(segment) && !productNameQualifier(segment);
  });
  // `ユリウス ぬいぐるみ` has one identity-bearing term plus a generic
  // product type. Treat that term as the character/subject, not as a work
  // title; otherwise every plush toy becomes a plausible match.
  const loneIdentitySegment = productType
    && segments.length === 2
    && identitySegments.length === 1
    && !likelyNamedWorkOrEvent(identitySegments[0])
    ? identitySegments[0]
    : undefined;
  const quotedWorkIndex = segments.findIndex((segment) => Boolean(quotedProductSegment(segment)));
  const inferredWorkIndex = quotedWorkIndex >= 0
    ? quotedWorkIndex
    : loneIdentitySegment
      ? -1
      : segments.findIndex((segment) => containsJapanese(segment)
      && segment.length >= 4
      && !productNameQualifier(segment)
      && !(productType && normalizeProductSearchText(segment).includes(normalizeProductSearchText(productType))));
  const workSegment = inferredWorkIndex >= 0 ? segments[inferredWorkIndex] : undefined;
  const workTitle = workSegment ? quotedProductSegment(workSegment) ?? workSegment : undefined;
  const lastMeaningful = [...segments].reverse().find((segment) => {
    if (segment === workSegment || quotedProductSegment(segment)) return false;
    if (productType && normalizeProductSearchText(segment).includes(normalizeProductSearchText(productType))) return false;
    if (size && compact(segment) === compact(size)) return false;
    if (color && compact(segment) === compact(color)) return false;
    return containsJapanese(segment) && segment.length <= 40 && !productNameQualifier(segment);
  });
  return normalizeProductFingerprint({
    canonicalName: normalizedName,
    workTitle,
    characters: lastMeaningful && lastMeaningful !== workTitle ? [lastMeaningful] : [],
    productType,
    size,
    color,
    edition,
    aliases: namedProductReductions(normalizedName, productType, lastMeaningful ?? workTitle),
    recallQueries: [],
    requiredTermGroups: [],
    supportingTermGroups: [],
    excludedTerms: [],
  })!;
}

/** AI 抽取器的输出形状。core 不依赖 validation，所以这里用结构化类型描述。 */
export interface ProductTargetExtractionInput {
  workTitle?: string | null;
  characters?: readonly string[];
  productType?: string | null;
  edition?: readonly string[];
  size?: string | null;
  color?: string | null;
  manufacturer?: string | null;
  series?: string | null;
  recallQueries?: readonly string[];
}

/**
 * 一份"什么都没抽到"的结果和"没有结果"不可区分，只可能来自解析失败或模型没答上来。
 * 采纳它比不抽取更糟：`fingerprintFromExtractedProductName` 会用空值覆盖启发式已有的
 * workTitle / characters，指纹反而变弱。2026-09-06 就是这样——`responseValue` 少了一层
 * 递归，整份响应被 schema 上逐字段的 `.catch()` 洗成全空，任务却标成 completed。
 *
 * 注意这和"characters 为空"不是一回事：那是抽取器给出的结论（`メダリスト展 アートブック`
 * 确实没有角色），必须原样采纳。只有所有槽位同时为空才算没抽到。
 */
export function productTargetExtractionIsEmpty(
  extraction: ProductTargetExtractionInput | undefined,
): boolean {
  if (!extraction) return true;
  return !extraction.workTitle?.trim()
    && !extraction.productType?.trim()
    && !extraction.size?.trim()
    && !extraction.color?.trim()
    && !extraction.manufacturer?.trim()
    && !extraction.series?.trim()
    && (extraction.characters ?? []).length === 0
    && (extraction.edition ?? []).length === 0
    && (extraction.recallQueries ?? []).length === 0;
}

/**
 * 抽取结果的**原文依据**检查（计划 §4.3）。
 *
 * 抽取器只被允许拆分原始商品名里已经存在的内容。原文写「深崎暮人」，抽取器写回
 * 「深崎暮人イラスト」时，多出来的那两个字不是用户的目标身份——它是模型补的。
 * 采纳它会让指纹比用户说的更窄，从此再也搜不到那件商品；而这件事在旧实现里
 * 没有任何一层会发现，因为 schema 只管类型对不对，不管值从哪来。
 *
 * 判据刻意保守：只要该值（去掉分隔符后）是原文的子串就算有依据。这条规则程序
 * 有把握，所以做厚；语义等价（「冴えカノ」＝「冴えない彼女の育てかた」）程序没把握，
 * 不在这里判——那类别名走 recallQueries，只用于召回，不进入身份等价。
 */
function groundedInRawInput(rawInput: string, value: string | null | undefined): boolean {
  const candidate = value ? compact(value) : "";
  if (!candidate) return false;
  return compact(rawInput).includes(candidate);
}

export interface TargetExtractionFidelity {
  /** 有依据、已被采纳的字段值。 */
  accepted: string[];
  /**
   * 原文里找不到依据、因此未被采纳的提议。保留下来是为了可审计：
   * 它们既不静默消失，也不冒充用户的目标身份。
   */
  ungroundedProposals: Array<{ field: string; value: string }>;
  /**
   * 内部处理状态，不是「用户输入质量」档位（计划 §4.1）。
   * `valid`：全部字段有依据；`retry_required`：有字段被判定无依据，值得重做该步；
   * `failed`：整份抽取为空。
   */
  extractionStatus: "valid" | "retry_required" | "failed";
}

/**
 * 逐字段核对抽取结果与原始商品名，返回**只保留有依据部分**的抽取结果和一份核对报告。
 * recallQueries 不在核对范围内：它是召回表达，允许比身份等价宽（计划 §4.4）。
 */
export function groundProductTargetExtraction(
  canonicalName: string,
  extraction: ProductTargetExtractionInput | undefined,
): { extraction: ProductTargetExtractionInput | undefined; fidelity: TargetExtractionFidelity } {
  if (!extraction || productTargetExtractionIsEmpty(extraction)) {
    return {
      extraction,
      fidelity: { accepted: [], ungroundedProposals: [], extractionStatus: "failed" },
    };
  }
  const accepted: string[] = [];
  const ungroundedProposals: Array<{ field: string; value: string }> = [];
  const keepScalar = (field: string, value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (groundedInRawInput(canonicalName, trimmed)) {
      accepted.push(trimmed);
      return trimmed;
    }
    ungroundedProposals.push({ field, value: trimmed.slice(0, 120) });
    return null;
  };
  const keepList = (field: string, values: readonly string[] | undefined): string[] => (
    (values ?? []).flatMap((value) => {
      const kept = keepScalar(field, value);
      return kept ? [kept] : [];
    })
  );
  const grounded: ProductTargetExtractionInput = {
    workTitle: keepScalar("workTitle", extraction.workTitle),
    characters: keepList("characters", extraction.characters),
    productType: keepScalar("productType", extraction.productType),
    edition: keepList("edition", extraction.edition),
    size: keepScalar("size", extraction.size),
    color: keepScalar("color", extraction.color),
    manufacturer: keepScalar("manufacturer", extraction.manufacturer),
    series: keepScalar("series", extraction.series),
    // 召回词允许比身份等价宽，原样透传。
    recallQueries: [...(extraction.recallQueries ?? [])],
  };
  return {
    extraction: grounded,
    fidelity: {
      accepted,
      ungroundedProposals: ungroundedProposals.slice(0, 12),
      extractionStatus: ungroundedProposals.length > 0 ? "retry_required" : "valid",
    },
  };
}

/**
 * 用 AI 抽取结果覆盖启发式指纹。抽取缺失时整份退回启发式——按 AGENTS.md §4，
 * 抽取失败只能降级，不能拦住用户建档。
 *
 * 采纳前先过 `groundProductTargetExtraction`：原始商品名始终是权威输入，派生字段
 * 只能解释它，不能改写它（计划 §4.1）。
 */
export function fingerprintFromExtractedProductName(
  canonicalName: string,
  rawExtraction: ProductTargetExtractionInput | undefined,
): ProductFingerprint {
  const derived = fingerprintFromJapaneseProductName(canonicalName);
  const { extraction } = groundProductTargetExtraction(canonicalName, rawExtraction);
  if (!extraction || productTargetExtractionIsEmpty(extraction)) return derived;
  return normalizeProductFingerprint({
    canonicalName: derived.canonicalName ?? canonicalName,
    ...(extraction.workTitle?.trim() ? { workTitle: extraction.workTitle.trim() } : {}),
    // 抽取器返回空角色本身就是结论（例如「メダリスト展 アートブック」确实没有角色），
    // 不能再退回启发式那个把品类词当角色的结果。
    characters: [...(extraction.characters ?? [])],
    ...(extraction.productType?.trim() ? { productType: extraction.productType.trim() } : {}),
    edition: [...(extraction.edition ?? [])],
    ...(extraction.size?.trim() ? { size: extraction.size.trim() } : {}),
    ...(extraction.color?.trim() ? { color: extraction.color.trim() } : {}),
    ...(extraction.manufacturer?.trim() ? { manufacturer: extraction.manufacturer.trim() } : {}),
    ...(extraction.series?.trim() ? { series: extraction.series.trim() } : {}),
    // 召回词是这次改动最直接的漏报修复：卖家写「冴えカノ」时，只发完整正式名
    // 根本搜不到，后面的打分再宽容也救不回来。
    recallQueries: [...(extraction.recallQueries ?? [])],
    aliases: derived.aliases,
    aiExtracted: true,
    excludedTerms: [],
  })!;
}

export function normalizeProductFingerprint(input: Partial<ProductFingerprint> | undefined): ProductFingerprint | undefined {
  if (!input) return undefined;
  const fingerprint: ProductFingerprint = {
    ...(input.referenceUrl?.trim() ? { referenceUrl: input.referenceUrl.trim() } : {}),
    ...(input.canonicalName?.trim() ? { canonicalName: input.canonicalName.trim() } : {}),
    ...(input.workTitle?.trim() ? { workTitle: input.workTitle.trim() } : {}),
    characters: uniqueTerms(input.characters ?? []).slice(0, 8),
    ...(input.productType?.trim() ? { productType: input.productType.trim() } : {}),
    ...(input.manufacturer?.trim() ? { manufacturer: input.manufacturer.trim() } : {}),
    ...(input.series?.trim() ? { series: input.series.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.jan?.trim() ? { jan: input.jan.trim() } : {}),
    ...(input.size?.trim() ? { size: input.size.trim() } : {}),
    ...(input.color?.trim() ? { color: input.color.trim() } : {}),
    edition: uniqueTerms(input.edition ?? []).slice(0, 8),
    ...(input.aiExtracted ? { aiExtracted: true } : {}),
    aliases: uniqueTerms(input.aliases ?? []).slice(0, 12),
    recallQueries: uniqueTerms(input.recallQueries ?? []).slice(0, 4),
    requiredTermGroups: uniqueTerms(input.requiredTermGroups ?? []).slice(0, 12),
    supportingTermGroups: uniqueTerms(input.supportingTermGroups ?? []).slice(0, 12),
    excludedTerms: uniqueTerms(input.excludedTerms ?? []).slice(0, 12),
  };
  return fingerprint;
}

export function productFingerprintStrength(target: ProductFingerprint | undefined): number {
  if (!target) return 0;
  if (normalizedIdentifier(target.jan) || normalizedIdentifier(target.model)) return 4;
  const attributes = [target.manufacturer, target.series, target.size, target.color, target.productType, target.workTitle]
    .filter(Boolean).length + Math.min(target.characters.length, 1) + Math.min(target.aliases.length, 1)
    + Math.min((target.edition ?? []).length, 1);
  return Math.min(3, attributes);
}

/**
 * A character/work plus a generic category describes a product family, not one
 * concrete SKU. Gemini can judge topical relevance for it, but cannot safely
 * promote marketplace offers to "same exact product" without another stable
 * discriminator or a distinctive product-line term in the supplied name.
 */
export function productFingerprintSupportsExactMatch(target: ProductFingerprint | undefined): boolean {
  if (!target) return false;
  if (normalizedIdentifier(target.jan) || normalizedIdentifier(target.model)) return true;
  if (target.manufacturer || target.series || target.size || target.color) return true;
  // 版本标记本身就是稳定判别符：有它就能把兄弟款区分开。
  if ((target.edition ?? []).length > 0) return true;
  if (target.workTitle && target.productType && likelyNamedWorkOrEvent(target.workTitle)) return true;
  if (!target.canonicalName) return false;
  const genericValues = uniqueTerms([
    target.productType,
    target.workTitle,
    ...target.characters,
  ]);
  return uniqueTerms(target.canonicalName.split(/\s+/u)).some((term) => compact(term).length >= 4
    && !genericValues.some((generic) => compact(term) === compact(generic)));
}

/**
 * 版本词用作**查询**时去掉末尾的版本标记（`Ver.` / `バージョン` 一类）。
 *
 * 「バースデーデート」比「バースデーデートVer.」召回更宽，而且严格包含后者——卖家
 * 写全了也照样命中，写漏了才救得回来。判定侧仍然用完整的版本词，这里只影响发出去的
 * 查询串。
 */
/** 带明确版本标记的词（`私服Ver.`、`F:NEX限定`、`レーシングバージョン`）。 */
function carriesVersionMarker(value: string): boolean {
  return /(?:ver\.?|version|バージョン|ヴァージョン|限定|版)$/iu.test(value.trim());
}

/**
 * 从版本词表里挑出**真正用来发查询的那一个**。
 *
 * 抽取器会把一堆东西倒进 `edition`，顺序就是它们在标题里出现的顺序。
 * 2026-09-12 实例：`["Fine", "ふわぷち", "M", "私服Ver."]`——`Fine` 是作品名的一部分，
 * `ふわぷち` 是产品线（series 里已有），`M` 是尺寸（size 里已有），只有 `私服Ver.`
 * 是版本词。盲取第一个的结果是把 `Fine` 送上了最高权重，连发两枪垃圾查询。
 *
 * 规则两条，都是确定性的：先扔掉已经被其他字段认领的词（作品/系列/尺寸/品类/
 * 角色/厂商），再优先选带明确版本标记的那一个。没有带标记的就用剩下的第一个。
 */
function editionQueryAxis(target: ProductFingerprint): string | undefined {
  const claimed = uniqueTerms([
    target.workTitle,
    target.series,
    target.size,
    target.color,
    target.productType,
    target.manufacturer,
    ...target.characters,
  ]);
  const own = target.edition.filter((value) => {
    const key = compact(value);
    if (key.length < 2) return false;
    return !claimed.some((other) => {
      const otherKey = compact(other);
      return otherKey.length >= 1 && (otherKey === key || otherKey.includes(key));
    });
  });
  return own.find(carriesVersionMarker) ?? own[0];
}

function editionQueryTerm(value: string): string {
  const trimmed = value
    .replace(/[\s　]*(?:ver\.?|version|ヴァージョン|バージョン)[\s　]*$/iu, "")
    .trim();
  return compact(trimmed).length >= 2 ? trimmed : value;
}

/**
 * 查询的用途。它决定排序与守门规则，不是展示标签（计划 §6.1）。
 */
export type PlannedQueryPurpose = "identifier" | "precise" | "alias" | "bounded_fallback";

export interface PlannedQueryCandidate {
  query: string;
  kind: SearchQueryKind;
  purpose: PlannedQueryPurpose;
  weight: number;
  lane: SearchQueryVariant["lane"];
  /** 这条查询保留下来的身份锚点，用于守门核对。 */
  anchors: string[];
}

const PLANNED_QUERY_PURPOSE_RANK: Record<PlannedQueryPurpose, number> = {
  identifier: 0,
  precise: 1,
  alias: 2,
  bounded_fallback: 3,
};

/**
 * 查询守门（计划 §6.2）。
 *
 * 要挡住的是「普通路径自动退化到作品 + 角色」这类整站浏览式查询；要放行的是
 * 商品代码、以及保留了主体锚点与品类的具体组合。规则刻意只做程序能核验的事：
 * 查询里有没有留下主体锚点、有没有留下品类词。「这个词辨识度高不高」不在这里判
 * ——那正是 §6.2 禁止的「靠模型评分放行宽词」。
 */
export function plannedQueryPassesGate(
  candidate: PlannedQueryCandidate,
  target: ProductFingerprint,
  originalQuery: string,
): boolean {
  if (!candidate.query.trim()) return false;
  // 可靠的完整商品代码独立成立，不需要品类陪绑。
  if (candidate.purpose === "identifier") {
    return Boolean(normalizedIdentifier(target.jan) || normalizedIdentifier(target.model));
  }
  // 用户提交的完整商品名本身就是目标定义，始终是一条合法查询。
  if (compact(candidate.query) === compact(originalQuery)) return true;

  const subjects = uniqueTerms([...target.characters, target.workTitle, target.canonicalName]);
  const keepsSubject = subjects.length === 0
    || subjects.some((subject) => includesValue(candidate.query, subject));
  // 品类是把「这个角色的所有周边」收敛成「这一类商品」的那一刀。没有它，
  // 「作品 + 角色」就是整站浏览——2026-09-10 的 866 条候选正是这么来的。
  const keepsProductType = !target.productType || includesValue(candidate.query, target.productType);

  // 稳定判别符：目标自己声明过的版本/限定词或型号。它比品类还窄一刀，
  // 所以「品类 + 版本」即使不带角色也不是整站浏览，只需再留一个身份要素即可放行。
  // 这里判的仍然只是程序能核验的事（这个词在不在目标身份里、在不在查询里），
  // 不是「这个词辨识度高不高」——后者仍然禁止（§6.2）。
  const discriminators = uniqueTerms([
    ...target.edition,
    ...target.edition.map(editionQueryTerm),
    target.model,
  ]);
  const keepsDiscriminator = discriminators.length > 0
    && discriminators.some((value) => includesValue(candidate.query, value));
  if (keepsDiscriminator && (keepsSubject || keepsProductType)) return true;

  if (!keepsSubject) return false;
  return keepsProductType;
}

/**
 * 合法查询的排序（计划 §6.3）。
 *
 * 顺序依据：可靠商品标识符 > 具体类型与版本/系列组合 > 受验证的召回别名 >
 * 其他受约束表达。原始完整标题是一条**可选**查询，既不固定永远第一，
 * 也不永远禁用——它按自己的用途参与排序，由来源侧再决定要不要提前。
 *
 * 这里不硬编码任何一个商品的词序：毛绒、徽章、复制画、型号商品的区分信息
 * 本来就不同，排序只看用途与权重。
 */
export function rankPlannedQueries(candidates: readonly PlannedQueryCandidate[]): PlannedQueryCandidate[] {
  return [...candidates].sort((left, right) => (
    PLANNED_QUERY_PURPOSE_RANK[left.purpose] - PLANNED_QUERY_PURPOSE_RANK[right.purpose]
    || right.weight - left.weight
    || left.query.localeCompare(right.query)
  ));
}

/* ------------------------------------------------------------------ *
 * 逐查询覆盖账本（计划 §6.5、§6.6）
 * ------------------------------------------------------------------ */

export type QueryStopReason =
  | "exhausted"
  | "refined"
  | "duplicate_yield"
  | "source_error"
  | "deadline"
  | "budget"
  | "objective_met";

export interface QueryCoverage {
  queryId: string;
  query: string;
  purpose: PlannedQueryPurpose;
  lane: CandidateLane;
  pagesFetched: number;
  rawReturned: number;
  /** 按上游名次实际收下的条数。rawReturned - accepted = 主动放弃的后排。 */
  acceptedListings?: number;
  uniqueNewListings: number;
  duplicateListings: number;
  hardConflictCount: number;
  /** 来源自报的总数。不准确时保留原值并标记，不据此推导「还剩几件」。 */
  reportedTotal?: number;
  reportedTotalReliability: "reported" | "unreliable" | "unknown";
  /**
   * 这条查询自己的游标。**不跨查询复用**——游标绑定 query + source + filters
   * + sort + lane，拿 A 查询的游标去翻 B 查询的下一页，翻到的是另一个结果集。
   */
  nextCursor: string | null;
  stopReason: QueryStopReason;
  /**
   * `exhausted` 只表示这条查询在当时返回的分页已耗尽，**不表示整个市场已搜尽**。
   * 多条合法查询都结束也不能保证绝对全召回（§6.6）。
   */
  coverage: "exhausted" | "partial" | "unknown";
  latencyMs: number;
}

export function buildProductSearchPlan(input: {
  query: string;
  mode?: SearchMode;
  target?: Partial<ProductFingerprint>;
  intentKind?: Exclude<ProductSearchIntentKind, "keyword">;
}): ProductSearchPlan {
  // Keyword mode is a source contract: keep the user's Japanese spacing and
  // punctuation intact. Exact-product derivatives are normalized separately.
  const originalQuery = input.query.trim().slice(0, 200);
  const mode = input.mode ?? "keyword";
  const suppliedTarget = mode === "exact_product" ? normalizeProductFingerprint(input.target) : undefined;
  const derivedTarget = mode === "exact_product" ? fingerprintFromJapaneseProductName(originalQuery) : undefined;
  const inferredIntentKind: ProductSearchIntentKind = mode === "keyword"
    ? "keyword"
    : suppliedTarget?.aiExtracted || (suppliedTarget && productFingerprintStrength(suppliedTarget) >= 2)
      ? "fingerprint"
      : "named_product";
  // AI 抽取过的指纹永远走 fingerprint 分支：named_product 分支会用启发式重算并
  // 覆盖掉抽取结果，那正是这次要消灭的东西。
  const intentKind: ProductSearchIntentKind = mode === "keyword"
    ? "keyword"
    : suppliedTarget?.aiExtracted ? "fingerprint" : input.intentKind ?? inferredIntentKind;
  const target = mode === "exact_product" ? normalizeProductFingerprint(intentKind === "named_product" ? {
    // Named-product intent is re-derived from the user's canonical name on
    // every run. This repairs legacy dossiers whose old parser persisted a
    // generic product noun (for example アートブック) as a character/alias.
    ...derivedTarget,
    ...(suppliedTarget?.referenceUrl ? { referenceUrl: suppliedTarget.referenceUrl } : {}),
    ...(suppliedTarget?.manufacturer ? { manufacturer: suppliedTarget.manufacturer } : {}),
    ...(suppliedTarget?.series ? { series: suppliedTarget.series } : {}),
    ...(suppliedTarget?.model ? { model: suppliedTarget.model } : {}),
    ...(suppliedTarget?.jan ? { jan: suppliedTarget.jan } : {}),
    canonicalName: derivedTarget?.canonicalName ?? originalQuery ?? suppliedTarget?.canonicalName,
    aliases: derivedTarget?.aliases ?? [],
    recallQueries: suppliedTarget?.recallQueries ?? [],
    requiredTermGroups: suppliedTarget?.requiredTermGroups ?? [],
    supportingTermGroups: suppliedTarget?.supportingTermGroups ?? [],
    excludedTerms: suppliedTarget?.excludedTerms ?? [],
  } : {
    ...derivedTarget,
    ...suppliedTarget,
    canonicalName: suppliedTarget?.canonicalName ?? derivedTarget?.canonicalName ?? originalQuery,
    characters: suppliedTarget?.aiExtracted
      ? suppliedTarget.characters
      : suppliedTarget?.characters.length ? suppliedTarget.characters : derivedTarget?.characters ?? [],
    aliases: uniqueTerms([...(suppliedTarget?.aliases ?? []), ...(derivedTarget?.aliases ?? [])]),
    excludedTerms: suppliedTarget?.excludedTerms ?? [],
  }) : undefined;
  /**
   * 查询候选池。
   *
   * 关键变化（计划 §6.3）：**先构造全部合法候选，再排序分配名额**。
   *
   * 旧写法是「边生成边占坑」——`add()` 一到 5 条就不再收。而生成顺序是
   * 原始标题 → 召回别名 ×4 → JAN → 型号 → 厂商 → 系列 → 尺寸，于是名额永远被
   * 前五条吃光，**JAN 和型号这两条最强的查询从来没被发出去过**。商品代码是
   * §8.2 路径 A 的唯一依据，它进不了查询，整条路径就是摆设。
   */
  const pool: PlannedQueryCandidate[] = [];
  const seen = new Set<string>();
  const offer = (
    kind: SearchQueryKind,
    purpose: PlannedQueryPurpose,
    weight: number,
    parts: readonly (string | undefined)[],
    anchors: readonly (string | undefined)[],
    lane: SearchQueryVariant["lane"] = "source_native",
  ) => {
    const query = boundedQuery(parts);
    const key = `${lane}:${compact(query)}`;
    if (!query || seen.has(key)) return;
    seen.add(key);
    pool.push({
      query,
      kind,
      purpose,
      weight,
      lane,
      anchors: uniqueTerms(anchors),
    });
  };

  if (mode === "keyword" && originalQuery) {
    pool.push({
      query: originalQuery,
      kind: "original",
      purpose: "precise",
      weight: 1,
      lane: "source_native",
      anchors: [],
    });
    seen.add(`source_native:${compact(originalQuery)}`);
  } else {
    // 完整官方标题保留一枪，但不再当主力：卖家几乎不会把它原样写完。
    offer("original", "precise", 0.82, [originalQuery], [originalQuery]);
  }
  if (mode === "exact_product" && target) {
    const character = target.characters[0];
    const anchor = character ?? target.workTitle ?? originalQuery;
    // 可靠的完整商品代码可以独立成为标识符查询（§6.2）。它不需要品类陪绑。
    if (target.jan) offer("identifier", "identifier", 1, [target.jan], [target.jan]);
    if (target.model) offer("identifier", "identifier", 0.98, [anchor, target.model], [target.model]);
    // 版本/限定词是这个领域辨识度最高的一类词：同作品、同角色、同品类的
    // 兄弟款，区别几乎全在这里。所以它必须是**独立的查询轴**，能单独跟主体或品类
    // 组队；旧写法里它只能做「主体 + 版本 + 品类」三连的一截，而三连一长，
    // 卖家少写任何一个词就搜不到了。
    const editionAxis = editionQueryAxis(target);
    const edition = editionAxis ? editionQueryTerm(editionAxis) : undefined;
    if (edition) {
      if (character) offer("edition", "precise", 0.96, [character, edition], [character, edition]);
      if (target.productType) {
        offer("edition", "precise", 0.84, [target.productType, edition], [target.productType, edition]);
      }
      if (character && target.productType) {
        offer("edition", "precise", 0.88, [character, edition, target.productType],
          [character, edition, target.productType]);
      }
    }
    // 主体 + 品类：单搜角色垃圾太多，单搜品类跨 IP，两个一起候选量骤降。
    // 它过去被归在 bounded_fallback（最后一档），5 个名额从来轮不到它。
    if (character && target.productType) {
      offer("alias", "precise", 0.92, [character, target.productType], [character, target.productType]);
    }
    // 用户/抽取器给的具体召回表达。卖家写「冴えカノ」时，只发完整正式名根本搜不到。
    // 它是具体查询而不是兜底，所以和版本轴、主体+品类同档参与排序。
    for (const recallQuery of target.recallQueries ?? []) {
      offer("alias", "precise", 0.9, [recallQuery], [recallQuery]);
    }
    // 以下三条是「往主体上再加一个属性」的组合。它们的判别力明显低于版本词，
    // 所以排在版本轴之后：加的词越多越像官方标题，越不像卖家会写的标题。
    if (target.manufacturer) {
      offer("manufacturer", "precise", 0.72, [anchor, target.productType, target.manufacturer],
        [anchor, target.productType]);
    }
    if (target.series) {
      offer("series", "precise", 0.68, [anchor, target.productType, target.series], [anchor, target.productType]);
    }
    if (target.size) {
      offer("size", "precise", 0.6, [anchor, target.productType, target.size, target.color],
        [anchor, target.productType]);
    }
    if (target.workTitle && target.productType) {
      offer("alias", "bounded_fallback", 0.55, [target.workTitle, target.productType],
        [target.workTitle, target.productType]);
    }
    // A named-product search is literal by contract: the user already supplied
    // the concrete title. Auto-derived aliases remain local matching evidence
    // and are never sent upstream. Fingerprint searches may use aliases only
    // when the stable identity anchor and product type remain in the query.
    if (intentKind === "fingerprint") {
      for (const alias of target.aliases) {
        const requiredAnchors = uniqueTerms([anchor, target.productType]);
        const aliasKeepsIdentity = requiredAnchors.every((value) => includesValue(alias, value));
        offer(
          "alias",
          "bounded_fallback",
          0.72,
          aliasKeepsIdentity ? [alias] : [...requiredAnchors, alias],
          aliasKeepsIdentity ? [alias] : requiredAnchors,
        );
      }
    }
  }

  const gated = mode === "exact_product" && target
    ? pool.filter((candidate) => candidate.lane !== "source_native"
      || plannedQueryPassesGate(candidate, target, originalQuery))
    : pool;
  const variants: SearchQueryVariant[] = rankPlannedQueries(gated)
    .filter((candidate) => candidate.lane === "source_native")
    .slice(0, 5)
    .map((candidate, index) => ({
      id: `${candidate.kind}-${index + 1}`,
      query: candidate.query,
      kind: candidate.kind,
      weight: candidate.weight,
      lane: candidate.lane,
      purpose: candidate.purpose,
      anchors: candidate.anchors,
    }));

  const warnings: string[] = [];
  if (intentKind === "named_product" && compact(originalQuery).length < 6) {
    warnings.push("商品名较短，可能只代表角色或作品；请尽量填写包含系列、品类和角色的完整日文商品名。");
  }
  return {
    version: PRODUCT_SEARCH_PLAN_VERSION,
    intentVersion: PRODUCT_SEARCH_INTENT_VERSION,
    intentKind,
    mode,
    originalQuery,
    ...(target ? { target } : {}),
    variants,
    deepSearch: false,
    warnings,
  };
}

function searchableListingText(listing: NormalizedListing): string {
  const facts = listing.facts;
  return normalizeProductSearchText([
    listing.title,
    listing.descriptionExcerpt,
    facts?.brand,
    facts?.manufacturer,
    facts?.workTitle,
    facts?.series,
    ...(facts?.characters ?? []),
    ...(facts?.categoryPath ?? []),
    ...(facts?.tags ?? []),
    ...(facts?.specifications?.flatMap((item) => [item.name, item.value]) ?? []),
  ].filter(Boolean).join(" "));
}

function matchKey(value: string): string {
  return normalizeProductSearchText(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}

function characterBigrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

/**
 * Share of the target name's character bigrams that appear in the candidate
 * text. Sellers reorder segments, drop bracketed qualifiers and omit the maker
 * prefix, which defeats whole-token containment even when the listing is
 * unmistakably the same product. Bigram overlap is order-independent and
 * survives those edits.
 *
 * The generic half of the name (category, size, color) is removed first: without
 * that, `ユリウス ぬいぐるみ` would half-match every plush toy. A target left with
 * fewer than six identity characters carries no usable signal and scores zero.
 */
function targetNameCoverage(
  canonicalName: string,
  genericValues: readonly string[],
  candidateText: string,
): number {
  const identity = genericValues.reduce(
    (value, generic) => value.split(normalizeProductSearchText(generic)).join(" "),
    normalizeProductSearchText(canonicalName),
  );
  const targetKey = matchKey(identity);
  const candidateKey = matchKey(candidateText);
  if (targetKey.length < 6 || candidateKey.length < 4) return 0;
  const targetBigrams = characterBigrams(targetKey);
  if (targetBigrams.size === 0) return 0;
  const candidateBigrams = characterBigrams(candidateKey);
  let matched = 0;
  for (const value of targetBigrams) if (candidateBigrams.has(value)) matched += 1;
  return matched / targetBigrams.size;
}

function includesValue(searchable: string, value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeProductSearchText(value);
  return searchable.includes(normalized) || (compact(normalized).length >= 2 && compact(searchable).includes(compact(normalized)));
}

function listingIdentifier(listing: NormalizedListing, name: "jan" | "modelNumber"): string | undefined {
  const factsValue = listing.facts?.identifiers?.[name];
  const rawIdentifiers = listing.rawMetadata?.identifiers;
  const rawValue = rawIdentifiers && typeof rawIdentifiers === "object" && !Array.isArray(rawIdentifiers)
    ? (rawIdentifiers as Record<string, unknown>)[name]
    : undefined;
  return normalizedIdentifier(factsValue ?? (typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue) : undefined));
}

function listingSize(listing: NormalizedListing): string | undefined {
  const specification = listing.facts?.specifications?.find((item) => /(?:size|サイズ|寸法|全長|大きさ|尺寸)/iu.test(item.name));
  if (specification?.value) return specification.value;
  // 颜色一直有标题兜底而尺寸没有，于是 `ネイビー` 对 `グレー` 会判出颜色冲突，
  // `Mサイズ` 对 `Lサイズ` 却一路满分通过。服饰类卖家几乎只把尺码写在标题里，
  // 这里用与目标侧同一个 detectedSize 读标题，让两侧抽取对称。
  return detectedSize([listing.title, listing.descriptionExcerpt].filter(Boolean).join(" "))
    ?? listing.descriptionExcerpt?.match(/(?:全長|約|サイズ[:：]?)?\s*\d+(?:\.\d+)?\s*(?:cm|mm)/iu)?.[0];
}

function listingColor(listing: NormalizedListing): string | undefined {
  const specification = listing.facts?.specifications?.find((item) => /(?:color|カラー|色|色名|颜色)/iu.test(item.name));
  if (specification?.value) return specification.value;
  return detectedColor([listing.title, listing.descriptionExcerpt].filter(Boolean).join(" "));
}

function explicitConflict(target: string | undefined, candidate: string | undefined): boolean {
  return Boolean(target && candidate && compact(target) !== compact(candidate));
}

/**
 * 商品名里的一个词是不是完全由已知槽位拼出来的（例如 `A3プリモアート` = 尺寸 `A3`
 * ＋ 品类 `プリモアート`），拼完没有剩余。
 *
 * 为什么要判这个：`canonicalIdentityTokens` 那道过滤用的是**等值**比较，所以尺寸单独
 * 成词（`Lサイズ`）时能被认出来当软属性，一旦和品类粘成一个词就认不出来，整块被当成
 * 原子身份词。于是卖家写「深崎暮人イラスト使用プリモアート」（没写 A3）就被判成缺身份，
 * 而写「グレー Lサイズ パーカー」的同一类缺失却不算——同一件事两种判法。
 * 2026-09-06 生产实例：mercari m11562761890 ¥40,000，`missing: ["A3プリモアート"]`。
 *
 * 拼得出来就不再当原子身份词：硬的那部分（品类）本来就单独进了身份词全集，
 * 软的那部分（尺寸 / 颜色）交回它自己的 `explicitConflict`——写了 A4 才是反证，
 * 没写只是没写（AGENTS.md §4）。
 */
function composedOfKnownParts(token: string, parts: readonly (string | undefined)[]): boolean {
  const known = uniqueTerms(parts).map(compact).filter((value) => value.length >= 2)
    // 先啃长的，避免 `A3` 先被吃掉后 `A3プリモアート` 剩下的部分对不上。
    .sort((left, right) => right.length - left.length);
  if (known.length === 0) return false;
  let remainder = compact(token);
  if (!remainder) return false;
  let consumed = false;
  for (const part of known) {
    if (!remainder.includes(part)) continue;
    remainder = remainder.split(part).join("");
    consumed = true;
    if (!remainder) break;
  }
  return consumed && remainder.length === 0;
}

function configuredTermGroup(value: string): string[] {
  return value.split(/[|｜]/u).map((term) => term.trim()).filter(Boolean);
}

function matchingConfiguredTerm(searchable: string, group: string): string | undefined {
  return configuredTermGroup(group).find((term) => includesValue(searchable, term));
}

/** 目标名里所有可能承载身份的词，供词频统计与加权共用。 */
function targetIdentityVocabulary(target: ProductFingerprint): string[] {
  return uniqueTerms([
    target.workTitle,
    ...(target.canonicalName?.split(/\s+/u) ?? []),
    ...target.characters,
    ...(target.edition ?? []),
    target.manufacturer,
    target.series,
    target.model,
  ]).filter((value) => compact(value).length >= 2);
}

/**
 * 统计目标身份词在本轮候选集里的出现次数。候选集就是"这件商品的邻居"，
 * 因此这份词频天然回答了"这个系列里什么词是废话、什么词才是区别"。
 */
export function buildProductMatchCorpus(
  listings: readonly NormalizedListing[],
  target: ProductFingerprint,
): ProductMatchCorpus {
  const vocabulary = targetIdentityVocabulary(target);
  const documentFrequency: Record<string, number> = {};
  const texts = listings.map((listing) => searchableListingText(listing));
  for (const term of vocabulary) {
    const key = matchKey(term);
    if (!key) continue;
    documentFrequency[key] = texts.filter((text) => includesValue(text, term)).length;
  }
  return { documentCount: listings.length, documentFrequency };
}

/**
 * 判别力权重：出现在几乎每条候选里的词接近 0 分，只有少数候选带的词接近满分。
 * 候选太少时退回等权，避免小样本把权重算成噪音。
 */
function termDiscriminativeWeight(value: string, corpus: ProductMatchCorpus | undefined): number {
  if (!corpus || corpus.documentCount < 4) return 1;
  const frequency = corpus.documentFrequency[matchKey(value)];
  if (frequency === undefined || frequency <= 0) return 1;
  return Math.max(0.15, 1 - frequency / corpus.documentCount);
}

/** 一行中文差异说明，直接给用户看：这条和你的目标差在哪。 */
/**
 * 只渲染"目标声明了、商品没写"的软属性。身份已经成立时，这行是用户下单前唯一需要
 * 自己核的一项，所以它必须跟着"确认同款"一起送出去，而不是被判定理由覆盖掉。
 */
export function describeProductMatchUnconfirmed(
  difference: ProductMatchDifference | undefined,
): string {
  const unconfirmed = difference?.unconfirmed ?? [];
  if (unconfirmed.length === 0) return "";
  return `${unconfirmed.slice(0, 2).join("、")} 商品未注明，请自行核对`;
}

export function describeProductMatchDifference(
  difference: ProductMatchDifference | undefined,
): string {
  if (!difference) return "";
  const parts: string[] = [];
  if (difference.missing.length > 0) parts.push(`缺少「${difference.missing.slice(0, 3).join("、")}」`);
  if (difference.conflicting.length > 0) parts.push(`存在${difference.conflicting.slice(0, 2).join("、")}`);
  if (parts.length === 0) {
    if (difference.matched.length === 0) return "";
    // 身份成立时才提软属性。已经在报"缺了哪个词"的时候再加一句"尺寸没注明"只是噪音，
    // 而这里它是用户下单前唯一需要自己核的一项。
    const unconfirmed = describeProductMatchUnconfirmed(difference);
    return `身份要素全部命中：${difference.matched.slice(0, 3).join("、")}`
      + (unconfirmed ? `；${unconfirmed}` : "");
  }
  return `与目标相比${parts.join("；")}`;
}

export function assessProductMatch(
  listing: NormalizedListing,
  target: ProductFingerprint,
  hits: readonly CandidateHit[] = [],
  corpus?: ProductMatchCorpus,
): ProductMatchAssessment {
  const searchable = searchableListingText(listing);
  // Coverage reads the seller's own words only. Category paths and tag blobs
  // would inflate overlap without saying anything about product identity.
  const listingText = [listing.title, listing.descriptionExcerpt].filter(Boolean).join(" ");
  const genericTargetValues = uniqueTerms([
    target.productType,
    target.size,
    target.color,
    ...target.characters.filter(isGenericProductDescriptor),
    ...target.aliases.filter(isGenericProductDescriptor),
  ]);
  const matchedFields: string[] = [];
  const conflicts: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  const requiredTermGroups = target.requiredTermGroups ?? [];
  const supportingTermGroups = target.supportingTermGroups ?? [];
  const requiredGroupMatches = requiredTermGroups.map((group) => matchingConfiguredTerm(searchable, group));
  const missingRequiredGroups = requiredTermGroups.filter((_group, index) => !requiredGroupMatches[index]);
  const supportingGroupMatches = supportingTermGroups
    .map((group) => matchingConfiguredTerm(searchable, group))
    .filter((value): value is string => Boolean(value));
  if (requiredTermGroups.length > 0 && missingRequiredGroups.length === 0) {
    score += 34;
    matchedFields.push("必要身份组");
    reasons.push(`必要身份组全部命中：${requiredGroupMatches.filter(Boolean).join("、")}`);
  }
  if (supportingGroupMatches.length > 0) {
    score += 18;
    matchedFields.push("同款辅助证据");
    reasons.push(`同款辅助证据命中：${supportingGroupMatches.slice(0, 3).join("、")}`);
  }

  const canonicalName = target.canonicalName;
  let canonicalNameMatched = false;
  let canonicalCoverage = 0;
  let nameCoverage = 0;
  if (canonicalName) {
    canonicalNameMatched = includesValue(searchable, canonicalName);
    const canonicalNameIsSpecific = compact(canonicalName).length >= 6
      || Boolean(target.productType || target.model || target.jan || target.manufacturer || target.series || target.color);
    const canonicalTokens = uniqueTerms(canonicalName.split(/\s+/u))
      .filter((value) => compact(value).length >= 2 && !productNameQualifier(value));
    const matchedCanonicalTokens = canonicalTokens.filter((value) => includesValue(searchable, value));
    // 按批内判别力加权：命中一个全系列都有的作品名，不等于命中一个只有两条候选带的
    // 版本词。等权计数会让兄弟款靠共享的那半个名字堆到确认门槛。
    const tokenWeight = (value: string): number => termDiscriminativeWeight(value, corpus);
    const totalTokenWeight = canonicalTokens.reduce((sum, value) => sum + tokenWeight(value), 0);
    const matchedTokenWeight = matchedCanonicalTokens.reduce((sum, value) => sum + tokenWeight(value), 0);
    canonicalCoverage = totalTokenWeight > 0 ? matchedTokenWeight / totalTokenWeight : 0;
    if (canonicalNameMatched) {
      score += canonicalNameIsSpecific ? 60 : 12;
      matchedFields.push("具体商品名");
      reasons.push(canonicalNameIsSpecific ? "具体日文商品名完整命中" : "较短名称命中，仅作弱证据");
    } else if (canonicalTokens.length >= 2 && canonicalCoverage >= 0.66) {
      score += canonicalCoverage >= 0.99 ? 48 : 35;
      matchedFields.push("商品名核心词");
      reasons.push(`商品名核心词命中 ${matchedCanonicalTokens.length}/${canonicalTokens.length}`);
    } else {
      // Whole-token containment found nothing. Fall back to character-level
      // coverage so a reordered or abbreviated seller title still reaches the
      // semantic review lane instead of being dropped as irrelevant.
      // 字面覆盖同样要先扣掉本轮候选里人人都有的词，否则「作品名 + 品类」两段共享
      // 文本就能凑出 65% 的覆盖率——这正是 2026-09-05 那次误报过线的来源。
      const boilerplateTerms = corpus && corpus.documentCount >= 4
        ? targetIdentityVocabulary(target)
          .filter((value) => (corpus.documentFrequency[matchKey(value)] ?? 0) / corpus.documentCount >= 0.7)
        : [];
      nameCoverage = targetNameCoverage(canonicalName, [...genericTargetValues, ...boilerplateTerms], listingText);
      if (nameCoverage >= 0.5) {
        score += nameCoverage >= 0.7 ? 40 : 30;
        matchedFields.push("商品名字面覆盖");
        reasons.push(`商品名字面覆盖 ${Math.round(nameCoverage * 100)}%`);
      }
    }
  }

  const targetJan = normalizedIdentifier(target.jan);
  const candidateJan = listingIdentifier(listing, "jan");
  const targetModel = normalizedIdentifier(target.model);
  const candidateModel = listingIdentifier(listing, "modelNumber");
  if (targetJan && candidateJan) {
    if (targetJan === candidateJan) {
      score += 100;
      matchedFields.push("JAN");
      reasons.push("JAN 完全一致");
    } else conflicts.push("JAN 冲突");
  } else if (targetJan && includesValue(searchable, target.jan)) {
    score += 90;
    matchedFields.push("JAN");
    reasons.push("正文命中目标 JAN");
  }
  if (targetModel && candidateModel) {
    if (targetModel === candidateModel) {
      score += 80;
      matchedFields.push("型号");
      reasons.push("型号完全一致");
    } else conflicts.push("型号冲突");
  } else if (target.model && includesValue(searchable, target.model)) {
    score += 58;
    matchedFields.push("型号");
    reasons.push("标题或描述命中目标型号");
  }

  const fieldMatches: Array<[string, string | undefined, number]> = [
    ["厂商", target.manufacturer, 30],
    ["系列", target.series, 24],
    ["作品", target.workTitle, 12],
    ["品类", target.productType, 14],
    ["尺寸", target.size, 18],
    ["颜色", target.color, 16],
  ];
  for (const [name, value, points] of fieldMatches) {
    if (value && includesValue(searchable, value)) {
      score += points;
      matchedFields.push(name);
      reasons.push(`${name}匹配`);
    }
  }
  const matchedEdition = (target.edition ?? []).filter((value) => includesValue(searchable, value));
  if (matchedEdition.length > 0) {
    score += 22;
    matchedFields.push("版本");
    reasons.push(`版本匹配：${matchedEdition.slice(0, 2).join("、")}`);
  }
  const identityCharacters = target.characters.filter((value) => !isGenericProductDescriptor(value));
  const matchedCharacters = identityCharacters.filter((value) => includesValue(searchable, value));
  if (matchedCharacters.length > 0) {
    score += 26;
    matchedFields.push("角色");
    reasons.push(`角色匹配：${matchedCharacters.slice(0, 2).join("、")}`);
  }
  const matchedAlias = target.aliases
    .filter((value) => !genericTargetValues.some((generic) => compact(value) === compact(generic)))
    .filter((value) => includesValue(searchable, value))
    .sort((left, right) => compact(right).length - compact(left).length)[0];
  if (matchedAlias) {
    score += compact(matchedAlias).length >= 6 ? 18 : 8;
    matchedFields.push("别名");
    reasons.push("商品名缩写命中");
  }

  const listingManufacturer = listing.facts?.manufacturer ?? listing.facts?.brand;
  const listingSeries = listing.facts?.series;
  const candidateSize = listingSize(listing);
  const candidateColor = listingColor(listing);
  // 品类写了别的 = 冲突，不是「卖家没写全」。
  //
  // `加藤恵 フィギュア` 不是漏写了「ぬいぐるみ」，它写的就是另一个品类；`ラバスト`、
  // `アクリルスタンド`、`缶バッジ` 同理。旧实现把「没写品类」和「写了别的品类」都记成
  // 缺失，于是有限的详情预算被花在明摆着不是同款的商品上——2026-09-12 实测，10 次
  // 详情里 8 次属于这一类。
  //
  // 三道约束，避免把「卖家换了个说法」误判成冲突：
  //  - 目标自己的品类必须是已知品类词，否则我们并不清楚目标是什么，不该定罪；
  //  - 商品文本里一旦出现目标品类（哪怕在正文或分类里），就不算冲突；
  //  - 只看**标题**里声明的品类。正文提一句「他にアクリルスタンドもあります」不是
  //    这条挂牌在卖的东西。
  const targetProductType = target.productType;
  const declaredOtherProductType = targetProductType
    && namedProductTypes.some((value) => compact(value) === compact(targetProductType))
    && !includesValue(searchable, targetProductType)
    ? namedProductTypes.find((value) => !includesValue(targetProductType, value)
      && !includesValue(value, targetProductType)
      && includesValue(normalizeProductSearchText(listing.title), value))
    : undefined;
  if (declaredOtherProductType) conflicts.push(`品类冲突：${declaredOtherProductType}`);
  if (explicitConflict(target.manufacturer, listingManufacturer)) conflicts.push("厂商冲突");
  if (explicitConflict(target.series, listingSeries)) conflicts.push("系列冲突");
  if (explicitConflict(target.size, candidateSize)) conflicts.push("尺寸冲突");
  if (explicitConflict(target.color, candidateColor)) conflicts.push("颜色冲突");
  for (const excluded of target.excludedTerms) {
    const matchedExcluded = matchingConfiguredTerm(searchable, excluded);
    if (matchedExcluded) conflicts.push(`排除词：${matchedExcluded}`);
  }

  const canonicalIdentityTokens = canonicalName
    ? uniqueTerms(canonicalName.split(/\s+/u)).filter((value) => compact(value).length >= 2
      && !productNameQualifier(value)
      && !genericTargetValues.some((generic) => compact(value) === compact(generic))
      // 等值比不出来的粘连词（`A3プリモアート`）走成分拆解，见 composedOfKnownParts。
      && !composedOfKnownParts(value, genericTargetValues))
    : [];
  const matchedCanonicalIdentityTokens = canonicalIdentityTokens.filter((value) => includesValue(searchable, value));
  // 目标的身份要素全集。商品名里凡是不属于通用描述（品类 / 尺寸 / 颜色 / 通用名词）
  // 的词都算数——版本标记 `♭`、`Fes. Fine`、`レーシングVer.`、`F：NEX限定` 正是靠
  // 这条被保住的：它们在 canonicalName 里原样存在，不需要任何词表去认。
  // 同一个判别符会以多种粒度出现：`冴えない彼女の育てかた♭` 这个整词、以及版本字段里
  // 单独的 `♭`。两个都报给用户是噪音，保留信息量更大的长词即可。
  const rawIdentityTerms = uniqueTerms([
    target.workTitle,
    ...canonicalIdentityTokens,
    ...identityCharacters,
    ...(target.edition ?? []),
    // 品类在这里算身份：`メダリスト展 公式図録` 缺 `アートブック` 就不是同一件商品。
    // 卖家省略品类词时会落到"证据不足"，由摘要的疑似分区兜住，不会消失。
    target.productType,
    target.manufacturer,
    target.series,
    target.model,
  ]);
  // 抽取器允许把作品名补成官方全名（`高木さん` → `からかい上手の高木さん`，见 docs §6.1），
  // 但补出来的词不能反过来当成必须命中的身份要素：那等于要求卖家写出**用户自己都没写**
  // 的词，标题与目标逐字相同的真品会因此判成缺身份（`高木さん からかいパーカー グレー
  // Lサイズ` 实测 100 分却 uncertain）。补全值仍然参与加分与召回，只是不做负证据。
  // 只对抽取过的指纹生效：启发式指纹的槽位本来就从商品名切出来，而用户在建档表单里
  // 手填的厂商 / 系列 / 型号是显式输入，不该被商品名反过来否决。
  const targetNameText = target.aiExtracted && canonicalName
    ? normalizeProductSearchText(canonicalName)
    : undefined;
  const evidencedIdentityTerms = targetNameText
    ? rawIdentityTerms.filter((value) => includesValue(targetNameText, value))
    : rawIdentityTerms;
  const identityTerms = evidencedIdentityTerms.filter((value) => !evidencedIdentityTerms
    .some((other) => other !== value && compact(other).includes(compact(value))));
  // 纯符号的版本标记（`冴えない彼女の育てかた♭` 的 `♭`）。compact 会把符号整个打掉，
  // 于是 `冴えない彼女の育てかた♭` 和 `冴えない彼女の育てかた` 比出来是同一个词——
  // 2026-10-11 实查，Fes. Fine 版就是这样被当成"作品名命中"，再由 AI 判成确认同款的。
  // 这类标记单独按原字符核对，不经过 compact。
  const versionMarkers = uniqueRawValues((target.edition ?? []).filter((value) => compact(value) === ""));
  const missingVersionMarkers = versionMarkers
    .filter((value) => !searchable.includes(normalizeProductSearchText(value)));
  const targetTypeIsKnown = Boolean(targetProductType
    && namedProductTypes.some((value) => compact(value) === compact(targetProductType)));
  const missingProductType = targetProductType && targetTypeIsKnown
    && !includesValue(searchable, targetProductType)
    && !namedProductTypes.some((value) => compact(value) !== compact(targetProductType)
      && includesValue(targetProductType, value)
      && includesValue(searchable, value))
    ? targetProductType
    : undefined;
  const missingIdentityTerms = [
    ...missingVersionMarkers,
    ...identityTerms.filter((value) => !includesValue(searchable, value)),
  ];
  // 尺寸与颜色是软属性：既没证实也没反证时不算缺身份，只如实告诉用户这一项没核上。
  // 有反证（尺寸冲突 / 颜色冲突）的已经落进 conflicts，不会走到这里。
  const unconfirmedAttributes = uniqueTerms([
    target.size && !includesValue(searchable, target.size) && !explicitConflict(target.size, candidateSize)
      ? `尺寸 ${target.size}` : undefined,
    target.color && !includesValue(searchable, target.color) && !explicitConflict(target.color, candidateColor)
      ? `颜色 ${target.color}` : undefined,
  ]);
  const extraDistinguishers = candidateExtraDistinguishers(listing.title, target);
  const difference: ProductMatchDifference = {
    matched: [
      ...versionMarkers.filter((value) => !missingVersionMarkers.includes(value)),
      ...identityTerms.filter((value) => includesValue(searchable, value)),
    ],
    missing: missingIdentityTerms,
    ...(missingVersionMarkers.length > 0 ? { missingVersionMarkers } : {}),
    ...(missingProductType ? { missingProductType } : {}),
    conflicting: [...new Set(conflicts)],
    ...(unconfirmedAttributes.length > 0 ? { unconfirmed: unconfirmedAttributes } : {}),
    ...(extraDistinguishers.length > 0 ? { extraDistinguishers } : {}),
  };
  const hasTextualIdentityAnchor = canonicalNameMatched
    || matchedCanonicalIdentityTokens.length > 0
    || matchedCharacters.length > 0
    || Boolean(matchedAlias)
    || nameCoverage >= 0.5
    || matchedFields.some((field) => ["JAN", "型号", "厂商", "系列", "作品"].includes(field));
  const supportsExactMatch = productFingerprintSupportsExactMatch(target);
  // Source rank is provenance, not proof of relevance. Yahoo/Amazon may return
  // OR matches or recommendations when the full query has no result, so only
  // use a high-ranked query hit after the candidate text independently matches
  // an identity-bearing target field.
  const strongHit = hasTextualIdentityAnchor && (hits.some((hit) => hit.kind === "identifier")
    || hits.some((hit) => ["manufacturer", "series", "size"].includes(hit.kind) && hit.upstreamRank <= 10)
    || Boolean(canonicalName && compact(canonicalName).length >= 6
      && hits.some((hit) => hit.kind === "original" && hit.upstreamRank <= 10)));
  const strongestIndexedHit = hits
    .filter((hit) => hit.upstreamRank <= 10 && ["identifier", "manufacturer", "series", "size"].includes(hit.kind))
    .sort((left, right) => right.weight - left.weight || left.upstreamRank - right.upstreamRank)[0];
  if (hasTextualIdentityAnchor && strongestIndexedHit && !matchedFields.includes("JAN") && !matchedFields.includes("型号")) {
    const inferred = strongestIndexedHit.kind === "identifier"
      ? { points: 42, field: "型号 / JAN（来源索引）" }
      : strongestIndexedHit.kind === "manufacturer"
        ? { points: 20, field: "厂商（来源索引）" }
        : strongestIndexedHit.kind === "series"
          ? { points: 17, field: "系列（来源索引）" }
          : { points: 13, field: "尺寸（来源索引）" };
    score += inferred.points;
    matchedFields.push(inferred.field);
    reasons.push(`${inferred.field}命中；等待详情字段复核`);
  }
  if (strongHit) {
    score += 12;
    reasons.push("由高辨识度查询召回");
  }
  // A lot is declared in the title. A spec sheet that lists 「セット内容」 for one
  // boxed product is a packing list, and reading it here demoted exact matches
  // to `bundle` — a relation that is excluded from AI review and hidden from
  // the default result view.
  const isBundle = bundlePattern.test(normalizeProductSearchText(listing.title));
  const hasHardConflict = conflicts.some((value) => value.startsWith("JAN") || value.startsWith("型号") || value.startsWith("排除词"));
  // 品类不同不是「同系列的另一个版本」，是另一样东西，按硬冲突处理。
  const hasHardProductTypeConflict = conflicts.some((value) => value.startsWith("品类冲突"));
  const hasVariantConflict = conflicts.some((value) => value.includes("厂商")
    || value.includes("系列")
    || value.includes("尺寸")
    || value.includes("颜色"));
  if (hasHardConflict || hasHardProductTypeConflict) score -= 90;
  else if (hasVariantConflict) score -= 38;
  if (isBundle) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let relation: ProductMatchRelation;
  if (missingRequiredGroups.length > 0) relation = "irrelevant";
  else if (!hasTextualIdentityAnchor) relation = "irrelevant";
  else if (!hasHardConflict && (matchedFields.includes("JAN") || matchedFields.includes("型号")) && score >= 85) relation = isBundle ? "bundle" : "exact";
  else if (isBundle && (matchedCharacters.length > 0 || score >= 35)) relation = "bundle";
  else if (hasHardProductTypeConflict) relation = "related";
  else if (hasHardConflict || (hasVariantConflict && score >= 20)) relation = "variant";
  // 缺一个身份要素就不叫同款。作品名被卖家缩写（冴えカノ）也会落到这里——那是
  // 正确的：证据确实不足，按 §4 降到 uncertain 交给人判断，而不是丢掉。
  else if (supportsExactMatch && score >= 68 && missingIdentityTerms.length === 0
    && (matchedCharacters.length > 0
    || canonicalNameMatched
    || canonicalCoverage >= 0.66
    || (requiredTermGroups.length > 0 && supportingGroupMatches.length > 0))) relation = "probable_exact";
  else if (supportsExactMatch && score >= 68 && missingIdentityTerms.length > 0) relation = "uncertain";
  else if (score >= 24) relation = "related";
  else if (score === 0 && !strongHit) relation = "irrelevant";
  else relation = "uncertain";

  if (missingIdentityTerms.length > 0) {
    reasons.unshift(`目标名中未出现于本商品：${missingIdentityTerms.slice(0, 3).join("、")}`);
  }
  const confidence = relation === "exact" || hasHardConflict ? "high" : score >= 55 ? "medium" : "low";
  return {
    version: PRODUCT_MATCH_VERSION,
    relation,
    difference,
    score,
    confidence,
    matchedFields: [...new Set(matchedFields)],
    conflicts: [...new Set(conflicts)],
    reasons: [...new Set(reasons)].slice(0, 8),
  };
}

export function reciprocalRankFusion(hits: readonly CandidateHit[]): number {
  const perVariant = new Map<string, CandidateHit>();
  for (const hit of hits) {
    const current = perVariant.get(hit.variantId);
    if (!current || hit.upstreamRank < current.upstreamRank) perVariant.set(hit.variantId, hit);
  }
  const score = [...perVariant.values()].reduce((total, hit) => total + hit.weight / (60 + Math.max(1, hit.upstreamRank)), 0);
  return Number((score * 10_000).toFixed(4));
}

export function searchCandidateEvidence(
  hits: readonly CandidateHit[],
  match?: ProductMatchAssessment,
): SearchCandidateEvidence {
  return {
    hits: [...hits].sort((left, right) => right.weight - left.weight || left.upstreamRank - right.upstreamRank),
    fusedScore: reciprocalRankFusion(hits),
    bestRank: Math.min(...hits.map((hit) => hit.upstreamRank), Number.MAX_SAFE_INTEGER),
    historical: hits.length > 0 && hits.every((hit) => hit.lane === "historical_index"),
    liveVerified: hits.some((hit) => hit.liveVerified),
    ...(match ? { match } : {}),
  };
}

export function compareProductSearchCandidates(
  left: SearchCandidateEvidence | undefined,
  right: SearchCandidateEvidence | undefined,
): number {
  const relationOrder: Record<ProductMatchRelation, number> = {
    exact: 0,
    probable_exact: 1,
    bundle: 2,
    variant: 3,
    related: 4,
    uncertain: 5,
    irrelevant: 6,
  };
  const leftRelation = left?.match?.relation ?? "uncertain";
  const rightRelation = right?.match?.relation ?? "uncertain";
  return relationOrder[leftRelation] - relationOrder[rightRelation]
    || (right?.match?.score ?? 0) - (left?.match?.score ?? 0)
    || (right?.fusedScore ?? 0) - (left?.fusedScore ?? 0)
    || (left?.bestRank ?? Number.MAX_SAFE_INTEGER) - (right?.bestRank ?? Number.MAX_SAFE_INTEGER);
}

export interface ProductSearchAiReviewCandidate {
  key: string;
  evidence?: SearchCandidateEvidence;
}

/**
 * 这条候选是否已经被程序判完。
 *
 * 两种情况不需要模型介入，因为程序自己就能证明：
 *
 * - 存在可核查的字段冲突（JAN / 型号 / 排除词 / 厂商 / 系列 / 尺寸 / 颜色）；
 * - 与目标没有任何身份重叠。
 *
 * 其余一律不算判完。特别是两种以前被掉在外面的：
 *
 * - `bundle`：来自标题上的「セット」正则。一件商品的包装清单和三件商品的
 *   套装在标题层分不开，需要语义复核才能判销售对象；
 * - 标题缩写导致缺了身份组的 `irrelevant`：只要还有部分身份要素命中，
 *   它就不是「无关」，是「卖家没写全」。2026-09-05 那条真品就死在这里。
 */
export function productMatchDeterministicallySettled(match: ProductMatchAssessment): boolean {
  if (match.conflicts.length > 0) return true;
  if ((match.difference?.conflicting.length ?? 0) > 0) return true;
  return match.relation === "irrelevant" && (match.difference?.matched.length ?? 0) === 0;
}

/**
 * 选出需要语义复核的候选。
 *
 * 这里不再按 relation 白名单挑人，而是反过来：**凡是程序没能判完的都该进**。
 * 白名单的毛病在于，被排除的候选不是“不需要复核”，而是“永远拿不到复核”，
 * 而下游又把“没复核”当成了结论。
 *
 * 上限先保留：把它换成任务期限内的分批队列是 P3 的范围，这一步只保证
 * 同样的 24 个名额花在真正没判完的候选上，而不是花在排序靠前的啦。
 */
export function selectProductSearchAiReviewCandidates<T extends ProductSearchAiReviewCandidate>(
  candidates: readonly T[],
  limit = PRODUCT_SEARCH_AI_REVIEW_LIMIT,
): T[] {
  const boundedLimit = Math.max(0, Math.min(PRODUCT_SEARCH_AI_REVIEW_LIMIT, Math.floor(limit)));
  if (boundedLimit === 0) return [];
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      const match = candidate.evidence?.match;
      if (!match) return false;
      // exact 且无冲突已经由文本证明身份，不占用复核名额。
      if (match.relation === "exact") return false;
      return !productMatchDeterministicallySettled(match);
    })
    .sort((left, right) => compareProductSearchCandidates(left.evidence, right.evidence))
    .slice(0, boundedLimit);
}

/**
 * 本轮没能判完、也没拿到复核名额的候选数。
 *
 * 它必须被记下来：计划 §9.3 要求“达到预算后，未解决候选仍未解决，不作拒绝，
 * 完成多少、缺哪一段覆盖要准确展示”。没有这个数，“已全部判定”就可以随口写。
 */
export function countProductSearchUnreviewedCandidates<T extends ProductSearchAiReviewCandidate>(
  candidates: readonly T[],
  selected: readonly T[],
): number {
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.key) || selectedKeys.has(candidate.key)) return false;
    seen.add(candidate.key);
    const match = candidate.evidence?.match;
    if (!match) return true;
    return match.relation !== "exact" && !productMatchDeterministicallySettled(match);
  }).length;
}

/* ------------------------------------------------------------------ *
 * 详情动作调度（计划 §7.3）
 * ------------------------------------------------------------------ */

/** 来源对**这一条商品**的详情能力。不支持是能力问题，不是身份冲突（计划 §6.8）。 */
export type CandidateDetailCapability = "supported" | "unsupported_item" | "unsupported_source";

/** 这次详情预计能解决什么。顺序即优先级依据，不是固定的 relation 排序。 */
export type CandidateDetailActionReason =
  /** 高区分查询召回，但卖家标题写得简略，正文里才可能有版本。 */
  | "terse_title_after_high_signal_query"
  /** 只差一个关键身份要素。 */
  | "single_identity_gap"
  /** 标题层判为套装，实际卖的是什么还没判清。 */
  | "sale_unit_unresolved"
  /** 缺多个身份要素，但确实有身份锚点。 */
  | "multiple_identity_gaps"
  /** 身份基本成立，只剩尺寸/颜色这类软属性待核。 */
  | "soft_attribute_verification"
  /** 历史索引来的参考，实时性不高。 */
  | "history_reference";

export interface CandidateDetailPlanInput {
  key: string;
  hits: readonly CandidateHit[];
  match?: ProductMatchAssessment;
  /** 已经抓过详情的不再重复花请求。 */
  detailHydrated?: boolean;
  detailCapability?: CandidateDetailCapability;
  availability?: string;
}

export interface CandidateDetailAction<T> {
  candidate: T;
  reason: CandidateDetailActionReason;
  /** 写给审计看的一句话：这次请求是冲着解决什么去的。 */
  resolves: string[];
  priority: number;
  /** 用来做同源内的轮转，避免一条查询的结果吃掉全部名额。 */
  variantId: string;
}

/** 高辨识度查询：商品代码类查询，以及用户/抽取器给的具体召回表达。 */
function highSignalHit(hits: readonly CandidateHit[]): CandidateHit | undefined {
  return [...hits]
    .filter((hit) => hit.lane === "source_native"
      && (hit.kind === "identifier" || hit.kind === "edition" || hit.kind === "alias"))
    .sort((left, right) => right.weight - left.weight)[0];
}

/**
 * 来源自己给的名次（越小越前）。
 *
 * 平台搜索是按相关度排序的，第一屏就是它认为最像的那几件。我们把这个名次
 * 记下来了却从来不用，挑详情时只看自己算的分——于是有限的几次详情请求撒在了
 * 整页候选里。名次不是同款证据（它还受价格、新旧、卖家影响），所以它只用来
 * 排「先问哪一条」，不参与判定。
 */
function bestUpstreamRank(hits: readonly CandidateHit[]): number {
  const ranks = hits
    .filter((hit) => hit.lane === "source_native")
    .map((hit) => hit.upstreamRank)
    .filter((rank): rank is number => typeof rank === "number" && rank > 0);
  return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
}

const DETAIL_ACTION_PRIORITY: Record<CandidateDetailActionReason, number> = {
  terse_title_after_high_signal_query: 10,
  single_identity_gap: 20,
  sale_unit_unresolved: 30,
  multiple_identity_gaps: 40,
  soft_attribute_verification: 50,
  history_reference: 90,
};

/**
 * 挑出值得花一次详情请求的候选，并说明这次请求要解决什么。
 *
 * 和旧实现（`["exact","probable_exact","uncertain","related"]` 白名单 + 按分数排序）
 * 的两处关键差别：
 *
 * 1. **依据从「关系标签」换成「详情能解决什么」。** 分数高但没有待解决问题的候选
 *    不该占用请求；分数低但只差一个版本词的候选才该优先。
 * 2. **标题缩写导致落到 `irrelevant` 的候选重新进入范围。** 只要还有身份要素命中，
 *    它就不是「无关」，是「卖家没写全」——正文里往往写着完整正式名。旧白名单把
 *    这一类整个排除在外，于是它永远拿不到能救它的那一次请求。
 *
 * 仍然排除两类：程序已经判完的（有可核查冲突、或与目标零重叠），以及来源对这条
 * 商品根本不支持详情的。后者是能力问题，调用方要如实记录，不能消耗一连串必然
 * 失败的请求，也不能把它当成「不是同款」。
 */
export function planCandidateDetailActions<T extends CandidateDetailPlanInput>(
  candidates: readonly T[],
  limit: number,
): CandidateDetailAction<T>[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const actions: CandidateDetailAction<T>[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (candidate.detailHydrated) continue;
    if ((candidate.detailCapability ?? "supported") !== "supported") continue;
    const match = candidate.match;
    if (!match) continue;
    if (productMatchDeterministicallySettled(match)) continue;

    const difference = match.difference;
    const missing = difference?.missing ?? [];
    const matched = difference?.matched ?? [];
    const unconfirmed = difference?.unconfirmed ?? [];
    // 身份锚点是入场券：一个身份要素都没命中、又不是匹配器认可的同款候选时，
    // 详情请求救不回它，只会把预算花在噪声上。
    const hasAnchor = matched.length > 0
      || match.relation === "exact"
      || match.relation === "probable_exact";
    if (!hasAnchor) continue;

    const historyOnly = candidate.hits.every((hit) => hit.lane !== "source_native");
    const signal = highSignalHit(candidate.hits);

    let reason: CandidateDetailActionReason;
    let resolves: string[];
    if (historyOnly) {
      reason = "history_reference";
      resolves = ["历史索引候选，需要详情确认当前身份与状态"];
    } else if (match.relation === "bundle") {
      reason = "sale_unit_unresolved";
      resolves = ["标题含套装词，需要正文确认主售对象是单件还是组合"];
    } else if (missing.length > 0 && signal) {
      reason = "terse_title_after_high_signal_query";
      resolves = [`由高辨识度查询「${signal.query}」召回，标题缺：${missing.slice(0, 3).join("、")}`];
    } else if (missing.length === 1) {
      reason = "single_identity_gap";
      resolves = [`标题缺一个身份要素：${missing[0]}`];
    } else if (missing.length > 1) {
      reason = "multiple_identity_gaps";
      resolves = [`标题缺：${missing.slice(0, 3).join("、")}`];
    } else if (unconfirmed.length > 0) {
      reason = "soft_attribute_verification";
      resolves = [`身份要素已命中，待核软属性：${unconfirmed.slice(0, 2).join("、")}`];
    } else {
      // 没有待解决的问题，就不该花这次请求。
      continue;
    }

    // 在售候选可能随时售出，同等待解决问题下优先。这只改动作顺序，不改身份事实。
    const purchasableBonus = candidate.availability === "available" ? -1 : 0;
    actions.push({
      candidate,
      reason,
      resolves,
      priority: DETAIL_ACTION_PRIORITY[reason] + purchasableBonus,
      variantId: signal?.variantId ?? candidate.hits[0]?.variantId ?? "unknown",
    });
  }

  // 同源内按查询轮转发名额：一条宽查询召回两百条噪声时，它不该把整批预算吃掉，
  // 别的查询召回的少数高价值候选也要排得上（计划 §7.3 末段）。
  const byVariant = new Map<string, CandidateDetailAction<T>[]>();
  for (const action of actions.sort((left, right) => left.priority - right.priority
    || bestUpstreamRank(left.candidate.hits) - bestUpstreamRank(right.candidate.hits)
    || (left.candidate.match?.score ?? 0) - (right.candidate.match?.score ?? 0))) {
    byVariant.set(action.variantId, [...(byVariant.get(action.variantId) ?? []), action]);
  }
  const queues = [...byVariant.values()];
  const ordered: CandidateDetailAction<T>[] = [];
  for (let round = 0; ordered.length < boundedLimit; round += 1) {
    let added = false;
    for (const queue of queues) {
      const action = queue[round];
      if (!action) continue;
      ordered.push(action);
      added = true;
      if (ordered.length >= boundedLimit) break;
    }
    if (!added) break;
  }
  return ordered;
}

export function fingerprintFromListing(listing: NormalizedListing): ProductFingerprint {
  const size = listingSize(listing);
  const color = listingColor(listing);
  return normalizeProductFingerprint({
    referenceUrl: listing.canonicalUrl,
    canonicalName: listing.title,
    workTitle: listing.facts?.workTitle,
    characters: listing.facts?.characters ?? [],
    productType: listing.facts?.categoryPath?.at(-1),
    manufacturer: listing.facts?.manufacturer ?? listing.facts?.brand,
    series: listing.facts?.series,
    model: listing.facts?.identifiers?.modelNumber ?? listing.facts?.identifiers?.sku,
    jan: listing.facts?.identifiers?.jan,
    size,
    color,
    aliases: [listing.title],
    excludedTerms: [],
  })!;
}

export function candidateKey(sourceId: SourceId, sourceItemId: string): string {
  return `${sourceId}:${sourceItemId}`;
}
