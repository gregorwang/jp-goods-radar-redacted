import { serviceSignatureMessage } from "@jpgr/core";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

// Public verification material. The matching private key remains only in the
// Cloudflare Worker secret MERCARI_ADAPTER_SIGNING_KEY.
export const SOURCE_RUNNER_PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAP0UZ368aXQDvf7Gu5CRqhMRgvMv2yy8h2wzq6fmaf8OKXojpFWCulWt0zqIt8ppraBIAHfRLt0DQPGXEByxWg";

export type AuthFailure = "request_timestamp_invalid" | "request_signature_invalid" | "request_replayed";

export type AuthResult =
  | { ok: true; replayKey: string }
  | { ok: false; code: AuthFailure };

function hexBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[a-f0-9]{128}$/iu.test(value)) return undefined;
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

export class SignatureReplayGuard {
  readonly #seen = new Map<string, number>();

  consume(key: string, now = Date.now()): boolean {
    for (const [candidate, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(candidate);
    }
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now + MAX_CLOCK_SKEW_MS);
    return true;
  }
}

export async function verifyRunnerRequest(
  headers: Headers,
  scope: string,
  body: unknown,
  replayGuard: SignatureReplayGuard,
  now = Date.now(),
  publicKeyValue = SOURCE_RUNNER_PUBLIC_KEY,
): Promise<AuthResult> {
  const timestamp = headers.get("x-jpgr-timestamp");
  const signature = headers.get("x-jpgr-signature");
  const timestampMs = timestamp && /^\d{13}$/u.test(timestamp) ? Number(timestamp) : Number.NaN;
  if (!timestamp || !Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "request_timestamp_invalid" };
  }
  const signatureBytes = signature ? hexBytes(signature) : undefined;
  const publicKey = base64UrlBytes(publicKeyValue);
  if (!signature || !signatureBytes || !publicKey) return { ok: false, code: "request_signature_invalid" };

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
    new TextEncoder().encode(serviceSignatureMessage(scope, timestamp, body)),
  );
  if (!valid) return { ok: false, code: "request_signature_invalid" };
  const replayKey = `${timestamp}:${signature.toLowerCase()}`;
  return replayGuard.consume(replayKey, now)
    ? { ok: true, replayKey }
    : { ok: false, code: "request_replayed" };
}
