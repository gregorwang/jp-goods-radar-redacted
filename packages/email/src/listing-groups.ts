// 日报邮件、基线回执和完整清单页共用的整理规则。只看标题和价格，确定性、零成本，
// 不调 AI。
//
//   - 排序：单品在前、打包放最后；一口价按价格从低到高，拍卖排在一口价后面
//     （拍卖价是当前出价，¥1 起拍会永远排第一，不能和一口价混排）；
//   - 同名折叠：标题去掉噪声词后完全相同的合成一组，组内同样按上面的顺序；
//     上游已经按图片判过同款（sameGroup）时改用那个分组，不再看标题；
//   - 品类：按标题里的词分，分不出的进「其他」，打包件单独一组；
//   - 明显乱填的价格（≤¥1、≥¥1,000,000）和拍卖当前出价不参与中位数和区间。
//
// 这个文件不 import 任何东西，好让本地预览脚本直接用 node 加载（见 scripts/preview-listing-page.mjs）。

export interface GroupableItem {
  title: string;
  price: number | null;
  auction: boolean;
  /** 上游（比如补充信息里的 is_bundle）已经判定是打包件时传 true；标题规则仍会兜底。 */
  bundle?: boolean;
  /** 合不上的商品各自成组时用来区分彼此，通常是 `${sourceId}:${sourceItemId}` 或链接。 */
  identity: string;
  /** 上游按图片判出的同款分组（radar_core.listing_same_groups）。值相同的合成一组；传了就不再按标题合并。 */
  sameGroup?: string;
}

export interface ItemGroup<T extends GroupableItem> {
  key: string;
  /** 已排好序，第一件是代表（最该先看的那件）。 */
  items: T[];
}

export interface ItemCategory<T extends GroupableItem> {
  id: string;
  label: string;
  groups: ItemGroup<T>[];
  count: number;
  median: number | null;
  low: number | null;
  high: number | null;
}

// 明说了两件以上的才算打包：「5点」「2枚セット」「12体」。「1点のみ」「1点物」是单品；
// 光写「セット」的常是官方套装（「Birthday Goods セット」），也不算。
const MANY = String.raw`(?:[2-9]|[1-9]\d+)\s*`;
const BUNDLE = new RegExp(String.raw`(まとめ|セット売り|大量|詰め合わせ|福袋|${MANY}(?:点|体(?!験))|${MANY}(?:個|種|枚|つ|本|冊)\s*セット|bundle|\blot\b)`, "iu");

// 顺序即优先级：一件标题同时含「フィギュア」和「アクリル」时算手办。
// 词表按 2026-10-07 三封邮件（赛车初音 1008 件、鸣濑白羽 872 件、爱蜜莉雅 99 件）补过，
// 「其他」从 22% 压到约 10%。加词时注意别让短词误伤：「マグ」要排在「マグネット」之后，
// 「ケース」要排在「デッキケース」之后。
const CATEGORY_RULES: { id: string; label: string; pattern: RegExp }[] = [
  { id: "model", label: "模型 / 工具", pattern: /(プラモ|プラスチックモデル|PLAMATEA|ミニカー|トミカ|1\/(?:24|43|64)|ニッパー|カッターマット|エアブラシ|ハンディクリーナー|模型|じおらま|model kit)/iu },
  { id: "figure", label: "手办", pattern: /(フィギュア|フィギア|figure|ねんどろいど|nendoroid|figma|プライズ|スケール|1\/[4-8](?!\d)|塗装済み?完成品|ぷちきゃら|ちょこのせ|POP UP PARADE|ESPRESTO|Luminasta|ルミナスタ|Yumemirize|ムチュート|Muchute|Trio-Try-iT|ぬーどるストッパー|ex:ride|SPM|Coreful)/iu },
  { id: "acrylic", label: "亚克力", pattern: /(アクリル|アクスタ|アクキー|スタンド|acrylic)/iu },
  { id: "shikishi", label: "色纸", pattern: /(色紙|(?<!デ)サイン)/iu },
  { id: "badge", label: "徽章", pattern: /(缶バッ[ジチ]|バッジ|ピンズ|メダル|badge)/iu },
  { id: "plush", label: "毛绒 / 抱枕", pattern: /(ぬいぐるみ|マスコット|抱き枕|クッション|plush)/iu },
  { id: "sticker", label: "贴纸 / 磁贴", pattern: /(ステッカー|シール|マグネット|sticker)/iu },
  { id: "poster", label: "挂画 / 海报 / 板", pattern: /(タペストリー|ポスター|クリアファイル|ファイル|パネル|キャンバス|アートボード|ウッドボード|poster|tapestry)/iu },
  { id: "charm", label: "挂件", pattern: /(キーホルダー|キーチェーン|ストラップ|チャーム|keychain)/iu },
  { id: "apparel", label: "服饰", pattern: /(Tシャツ|シャツ|\bTEE\b|パーカー|タオル|コスプレ|衣装|ウィッグ|キャップ|帽子|ジャケット|ハッピ|はっぴ|法被|スニーカー|リストバンド|ブランケット|hoodie)/iu },
  { id: "card", label: "卡片 / 卡牌周边", pattern: /(カード|ブロマイド|プロマイド|トレカ|ポストカード|スリーブ|デッキ|ストレ[イー]ジボックス|プレイマット|ラバーマット|ヴァイスシュヴァルツ|PSA\s?\d|プロモ)/iu },
  { id: "media", label: "音像 / 书刊", pattern: /(CD|DVD|Blu-?ray|BD|ゲーム|Switch|PS4|PS5|雑誌|マガジン|画集|ビジュアル|小説|コミック|短編集|アンソロジー|小冊子|キャラクターソング|主題歌|テーマ)/iu },
  { id: "goods", label: "日用杂货", pattern: /(ケース|バッグ|トート|ショッパー|ポーチ|財布|スマホ|ミラー|グラスクロス|マイクロファイバー|マグ|グラス|コースター|タグ|プレート|マット|下敷き|メモ(?!リ)|ブックマーカー|クロック|時計|お守り|ペンライト|イヤホン|Zippo|香水|フラッグ)/iu },
];
const OTHER = { id: "other", label: "其他" };
const BUNDLES = { id: "bundle", label: "打包 / まとめ" };

