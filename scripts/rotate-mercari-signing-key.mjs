import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--confirm-rotation")) {
  console.error("Refusing to rotate without --confirm-rotation");
  process.exit(2);
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const [privateKey, publicKey] = await Promise.all([
  webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  webcrypto.subtle.exportKey("spki", keyPair.publicKey),
]);
const privateValue = Buffer.from(privateKey).toString("base64url");
const publicValue = Buffer.from(publicKey).toString("base64url");
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) {
  console.error("Unable to locate the active pnpm entrypoint.");
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [pnpmEntrypoint, "--filter", "@jpgr/collector", "exec", "wrangler", "secret", "put", "MERCARI_ADAPTER_SIGNING_KEY"],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    input: `${privateValue}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
if (result.status !== 0) {
  console.error("Cloudflare secret update failed; no private key was written to disk.");
  process.exit(result.status ?? 1);
}

const fingerprint = createHash("sha256").update(Buffer.from(publicKey)).digest("hex").slice(0, 16);
console.log(`Public key (safe to commit): ${publicValue}`);
console.log(`Public key fingerprint: ${fingerprint}`);
