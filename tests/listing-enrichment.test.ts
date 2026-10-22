import { describe, expect, it } from "vitest";
import {
  LISTING_ENRICHMENT_MODEL,
  listingEnrichmentProviderRequest,
  listingEnrichmentMessages,
  listingSemanticProjection,
  parseListingEnrichment,
  parseListingEnrichmentBatch,
  parseListingEnrichmentBatchPartial,
} from "../apps/web/src/lib/listing-enrichment";

const mercariInput = {
  sourceId: "mercari_jp" as const,
  sourceItemId: "m12345678901",
  identityScope: "listing" as const,
  canonicalUrl: "https://jp.mercari.com/item/m12345678901",
  title: "限定版フィギュア",
  descriptionExcerpt: "前髪に小傷あり。箱なし。",
  currency: "JPY",
  currentPrice: 4_800,
  priceBasis: "listing_price" as const,
  condition: "used" as const,
  availability: "available" as const,
  sourceConditionLabel: "やや傷や汚れあり",
};

const surugayaInput = {
  sourceId: "surugaya" as const,
  sourceItemId: "428000001",
  identityScope: "catalog" as const,
  canonicalUrl: "https://www.suruga-ya.jp/product/detail/428000001",
  title: "氷菓 Blu-ray BOX 初回限定版",
  descriptionExcerpt: "収納BOX・ブックレット付き。",
  currency: "JPY",
  currentPrice: 12_800,
  priceBasis: "catalog_price" as const,
  condition: "used" as const,
  availability: "available" as const,
  sourceConditionLabel: "中古",
  category: "Blu-ray",
};

const factsRichInput = {
  sourceId: "mercari_jp" as const,
  sourceItemId: "m12345678901",
  identityScope: "listing" as const,
  canonicalUrl: "https://jp.mercari.com/item/m12345678901",
  title: "限定版フィギュア",
  descriptionExcerpt: "前髪に小傷あり。箱なし。",
  imageUrl: "https://static.mercdn.net/item/detail/orig/photos/m12345678901_1.jpg?1774673297",
  currency: "JPY",
  currentPrice: 4_800,
  originalPrice: 6_000,
  priceBasis: "listing_price" as const,
  condition: "used" as const,
  availability: "available" as const,
  sourceListedAt: "2026-03-28T04:48:17.000Z",
  sourceUpdatedAt: "2026-04-14T10:38:15.000Z",
  sourceConditionLabel: "やや傷や汚れあり",
  facts: {
    manufacturer: "グッドスマイルカンパニー",
    categoryPath: ["ホビー", "フィギュア"],
    imageUrls: ["https://static.mercdn.net/item/detail/orig/photos/m12345678901_2.jpg?1774673297"],
    specifications: [{ name: "スケール", value: "1/7 スケール" }],
    variants: [{ name: "カラー", value: "ホワイト", availability: "available" as const, priceJpy: 3_200 }],
    displayFacts: [
      { key: "source_condition", label: "来源品相", group: "catalog" as const, kind: "text" as const, value: "やや傷や汚れあり" },
      { key: "like_count", label: "收藏数", group: "commerce" as const, kind: "text" as const, value: "37" },
    ],
    sourceAvailabilityLabel: "on_sale",
    provenance: {
      displayFacts: { method: "internal_api" as const, sourceLabel: "Mercari JP experimental web API" },
    },
  },
};

function emptyEnrichment(overrides: Record<string, unknown> = {}) {
  return {
    translatedTitle: null,
    summary: null,
    conditionNotes: [],
    defects: [],
    missingParts: [],
    includedItems: [],
    editionOrModel: null,
    evidence: [],
    confidence: "low",
    ...overrides,
  };
}