const NOISE = /(新品|未開封|未使用|中古|美品|送料無料|送料込み?|匿名配送|即決|即購入可|正規品|国内正規品|在庫あり)/gu;

export function isBundle(item: Pick<GroupableItem, "title" | "bundle">): boolean {
  return item.bundle === true || BUNDLE.test(item.title);
}

export function categoryOf(item: Pick<GroupableItem, "title" | "bundle">): { id: string; label: string } {
  if (isBundle(item)) return BUNDLES;
  return CATEGORY_RULES.find((entry) => entry.pattern.test(item.title)) ?? OTHER;
}

function sameProductKey(item: GroupableItem): string {
  if (item.sameGroup !== undefined) return `img:${item.sameGroup}`;
  const key = item.title.normalize("NFKC").toLowerCase().replace(NOISE, "").replace(/[^\p{L}\p{N}]+/gu, "");
  // 太短的标题合并起来不可靠（「フィギュア」「サイズonesize」），宁可不合。
  return key.length >= 8 ? key : `#${item.identity}`;
}

/** 价格能不能拿来算中位数 / 区间：乱填价排除。 */
export const sanePrice = (price: number | null): price is number => price !== null && price > 1 && price < 1_000_000;

/** 单品 → 打包；组内一口价 → 拍卖；再按价格从低到高，价格未知或乱填的排最后。 */
export function compareItems(left: GroupableItem, right: GroupableItem): number {
  const rank = (item: GroupableItem) => [
    isBundle(item) ? 1 : 0,
    item.auction ? 1 : 0,
    sanePrice(item.price) ? item.price : Number.MAX_SAFE_INTEGER,
  ];
  const [l, r] = [rank(left), rank(right)];
  return l[0]! - r[0]! || l[1]! - r[1]! || l[2]! - r[2]!;
}

/** 同名折叠。输入顺序无关；输出按每组代表排序，代表就是组内排第一的那件。 */
export function groupSameTitle<T extends GroupableItem>(items: readonly T[]): ItemGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = sameProductKey(item);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .map(([key, members]) => ({ key, items: members.sort(compareItems) }))
    .sort((left, right) => compareItems(left.items[0]!, right.items[0]!));
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** 参与统计的价格：一口价且不是乱填的。 */
export function statPrices(items: readonly GroupableItem[]): number[] {
  return items.filter((item) => !item.auction).map((item) => item.price).filter(sanePrice);
}

/** 按品类分组 + 组内同名折叠。件数多的品类在前；「其他」和打包固定排在最后。 */
export function organizeByCategory<T extends GroupableItem>(items: readonly T[]): ItemCategory<T>[] {
  // 按图片合成的一组，标题五花八门，逐件分品类会把同一组拆进好几个品类；整组跟多数走（打包件仍单独放）。
  const groupRule = new Map<string, { id: string; label: string }>();
  const votes = new Map<string, Map<string, { rule: { id: string; label: string }; n: number }>>();
  for (const item of items) {
    if (item.sameGroup === undefined || isBundle(item)) continue;
    const rule = categoryOf(item);
    const tally = votes.get(item.sameGroup) ?? new Map();
    const entry = tally.get(rule.id) ?? { rule, n: 0 };
    entry.n += 1;
    tally.set(rule.id, entry);
    votes.set(item.sameGroup, tally);
  }
  for (const [group, tally] of votes) {
    // 平票时「其他」让位给具体品类
    const best = [...tally.values()].sort((a, b) => b.n - a.n || Number(a.rule.id === OTHER.id) - Number(b.rule.id === OTHER.id))[0]!;
    groupRule.set(group, best.rule);
  }
  const buckets = new Map<string, { label: string; items: T[] }>();
  for (const item of items) {
    const rule = (item.sameGroup !== undefined && !isBundle(item) && groupRule.get(item.sameGroup)) || categoryOf(item);
    const bucket = buckets.get(rule.id) ?? { label: rule.label, items: [] };
    bucket.items.push(item);
    buckets.set(rule.id, bucket);
  }
  const categories = [...buckets.entries()].map(([id, bucket]): ItemCategory<T> => {
    const prices = statPrices(bucket.items);
    return {
      id,
      label: bucket.label,
      groups: groupSameTitle(bucket.items),
      count: bucket.items.length,
      median: median(prices),
      low: prices.length ? Math.min(...prices) : null,
      high: prices.length ? Math.max(...prices) : null,
    };
  });
  const rank = (category: ItemCategory<T>) => category.id === BUNDLES.id ? 2 : category.id === OTHER.id ? 1 : 0;
  return categories.sort((left, right) => rank(left) - rank(right) || right.count - left.count);
}

export const BUNDLE_CATEGORY_ID = BUNDLES.id;
