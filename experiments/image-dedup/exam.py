# 用户 2026-10-08 标注的考卷（exam-screenshots/round1-*.png，7 张），10-09 第 2 轮又标了 4 张（round2-*.png）。编号就是图片墙卡片上的 #序号。
#   same: 每个集合内部应该合在一起；apart: 集合之间不能合。
import itertools, json
from common import items

# 第 1 版图片墙里这几组用户没标红的成员 = 认可它们是同款
# #377 #381 图上写着「２個セット」：按打包规则单独放，不算进来（10-08 第 2 轮决定，待用户确认）
G2_OK = [682,116,598,269,69,30,158,37,132,34,162,278,229,362,224,313,750,341,562,506,530,365,534,337,361,33,236]
SAME = [
    G2_OK,                                   # 第 2 组除 #293
    [59, 196, 299, 451],                     # 第 5 组 1/8（用户：脚和发丝不同）
    [715, 619, 840, 711, 885, 927],          # 第 5 组 1/7
    [72, 961, 854],                          # 第 14 组 セガ 2012 プレミアム
    [772, 768],                              # 第 14 组 グッスマ 1/8
    [289, 150, 478, 518, 131, 268],          # 第 18 组 2011 プレミアム
    [73, 206, 221, 251, 287, 371, 495, 922], # 10-09 第 2 轮第 5 组：figma 2013 EV MIRAI
    [563, 567],                              # 10-09 第 106 组：同款，但一张实拍没拿旗、一张官图拿旗——只看图不像
]
APART = [
    [[293], G2_OK],
    [[702], [286, 645]],
    [[373], [502], [253], [464]],
    [[59, 196, 299, 451], [715, 619, 840, 711, 885, 927]],
    [[72, 961, 854], [446], [772, 768], [504]],
    [[342], [289, 150, 478, 518, 131, 268]],
    [[771], [759]],
    [[318, 624], [73, 206, 221, 251, 287, 371, 495, 922]],  # 10-09 第 5 组：个人赞助特典版 ≠ EV MIRAI 市售版
    [[81], [74]],                                            # 10-09 第 70 组：Rd.0 応援 Ver. ≠ KV1 ちょこぷに Ver.
]

# 白羽（shiroha/）：10-09 第 2 轮标注。全是骏河屋系的吧唧，区别写在编号、括号款式、系列名里
SHIROHA_SAME = [[346, 533], [502, 611], [513, 642], [509, 645], [612, 614], [596, 615]]
SHIROHA_APART = [
    [[346, 533], [502, 611]],   # 第 18 组：口開け ≠ 口閉じ
    [[513, 642], [509, 645]],   # 第 19 组：普通缶バッジ ≠ ホログラム缶バッジ
    [[612, 614], [596, 615]],   # 第 20 组：1. ≠ 3.
]

def score(labels, quiet=False, shiroha=False):
    SAME_, APART_ = (SHIROHA_SAME, SHIROHA_APART) if shiroha else (SAME, APART)
    same_pairs = [(a, b) for s in SAME_ for a, b in itertools.combinations(s, 2)]
    kept = sum(labels[a] == labels[b] for a, b in same_pairs)
    bad = []
    for sets in APART_:
        for x, y in itertools.combinations(sets, 2):
            bad += [(a, b) for a in x for b in y if labels[a] == labels[b]]
    cards = len(set(labels))
    if not quiet:
        print(f"  卡片 {cards} 张 | 该合的 {kept}/{len(same_pairs)} 对合上了 | 不该合的被合上 {len(bad)} 对", sorted({a for a, _ in bad} | {b for _, b in bad})[:20])
    return cards, kept / len(same_pairs), len(bad)
