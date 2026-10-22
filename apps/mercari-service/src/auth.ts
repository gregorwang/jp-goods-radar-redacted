import { serviceSignatureMessage } from "../../../packages/core/src/index.js";
import { MERCARI_SERVICE_PUBLIC_KEY } from "./public-key.js";
import type { VercelRequest } from "./vercel-types.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[a-f0-9]{128}$/i.test(value)) return undefined;
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return undefined;
  }
}

export type AuthFailure = "request_timestamp_invalid" | "request_signature_invalid" | "request_replayed";

// 时间窗内的一次性签名记录。Vercel 每个函数实例各自持有一份，因此这是尽力而为的
// 单实例防护：与 source-runner 的进程内 Map 同级，重启或换实例后重新计数。
// 需要跨实例硬保证时应改为 KV/Upstash，键为签名 hex、TTL 与时间窗一致。
const seenSignatures = new Map<string, number>();

function consumeReplayKey(key: string, now: number): boolean {
  for (const [candidate, expiresAt] of seenSignatures) {
    if (expiresAt <= now) seenSignatures.delete(candidate);
  }
  if (seenSignatures.has(key)) return false;
  seenSignatures.set(key, now + MAX_CLOCK_SKEW_MS);
  return true;
}

export async function verifyServiceRequest(
  request: VercelRequest,
  scope: string,
  body: unknown,
): Promise<AuthFailure | undefined> {
  const timestamp = singleHeader(request.headers["x-jpgr-timestamp"]);
  const signature = singleHeader(request.headers["x-jpgr-signature"]);
  const timestampMs = timestamp && /^\d{13}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return "request_timestamp_invalid";
  }
  if (!timestamp) return "request_timestamp_invalid";

  const signatureBytes = signature ? hexBytes(signature) : undefined;
  if (!signatureBytes) return "request_signature_invalid";

  const publicKey = base64UrlBytes(MERCARI_SERVICE_PUBLIC_KEY);
  if (!publicKey) return "request_signature_invalid";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "spki",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes,
    encoder.encode(serviceSignatureMessage(scope, timestamp, body)),
  );
  if (!valid) return "request_signature_invalid";
  return consumeReplayKey(`${timestamp}:${signature!.toLowerCase()}`, Date.now())
    ? undefined
    : "request_replayed";
}
