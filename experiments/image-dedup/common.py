import json, os, re, unicodedata, numpy as np
items = json.load(open("payload.json", encoding="utf8"))["items"]
E = np.load("embeddings.npz") if os.path.exists("embeddings.npz") else None
# 与 packages/email/src/listing-groups.ts 的 BUNDLE 一致：打包件不参与图片合并。
MANY = r"(?:[2-9]|[1-9]\d+)\s*"
BUNDLE = re.compile(rf"(まとめ|セット売り|大量|詰め合わせ|福袋|{MANY}(?:点|体(?!験))|{MANY}(?:個|種|枚|つ|本|冊)\s*セット|bundle|\blot\b)", re.I)
def is_bundle(it): return bool(BUNDLE.search(it["title"])) or bool((it.get("enrichment") or {}).get("is_bundle"))
RULES = 'v1'  # 'v2' = titlerules.py 的完整否决规则 + 标题多件判定
MULTI_PHOTO = set()  # 图片里看出不止一件的（第二步填）
import os
NO_IMAGE = set(json.load(open('noimage.json'))) if os.path.exists('noimage.json') else set()

def _bigrams(t):
    t = re.sub(r"[\W_]+", "", NOISE_WORDS.sub("", unicodedata.normalize("NFKC", t).lower()))
    return {t[k:k + 2] for k in range(len(t) - 1)}
NOISE_WORDS = re.compile(r"(新品|未開封|未使用|中古|美品|送料無料|送料込み?|非常に良い|良い)")

def placeholders(kind="fused2"):
    """店铺的「NO IMAGE」占位图：几张图几乎一模一样，标题却互不相干。当成无图处理。"""
    S = sims(kind); n = len(S); out = set()
    grams = [_bigrams(it["title"]) for it in items]
    for i in range(n):
        twins = [j for j in np.where(S[i] >= 0.98)[0] if j != i]
        if len(twins) < 2: continue
        jac = [len(grams[i] & grams[j]) / max(1, len(grams[i] | grams[j])) for j in twins]
        if np.median(jac) < 0.25: out.add(i)
    # 和已认定的占位图一模一样的，也是占位图
    for i in list(out):
        out |= {int(j) for j in np.where(S[i] >= 0.99)[0]}
    return out
def excluded(it_index):
    it = items[it_index]
    if is_bundle(it) or it_index in NO_IMAGE: return True
    if RULES == 'v2':
        import titlerules
        return titlerules.multi_item(it['title']) or it_index in MULTI_PHOTO
    return False
def sims(kind):
    if kind == "fused2":
        E2 = np.load("embeddings2.npz")
        return (E2["dino_cls"] @ E2["dino_cls"].T + E2["siglip"] @ E2["siglip"].T) / 2
    if kind == "fused":
        return (E["dino_cls"] @ E["dino_cls"].T + E["siglip"] @ E["siglip"].T) / 2
    return E[kind] @ E[kind].T

YEAR = re.compile(r"(?<!\d)(20[0-3]\d)(?!\d)")
# 标题里能区分"同系列不同款"的硬标识：年份、款式字母 (A)～(Z)、①②、Rd.N、Type A、キービジュアル1。
# 两件都写了且对不上 = 不同款，图片再像也拆开。
VARIANT = re.compile(r"(?<!\d)(20[0-3]\d)(?!\d)|ver\.?\s*\(([a-z])\)|\(([a-z])\)(?=\s|「|$)|([①-⑳])|rd\.?\s*(\d+)|type\s*-?([a-z0-9])|キービジュアル\s*(\d)", re.I)
def years(it):
    t = unicodedata.normalize("NFKC", it["title"]).lower()
    out = set()
    for m in VARIANT.finditer(t):
        for k, v in enumerate(m.groups()):
            if v: out.add(f"{k}:{v}")
    return frozenset(out)

# 立体货（手办 / 模型）看外形就够；扁平周边（吧唧、亚克力、色纸、卡、海报……）形状版式都一样，
# 区别全在画面，所以要求更像才合。用标题判断，与 listing-groups.ts 的 figure / model 词表一致。
SOLID = re.compile(r"(フィギュア|フィギア|figure|ねんどろいど|nendoroid|figma|プライズ|スケール|1/[4-8](?!\d)|塗装済み?完成品|ぷちきゃら|ちょこのせ|POP UP PARADE|ESPRESTO|Luminasta|ルミナスタ|Yumemirize|ムチュート|Muchute|Trio-Try-iT|ぬーどるストッパー|ex:ride|SPM|Coreful|プラモ|プラスチックモデル|PLAMATEA|ミニカー|トミカ|1/(?:24|43|64)|ニッパー|模型|ぬいぐるみ)", re.I)
def is_solid(it): return bool(SOLID.search(it["title"]))

