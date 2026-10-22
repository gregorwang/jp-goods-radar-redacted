# 按图片合并同款的判定逻辑（docs/研究/图片去重-实测-20261008.md）。
# 与 experiments/image-dedup/common.py 的 pipeline() 逐行对应，只是去掉了全局状态、改成传参。
# 参数（0.75 / 0.88 / 100 点 / 0.95 / 占位图 0.98）是拿两份考卷调出来的，改任何一个都要
# 用 check_exam.py 重新打分（初音、白羽都必须 0 错）。
#
# 四步：① 图片指纹提名（分层聚类）→ ② 标题否决（titlerules.py）→ ③ 多件合拍不参与 → ④ 细节比对复核。
# ③ 和 ④ 的模型在 Modal 上跑（service.py），这里只吃它们的结果，所以分成 propose / finalize 两段。
import itertools
import re
import unicodedata

import numpy as np

import titlerules

# 与 packages/email/src/listing-groups.ts 的 BUNDLE 一致：打包件不参与图片合并。
MANY = r"(?:[2-9]|[1-9]\d+)\s*"
BUNDLE = re.compile(rf"(まとめ|セット売り|大量|詰め合わせ|福袋|{MANY}(?:点|体(?!験))|{MANY}(?:個|種|枚|つ|本|冊)\s*セット|bundle|\blot\b)", re.I)
# 立体货（手办 / 模型）看外形就够；扁平周边（吧唧、亚克力、色纸、卡、海报……）形状版式都一样，
# 区别全在画面，所以要求更像才合。与 listing-groups.ts 的 figure / model 词表一致。
SOLID = re.compile(r"(フィギュア|フィギア|figure|ねんどろいど|nendoroid|figma|プライズ|スケール|1/[4-8](?!\d)|塗装済み?完成品|ぷちきゃら|ちょこのせ|POP UP PARADE|ESPRESTO|Luminasta|ルミナスタ|Yumemirize|ムチュート|Muchute|Trio-Try-iT|ぬーどるストッパー|ex:ride|SPM|Coreful|プラモ|プラスチックモデル|PLAMATEA|ミニカー|トミカ|1/(?:24|43|64)|ニッパー|模型|ぬいぐるみ)", re.I)
NOISE_WORDS = re.compile(r"(新品|未開封|未使用|中古|美品|送料無料|送料込み?|非常に良い|良い)")

THRESHOLD = 0.75        # 手办：整体相似度 ≥ 0.75 提名
FLAT_THRESHOLD = 0.88   # 扁平周边
MIN_INLIERS = 100       # 细节点对得上 ≥ 100 = 连得上
SURE_SIM = 0.95         # 或整体相似度 ≥ 0.95


def is_bundle(item):
    return bool(BUNDLE.search(item["title"])) or bool(item.get("bundle"))


def is_solid(item):
    return bool(SOLID.search(item["title"]))


def similarity(dino, siglip):
    """两个指纹（看长相 / 看是什么）的余弦相似度取平均。输入已归一化。"""
    return (dino @ dino.T + siglip @ siglip.T) / 2


def _bigrams(title):
    t = re.sub(r"[\W_]+", "", NOISE_WORDS.sub("", unicodedata.normalize("NFKC", title).lower()))
    return {t[k:k + 2] for k in range(len(t) - 1)}


def placeholders(S, items):
    """店铺的「NO IMAGE」占位图：几张图几乎一模一样，标题却互不相干。当成无图处理。"""
    n = len(S)
    out = set()
    grams = [_bigrams(it["title"]) for it in items]
    for i in range(n):
        twins = [j for j in np.where(S[i] >= 0.98)[0] if j != i]
        if len(twins) < 2:
            continue
        jac = [len(grams[i] & grams[j]) / max(1, len(grams[i] | grams[j])) for j in twins]
        if np.median(jac) < 0.25:
            out.add(i)
    # 和已认定的占位图一模一样的，也是占位图
    for i in list(out):
        out |= {int(j) for j in np.where(S[i] >= 0.99)[0]}
    return out


def excluded(items, S, multi_photo):
    """不参与合并的：打包、占位图、标题写明多件、照片里拍了多件不同商品。"""
    no_image = placeholders(S, items)
    return {i for i, it in enumerate(items)
            if is_bundle(it) or i in no_image or titlerules.multi_item(it["title"]) or i in multi_photo}


