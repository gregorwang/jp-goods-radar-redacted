"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { BookmarkPlus, Check, ChevronDown, Crosshair, ExternalLink, Languages, ScanText } from "lucide-react";
import { useId, useState } from "react";
import type { ItemCondition, NormalizedListing, SearchCandidateEvidence, SourceId } from "@jpgr/core";
import { canCreateItemPriceWatch, formatJpy } from "@jpgr/core";
import type { ListingEnrichment, ListingEnrichmentRequest } from "@jpgr/validation";
import {
  listingCategory,
  listingDisplayFactRows,
  type ListingDisplayFactRow,
} from "@/lib/listing-display-facts";

export interface ListingAiState {
  status: "idle" | "queued" | "loading" | "waiting_rate_limit" | "ready" | "unavailable";
  enrichment?: ListingEnrichment;
  scope?: "listing";
}

export interface ComparisonPosition {
  position: number;
  total: number;
  method: "identifier" | "exact_title";
}

export type ListingWatchState = "idle" | "saving" | "saved" | "paused";

const matchRelationNames: Record<NonNullable<SearchCandidateEvidence["match"]>["relation"], string> = {
  exact: "完全同款",
  probable_exact: "高概率同款",
  variant: "其他版本",
  bundle: "套装 / 组合",
  related: "相关商品",
  irrelevant: "不相关",
  uncertain: "等待复核",
};

const sourceNames: Record<SourceId, string> = {
  amiami: "AmiAmi（あみあみ）",
  rakuten_ichiba: "乐天市场",
  rakuten_books: "Rakuten Books",
  yahoo_shopping: "Yahoo! Shopping（实验）",
  yahoo_auctions_jp: "Yahoo!オークション（实验）",
  yahoo_fleamarket_jp: "Yahoo!フリマ",
  amazon_jp: "Amazon Japan",
  ebay: "eBay",
  mercari_jp: "Mercari",
  surugaya: "骏河屋",
  charaon: "CharaON",
  cospa: "COSPA",
  animate: "Animate 通贩",
};

export type ListingAvailabilityState = NormalizedListing["availability"] | "trading";

const availabilityNames: Record<ListingAvailabilityState, string> = {
  available: "在售",
  sold_out: "已售出",
  trading: "交易中",
  unavailable: "当前不可购买",
  preorder: "预售",
  backorder: "等待补货",
  unknown: "库存未确认",
};

export function listingAvailabilityState(item: NormalizedListing): ListingAvailabilityState {
  const sourceStatus = item.rawMetadata?.sourceStatus;
  if (item.sourceId === "mercari_jp"
    && typeof sourceStatus === "string"
    && /^(?:item_status_)?trading$/iu.test(sourceStatus.trim())) {
    return "trading";
  }
  return item.availability;
}

const conditionNames: Record<ItemCondition, string> = {
  new: "新品",
  used: "中古",
  collectible: "收藏品",
  refurbished: "翻新",
  unknown: "品相未确认",
};

const conditionTranslations: Readonly<Record<string, string>> = {
  "新品": "新品",
  "新品、未使用": "全新未使用",
  "新品・未使用": "全新未使用",
  "未使用に近い": "接近未使用",
  "目立った傷や汚れなし": "无明显划痕或污渍",
  "やや傷や汚れあり": "有轻微划痕或污渍",
  "傷や汚れあり": "有划痕或污渍",
  "全体的に状態が悪い": "整体状态较差",
  "中古": "中古",
  "中古品": "中古",
  "予約": "预售",
  "予約商品": "预售商品",
};

export function listingKey(item: Pick<NormalizedListing, "sourceId" | "sourceItemId">): string {
  return `${item.sourceId}:${item.sourceItemId}`;
}

