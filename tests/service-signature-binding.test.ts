import { describe, expect, it } from "vitest";
import { canonicalJson, serviceSignatureMessage } from "@jpgr/core";
import { mercariSearchBodySchema, surugayaSearchBodySchema } from "../apps/mercari-service/src/schemas";

/**
 * Collector 对 payload 签名并发送 canonicalJson(payload)（source-execution.ts）。
 * 固定用途服务必须对"实际收到的请求体"验签，而不是 zod 变换后的 parsed.data，
 * 否则签名不再绑定传输字节，且带首尾空白的合法请求会被误判为签名无效。
 */
describe("固定用途服务的签名绑定对象", () => {
  const payload = {
    query: "氷菓 千反田える",
    filters: { page: 1, pageSize: 30, sort: "newest" as const, inStockOnly: true },
    sourceConfig: { includeMarketplace: true },
  };

  it("请求体经 JSON 往返后 canonical 形式与签名时一致", () => {
    const transmitted = canonicalJson(payload);
    const received: unknown = JSON.parse(transmitted);
    expect(canonicalJson(received)).toBe(transmitted);
    expect(serviceSignatureMessage("surugaya.search.v1", "1750000000000", received))
      .toBe(serviceSignatureMessage("surugaya.search.v1", "1750000000000", payload));
  });

  it("zod 的 trim 变换会让 parsed.data 与传输字节不一致", () => {
    const withWhitespace = { ...payload, query: "  氷菓 千反田える  " };
    const transmitted = canonicalJson(withWhitespace);
    const received: unknown = JSON.parse(transmitted);
    const parsed = surugayaSearchBodySchema.parse(received);

    // 对 request.body 验签：与签名时逐字节一致。
    expect(canonicalJson(received)).toBe(transmitted);
    // 对 parsed.data 验签：trim 后的 query 使 canonical 形式改变，签名必然不匹配。
    expect(canonicalJson(parsed)).not.toBe(transmitted);
  });

  it("键顺序不同不影响 canonical 形式，因此不会造成假的签名失败", () => {
    const reordered = {
      sourceConfig: payload.sourceConfig,
      filters: { sort: "newest" as const, inStockOnly: true, pageSize: 30, page: 1 },
      query: payload.query,
    };
    expect(canonicalJson(reordered)).toBe(canonicalJson(payload));
    expect(mercariSearchBodySchema.safeParse(JSON.parse(canonicalJson(reordered))).success).toBe(true);
  });
});
