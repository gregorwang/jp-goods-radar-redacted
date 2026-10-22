/**
 * 飞书事件 / 回调请求的解密与验签（docs/研究/飞书自建应用机器人-能力调研-20261013.md §2）。
 *
 * - 开了 Encrypt Key：请求体是 {"encrypt":"…"}。base64 解码后前 16 字节是 IV，
 *   key = SHA256(EncryptKey)，AES-256-CBC + PKCS7（WebCrypto 的 AES-CBC 自带去填充）。
 * - 签名：X-Lark-Signature = hex(SHA256(timestamp + nonce + EncryptKey + 原始请求体))。只有开了 Encrypt Key 才有。
 * - Verification Token：解密后 header.token（2.0 结构）或 token（URL 校验、1.0 结构）。
 */

const encoder = new TextEncoder();

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decryptFeishu(encrypted: string, encryptKey: string): Promise<string> {
  const raw = base64Bytes(encrypted);
  if (raw.byteLength <= 16) throw new Error("encrypt 太短");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(encryptKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  return new TextDecoder().decode(plain);
}

/** 请求头带了签名就必须对上；没带（没开 Encrypt Key）返回 null，由调用方决定。 */
export async function feishuSignatureValid(request: Request, rawBody: string, encryptKey: string | undefined): Promise<boolean | null> {
  const signature = request.headers.get("X-Lark-Signature");
  if (!signature) return null;
  if (!encryptKey) return false;
  const timestamp = request.headers.get("X-Lark-Request-Timestamp") ?? "";
  const nonce = request.headers.get("X-Lark-Request-Nonce") ?? "";
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(timestamp + nonce + encryptKey + rawBody)));
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(digest)),
    crypto.subtle.digest("SHA-256", encoder.encode(signature.toLowerCase())),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function tokenEquals(given: unknown, expected: string | undefined): Promise<boolean> {
  if (typeof given !== "string" || !given || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
