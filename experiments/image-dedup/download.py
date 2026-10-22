# 把基线里每件商品的图下载到 images/<序号>.jpg（本机网络，避免平台拦机房 IP）。
import json, os, sys, concurrent.futures as cf, urllib.request
items = json.load(open("payload.json", encoding="utf8"))["items"]
os.makedirs("images", exist_ok=True)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
def get(i):
    path = f"images/{i}.jpg"
    if os.path.exists(path) and os.path.getsize(path) > 0: return i, "cached"
    try:
        req = urllib.request.Request(items[i]["imageUrl"], headers={"User-Agent": UA})
        data = urllib.request.urlopen(req, timeout=30).read()
        open(path, "wb").write(data); return i, "ok"
    except Exception as e: return i, f"fail {e}"
with cf.ThreadPoolExecutor(24) as ex:
    res = list(ex.map(get, range(len(items))))
fails = [(i, s) for i, s in res if s.startswith("fail")]
print(len(res) - len(fails), "ok;", len(fails), "fail")
for i, s in fails[:20]: print(i, items[i]["sourceId"], s[:120])
