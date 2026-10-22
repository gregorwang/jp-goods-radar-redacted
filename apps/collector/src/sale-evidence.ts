/**
 * 二手「最近成交」的逐条核对。
 *
 * 提供方给的行情分三档：same_product（已确认同款）、similar_title（标题相似）、
 * category（同作品同品类）。实测后两档大量配错——爱蜜莉雅手办配上蕾姆手办、
 * 必胜客联动立牌配上丸井联动立牌（2026-09-23 用户逐条点开核对，只有 4 件是对的）。
 * 一条没有出处的中位数，和一条配错了的成交链接，对读者来说都等于「随便有人说了句话」。
 *
 * 所以这里只做代码有把握的那一半：从这件商品自己的日文标题里抽出「身份词」
 * （去掉作品名、角色名、品类词、品相 / 物流词、厂商名后剩下的词，如 ESPRESTO、
 * 王選候補者と騎士、もふもふパック、ピザハット、704），一条成交记录必须逐字包含
 * 全部身份词、并且角色对得上，才算同款证据。抽不出任何身份词的标题（「リゼロ エミリア
 * フィギュア 箱無し」）本身就分不清是哪一款——宁可不给行情，也不给一个配错的行情。
 */

export interface VerifiedSale {
  priceJpy: number;
  platform: string;
  title: string;
  url: string;
  seenAt?: string;
}

/** 作品名与常见别名。只用来从「身份词」里剔除，不参与判断。 */
const WORK_WORDS = [
  "re:ゼロから始める異世界生活", "reゼロから始める異世界生活", "ゼロから始める異世界生活", "re:ゼロ", "reゼロ", "リゼロ", "rezero", "re:zero",
  "re", "ゼロ", "nex", "f", "ゼロから始める",
  "冴えない彼女の育てかた", "冴えない彼女の育て方", "冴えカノ", "劇場版", "fine", "memorial", "♭",
  "氷菓", "千反田える", "京都アニメーション",
  // 初音ミク GT プロジェクト是系列名：卖家常省略，官方标题总带着，不说明是哪一款。
  "初音ミク", "gtプロジェクト", "初音ミクgtプロジェクト", "vocaloid", "ボーカロイド",
];

/** 品类、品相、物流、厂商、泛用修饰词：出现与否不说明是哪一款。 */
const GENERIC_WORDS = [
  // 品类
  "フィギュア", "スケールフィギュア", "プライズフィギュア", "プライズ", "景品", "完成品", "ノンスケール", "スケール",
  "アクリルスタンド", "アクスタ", "bigアクリルスタンド", "アクリルキーホルダー", "アクキー", "キーホルダー", "アクリルチャーム",
  "缶バッジ", "トレーディング缶バッジ", "ぬいぐるみ", "bigぬいぐるみ", "マスコット", "クリアファイル", "タペストリー",
  "バッジ", "ピンズ", "ビンズ", "ステッカー", "ポスター", "色紙", "ミニ色紙", "グッズ", "トレーディング", "抱き枕カバー", "スリーブ", "カード",
  "ねんどろいど", "figure", "abs", "pvc", "abs&pvc製", "塗装済", "塗装済み", "可動", "アクション",
  // 品相 / 数量 / 物流
  "新品", "未開封", "内未開封", "開封品", "未使用", "中古", "美品", "箱無し", "箱なし", "箱付き", "本体のみ", "単品",
  "セット", "まとめ", "まとめ売り", "送料無料", "匿名配送", "即購入ok", "即購入可", "正規品", "公式", "1円", "1円～",
  "同梱不可", "当選品", "抽プレ", "非売品", "限定", "特典", "ver", "ver.", "コラボ", "未組立", "現状品",
  // 厂商 / 渠道
  "bandai", "spirits", "bandaispirits", "バンダイ", "バンプレスト", "グッドスマイルカンパニー", "goodsmile", "gsc",
  "アニプレックス", "aniplex", "マックスファクトリー", "フリュー", "furyu", "セガ", "sega", "タイトー", "taito",
  "コトブキヤ", "壽屋", "アルター", "f:nex", "fnex", "big", "通常", "アニメ", "コミック", "イラスト", "文房具",
  "高品質", "同人グッズ", "同梱可", "同梱品", "塗装済み", "完成品フィギュア", "スケールフィギュア", "製",
];
const GENERIC = new Set(GENERIC_WORDS.map((word) => normalize(word)));
const WORKS = WORK_WORDS.map((word) => normalize(word));

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").replace(/\s+/gu, "");
}

