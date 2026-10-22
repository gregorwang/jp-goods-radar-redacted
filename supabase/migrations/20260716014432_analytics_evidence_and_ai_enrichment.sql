-- Preserve the evidence that produced analytics and make AI output an
-- immutable, versioned derivative instead of overwriting source facts.

ALTER TABLE radar_analytics.source_listings
  ADD COLUMN source_listed_at text,
  ADD COLUMN source_updated_at text;

ALTER TABLE radar_analytics.listing_observations
  ADD COLUMN listing_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(listing_payload) = 'object'),
  ADD COLUMN payload_hash text;

CREATE TABLE radar_analytics.source_run_artifacts (
  run_id uuid NOT NULL,
  source_id text NOT NULL,
  artifact_kind text NOT NULL DEFAULT 'normalized_source_group'
    CHECK (artifact_kind IN ('normalized_source_group')),
  captured_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  payload_bytes bigint NOT NULL CHECK (payload_bytes >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_id, artifact_kind),
  FOREIGN KEY (run_id, source_id)
    REFERENCES radar_analytics.search_run_sources(run_id, source_id)
    ON DELETE CASCADE,
  CHECK (payload ->> 'sourceId' = source_id)
);

CREATE INDEX source_run_artifacts_source_time_idx
  ON radar_analytics.source_run_artifacts(source_id, captured_at DESC);

