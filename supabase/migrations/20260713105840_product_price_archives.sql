ALTER TABLE radar_analytics.source_listings
  ADD COLUMN product_key text,
  ADD COLUMN product_match_method text
    CHECK (product_match_method IN ('identifier', 'exact_title', 'listing_identity'));

ALTER TABLE radar_analytics.listing_observations
  ADD COLUMN price_basis text NOT NULL DEFAULT 'listing_price'
    CHECK (price_basis IN ('listing_price', 'catalog_price', 'offer_price'));

ALTER TABLE radar_analytics.catalog_products
  ADD COLUMN product_key text,
  ADD COLUMN identity_method text
    CHECK (identity_method IN ('identifier', 'exact_title', 'listing_identity'));

UPDATE radar_analytics.catalog_products
SET product_key = 'legacy:' || id::text,
    identity_method = 'listing_identity'
WHERE product_key IS NULL;

ALTER TABLE radar_analytics.catalog_products
  ALTER COLUMN product_key SET NOT NULL,
  ALTER COLUMN identity_method SET NOT NULL;

CREATE UNIQUE INDEX catalog_products_product_key_idx
  ON radar_analytics.catalog_products(product_key);

-- One source listing belongs to exactly one conservative product identity.
DELETE FROM radar_analytics.product_listing_links older
USING radar_analytics.product_listing_links newer
WHERE older.source_listing_id = newer.source_listing_id
  AND older.catalog_product_id > newer.catalog_product_id;

CREATE UNIQUE INDEX product_listing_links_source_listing_idx
  ON radar_analytics.product_listing_links(source_listing_id);

CREATE OR REPLACE FUNCTION radar_analytics.resolve_product_identity(
  p_source_id text,
  p_source_item_id text,
  p_title text,
  p_facts jsonb,
  p_raw_metadata jsonb
)
RETURNS TABLE(product_key text, match_method text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  candidate record;
  normalized_identifier text;
  normalized_title text;
BEGIN
  FOR candidate IN
    SELECT * FROM (VALUES
      ('jan', COALESCE(p_facts #>> '{identifiers,jan}', p_raw_metadata #>> '{identifiers,jan}')),
      ('isbn', COALESCE(p_facts #>> '{identifiers,isbn}', p_raw_metadata #>> '{identifiers,isbn}')),
      ('asin', COALESCE(p_facts #>> '{identifiers,asin}', p_raw_metadata #>> '{identifiers,asin}')),
      ('modelNumber', COALESCE(p_facts #>> '{identifiers,modelNumber}', p_raw_metadata #>> '{identifiers,modelNumber}'))
    ) AS identifiers(label, raw_value)
  LOOP
    IF candidate.raw_value IS NOT NULL THEN
      normalized_identifier := upper(regexp_replace(normalize(candidate.raw_value, NFKC), '[[:space:]-]+', '', 'g'));
      IF normalized_identifier ~ '^[A-Z0-9]{8,20}$' THEN
        product_key := candidate.label || ':' || normalized_identifier;
        match_method := 'identifier';
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END LOOP;

  normalized_title := regexp_replace(lower(normalize(COALESCE(p_title, ''), NFKC)), '[[:space:][:punct:]]+', '', 'g');
  IF char_length(normalized_title) >= 8 THEN
    product_key := 'title:' || normalized_title;
    match_method := 'exact_title';
  ELSE
    product_key := 'listing:' || p_source_id || ':' || p_source_item_id;
    match_method := 'listing_identity';
  END IF;
  RETURN NEXT;
END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.assign_source_listing_product_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  identity record;
BEGIN
  SELECT * INTO identity
  FROM radar_analytics.resolve_product_identity(
    NEW.source_id, NEW.source_item_id, NEW.title, NEW.facts, NEW.raw_metadata
  );
  NEW.product_key := identity.product_key;
  NEW.product_match_method := identity.match_method;
  RETURN NEW;
END
$$;

CREATE TRIGGER source_listings_assign_product_identity
BEFORE INSERT OR UPDATE OF source_id, source_item_id, title, facts, raw_metadata
ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.assign_source_listing_product_identity();

CREATE OR REPLACE FUNCTION radar_analytics.link_source_listing_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  product_id bigint;
BEGIN
  INSERT INTO radar_analytics.catalog_products(product_key, canonical_title, identifiers, identity_method, updated_at)
  VALUES (
    NEW.product_key,
    NEW.title,
    COALESCE(NEW.facts -> 'identifiers', NEW.raw_metadata -> 'identifiers', '{}'::jsonb),
    NEW.product_match_method,
    now()
  )
  ON CONFLICT (product_key) DO UPDATE SET
    canonical_title = EXCLUDED.canonical_title,
    identifiers = radar_analytics.catalog_products.identifiers || EXCLUDED.identifiers,
    identity_method = EXCLUDED.identity_method,
    updated_at = now()
  RETURNING id INTO product_id;

  INSERT INTO radar_analytics.product_listing_links(
    catalog_product_id, source_listing_id, match_method, confidence, evidence
  ) VALUES (
    product_id,
    NEW.id,
    NEW.product_match_method,
    CASE NEW.product_match_method WHEN 'identifier' THEN 1.0 WHEN 'exact_title' THEN 0.9 ELSE 1.0 END,
    jsonb_build_object('productKey', NEW.product_key, 'title', NEW.title)
  )
  ON CONFLICT (source_listing_id) DO UPDATE SET
    catalog_product_id = EXCLUDED.catalog_product_id,
    match_method = EXCLUDED.match_method,
    confidence = EXCLUDED.confidence,
    evidence = EXCLUDED.evidence;
  RETURN NEW;
END
$$;

CREATE TRIGGER source_listings_link_product
AFTER INSERT OR UPDATE OF product_key, product_match_method, title, facts, raw_metadata
ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.link_source_listing_product();

CREATE OR REPLACE FUNCTION radar_analytics.assign_observation_price_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, radar_analytics
AS $$
BEGIN
  SELECT source_listing.price_basis INTO NEW.price_basis
  FROM radar_analytics.source_listings source_listing
  WHERE source_listing.id = NEW.source_listing_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER listing_observations_assign_price_basis
BEFORE INSERT OR UPDATE OF source_listing_id
ON radar_analytics.listing_observations
FOR EACH ROW EXECUTE FUNCTION radar_analytics.assign_observation_price_basis();

-- Fire the identity/link triggers for the existing history, then make the
-- product identity mandatory for every future listing.
UPDATE radar_analytics.source_listings SET title = title;
UPDATE radar_analytics.listing_observations observation
SET price_basis = source_listing.price_basis
FROM radar_analytics.source_listings source_listing
WHERE source_listing.id = observation.source_listing_id;

ALTER TABLE radar_analytics.source_listings
  ALTER COLUMN product_key SET NOT NULL,
  ALTER COLUMN product_match_method SET NOT NULL;

REVOKE ALL ON FUNCTION radar_analytics.resolve_product_identity(text,text,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.assign_source_listing_product_identity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.link_source_listing_product()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.assign_observation_price_basis()
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN radar_analytics.source_listings.product_key IS
  'Conservative identity: official identifier first, otherwise exact normalized title, otherwise source listing.';
COMMENT ON COLUMN radar_analytics.listing_observations.price_basis IS
  'Price representation captured with the observation; incompatible bases are never compared as a change.';
