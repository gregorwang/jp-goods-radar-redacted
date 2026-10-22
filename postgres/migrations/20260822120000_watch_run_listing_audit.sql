-- Restore exact-product watches to a scheduled cluster scan and retain every
-- normalized listing seen by each run as user-visible operational evidence.
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
      'watch run listing audit requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
END
$runner_contract$;

CREATE TABLE radar_core.watch_run_listing_observations (
  watch_run_id text NOT NULL REFERENCES radar_core.watch_runs(id) ON DELETE CASCADE,
  watch_binding_id text NOT NULL REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  source_item_id text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  image_url text,
  current_price bigint,
  original_price bigint,
  currency text NOT NULL,
  availability text NOT NULL,
  item_condition text NOT NULL,
  source_listed_at text,
  ordinal bigint NOT NULL,
  observed_at text NOT NULL,
  decision_status text NOT NULL DEFAULT 'pending',
  decision_reason text,
  match_relation text,
  is_purchasable bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (watch_run_id,source_id,source_item_id),
  CONSTRAINT ck_watch_run_listing_observations_01 CHECK (
    decision_status = ANY (ARRAY['pending'::text,'confirmed'::text,'rejected'::text,'uncertain'::text])
  ),
  CONSTRAINT ck_watch_run_listing_observations_02 CHECK (
    is_purchasable = ANY (ARRAY[0::bigint,1::bigint])
  ),
  CONSTRAINT ck_watch_run_listing_observations_03 CHECK (ordinal > 0)
);

CREATE INDEX idx_watch_run_listing_observations_binding_run
  ON radar_core.watch_run_listing_observations(watch_binding_id,watch_run_id,ordinal);

GRANT SELECT,INSERT,DELETE,UPDATE
  ON TABLE radar_core.watch_run_listing_observations TO radar_core_runtime;

-- Exact-product profiles scan the current purchasable cluster on their shared
-- schedule. Retire the later per-listing child scheduler without deleting the
-- retained source/listing evidence.
UPDATE radar_core.watch_listing_matches AS match
SET tracking_status='discovery_only',
    tracking_next_run_at=NULL,
    tracking_cooldown_until=NULL,
    tracking_ended_at=COALESCE(tracking_ended_at,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    tracking_terminal_reason='cluster_scan_only'
FROM radar_core.watch_bindings AS binding,
     radar_core.watch_profiles AS profile
WHERE binding.id=match.watch_binding_id
  AND profile.id=binding.watch_profile_id
  AND profile.dossier_kind='exact_product';

UPDATE radar_core.watch_bindings AS binding
SET notify_price_drop=0,
    notify_restock=0,
    notify_sold_out=0,
    updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM radar_core.watch_profiles AS profile
WHERE profile.id=binding.watch_profile_id
  AND profile.dossier_kind='exact_product';

UPDATE radar_core.monitor_rules AS rule
SET event_types_json=COALESCE((
  SELECT jsonb_agg(event_type ORDER BY event_type)::text
  FROM jsonb_array_elements_text(rule.event_types_json::jsonb) AS event_type
  WHERE event_type NOT IN ('listing.price_changed','listing.availability_changed')
),'[]')
FROM radar_core.watch_profiles AS profile
WHERE profile.id=rule.watch_profile_id
  AND profile.dossier_kind='exact_product'
  AND rule.valid_to IS NULL;

-- Sold-out and unavailable rows remain in listings/snapshots as source
-- evidence, but they are not members of a purchase watch's current cluster.
DELETE FROM radar_core.watch_listing_matches AS match
USING radar_core.watch_bindings AS binding,
      radar_core.watch_profiles AS profile,
      radar_core.listings AS listing
WHERE binding.id=match.watch_binding_id
  AND profile.id=binding.watch_profile_id
  AND listing.id=match.listing_id
  AND profile.dossier_kind='exact_product'
  AND listing.availability NOT IN ('available','preorder','backorder');