CREATE TABLE radar_analytics.operational_listing_snapshots (
  external_snapshot_id text PRIMARY KEY,
  source_listing_id bigint NOT NULL REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  watch_binding_id text,
  observed_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operational_listing_snapshots_listing_time_idx
  ON radar_analytics.operational_listing_snapshots(source_listing_id, observed_at DESC);

ALTER TABLE radar_analytics.ai_enrichments
  ADD COLUMN provider text NOT NULL DEFAULT 'unknown',
  ADD COLUMN input_hash text,
  ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN confidence text CHECK (confidence IN ('high', 'medium', 'low')),
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE radar_analytics.ai_enrichments
SET input_hash = md5(
  COALESCE(source_listing_id::text, catalog_product_id::text, '') || ':' ||
  purpose || ':' || model || ':' || prompt_version || ':' || output::text
)
WHERE input_hash IS NULL;

ALTER TABLE radar_analytics.ai_enrichments
  ALTER COLUMN input_hash SET NOT NULL,
  ADD CONSTRAINT ai_enrichments_input_object CHECK (jsonb_typeof(input) = 'object'),
  ADD CONSTRAINT ai_enrichments_output_object CHECK (jsonb_typeof(output) = 'object'),
  ADD CONSTRAINT ai_enrichments_evidence_object CHECK (jsonb_typeof(evidence) = 'object'),
  ADD CONSTRAINT ai_enrichments_metadata_object CHECK (jsonb_typeof(metadata) = 'object');

CREATE UNIQUE INDEX ai_enrichments_listing_version_idx
  ON radar_analytics.ai_enrichments(
    source_listing_id, purpose, provider, model, prompt_version, input_hash
  )
  WHERE source_listing_id IS NOT NULL;

CREATE OR REPLACE FUNCTION radar_analytics.preserve_source_listing_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
BEGIN
  NEW.description_excerpt := COALESCE(NEW.description_excerpt, OLD.description_excerpt);
  NEW.image_url := COALESCE(NEW.image_url, OLD.image_url);
  NEW.seller_name := COALESCE(NEW.seller_name, OLD.seller_name);
  NEW.shop_name := COALESCE(NEW.shop_name, OLD.shop_name);
  NEW.source_listed_at := COALESCE(NEW.source_listed_at, OLD.source_listed_at);
  NEW.source_updated_at := COALESCE(NEW.source_updated_at, OLD.source_updated_at);
  NEW.facts := COALESCE(OLD.facts, '{}'::jsonb) || jsonb_strip_nulls(COALESCE(NEW.facts, '{}'::jsonb));
  NEW.raw_metadata := COALESCE(OLD.raw_metadata, '{}'::jsonb) || jsonb_strip_nulls(COALESCE(NEW.raw_metadata, '{}'::jsonb));
  RETURN NEW;
END
$$;

-- Trigger names are fired alphabetically; this must merge evidence before the
-- existing product-identity trigger reads facts and raw_metadata.
CREATE TRIGGER source_listings_00_preserve_evidence
BEFORE UPDATE ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.preserve_source_listing_evidence();

CREATE OR REPLACE FUNCTION radar_analytics.upsert_source_listing(
  p_listing jsonb,
  p_seen_at timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_listing_id bigint;
BEGIN
  IF jsonb_typeof(p_listing) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'source listing payload must be an object';
  END IF;
  IF COALESCE(p_listing ->> 'sourceId', '') = ''
     OR COALESCE(p_listing ->> 'sourceItemId', '') = ''
     OR COALESCE(p_listing ->> 'canonicalUrl', '') = ''
     OR COALESCE(p_listing ->> 'title', '') = '' THEN
    RAISE EXCEPTION 'source listing payload is missing identity';
  END IF;

  INSERT INTO radar_analytics.source_listings AS existing(
    source_id, source_item_id, identity_scope, canonical_url, title,
    description_excerpt, image_url, seller_name, shop_name,
    currency, current_price_jpy, original_price_jpy, price_basis,
    item_condition, availability, facts, raw_metadata,
    source_listed_at, source_updated_at,
    first_seen_at, last_seen_at, last_changed_at
  ) VALUES (
    p_listing ->> 'sourceId',
    p_listing ->> 'sourceItemId',
    COALESCE(NULLIF(p_listing ->> 'identityScope', ''), 'listing'),
    p_listing ->> 'canonicalUrl',
    p_listing ->> 'title',
    NULLIF(p_listing ->> 'descriptionExcerpt', ''),
    NULLIF(p_listing ->> 'imageUrl', ''),
    NULLIF(p_listing ->> 'sellerName', ''),
    NULLIF(p_listing ->> 'shopName', ''),
    COALESCE(NULLIF(p_listing ->> 'currency', ''), 'JPY'),
    (p_listing ->> 'currentPrice')::integer,
    (p_listing ->> 'originalPrice')::integer,
    COALESCE(NULLIF(p_listing ->> 'priceBasis', ''), 'listing_price'),
    COALESCE(NULLIF(p_listing ->> 'condition', ''), 'unknown'),
    COALESCE(NULLIF(p_listing ->> 'availability', ''), 'unknown'),
    COALESCE(p_listing -> 'facts', '{}'::jsonb),
    COALESCE(p_listing -> 'rawMetadata', '{}'::jsonb),
    NULLIF(p_listing ->> 'sourceListedAt', ''),
    NULLIF(p_listing ->> 'sourceUpdatedAt', ''),
    p_seen_at, p_seen_at, p_seen_at
  )
  ON CONFLICT (source_id, source_item_id) DO UPDATE SET
    identity_scope = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.identity_scope ELSE existing.identity_scope END,
    canonical_url = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.canonical_url ELSE existing.canonical_url END,
    title = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.title ELSE existing.title END,
    description_excerpt = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.description_excerpt, existing.description_excerpt) ELSE existing.description_excerpt END,
    image_url = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.image_url, existing.image_url) ELSE existing.image_url END,
    seller_name = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.seller_name, existing.seller_name) ELSE existing.seller_name END,
    shop_name = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.shop_name, existing.shop_name) ELSE existing.shop_name END,
    currency = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.currency ELSE existing.currency END,
    current_price_jpy = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.current_price_jpy ELSE existing.current_price_jpy END,
    original_price_jpy = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.original_price_jpy ELSE existing.original_price_jpy END,
    price_basis = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.price_basis ELSE existing.price_basis END,
    item_condition = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.item_condition ELSE existing.item_condition END,
    availability = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.availability ELSE existing.availability END,
    facts = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN existing.facts || jsonb_strip_nulls(EXCLUDED.facts) ELSE existing.facts END,
    raw_metadata = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN existing.raw_metadata || jsonb_strip_nulls(EXCLUDED.raw_metadata) ELSE existing.raw_metadata END,
    source_listed_at = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.source_listed_at, existing.source_listed_at) ELSE existing.source_listed_at END,
    source_updated_at = CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN COALESCE(EXCLUDED.source_updated_at, existing.source_updated_at) ELSE existing.source_updated_at END,
    first_seen_at = LEAST(existing.first_seen_at, EXCLUDED.first_seen_at),
    last_changed_at = CASE
      WHEN EXCLUDED.last_seen_at >= existing.last_seen_at AND
        (existing.current_price_jpy, existing.availability, existing.title, existing.canonical_url, existing.facts, existing.raw_metadata)
        IS DISTINCT FROM
        (EXCLUDED.current_price_jpy, EXCLUDED.availability, EXCLUDED.title, EXCLUDED.canonical_url, EXCLUDED.facts, EXCLUDED.raw_metadata)
      THEN EXCLUDED.last_seen_at ELSE existing.last_changed_at END,
    last_seen_at = GREATEST(existing.last_seen_at, EXCLUDED.last_seen_at)
  RETURNING id INTO v_listing_id;

  RETURN v_listing_id;
