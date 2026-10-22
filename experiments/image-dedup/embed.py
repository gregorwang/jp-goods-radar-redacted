# 在 Modal GPU 上给每张图算指纹：DINOv2（看长相）+ SigLIP（看是什么），结果存 embeddings.npz。
#   modal run embed.py
import modal

app = modal.App("jpgr-image-dedup-experiment")
image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "torch==2.5.1", "transformers==4.46.3", "pillow==11.0.0", "numpy<2.2", "sentencepiece==0.2.0", "protobuf==5.29.1"
)
MODELS = {"dinov2": "facebook/dinov2-large", "siglip": "google/siglip-so400m-patch14-384"}


@app.cls(image=image, gpu="T4", timeout=1800)
class Embedder:
    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoImageProcessor, AutoModel, SiglipModel, SiglipProcessor
        self.torch = torch
        self.dino_proc = AutoImageProcessor.from_pretrained(MODELS["dinov2"])
        self.dino = AutoModel.from_pretrained(MODELS["dinov2"], torch_dtype=torch.float16).cuda().eval()
        self.sig_proc = SiglipProcessor.from_pretrained(MODELS["siglip"])
        self.sig = SiglipModel.from_pretrained(MODELS["siglip"], torch_dtype=torch.float16).cuda().eval()

    @modal.method()
    def embed(self, blobs: list[bytes]) -> dict:
        import io
        import numpy as np
        from PIL import Image
        torch = self.torch
        ims = [Image.open(io.BytesIO(b)).convert("RGB") for b in blobs]
        with torch.no_grad():
            x = self.dino_proc(images=ims, return_tensors="pt")["pixel_values"].cuda().half()
            h = self.dino(pixel_values=x).last_hidden_state
            dino_cls = h[:, 0]
            dino_mean = h[:, 1:].mean(1)
            y = self.sig_proc(images=ims, return_tensors="pt")["pixel_values"].cuda().half()
            sig = self.sig.get_image_features(pixel_values=y)
        norm = lambda t: torch.nn.functional.normalize(t.float(), dim=-1).cpu().numpy().astype(np.float32)
        return {"dino_cls": norm(dino_cls), "dino_mean": norm(dino_mean), "siglip": norm(sig)}


@app.local_entrypoint()
def main():
    import json, time
    import numpy as np
    n = len(json.load(open("payload.json", encoding="utf8"))["items"])
    blobs = [open(f"images/{i}.jpg", "rb").read() for i in range(n)]
    chunks = [blobs[i:i + 64] for i in range(0, n, 64)]
    t = time.time()
    parts = list(Embedder().embed.map(chunks))
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    np.savez("embeddings.npz", **out)
    print({k: v.shape for k, v in out.items()}, f"{time.time() - t:.0f}s")
