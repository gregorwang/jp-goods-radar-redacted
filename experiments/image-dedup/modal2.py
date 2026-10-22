# 第 2、3 步在 Modal 上跑的部分：
#   modal run modal2.py::embed   → embeddings2.npz（不裁边、448 分辨率）+ multi.json（看图模型判断一张图里是否多件）
#   modal run modal2.py::match   → matches.json（pairs.json 里每一对图做细节比对，数能对上的特征点）
import modal

app = modal.App("jpgr-image-dedup-experiment-v2")
image = (modal.Image.debian_slim(python_version="3.12")
         .apt_install("libgl1", "libglib2.0-0")
         .pip_install("torch==2.5.1", "torchvision==0.20.1", "transformers==4.51.3", "accelerate==1.6.0", "pillow==11.0.0",
                      "numpy<2.2", "sentencepiece==0.2.0", "protobuf==5.29.1", "kornia==0.8.0", "opencv-python-headless==4.10.0.84"))
hf_cache = modal.Volume.from_name("jpgr-hf-cache", create_if_missing=True)
VOL = {"/root/.cache/huggingface": hf_cache}


def square(im, fill=(255, 255, 255)):
    from PIL import Image
    w, h = im.size
    s = max(w, h)
    out = Image.new("RGB", (s, s), fill)
    out.paste(im, ((s - w) // 2, (s - h) // 2))
    return out


@app.function(image=image, gpu="T4", timeout=1800, volumes=VOL)
def embed_chunk(blobs: list[bytes]) -> dict:
    import io, numpy as np, torch
    from PIL import Image
    from transformers import AutoModel, SiglipModel, SiglipProcessor
    dino = AutoModel.from_pretrained("facebook/dinov2-large", torch_dtype=torch.float16).cuda().eval()
    sp = SiglipProcessor.from_pretrained("google/siglip-so400m-patch14-384")
    sig = SiglipModel.from_pretrained("google/siglip-so400m-patch14-384", torch_dtype=torch.float16).cuda().eval()
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


PROMPT = ("This photo is from a second-hand marketplace listing. Does the photo show two or more DIFFERENT products "
          "(for example two different figures, or the boxes of two different figures, or several different goods)? "
          "These all count as ONE product: several photos or angles of the same single item; one figure shown together with its own box; "
          "an acrylic stand together with its own base; one item shown with its packaging; an official product image showing the item with its included bonus; "
          "two or more identical copies of the same product; a collage of several photos of the same item. "
          "Answer with exactly one word: one or multiple.")


@app.function(image=image, gpu="A10G", timeout=3600, volumes=VOL)
def multi_chunk(blobs: list[bytes]) -> list[str]:
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


@app.function(image=image, gpu="T4", timeout=3600, volumes=VOL)
def match_pairs(blobs: dict, pairs: list) -> list:
    """DISK 特征点 + LightGlue 匹配 + MAGSAC 几何校验，返回每一对的内点数（能在两张图上一一对上的细节点）。"""
    import io, numpy as np, torch, cv2, kornia.feature as KF
    from PIL import Image
    disk = KF.DISK.from_pretrained("depth").cuda().eval()
    lg = KF.LightGlueMatcher("disk").cuda().eval()
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


@app.local_entrypoint()
def embed():
    import json, numpy as np
    n = len(json.load(open("payload.json", encoding="utf8"))["items"])
    blobs = [open(f"images/{i}.jpg", "rb").read() for i in range(n)]
    chunks = [blobs[i:i + 128] for i in range(0, n, 128)]
    calls = [multi_chunk.spawn(c) for c in chunks]
    parts = list(embed_chunk.map(chunks))
    np.savez("embeddings2.npz", **{k: np.concatenate([p[k] for p in parts]) for k in parts[0]})
    print("embeddings2.npz saved")
    answers = [a for c in calls for a in c.get()]
    json.dump(answers, open("multi.json", "w"))
    print("multi:", sum(a.startswith("multi") for a in answers), "of", len(answers), set(answers))


@app.local_entrypoint()
def match():
    import json
    import os
    old = json.load(open("matches.json")) if os.path.exists("matches.json") else {}
    pairs = [p for p in json.load(open("pairs.json")) if f"{p[0]},{p[1]}" not in old]
    print(len(pairs), "new pairs")
    if not pairs: return
    need = sorted({i for p in pairs for i in p})
    blobs = {str(i): open(f"images/{i}.jpg", "rb").read() for i in need}
    step = 1500
    chunks = [[[str(a), str(b)] for a, b in pairs[k:k + step]] for k in range(0, len(pairs), step)]
    res = [r for part in match_pairs.starmap([(blobs, c) for c in chunks]) for r in part]
    old.update({f"{a},{b}": r for (a, b), r in zip(pairs, res)})
    json.dump(old, open("matches.json", "w"))
    print(len(res), "pairs matched")


@app.local_entrypoint()
def multi():
    import json
    n = len(json.load(open("payload.json", encoding="utf8"))["items"])
    blobs = [open(f"images/{i}.jpg", "rb").read() for i in range(n)]
    answers = [a for part in multi_chunk.map([blobs[i:i + 128] for i in range(0, n, 128)]) for a in part]
    json.dump(answers, open("multi.json", "w"))
    print("multi:", sum(a.startswith("multi") for a in answers), "of", len(answers))
