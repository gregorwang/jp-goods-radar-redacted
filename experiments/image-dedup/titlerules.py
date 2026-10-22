# 标题否决规则：图片负责提名，标题里写明的区别负责否决。
# 每个标识归一类；两件都写了同一类、且对不上 = 不同款。
import re, unicodedata

def norm(t): return unicodedata.normalize("NFKC", t).lower()

# 厂商：同一件商品不会同时出自两家
MAKERS = {
    "sega": r"セガ|sega", "taito": r"タイトー|taito", "furyu": r"フリュー|furyu", "bandai": r"バンプレスト|banpresto|bandai spirits|一番くじ",
    "gsc": r"グッドスマイルカンパニー|グッスマ|good ?smile ?company|\bgsc\b", "freeing": r"freeing|フリーイング", "maxfactory": r"マックスファクトリー|max ?factory",
    "kotobukiya": r"コトブキヤ|kotobukiya", "alter": r"アルター|\balter\b", "aniplex": r"アニプレックス|aniplex", "spm": r"\bspm\b",
}
# 商品线：同一件商品只属于一条线；一个标题里出现两条线 = 多件合拍
LINES = {
    "muchute": r"ムチュート|muchute", "trio": r"trio-?try-?it", "tmost": r"t-?most", "evolve": r"evolve", "figurizma": r"figurizm",
    "highgrade": r"ハイグレード", "premium": r"プレミアムフィギュア", "luminasta": r"luminasta|ルミナスタ", "espresto": r"espresto",
    "nendoroid": r"ねんどろいど|nendoroid", "figma": r"figma", "popup": r"pop ?up ?parade", "noodle": r"ぬーどるストッパー",
    "chokonose": r"ちょこのせ", "puchikyara": r"ぷちきゃら", "coreful": r"coreful", "aqua": r"aqua float girls", "exride": r"ex:ride",
    "plush": r"ぬいぐるみ|plush", "acsta": r"アクリルスタンド|アクスタ", "keyholder": r"キーホルダー|キーチェーン",
}
# 周边种类：同一张插画会印在文件夹、挂画、卡套、亚克力上，图片必然很像，但不是同一件商品
KINDS = {
    "tapestry": r"タペストリー", "clearfile": r"クリアファイル", "poster": r"ポスター", "shikishi": r"色紙", "sleeve": r"スリーブ",
    "deskmat": r"デスクマット|プレイマット|ラバーマット", "acsta": r"アクリルスタンド|アクスタ", "acplate": r"アクリルプレート|アクリルパネル|アクリルボード",
    "keyholder": r"キーホルダー|キーチェーン|ストラップ|チャーム", "badge": r"缶バッ[ジチ]|バッジ", "tshirt": r"tシャツ", "mug": r"マグカップ|マグ(?!ネット)",
    "coaster": r"コースター", "sticker": r"ステッカー|シール", "towel": r"タオル", "cushion": r"クッション|抱き枕", "card": r"ブロマイド|ポストカード|カード",
    "cd": r"cd", "bluray": r"blu-?ray|bd|dvd", "book": r"小説|画集|コミック|雑誌|設定資料",
}
ALIAS = {"セパン": "sepang", "スパ": "spa", "トロピカル": "tropical", "ミライ": "mirai", "晴れ着": "晴着"}
# 紧挨 Ver 但不是版本名的词
VER_NOISE = {"plain", "レーシング", "アクリルスタンド", "セット", "着", "style", "フィギュア"}

FIXED = re.compile(r"(?<!\d)(20[0-3]\d)(?!\d)|ver\.?\s*\(([a-z])\)|\(([a-z])\)(?=\s|「|$)|([①-⑳])|rd\.?\s*(\d+)|type\s*-?([a-z0-9])\b|(?:キービジュアル|(?<![a-z])kv)\s*(\d)|(?<![\d/])1\s*/\s*(\d{1,2})(?!\d)|(?:ねんどろいど|nendoroid|no\.)\s*#?(\d{3,4})(?!\d)|figma\s*#?(\d{2,3})(?!\d)|(?<![a-z])sp-?(\d{3})(?!\d)")
FIXED_KINDS = ["year", "letter", "letter", "circled", "rd", "type", "kv", "scale", "nendo_no", "figma_no", "figma_sp"]
# 版本名：紧挨在 Ver 前面的那个词。「2025Ver.」= 普通版（plain），「セパンVer.」「SPA 2025応援Ver.」= 具名版
VER = re.compile(r"([a-z぀-ゟ゠-ヿ一-鿿\d]+)\s*(?:20[0-3]\d)?\s*ver\b", re.I)

