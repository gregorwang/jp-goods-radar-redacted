import { describe, expect, it } from "vitest";
import { isWeeklyMarketDigestTick } from "../apps/collector/src/weekly-schedule";

describe("weekly market digest schedule", () => {
  it("fires at Monday 09:15 Tokyo time", () => {
    expect(isWeeklyMarketDigestTick("2026-08-24T00:15:00.000Z")).toBe(true);
  });

  it("does not overlap the daily scan at another minute or day", () => {
    expect(isWeeklyMarketDigestTick("2026-08-24T00:14:00.000Z")).toBe(false);
    expect(isWeeklyMarketDigestTick("2026-08-25T00:15:00.000Z")).toBe(false);
  });
});
