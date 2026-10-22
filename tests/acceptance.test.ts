import { describe, expect, it } from "vitest";
import { evaluateProbeWindow, listingFieldCompleteness, PROBE_WINDOW_MS } from "@jpgr/core";

const startedAt = "2026-07-10T00:00:00.000Z";
const end = Date.parse(startedAt) + PROBE_WINDOW_MS;

describe("48 hour source probe", () => {
  it("does not pass before the complete observation window", () => {
    expect(evaluateProbeWindow({ startedAt, totalRuns: 48, successfulRuns: 48, fieldTotal: 288, fieldComplete: 288,
      captchaRuns: 0, cpuLimitRuns: 0, loginRequiredRuns: 0 }, end - 1).status).toBe("running");
  });

  it("passes only when every Go/No-Go threshold is met", () => {
    const decision = evaluateProbeWindow({ startedAt, totalRuns: 48, successfulRuns: 46, fieldTotal: 600, fieldComplete: 588,
      captchaRuns: 0, cpuLimitRuns: 0, loginRequiredRuns: 0 }, end);
    expect(decision.status).toBe("passed");
    expect(decision.successRate).toBeGreaterThanOrEqual(0.95);
    expect(decision.fieldCompletenessRate).toBeGreaterThanOrEqual(0.98);
  });

  it.each([
    [{ totalRuns: 47 }, "有效探针次数不足"],
    [{ successfulRuns: 45 }, "成功率低于"],
    [{ fieldComplete: 587 }, "关键字段解析率低于"],
    [{ captchaRuns: 1 }, "CAPTCHA"],
    [{ cpuLimitRuns: 1 }, "CPU"],
    [{ loginRequiredRuns: 1 }, "登录依赖"],
  ])("fails closed for %o", (override, reason) => {
    const decision = evaluateProbeWindow({ startedAt, totalRuns: 48, successfulRuns: 48, fieldTotal: 600, fieldComplete: 600,
      captchaRuns: 0, cpuLimitRuns: 0, loginRequiredRuns: 0, ...override }, end);
    expect(decision.status).toBe("failed");
    expect(decision.reasons.join(" ")).toContain(reason);
  });

  it("measures six critical fields per listing", () => {
    expect(listingFieldCompleteness([{ sourceItemId: "1", canonicalUrl: "https://example.com/1", title: "item", currentPrice: 1,
      imageUrl: undefined, availability: "available" }])).toEqual({ total: 6, complete: 5 });
  });
});
