# 第 3 步要比对的图片对：宽松分组内的所有对 + 整体相似度 ≥ 0.72 的对。在档案目录里运行。
import sys, os, json, itertools, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, common
common.RULES = "v2"
S = common.sims("fused2"); n = len(S)
L = common.cluster("fused2", 0.7, flat_threshold=0.85)
g = collections.defaultdict(list)
for i, l in enumerate(L): g[l].append(i)
P = set()
for m in g.values(): P |= {tuple(sorted(p)) for p in itertools.combinations(m, 2)}
iu = np.triu_indices(n, 1); m = S[iu] >= 0.72
P |= {(int(a), int(b)) for a, b in zip(iu[0][m], iu[1][m])}
json.dump(sorted(P), open("pairs.json", "w")); print(len(P), "pairs")