function tokens(title: string): string[] {
  return title.normalize("NFKC")
    // 【】里多是物流 / 品相附注（【2週間以内発送】【中古】），不是商品身份。
    .replace(/【[^】]*】/gu, " ")
    .toLocaleLowerCase("ja-JP")
    // 「ー」是片假名长音，不是分隔符（キーホルダー 不能被切成 キ / ホルダ）。
    .split(/[\s「」『』（）()［］\[\]〈〉《》<>・×&＆,，、。．!！?？"“”'‘’\-－―~〜～_/／|｜:：;；★☆◆◇■□●○♪♡❤+＋=*＊#＃➕]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

const LONG_GENERIC = [...GENERIC].filter((word) => word.length >= 3).sort((left, right) => right.length - left.length);
const LONG_WORKS = WORKS.filter((word) => word.length >= 3).sort((left, right) => right.length - left.length);

/**
 * 这件商品的身份词；去掉作品名、角色名与泛用词后剩下的部分。
 * 作品名嵌在词里（リゼロ展）且剩下的部分太短时保留原词——「リゼロ展」本身就是身份。
 */
export function identityTokens(title: string, characters: readonly string[]): string[] {
  const characterParts = characters.flatMap((name) => tokens(name)).filter((part) => part.length >= 2);
  const result = new Set<string>();
  for (const raw of tokens(title)) {
    if (WORKS.includes(raw) || GENERIC.has(raw)) continue;
    let token = raw;
    for (const work of LONG_WORKS) token = token.split(work).join("");
    for (const part of characterParts) token = token.split(part).join("");
    token = token.replace(/^の|の$/gu, "");
    // 剩下一个有意义的字（リゼロ展 → 展）才保留原词；剩下的只是符号（冴えない彼女の育てかた♭ → ♭）就丢掉。
    if (token.length < 2 && raw !== token && /[\p{L}\p{N}]/u.test(token)
      && !characterParts.some((part) => raw.includes(part))) token = raw;
    for (const generic of LONG_GENERIC) token = token.split(generic).join("");
    if (token.length < 2) continue;
    if (GENERIC.has(token) || WORKS.includes(token)) continue;
    if (/発送|送料|即購入|まとめ|点セット|体セット|個セット|枚セット|同梱/u.test(token)) continue;
    // 纯数字只在 3 位以上时算身份（ねんどろいど 704 这种编号）；2体 / 1/7 / A4 / 160x50cm 不算。
    if (/^\d{1,2}$/u.test(token) || /^\d+(体|個|点|枚|cm|mm|㎝)$/u.test(token) || /^[a-z]?\d{1,2}$/u.test(token)
      || /^\d+x\d+/u.test(token) || /^\d+スケ/u.test(token)) continue;
    result.add(token);
  }
  return [...result];
}

/**
 * 强身份词才能单独确定一款：3 字以上、且不是「某店限定 / 限定版 / コラボ」这类渠道标记。
 * 「GIGO限定」同时覆盖好几款手办，「加藤」「卒業」这种两字词也撑不起同款判断。
 * 弱身份词照样要求成交标题包含，只是不够单独放行。
 */
function isStrongIdentity(token: string): boolean {
  if (token.length < 3) return /\d{3,}/u.test(token);
  return !/(限定|限定版|コラボ|特典)$/u.test(token);
}

/** 版本词：制服Ver. / パジャマver / 水着バージョン。 */
function versionTokens(title: string): string[] {
  return tokens(title).filter((token) => /(ver\.?|バージョン)$/u.test(token) && !/^(ver\.?|バージョン)$/u.test(token));
}

function characterMatches(saleTitle: string, characters: readonly string[]): boolean {
  const normalized = normalize(saleTitle);
  return characters.every((name) => {
    const parts = tokens(name).filter((part) => part.length >= 2);
    return parts.length === 0 || parts.some((part) => normalized.includes(part));
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 另一条标题（成交记录 / 官方商品）是否与本件是同一款：身份词全含、角色对得上、版本不多、不是打包。 */
function titleMatchesIdentity(
  title: string,
  normalizedTitle: string,
  identity: readonly string[],
  characters: readonly string[],
  otherTitle: string,
): boolean {
  const normalized = normalize(otherTitle);
  if (!identity.every((token) => normalized.includes(token))) return false;
  if (!characterMatches(otherTitle, characters)) return false;
  // 对方标题带着本件没有的版本（本件没写版本，对方是「パジャマVer.」）——不是同一款。
  if (versionTokens(otherTitle).some((version) => !normalizedTitle.includes(version))) return false;
  // 打包的价格不能和单件比。
  return !(/(\d+|[二三四五六七八九十])(体|個|点|枚)(セット)?|まとめ|セット/u.test(otherTitle.normalize("NFKC"))
    && !/(\d+|[二三四五六七八九十])(体|個|点|枚)|まとめ|セット/u.test(title.normalize("NFKC")));
}

/** 版本词去掉末尾的点再比：卖家写「2023Ver」、官方写「2023Ver.」是同一个版本。 */
const versionKey = (token: string) => token.replace(/\.+$/u, "");

/** 字符二元组的 Dice 相似度：「キャラクターラバーマット」对「キャラクター万能ラバーマット」是 0.83。 */
function bigramDice(left: string, right: string): number {
  const grams = (value: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const a = grams(left);
  const b = grams(right);
  let shared = 0;
  for (const [gram, count] of a) shared += Math.min(count, b.get(gram) ?? 0);
  const total = left.length - 1 + right.length - 1;
  return total > 0 ? (2 * shared) / total : 0;
}

/**
 * 这个词在另一条标题里出现了吗。逐字包含最好；4 字以上、不含数字的词允许写法差一点
 *（Dice ≥ 0.8）。带数字的词必须逐字对上——「誕生日生活2022」和「誕生日生活2020」不是一款。
 */
function tokenPresent(token: string, normalizedOther: string, otherTokens: readonly string[]): boolean {
  if (normalizedOther.includes(token)) return true;
  if (token.length < 4 || /\d/u.test(token)) return false;
  return otherTokens.some((other) => other.length >= 4 && !/\d/u.test(other) && bigramDice(token, other) >= 0.8);
}

/**
 * 官方商品库里排第一的那件，是不是这件商品本身。
 *
 * 以官方标题为准反向核对：官方标题是干净的，它自己的身份词必须都出现在本件标题里
 *（容许写法差一点）。单向时「トレーディングアクリルカード」会被「アクリルブックエンド」、
 * 「エミリア クッション」会被「猫まみれクッション エミリア＆ベアトリス」放行，反向能拦住。
 *
 * 本件这一侧只要求「至少一个强身份词对得上、没有冲突」，不再要求每个词都出现在官方标题里。
 * 卖家标题里常有货号（Yc196、ACF5765）、店铺标注（[コスパ]《発売済・在庫品》《11月予約》）、
 * 同义词（はっぴ / 法被），旧规则一碰到就判不通过：2026-09-23 起 222 对里只过了 41 对，
 * 一字不差的「デッキホルダー Vol.242 加藤恵」也被降成「最接近的一款」（2026-10-08 用户要求放宽）。
 * 冲突仍然一票否决：角色对不上、任一边的版本词另一边没有、单件对打包。
 * 标题抽不出强身份词（「リゼロ エミリア フィギュア」）时仍一律不算核对通过；官方标题自己抽不出
 * 身份词（「Re：ゼロ 缶バッジ エミリア」）时也不算——它对应哪一款都说得通，反向核对等于没核，
 * 劇場限定的「氷結の絆」缶バッジ就这样配上过 407 円的普通缶バッジ。
 */
export function sameProductTitle(title: string, characters: readonly string[], officialTitle: string): boolean {
  const strong = identityTokens(title, characters).filter(isStrongIdentity);
  if (strong.length === 0) return false;
  // 官方标题末尾不带数字的括注是品类说明（カードサプライ / 再販），不是身份；带数字的（3次受注）保留。
  const official = officialTitle.replace(/[（(][^（）()\d]*[）)]\s*$/u, "");
  const normalizedTitle = normalize(title);
  const normalizedOfficial = normalize(official);
  const titleTokens = tokens(title);
  const officialTokens = tokens(official);
  if (!strong.some((token) => tokenPresent(token, normalizedOfficial, officialTokens))) return false;
  if (!characterMatches(official, characters)) return false;
  const titleVersions = versionTokens(title).map(versionKey);
  const officialVersions = versionTokens(official).map(versionKey);
  if (officialVersions.some((version) => !normalizedTitle.includes(version))) return false;
  if (titleVersions.some((version) => !normalizedOfficial.includes(version))) return false;
  const bundle = /(\d+|[二三四五六七八九十])(体|個|点|枚)(セット)?|まとめ|セット/u;
  if (bundle.test(official.normalize("NFKC")) !== bundle.test(title.normalize("NFKC"))) return false;
  const officialIdentity = identityTokens(official, characters);
  return officialIdentity.length > 0
    && officialIdentity.every((token) => tokenPresent(token, normalizedTitle, titleTokens));
}

/**
 * 从提供方各档行情的 recent_sold 里挑出标题逐条核对通过的成交。
 * 返回 null 表示这件商品的标题抽不出身份词，根本无从核对。
 */
export function verifiedRecentSales(title: string, enrichment: Record<string, unknown> | null): VerifiedSale[] | null {
  if (!enrichment) return null;
  const characters = Array.isArray(enrichment.characters)
    ? enrichment.characters.filter((name): name is string => typeof name === "string")
    : [];
  const identity = identityTokens(title, characters);
  if (!identity.some(isStrongIdentity)) return null;
  const normalizedTitle = normalize(title);
  const tiers = recordValue(recordValue(enrichment.market).tiers);
  const seen = new Set<string>();
  const sales: VerifiedSale[] = [];
  for (const tierKey of ["same_product", "similar_title", "category"]) {
    const recent = recordValue(tiers[tierKey]).recent_sold;
    for (const entry of Array.isArray(recent) ? recent : []) {
      const sale = recordValue(entry);
      const saleTitle = typeof sale.title === "string" ? sale.title : "";
      const url = typeof sale.item_url === "string" ? sale.item_url : "";
      const price = typeof sale.price_jpy === "number" ? sale.price_jpy : Number.NaN;
      if (!saleTitle || !url || !Number.isFinite(price) || seen.has(url)) continue;
      seen.add(url);
      if (!titleMatchesIdentity(title, normalizedTitle, identity, characters, saleTitle)) continue;
      sales.push({
        priceJpy: price,
        platform: typeof sale.platform === "string" ? sale.platform : "",
        title: saleTitle,
        url,
        ...(typeof sale.seen_at === "string" ? { seenAt: sale.seen_at } : {}),
      });
    }
  }
  return sales;
}
