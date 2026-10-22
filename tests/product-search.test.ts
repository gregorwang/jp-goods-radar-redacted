import { describe, expect, it } from "vitest";
import {
  assessProductMatch,
  buildProductSearchPlan,
  compareProductSearchCandidates,
  fingerprintFromJapaneseProductName,
  productFingerprintSupportsExactMatch,
  PRODUCT_SEARCH_AI_REVIEW_LIMIT,
  PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT,
  searchCandidateEvidence,
  selectProductSearchAiReviewCandidates,
  type CandidateHit,
  type NormalizedListing,
  type ProductFingerprint,
} from "@jpgr/core";

const target: ProductFingerprint = {
  workTitle: "Re:ゼロから始める異世界生活",
  characters: ["ラインハルト", "ラインハルト・ヴァン・アストレア"],
  productType: "ぬいぐるみ",
  manufacturer: "GSクラフト",
  model: "N0065",
  jan: "4589955576984",
  size: "18cm",
  aliases: ["剣聖 ラインハルト ぬいぐるみ"],
  excludedTerms: ["GiGO", "ちびぐるみ", "ちょぴぬいぷち", "プライズ"],
};

function listing(id: string, title: string, descriptionExcerpt?: string): NormalizedListing {
  return {
    sourceId: "yahoo_fleamarket_jp",
    sourceItemId: id,
    identityScope: "listing",
    canonicalUrl: `https://paypayfleamarket.yahoo.co.jp/item/${id}`,
    title,
    ...(descriptionExcerpt ? { descriptionExcerpt } : {}),
    currency: "JPY",
    currentPrice: 7_200,
    priceBasis: "listing_price",
    condition: "used",
    availability: "sold_out",
    rawMetadata: {},
  };
}

function hit(overrides: Partial<CandidateHit> = {}): CandidateHit {
  return {
    variantId: "manufacturer-3",
    query: "ラインハルト ぬいぐるみ GSクラフト",
    kind: "manufacturer",
    lane: "source_native",
    upstreamRank: 1,
    weight: 0.9,
    liveVerified: true,
    ...overrides,
  };
}

