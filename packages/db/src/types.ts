import type {
  Coverage,
  MonitorDeliveryMode,
  MonitorEventType,
  MonitorScopeType,
  MonitorStaleSourcePolicy,
  MonitoringPurpose,
  OfferTrackingPolicy,
  SourceId,
  WatchDossierKind,
  WatchListingTrackingStatus,
} from "@jpgr/core";

export interface WatchBindingRow {
  id: string;
  watch_profile_id: string;
  source_id: SourceId;
  kind: "keyword" | "item";
  query: string | null;
  search_url: string | null;
  target_url: string | null;
  source_config_json: string;
  source_item_id: string | null;
  interval_minutes: number;
  schedule_interval_minutes: number;
  monitoring_purpose: MonitoringPurpose;
  next_run_at: string;
  baseline_completed: 0 | 1;
  notify_initial: 0 | 1;
  notify_new_listing: 0 | 1;
  notify_price_drop: 0 | 1;
  /** 涨价提醒。一次性挂牌涨价常是"这件要走了"的前兆，商家目录商品则多是普通波动。 */
  notify_price_rise: 0 | 1;
  notify_restock: 0 | 1;
  notify_sold_out: 0 | 1;
  target_price: number | null;
  min_drop_amount: number;
  enabled: 0 | 1;
  consecutive_failures: number;
  cooldown_until: string | null;
  /** 该绑定的上新窗口已覆盖到的最新上架时间；来源不提供上架时间时始终为 null。 */
  new_listing_watermark: string | null;
  /** 首次深度锚定完成的时间；为 null 表示还没有可信的深度基线。 */
  new_listing_anchored_at: string | null;
  /** 已经尝试过几轮深度锚定；截断的锚定轮不落锁而是重来，这里给重试一个上界。 */
  new_listing_anchor_attempts: number;
  profile_name?: string;
  profile_description?: string | null;
  profile_default_max_price?: number | null;
  profile_include_terms_json?: string;
  profile_exclude_terms_json?: string;
  profile_dossier_kind?: WatchDossierKind;
  profile_offer_tracking_policy?: OfferTrackingPolicy;
  /** 关键词档案的最低价（送达门槛），null = 不限。 */
  profile_min_listing_price?: number | string | null;
}

export interface ExistingListingRow {
  id: string;
  current_price: number | null;
  availability: string;
  description_excerpt: string | null;
  state_hash: string | null;
  content_hash: string | null;
}

/**
 * 库里已有的详情证据。精确同款巡检跳过重复详情补抓时用它补厚本轮的搜索结果，
 * 见 RadarRepository.storedListingDetails。
 */
export interface StoredListingDetail {
  detailHydratedAt: string | null;
  descriptionExcerpt: string | null;
  facts: Record<string, unknown>;
}

export interface TrackedListingRow {
  watch_binding_id: string;
  listing_id: string;
  tracking_status: WatchListingTrackingStatus;
  tracking_interval_minutes: number;
  tracking_next_run_at: string | null;
  tracking_last_run_at: string | null;
  tracking_last_success_at: string | null;
  tracking_baseline_completed: 0 | 1;
  tracking_consecutive_failures: number;
  tracking_cooldown_until: string | null;
  tracking_last_error_code: string | null;
  tracking_last_error_message: string | null;
  tracking_missing_observations: number;
  tracking_last_price: number | null;
  tracking_last_availability: string | null;
  tracking_last_state_hash: string | null;
  tracking_started_at: string | null;
  tracking_ended_at: string | null;
  tracking_terminal_reason: string | null;
  source_id: SourceId;
  source_item_id: string;
  canonical_url: string;
  title: string;
  currency: string;
  current_price: number | null;
  original_price: number | null;
  price_basis: string;
  item_condition: string;
  availability: string;
  state_hash: string | null;
  content_hash: string | null;
  product_facts_json: string;
}