def _split_conflicts(members, items, S):
    """标识多的先占位；每件放进不冲突的子组里图片最像的那个，都冲突就自立一组。"""
    tags = {i: titlerules.tags(items[i]["title"]) for i in members}
    order = sorted(members, key=lambda i: -len(tags[i]))
    parts = []
    for i in order:
        ok = [p for p in parts if not any(titlerules.conflict(tags[i], tags[j]) for j in p)]
        if ok:
            max(ok, key=lambda p: S[i, p].mean()).append(i)
        else:
            parts.append([i])
    return parts


def propose(items, S, multi_photo):
    """①②③：图片提名 + 标题否决，返回初步分组 labels（同一数字 = 同一组）。"""
    from sklearn.cluster import AgglomerativeClustering
    excl = excluded(items, S, multi_photo)
    singles = [i for i in range(len(items)) if i not in excl]
    labels = np.full(len(items), -1)
    groups = {}
    if len(singles) >= 2:
        D = 1 - S[np.ix_(singles, singles)]
        # 任一方是扁平周边：把距离放大，等效于要求相似度 ≥ FLAT_THRESHOLD 才合
        flat = np.array([not is_solid(items[i]) for i in singles])
        pair_flat = flat[:, None] | flat[None, :]
        D = np.where(pair_flat, D * (1 - THRESHOLD) / (1 - FLAT_THRESHOLD), D)
        np.fill_diagonal(D, 0)
        D = np.clip(D, 0, 2)
        lab = AgglomerativeClustering(n_clusters=None, metric="precomputed", linkage="average",
                                      distance_threshold=1 - THRESHOLD).fit_predict(D)
        for i, l in zip(singles, lab):
            groups.setdefault(l, []).append(i)
    nxt = 0
    for members in groups.values():
        for p in _split_conflicts(members, items, S):
            labels[p] = nxt
            nxt += 1
    for i in range(len(items)):
        if labels[i] == -1:
            labels[i] = nxt
            nxt += 1
    return labels


def pairs_to_check(labels):
    """④ 要做细节比对的对：初步分组里每组内的所有两两组合。"""
    groups = {}
    for i, l in enumerate(labels):
        groups.setdefault(int(l), []).append(i)
    return sorted({p for m in groups.values() if len(m) > 1 for p in itertools.combinations(m, 2)})


def finalize(labels, S, matches):
    """④：组内两件连得上 = 细节点 ≥ MIN_INLIERS 或整体相似度 ≥ SURE_SIM；按连通块拆组。
    matches = {(a, b): 内点数}，a < b；没比对过的对按不连处理。"""
    out = labels.copy()
    nxt = labels.max() + 1 if len(labels) else 0
    groups = {}
    for i, l in enumerate(labels):
        groups.setdefault(l, []).append(i)
    for members in groups.values():
        if len(members) < 2:
            continue
        parent = {i: i for i in members}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a_i, a in enumerate(members):
            for b in members[a_i + 1:]:
                if matches.get((min(a, b), max(a, b)), 0) >= MIN_INLIERS or S[a, b] >= SURE_SIM:
                    parent[find(a)] = find(b)
        comps = {}
        for i in members:
            comps.setdefault(find(i), []).append(i)
        for n, comp in enumerate(comps.values()):
            if n == 0:
                continue
            out[comp] = nxt
            nxt += 1
    return out


def run(items, has_image, dino, siglip, multi_answers, match):
    """整封回执分组。dino / siglip / multi_answers 只对 has_image 为真的那些件、按原顺序给；
    match(pairs) 对子集下标的图片对返回内点数。没下到图的件各自一组。返回与 items 同序的组号。"""
    idx = [i for i in range(len(items)) if has_image[i]]
    sub = [items[i] for i in idx]
    S = similarity(dino, siglip) if idx else np.zeros((0, 0))
    multi_photo = {k for k, a in enumerate(multi_answers) if a.startswith("multi")}
    pre = propose(sub, S, multi_photo)
    pairs = pairs_to_check(pre)
    inliers = match(pairs) if pairs else []
    final = finalize(pre, S, dict(zip(pairs, inliers)))
    out = [-1] * len(items)
    for k, i in enumerate(idx):
        out[i] = int(final[k])
    nxt = max(out) + 1 if out else 0
    for i in range(len(items)):
        if out[i] == -1:
            out[i] = nxt
            nxt += 1
    return out, {"pairs": len(pairs), "multiPhoto": len(multi_photo)}