describe("listing semantic fact extraction boundary", () => {
  it("treats listing text as data and forbids purchase decisions", () => {
    const messages = listingEnrichmentMessages([mercariInput]);
    expect(messages[0]?.content).toContain("不可信数据");
    expect(messages[0]?.content).toContain("禁止推荐");
    expect(messages[0]?.content).toContain("语义相关性");
    expect(messages[0]?.content).toContain("价格、库存、首次出现、涨跌和数量由程序计算");
    expect(messages[1]?.content).toContain("前髪に小傷あり");
  });

  it("disambiguates a watched entity instead of accepting a same-name string match", () => {
    const messages = listingEnrichmentMessages([mercariInput], "エミリア", {
      targetLabel: "爱蜜莉雅",
      targetDescription: "《Re:ゼロから始める異世界生活》的艾米莉亚角色商品",
      includeTerms: ["エミリア|Emilia|爱蜜莉雅"],
      excludeTerms: ["Emilia Clarke|エミリア・クラーク"],
    });

    expect(messages[0]?.content).toContain("命中查询词或别名本身不是 relevant 的充分条件");
    expect(messages[0]?.content).toContain("作者或普通人名、地名、品牌或型号");
    expect(messages[0]?.content).toContain("EMELIA 商品型号");
    expect(messages[1]?.content).toContain('"targetLabel":"爱蜜莉雅"');
    expect(messages[1]?.content).toContain('"targetDescription":"《Re:ゼロから始める異世界生活》的艾米莉亚角色商品"');
    expect(messages[1]?.content).toContain('"excludeTerms":["Emilia Clarke|エミリア・クラーク"]');
  });

  it("keeps the user's complete exact-product title authoritative over heuristic fields", () => {
    const messages = listingEnrichmentMessages([mercariInput], "魔法少女まどか☆マギカ ワルプルギスの廻天 クリアボトル", {
      targetLabel: "具体同款：魔法少女まどか☆マギカ ワルプルギスの廻天 クリアボトル",
      targetDescription: "品类：クリアボトル",
    });
    expect(messages[0]?.content).toContain("完整商品名是最高优先级的目标证据");
    expect(messages[0]?.content).toContain("只能辅助判断，不能覆盖、改写或缩窄完整商品名");
    expect(messages[0]?.content).toContain("只共享作品、角色或宽泛品类的其他周边");
  });

  it("uses Gemini 3.5 Flash Lite through the direct Google API", () => {
    const request = listingEnrichmentProviderRequest([mercariInput, surugayaInput]);
    expect(LISTING_ENRICHMENT_MODEL).toEqual({
      provider: "google-ai-studio",
      model: "gemini-3.5-flash-lite",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    });
    expect(request).toMatchObject({
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 65_536,
        responseMimeType: "application/json",
      },
    });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("@cf/");
    expect(serialized).not.toContain("deepseek");
    expect(serialized).not.toContain("grok");
    expect(serialized).not.toContain("api-key");
    expect(serialized).not.toContain("Authorization");
  });

  it("sends every semantic field of the normalized listing to the cleaning model", () => {
    const messages = listingEnrichmentMessages([mercariInput]);
    expect(messages[1]?.content).toContain("限定版フィギュア");
    expect(messages[1]?.content).toContain("m12345678901");
    expect(messages[1]?.content).toContain("jp.mercari.com");
    expect(messages[1]?.content).toContain("やや傷や汚れあり");
  });

  it("keeps the program-side and per-round fields out of the prompt", () => {
    const messages = listingEnrichmentMessages([factsRichInput]);
    const prompt = messages[1]?.content ?? "";

    // 图片与采集溯源：模型读不到图片，URL 上的时间戳只会把缓存键打飞。
    expect(prompt).not.toContain("static.mercdn.net");
    expect(prompt).not.toContain("internal_api");
    // 价格与库存由程序计算，提示词本来就禁止模型改写。
    expect(prompt).not.toContain("4800");
    expect(prompt).not.toContain("available");
    // 每轮都在变的展示事实与变体报价。
    expect(prompt).not.toContain("收藏数");
    expect(prompt).not.toContain("2026-04-14T10:38:15.000Z");
    expect(prompt).not.toContain("3200");

    // 身份证据一个都不能少。
    expect(prompt).toContain("限定版フィギュア");
    expect(prompt).toContain("グッドスマイルカンパニー");
    expect(prompt).toContain("来源品相");
    expect(prompt).toContain("1/7 スケール");
  });

  it("gives one listing the same cache key whatever its price and stock do", () => {
    const bumped = {
      ...factsRichInput,
      currentPrice: 4_200,
      availability: "sold_out" as const,
      sourceUpdatedAt: "2026-05-02T01:00:00.000Z",
      imageUrl: "https://static.mercdn.net/item/detail/orig/photos/m12345678901_1.jpg?1780000000",
      facts: {
        ...factsRichInput.facts,
        displayFacts: [
          ...factsRichInput.facts.displayFacts.filter((fact) => fact.key !== "like_count"),
          { key: "like_count", label: "收藏数", group: "commerce" as const, kind: "text" as const, value: "412" },
        ],
      },
    };

    expect(JSON.stringify(listingSemanticProjection(bumped)))
      .toBe(JSON.stringify(listingSemanticProjection(factsRichInput)));
    // 标题变了就必须重判。
    expect(JSON.stringify(listingSemanticProjection({ ...bumped, title: "通常版フィギュア" })))
      .not.toBe(JSON.stringify(listingSemanticProjection(factsRichInput)));
  });

  it("parses one native Gemini batch into ordered Chinese facts", () => {
    const response = {
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        items: [
          {
            index: 1,
            ...emptyEnrichment({
              translatedTitle: "《冰菓》Blu-ray BOX 初回限定版",
              summary: "初回限定版 Blu-ray BOX，附收纳盒和小册子。",
              includedItems: ["附收纳盒", "附小册子"],
              editionOrModel: "初回限定版",
              evidence: [
                { field: "title", quote: "初回限定版" },
                { field: "description", quote: "収納BOX・ブックレット付き" },
              ],
              confidence: "high",
            }),
          },
          {
            index: 0,
            ...emptyEnrichment({
              translatedTitle: "限定版手办",
              summary: "限定版手办，刘海有小划痕且无外盒。",
              defects: ["刘海有小划痕"],
              missingParts: ["无外盒"],
              editionOrModel: "限定版",
              evidence: [
                { field: "title", quote: "限定版フィギュア" },
                { field: "description", quote: "前髪に小傷あり" },
                { field: "description", quote: "箱なし" },
              ],
              confidence: "high",
            }),
          },
        ],
      }) }] } }],
    };
    const enrichments = parseListingEnrichmentBatch(response, [mercariInput, surugayaInput]);
    expect(enrichments.map((item) => item.translatedTitle)).toEqual([
      "限定版手办",
      "《冰菓》Blu-ray BOX 初回限定版",
    ]);
    expect(enrichments[0]?.missingParts).toEqual(["无外盒"]);
    expect(enrichments[1]?.includedItems).toEqual(["附收纳盒", "附小册子"]);
  });

  it("accepts a strict evidence-backed single response", () => {
    const enrichment = parseListingEnrichment({ response: JSON.stringify(emptyEnrichment({
      translatedTitle: "限定版手办",
      summary: "刘海有小划痕，且不含外盒。",
      defects: ["刘海有小划痕"],
      missingParts: ["不含外盒"],
      editionOrModel: "限定版",
      evidence: [
        { field: "title", quote: "限定版フィギュア" },
        { field: "description", quote: "前髪に小傷あり" },
        { field: "description", quote: "箱なし" },
      ],
      confidence: "high",
    })) }, mercariInput);
    expect(enrichment.translatedTitle).toBe("限定版手办");
    expect(enrichment.missingParts).toEqual(["不含外盒"]);
  });

  it("keeps usable known fields when the model adds an extra field", () => {
    expect(parseListingEnrichment(emptyEnrichment({ recommendation: "buy", summary: "限定版手办。" }), mercariInput).summary)
      .toBe("限定版手办。");
  });

  it("does not discard model output because an evidence quote is imperfect", () => {
    expect(parseListingEnrichment(emptyEnrichment({
      summary: "商品有明显破损。",
      defects: ["明显破损"],
      evidence: [{ field: "description", quote: "完全破損" }],
      confidence: "high",
    }), mercariInput).defects).toEqual(["明显破损"]);
  });

  it("accepts extracted fields without requiring evidence quotes", () => {
    expect(parseListingEnrichment(emptyEnrichment({
      translatedTitle: "限定版手办",
      summary: "限定版。",
      editionOrModel: "限定版",
    }), mercariInput).translatedTitle).toBe("限定版手办");
  });

  it("rejects a strict batch only when an input index is actually missing", () => {
    const duplicate = {
      items: [
        { index: 0, ...emptyEnrichment() },
        { index: 0, ...emptyEnrichment() },
      ],
    };
    expect(() => parseListingEnrichmentBatch(duplicate, [mercariInput, surugayaInput]))
      .toThrow("AI response is missing index 1");
  });

  it("keeps both items when evidence text is imperfect", () => {
    const response = {
      items: [
        {
          index: 0,
          ...emptyEnrichment({
            translatedTitle: "限定版手办",
            summary: "限定版手办。",
            evidence: [{ field: "title", quote: "不存在的标题片段" }],
            confidence: "high",
          }),
        },
        {
          index: 1,
          ...emptyEnrichment({
            translatedTitle: "《冰菓》Blu-ray BOX 初回限定版",
            summary: "初回限定版 Blu-ray BOX。",
            evidence: [{ field: "title", quote: "初回限定版" }],
            confidence: "high",
          }),
        },
      ],
    };

    const result = parseListingEnrichmentBatchPartial(response, [mercariInput, surugayaInput]);
    expect(result.rejectedIndexes).toEqual([]);
    expect(result.items[0]?.translatedTitle).toBe("限定版手办");
    expect(result.items[1]?.translatedTitle).toBe("《冰菓》Blu-ray BOX 初回限定版");
  });

  it("keeps an item and defaults one malformed field instead of rejecting the whole item", () => {
    const response = {
      items: [
        {
          index: 0,
          translatedTitle: "限定版手办",
          summary: "限定版手办。",
          conditionNotes: [],
          defects: "无",
          missingParts: [],
          includedItems: [],
          editionOrModel: null,
          evidence: [{ field: "title", quote: "限定" }],
          confidence: "high",
        },
        {
          index: 1,
          ...emptyEnrichment({
            translatedTitle: "《冰菓》Blu-ray BOX 初回限定版",
            summary: "初回限定版 Blu-ray BOX。",
            evidence: [{ field: "title", quote: "初回限定版" }],
            confidence: "high",
          }),
        },
      ],
    };

    const result = parseListingEnrichmentBatchPartial(response, [mercariInput, surugayaInput]);
    expect(result.rejectedIndexes).toEqual([]);
    expect(result.items[0]?.defects).toEqual([]);
    expect(result.items[1]?.summary).toBe("初回限定版 Blu-ray BOX。");
  });
});
