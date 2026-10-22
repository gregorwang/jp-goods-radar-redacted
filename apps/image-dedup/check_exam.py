# 离线核对：用实验目录里已经算好的指纹 / 多件判断 / 细节比对结果跑 grouping.run，
#   1) 和 experiments/image-dedup/common.py 的 pipeline() 分组逐件比，必须完全一样；
#   2) 用考卷 exam.py 打分（初音 score(labels)、白羽 score(labels, shiroha=True)），都必须 0 错。
# 不花钱、不连网。改了 grouping.py / titlerules.py 之后先跑这个。
#   python apps/image-dedup/check_exam.py experiments/image-dedup
#   python apps/image-dedup/check_exam.py experiments/image-dedup/shiroha
# 也可以给第二个参数：服务算出来的结果 JSON（service.py::local 的输出，{"labels": [...]}），只打分。
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
data = os.path.abspath(sys.argv[1])
exp = os.path.abspath(os.path.join(data, "..")) if os.path.basename(data) == "shiroha" else data
shiroha = os.path.basename(data) == "shiroha"
result_file = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
sys.path.insert(0, here)
import numpy as np  # noqa: E402
import grouping  # noqa: E402

os.chdir(data)
sys.path.insert(1, exp)
import common  # noqa: E402  实验版，读当前目录的数据
from exam import score  # noqa: E402


def same_partition(a, b):
    return all((a[i] == a[j]) == (b[i] == b[j]) for i in range(len(a)) for j in range(i + 1, len(a)))


if result_file:
    labels = json.load(open(result_file, encoding="utf8"))["labels"]
    print("服务结果", result_file)
    score(labels, shiroha=shiroha)
    ref = common.pipeline()
    diff = [i for i in range(len(labels)) if any((labels[i] == labels[j]) != (ref[i] == ref[j]) for j in range(len(labels)))]
    print(f"  和笔记本版分组不同的商品 {len(diff)} 件", diff[:30])
    sys.exit(0)

items = [{"title": it["title"], "bundle": (it.get("enrichment") or {}).get("is_bundle")} for it in common.items]
# 实验里下载失败的几张（白羽 3 张 404）服务里就是"没下到图"
missing = set(json.load(open("noimage.json"))) if os.path.exists("noimage.json") else set()
has_image = [i not in missing for i in range(len(items))]
idx = [i for i in range(len(items)) if has_image[i]]
E = np.load("embeddings2.npz")
multi = json.load(open("multi.json"))
M = {tuple(map(int, k.split(","))): v for k, v in json.load(open("matches.json")).items()}
labels, stats = grouping.run(items, has_image, E["dino_cls"][idx], E["siglip"][idx], [multi[i] for i in idx],
                             lambda pairs: [M.get((idx[a], idx[b]), 0) for a, b in pairs])
print("服务版", stats)
score(labels, shiroha=shiroha)
ref = common.pipeline()
print("笔记本版")
score(ref, shiroha=shiroha)
print("分组完全一致" if same_partition(labels, ref) else "!! 分组和笔记本版不一致")
