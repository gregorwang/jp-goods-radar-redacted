# 首次建档回执的图片分组服务（Modal）。collector 在回执发出后调用，结果写进 radar_core.listing_same_groups。
# 判定逻辑在 grouping.py / titlerules.py；这里只负责下图、跑模型、对外接口。
#
#   部署：modal deploy apps/image-dedup/service.py
#   接口（Authorization: Bearer <DEDUP_TOKEN>，存在 Modal Secret「jpgr-image-dedup」和 collector 的 IMAGE_DEDUP_TOKEN）：
#     POST /start         {"items": [{url, imageUrl, title, bundle}], "images": {url: base64}} → {"callId"}
#     GET  /result/<id>   202 {"status":"running"} | 200 {"status":"done", "groups":[{url, group}], "stats"} | 200 {"status":"failed","error"}
#     POST /score         {"references": [base64], "candidates": [{url, imageUrl}]} → {"callId"}
#     GET  /score/<id>    202 {"status":"running"} | 200 {"status":"done", "results":[{url, sim, inliers}], "stats"} | 200 {"status":"failed","error"}
#   /score 是精确同款按参考图打分（docs/进行中/精确同款参考图-交接-20261009.md），collector 的
#   exact-reference-image.ts 调用，开关 runtime_feature_flags.exact_reference_image_v1 关着时不会被调用。
#   本地拿一封实验数据试跑（不写库）：在档案目录里 modal run <repo>/apps/image-dedup/service.py::local
#
# 骏河屋的图从 Modal（美国机房）和 VPS（新加坡）下都是 403，只有 Cloudflare 出口能下，
# 所以骏河屋的图由 collector 下好放在 images 里带过来；其他平台在这里下（2026-10-09 实测全部 200）。
import os

import modal

app = modal.App("jpgr-image-dedup")
HERE = os.path.dirname(os.path.abspath(__file__))

gpu_image = (modal.Image.debian_slim(python_version="3.12")
             .apt_install("libgl1", "libglib2.0-0")
             .pip_install("torch==2.5.1", "torchvision==0.20.1", "transformers==4.51.3", "accelerate==1.6.0", "pillow==11.0.0",
                          "numpy<2.2", "sentencepiece==0.2.0", "protobuf==5.29.1", "kornia==0.8.0", "opencv-python-headless==4.10.0.84"))
cpu_image = (modal.Image.debian_slim(python_version="3.12")
             .pip_install("numpy<2.2", "scikit-learn==1.5.2", "pillow==11.0.0", "httpx==0.28.1")
             # 按文件路径放进去：实验目录里也有一份 titlerules.py，按模块名找可能找错
             .add_local_file(os.path.join(HERE, "grouping.py"), "/root/grouping.py")
             .add_local_file(os.path.join(HERE, "titlerules.py"), "/root/titlerules.py"))
# 精确同款打分：同一台机器里下图 + 指纹 + 细节比对，所以比 gpu_image 多一个下图用的 httpx
score_image = gpu_image.pip_install("httpx==0.28.1")
web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]==0.115.6")
hf_cache = modal.Volume.from_name("jpgr-hf-cache", create_if_missing=True)
VOL = {"/root/.cache/huggingface": hf_cache}
secret = modal.Secret.from_name("jpgr-image-dedup")

