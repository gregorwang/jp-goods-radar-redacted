-- Preserve the price meaning of every watch-run observation so the audit UI
-- never presents an in-progress auction bid as a fixed purchasable price.
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
      'watch observation price basis requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
END
$runner_contract$;

ALTER TABLE radar_core.watch_run_listing_observations
  ADD COLUMN price_basis text;

UPDATE radar_core.watch_run_listing_observations AS observation
SET price_basis=COALESCE((
  SELECT listing.price_basis
  FROM radar_core.listings AS listing
  WHERE listing.source_id=observation.source_id
    AND listing.source_item_id=observation.source_item_id
),CASE
  WHEN observation.source_id='yahoo_auctions_jp' THEN 'auction_current_bid'
  ELSE 'listing_price'
END);

ALTER TABLE radar_core.watch_run_listing_observations
  ALTER COLUMN price_basis SET NOT NULL,
  ADD CONSTRAINT ck_watch_run_listing_observations_04 CHECK (
    price_basis = ANY (ARRAY[
      'listing_price'::text,
      'catalog_price'::text,
      'offer_price'::text,
      'auction_current_bid'::text
    ])
  );
