-- Keep exact-product discovery running while independently following every
-- confirmed source listing for price and availability transitions.
--
-- Do not add BEGIN/COMMIT: jpgr-apply-analytics-migrations provides one outer
-- transaction and records this file's checksum in that same transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION
      'exact-product listing tracking requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
END
$runner_contract$;

ALTER TABLE radar_core.watch_listing_matches
  ADD COLUMN tracking_status text NOT NULL DEFAULT 'discovery_only',
  ADD COLUMN tracking_interval_minutes bigint NOT NULL DEFAULT 180,
  ADD COLUMN tracking_next_run_at text,
  ADD COLUMN tracking_last_run_at text,
  ADD COLUMN tracking_last_success_at text,
  ADD COLUMN tracking_baseline_completed bigint NOT NULL DEFAULT 0,
  ADD COLUMN tracking_consecutive_failures bigint NOT NULL DEFAULT 0,
  ADD COLUMN tracking_cooldown_until text,
  ADD COLUMN tracking_last_error_code text,
  ADD COLUMN tracking_last_error_message text,
  ADD COLUMN tracking_missing_observations bigint NOT NULL DEFAULT 0,
  ADD COLUMN tracking_last_price bigint,
  ADD COLUMN tracking_last_availability text,
  ADD COLUMN tracking_last_state_hash text,
  ADD COLUMN tracking_started_at text,
  ADD COLUMN tracking_ended_at text,
  ADD COLUMN tracking_terminal_reason text,
  ADD CONSTRAINT ck_watch_listing_matches_02 CHECK (
    tracking_status = ANY (ARRAY[
      'discovery_only'::text,'active'::text,'unavailable_pending'::text,
      'waiting_restock'::text,'terminal'::text,'dismissed'::text,
      'purchased'::text,'paused'::text
    ])
  ),
  ADD CONSTRAINT ck_watch_listing_matches_03 CHECK (
    tracking_interval_minutes >= 30 AND tracking_interval_minutes <= 1440
  ),
  ADD CONSTRAINT ck_watch_listing_matches_04 CHECK (
    tracking_baseline_completed = ANY (ARRAY[0::bigint,1::bigint])
  ),
  ADD CONSTRAINT ck_watch_listing_matches_05 CHECK (
    tracking_consecutive_failures >= 0 AND tracking_missing_observations >= 0
  ),
  ADD CONSTRAINT ck_watch_listing_matches_06 CHECK (
    tracking_last_availability IS NULL OR tracking_last_availability = ANY (ARRAY[
      'available'::text,'sold_out'::text,'unavailable'::text,
      'preorder'::text,'backorder'::text,'unknown'::text
    ])
  );

CREATE INDEX idx_watch_listing_matches_tracking_due
  ON radar_core.watch_listing_matches(tracking_status,tracking_next_run_at)
  WHERE tracking_next_run_at IS NOT NULL;

-- Exact-product bindings now own both discovery notifications and lifecycle
-- notifications for the accepted listing children.
UPDATE radar_core.watch_bindings AS binding
SET
  notify_price_drop = 1,
  notify_restock = 1,
  notify_sold_out = 1,
  updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM radar_core.watch_profiles AS profile
WHERE profile.id = binding.watch_profile_id
  AND profile.dossier_kind = 'exact_product';

UPDATE radar_core.monitor_rules AS rule
SET event_types_json = (
  SELECT jsonb_agg(event_type ORDER BY event_type)::text
  FROM (
    SELECT jsonb_array_elements_text(rule.event_types_json::jsonb) AS event_type
    UNION SELECT 'listing.price_changed'
    UNION SELECT 'listing.availability_changed'
  ) AS configured
)
FROM radar_core.watch_profiles AS profile
WHERE profile.id = rule.watch_profile_id
  AND profile.dossier_kind = 'exact_product'
  AND rule.valid_to IS NULL;

-- Existing matches start from their current persisted state. This deliberately
-- creates no events, so the migration cannot replay an old price drop or sale.
WITH migration_clock AS (
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso
)
UPDATE radar_core.watch_listing_matches AS match
SET
  tracking_status = CASE
    WHEN binding.source_id IN ('yahoo_shopping','ebay') THEN 'paused'
    WHEN binding.source_id IN ('mercari_jp','yahoo_auctions_jp','yahoo_fleamarket_jp')
      AND listing.availability IN ('sold_out','unavailable') THEN 'terminal'
    WHEN listing.availability IN ('sold_out','unavailable') THEN 'waiting_restock'
    ELSE 'active'
  END,
  tracking_interval_minutes = CASE
    WHEN binding.source_id IN ('mercari_jp','yahoo_auctions_jp','yahoo_fleamarket_jp','ebay') THEN 60
    ELSE 180
  END,
  tracking_next_run_at = CASE
    WHEN binding.source_id IN ('yahoo_shopping','ebay') THEN NULL
    WHEN binding.source_id IN ('mercari_jp','yahoo_auctions_jp','yahoo_fleamarket_jp')
      AND listing.availability IN ('sold_out','unavailable') THEN NULL
    ELSE migration_clock.now_iso
  END,
  tracking_baseline_completed = 1,
  tracking_last_price = listing.current_price,
  tracking_last_availability = listing.availability,
  tracking_last_state_hash = listing.state_hash,
  tracking_started_at = migration_clock.now_iso,
  tracking_ended_at = CASE
    WHEN binding.source_id IN ('mercari_jp','yahoo_auctions_jp','yahoo_fleamarket_jp')
      AND listing.availability IN ('sold_out','unavailable') THEN migration_clock.now_iso
    ELSE NULL
  END,
  tracking_terminal_reason = CASE
    WHEN binding.source_id IN ('mercari_jp','yahoo_auctions_jp','yahoo_fleamarket_jp')
      AND listing.availability IN ('sold_out','unavailable') THEN 'already_terminal_when_migrated'
    ELSE NULL
  END,
  tracking_last_error_code = CASE
    WHEN binding.source_id IN ('yahoo_shopping','ebay') THEN 'item_lookup_unsupported'
    ELSE NULL
  END,
  tracking_last_error_message = CASE
    WHEN binding.source_id IN ('yahoo_shopping','ebay')
      THEN '该来源暂不支持独立商品详情跟踪；发现流程仍会继续运行'
    ELSE NULL
  END
FROM radar_core.watch_bindings AS binding,
     radar_core.watch_profiles AS profile,
     radar_core.listings AS listing,
     migration_clock
WHERE binding.id = match.watch_binding_id
  AND profile.id = binding.watch_profile_id
  AND listing.id = match.listing_id
  AND profile.dossier_kind = 'exact_product';
