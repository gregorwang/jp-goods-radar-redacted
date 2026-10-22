# 把分组结果渲染成图片墙：每组一排，大组在前；单件和打包件放最后。图片用本地 images/。
import collections, html, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *
import common
title = sys.argv[1] if len(sys.argv) > 1 else '赛车初音基线'
L = common.pipeline()
multiphoto = common.MULTI_PHOTO
groups = collections.defaultdict(list)
for i, l in enumerate(L): groups[l].append(i)
sane = lambda p: p is not None and 1 < p < 1_000_000
multi = sorted([g for g in groups.values() if len(g) > 1], key=lambda g: -len(g))
single = [g[0] for g in groups.values() if len(g) == 1 and not common.excluded(g[0])]
bundles = [i for i in range(len(items)) if common.excluded(i)]
SRC = {"yahoo_fleamarket_jp": "フリマ", "yahoo_auctions_jp": "ヤフオク", "rakuten_ichiba": "乐天", "mercari_jp": "煤炉",
       "surugaya": "骏河屋", "amazon_jp": "Amazon", "amiami": "AmiAmi"}
def card(i):
    it = items[i]; p = it["price"]
    return (f'<a class="c" href="{html.escape(it["url"])}" target="_blank" title="{html.escape(it["title"])}">'
            f'<img loading="lazy" src="images/{i}.jpg"><b>{f"¥{p:,}" if p is not None else "价格未知"}</b><s>{SRC.get(it["sourceId"], it["sourceId"])} #{i}</s>'
            f'<span>{html.escape(it["title"][:60])}</span></a>')
rows = []
for n, g in enumerate(multi, 1):
    g.sort(key=lambda i: (items[i]["sourceId"] == "yahoo_auctions_jp", items[i]["price"] if sane(items[i]["price"]) else 1e12))
    ps = [items[i]["price"] for i in g if sane(items[i]["price"]) and items[i]["sourceId"] != "yahoo_auctions_jp"]
    rng = f"一口价 ¥{min(ps):,}～¥{max(ps):,}" if ps else "只有拍卖"
    rows.append(f'<section><h2>第 {n} 组 · {len(g)} 件 · {rng}</h2><div class="w">{"".join(card(i) for i in g)}</div></section>')
merged_cards = len(multi) + len(single) + len(bundles)
out = f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>图片去重实验 v3</title><style>
:root{{--bg:#fafaf8;--fg:#1d1d1b;--mute:#6b6b66;--line:#e3e2dd;--card:#fff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#161615;--fg:#ecebe6;--mute:#9a9992;--line:#2c2c2a;--card:#1f1f1d}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:16px;max-width:1400px;margin:auto}}
h1{{font-size:20px}} h2{{font-size:15px;margin:22px 0 8px;border-top:1px solid var(--line);padding-top:12px}}
.sum{{color:var(--mute)}} .sum b{{color:var(--fg)}}
.w{{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}}
.c{{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;color:inherit;text-decoration:none;display:flex;flex-direction:column;font-size:11px}}
.c img{{width:100%;aspect-ratio:1;object-fit:cover;background:#ddd}} .c b{{padding:3px 6px 0;font-size:13px}}
.c s{{text-decoration:none;color:var(--mute);padding:0 6px}} .c span{{padding:0 6px 6px;color:var(--mute);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}}
details{{margin-top:24px}} summary{{cursor:pointer;font-weight:600}}
@media (max-width:600px){{.w{{grid-template-columns:repeat(3,1fr)}}}}
</style>
<h1>{title} · 按图片分组（实验第 3 轮）</h1>
<p class="sum">全部 <b>{len(items)}</b> 件 → 按图片合并后 <b>{merged_cards}</b> 张卡（现有标题去重是 {common.title_dedup_cards()} 张）。<br>
其中 <b>{len(multi)}</b> 个多件组共 <b>{sum(map(len, multi))}</b> 件；单件 {len(single)} 件；打包件 / 多件合拍 / 无图共 {len(bundles)} 件不参与合并。<br>
方法：① 图片指纹提名（DINOv2 + SigLIP，不裁边）；② 标题否决（年份、比例、厂商、商品线、版本名、款式字母、编号对不上就拆）；③ 看图模型判出的多件合拍照片不参与合并；④ 组内两两比细节，能对上的特征点 ≥100 或整体相似度 ≥0.9 才连在一起。点卡片打开原链接，悬停看完整标题。</p>
{"".join(rows)}
<details><summary>单件（没找到同伴）{len(single)} 件</summary><div class="w">{"".join(card(i) for i in single)}</div></details>
<details><summary>打包件 / 多件合拍 / 无图 {len(bundles)} 件（不参与合并）</summary><div class="w">{"".join(card(i) for i in bundles)}</div></details>
'''
open("wall_v3.html", "w", encoding="utf8").write(out)
print(merged_cards, "cards;", len(multi), "multi groups;", sum(map(len, multi)), "items in multi; sizes", [len(g) for g in multi[:25]])
