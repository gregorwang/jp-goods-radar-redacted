import { describe, expect, it } from "vitest";
import {
  strongReminderDeliveryTimes,
  strongReminderPolicyFromSourceConfig,
} from "@jpgr/core";

describe("strong target-price reminders", () => {
  it("defaults to three deliveries separated by twenty minutes", () => {
    const policy = strongReminderPolicyFromSourceConfig({
      strongReminder: { enabled: true },
    });

    expect(policy).toEqual({ enabled: true, intervalMinutes: 20, repeatCount: 3 });
    expect(strongReminderDeliveryTimes("2026-09-01T10:00:00.000Z", policy)).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:20:00.000Z",
      "2026-09-01T10:40:00.000Z",
    ]);
  });

  it("does not schedule deliveries when the explicit opt-in is disabled", () => {
    const policy = strongReminderPolicyFromSourceConfig({});
    expect(policy.enabled).toBe(false);
    expect(strongReminderDeliveryTimes("2026-09-01T10:00:00.000Z", policy)).toEqual([]);
  });
});
