import { isOneOffListingSource, itemSchedulePolicy, type ItemScheduleMode, type MonitoringPurpose } from "@jpgr/core";
import type { OperationalDatabase } from "@jpgr/db";

export interface ExistingItemWatch {
  bindingId: string;
  profileId: string;
  enabled: boolean;
  purpose: "item_price";
  intervalMinutes: number;
  nextRunAt: string;
  completed: boolean;
}

export function resolveMonitoringPurpose(
  kind: "keyword" | "item",
  _requested?: MonitoringPurpose,
): MonitoringPurpose {
  if (kind === "item") return "item_price";
  return "keyword_new_listing";
}

export function legacyIntervalMinutes(intervalMinutes: number): number {
  return Math.max(60, intervalMinutes);
}

export function initialNextRunAt(requested?: string): string {
  return requested ?? new Date().toISOString();
}

export function itemScheduleSourceConfig(
  config: Record<string, unknown>,
  options: { itemScheduleMode?: ItemScheduleMode; itemScheduleMaxMinutes?: number; reset?: boolean } = {},
): Record<string, unknown> {
  const current = itemSchedulePolicy({ source_config_json: JSON.stringify(config) });
  return { ...config, itemSchedule: {
    mode: options.itemScheduleMode ?? current.mode,
    maxIntervalMinutes: options.itemScheduleMaxMinutes ?? current.maxIntervalMinutes,
    ...(!options.reset && current.state ? { state: current.state } : {}),
  } };
}

export function resetItemScheduleForProfile(db: OperationalDatabase, profileId: string, pausedOnly = false) {
  return db.prepare(
    `UPDATE watch_bindings b SET source_config_json=(b.source_config_json::jsonb #- '{itemSchedule,state}')::text
     WHERE b.watch_profile_id=? AND b.kind='item' AND b.monitoring_purpose='item_price'
       AND (?=0 OR b.enabled=0)
       AND b.source_id<>'yahoo_auctions_jp'
       AND EXISTS(SELECT 1 FROM watch_profiles p WHERE p.id=b.watch_profile_id AND p.dossier_kind='item')
       AND b.source_config_json::jsonb#>'{itemSchedule,state}' IS NOT NULL`,
  ).bind(profileId, pausedOnly ? 1 : 0);
}

/**
 * 售出通知的默认值只能按来源定，不能一刀切。
 * 一次性挂牌来源（Mercari / 雅虎拍卖 / 雅虎フリマ / eBay）售出即终局，不会补货：
 * "这件没了"是用户要的结论，默认发。商家目录商品会重新上架，售罄只是中间状态，
 * 真正有价值的是随后的补货通知，所以默认不为售罄打扰用户。
 */
function soldOutDefault(requested: boolean | undefined, sourceId?: string): 0 | 1 {
  if (requested !== undefined) return requested ? 1 : 0;
  return sourceId !== undefined && isOneOffListingSource(sourceId) ? 1 : 0;
}

/**
 * 涨价提醒的默认值同样只能按来源定。
 * 一次性挂牌（Mercari / 雅虎拍卖 / 雅虎フリマ / eBay）售出即终局，用户肯为某条链接
 * 单独建监控，本身就说明在等这一件；涨价往往是它要走的前兆，属于看一眼就得做决定的
 * 信号。商家目录商品会重新上架，涨跌只是普通波动，为它打扰用户只会消耗注意力。
 */
function priceRiseDefault(requested: boolean | undefined, sourceId?: string): 0 | 1 {
  if (requested !== undefined) return requested ? 1 : 0;
  return sourceId !== undefined && isOneOffListingSource(sourceId) ? 1 : 0;
}

export function notificationColumns(
  purpose: MonitoringPurpose,
  requested: {
    notifyNewListing?: boolean;
    notifyPriceDrop?: boolean;
    notifyPriceRise?: boolean;
    notifyRestock?: boolean;
    notifySoldOut?: boolean;
  } = {},
  options: { restockOnly?: boolean; exactProduct?: boolean; sourceId?: string } = {},
) {
  if (purpose === "keyword_new_listing") {
    // 精确同款档案里确认的每件报价都会被独立盯价；用户看过没买，就是在等它降价，
    // 所以降价提醒默认打开，而不是逼用户给每条链接再建一份单品监控。
    if (options.exactProduct) {
      return {
        notifyNewListing: requested.notifyNewListing === false ? 0 : 1,
        notifyPriceDrop: requested.notifyPriceDrop === false ? 0 : 1,
        // 关键词扫描看的是市场而不是某一件，涨价在这里只是行情噪音。
        notifyPriceRise: 0,
        notifyRestock: 0,
        notifySoldOut: soldOutDefault(requested.notifySoldOut, options.sourceId),
      } as const;
    }
    return {
      notifyNewListing: requested.notifyNewListing === false ? 0 : 1,
      notifyPriceDrop: 0,
      notifyPriceRise: 0,
      notifyRestock: 0,
      notifySoldOut: 0,
    } as const;
  }
  // 售罄的商家商品此刻没有可比在售价，降价与售罄通知都不成立，只留补货。
  if (options.restockOnly) {
    return { notifyNewListing: 0, notifyPriceDrop: 0, notifyPriceRise: 0, notifyRestock: 1, notifySoldOut: 0 } as const;
  }
  return {
    notifyNewListing: 0,
    notifyPriceDrop: requested.notifyPriceDrop === false ? 0 : 1,
    notifyPriceRise: priceRiseDefault(requested.notifyPriceRise, options.sourceId),
    notifyRestock: requested.notifyRestock === false ? 0 : 1,
    notifySoldOut: soldOutDefault(requested.notifySoldOut, options.sourceId),
  } as const;
}

export async function findExistingItemWatch(
  db: OperationalDatabase,
  sourceId: string,
  sourceItemId: string,
): Promise<ExistingItemWatch | null> {
  const row = await db.prepare(
    `SELECT b.id binding_id,b.watch_profile_id,b.enabled binding_enabled,p.enabled profile_enabled,
            b.monitoring_purpose,b.schedule_interval_minutes,b.next_run_at,
            EXISTS(
              SELECT 1 FROM events e WHERE e.watch_profile_id=p.id
                AND COALESCE(e.semantic_event_type,e.event_type)='watch_completed'
            ) profile_completed
     FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
     WHERE b.kind='item' AND b.source_id=? AND b.source_item_id=? LIMIT 1`,
  ).bind(sourceId, sourceItemId).first<{
    binding_id: string;
    watch_profile_id: string;
    binding_enabled: number;
    profile_enabled: number;
    monitoring_purpose: "item_price";
    schedule_interval_minutes: number;
    next_run_at: string;
    profile_completed: boolean | number;
  }>();
  return row ? {
    bindingId: row.binding_id,
    profileId: row.watch_profile_id,
    enabled: row.binding_enabled === 1 && row.profile_enabled === 1,
    purpose: row.monitoring_purpose,
    intervalMinutes: row.schedule_interval_minutes,
    nextRunAt: row.next_run_at,
    completed: Boolean(row.profile_completed),
  } : null;
}
