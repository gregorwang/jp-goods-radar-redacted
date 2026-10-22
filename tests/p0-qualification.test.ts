import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldAutoRunP0 } from "../apps/collector/src/p0-qualification";
import { createPacedFetch } from "../apps/collector/src/request-pacer";

const now = Date.parse("2026-07-12T06:00:00.000Z");

describe("automatic P0 qualification policy", () => {
  afterEach(() => vi.useRealTimers());

  it("starts as soon as every provider credential is available", () => {
    expect(shouldAutoRunP0({ credentialsReady: true, allP0ChecksPassed: false }, now)).toBe(true);
  });

  it("does not run without complete credentials or after all checks passed", () => {
    expect(shouldAutoRunP0({ credentialsReady: false, allP0ChecksPassed: false }, now)).toBe(false);
    expect(shouldAutoRunP0({ credentialsReady: true, allP0ChecksPassed: true }, now)).toBe(false);
  });

  it("does not overlap a current run", () => {
    expect(shouldAutoRunP0({ credentialsReady: true, allP0ChecksPassed: false,
      latestRun: { status: "running", started_at: new Date(now - 5 * 60_000).toISOString() } }, now)).toBe(false);
  });

  it("waits six hours before retrying a completed or stale run", () => {
    expect(shouldAutoRunP0({ credentialsReady: true, allP0ChecksPassed: false,
      latestRun: { status: "failed", started_at: new Date(now - 6 * 60 * 60_000 + 1).toISOString() } }, now)).toBe(false);
    expect(shouldAutoRunP0({ credentialsReady: true, allP0ChecksPassed: false,
      latestRun: { status: "failed", started_at: new Date(now - 6 * 60 * 60_000).toISOString() } }, now)).toBe(true);
  });

  it("serializes Rakuten calls and spaces their start times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const starts: number[] = [];
    const upstream = vi.fn(async () => {
      starts.push(Date.now());
      return Response.json({ ok: true });
    }) as typeof fetch;
    const paced = createPacedFetch(upstream, 1_100);
    const first = paced("https://openapi.rakuten.co.jp/first");
    const second = paced("https://openapi.rakuten.co.jp/second");

    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(starts).toEqual([now, now + 1_100]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