CHUNK = 128          # 指纹 / 多件判断每个容器处理的图片数（与实验相同）
PAIR_CHUNK = 1500    # 细节比对每个容器处理的图片对数
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def square(im, fill=(255, 255, 255)):
    from PIL import Image
    w, h = im.size
    s = max(w, h)
    out = Image.new("RGB", (s, s), fill)
    out.paste(im, ((s - w) // 2, (s - h) // 2))
    return out


# ---- 指纹和细节比对的算法（与 experiments/image-dedup/modal2.py 相同）----
# 建档回执分组（embed_chunk / match_pairs）和精确同款打分（ReferenceScorer）共用这几个函数，
# 两边算法必须一致：补白成正方形、448、DISK n=2048、LightGlue、MAGSAC 1.5。只有"模型什么时候装"不同。

def _load_embedders():
    import torch
    from transformers import AutoModel, SiglipModel, SiglipProcessor
    dino = AutoModel.from_pretrained("facebook/dinov2-large", torch_dtype=torch.float16).cuda().eval()
    sp = SiglipProcessor.from_pretrained("google/siglip-so400m-patch14-384")
    sig = SiglipModel.from_pretrained("google/siglip-so400m-patch14-384", torch_dtype=torch.float16).cuda().eval()
    return dino, sp, sig


def _load_matcher():
    import kornia.feature as KF
    disk = KF.DISK.from_pretrained("depth").cuda().eval()
    lg = KF.LightGlueMatcher("disk").cuda().eval()
    return disk, lg


def _embed(embedders, blobs: list[bytes]) -> dict:
    """两个图片指纹：DINOv2（看长相）+ SigLIP（看是什么）。补白成正方形、448，不裁边。"""
    import io, numpy as np, torch
    from PIL import Image
    dino, sp, sig = embedders
    ims = [square(Image.open(io.BytesIO(b)).convert("RGB")) for b in blobs]
    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1); std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
    x = torch.stack([torch.from_numpy(np.asarray(im.resize((448, 448), Image.BICUBIC))).permute(2, 0, 1).float() / 255 for im in ims])
    x = ((x - mean) / std).cuda().half()
    with torch.no_grad():
        h = dino(pixel_values=x).last_hidden_state
        y = sp(images=ims, return_tensors="pt")["pixel_values"].cuda().half()
        s = sig.get_image_features(pixel_values=y)
    n = lambda t: torch.nn.functional.normalize(t.float(), dim=-1).cpu().numpy().astype(np.float32)
    return {"dino_cls": n(h[:, 0]), "siglip": n(s)}


def _match(matcher, blobs: dict, pairs: list) -> list:
    """DISK 特征点 + LightGlue 匹配 + MAGSAC 几何校验，返回每一对的内点数（能在两张图上一一对上的细节点）。"""
    import io, numpy as np, torch, cv2, kornia.feature as KF
    from PIL import Image
    disk, lg = matcher
    feats = {}
    with torch.no_grad():
        for key, b in blobs.items():
            im = Image.open(io.BytesIO(b)).convert("RGB")
            im.thumbnail((640, 640))
            if min(im.size) < 160: im = im.resize((im.width * 2, im.height * 2), Image.BICUBIC)
            t = torch.from_numpy(np.asarray(im)).permute(2, 0, 1).float().div(255)[None].cuda()
            f = disk(t, n=2048, pad_if_not_divisible=True)[0]
            feats[key] = (f.keypoints, f.descriptors, t.shape[-2:])
        res = []
        for a, b in pairs:
            ka, da, ha = feats[a]; kb, db, hb = feats[b]
            if len(ka) < 8 or len(kb) < 8: res.append(0); continue
            la = KF.laf_from_center_scale_ori(ka[None], torch.ones(1, len(ka), 1, 1, device="cuda"))
            lb = KF.laf_from_center_scale_ori(kb[None], torch.ones(1, len(kb), 1, 1, device="cuda"))
            _, idx = lg(da, db, la, lb, hw1=torch.tensor(ha), hw2=torch.tensor(hb))
            if len(idx) < 8: res.append(int(len(idx))); continue
            p1 = ka[idx[:, 0]].cpu().numpy(); p2 = kb[idx[:, 1]].cpu().numpy()
            try:
                _, mask = cv2.findFundamentalMat(p1, p2, cv2.USAC_MAGSAC, 1.5, 0.999, 10000)
                res.append(int(mask.sum()) if mask is not None else 0)
            except cv2.error:
                res.append(0)  # 点退化（全挤在一处），按对不上处理
    return res


# ---- 建档回执分组的三个模型函数（每次调用装一次模型，与实验相同）----

@app.function(image=gpu_image, gpu="T4", timeout=1800, volumes=VOL)
def embed_chunk(blobs: list[bytes]) -> dict:
    """① 两个图片指纹。"""
    return _embed(_load_embedders(), blobs)


PROMPT = ("This photo is from a second-hand marketplace listing. Does the photo show two or more DIFFERENT products "
          "(for example two different figures, or the boxes of two different figures, or several different goods)? "
          "These all count as ONE product: several photos or angles of the same single item; one figure shown together with its own box; "
          "an acrylic stand together with its own base; one item shown with its packaging; an official product image showing the item with its included bonus; "
          "two or more identical copies of the same product; a collage of several photos of the same item. "
          "Answer with exactly one word: one or multiple.")


@app.function(image=gpu_image, gpu="A10G", timeout=3600, volumes=VOL)
def multi_chunk(blobs: list[bytes]) -> list[str]:
    """③ 看图模型逐张判断：这张照片里是不是拍了不止一件不同的商品。"""
    import io, torch
    from PIL import Image
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
    name = "Qwen/Qwen2.5-VL-7B-Instruct"
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(name, torch_dtype=torch.bfloat16, attn_implementation="sdpa").cuda().eval()
    proc = AutoProcessor.from_pretrained(name, min_pixels=256 * 28 * 28, max_pixels=640 * 28 * 28)
    proc.tokenizer.padding_side = "left"
    out = []
    for k in range(0, len(blobs), 8):
        ims = [Image.open(io.BytesIO(b)).convert("RGB") for b in blobs[k:k + 8]]
        msgs = [[{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT}]}] for _ in ims]
        texts = [proc.apply_chat_template(m, tokenize=False, add_generation_prompt=True) for m in msgs]
        inp = proc(text=texts, images=ims, return_tensors="pt", padding=True).to("cuda")
        with torch.no_grad():
            gen = model.generate(**inp, max_new_tokens=3, do_sample=False)
        out += [t.strip().lower() for t in proc.batch_decode(gen[:, inp["input_ids"].shape[1]:], skip_special_tokens=True)]
    return out


