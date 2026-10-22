import { describe, expect, it } from "vitest";
import { watchLifecycle, watchLifecycleLabel, watchOverviewLabel } from "../apps/web/src/lib/watch-lifecycle";

describe("watchLifecycle", () => {
  it("把用户已购买事件视为不可恢复的手动归档", () => {
    const lifecycle = watchLifecycle({
      enabled: 0,
      activeBindingCount: 0,
      bindingCount: 1,
      completion: { payload_json: JSON.stringify({ kind: "user_purchased" }) },
    });
    expect(lifecycle).toEqual({ status: "archived", reason: "user_purchased" });
    expect(watchLifecycleLabel(lifecycle.status, lifecycle.reason)).toBe("已购买归档");
  });

  it("区分自动完成、暂停和部分运行", () => {
    expect(watchLifecycle({
      enabled: 0,
      activeBindingCount: 0,
      bindingCount: 1,
      completion: { payload_json: JSON.stringify({ kind: "terminal_item_watch_completed" }) },
    })).toEqual({ status: "completed", reason: "terminal_listing" });
    expect(watchLifecycle({ enabled: 0, activeBindingCount: 0, bindingCount: 1 }))
      .toEqual({ status: "paused", reason: "user_paused" });
    expect(watchLifecycle({ enabled: 1, activeBindingCount: 1, bindingCount: 2 }))
      .toEqual({ status: "partial", reason: null });
  });
});

describe("watchOverviewLabel", () => {
  it("uses plain labels for failed and paused sources", () => {
    expect(watchOverviewLabel({
      status: "partial",
      reason: null,
      failingBindingCount: 2,
      pausedBindingCount: 1,
    })).toBe("有来源需处理");
    expect(watchOverviewLabel({
      status: "partial",
      reason: null,
      failingBindingCount: 0,
      pausedBindingCount: 1,
    })).toBe("有来源暂停");
    expect(watchOverviewLabel({
      status: "active",
      reason: null,
      failingBindingCount: 0,
      pausedBindingCount: 0,
    })).toBe("运行中");
  });

  it("keeps terminal and profile-level paused labels", () => {
    expect(watchOverviewLabel({
      status: "archived",
      reason: "user_purchased",
      failingBindingCount: 1,
      pausedBindingCount: 0,
    })).toBe("已购买归档");
    expect(watchOverviewLabel({
      status: "paused",
      reason: "user_paused",
      failingBindingCount: 1,
      pausedBindingCount: 0,
    })).toBe("已暂停");
  });
});