export interface MonitorRuleRow {
  id: string;
  rule_key: string;
  version: number;
  watch_profile_id: string;
  scope_type: MonitorScopeType;
  scope_id: string;
  scope_identity_status: "bound" | "pending";
  event_types_json: string;
  source_allow_json: string;
  source_deny_json: string;
  conditions_json: string;
  completeness_json: string;
  target_listing_price: number | null;
  target_landed_cost: number | null;
  delivery_mode: MonitorDeliveryMode;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: "Asia/Tokyo";
  dedupe_window_minutes: number;
  cooldown_minutes: number;
  stale_source_policy: MonitorStaleSourcePolicy;
  enabled: 0 | 1;
  supersedes_rule_id: string | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  created_by: "migration" | "user" | "system";
}

export interface CostProfileRow {
  id: string;
  profile_key: string;
  version: number;
  name: string;
  exchange_rate_cny_per_100_jpy_milli: number;
  exchange_rate_buffer_bps: number;
  proxy_fixed_fee_jpy: number;
  proxy_percent_bps: number;
  domestic_shipping_min_jpy: number;
  domestic_shipping_max_jpy: number;
  international_route_label: string;
  first_weight_grams: number;
  first_weight_min_jpy: number;
  first_weight_max_jpy: number;
  continued_weight_grams: number;
  continued_weight_min_jpy: number;
  continued_weight_max_jpy: number;
  unknown_weight_min_grams: number;
  unknown_weight_max_grams: number;
  consolidation_share_bps: number;
  tax_enabled: 0 | 1;
  tax_bps: number;
  cost_buffer_bps: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  created_by: "user" | "system" | "migration";
}

export interface MonitorRuleLandedCostTargetRow {
  monitor_rule_id: string;
  cost_profile_id: string;
  target_landed_cost_jpy: number;
  threshold_policy: "estimate_upper_bound_at_or_below";
  created_at: string;
}

export interface MonitorEventInsertDecision {
  eventType: MonitorEventType;
  eventKey: string;
  evidenceHash: string;
  notificationEligibility: "instant" | "digest" | "quiet_hours" | "cooldown" | "record_only";
  suppressionReason: string | null;
  deliveryNotBefore: string | null;
}

export interface DashboardSummary {
  activeWatches: number;
  activeSources: number;
  todaySearches: number;
  todayNewListings: number;
  todayPriceDrops: number;
  todayEmails: number;
  failingSources: number;
  emailProtectionTriggered: boolean;
}

export interface ConfirmationListingRow extends ExistingListingRow {
  source_id: import("@jpgr/core").SourceId;
  source_item_id: string;
}

export interface WatchRunResult {
  status: "success" | "failed" | "skipped" | "rate_limited" | "blocked";
  coverage: Coverage;
  resultCount: number;
  newCount: number;
  changedCount: number;
  httpStatus?: number;
  parserVersion?: string;
  errorCode?: string;
  errorMessage?: string;
  fieldTotal?: number;
  fieldComplete?: number;
  captchaDetected?: boolean;
  cpuLimitDetected?: boolean;
  loginRequired?: boolean;
  healthEvidence?: {
    rawResultCount?: number;
    pageDepth?: number;
    cursorTerminationReason?: "exhausted" | "budget_reached" | "not_applicable" | "unknown";
    abnormalEmpty?: boolean;
    blockedDetected?: boolean;
  };
}

export interface ProbeWindowRow {
  source_id: import("@jpgr/core").SourceId;
  status: "pending" | "running" | "passed" | "failed";
  started_at: string | null;
  planned_end_at: string | null;
  finished_at: string | null;
  total_runs: number;
  successful_runs: number;
  field_total: number;
  field_complete: number;
  captcha_runs: number;
  cpu_limit_runs: number;
  login_required_runs: number;
  decision_reason: string | null;
  updated_at: string;
  request_route: "direct" | "mercari_service";
}

export interface ManagedApiUsage {
  provider: string;
  monthUtc: string;
  runtimeBudget: number;
  runtimeCalls: number;
  emergencyReserve: number;
}

export interface ManagedApiBillingUsage {
  provider: string;
  periodStartedAt: string;
  periodEndsAt: string;
  runtimeBudget: number;
  runtimeCalls: number;
  emergencyReserve: number;
  dailyDayJst: string | null;
  dailyBudget: number;
  dailyRuntimeCalls: number;
}

export interface VerificationCheckRow {
  scope: "p0" | "final";
  check_key: string;
  label: string;
  status: "pending" | "passed" | "failed" | "blocked";
  evidence_json: string;
  verified_at: string | null;
}

