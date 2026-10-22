// 渲染邮件头图：node scripts/mail-headers/render.mjs
// 用 Playwright 自带的 Chromium 无头截图（2 倍图 1280×480），再用 sharp 压成调色板 PNG，
// 写进主站（apps/web/public/art/mail）。
// 改了文案就把 VERSION 和 packages/email/src/design.ts 的 HEADER_VERSION 一起 +1，旧邮件里的图才不会跟着变。
// 注意：Windows 上 Chromium 认不了带中文的路径，CHROME 和仓库路径都要用 8.3 短路径（如 C:/Users/6058~1/...）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VERSION = "v1";
const KINDS = ["keyword-digest", "keyword-new", "receipt", "exact", "exact-image-hold", "exact-suspect", "weekly", "item",
  "confirm", "confirm-intake", "login", "intake-find", "intake-bootleg", "intake-price"];
const root = resolve(process.env.REPO_ROOT ?? ".");
const chrome = process.env.CHROME;
if (!chrome) throw new Error("set CHROME to a Chromium executable (e.g. ~/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe)");
const pnpmDir = join(root, "node_modules/.pnpm");
const sharpDir = readdirSync(pnpmDir).find((name) => name.startsWith("sharp@"));
const sharp = createRequire(import.meta.url)(join(pnpmDir, sharpDir, "node_modules/sharp"));
const shots = mkdtempSync(join(tmpdir(), "mail-headers-"));
const page = `file:///${join(root, "scripts/mail-headers/header.html").replace(/\/g, "/")}`;

for (const kind of KINDS) {
  const shot = join(shots, `${kind}.png`);
  // 每张图一个独立的临时用户目录：共用默认目录时，残留的无头 Chromium 会接走请求、不写截图却照样返回 0。
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--user-data-dir=${join(shots, `profile-${kind}`)}`,
    "--window-size=640,240", "--virtual-time-budget=10000", `--screenshot=${shot}`, `${page}#${kind}`]);
  const png = await sharp(shot).png({ palette: true, quality: 92, effort: 10, compressionLevel: 9 }).toBuffer();
  for (const dir of ["apps/web/public/art/mail"]) {
    writeFileSync(join(root, dir, `header-${kind}-${VERSION}.png`), png);
  }
  console.log(kind, png.length);
}
