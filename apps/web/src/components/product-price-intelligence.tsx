import { Radar } from "lucide-react";
import type { ItemCondition, ProductPriceIntelligence } from "@jpgr/core";
import { formatJpy } from "@jpgr/core";

const conditionNames: Record<ItemCondition, string> = {
  new: "新品",
  used: "中古",
  collectible: "收藏品",
  refurbished: "翻新",
  unknown: "品相未确认",
};

const confidenceNames: Record<ProductPriceIntelligence["sampleConfidence"], string> = {
  insufficient: "样本不足",
  low: "低置信度",
  medium: "中等置信度",
  high: "较高置信度",
};

const dateCoverageNames: Record<ProductPriceIntelligence["appearanceDateCoverage"], string> = {
  none: "无来源日期",
  partial: "部分日期可用",
  complete: "来源日期完整",
};

const priceBasisNames: Record<NonNullable<ProductPriceIntelligence["comparisonPriceBasis"]>, string> = {
  listing_price: "商品公开标价",
  catalog_price: "目录标价",
  offer_price: "卖家报价",
  auction_current_bid: "拍卖当前出价",
};

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value}%`;
}

function recommendationCopy(intelligence: ProductPriceIntelligence): { title: string; body: string } {
  switch (intelligence.recommendation) {
    case "no_current_offer":
      return {
        title: "暂无可买同款，等待新上架",
        body: "这组确认同款没有当前可购买报价。与其监控已经售出的单品，不如持续寻找新出现的同款。",
      };
    case "current_price_missing":
      return {
        title: "有在售记录，但价格仍待确认",
        body: "来源没有返回可核实的当前价格。先打开来源核对商品与金额，再决定是否建立精确同款监控。",
      };
    case "insufficient_history":
      return {
        title: "历史价格样本不足",
        body: "当前有可购买报价，但还没有至少两件同品相的来源已售状态公开标价。先核对缺件和运费，并继续积累证据。",
      };
    case "mixed_comparability":
      return {
        title: "当前样本不可直接合并比较",
        body: "当前报价与历史公开标价的品相或价格口径不一致，直接计算溢价容易误导。请先核对新品、中古、缺件与标价类型。",
      };
    case "wait_for_better_price":
      return {
        title: "当前报价明显偏高，非急需可继续等",
        body: `当前最低可购买价比同品相公开标价参考中位值高 ${intelligence.premiumToReferenceMedianPercent ?? 0}%。等待下一次同款上架更合理。`,
      };
    case "slightly_above_history":
      return {
        title: "当前报价高于历史样本中枢",
        body: `当前最低可购买价比同品相公开标价参考中位值高 ${intelligence.premiumToReferenceMedianPercent ?? 0}%。若不急需，可以继续观察。`,
      };
    case "below_history":
      return {
        title: "当前报价低于历史样本",
        body: "价格具有吸引力，但仍应先核对品相、缺件、卖家和未计入的运费。",
      };
    case "near_history":
      return {
        title: "当前报价接近历史样本中枢",
        body: "价格没有明显偏离同品相公开标价样本，是否购买主要取决于完整度和总到手成本。",
      };
  }
}

export function ProductPriceIntelligencePanel({
  intelligence,
}: {
  intelligence: ProductPriceIntelligence;
}) {
  const recommendation = recommendationCopy(intelligence);
  const referenceRange = intelligence.referencePriceLow === undefined
    ? "暂无可用价格"
    : intelligence.referencePriceHigh === undefined || intelligence.referencePriceLow === intelligence.referencePriceHigh
      ? `唯一可比价格 ${formatJpy(intelligence.referencePriceLow)}`
      : `${formatJpy(intelligence.referencePriceLow)}–${formatJpy(intelligence.referencePriceHigh)}`;
  const conditions = intelligence.conditions.map((condition) => conditionNames[condition]).join("、");
  const comparisonCondition = intelligence.comparisonCondition === undefined
    ? "尚未形成单一品相口径"
    : `比较口径：${conditionNames[intelligence.comparisonCondition]}`;
  const comparisonPriceBasis = intelligence.comparisonPriceBasis === undefined
    ? "价格口径未统一"
    : priceBasisNames[intelligence.comparisonPriceBasis];
  const metricAsOf = new Date(intelligence.asOf).toLocaleString("zh-CN", {
    timeZone: intelligence.window.timeZone,
    hour12: false,
  });

  return (
    <section className="product-price-intelligence" aria-labelledby="product-price-intelligence-title">
      <header>
        <div>
          <p className="eyebrow">PRICE INTELLIGENCE</p>
          <h4 id="product-price-intelligence-title">确认同款价格与库存结论</h4>
        </div>
        <span>确定性统计 · 基于 {intelligence.confirmedListingCount} 件确认同款</span>
      </header>

      <div className="price-intelligence-layout">
        <dl className="price-intelligence-metrics">
          <div>
            <dt>来源已售状态公开标价</dt>
            <dd>{intelligence.sourceSoldStatusPriceSampleCount} 件</dd>
            <small>{intelligence.sourceSoldStatusCount} 件来源已售状态 · 非成交证明</small>
          </div>
          <div>
            <dt>同品相参考中位值</dt>
            <dd>{intelligence.referencePriceMedian === undefined ? "暂不计算" : formatJpy(intelligence.referencePriceMedian)}</dd>
            <small>{intelligence.comparablePriceSampleCount} 件可比 · {referenceRange}</small>
          </div>
          <div>
            <dt>当前最低有效标价</dt>
            <dd>{intelligence.currentLowestPrice === undefined ? "暂无有效报价" : formatJpy(intelligence.currentLowestPrice)}</dd>
            <small>{intelligence.confirmedActiveOfferCount} 件在售 / 预订 / 缺货订购 · {intelligence.currentPricedOfferCount} 件有价格</small>
          </div>
          <div>
            <dt>相对参考中位值</dt>
            <dd>{intelligence.premiumToReferenceMedianPercent === undefined ? "不适用" : signedPercent(intelligence.premiumToReferenceMedianPercent)}</dd>
            <small>{comparisonCondition} · {comparisonPriceBasis} · 未含运费</small>
          </div>
          <div>
            <dt>730 天内可确认出现</dt>
            <dd>{intelligence.sourceDatedListingCount === 0 ? "日期不足" : `${intelligence.sourceListedWithinWindowCount} 件`}</dd>
            <small>来源日期覆盖 {intelligence.sourceDateCoveragePercent}% · {dateCoverageNames[intelligence.appearanceDateCoverage]}</small>
          </div>
          <div>
            <dt>价格参考质量</dt>
            <dd>{confidenceNames[intelligence.sampleConfidence]}</dd>
            <small>{intelligence.verifiedSaleCount} 条已验证成交记录 · 不输出单一稀缺度</small>
          </div>
        </dl>

        <aside className="price-intelligence-verdict" data-signal={intelligence.recommendation}>
          <span><Radar size={15} aria-hidden="true" />当前建议</span>
          <h5>{recommendation.title}</h5>
          <p>{recommendation.body}</p>
          <small>本卡只解释价格与库存证据；长期巡回由关注档案管理。</small>
        </aside>
      </div>

      <footer>
        <p>统计只使用本次搜索确认的同款。参考价格取自来源把商品标为已售时最后可见的公开标价，不等于已验证成交价，也未包含运费与代购费用。</p>
        {(intelligence.mixedConditions || intelligence.sourceUndatedListingCount > 0 || intelligence.comparisonExcludedPriceSampleCount > 0) && (
          <p>{intelligence.mixedConditions ? `本组包含${conditions}。` : ""}{intelligence.comparisonExcludedPriceSampleCount > 0 ? `${intelligence.comparisonExcludedPriceSampleCount} 件不同品相或价格口径的公开标价未进入中位值。` : ""}{intelligence.sourceUndatedListingCount > 0 ? `${intelligence.sourceUndatedListingCount} 件缺来源上架日期，未进入 730 天次数。` : ""}</p>
        )}
        <p>口径 {intelligence.metricVersion} · {intelligence.window.days} 日窗口 · {intelligence.window.timeZone} · 截至 {metricAsOf}</p>
      </footer>
    </section>
  );
}