def conflict(a, b):
    ka, kb = {}, {}
    for t in a: ka.setdefault(t.split(":")[0], set()).add(t)
    for t in b: kb.setdefault(t.split(":")[0], set()).add(t)
    return any(k in kb and not (ka[k] & kb[k]) for k in ka)

def split_conflicts(members, S=None):
    """标识多的先占位；每件放进不冲突的子组里图片最像的那个，都冲突就自立一组。"""
    import titlerules
    tags = {i: (titlerules.tags(items[i]['title']) if RULES == 'v2' else years(items[i])) for i in members}
    cf = titlerules.conflict if RULES == 'v2' else conflict
    order = sorted(members, key=lambda i: -len(tags[i]))
    parts = []
    for i in order:
        ok = [p for p in parts if not any(cf(tags[i], tags[j]) for j in p)]
        if ok:
            best = max(ok, key=lambda p: S[i, p].mean() if S is not None else 0)
            best.append(i)
        else:
            parts.append([i])
    return parts

def cluster(kind="fused", threshold=0.75, linkage="average", flat_threshold=None):
    """返回 labels：同一数字 = 同一组。打包件各自成组；组内年份冲突再拆。"""
    from sklearn.cluster import AgglomerativeClustering
    S = sims(kind)
    singles = [i for i, it in enumerate(items) if not excluded(i)]
    D = 1 - S[np.ix_(singles, singles)]
    if flat_threshold is not None:
        # 任一方是扁平周边：把距离放大，等效于要求相似度 ≥ flat_threshold 才合
        flat = np.array([not is_solid(items[i]) for i in singles])
        pair_flat = flat[:, None] | flat[None, :]
        D = np.where(pair_flat, D * (1 - threshold) / (1 - flat_threshold), D)
    np.fill_diagonal(D, 0); D = np.clip(D, 0, 2)
    lab = AgglomerativeClustering(n_clusters=None, metric="precomputed", linkage=linkage,
                                  distance_threshold=1 - threshold).fit_predict(D)
    labels = np.full(len(items), -1)
    nxt = 0
    groups = {}
    for i, l in zip(singles, lab): groups.setdefault(l, []).append(i)
    for members in groups.values():
        # 年份冲突：按年份拆；不写年份的跟着人最多的那一年
        parts = split_conflicts(members, S)
        for p in parts:
            labels[p] = nxt; nxt += 1
    for i, it in enumerate(items):
        if labels[i] == -1: labels[i] = nxt; nxt += 1
    return labels


# ---- 第 3 步：细节比对复核 ----
MATCHES = None
def load_matches():
    global MATCHES
    if MATCHES is None:
        MATCHES = {tuple(map(int, k.split(","))): v for k, v in json.load(open("matches.json")).items()} if os.path.exists("matches.json") else {}
    return MATCHES

def verify(labels, kind, min_inliers=40, sure_sim=0.9):
    """组内两件连得上 = 细节点对得上 ≥ min_inliers，或整体相似度 ≥ sure_sim；按连通块拆组。没比对过的对按不连处理。"""
    M = load_matches(); S = sims(kind)
    out = labels.copy(); nxt = labels.max() + 1
    groups = {}
    for i, l in enumerate(labels): groups.setdefault(l, []).append(i)
    for members in groups.values():
        if len(members) < 2: continue
        parent = {i: i for i in members}
        def find(x):
            while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for a_i, a in enumerate(members):
            for b in members[a_i + 1:]:
                k = (min(a, b), max(a, b))
                if M.get(k, 0) >= min_inliers or S[a, b] >= sure_sim:
                    parent[find(a)] = find(b)
        comps = {}
        for i in members: comps.setdefault(find(i), []).append(i)
        for n, comp in enumerate(comps.values()):
            if n == 0: continue
            out[comp] = nxt; nxt += 1
    return out

# ---- 第 2 轮完整流程 ----
NOISE = re.compile(r"(新品|未開封|未使用|中古|美品|送料無料|送料込み?|匿名配送|即決|即購入可|正規品|国内正規品|在庫あり)")
def title_dedup_cards():
    """现有标题去重（listing-groups.ts sameProductKey）会得到几张卡，用来对照。"""
    keys = set()
    for i, it in enumerate(items):
        k = re.sub(r"[^\w]+|_", "", NOISE.sub("", unicodedata.normalize("NFKC", it["title"]).lower()))
        keys.add(k if len(k) >= 8 else f"#{i}")
    return len(keys)

def pipeline(min_inliers=100, sure_sim=0.95):
    global RULES, MULTI_PHOTO
    RULES = "v2"
    if os.path.exists("multi.json"):
        MULTI_PHOTO = {i for i, a in enumerate(json.load(open("multi.json"))) if a.startswith("multi")}
    NO_IMAGE.update(placeholders())
    L = cluster("fused2", 0.75, flat_threshold=0.88)
    return verify(L, "fused2", min_inliers=min_inliers, sure_sim=sure_sim)
