# 把一封档案的实验结果存成长期数据集：图片 + 商品 + 分组 + 标注。
# 在档案目录里运行（和其他脚本一样读当前目录）：python ../export_dataset.py 档案名 [--holdout]
#   --holdout：这封永远只当考卷，不拿来训练（白羽）。
# 输出到 DATASET_ROOT/档案名/，重跑会覆盖同名档案。
import hashlib, json, os, shutil, sys, collections, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common, exam

DATASET_ROOT = os.path.expanduser("~/jpgr-datasets/二次元周边同款")
name = sys.argv[1]
holdout = "--holdout" in sys.argv
shiroha = os.path.basename(os.getcwd()) == "shiroha"
out = os.path.join(DATASET_ROOT, name)
os.makedirs(os.path.join(out, "images"), exist_ok=True)

items = common.items
labels = [int(x) for x in common.pipeline()]
groups = collections.defaultdict(list)
for i, l in enumerate(labels): groups[l].append(i)

with open(os.path.join(out, "items.jsonl"), "w", encoding="utf8") as f:
    for i, it in enumerate(items):
        src = f"images/{i}.jpg"
        img = None
        if os.path.exists(src):
            data = open(src, "rb").read()
            img = f"images/{hashlib.sha1(data).hexdigest()[:16]}.jpg"
            shutil.copyfile(src, os.path.join(out, img))
        f.write(json.dumps({
            "n": i, "sourceId": it["sourceId"], "sourceItemId": it.get("sourceItemId"), "url": it["url"],
            "title": it["title"], "price": it["price"], "imageUrl": it.get("imageUrl"), "image": img,
            "multiPhoto": i in common.MULTI_PHOTO, "excluded": bool(common.excluded(i)),
        }, ensure_ascii=False) + "\n")

SAME, APART = (exam.SHIROHA_SAME, exam.SHIROHA_APART) if shiroha else (exam.SAME, exam.APART)
json.dump({
    "dossier": name,
    "exportedAt": datetime.date.today().isoformat(),
    "holdout": holdout,
    # 用户明确标的：same 每组内部是同款；apart 每条里的几组彼此不是同款（"像但不是"，最值钱）
    "explicit": {"same": SAME, "apart": APART},
    # 系统分组、用户整组看过没挑出错（10-09 第 3 轮验收）。单件用户没看，不代表"不是同款"
    "reviewedGroups": sorted([sorted(g) for g in groups.values() if len(g) > 1], key=len, reverse=True),
}, open(os.path.join(out, "labels.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
print(out, len(items), "items,", sum(len(g) > 1 for g in groups.values()), "reviewed groups")
