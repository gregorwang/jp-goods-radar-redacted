import { describe, expect, it, vi } from "vitest";
import { sendResendEmail } from "../packages/email/src/resend";
import {
  dailyDigestEmail,
  keywordDigestEmail,
  listingEmail,
  morningDigestEmail,
  weeklyExactReportEmail,
  sourceErrorEmail,
  watchCompletedEmail,
} from "../packages/email/src/templates";

describe("Weekly exact-product report", () => {
  it("puts profiles with news first and keeps quiet ones in the overview only", () => {
    const template = weeklyExactReportEmail({
      kind: "weekly_exact_report",
      windowStartedAt: "2026-09-14T00:15:00.000Z",
      windowEndedAt: "2026-09-21T00:15:00.000Z",
      profiles: [
        {
          profileName: "初音ミク 色紙", targetPrice: null, checks: 84, newOfferCount: 0, dropCount: 0, targetHitCount: 0,
          newOffers: [], drops: [], targetHits: [], lowestNow: 2_200, lowestWeekAgo: 2_200,
        },
        {
          profileName: "メダリスト展 アートブック", targetPrice: 3_700, checks: 168, newOfferCount: 1, dropCount: 0, targetHitCount: 1,
          newOffers: [{ sourceId: "mercari_jp", title: "メダリスト展 アートブック", url: "https://jp.mercari.com/item/m1", price: 3_600, available: true, auction: false }],
          drops: [],
          targetHits: [{ sourceId: "mercari_jp", title: "メダリスト展 アートブック", url: "https://jp.mercari.com/item/m1", price: 3_600, available: true, auction: false }],
          lowestNow: 3_600, lowestWeekAgo: 4_800,
        },
      ],
    });
    expect(template.subject).toContain("1 个档案有新情况");
    expect(template.text).toContain("2 个档案 · 1 个有新情况 · 1 个本周没有变化");
    expect(template.text).toContain("★ 到目标价");
    expect(template.text).toContain("比一周前低 ￥1,200");
    expect(template.text).not.toContain("初音ミク 色紙\n  ");
    expect(template.html).not.toContain("health");
  });
});

