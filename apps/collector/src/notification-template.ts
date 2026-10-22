import type { NormalizedListing } from "@jpgr/core";
import type { PendingEmailRow } from "@jpgr/db";
import {
  dailyDigestEmail,
  keywordDigestEmail,
  listingEmail,
  morningDigestEmail,
  weeklyExactReportEmail,
  sourceErrorEmail,
  watchCompletedEmail,
} from "@jpgr/email";

export interface RenderedNotification {
  subject: string;
  html: string;
  text: string;
}

export function renderEventNotification(row: PendingEmailRow): RenderedNotification {
  const detail: unknown = JSON.parse(row.payload_json);
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error(`事件 ${row.event_id} 的通知载荷无效`);
  }
  const record = detail as Record<string, unknown>;
  if (row.event_type === "source_error") return sourceErrorEmail(record);
  if (row.event_type === "watch_completed") return watchCompletedEmail(record);
  if (row.event_type === "morning_digest") return morningDigestEmail(record);
  if (row.event_type === "weekly_market_digest") return weeklyExactReportEmail(record);
  if (row.event_type === "daily_digest") {
    return record.kind === "keyword_new_listing"
      || record.kind === "exact_product_new_listing"
      || record.kind === "keyword_initial_baseline"
      || record.kind === "keyword_scan_summary"
      ? keywordDigestEmail(record, { eventId: row.event_id })
      : dailyDigestEmail(record);
  }
  if (
    !row.source_id
    || !row.source_item_id
    || !row.identity_scope
    || !row.canonical_url
    || !row.title
    || !row.price_basis
    || !row.item_condition
    || !row.availability
  ) {
    throw new Error(`事件 ${row.event_id} 缺少商品通知所需字段`);
  }
  const listing: NormalizedListing = {
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    identityScope: row.identity_scope,
    canonicalUrl: row.canonical_url,
    title: row.title,
    descriptionExcerpt: row.description_excerpt ?? undefined,
    imageUrl: row.image_url ?? undefined,
    sellerName: row.seller_name ?? undefined,
    shopName: row.shop_name ?? undefined,
    currency: row.currency ?? "JPY",
    currentPrice: row.current_price ?? undefined,
    originalPrice: row.original_price ?? undefined,
    priceBasis: row.price_basis,
    condition: row.item_condition,
    availability: row.availability,
  };
  return listingEmail(row.event_type, listing, record);
}
