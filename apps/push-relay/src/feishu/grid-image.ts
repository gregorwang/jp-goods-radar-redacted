/**
 * 一个 IP 这一轮的新货拼成一张九宫格图，一次只占一次飞书上传额度（免费版每月 1 万次，
 * 一件一张图一个月要 9 千多次，见 docs/研究/飞书自建应用机器人-能力调研-20261013.md §4）。
 *
 * 每格：商品图（按中心裁成正方形、圆角）+ 左上角序号（和卡片里的 ①② 对应）+ 左下角价格条
 * （低于同款行情绿色、拍卖橙色带「拍」、其余深灰）。背景透明，飞书浅色 / 深色模式都不突兀。
 *
 * 只解 JPEG（纯 JS 的 jpeg-js，不用 wasm）。各来源默认给 WebP 的，先换成同一张图的 JPEG 地址（jpegVariant）；
 * 换不出来或下载失败的格子画成浅灰占位，不影响其他格子。PNG 用平台自带的 CompressionStream 压。
 */
import decodeJpeg from "jpeg-js/lib/decoder.js";
import { yen } from "./card";
import { GLYPHS } from "./glyphs";

export interface GridTile {
  imageUrl?: string;
  /** 格子左上角的序号，从 1 开始。 */
  n: number;
  price: number | null;
  tone: "default" | "cheaper" | "auction";
}

const GAP = 8;
const RADIUS = 14;
const FETCH_TIMEOUT_MS = 6_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** 各来源换成同一张图的 JPEG 小图地址（2026-10-13 逐个实测过返回 image/jpeg）。 */
export function jpegVariant(imageUrl: string): string {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return imageUrl;
  }
  if (url.hostname === "static.mercdn.net") {
    const photo = /\/photos\/(m\d+_\d+\.jpg)$/u.exec(url.pathname)?.[1];
    if (photo) return `https://static.mercdn.net/thumb/photos/${photo}`;
  }
  if (url.hostname === "assets.mercari-shops-static.com") {
    const id = /\/plain\/([^/@]+)/u.exec(url.pathname)?.[1];
    if (id) return `https://assets.mercari-shops-static.com/-/medium/plain/${id}@jpg`;
  }
  if (url.hostname.endsWith("suruga-ya.jp")) {
    const shinaban = url.searchParams.get("shinaban");
    if (shinaban && /^[\w-]+$/u.test(shinaban)) return `https://cdn.suruga-ya.jp/pics/boxart_m/${shinaban}m.jpg`;
  }
  if (url.hostname === "thumbnail.image.rakuten.co.jp") {
    url.searchParams.set("_ex", "300x300");
    return url.href;
  }
  return url.href;
}

interface Rgb {
  width: number;
  height: number;
  data: Uint8Array;
}

