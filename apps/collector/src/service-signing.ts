import { serviceSignatureMessage } from "@jpgr/core";

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

const importedSigningKeys = new Map<string, Promise<CryptoKey>>();
const MAX_CACHED_SIGNING_KEYS = 4;

function importedSigningKey(signingKey: string): Promise<CryptoKey> {
  const cached = importedSigningKeys.get(signingKey);
  if (cached) {
    importedSigningKeys.delete(signingKey);
    importedSigningKeys.set(signingKey, cached);
    return cached;
  }
  const imported = crypto.subtle.importKey(
    "pkcs8",
    base64UrlBytes(signingKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  importedSigningKeys.set(signingKey, imported);
  imported.catch(() => {
    if (importedSigningKeys.get(signingKey) === imported) importedSigningKeys.delete(signingKey);
  });
  while (importedSigningKeys.size > MAX_CACHED_SIGNING_KEYS) {
    const oldest = importedSigningKeys.keys().next().value;
    if (oldest === undefined) break;
    importedSigningKeys.delete(oldest);
  }
  return imported;
}

export async function signServiceRequest(
  signingKey: string,
  scope: string,
  timestamp: string,
  body: unknown,
): Promise<string> {
  const key = await importedSigningKey(signingKey);
  const message = new TextEncoder().encode(serviceSignatureMessage(scope, timestamp, body));
  return bytesToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message));
}