END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_run_v2(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_run_id uuid := (p_payload ->> 'id')::uuid;
  v_searched_at timestamptz := (p_payload ->> 'searchedAt')::timestamptz;
  entry record;
BEGIN
  PERFORM radar_analytics.ingest_search_run(p_payload);

  INSERT INTO radar_analytics.source_run_artifacts(
    run_id, source_id, artifact_kind, captured_at, content_hash, payload_bytes, payload
  )
  SELECT
    v_run_id,
    group_value ->> 'sourceId',
    'normalized_source_group',
    v_searched_at,
    md5(group_value::text),
    octet_length(convert_to(group_value::text, 'UTF8')),
    group_value
  FROM jsonb_array_elements(COALESCE(p_payload -> 'groups', '[]'::jsonb)) AS groups(group_value)
  ON CONFLICT (run_id, source_id, artifact_kind) DO NOTHING;

  FOR entry IN
    SELECT listing_value
    FROM jsonb_array_elements(COALESCE(p_payload -> 'groups', '[]'::jsonb)) AS groups(group_value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings', '[]'::jsonb)) AS listings(listing_value)
    WHERE group_value ->> 'status' IN ('success', 'empty')
  LOOP
    PERFORM radar_analytics.upsert_source_listing(entry.listing_value, v_searched_at);
  END LOOP;

  WITH entries AS (
    SELECT group_value ->> 'sourceId' AS source_id, listing_value
    FROM jsonb_array_elements(COALESCE(p_payload -> 'groups', '[]'::jsonb)) AS groups(group_value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings', '[]'::jsonb)) AS listings(listing_value)
    WHERE group_value ->> 'status' IN ('success', 'empty')
  )
  UPDATE radar_analytics.listing_observations AS observation
  SET listing_payload = entries.listing_value,
      payload_hash = md5(entries.listing_value::text)
  FROM entries
  JOIN radar_analytics.source_listings AS source_listing
    ON source_listing.source_id = entries.source_id
   AND source_listing.source_item_id = entries.listing_value ->> 'sourceItemId'
  WHERE observation.run_id = v_run_id
    AND observation.source_listing_id = source_listing.id
    AND observation.listing_payload = '{}'::jsonb;
END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_operational_listing_bundle(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_listing jsonb := p_payload -> 'listing';
  v_observed_at timestamptz := (p_payload ->> 'observedAt')::timestamptz;
  v_listing_id bigint;
  snapshot_value jsonb;
BEGIN
  v_listing_id := radar_analytics.upsert_source_listing(v_listing, v_observed_at);

  FOR snapshot_value IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload -> 'snapshots', '[]'::jsonb))
  LOOP
    INSERT INTO radar_analytics.operational_listing_snapshots(
      external_snapshot_id, source_listing_id, watch_binding_id, observed_at,
      content_hash, payload
    ) VALUES (
      snapshot_value ->> 'id',
      v_listing_id,
      NULLIF(snapshot_value ->> 'watchBindingId', ''),
      (snapshot_value ->> 'observedAt')::timestamptz,
      COALESCE(NULLIF(snapshot_value ->> 'contentHash', ''), md5(snapshot_value::text)),
      snapshot_value
    )
    ON CONFLICT (external_snapshot_id) DO NOTHING;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_ai_enrichments(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  record_value jsonb;
  v_listing_id bigint;
  v_observed_at timestamptz;
BEGIN
  FOR record_value IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload -> 'records', '[]'::jsonb))
  LOOP
    v_observed_at := COALESCE((record_value ->> 'observedAt')::timestamptz, now());
    v_listing_id := radar_analytics.upsert_source_listing(record_value -> 'listing', v_observed_at);

    INSERT INTO radar_analytics.ai_enrichments(
      source_listing_id, purpose, provider, model, prompt_version,
      input_hash, input, output, evidence, confidence, metadata, created_at
    ) VALUES (
      v_listing_id,
      record_value ->> 'purpose',
      record_value ->> 'provider',
      record_value ->> 'model',
      record_value ->> 'promptVersion',
      record_value ->> 'inputHash',
      record_value -> 'input',
      record_value -> 'output',
      COALESCE(record_value -> 'evidence', '{}'::jsonb),
      NULLIF(record_value ->> 'confidence', ''),
      COALESCE(record_value -> 'metadata', '{}'::jsonb),
      v_observed_at
    )
    ON CONFLICT (
      source_listing_id, purpose, provider, model, prompt_version, input_hash
    ) WHERE source_listing_id IS NOT NULL DO NOTHING;
  END LOOP;
END
$$;

CREATE VIEW radar_analytics.market_subscription_daily_source_metrics
WITH (security_invoker = true)
AS
WITH source_runs AS (
  SELECT
    run.id AS run_id,
    timezone('Asia/Hong_Kong', run.searched_at)::date AS day,
    run.subscription_key,
    COALESCE(run.subscription_name, run.query) AS subscription_name,
    run.query,
    run.query_key,
    run.searched_at,
    source.source_id,
    source.result_count,
    source.new_count,
    source.left_count
  FROM radar_analytics.search_runs AS run
  JOIN radar_analytics.search_run_sources AS source ON source.run_id = run.id
  WHERE run.origin = 'watch_keyword'
    AND run.subscription_key IS NOT NULL
    AND source.status IN ('success', 'empty')
), latest_source_window AS (
  SELECT DISTINCT ON (day, subscription_key, source_id)
    run_id, day, subscription_key, subscription_name, query, query_key,
    source_id, result_count
  FROM source_runs
  ORDER BY day, subscription_key, source_id, searched_at DESC, run_id DESC
), daily_movement AS (
  SELECT day, subscription_key, source_id,
         sum(new_count)::integer AS new_count,
         sum(left_count)::integer AS left_visible_window,
         count(DISTINCT run_id)::integer AS run_count
  FROM source_runs
  GROUP BY day, subscription_key, source_id
), latest_observations AS (
  SELECT latest.day, latest.subscription_key, latest.source_id,
         observation.price_jpy, observation.availability
  FROM latest_source_window AS latest
  JOIN radar_analytics.listing_observations AS observation
    ON observation.run_id = latest.run_id
   AND observation.source_id = latest.source_id
), daily_distribution AS (
  SELECT day, subscription_key, source_id,
         count(*) FILTER (WHERE availability IN ('available', 'preorder', 'backorder'))::integer AS available_count,
         count(*) FILTER (WHERE availability = 'sold_out')::integer AS sold_out_count,
         count(price_jpy)::integer AS priced_count,
         min(price_jpy)::integer AS min_price_jpy,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price_jpy)::integer AS median_price_jpy,
         round(avg(price_jpy), 2) AS average_price_jpy,
         max(price_jpy)::integer AS max_price_jpy
  FROM latest_observations
  GROUP BY day, subscription_key, source_id
)
SELECT latest.day, latest.subscription_key, latest.subscription_name,
       latest.query, latest.query_key, latest.source_id,
       latest.result_count::integer AS visible_count,
       1::integer AS source_count,
       movement.new_count, movement.left_visible_window, movement.run_count,
       COALESCE(distribution.available_count, 0)::integer AS available_count,
       COALESCE(distribution.sold_out_count, 0)::integer AS sold_out_count,
       COALESCE(distribution.priced_count, 0)::integer AS priced_count,
       distribution.min_price_jpy, distribution.median_price_jpy,
       distribution.average_price_jpy, distribution.max_price_jpy
