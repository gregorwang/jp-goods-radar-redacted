# 用法：python gen-glyphs.py <NotoSansSC-Bold.ttf> ../src/feishu/glyphs.ts
# 字体从 Google Fonts 取（css2?family=Noto+Sans+SC:wght@700&text=<字符>，User-Agent 用老浏览器才给 ttf）。
import sys, base64, json
from PIL import ImageFont, Image, ImageDraw
font_path, out = sys.argv[1], sys.argv[2]
SIZE = 30
font = ImageFont.truetype(font_path, SIZE)
chars = "0123456789¥,+拍"
ascent, descent = font.getmetrics()
glyphs = {}
for ch in chars:
    l, t, r, b = font.getbbox(ch)
    w, h = max(1, r - l), max(1, b - t)
    img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(img).text((-l, -t), ch, font=font, fill=255)
    adv = font.getlength(ch)
    glyphs[ch] = {"w": w, "h": h, "x": l, "y": t, "adv": round(adv, 2), "a": base64.b64encode(img.tobytes()).decode()}
lines = [
  "// 由 apps/push-relay/scripts/gen-glyphs.py 生成：Noto Sans SC Bold（SIL OFL 1.1）按 %dpx 栅格化的几个字形，拼图上画序号和价格用。" % SIZE,
  "// 只有这些字符：%s。要加字符就重新生成，别手改。" % chars,
  "export const GLYPH_SIZE = %d;" % SIZE,
  "export const GLYPH_ASCENT = %d;" % ascent,
  "export const GLYPH_DESCENT = %d;" % descent,
  "export const GLYPHS: Record<string, { w: number; h: number; x: number; y: number; adv: number; a: string }> = %s;" % json.dumps(glyphs, ensure_ascii=False),
  "",
]
open(out, "w", encoding="utf-8").write("\n".join(lines))
print(ascent, descent, sum(len(g["a"]) for g in glyphs.values()))