function metadataText(item: NormalizedListing, key: string): string | undefined {
  const value = item.rawMetadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceConditionOriginal(item: NormalizedListing): string | undefined {
  return item.facts?.sourceConditionLabel ?? metadataText(item, "sourceConditionLabel");
}

function sourceCondition(item: NormalizedListing): string {
  const original = sourceConditionOriginal(item);
  return original ? conditionTranslations[original.normalize("NFKC")] ?? conditionNames[item.condition] : conditionNames[item.condition];
}

export function enrichmentRequest(item: NormalizedListing): ListingEnrichmentRequest {
  return {
    ...item,
    sourceConditionLabel: sourceConditionOriginal(item),
    category: listingCategory(item),
  };
}

export function shouldEnrich(item: NormalizedListing): boolean {
  return Boolean(item.sourceId && item.sourceItemId && item.title);
}

function ListingImage({ item }: { item: NormalizedListing }) {
  const [failed, setFailed] = useState(false);
  if (!item.imageUrl || failed) return <div className="result-product-image product-placeholder" aria-label="商品图片暂缺" />;
  return (
    <Image
      className="result-product-image"
      src={item.imageUrl}
      alt={item.title}
      width={360}
      height={360}
      sizes="(max-width: 520px) 92px, (max-width: 900px) 124px, 172px"
      onError={() => setFailed(true)}
    />
  );
}

function EnrichmentFacts({ ai, item }: { ai?: ListingAiState; item: NormalizedListing }) {
  if (!ai || ai.status === "idle") return <p className="semantic-status">等待 Gemini 整理这件商品的重点。</p>;
  if (ai.status === "queued") return <p className="semantic-status">已写入后台任务，正在等待 Gemini 整理。</p>;
  if (ai.status === "loading") return <p className="semantic-status">Gemini 正在翻译标题，并整理品相、缺件与版本信息…</p>;
  if (ai.status === "waiting_rate_limit") return <p className="semantic-status">Gemini 配额暂满，后台会按服务端等待时间自动继续。</p>;
  if (ai.status === "unavailable") {
    return (
      <div className="semantic-fallback">
        <p className="semantic-status" data-tone="bad">本件商品的 AI 整理没有完成，来源事实仍然完整保留。</p>
        {item.descriptionExcerpt && <p className="result-source-excerpt" lang="ja">{item.descriptionExcerpt}</p>}
      </div>
    );
  }
  const enrichment = ai.enrichment;
  if (!enrichment) return null;
  const sections = [
    ["分类", [enrichment.normalizedCategory, enrichment.productType].filter((value): value is string => Boolean(value))],
    ["作品 / 系列", [enrichment.workTitle, enrichment.series].filter((value): value is string => Boolean(value))],
    ["角色", enrichment.characters],
    ["品相", enrichment.conditionNotes],
    ["瑕疵", enrichment.defects],
    ["缺件", enrichment.missingParts],
    ["包含物", enrichment.includedItems],
  ] as const;
  return (
    <div className="semantic-result">
      {enrichment.summary && <p className="semantic-summary">{enrichment.summary}</p>}
      <p><strong>关键词相关性</strong><span>{enrichment.relevance === "relevant" ? "相关" : enrichment.relevance === "irrelevant" ? "无关（已从默认结果隐藏）" : "可能相关"}{enrichment.relevanceReason ? ` · ${enrichment.relevanceReason}` : ""}</span></p>
      {enrichment.officialStatus !== "unknown" && <p><strong>商品性质</strong><span>{enrichment.officialStatus === "official" ? "官方商品" : "同人 / 非官方商品"}</span></p>}
      {enrichment.editionOrModel && <p><strong>版本 / 型号</strong><span>{enrichment.editionOrModel}</span></p>}
      {sections.filter(([, values]) => values.length > 0).map(([label, values]) => (
        <p key={label}><strong>{label}</strong><span>{values.join(" · ")}</span></p>
      ))}
      <details>
        <summary>更多 AI 清洗信息 · 置信度 {enrichment.confidence === "high" ? "高" : enrichment.confidence === "medium" ? "中" : "低"}</summary>
        {Object.keys(enrichment.extraInfo).length > 0 && <ul>{Object.entries(enrichment.extraInfo).map(([key, value]) => <li key={key}>{key}：{value}</li>)}</ul>}
        {enrichment.evidence.length > 0 && <ul>{enrichment.evidence.map((evidence, index) => <li key={`${evidence.field}-${index}`}>{evidence.quote}</li>)}</ul>}
      </details>
    </div>
  );
}

const PRIMARY_FACT_LIMIT = 8;

function ProductFactRows({ rows }: { rows: readonly ListingDisplayFactRow[] }) {
  return (
    <dl className="result-facts">
      {rows.map((row) => (
        <div key={row.key} data-group={row.group}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ListingResultCard({
  item,
  ai,
  comparison,
  watchState,
  watchProfileId,
  watchDisabledReason,
  showAi = true,
  searchEvidence,
  onFindSimilar,
  onWatch,
}: {
  item: NormalizedListing;
  ai?: ListingAiState;
  comparison?: ComparisonPosition;
  watchState: ListingWatchState;
  watchProfileId?: string;
  watchDisabledReason?: string;
  showAi?: boolean;
  searchEvidence?: SearchCandidateEvidence;
  onFindSimilar?: () => void;
  onWatch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const aiEligible = showAi && shouldEnrich(item);
  const enrichment = showAi ? ai?.enrichment : undefined;
  const translatedTitle = enrichment?.translatedTitle;
  const currentPrice = typeof item.currentPrice === "number" && Number.isFinite(item.currentPrice) && item.currentPrice > 0 ? item.currentPrice : undefined;
  const priceKnown = currentPrice !== undefined;
  const availabilityState = listingAvailabilityState(item);
  const factRows = listingDisplayFactRows(item);
  const primaryFactRows = factRows.slice(0, PRIMARY_FACT_LIMIT);
  const additionalFactRows = factRows.slice(PRIMARY_FACT_LIMIT);
  const watchUnavailable = watchState === "idle" && Boolean(watchDisabledReason);
  const terminalSoldListing = !canCreateItemPriceWatch(availabilityState, item.identityScope, item.sourceId);
  const showWatchButton = watchState !== "idle" || !terminalSoldListing;
  const watchActionLabel = availabilityState === "sold_out" || availabilityState === "unavailable" || availabilityState === "backorder"
    ? "监控补货"
    : availabilityState === "unknown"
      ? "监控价格与库存"
      : "监控此商品价格";

  return (
    <article className="result-product-card" data-availability={availabilityState} data-match={searchEvidence?.match?.relation} data-expanded={expanded}>
      <div className="result-product-media">
        <ListingImage item={item} />
        {comparison && <span className="comparison-rank">同款价序 {comparison.position}/{comparison.total}</span>}
      </div>

      <div className="result-product-main">
        <div className="result-product-kicker">
          <span>{sourceNames[item.sourceId]}</span>
          <span data-tone={availabilityState === "available" || availabilityState === "preorder" ? "good" : availabilityState === "sold_out" ? "bad" : "warn"}>{availabilityNames[availabilityState]}</span>
          <span>{sourceCondition(item)}</span>
          {ai?.status === "ready" && <span data-tone="ai"><Languages size={11} aria-hidden="true" />AI 已整理</span>}
          {searchEvidence?.match && <span data-tone={searchEvidence.match.relation === "exact" || searchEvidence.match.relation === "probable_exact" ? "good" : searchEvidence.match.relation === "variant" || searchEvidence.match.relation === "bundle" ? "warn" : undefined}>{matchRelationNames[searchEvidence.match.relation]} · {searchEvidence.match.score}</span>}
          {searchEvidence?.historical && <span data-tone="warn">历史索引{searchEvidence.liveVerified ? " · 已复核" : " · 未实时复核"}</span>}
        </div>
        <div className="result-product-head">
          <div className="result-title-stack">
            <h3>{translatedTitle ?? item.title}</h3>
            {translatedTitle && translatedTitle !== item.title && (
              <details className="result-original-title">
                <summary>查看日文原标题</summary>
                <p lang="ja">{item.title}</p>
              </details>
            )}
          </div>
          <div className="result-price-block">
            <span>{availabilityState === "sold_out" ? "来源已售状态 / 最后公开标价" : availabilityState === "trading" ? "来源交易中 / 当前公开标价" : "来源标价 · 未计运费"}</span>
            <strong data-missing={!priceKnown}>{priceKnown ? formatJpy(currentPrice) : "价格待确认"}</strong>
            {!priceKnown && <small>来源没有返回可核实金额</small>}
            {item.originalPrice !== undefined && <del>{formatJpy(item.originalPrice)}</del>}
          </div>
        </div>

        <div className="result-card-controls">
          <button
            className="result-card-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown size={15} aria-hidden="true" />
            {expanded ? "收起商品详情" : "展开商品详情"}
          </button>
          <div className="result-actions">
            {showWatchButton ? (
              <button className="watch-item-button" type="button" data-state={watchState} disabled={watchState !== "idle" || watchUnavailable} title={watchUnavailable ? watchDisabledReason : undefined} onClick={onWatch}>
                {watchState === "saved" || watchState === "paused" ? <Check size={15} aria-hidden="true" /> : <BookmarkPlus size={15} aria-hidden="true" />}
                {watchState === "saving" ? "正在建立…" : watchState === "saved" ? "正在监控" : watchState === "paused" ? "监控已暂停" : watchUnavailable ? "暂不支持单品监控" : watchActionLabel}
              </button>
            ) : (
              <span className="terminal-listing-note">已售或交易中的单品不建立价格监控</span>
            )}
            {onFindSimilar && <button className="find-similar-button" type="button" onClick={onFindSimilar}><Crosshair size={15} aria-hidden="true" />以此扩展同款检索</button>}
            {watchProfileId && <Link className="text-link" href={`/watches/${watchProfileId}` as Route}>查看关注档案</Link>}
            <a className="text-link" href={item.canonicalUrl} target="_blank" rel="noreferrer">打开来源页<ExternalLink size={13} aria-hidden="true" /></a>
          </div>
        </div>

        {expanded && <section id={detailId} className="result-ai-brief" data-status={aiEligible ? ai?.status ?? "idle" : "source"} aria-label="商品重点">
          <header>
            <div className="result-ai-brief-heading">
              <strong>{aiEligible ? <Languages size={15} aria-hidden="true" /> : <ScanText size={15} aria-hidden="true" />}{aiEligible ? "AI 商品重点" : "来源商品重点"}</strong>
              <span>{aiEligible ? "只整理来源证据，不做购买判断" : "直接采用来源结构化事实"}</span>
            </div>
          </header>
          <div className="result-ai-brief-body">
            {searchEvidence?.match && (
              <div className="product-match-evidence" aria-label="同款匹配证据">
                <p><strong>{matchRelationNames[searchEvidence.match.relation]}</strong><span>确定性评分 {searchEvidence.match.score}/100 · {searchEvidence.match.confidence === "high" ? "高" : searchEvidence.match.confidence === "medium" ? "中" : "低"}置信度</span></p>
                {searchEvidence.match.reasons.length > 0 && <p>{searchEvidence.match.reasons.join(" · ")}</p>}
                {searchEvidence.match.conflicts.length > 0 && <p data-tone="warn">冲突：{searchEvidence.match.conflicts.join(" · ")}</p>}
                <details><summary>查看召回证据 · {searchEvidence.hits.length} 条查询命中</summary><ul>{searchEvidence.hits.map((hit, index) => <li key={`${hit.variantId}-${hit.lane}-${index}`}>{hit.lane === "source_native" ? "来源内" : hit.lane === "web_search" ? "网页补漏" : "历史索引"}第 {hit.upstreamRank} 位 · {hit.query}</li>)}</ul></details>
              </div>
            )}
            {aiEligible
              ? <EnrichmentFacts ai={ai} item={item} />
              : <p className="semantic-summary">{item.descriptionExcerpt ?? "来源已提供可核实的商品身份、价格与发售信息。"}</p>}

            {primaryFactRows.length > 0 && <ProductFactRows rows={primaryFactRows} />}
            {additionalFactRows.length > 0 && (
              <details className="result-more-facts">
                <summary>更多商品信息 · {additionalFactRows.length} 项</summary>
                <ProductFactRows rows={additionalFactRows} />
              </details>
            )}
            {item.descriptionExcerpt && aiEligible && (
              <details className="result-source-description">
                <summary>查看来源商品信息原文</summary>
                <p lang="ja">{item.descriptionExcerpt}</p>
              </details>
            )}
          </div>
        </section>}
        {expanded && comparison && <p className="comparison-method">{comparison.method === "identifier" ? "ISBN / JAN 等强标识匹配" : "标题严格一致匹配"}</p>}
      </div>
    </article>
  );
}