FROM latest_source_window AS latest
JOIN daily_movement AS movement USING (day, subscription_key, source_id)
LEFT JOIN daily_distribution AS distribution USING (day, subscription_key, source_id);

COMMENT ON VIEW radar_analytics.market_subscription_daily_source_metrics IS
  'Daily scheduled market metrics at the source boundary; each value can be traced to one latest successful source window.';

COMMENT ON TABLE radar_analytics.source_run_artifacts IS
  'Immutable normalized source-group evidence captured before any analytical projection.';
COMMENT ON COLUMN radar_analytics.listing_observations.listing_payload IS
  'Exact normalized listing document observed in this run; never overwritten after first ingestion.';
COMMENT ON TABLE radar_analytics.operational_listing_snapshots IS
  'Backfilled D1 watch snapshots retained as immutable evidence even when no historical market run exists.';
COMMENT ON TABLE radar_analytics.ai_enrichments IS
  'Versioned AI derivatives. Source evidence remains authoritative and is never overwritten by model output.';

REVOKE ALL ON radar_analytics.source_run_artifacts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.operational_listing_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.market_subscription_daily_source_metrics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.preserve_source_listing_evidence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.upsert_source_listing(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_search_run_v2(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_operational_listing_bundle(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_ai_enrichments(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON radar_analytics.ai_enrichments FROM radar_analytics_runtime;

GRANT SELECT, INSERT ON radar_analytics.source_run_artifacts TO radar_analytics_runtime;
GRANT SELECT, INSERT ON radar_analytics.operational_listing_snapshots TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.market_subscription_daily_source_metrics TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.upsert_source_listing(jsonb, timestamptz) TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_search_run_v2(jsonb) TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_operational_listing_bundle(jsonb) TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_ai_enrichments(jsonb) TO radar_analytics_runtime;
