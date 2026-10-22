"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { ImagePlus, Power, Trash2 } from "lucide-react";
import { apiErrorMessage, apiFetch } from "@/lib/client-api";
import { tokyoFull } from "@/lib/format-time";

/**
 * 精确同款的参考图（1～2 张）。传了，系统每天拿漏斗筛剩的候选商品图和它比
 * （collector 的 exact-reference-image.ts）；没传就照旧只看标题。
 */
export const MAX_REFERENCE_IMAGES = 2;
/** 长边缩到这么大再传：模型只用 448 / 640，原图再大也没用，只占库。 */
const MAX_EDGE = 1024;

export interface PreparedReferenceImage {
  dataBase64: string;
  contentType: "image/jpeg";
  width: number;
  height: number;
  previewUrl: string;
}

/** 在浏览器里把图缩到长边 ≤1024、转成 JPEG（透明底补白，和模型的补白一致）。 */
export async function prepareReferenceImage(file: File): Promise<PreparedReferenceImage> {
  if (!file.type.startsWith("image/")) throw new Error(`「${file.name}」不是图片`);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`「${file.name}」读不出来，换一张 JPEG / PNG 试试`);
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持图片处理");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const previewUrl = canvas.toDataURL("image/jpeg", 0.9);
  return { dataBase64: previewUrl.slice(previewUrl.indexOf(",") + 1), contentType: "image/jpeg", width, height, previewUrl };
}

export async function uploadReferenceImage(profileId: string, image: PreparedReferenceImage): Promise<void> {
  await apiFetch(`/api/watch-profiles/${encodeURIComponent(profileId)}/reference-images`, {
    method: "POST",
    body: JSON.stringify({
      dataBase64: image.dataBase64,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
    }),
  });
}

export const REFERENCE_IMAGE_EXPLAINER = "可选。传 1～2 张这件商品的图（官图、实拍都行）。系统会拿每天筛剩的候选商品图和它比：图片对上的，即使标题没写全也会当天发；标题判成同款、图却明显不像的，攒到晚上 21:00 一起发。不传就照旧只看标题。";

interface ReferenceImagesResponse {
  maxImages: number;
  scoringEnabled: boolean;
  /** 看图开关最近一次拨动的时间（ISO）。 */
  scoringChangedAt: string | null;
  images: { ordinal: number; dataUrl: string; width: number | null; height: number | null; createdAt: string }[];
}

/** 档案详情页：查看、补传、删除参考图。 */
export function ReferenceImagePanel({ profileId }: { profileId: string }) {
  const inputId = useId();
  const [data, setData] = useState<ReferenceImagesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const fetchImages = useCallback((signal?: AbortSignal) => apiFetch<ReferenceImagesResponse>(
    `/api/watch-profiles/${encodeURIComponent(profileId)}/reference-images`,
    signal ? { signal } : undefined,
  ), [profileId]);

  async function load() {
    setData(await fetchImages());
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchImages(controller.signal)
      .then(setData)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setNotice(apiErrorMessage(reason, "参考图读取失败"));
      });
    return () => controller.abort();
  }, [fetchImages]);

  const images = data?.images ?? [];
  const room = MAX_REFERENCE_IMAGES - images.length;

  async function addFiles(files: FileList | null) {
    const picked = Array.from(files ?? []).slice(0, Math.max(0, room));
    if (picked.length === 0) return;
    setBusy(true);
    setNotice("正在上传…");
    try {
      for (const file of picked) await uploadReferenceImage(profileId, await prepareReferenceImage(file));
      setNotice("已保存。");
      await load();
    } catch (reason) {
      setNotice(apiErrorMessage(reason, "上传失败"));
    } finally {
      setBusy(false);
    }
  }

  /** 看图是全局开关：所有传了参考图的精确同款档案一起开关。 */
  async function toggleScoring() {
    if (!data) return;
    const next = !data.scoringEnabled;
    setBusy(true);
    setNotice("");
    try {
      const result = await apiFetch<Pick<ReferenceImagesResponse, "scoringEnabled" | "scoringChangedAt">>(
        `/api/watch-profiles/${encodeURIComponent(profileId)}/reference-images`,
        { method: "PATCH", body: JSON.stringify({ scoringEnabled: next }) },
      );
      setData({ ...data, ...result });
      setNotice(result.scoringEnabled
        ? "看图已打开：从下一轮巡回起，所有传了参考图的精确同款档案都会看图。"
        : "看图已关闭：从下一轮巡回起只看标题，不再调用显卡。");
    } catch (reason) {
      setNotice(apiErrorMessage(reason, "看图开关设置失败"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(ordinal: number) {
    setBusy(true);
    setNotice("");
    try {
      await apiFetch(`/api/watch-profiles/${encodeURIComponent(profileId)}/reference-images?ordinal=${ordinal}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setNotice(apiErrorMessage(reason, "删除失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="paper-panel reference-image-panel">
      <div className="panel-header">
        <div><p className="eyebrow">REFERENCE IMAGES</p><h2>参考图</h2></div>
        <div className="reference-image-switch">
          <span className={`status-pill ${data?.scoringEnabled ? "good" : "warn"}`}>
            {data ? data.scoringEnabled ? "看图已开启" : "看图暂未开启" : "读取中"}
          </span>
          {data && (
            <button className="ghost-button" type="button" disabled={busy} onClick={() => void toggleScoring()}>
              <Power size={13} aria-hidden="true" />{data.scoringEnabled ? "关闭看图" : "打开看图"}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body">
        <p className="reference-image-copy">{REFERENCE_IMAGE_EXPLAINER}</p>
        {data && (
          <p className="reference-image-copy muted-copy">
            {data.scoringEnabled
              ? `看图${data.scoringChangedAt ? `自 ${tokyoFull(data.scoringChangedAt)} 起` : ""}开着。`
              : `看图现在关着${data.scoringChangedAt ? `（${tokyoFull(data.scoringChangedAt)} 关闭）` : ""}，只看标题；参考图可以先传，打开后自动生效。`}
            这个开关对所有传了参考图的精确同款档案一起生效，没传图的档案始终只看标题、不花钱。看图要用付费显卡，每个档案每轮最多开机一次（约 $0.005～0.01）。
          </p>
        )}
        <div className="reference-image-grid">
          {images.map((image) => (
            <figure key={image.ordinal} className="reference-image-tile">
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL，不走图片优化 */}
              <img src={image.dataUrl} alt={`参考图 ${image.ordinal}`} />
              <figcaption>
                <span>{image.width && image.height ? `${image.width}×${image.height}` : `第 ${image.ordinal} 张`}</span>
                <button className="ghost-button danger-button" type="button" disabled={busy} onClick={() => void remove(image.ordinal)}>
                  <Trash2 size={13} aria-hidden="true" />删除
                </button>
              </figcaption>
            </figure>
          ))}
          {data && room > 0 && (
            <label className="reference-image-add" htmlFor={inputId} data-busy={busy}>
              <ImagePlus size={18} aria-hidden="true" />
              <span>{images.length === 0 ? "上传参考图" : "再传一张"}</span>
              <small>JPEG / PNG / WebP，还能传 {room} 张</small>
              <input
                id={inputId}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple={room > 1}
                disabled={busy}
                onChange={(event) => {
                  void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        {notice && <p className="form-note" role="status">{notice}</p>}
      </div>
    </section>
  );
}