@app.function(image=gpu_image, gpu="T4", timeout=3600, volumes=VOL)
def match_pairs(blobs: dict, pairs: list) -> list:
    """④ 细节比对，返回每一对的内点数。"""
    return _match(_load_matcher(), blobs, pairs)


# ---- 编排 ----

def _download(items, inline):
    """下载每件的商品图；下不到、或者下回来不是图片（平台拦截页）的记 None。"""
    import base64, io, re, concurrent.futures as cf, httpx
    from PIL import Image
    client = httpx.Client(headers={"User-Agent": UA}, timeout=30, follow_redirects=True)

    def valid(data):
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            return data if min(im.size) >= 8 else None
        except Exception:
            return None

    def get(it):
        if it["url"] in inline:
            return valid(base64.b64decode(inline[it["url"]]))
        if not it.get("imageUrl"):
            return None
        url = it["imageUrl"]
        # 骏河屋的 photo.php 对机房 IP 是 403，但它跳转去的图片 CDN 不拦（2026-10-09 实测：エアリアル那封 28 件里 24 件 200）
        m = re.match(r"https://www\.suruga-ya\.jp/database/photo\.php\?shinaban=([0-9A-Za-z]+)", url)
        if m:
            url = f"https://cdn.suruga-ya.jp/pics_webp/boxart_m/{m.group(1)}m.jpg.webp"
        for _ in range(2):
            try:
                r = client.get(url)
                if r.status_code == 200:
                    return valid(r.content)
                if r.status_code in (403, 404, 410):
                    return None
            except httpx.HTTPError:
                pass
        return None

    with cf.ThreadPoolExecutor(24) as ex:
        return list(ex.map(get, items))


