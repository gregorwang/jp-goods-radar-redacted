import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeSession,
  encodeSession,
  validOrigin,
  verifyPasswordDigest,
} from "../apps/web/src/lib/auth-core";

const SECRET = "test-session-secret-with-enough-entropy";
const NOW = Date.parse("2026-07-27T00:00:00.000Z");

describe("admin auth primitives", () => {
  it("accepts a valid signed session and rejects tampering or trailing segments", async () => {
    const token = await encodeSession(SECRET, {
      sub: "admin",
      exp: NOW + 60_000,
      nonce: "nonce-1",
    });

    await expect(decodeSession(SECRET, token, NOW)).resolves.toMatchObject({ sub: "admin", nonce: "nonce-1" });
    const [data, signature] = token.split(".");
    await expect(decodeSession(SECRET, `${data}x.${signature}`, NOW)).resolves.toBeNull();
    await expect(decodeSession(SECRET, `${token}.ignored`, NOW)).resolves.toBeNull();
  });

  it("rejects expired sessions", async () => {
    const token = await encodeSession(SECRET, {
      sub: "admin",
      exp: NOW,
      nonce: "nonce-2",
    });
    await expect(decodeSession(SECRET, token, NOW)).resolves.toBeNull();
  });

  it("compares the configured password digest without exposing the password", async () => {
    const digest = createHmac("sha256", SECRET).update("correct horse").digest("hex");
    await expect(verifyPasswordDigest(SECRET, digest, "correct horse")).resolves.toBe(true);
    await expect(verifyPasswordDigest(SECRET, digest, "wrong")).resolves.toBe(false);
  });
});

describe("validOrigin", () => {
  it("accepts only the request URL host", () => {
    expect(validOrigin(new Request("https://worker.example.com/api", {
      headers: { origin: "https://worker.example.com" },
    }))).toBe(true);
    expect(validOrigin(new Request("https://worker.example.com/api", {
      headers: { origin: "https://admin.example.com" },
    }))).toBe(false);
  });

  it("rejects absent, malformed, non-http, or forwarded-host-only origins", () => {
    expect(validOrigin(new Request("https://worker.example.com/api"))).toBe(false);
    expect(validOrigin(new Request("https://worker.example.com/api", {
      headers: { origin: "null" },
    }))).toBe(false);
    expect(validOrigin(new Request("https://worker.example.com/api", {
      headers: { origin: "ftp://worker.example.com" },
    }))).toBe(false);
    expect(validOrigin(new Request("https://worker.example.com/api", {
      headers: {
        origin: "https://attacker.example.com",
        "x-forwarded-host": "attacker.example.com",
      },
    }))).toBe(false);
  });
});
