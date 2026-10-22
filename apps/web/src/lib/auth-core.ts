const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SessionPayload {
  sub: "admin";
  exp: number;
  nonce: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  if (!secret) throw new Error("auth_secret_missing");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

export async function verifyPasswordDigest(
  secret: string,
  digest: string,
  password: string,
): Promise<boolean> {
  if (!secret || !digest) return false;
  const calculated = hex(await hmac(secret, password));
  return constantTimeEqual(encoder.encode(calculated), encoder.encode(digest.toLowerCase()));
}

export async function encodeSession(secret: string, payload: SessionPayload): Promise<string> {
  const data = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = toBase64Url(await hmac(secret, data));
  return `${data}.${signature}`;
}

export async function decodeSession(
  secret: string,
  value: string | undefined,
  now = Date.now(),
): Promise<SessionPayload | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  if (!data || !signature) return null;
  try {
    const expected = await hmac(secret, data);
    if (!constantTimeEqual(expected, fromBase64Url(signature))) return null;
    const payload: unknown = JSON.parse(decoder.decode(fromBase64Url(data)));
    if (payload === null || typeof payload !== "object") return null;
    const session = payload as Partial<SessionPayload>;
    if (
      session.sub !== "admin"
      || !Number.isFinite(session.exp)
      || Number(session.exp) <= now
      || typeof session.nonce !== "string"
      || session.nonce.length === 0
    ) return null;
    return session as SessionPayload;
  } catch {
    return null;
  }
}

export function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") return false;
    return originUrl.host.toLowerCase() === new URL(request.url).host.toLowerCase();
  } catch {
    return false;
  }
}
