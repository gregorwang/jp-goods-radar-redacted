import { describe, expect, it } from "vitest";
import { parseExactProductConfig } from "../apps/web/src/lib/exact-product-config";

const intervals = ["30", "60", "180", "240", "360", "720", "1440"];

describe("exact-product config sheet", () => {
  it("maps a full config onto the composer fields and reports unsupported parts", () => {
    const fill = parseExactProductConfig(JSON.stringify({
      name: "WHITE ALBUM2 小木曽雪菜 ぬいぐるみ",
      canonical_name: "『WHITE ALBUM2』ぬいぐるみ「小木曽雪菜」",
      title_queries: ["a", "b", "c", "d", "e"],
      identity_groups: [["小木曽雪菜", "雪菜"], ["ぬいぐるみ", "ぬい"]],
      evidence_groups: [["WHITE ALBUM2", "WA2"]],
      exclude_terms: ["フィギュア", "カード"],
      price: { currency: "JPY", target: 7000, strong_alert: true, secondary_alert_max: 8000 },
      cadence: { type: "interval", minutes: 60 },
      sources: { mode: "secondhand_priority", enabled: ["mercari", "yahoo_fleamarket", "yahoo_auction", "rakuma", "surugaya"] },
      matching: { allow_bundle: true },
    }), intervals);
    expect(fill.query).toBe("『WHITE ALBUM2』ぬいぐるみ「小木曽雪菜」");
    expect(fill.recallQueries.split("\n")).toEqual(["a", "b", "c", "d"]);
    expect(fill.requiredGroups).toBe("小木曽雪菜|雪菜, ぬいぐるみ|ぬい");
    expect(fill.supportingGroups).toBe("WHITE ALBUM2|WA2");
    expect(fill.excludedTerms).toBe("フィギュア, カード");
    expect(fill.targetPrice).toBe("7000");
    expect(fill.strongReminder).toBe(true);
    expect(fill.intervalMinutes).toBe("60");
    expect(fill.sources).toEqual(["mercari_jp", "yahoo_fleamarket_jp", "yahoo_auctions_jp", "surugaya"]);
    expect(fill.ignored.join("\n")).toMatch(/rakuma/);
    expect(fill.ignored.join("\n")).toMatch(/secondary_alert_max/);
    expect(fill.ignored.join("\n")).toMatch(/matching/);
  });

  it("refuses strong reminders without a target price and rejects bad JSON", () => {
    const fill = parseExactProductConfig('{"name":"x","price":{"strong_alert":true}}', intervals);
    expect(fill.strongReminder).toBe(false);
    expect(() => parseExactProductConfig("{", intervals)).toThrow(/JSON/);
    expect(() => parseExactProductConfig("{}", intervals)).toThrow(/canonical_name/);
  });
});
