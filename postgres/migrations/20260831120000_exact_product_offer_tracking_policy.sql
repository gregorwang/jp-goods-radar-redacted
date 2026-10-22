-- Separate exact-product discovery from confirmed-offer tracking, and allow
-- an existing item watch to be recorded as a non-notifying known-offer anchor.
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
      'exact-product offer tracking policy requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
END
$runner_contract$;

ALTER TABLE radar_core.watch_profiles
  ADD COLUMN offer_tracking_policy text NOT NULL DEFAULT 'search_window',
  ADD CONSTRAINT ck_watch_profiles_02 CHECK (
    offer_tracking_policy = ANY (ARRAY['search_window'::text,'all_confirmed_offers'::text])
  );

-- The previous exact-product migration already activated existing confirmed
-- matches. Recording the policy makes that runtime behavior explicit.
UPDATE radar_core.watch_profiles
SET offer_tracking_policy = 'all_confirmed_offers'
WHERE dossier_kind = 'exact_product';

ALTER TABLE radar_core.watch_listing_matches
  DROP CONSTRAINT ck_watch_listing_matches_01,
  ADD CONSTRAINT ck_watch_listing_matches_01 CHECK (
    acceptance_reason = ANY (ARRAY[
      'legacy'::text,'direct_item'::text,'keyword_relevant'::text,
      'deterministic_exact'::text,'semantic_exact'::text,'anchor_known'::text
    ])
  ),
  DROP CONSTRAINT ck_watch_listing_matches_02,
  ADD CONSTRAINT ck_watch_listing_matches_02 CHECK (
    tracking_status = ANY (ARRAY[
      'discovery_only'::text,'anchor_known'::text,'active'::text,
      'unavailable_pending'::text,'waiting_restock'::text,'terminal'::text,
      'dismissed'::text,'purchased'::text,'paused'::text
    ])
  );

-- If the same confirmed listing already has a dedicated item watch, that item
-- watch owns lifecycle tracking. The exact-product dossier keeps the listing
-- as identity evidence and suppresses duplicate child work.
WITH migration_clock AS (
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso
)
UPDATE radar_core.watch_listing_matches AS exact_match
SET
  acceptance_reason = 'anchor_known',
  tracking_status = 'anchor_known',
  tracking_next_run_at = NULL,
  tracking_cooldown_until = NULL,
  tracking_baseline_completed = 1,
  tracking_ended_at = migration_clock.now_iso,
  tracking_terminal_reason = 'known_offer_anchor'
FROM radar_core.watch_bindings AS exact_binding,
     radar_core.watch_profiles AS exact_profile,
     migration_clock
WHERE exact_binding.id = exact_match.watch_binding_id
  AND exact_profile.id = exact_binding.watch_profile_id
  AND exact_profile.dossier_kind = 'exact_product'
  AND EXISTS (
    SELECT 1
    FROM radar_core.watch_listing_matches AS item_match
    JOIN radar_core.watch_bindings AS item_binding
      ON item_binding.id = item_match.watch_binding_id
    JOIN radar_core.watch_profiles AS item_profile
      ON item_profile.id = item_binding.watch_profile_id
    WHERE item_match.listing_id = exact_match.listing_id
      AND item_binding.kind = 'item'
      AND item_profile.dossier_kind = 'item'
  );