@app.function(image=cpu_image, timeout=3600)
def group_receipt(req: dict) -> dict:
    import collections, numpy as np, grouping
    items = req["items"]
    blobs = _download(items, req.get("images") or {})
    has_image = [b is not None for b in blobs]
    got = sum(has_image)
    by_source = collections.Counter()
    for it, b in zip(items, blobs):
        if b is None: by_source[it.get("sourceId") or "?"] += 1
    # 图大面积下不到时不写结果：写进去的话这一封每件都各自一张卡，比同名折叠还糟。报错让 collector 稍后重试。
    if got < max(2, len(items) // 2):
        raise RuntimeError(f"only {got}/{len(items)} images downloaded; missing by source {dict(by_source)}")
    sub = [b for b in blobs if b is not None]
    chunks = [sub[i:i + CHUNK] for i in range(0, len(sub), CHUNK)]
    multi_calls = [multi_chunk.spawn(c) for c in chunks]
    parts = list(embed_chunk.map(chunks))
    dino = np.concatenate([p["dino_cls"] for p in parts])
    siglip = np.concatenate([p["siglip"] for p in parts])
    answers = [a for c in multi_calls for a in c.get()]

    def match(pairs):
        work = []
        for k in range(0, len(pairs), PAIR_CHUNK):
            chunk = pairs[k:k + PAIR_CHUNK]
            need = {i for p in chunk for i in p}
            work.append(({str(i): sub[i] for i in need}, [[str(a), str(b)] for a, b in chunk]))
        return [r for part in match_pairs.starmap(work) for r in part]

    labels, stats = grouping.run(items, has_image, dino, siglip, answers, match)
    return {
        "groups": [{"url": it["url"], "group": str(l)} for it, l in zip(items, labels)],
        "labels": labels,
        "stats": {**stats, "items": len(items), "images": got, "missingBySource": dict(by_source),
                  "cards": len(set(labels))},
    }


# ---- 精确同款按参考图打分（docs/进行中/精确同款参考图-交接-20261009.md）----
# 一次调用 = 一个档案一轮巡回漏斗筛剩的几件到十几件。钱几乎全花在开机装模型上（10-09 实测：
# 指纹、细节比对各开一台各冷启动一次 ≈ $0.03），所以四个模型合进一台机器、在 @modal.enter 里只装一次，
# 算完 2 秒就关（scaledown_window），单次 ≈ $0.005。门槛不在这里：这里只给每张参考图的分数，
# 对上没对上由 collector 的 exact-reference-image.ts 判，调门槛不用重新部署。
MAX_SCORE_CANDIDATES = 60
MAX_REFERENCES = 4


@app.cls(image=score_image, gpu="T4", timeout=600, volumes=VOL, scaledown_window=2)
class ReferenceScorer:
    @modal.enter()
    def load(self):
        self.embedders = _load_embedders()
        self.matcher = _load_matcher()

    @modal.method()
    def score(self, req: dict) -> dict:
        """references: 参考图（base64），candidates: [{url, imageUrl}] → 每件对每张参考图的整体相似度和细节点。
        下不到图的那件 refs 为空，collector 按"没看图"处理（只看文字）。"""
        import base64, time
        import numpy as np
        started = time.time()
        refs = [base64.b64decode(b) for b in req["references"]][:MAX_REFERENCES]
        cands = req["candidates"][:MAX_SCORE_CANDIDATES]
        blobs = _download(cands, {})
        got = [i for i, b in enumerate(blobs) if b is not None]
        results = [{"url": c["url"], "refs": []} for c in cands]
        if got:
            emb = _embed(self.embedders, refs + [blobs[i] for i in got])
            r = len(refs)
            # 与 grouping.similarity 相同：两个指纹的余弦相似度取平均
            sim = (emb["dino_cls"][r:] @ emb["dino_cls"][:r].T + emb["siglip"][r:] @ emb["siglip"][:r].T) / 2
            images = {**{f"r{k}": b for k, b in enumerate(refs)}, **{f"c{i}": blobs[i] for i in got}}
            pairs = [[f"r{k}", f"c{i}"] for i in got for k in range(r)]
            inliers = np.array(_match(self.matcher, images, pairs)).reshape(len(got), r)
            for row, i in enumerate(got):
                results[i]["refs"] = [{"sim": round(float(sim[row, k]), 4), "inliers": int(inliers[row, k])} for k in range(r)]
        return {"results": results,
                "stats": {"candidates": len(cands), "images": len(got), "references": len(refs),
                          "seconds": round(time.time() - started, 1)}}


@app.function(image=web_image, secrets=[secret], timeout=60)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse
    web = FastAPI()

    def auth(request: Request):
        if request.headers.get("authorization") != f"Bearer {os.environ['DEDUP_TOKEN']}":
            raise HTTPException(status_code=401)

    @web.post("/start")
    async def start(request: Request):
        auth(request)
        body = await request.json()
        if not isinstance(body.get("items"), list) or not body["items"]:
            raise HTTPException(status_code=400, detail="items required")
        call = await group_receipt.spawn.aio(body)
        return {"callId": call.object_id}

    @web.get("/result/{call_id}")
    async def result(call_id: str, request: Request):
        auth(request)
        try:
            out = await modal.FunctionCall.from_id(call_id).get.aio(timeout=0)
        except TimeoutError:
            return JSONResponse({"status": "running"}, status_code=202)
        except Exception as error:  # 算失败、结果过期：都交给 collector 记失败、按次数重试
            return {"status": "failed", "error": f"{type(error).__name__}: {error}"[:500]}
        return {"status": "done", "groups": out["groups"], "stats": out["stats"]}

    @web.post("/score")
    async def score_start(request: Request):
        auth(request)
        body = await request.json()
        refs, cands = body.get("references"), body.get("candidates")
        if not isinstance(refs, list) or not refs or not isinstance(cands, list) or not cands:
            raise HTTPException(status_code=400, detail="references and candidates required")
        if len(refs) > MAX_REFERENCES or len(cands) > MAX_SCORE_CANDIDATES:
            raise HTTPException(status_code=400, detail="too many references or candidates")
        call = await ReferenceScorer().score.spawn.aio({"references": refs, "candidates": cands})
        return {"callId": call.object_id}

    @web.get("/score/{call_id}")
    async def score_result(call_id: str, request: Request):
        auth(request)
        try:
            out = await modal.FunctionCall.from_id(call_id).get.aio(timeout=0)
        except TimeoutError:
            return JSONResponse({"status": "running"}, status_code=202)
        except Exception as error:
            return {"status": "failed", "error": f"{type(error).__name__}: {error}"[:500]}
        return {"status": "done", "results": out["results"], "stats": out["stats"]}

    return web


@app.local_entrypoint()
def local(out: str = "service_result.json"):
    """在实验的档案目录里跑：读 payload.json，骏河屋的图从本地 images/ 带上（模拟 collector），结果写 out。"""
    import base64, json
    payload = json.load(open("payload.json", encoding="utf8"))["items"]
    items = [{"url": it["url"], "imageUrl": it.get("imageUrl"), "title": it["title"], "sourceId": it["sourceId"],
              "bundle": bool((it.get("enrichment") or {}).get("is_bundle"))} for it in payload]
    images = {}
    for i, it in enumerate(items):
        if it["sourceId"] == "surugaya" and os.path.exists(f"images/{i}.jpg"):
            images[it["url"]] = base64.b64encode(open(f"images/{i}.jpg", "rb").read()).decode()
    res = group_receipt.remote({"items": items, "images": images})
    json.dump({"labels": res["labels"], "stats": res["stats"]}, open(out, "w"))
    print(res["stats"])


@app.local_entrypoint()
def score_local(refs: str, candidates: str):
    """精确同款打分试跑（花钱，单次约 $0.005）：
    modal run apps/image-dedup/service.py::score_local --refs a.jpg,b.png --candidates cands.json
    cands.json = [{"url": ..., "imageUrl": ...}]，结果直接打印。"""
    import base64, json
    references = [base64.b64encode(open(path, "rb").read()).decode() for path in refs.split(",") if path]
    res = ReferenceScorer().score.remote({"references": references, "candidates": json.load(open(candidates, encoding="utf8"))})
    print(json.dumps(res, ensure_ascii=False, indent=1))
