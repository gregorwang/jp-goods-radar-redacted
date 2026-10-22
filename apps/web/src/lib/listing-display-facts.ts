import { formatJpy } from "@jpgr/core";
import type {
  Availability,
  NormalizedListing,
  ProductDisplayFact,
  ProductDisplayFactGroup,
  ProductVariant,
} from "@jpgr/core";

export interface ListingDisplayFactRow {
  key: string;
  label: string;
  value: string;
  group: ProductDisplayFactGroup;
}

const variantAvailabilityNames: Record<Availability, string> = {
  available: "在售",
  sold_out: "已售出",
  unavailable: "当前不可购买",
  preorder: "预售",
  backorder: "等待补货",
  unknown: "库存未确认",
};

function metadataText(item: NormalizedListing, key: string): string | undefined {
  const value = item.rawMetadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(item: NormalizedListing, key: string): number | undefined {
  const value = item.rawMetadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatSourceDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^(?:発売日|発行日)\s*[:：]\s*/u, "").trim();
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return normalized.slice(0, 40);
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: normalized.includes("T") ? "2-digit" : undefined,
    minute: normalized.includes("T") ? "2-digit" : undefined,
  });
}

export function listingCategory(item: NormalizedListing): string | undefined {
  return item.facts?.categoryPath?.join(" / ") ?? metadataText(item, "category");
}

function productDisplayFactValue(fact: ProductDisplayFact): string {
  switch (fact.kind) {
    case "text":
      return fact.value;
    case "list":
      return fact.values.join(" · ");
    default: {
      const exhaustive: never = fact;
      throw new Error(`Unsupported product display fact: ${String(exhaustive)}`);
    }
  }
}

function variantValue(variant: ProductVariant): string {
  const parts = [variant.value];
  if (variant.availability) parts.push(variantAvailabilityNames[variant.availability]);
  if (variant.priceJpy !== undefined) parts.push(formatJpy(variant.priceJpy));
  return parts.join(" · ");
}

/**
 * Projects canonical and adapter-approved facts into one source-independent UI
 * list. rawMetadata is deliberately not enumerated here.
 */
export function listingDisplayFactRows(item: NormalizedListing): ListingDisplayFactRow[] {
  const rows: ListingDisplayFactRow[] = [];
  const append = (
    key: string,
    label: string,
    value: string | undefined,
    group: ProductDisplayFactGroup,
  ): void => {
    const normalized = value?.trim();
    if (normalized) rows.push({ key, label, value: normalized, group });
  };

  append("seller", "店铺 / 卖家", item.shopName ?? item.sellerName, "seller");
  append("source_item_id", "来源商品 ID", item.sourceItemId, "identity");

  const identifiers = item.facts?.identifiers;
  const legacyIdentifiers = item.rawMetadata?.identifiers;
  const legacyIdentifier = (key: string): string | undefined => {
    if (legacyIdentifiers === null || typeof legacyIdentifiers !== "object" || Array.isArray(legacyIdentifiers)) return undefined;
    const value = Reflect.get(legacyIdentifiers, key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  append("jan", "JAN 代码", identifiers?.jan ?? legacyIdentifier("jan"), "identity");
  append("isbn", "ISBN 代码", identifiers?.isbn ?? legacyIdentifier("isbn"), "identity");
  append("asin", "ASIN", identifiers?.asin ?? legacyIdentifier("asin"), "identity");
  append("sku", "SKU", identifiers?.sku ?? legacyIdentifier("sku"), "identity");
  append("model_number", "型号", identifiers?.modelNumber ?? legacyIdentifier("modelNumber"), "identity");
  append("source_catalog_id", "来源目录 ID", identifiers?.sourceCatalogId ?? legacyIdentifier("sourceCatalogId"), "identity");

  append("brand", "品牌", item.facts?.brand, "catalog");
  append("manufacturer", "制造商", item.facts?.manufacturer, "catalog");
  append("distributor", "发行 / 经销", item.facts?.distributor, "catalog");
  append("work_title", "作品", item.facts?.workTitle, "catalog");
  append("series", "系列", item.facts?.series, "catalog");
  append("characters", "角色", item.facts?.characters?.join(" · "), "catalog");
  append("category", "商品分类", listingCategory(item), "catalog");
  append("tags", "标签", item.facts?.tags?.join(" · "), "catalog");
  append("release_date", "发售日", formatSourceDate(item.facts?.releaseDate), "catalog");
  append("preorder_deadline", "预约截止", formatSourceDate(item.facts?.preorderDeadline), "commerce");

  const listedAt = formatSourceDate(item.sourceListedAt ?? metadataText(item, "createdAt"));
  append("source_listed_at", "来源发布日期", listedAt, "commerce");
  append("source_updated_at", "来源更新时间", formatSourceDate(item.sourceUpdatedAt), "commerce");

  const marketplacePrice = metadataNumber(item, "marketplacePrice");
  append(
    "marketplace_price",
    "其他店铺起价",
    marketplacePrice === undefined ? undefined : formatJpy(marketplacePrice),
    "commerce",
  );

  item.facts?.displayFacts?.forEach((fact) => {
    append(`display:${fact.key}`, fact.label, productDisplayFactValue(fact), fact.group);
  });
  item.facts?.specifications?.forEach((specification, index) => {
    append(`specification:${index}:${specification.name}`, specification.name, specification.value, "catalog");
  });
  item.facts?.variants?.forEach((variant, index) => {
    append(`variant:${index}:${variant.name}`, variant.name, variantValue(variant), "catalog");
  });

  append("source_condition", "来源品相原文", item.facts?.sourceConditionLabel, "commerce");
  append("source_availability", "来源库存原文", item.facts?.sourceAvailabilityLabel, "commerce");
  return rows;
}