export interface P0QualificationRunRow {
  id: string;
  status: "running" | "passed" | "failed" | "blocked";
  triggered_by: "admin" | "system";
  started_at: string;
  finished_at: string | null;
  results_json: string;
  error_message: string | null;
  updated_at: string;
}

export interface PendingEmailRow {
  event_id: string;
  event_key: string;
  event_type: import("@jpgr/core").EventType;
  event_created_at: string;
  payload_json: string;
  source_id: import("@jpgr/core").SourceId | null;
  source_item_id: string | null;
  identity_scope: import("@jpgr/core").IdentityScope | null;
  canonical_url: string | null;
  title: string | null;
  description_excerpt: string | null;
  image_url: string | null;
  seller_name: string | null;
  shop_name: string | null;
  currency: string | null;
  current_price: number | null;
  original_price: number | null;
  price_basis: "listing_price" | "catalog_price" | "offer_price" | "auction_current_bid" | null;
  item_condition: import("@jpgr/core").ItemCondition | null;
  availability: import("@jpgr/core").Availability | null;
  binding_enabled: number;
  profile_enabled: number;
  /**
   * 这封邮件是别的渠道没送到才补发的：写在邮件开头的那句原因（notice_deliveries.fallback_reason）。
   * 只有邮件队列（pendingEmails）带这一列。
   */
  fallback_reason?: string | null;
}

/** 精确同款周报的载荷：所有启用中的精确同款档案合并成一封，每周一发。
 * 只放数字和商品清单，句子由邮件模板按固定规则拼出来，不经过 AI。 */
export interface WeeklyExactReportItem {
  sourceId: SourceId;
  title: string;
  url: string;
  price: number | null;
  /** 降价时是上周此时的价格。 */
  oldPrice?: number;
  available: boolean;
  /** 进行中拍卖：价格是当前出价，不是能直接成交的价格。 */
  auction: boolean;
}

export interface WeeklyExactReportProfile {
  profileId: string;
  profileName: string;
  /** 只有规则里开着"低于目标标价"时才有值。 */
  targetPrice: number | null;
  /** 本周自动检查成功的次数；0 说明这个档案这周没在工作。 */
  checks: number;
  newOfferCount: number;
  dropCount: number;
  targetHitCount: number;
  newOffers: WeeklyExactReportItem[];
  drops: WeeklyExactReportItem[];
  targetHits: WeeklyExactReportItem[];
  /** 当前在售、可成交标价的确认同款里的最低价。 */
  lowestNow: number | null;
  /** 一周前那一刻同一口径的最低价。 */
  lowestWeekAgo: number | null;
}

export interface WeeklyExactReport {
  kind: "weekly_exact_report";
  windowStartedAt: string;
  windowEndedAt: string;
  profiles: WeeklyExactReportProfile[];
  /** 运维信息：本周每日体检的结论，放在周报最底部，与买家内容分开。 */
  health?: WeeklyHealthSummary;
}

export type HealthSeverity = "warning" | "critical";

/** 每日体检发现的一个问题（同一问题每天再次发现只刷新 lastSeenAt）。 */
export interface HealthFinding {
  checkKey: string;
  subjectKey: string;
  severity: HealthSeverity;
  sourceId: SourceId | null;
  title: string;
  detail: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 为 null 说明到最近一次体检为止仍然存在。 */
  resolvedAt: string | null;
}

export interface WeeklyHealthSummary {
  /** 本周体检实际跑完的天数，满分 days。 */
  completedRuns: number;
  days: number;
  findings: HealthFinding[];
}

export interface HermesDeliveryClaim {
  id: string;
  attempts: number;
  requestId: string;
}

/** 通知的发送渠道：radar_core.notice_deliveries.channel。加渠道先改那张表的 CHECK。 */
export type NoticeChannel = "email" | "feishu" | "hermes";

/** 认领到的一行投递：attempts 是算上这一次的第几次。 */
export interface NoticeClaim {
  id: string;
  attempts: number;
}

export interface NoticeAwaitingOutcomeRow {
  delivery_id: string;
  event_id: string;
  remote_id: string;
}
