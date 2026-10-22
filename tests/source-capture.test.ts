import { describe, expect, it, vi } from "vitest";
import type { AnalyticsSourceCapture } from "../packages/analytics/src";
import { sha256Hex } from "../packages/core/src";
import { createMercariUpstreamCaptureRecorder } from "../apps/mercari-service/src/upstream-capture";
import {
  createSourceCaptureRecorder,
  separateEmbeddedUpstreamCaptures,
} from "../apps/collector/src/source-capture";

describe("Mercari upstream response evidence", () => {
  it("captures only the bounded upstream response and never request credentials", async () => {
    const upstreamBody = JSON.stringify({ items: [{ id: "FxHFY4yGnZznBUN76YziYm" }] });
    const fetcher = vi.fn(async () => new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    })) as unknown as typeof fetch;
    const recorder = createMercariUpstreamCaptureRecorder(fetcher);
    const response = await recorder.fetch("https://api.mercari.jp/v2/entities:search", {
      method: "POST",
      headers: { DPoP: "private-proof", Cookie: "private-cookie" },
      body: JSON.stringify({ privateRequestValue: "must-not-be-captured" }),
    });
    await response.text();
    const captures = await recorder.flush();

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      version: 1,
      requestUrl: "https://api.mercari.jp/v2/entities:search",
      requestMethod: "POST",
      responseStatus: 200,
      rawPayload: upstreamBody,
      truncated: false,
    });
    expect(JSON.stringify(captures)).not.toContain("private-proof");
    expect(JSON.stringify(captures)).not.toContain("private-cookie");
    expect(JSON.stringify(captures)).not.toContain("must-not-be-captured");
  });

  it("separates the standardized service envelope from the upstream body", async () => {
    const upstreamBody = JSON.stringify({ data: { id: "FxHFY4yGnZznBUN76YziYm" } });
    const envelope = JSON.stringify({
      ok: true,
      data: { listings: [{ sourceItemId: "FxHFY4yGnZznBUN76YziYm" }] },
      meta: {
        runtime: "vercel-node",
        upstreamCaptures: [{
          version: 1,
          requestUrl: "https://api.mercari.jp/v2/entities:search",
          requestMethod: "POST",
          responseStatus: 200,
          contentType: "application/json",
          rawPayload: upstreamBody,
          payloadBytes: new TextEncoder().encode(upstreamBody).byteLength,
          contentHash: await sha256Hex(upstreamBody),
          capturedAt: "2026-07-17T00:00:00.000Z",
          durationMs: 20,
          truncated: false,
          requestHeaders: { DPoP: "must-not-survive" },
        }],
      },
    });
    const outer: AnalyticsSourceCapture = {
      id: "outer",
      sourceId: "mercari_jp",
      ordinal: 1,
      requestUrl: "https://your-mercari-service.vercel.app/api/search",
      requestMethod: "POST",
      responseStatus: 200,
      contentType: "application/json",
      payloadKind: "json",
      rawPayload: envelope,
      payloadBytes: new TextEncoder().encode(envelope).byteLength,
      contentHash: await sha256Hex(envelope),
      capturedAt: "2026-07-17T00:00:00.100Z",
      durationMs: 30,
      truncated: false,
    };

    const captures = await separateEmbeddedUpstreamCaptures(outer);
    expect(captures).toHaveLength(2);
    expect(captures[0]?.rawPayload).not.toContain("upstreamCaptures");
    expect(captures[1]).toMatchObject({
      requestUrl: "https://api.mercari.jp/v2/entities:search",
      rawPayload: upstreamBody,
      contentHash: await sha256Hex(upstreamBody),
    });
    expect(JSON.stringify(captures)).not.toContain("must-not-survive");
  });

  it("separates a signed source-runner HTML response under the declared source", async () => {
    const upstreamBody = "<!doctype html><html><body>Yahoo fixture</body></html>";
    const envelope = JSON.stringify({
      ok: true,
      data: { status: "succeeded", result: { sourceId: "yahoo_fleamarket_jp", listings: [] } },
      meta: {
        runtime: "node-playwright",
        upstreamCaptures: [{
          version: 1,
          requestUrl: "https://paypayfleamarket.yahoo.co.jp/search/test?page=1",
          requestMethod: "GET",
          responseStatus: 200,
          contentType: "text/html",
          rawPayload: upstreamBody,
          payloadBytes: new TextEncoder().encode(upstreamBody).byteLength,
          contentHash: await sha256Hex(upstreamBody),
          capturedAt: "2026-07-22T00:00:00.000Z",
          durationMs: 100,
          truncated: false,
        }],
      },
    });
    const outer: AnalyticsSourceCapture = {
      id: "outer-yahoo",
      sourceId: "yahoo_fleamarket_jp",
      ordinal: 1,
      requestUrl: "https://runner.example.com/v1/jobs/status",
      requestMethod: "POST",
      responseStatus: 200,
      contentType: "application/json",
      payloadKind: "json",
      rawPayload: envelope,
      payloadBytes: new TextEncoder().encode(envelope).byteLength,
      contentHash: await sha256Hex(envelope),
      capturedAt: "2026-07-22T00:00:00.100Z",
      durationMs: 120,
      truncated: false,
    };

    const captures = await separateEmbeddedUpstreamCaptures(outer);

    expect(captures).toHaveLength(2);
    expect(captures[0]?.rawPayload).not.toContain("upstreamCaptures");
    expect(captures[1]).toMatchObject({
      sourceId: "yahoo_fleamarket_jp",
      requestUrl: "https://paypayfleamarket.yahoo.co.jp/search/test?page=1",
      payloadKind: "html",
      payloadBytes: new TextEncoder().encode(upstreamBody).byteLength,
      contentHash: await sha256Hex(upstreamBody),
    });
    expect(captures[1]?.rawPayload).toBeUndefined();
  });

  it("parses HTML through the original response but persists metadata only", async () => {
    const html = "<!doctype html><html><body><p>商品説明</p></body></html>";
    const fetcher = vi.fn(async () => new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
    const recorder = createSourceCaptureRecorder("amazon_jp", fetcher);

    const response = await recorder.fetch("https://www.amazon.co.jp/s?k=test");
    expect(await response.text()).toBe(html);
    const [capture] = await recorder.flush();

    expect(capture).toMatchObject({
      payloadKind: "html",
      payloadBytes: new TextEncoder().encode(html).byteLength,
      contentHash: await sha256Hex(html),
    });
    expect(capture?.rawPayload).toBeUndefined();
  });
});