describe("Resend delivery", () => {
  it("sends HTML and plain text with an idempotency key", async () => {
    let request: Request | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ id: "email_123" });
    }) as unknown as typeof fetch;
    const id = await sendResendEmail({ apiKey: "secret", from: "Radar <alerts@example.com>", to: "owner@example.com", subject: "Alert", html: "<p>Alert</p>", text: "Alert", idempotencyKey: "event/123" }, fetcher);
    expect(id).toBe("email_123");
    expect(request?.headers.get("Idempotency-Key")).toBe("event/123");
    expect(await request?.json()).toMatchObject({ text: "Alert", html: "<p>Alert</p>" });
  });

  it("sends a base64 PDF attachment", async () => {
    let request: Request | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ id: "email_pdf_123" });
    }) as unknown as typeof fetch;
    await sendResendEmail({
      apiKey: "secret",
      from: "Radar <alerts@example.com>",
      to: "owner@example.com",
      subject: "Daily report",
      html: "<p>Report</p>",
      idempotencyKey: "report/2026-08-21",
      attachments: [{ filename: "report.pdf", content: "JVBERg==" }],
    }, fetcher);
    expect(await request?.json()).toMatchObject({
      attachments: [{ filename: "report.pdf", content: "JVBERg==" }],
    });
  });

  it("fails closed when Resend rejects a request", async () => {
    const fetcher = vi.fn(async () => Response.json({ message: "rejected" }, { status: 403 })) as unknown as typeof fetch;
    await expect(sendResendEmail({ apiKey: "secret", from: "a@example.com", to: "b@example.com", subject: "x", html: "x", idempotencyKey: "event/403" }, fetcher)).rejects.toThrow("403");
  });

  it("cancels a chunked oversized Resend response", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
    }))) as unknown as typeof fetch;

    await expect(sendResendEmail({
      apiKey: "secret",
      from: "a@example.com",
      to: "b@example.com",
      subject: "x",
      html: "x",
      idempotencyKey: "event/oversized",
    }, fetcher)).rejects.toThrow("4 KiB");
    expect(cancel).toHaveBeenCalled();
  });

  it("escapes source failure content in HTML", () => {
    const template = sourceErrorEmail({
      sourceId: "source<script>",
      profileName: "同款<script>监控",
      monitorTarget: "目标<img onerror=alert(1)>",
      code: "facts.imageUrls",
      message: "<img onerror=alert(1)>",
      failures: 3,
    });
    expect(template.subject).toContain("【格银西里尔】");
    expect(template.html).not.toContain("<script>");
    expect(template.html).not.toContain("<img onerror");
    expect(template.text).toContain("监控：同款<script>监控");
    expect(template.text).toContain("错误码：facts.imageUrls");
    expect(template.text).toContain("连续失败 3 次");
  });

  it("renders a bounded and escaped daily digest", () => {
    const template = dailyDigestEmail({ day: "2026-07-12", total: 51, items: [{ type: "new_listing", sourceId: "rakuten_ichiba", title: "<script>alert(1)</script>", url: "https://example.com/item?a=1&b=2", price: 5000 }] });
    expect(template.subject).toContain("51 条");
    expect(template.html).not.toContain("<script>");
    expect(template.html).toContain("另有 50 条");
    expect(template.text).toContain("￥5,000");
  });

  it("shows the product source without leaking internal event JSON", () => {
    const template = listingEmail("new_listing", {
      sourceId: "mercari_jp", sourceItemId: "m12345678901", identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m12345678901", title: "千反田える",
      currency: "JPY", currentPrice: 3000, priceBasis: "listing_price", condition: "used", availability: "available",
    }, { current: { price: 3_000, stateHash: "internal-only" } });
    expect(template.html).toContain("Mercari");
    expect(template.subject).toContain("【格银西里尔】");
    expect(template.text).toContain("￥3,000");
    expect(template.text).toContain("不代表平台完整库存");
    expect(template.html).not.toContain("stateHash");
    expect(template.text).not.toContain("internal-only");
  });

  it("labels an initially available stock watch without claiming a restock transition", () => {
    const template = listingEmail("restock", {
      sourceId: "rakuten_ichiba",
      sourceItemId: "gscraft:n0066",
      identityScope: "listing",
      canonicalUrl: "https://item.rakuten.co.jp/gscraft/n0066/",
      title: "在庫監視商品",
      currency: "JPY",
      currentPrice: 4_000,
      priceBasis: "listing_price",
      condition: "new",
      availability: "available",
    }, {
      previousAvailability: "unknown",
      currentAvailability: "available",
      initialObservation: true,
    });
    expect(template.subject).toContain("商品当前有货");
    expect(template.text).toContain("首次检查：当前可购买");
    expect(template.text).not.toContain("此前状态");
  });

  it("labels each target-price strong reminder with its sequence", () => {
    const template = listingEmail("target_price", {
      sourceId: "mercari_jp",
      sourceItemId: "m-strong-reminder",
      identityScope: "listing",
      canonicalUrl: "https://jp.mercari.com/item/m-strong-reminder",
      title: "加藤恵 ふわぷち 私服Ver",
      currency: "JPY",
      currentPrice: 2_000,
      priceBasis: "listing_price",
      condition: "used",
      availability: "available",
    }, {
      targetPrice: 2_500,
      newPrice: 2_000,
      strongReminder: { sequence: 2, total: 3, intervalMinutes: 20, emailOnlyRepeat: true },
    });

    expect(template.subject).toContain("[强提醒 2/3]");
    expect(template.html).toContain("确认同款已进入目标价");
    expect(template.text).toContain("第 2/3 次强提醒");
  });

  it("renders one mobile-friendly keyword digest with image, title, source and price", () => {
    const template = keywordDigestEmail({
      day: "2026-07-15",
      profileName: "爱蜜莉雅",
      total: 2,
      sourceCounts: [{ sourceId: "mercari_jp", count: 1 }, { sourceId: "rakuten_ichiba", count: 1 }],
      items: [
        { sourceId: "mercari_jp", title: "エミリア アクリルスタンド", price: 1_200, imageUrl: "https://static.example.com/emilia.jpg", url: "https://jp.mercari.com/item/m1" },
        { sourceId: "rakuten_ichiba", title: "<script>bad</script>", price: 680, url: "javascript:alert(1)" },
      ],
    });
    expect(template.subject).toContain("发现 2 件新的商品");
    expect(template.html).toContain("格银西里尔");
    expect(template.html).toContain("Mercari 1 件 · 乐天市场 1 件");
    expect(template.html).toContain("https://static.example.com/emilia.jpg");
    expect(template.html).not.toContain("<script>");
    expect(template.html).not.toContain("javascript:");
    expect(template.text).toContain("￥1,200");
  });

  it("renders an initial keyword baseline without presenting existing items as new", () => {
    const template = keywordDigestEmail({
      kind: "keyword_initial_baseline",
      day: "2026-08-30",
      profileName: "路人女主｜加藤惠",
      total: 42,
      baselineTotal: 42,
      newTotal: 0,
      sourceCounts: [{ sourceId: "mercari_jp", count: 42 }],
      items: [{ sourceId: "mercari_jp", title: "加藤恵 アクリルスタンド", price: 1_200 }],
    });
    expect(template.subject).toContain("首次巡回完成，已建立 42 件基线");
    expect(template.text).toContain("首次收录");
    expect(template.text).toContain("不会冒充今天新上架");
    expect(template.text).not.toContain("新增 42 件");
  });

  it("separates a new source baseline and recovered evidence from first discoveries", () => {
    const template = keywordDigestEmail({
      kind: "keyword_scan_summary", profileName: "加藤惠", total: 53,
      newTotal: 18, recoveredTotal: 34, baselineTotal: 1, baselineSourceIds: ["amiami"],
      items: [
        { sourceId: "amiami", title: "存量", category: "baseline" },
        { sourceId: "mercari_jp", title: "旧商品", category: "recovered" },
        { sourceId: "mercari_jp", title: "新发现", category: "new" },
      ],
      failedSources: ["rakuten_ichiba"],
      sourceIssues: [{ sourceId: "rakuten_ichiba", status: "skipped", errorCode: "keyword_rules_filtered_all" }],
    });
    expect(template.subject).toContain("首次发现 18 件 · 恢复识别 34 件 · 来源基线 1 件");
    expect(template.text).toContain("【来源基线】");
    expect(template.text).toContain("【恢复识别】");
    expect(template.text).toContain("本轮建立基线的来源：AmiAmi");
    expect(template.html).not.toContain("本轮未完成");
    expect(template.subject).not.toContain("首次巡回");
  });

  it("renders an exact-product digest as confirmed same-item discoveries", () => {
    const template = keywordDigestEmail({
      kind: "exact_product_new_listing",
      day: "2026-07-18",
      profileName: "同款 · 雪ミク限定ストラップ",
      total: 1,
      items: [{ sourceId: "mercari_jp", title: "雪ミク HAC JAL 限定ストラップ", price: 3_800 }],
    });
    expect(template.subject).toContain("发现 1 件新的确认同款");
    expect(template.subject).toContain("【格银西里尔】雪ミク限定ストラップ");
    expect(template.subject).not.toContain("同款 ·");
    expect(template.text).toContain("确认同款上新");
    expect(template.text).toContain("确定性命中或经语义复核确认");
  });

  it("distinguishes a safety rejection from a source that did not finish", () => {
    const template = keywordDigestEmail({
      day: "2026-08-20",
      profileName: "爱蜜莉雅",
      total: 2,
      items: [{ sourceId: "surugaya", title: "商品", price: 1_000 }],
      sourceIssues: [
        { sourceId: "rakuten_ichiba", status: "skipped", code: "suspected_source_degradation" },
        { sourceId: "mercari_jp", status: "rate_limited", code: "http_429" },
      ],
    });
    expect(template.text).toContain("已完成采集但未纳入本轮：乐天市场");
    expect(template.text).toContain("安全校验未通过");
    expect(template.text).toContain("本轮未完成：Mercari");
    expect(template.html).toContain("原始采集结果仍已保留");
  });

  it("renders a safe terminal-watch completion notice", () => {
    const template = watchCompletedEmail({
      sourceId: "mercari_jp",
      profileName: "千反田<script>监控",
      title: "限定徽章<img onerror=alert(1)>",
      url: "javascript:alert(1)",
      terminalAvailability: "sold_out",
      terminalDays: 7,
    });
    expect(template.subject).toContain("监控已完成");
    expect(template.html).not.toContain("<script>");
    expect(template.html).not.toContain("<img onerror");
    expect(template.html).not.toContain("javascript:");
    expect(template.text).toContain("连续 7 天");
  });

  it("renders the proactive JST morning digest with typed counts", () => {
    const template = morningDigestEmail({
      day: "2026-07-26",
      total: 3,
      counts: [
        { type: "new_listing", count: 2 },
        { type: "price_rise", count: 1 },
      ],
      items: [{
        type: "price_rise",
        sourceId: "mercari_jp",
        title: "限定商品",
        price: 4_800,
        url: "https://jp.mercari.com/item/morning-item",
      }],
    });
    expect(template.subject).toContain("早间雷达摘要（3 条）");
    expect(template.html).toContain("东京时间 09:00");
    expect(template.text).toContain("新商品 2 条 · 价格上涨 1 条");
    expect(template.text).toContain("￥4,800");
  });
});
