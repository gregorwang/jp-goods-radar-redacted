import { describe, expect, it } from "vitest";
import {
  isTokyoOvernightQuietHours,
  nextOvernightCollectionExpiry,
  overnightCollectionPolicy,
} from "../packages/core/src/collection-policy";

describe("overnight collection policy", () => {
  it("uses the fixed Tokyo 00:00-05:00 window", () => {
    expect(isTokyoOvernightQuietHours("2026-08-20T14:59:59.000Z")).toBe(false);
    expect(isTokyoOvernightQuietHours("2026-08-20T15:00:00.000Z")).toBe(true);
    expect(isTokyoOvernightQuietHours("2026-08-20T19:59:59.000Z")).toBe(true);
    expect(isTokyoOvernightQuietHours("2026-08-20T20:00:00.000Z")).toBe(false);
  });

  it("expires a temporary override at the next Tokyo 05:00", () => {
    expect(nextOvernightCollectionExpiry("2026-08-20T16:30:00.000Z"))
      .toBe("2026-08-20T20:00:00.000Z");
    expect(nextOvernightCollectionExpiry("2026-08-20T10:00:00.000Z"))
      .toBe("2026-08-20T20:00:00.000Z");
  });

  it("allows automatic collection only while a valid override is active", () => {
    const now = "2026-08-20T16:30:00.000Z";
    expect(overnightCollectionPolicy(now).automaticCollectionAllowed).toBe(false);
    expect(overnightCollectionPolicy(now, {
      enabled: 1,
      config_json: JSON.stringify({ expiresAt: "2026-08-20T20:00:00.000Z" }),
    })).toMatchObject({ quietHoursActive: true, overrideActive: true, automaticCollectionAllowed: true });
    expect(overnightCollectionPolicy(now, {
      enabled: 1,
      config_json: JSON.stringify({ expiresAt: "2026-08-20T16:00:00.000Z" }),
    })).toMatchObject({ overrideActive: false, automaticCollectionAllowed: false });
  });
});
