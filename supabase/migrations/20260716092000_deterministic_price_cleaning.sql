-- Price validity is deterministic and must not consume model calls. The exact
-- observed value remains in listing_observations.listing_payload and in the
-- pre-parser source response.
ALTER TABLE radar_analytics.source_listings
  ADD COLUMN price_status text NOT NULL DEFAULT 'missing'
    CHECK (price_status IN ('valid','missing','invalid'));

ALTER TABLE radar_analytics.listing_observations
  ADD COLUMN price_status text NOT NULL DEFAULT 'missing'
    CHECK (price_status IN ('valid','missing','invalid'));

CREATE OR REPLACE FUNCTION radar_analytics.clean_source_listing_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
BEGIN
  IF NEW.current_price_jpy IS NULL THEN
    NEW.price_status := 'missing';
  ELSIF NEW.current_price_jpy <= 0 OR NEW.current_price_jpy > 1000000000 THEN
    NEW.current_price_jpy := NULL;
    NEW.price_status := 'invalid';
  ELSE
    NEW.price_status := 'valid';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.clean_listing_observation_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
BEGIN
  IF NEW.price_jpy IS NULL THEN
    NEW.price_status := 'missing';
  ELSIF NEW.price_jpy <= 0 OR NEW.price_jpy > 1000000000 THEN
    NEW.price_jpy := NULL;
    NEW.price_status := 'invalid';
  ELSE
    NEW.price_status := 'valid';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER source_listings_05_clean_price
BEFORE INSERT OR UPDATE OF current_price_jpy ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.clean_source_listing_price();

CREATE TRIGGER listing_observations_05_clean_price
BEFORE INSERT OR UPDATE OF price_jpy ON radar_analytics.listing_observations
FOR EACH ROW EXECUTE FUNCTION radar_analytics.clean_listing_observation_price();

UPDATE radar_analytics.source_listings SET current_price_jpy=current_price_jpy;
UPDATE radar_analytics.listing_observations SET price_jpy=price_jpy;

COMMENT ON COLUMN radar_analytics.source_listings.price_status IS
  'Deterministic validity of the current comparable price; model output is not involved.';
COMMENT ON COLUMN radar_analytics.listing_observations.price_status IS
  'Deterministic validity of this observation price. The raw value remains in listing_payload.';

REVOKE ALL ON FUNCTION radar_analytics.clean_source_listing_price() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.clean_listing_observation_price() FROM PUBLIC, anon, authenticated;
