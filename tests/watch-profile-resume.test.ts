import { describe, expect, it } from "vitest";
import { planWatchProfileResume } from "../apps/web/src/lib/watch-profile-resume";

const policy = new Map([
  ["mercari_jp", { monitoringAllowed: true }],
  ["yahoo_shopping", { monitoringAllowed: true }],
  ["yahoo_auctions_jp", { monitoringAllowed: false }],
]);

describe("watch profile resume planning", () => {
  it("resumes every eligible paused source and leaves experiment-off sources paused", () => {
    const result = planWatchProfileResume([
      { id: "mercari", sourceId: "mercari_jp", enabled: false },
      { id: "shopping", sourceId: "yahoo_shopping", enabled: false },
      { id: "auction", sourceId: "yahoo_auctions_jp", enabled: false },
    ], policy);

    expect(result.resumeIds).toEqual(["mercari", "shopping"]);
    expect(result.alreadyActiveCount).toBe(0);
    expect(result.skipped).toEqual([{
      bindingId: "auction",
      sourceId: "yahoo_auctions_jp",
      reason: "source_monitoring_not_allowed",
    }]);
  });

  it("resumes all eligible paused bindings regardless of already active bindings", () => {
    const result = planWatchProfileResume([
      { id: "already-active", sourceId: "mercari_jp", enabled: true },
      { id: "first-paused", sourceId: "mercari_jp", enabled: false },
      { id: "second-paused", sourceId: "yahoo_shopping", enabled: false },
    ], policy);

    expect(result.resumeIds).toEqual(["first-paused", "second-paused"]);
    expect(result.alreadyActiveCount).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("does not manufacture resumable work when every source is unavailable", () => {
    const result = planWatchProfileResume([
      { id: "auction", sourceId: "yahoo_auctions_jp", enabled: false },
    ], policy);

    expect(result.resumeIds).toEqual([]);
    expect(result.alreadyActiveCount).toBe(0);
    expect(result.skipped[0]?.reason).toBe("source_monitoring_not_allowed");
  });
});
