-- Retire the standalone market-sampling dossier and erase data attributable
-- only to that feature. Shared listing catalog rows remain when another watch
-- or analytics fact still references them.
--
-- Do not add BEGIN/COMMIT: jpgr-apply-analytics-migrations provides one outer
-- transaction and records this file's checksum in that same transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION
      'market-sampling retirement requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
END
$runner_contract$;

CREATE TEMP TABLE retired_market_profiles ON COMMIT DROP AS
SELECT id
FROM radar_core.watch_profiles
WHERE dossier_kind = 'market';

CREATE TEMP TABLE retired_market_bindings ON COMMIT DROP AS
SELECT binding.id
FROM radar_core.watch_bindings AS binding
JOIN retired_market_profiles AS profile ON profile.id = binding.watch_profile_id;

CREATE TEMP TABLE retired_market_runs ON COMMIT DROP AS
SELECT run.id
FROM radar_core.watch_runs AS run
JOIN retired_market_bindings AS binding ON binding.id = run.watch_binding_id;

CREATE TEMP TABLE retired_market_core_listings ON COMMIT DROP AS
SELECT DISTINCT match.listing_id AS id
FROM radar_core.watch_listing_matches AS match
JOIN retired_market_bindings AS binding ON binding.id = match.watch_binding_id;

CREATE TEMP TABLE retired_market_analytics_runs ON COMMIT DROP AS
SELECT run.id
FROM radar_analytics.search_runs AS run
WHERE EXISTS (
    SELECT 1
    FROM retired_market_profiles AS profile
    WHERE run.subscription_key LIKE 'market:' || profile.id || ':%'
  )
   OR run.binding_id IN (SELECT id FROM retired_market_bindings);

CREATE TEMP TABLE retired_market_source_listings ON COMMIT DROP AS
SELECT DISTINCT observation.source_listing_id AS id
FROM radar_analytics.listing_observations AS observation
JOIN retired_market_analytics_runs AS run ON run.id = observation.run_id;

DELETE FROM radar_analytics.ai_enrichments AS enrichment
WHERE EXISTS (
  SELECT 1
  FROM retired_market_profiles AS profile
  WHERE enrichment.metadata->>'marketSubscriptionKey' LIKE 'market:' || profile.id || ':%'
);

DELETE FROM radar_analytics.operational_listing_snapshots
WHERE watch_binding_id IN (SELECT id FROM retired_market_bindings);

DELETE FROM radar_analytics.keyword_listings AS listing
WHERE EXISTS (
  SELECT 1
  FROM retired_market_profiles AS profile
  WHERE listing.query_key LIKE 'market:' || profile.id || ':%'
);

DELETE FROM radar_analytics.search_runs
WHERE id IN (SELECT id FROM retired_market_analytics_runs);

DELETE FROM radar_analytics.market_scope_versions AS scope
WHERE EXISTS (
  SELECT 1
  FROM retired_market_profiles AS profile
  WHERE scope.subscription_key LIKE 'market:' || profile.id || ':%'
);

DELETE FROM radar_analytics.source_listings AS listing
WHERE listing.id IN (SELECT id FROM retired_market_source_listings)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.listing_observations observation WHERE observation.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.keyword_listings keyword_listing WHERE keyword_listing.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.operational_listing_snapshots snapshot WHERE snapshot.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.ai_enrichments enrichment WHERE enrichment.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.product_listing_links link WHERE link.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.product_listing_memberships membership WHERE membership.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.sale_records sale WHERE sale.source_listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_analytics.search_product_relations relation WHERE relation.source_listing_id = listing.id);

DELETE FROM radar_core.events
WHERE watch_profile_id IN (SELECT id FROM retired_market_profiles)
   OR watch_binding_id IN (SELECT id FROM retired_market_bindings);

DELETE FROM radar_core.listing_snapshots
WHERE watch_binding_id IN (SELECT id FROM retired_market_bindings);

DELETE FROM radar_core.source_response_captures
WHERE run_id IN (SELECT id FROM retired_market_runs);

DELETE FROM radar_core.analytics_outbox
WHERE reference_id IN (SELECT id FROM retired_market_runs)
   OR EXISTS (
     SELECT 1
     FROM retired_market_profiles AS profile
     WHERE payload_json LIKE '%' || profile.id || '%'
   );

DELETE FROM radar_core.market_listing_cleaning_claims AS claim
WHERE EXISTS (
  SELECT 1
  FROM retired_market_profiles AS profile
  WHERE claim.subscription_key LIKE 'market:' || profile.id || ':%'
);

DELETE FROM radar_core.gemini_jobs
WHERE binding_id IN (SELECT id FROM retired_market_bindings)
   OR watch_run_id IN (SELECT id FROM retired_market_runs);

DELETE FROM radar_core.watch_profiles
WHERE id IN (SELECT id FROM retired_market_profiles);

DELETE FROM radar_core.listings AS listing
WHERE listing.id IN (SELECT id FROM retired_market_core_listings)
  AND NOT EXISTS (SELECT 1 FROM radar_core.watch_listing_matches match WHERE match.listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_core.events event WHERE event.listing_id = listing.id)
  AND NOT EXISTS (SELECT 1 FROM radar_core.monitor_events event WHERE event.listing_id = listing.id);

ALTER TABLE radar_core.watch_profiles
  DROP CONSTRAINT ck_watch_profiles_01,
  ADD CONSTRAINT ck_watch_profiles_01 CHECK (
    dossier_kind = ANY (ARRAY['item'::text,'exact_product'::text,'keyword'::text])
  );

ALTER TABLE radar_core.watch_bindings
  DROP CONSTRAINT ck_watch_bindings_03,
  ADD CONSTRAINT ck_watch_bindings_03 CHECK (
    monitoring_purpose = ANY (ARRAY['item_price'::text,'keyword_new_listing'::text])
  );
