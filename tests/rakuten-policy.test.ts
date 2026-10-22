import { describe, expect, it } from "vitest";
import { rakutenMonitoringEnabledForSource } from "../apps/web/src/lib/rakuten-policy";

describe("Rakuten per-source monitoring policy", () => {
  it("keeps Ichiba and Books independent", () => {
    const policy = {
      privateMonitoringEnabled: false,
      privateMonitoringBySource: {
        rakuten_ichiba: true,
        rakuten_books: false,
      },
    } as const;
    expect(rakutenMonitoringEnabledForSource("rakuten_ichiba", policy)).toBe(true);
    expect(rakutenMonitoringEnabledForSource("rakuten_books", policy)).toBe(false);
  });

  it("uses the legacy combined flag only when a source-specific value is absent", () => {
    expect(rakutenMonitoringEnabledForSource("rakuten_ichiba", { privateMonitoringEnabled: true })).toBe(true);
    expect(rakutenMonitoringEnabledForSource("rakuten_books", {
      privateMonitoringEnabled: true,
      privateMonitoringBySource: { rakuten_books: false },
    })).toBe(false);
  });
});