describe("P3 product search", () => {
  it("keeps apparel size, color, and product type out of the character field", () => {
    expect(fingerprintFromJapaneseProductName("高木さん からかいパーカー グレー Lサイズ"))
      .toMatchObject({
        productType: "パーカー",
        size: "Lサイズ",
        color: "グレー",
        characters: [],
      });
    expect(fingerprintFromJapaneseProductName("初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver."))
      .toMatchObject({
        productType: "ミニ色紙",
        characters: [],
      });
  });

  it("builds a bounded, explainable query plan instead of deep-paging one broad query", () => {
    const plan = buildProductSearchPlan({
      query: "ラインハルト ぬいぐるみ",
      mode: "exact_product",
      target,
    });

    const native = plan.variants.filter((variant) => variant.lane === "source_native");
    expect(native.length).toBeLessThanOrEqual(5);
    // 名额先给可靠的商品标识符。旧写法边生成边占坑，原始标题和几条召回别名
    // 先把五个名额吃完，JAN 和型号根本排不进去——而商品代码是确认同款的
    // 路径 A 的唯一依据，它发不出去，那条路径就是摆设。
    expect(native[0]?.purpose).toBe("identifier");
    expect(native[0]?.query).toContain("4589955576984");
    expect(native.some((variant) => variant.query.includes("N0065"))).toBe(true);
    // 原始完整标题仍然是一条合法查询，只是不再固定第一。
    expect(native.some((variant) => variant.query === "ラインハルト ぬいぐるみ")).toBe(true);
    expect(plan.variants.every((variant) => variant.lane === "source_native")).toBe(true);
  });

  // 计划 §6.2：普通路径不得自动退化到「作品 + 角色」。那不是一条精确查询，
  // 是整站浏览——搜一个具体商品却拿回八百条候选，就是这么来的。
  it("never emits a work-plus-character query that drops the product type", () => {
    const plan = buildProductSearchPlan({
      query: "冴えない彼女の育てかた Fine 加藤恵 A3プリモアート",
      mode: "exact_product",
    });
    const native = plan.variants.filter((variant) => variant.lane === "source_native");
    expect(native.length).toBeGreaterThan(0);
    for (const variant of native) {
      if (variant.purpose === "identifier") continue;
      if (variant.query === plan.originalQuery) continue;
      const keepsProductType = plan.target?.productType
        ? variant.query.includes(plan.target.productType)
        : true;
      const keepsVerifiedEdition = (plan.target?.edition ?? []).some((value) => variant.query.includes(value));
      expect(keepsProductType || keepsVerifiedEdition).toBe(true);
    }
  });

  it("keeps keyword search as one upstream-relevance request", () => {
    const plan = buildProductSearchPlan({ query: "ラインハルト ぬいぐるみ", mode: "keyword" });
    expect(plan.variants).toEqual([{
      id: "original-1",
      query: "ラインハルト ぬいぐるみ",
      kind: "original",
      weight: 1,
      lane: "source_native",
      purpose: "precise",
      anchors: [],
    }]);
  });

  it("preserves source-significant Japanese spacing and punctuation in keyword mode", () => {
    const query = "ぬいぐるみ　エミリア 「Re：ゼロ」 F：NEX限定";
    const plan = buildProductSearchPlan({ query, mode: "keyword" });
    expect(plan.originalQuery).toBe(query);
    expect(plan.variants[0]?.query).toBe(query);
  });

  it("turns one concrete Japanese product name into a bounded reusable intent", () => {
    const name = "Re:ゼロから始める異世界生活 ふわかわロリータぬいぐるみ レム";
    const plan = buildProductSearchPlan({ query: name, mode: "exact_product" });

    expect(plan.intentKind).toBe("named_product");
    expect(plan.target).toMatchObject({
      canonicalName: name,
      workTitle: "Re:ゼロから始める異世界生活",
      characters: ["レム"],
      productType: "ぬいぐるみ",
    });
    expect(plan.target?.model).toBeUndefined();
    expect(plan.target?.jan).toBeUndefined();
    expect(plan.variants.map((variant) => variant.query)).toEqual([
      name,
      "レム ぬいぐるみ",
      "Re:ゼロから始める異世界生活 ぬいぐるみ",
    ]);

    const reused = buildProductSearchPlan({
      query: name,
      mode: "exact_product",
      target: plan.target,
      intentKind: plan.intentKind === "named_product" ? plan.intentKind : undefined,
    });
    expect(reused.intentKind).toBe("named_product");
    expect(reused.variants).toEqual(plan.variants);
  });

  it("does not turn a short character plus product type into a generic category search", () => {
    const plan = buildProductSearchPlan({ query: "ユリウス ぬいぐるみ", mode: "exact_product" });

    expect(plan.target).toMatchObject({
      characters: ["ユリウス"],
      productType: "ぬいぐるみ",
    });
    expect(plan.target?.workTitle).toBeUndefined();
    expect(plan.variants.map((variant) => variant.query)).toEqual(["ユリウス ぬいぐるみ"]);
  });

  it("builds short Kato Megumi art recall and lets the detail text prove the edition", () => {
    const name = "限定★描き下ろし 加藤恵 A4キャラファイングラフ バースデーデートVer. [冴えない彼女の育てかた Fine]";
    const plan = buildProductSearchPlan({
      query: name,
      mode: "exact_product",
    });

    expect(plan.target).toMatchObject({
      workTitle: "冴えない彼女の育てかた Fine",
      characters: ["加藤恵"],
      productType: "キャラファイングラフ",
      size: "A4",
      edition: ["バースデーデートVer."],
    });
    expect(plan.variants.some((variant) => variant.query === "加藤恵 キャラファイングラフ")).toBe(true);

    const sold = listing(
      "m64354531343",
      "冴えない彼女の育てかた 加藤恵 キャラファイングラフ",
      "冴えない彼女の育てかた Fine 描き下ろし 加藤恵 A4キャラファイングラフ バースデーデートVer. サイズ約44×35cm 未開封",
    );
    expect(assessProductMatch(sold, plan.target!, []).relation).toBe("probable_exact");
  });

  it("keeps a named art-book search literal and repairs legacy generic aliases", () => {
    const name = "メダリスト展 アートブック";
    const plan = buildProductSearchPlan({
      query: name,
      mode: "exact_product",
      intentKind: "named_product",
      target: {
        canonicalName: name,
        workTitle: "メダリスト展",
        characters: ["アートブック"],
        aliases: ["アートブック"],
        excludedTerms: [],
      },
    });

    expect(plan.target).toMatchObject({
      canonicalName: name,
      workTitle: "メダリスト展",
      characters: [],
      productType: "アートブック",
      aliases: [],
    });
    expect(plan.variants.map((variant) => variant.query)).toEqual([name]);

    const sourceHit = hit({ variantId: "original-1", query: name, kind: "original", weight: 1 });
    expect(assessProductMatch(listing("art-generic", "COMME des GARÇONS アートブック"), plan.target!, [sourceHit]).relation)
      .toBe("irrelevant");
    expect(assessProductMatch(listing("art-target", "メダリスト展 公式アートブック"), plan.target!, [sourceHit]).relation)
      .toBe("probable_exact");

    const legacyTarget: ProductFingerprint = {
      canonicalName: name,
      workTitle: "メダリスト展",
      characters: ["アートブック"],
      aliases: ["アートブック"],
      excludedTerms: [],
    };
    expect(assessProductMatch(listing("legacy-generic", "GEORGIA O'KEEFFE アートブック"), legacyTarget, [sourceHit]).relation)
      .toBe("irrelevant");
    expect(assessProductMatch(listing("legacy-target", "メダリスト展 公式アートブック"), legacyTarget, [sourceHit]).relation)
      .not.toBe("irrelevant");
  });

  it("parses product-type-first names without treating a sales qualifier as the character", () => {
    const name = "ぬいぐるみ エミリア 「Re：ゼロ」 F：NEX限定";
    const plan = buildProductSearchPlan({ query: name, mode: "exact_product" });

    expect(plan.target).toMatchObject({
      canonicalName: "ぬいぐるみ エミリア 「Re:ゼロ」 F:NEX限定",
      workTitle: "Re:ゼロ",
      characters: ["エミリア"],
      productType: "ぬいぐるみ",
    });
    expect(plan.target?.aliases).not.toContain("「Re:ゼロ」 F:NEX限定");
  });

  it("keeps same-name books out of the high-confidence product lane", () => {
    const name = "Re:ゼロから始める異世界生活 ふわかわロリータぬいぐるみ エミリア";
    const plan = buildProductSearchPlan({ query: name, mode: "exact_product" });
    const sourceHit = hit({ variantId: "original-1", query: name, kind: "original", weight: 1 });
    const matching = listing("z-product", "ふわかわロリータぬいぐるみ エミリア F:NEX");
    const unrelatedBook = listing("z-book", "Diverticulosis and You A Lifestyle Guide Chef Emilia Santos 電子書籍");

    expect(assessProductMatch(matching, plan.target!, [sourceHit]).relation).toBe("probable_exact");
    expect(["related", "uncertain", "irrelevant"]).toContain(
      assessProductMatch(unrelatedBook, plan.target!, [sourceHit]).relation,
    );
  });

  it("treats a bare character name as weak evidence instead of an exact product", () => {
    const name = "エミリア";
    const plan = buildProductSearchPlan({ query: name, mode: "exact_product" });
    const sourceHit = hit({ variantId: "original-1", query: name, kind: "original", weight: 1 });
    const unrelatedBook = listing("z-short-name", "Chef Emilia Santos エミリア 電子書籍");

    expect(plan.warnings).toHaveLength(1);
    expect(assessProductMatch(unrelatedBook, plan.target!, [sourceHit]).relation).not.toBe("probable_exact");
  });

  it("regresses the Yahoo Reinhard case: GS Craft ranks ahead of GiGO variants", () => {
    const exact = listing(
      "z589863828",
      "Re:ゼロから始める異世界生活 ラインハルト ぬいぐるみ リゼロ",
      "GSクラフト ラインハルト・ヴァン・アストレア ぬいぐるみ 未開封 全長18cm N0065 JAN 4589955576984",
    );
    const gigo = listing("z600000001", "GiGO限定 ちょぴぬいぷち ラインハルト ぬいぐるみ");
    const exactHits = [
      hit({ variantId: "original-1", query: "ラインハルト ぬいぐるみ", kind: "original", upstreamRank: 30, weight: 0.55 }),
      hit(),
    ];
    const exactEvidence = searchCandidateEvidence(exactHits, assessProductMatch(exact, target, exactHits));
    const variantHits = [hit({ variantId: "original-1", query: "ラインハルト ぬいぐるみ", kind: "original", upstreamRank: 1, weight: 0.55 })];
    const variantEvidence = searchCandidateEvidence(variantHits, assessProductMatch(gigo, target, variantHits));

    expect(exactEvidence.match?.relation).toBe("exact");
    expect(variantEvidence.match?.relation).toBe("variant");
    expect(compareProductSearchCandidates(exactEvidence, variantEvidence)).toBeLessThan(0);
  });

  it("separates bundles from exact single-item matches", () => {
    const bundle = listing("z600000002", "ラインハルト ユリウス ぬいぐるみ 2点セット", "GSクラフト 18cm");
    const assessment = assessProductMatch(bundle, { ...target, jan: undefined, model: undefined }, [hit()]);
    expect(assessment.relation).toBe("bundle");
  });

  it("rejects source fallback recommendations that only match the generic product type", () => {
    const plan = buildProductSearchPlan({ query: "ユリウス ぬいぐるみ", mode: "exact_product" });
    const sourceHit = hit({ variantId: "original-1", query: plan.originalQuery, kind: "original", weight: 1 });
    const unrelated = listing("z-generic-plush", "大人向け 音声認識 ぬいぐるみ しばいぬ");
    const related = listing("z-julius", "Re:ゼロ GiGO限定 ちょぴぬいぷち ユリウス ぬいぐるみ");

    expect(assessProductMatch(unrelated, plan.target!, [sourceHit])).toMatchObject({
      version: "product-match-v6",
      relation: "irrelevant",
    });
    expect(assessProductMatch(related, plan.target!, [sourceHit]).relation).toBe("related");
    expect(productFingerprintSupportsExactMatch(plan.target)).toBe(false);
  });

  it("recalls Kato Megumi seller abbreviations but still enforces identity and conflict groups", () => {
    const name = "冴えない彼女の育てかた Fine ふわぷち Mぬいぐるみ 加藤恵 私服Ver.";
    const inferred = buildProductSearchPlan({ query: name, mode: "exact_product" });
    const recallQueries = [
      "加藤恵 ふわぷち 私服",
      "加藤恵 ふわぷち M",
      "冴えカノ 加藤恵 ふわぷち",
      "加藤恵 Fuwapuchi",
    ];
    const plan = buildProductSearchPlan({
      query: name,
      mode: "exact_product",
      intentKind: "named_product",
      target: {
        ...inferred.target!,
        recallQueries,
        requiredTermGroups: ["加藤恵|加藤 恵|加藤惠", "ふわぷち|フワプチ|Fuwapuchi|fuwapuchi"],
        supportingTermGroups: [
          "私服|私服Ver|私服ver|私服Ver.",
          "M|Mぬいぐるみ|ぬいぐるみ",
          "冴えない彼女の育てかた|冴えない彼女|冴えカノ|Fine",
        ],
        excludedTerms: ["制服", "パジャマ", "セーター", "Luminasta|ルミナスタ", "フィギュア"],
      },
    });

    expect(plan.variants.filter((variant) => variant.lane === "source_native").map((variant) => variant.query))
      .toEqual([name, ...recallQueries]);

    const sellerTitles = [
      "加藤恵 ふわぷち 私服Ver",
      "加藤恵 ふわぷち 私服ver",
      "加藤恵 ふわぷち M",
      "加藤恵 ふわぷち ぬいぐるみ",
      "冴えない彼女 加藤恵 ふわぷち",
      "冴えカノ 加藤恵 ふわぷち",
      "加藤 恵 ふわぷち 私服",
    ];
    const recallHit = hit({
      variantId: "alias-2",
      query: recallQueries[0],
      kind: "alias",
      weight: 0.86,
    });
    for (const [index, title] of sellerTitles.entries()) {
      expect(assessProductMatch(listing(`kato-${index}`, title), plan.target!, [recallHit]).relation)
        .toBe("probable_exact");
    }
    expect(assessProductMatch(
      listing("kato-uniform", "加藤恵 ふわぷち 制服Ver"),
      plan.target!,
      [recallHit],
    ).relation).toBe("variant");
    expect(assessProductMatch(
      listing("wrong-character", "霞ヶ丘詩羽 ふわぷち 私服Ver"),
      plan.target!,
      [recallHit],
    ).relation).toBe("irrelevant");
  });

  it("sends only a bounded ambiguous shortlist to AI", () => {
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      key: `source:${index}`,
      evidence: searchCandidateEvidence([hit({ upstreamRank: index + 1 })], {
        version: "product-match-v6",
        relation: index === 0 ? "exact" : index === 1 ? "variant" : "probable_exact",
        score: index === 0 ? 100 : index === 1 ? 70 : 70 - Math.min(index, 40),
        confidence: index < 2 ? "high" : "medium",
        matchedFields: [],
        // 名额的排除依据是**可核查的冲突**，不再是 relation 的字面值。
        conflicts: index === 1 ? ["型号：N0065 ≠ N0066"] : [],
        reasons: [],
      }),
    }));

    const selected = selectProductSearchAiReviewCandidates(candidates);
    expect(selected).toHaveLength(PRODUCT_SEARCH_AI_REVIEW_LIMIT);
    expect(selected.map((candidate) => candidate.key)).not.toContain("source:0");
    expect(selected.map((candidate) => candidate.key)).not.toContain("source:1");
    expect(selectProductSearchAiReviewCandidates(candidates, PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT))
      .toHaveLength(PRODUCT_SEARCH_WATCH_AI_REVIEW_LIMIT);
  });

  // 复核名额的分配依据从“relation 白名单”改成了“程序是否已经判完”。
  // 改这一条是因为白名单排掉的候选不是“不需要复核”，而是“永远拿不到复核”，
  // 然后下游又把没复核当成了结论。bundle 来自标题上的「セット」正则，
  // 一件商品的包装清单和三件商品的套装在标题层根本分不开。
  it("reviews everything the deterministic matcher could not settle", () => {
    const candidate = (
      key: string,
      relation: "related" | "uncertain" | "irrelevant" | "variant" | "bundle" | "exact",
      options: { conflicts?: string[]; matched?: string[] } = {},
    ) => ({
      key,
      evidence: searchCandidateEvidence([hit()], {
        version: "product-match-v6",
        relation,
        score: relation === "related" ? 40 : relation === "uncertain" ? 10 : 80,
        confidence: "medium" as const,
        matchedFields: [],
        conflicts: options.conflicts ?? [],
        reasons: [],
        difference: { matched: options.matched ?? [], missing: [], conflicting: [] },
      }),
    });
    const selected = selectProductSearchAiReviewCandidates([
      candidate("related", "related"),
      candidate("uncertain", "uncertain"),
      // 与目标零重叠：程序可证明的无关，不占名额。
      candidate("fallback", "irrelevant"),
      // 标题缩写导致缺了身份组，但角色确实命中：这是“卖家没写全”，不是无关。
      candidate("abbreviated", "irrelevant", { matched: ["角色"] }),
      // 有可核查的冲突：程序已经判完。
      candidate("variant", "variant", { conflicts: ["尺寸：A3 ≠ A4"] }),
      candidate("bundle", "bundle"),
      candidate("exact", "exact"),
    ]);
    expect(new Set(selected.map((item) => item.key)))
      .toEqual(new Set(["related", "uncertain", "abbreviated", "bundle"]));
  });
});
