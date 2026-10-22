import { MercariDpopError } from "./errors.js";

const encoder = new TextEncoder();

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export interface DpopSigner {
  readonly deviceUuid: string;
  createProof(method: "GET" | "POST", url: string): Promise<string>;
}

export async function createDpopSigner(): Promise<DpopSigner> {
  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  } catch {
    throw new MercariDpopError("当前 Worker 无法生成 P-256 密钥");
  }
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!exported.kty || !exported.crv || !exported.x || !exported.y) {
    throw new MercariDpopError("Mercari DPoP 公钥导出字段不完整");
  }
  const deviceUuid = crypto.randomUUID();

  return {
    deviceUuid,
    async createProof(method, url) {
      const header = {
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
      } as const;
      const payload = {
        iat: Math.floor(Date.now() / 1_000),
        jti: crypto.randomUUID(),
        htu: url,
        htm: method,
        uuid: deviceUuid,
      } as const;
      const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
      let signed: ArrayBuffer;
      try {
        signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, encoder.encode(signingInput));
      } catch {
        throw new MercariDpopError();
      }
      // WebCrypto 的 ECDSA 签名固定输出 IEEE P1363 裸格式（P-256 即 64 字节 r‖s），
      // ES256 也只接受这一种。长度不符说明运行时行为变了，必须当场失败，
      // 而不是签出一个能发出去、却会被 Mercari 判无效的 DPoP。
      const raw = new Uint8Array(signed);
      if (raw.byteLength !== 64) throw new MercariDpopError("Mercari DPoP ES256 签名长度异常");
      return `${signingInput}.${base64Url(raw)}`;
    },
  };
}