def tags(title):
    t = norm(title)
    out = set()
    for m in FIXED.finditer(t):
        for k, v in enumerate(m.groups()):
            if v: out.add(f"{FIXED_KINDS[k]}:{v}")
    for name, pat in MAKERS.items():
        if re.search(pat, t): out.add(f"maker:{name}")
    for name, pat in LINES.items():
        if re.search(pat, t): out.add(f"line:{name}")
    kinds = [name for name, pat in KINDS.items() if re.search(pat, t)]
    if len(kinds) == 1: out.add(f"kind:{kinds[0]}")  # 写了好几种（「スリーブ+PRカードセット」）就不拿来否决
    for m in VER.finditer(t):
        w = m.group(1)
        w = "" if re.fullmatch(r".*20[0-3]\d", w) else w
        w = re.sub(r"^(レーシングミク|racingmiku|初音ミク|miku)?(20[0-3]\d)?", "", w)
        w = ALIAS.get(w, w) or "plain"
        # 商品线名、品类名不是版本名（「ハイグレードフィギュア 2025Ver」）
        if w in VER_NOISE or "フィギュア" in w or any(re.search(p, w) for p in LINES.values()): continue
        out.add(f"ver:{w}")
    if re.search(r"スポンサー特典", t): out.add("ver:sponsor")  # 个人赞助特典版 ≠ 市售版
    # 骏河屋系的标题格式「1.角色名(款式) 「系列名」」：编号、括号里的款式、书名号里的系列名都是确定的区别
    for m in re.finditer(r"(?:^|[\s】])(\d{1,2})\.(?=[^\d\s.])", t): out.add(f"no:{m.group(1)}")
    for m in re.finditer(r"\(([^()]{1,12})\)\s*「", t): out.add(f"var:{m.group(1).strip()}")
    # 系列名只认标题最后那个「」：开头的「未使用品」「ほぼ新品」是品相，中间的是别家卖家各写各的
    m = re.search(r"「([^「」]+)」\s*$", t)
    if m: out.add("series:" + re.sub(r"\s+", "", m.group(1)))
    return frozenset(out)

def multi_item(title):
    """标题本身就说明一张图里不止一件：两个年份、两条商品线。"""
    tg = tags(title)
    years = {x for x in tg if x.startswith("year:")}
    lines = {x for x in tg if x.startswith("line:") and x not in ("line:plush", "line:acsta", "line:keyholder")}
    return len(years) >= 2 or len(lines) >= 2

# 景品 / 量产线 / 粘土人 / figma / POP UP PARADE 都没有比例；写了 1/7、1/8 的是比例手办，两者不会是同一件
PRIZE_LINES = {"line:" + k for k in ("muchute", "trio", "tmost", "evolve", "figurizma", "highgrade", "premium", "luminasta", "espresto", "noodle", "chokonose", "aqua",
                                     "popup", "nendoroid", "figma", "puchikyara", "coreful")}

def conflict(a, b):
    for x, y in ((a, b), (b, a)):
        if any(t.startswith("scale:") for t in x) and (y & PRIZE_LINES): return True
    ka, kb = {}, {}
    for t in a: ka.setdefault(t.split(":")[0], set()).add(t)
    for t in b: kb.setdefault(t.split(":")[0], set()).add(t)
    for k in ka:
        if k not in kb: continue
        if k in ("ver", "series"):
            # 「teamukyo応援」和「応援」算同一个；只有互不包含才算冲突
            if not any(x in y or y in x for x in {t.split(":", 1)[1] for t in ka[k]} for y in {t.split(":", 1)[1] for t in kb[k]}): return True
        elif not (ka[k] & kb[k]):
            return True
    return False