async function loadJpeg(imageUrl: string | undefined): Promise<Rgb | null> {
  if (!imageUrl) return null;
  try {
    const response = await fetch(jpegVariant(imageUrl), {
      headers: { Accept: "image/jpeg,image/*;q=0.5", "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  } catch {
    return null;
  }
}

class Canvas {
  readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 4);
  }

  /** 把颜色按 alpha（0–1）叠上去。 */
  blend(x: number, y: number, r: number, g: number, b: number, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    const under = this.data[index + 3]! / 255;
    const outAlpha = a + under * (1 - a);
    if (outAlpha <= 0) return;
    const mix = (top: number, bottom: number) => Math.round((top * a + bottom * under * (1 - a)) / outAlpha);
    this.data[index] = mix(r, this.data[index]!);
    this.data[index + 1] = mix(g, this.data[index + 1]!);
    this.data[index + 2] = mix(b, this.data[index + 2]!);
    this.data[index + 3] = Math.round(outAlpha * 255);
  }

  /** 圆角矩形（边缘按像素覆盖率抗锯齿）。 */
  roundRect(left: number, top: number, width: number, height: number, radius: number, color: [number, number, number], alpha: number): void {
    const r = Math.min(radius, width / 2, height / 2);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const coverage = cornerCoverage(x, y, width, height, r);
        if (coverage > 0) this.blend(left + x, top + y, color[0], color[1], color[2], alpha * coverage);
      }
    }
  }

  /** 把一张图按中心裁成 size×size 贴上去（双线性采样），四角圆角。 */
  drawCover(image: Rgb, left: number, top: number, size: number, radius: number): void {
    const scale = Math.max(size / image.width, size / image.height);
    const offsetX = (image.width - size / scale) / 2;
    const offsetY = (image.height - size / scale) / 2;
    for (let y = 0; y < size; y += 1) {
      const sy = Math.min(image.height - 1, Math.max(0, offsetY + (y + 0.5) / scale - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(image.height - 1, y0 + 1);
      const fy = sy - y0;
      for (let x = 0; x < size; x += 1) {
        const coverage = cornerCoverage(x, y, size, size, radius);
        if (coverage <= 0) continue;
        const sx = Math.min(image.width - 1, Math.max(0, offsetX + (x + 0.5) / scale - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(image.width - 1, x0 + 1);
        const fx = sx - x0;
        const channel = (c: number) => {
          const p00 = image.data[(y0 * image.width + x0) * 3 + c]!;
          const p01 = image.data[(y0 * image.width + x1) * 3 + c]!;
          const p10 = image.data[(y1 * image.width + x0) * 3 + c]!;
          const p11 = image.data[(y1 * image.width + x1) * 3 + c]!;
          return (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
        };
        this.blend(left + x, top + y, channel(0), channel(1), channel(2), coverage);
      }
    }
  }

  /** 白字。y 是文字可见部分的上沿。 */
  text(value: string, left: number, top: number): void {
    const glyphs = [...value].map((char) => GLYPHS[char]).filter((glyph) => glyph !== undefined);
    const minY = Math.min(...glyphs.map((glyph) => glyph.y));
    let cursor = left;
    for (const glyph of glyphs) {
      const mask = atob(glyph.a);
      for (let y = 0; y < glyph.h; y += 1) {
        for (let x = 0; x < glyph.w; x += 1) {
          const alpha = mask.charCodeAt(y * glyph.w + x) / 255;
          if (alpha > 0) this.blend(Math.round(cursor + glyph.x) + x, top + glyph.y - minY + y, 255, 255, 255, alpha);
        }
      }
      cursor += glyph.adv;
    }
  }
}

function cornerCoverage(x: number, y: number, width: number, height: number, radius: number): number {
  const cx = x < radius ? radius : x >= width - radius ? width - radius : null;
  const cy = y < radius ? radius : y >= height - radius ? height - radius : null;
  if (cx === null || cy === null) return 1;
  const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return Math.max(0, Math.min(1, radius - distance + 0.5));
}

export function textMetrics(value: string): { width: number; height: number } {
  const glyphs = [...value].map((char) => GLYPHS[char]).filter((glyph) => glyph !== undefined);
  if (glyphs.length === 0) return { width: 0, height: 0 };
  const top = Math.min(...glyphs.map((glyph) => glyph.y));
  const bottom = Math.max(...glyphs.map((glyph) => glyph.y + glyph.h));
  const last = glyphs[glyphs.length - 1]!;
  const width = glyphs.slice(0, -1).reduce((sum, glyph) => sum + glyph.adv, 0) + last.x + last.w;
  return { width: Math.ceil(width), height: bottom - top };
}

const DARK: [number, number, number] = [17, 24, 39];
/** 序号底色，和卡片列表里的 indigo 小标签同一个色系，两边对得上。 */
const INDIGO: [number, number, number] = [79, 70, 229];
const GREEN: [number, number, number] = [22, 163, 74];
const ORANGE: [number, number, number] = [234, 88, 12];
const PLACEHOLDER: [number, number, number] = [229, 231, 235];

function drawBadges(canvas: Canvas, tile: GridTile, left: number, top: number, size: number): void {
  const label = String(tile.n);
  const metrics = textMetrics(label);
  const badgeHeight = 42;
  const badgeWidth = Math.max(badgeHeight, metrics.width + 24);
  canvas.roundRect(left + 10, top + 10, badgeWidth, badgeHeight, badgeHeight / 2, INDIGO, 0.92);
  canvas.text(label, left + 10 + Math.round((badgeWidth - metrics.width) / 2), top + 10 + Math.round((badgeHeight - metrics.height) / 2));

  if (tile.price === null) return;
  const priceLabel = `${tile.tone === "auction" ? "拍" : ""}${yen(tile.price)}`;
  const priceMetrics = textMetrics(priceLabel);
  const pillHeight = 44;
  const pillWidth = Math.min(size - 20, priceMetrics.width + 26);
  const color = tile.tone === "cheaper" ? GREEN : tile.tone === "auction" ? ORANGE : DARK;
  const pillTop = top + size - pillHeight - 10;
  canvas.roundRect(left + 10, pillTop, pillWidth, pillHeight, pillHeight / 2, color, 0.9);
  canvas.text(priceLabel, left + 10 + 13, pillTop + Math.round((pillHeight - priceMetrics.height) / 2));
}

/**
 * 永远一行 3 格、格子一样大：飞书会把图拉满卡片宽度，按件数换列数的话 1 件就是一整屏大图（10-13 用户：「这怎么阅读」）。
 * 不满 3 格的那一行右边留透明。
 */
const COLUMNS = 3;
const TILE = 300;

/** 拼法改了就改这个号：拼图按格子内容缓存 image_key（desk.ts），不换号会继续用旧样子的图。 */
export const GRID_LAYOUT_VERSION = 2;

/** 画好返回 PNG 字节；一张图都没取到返回 null（这时卡片就不放图）。 */
export async function renderGrid(tiles: GridTile[]): Promise<Uint8Array | null> {
  if (tiles.length === 0) return null;
  const images = await Promise.all(tiles.map((tile) => loadJpeg(tile.imageUrl)));
  if (images.every((image) => image === null)) return null;
  const columns = COLUMNS;
  const size = TILE;
  const rows = Math.ceil(tiles.length / columns);
  const canvas = new Canvas(columns * size + (columns - 1) * GAP, rows * size + (rows - 1) * GAP);
  tiles.forEach((tile, index) => {
    const left = (index % columns) * (size + GAP);
    const top = Math.floor(index / columns) * (size + GAP);
    const image = images[index];
    if (image) canvas.drawCover(image, left, top, size, RADIUS);
    else canvas.roundRect(left, top, size, size, RADIUS, PLACEHOLDER, 1);
    drawBadges(canvas, tile, left, top, size);
  });
  return encodePng(canvas.width, canvas.height, canvas.data);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  view.setUint32(8 + payload.byteLength, crc32(out.subarray(4, 8 + payload.byteLength)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA 8 位 PNG，每行用 Paeth 滤波（照片压得比不滤波小三成左右）。 */
async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x += 1) {
      const current = rgba[y * stride + x]!;
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const upLeft = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0;
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      filtered[y * (stride + 1) + 1 + x] = (current - predictor) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(filtered)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
