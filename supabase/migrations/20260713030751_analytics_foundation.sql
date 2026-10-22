CREATE SCHEMA IF NOT EXISTS radar_analytics;
REVOKE ALL ON SCHEMA radar_analytics FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_analytics_runtime') THEN
    CREATE ROLE radar_analytics_runtime NOLOGIN;
  END IF;
END
$$;

CREATE TABLE radar_analytics.search_runs (
  id uuid PRIMARY KEY,
  origin text NOT NULL CHECK (origin IN ('manual_search', 'watch_keyword', 'watch_item')),
  query text NOT NULL,
  query_key text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  status text NOT NULL CHECK (status IN ('success', 'partial', 'empty', 'failed')),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  searched_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_runs_query_time_idx
  ON radar_analytics.search_runs(query_key, searched_at DESC);
CREATE INDEX search_runs_time_idx
  ON radar_analytics.search_runs(searched_at DESC);

CREATE TABLE radar_analytics.search_run_sources (
  run_id uuid NOT NULL REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'empty', 'failed', 'disabled', 'cooldown')),
  coverage text,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  left_count integer NOT NULL DEFAULT 0 CHECK (left_count >= 0),
  available_count integer NOT NULL DEFAULT 0 CHECK (available_count >= 0),
  min_price_jpy integer,
  max_price_jpy integer,
  average_price_jpy numeric(12,2),
  parser_version text,
  request_route text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  PRIMARY KEY (run_id, source_id)
);

CREATE INDEX search_run_sources_source_idx
  ON radar_analytics.search_run_sources(source_id, run_id);

CREATE TABLE radar_analytics.source_listings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  source_item_id text NOT NULL,
  identity_scope text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  description_excerpt text,
  image_url text,
  seller_name text,
  shop_name text,
  currency text NOT NULL DEFAULT 'JPY',
  current_price_jpy integer,
  original_price_jpy integer,
  price_basis text NOT NULL,
  item_condition text NOT NULL,
  availability text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_metadata) = 'object'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  UNIQUE (source_id, source_item_id)
);

CREATE INDEX source_listings_last_seen_idx
  ON radar_analytics.source_listings(last_seen_at DESC);
CREATE INDEX source_listings_price_idx
  ON radar_analytics.source_listings(source_id, current_price_jpy)
  WHERE current_price_jpy IS NOT NULL;

CREATE TABLE radar_analytics.keyword_listings (
  query_key text NOT NULL,
  source_listing_id bigint NOT NULL REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL,
  first_seen_run_id uuid NOT NULL REFERENCES radar_analytics.search_runs(id) ON DELETE RESTRICT,
  last_seen_at timestamptz NOT NULL,
  last_seen_run_id uuid NOT NULL REFERENCES radar_analytics.search_runs(id) ON DELETE RESTRICT,
  latest_evaluated_at timestamptz NOT NULL,
  last_left_run_id uuid REFERENCES radar_analytics.search_runs(id) ON DELETE SET NULL,
  appearances integer NOT NULL DEFAULT 1 CHECK (appearances >= 1),
  active_visible boolean NOT NULL DEFAULT true,
  PRIMARY KEY (query_key, source_listing_id)
);

CREATE INDEX keyword_listings_visible_idx
  ON radar_analytics.keyword_listings(query_key, active_visible, last_seen_at DESC);

CREATE TABLE radar_analytics.listing_observations (
  run_id uuid NOT NULL REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE,
  source_listing_id bigint NOT NULL REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  price_jpy integer,
  original_price_jpy integer,
  availability text NOT NULL,
  item_condition text NOT NULL,
  is_new_for_query boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, source_listing_id)
);

CREATE INDEX listing_observations_listing_time_idx
  ON radar_analytics.listing_observations(source_listing_id, observed_at DESC);
CREATE INDEX listing_observations_run_source_idx
  ON radar_analytics.listing_observations(run_id, source_id);

-- These three tables reserve explicit, auditable extension points. A sale is
-- recorded only when a source supplies actual sold evidence; sold_out alone is
-- deliberately insufficient.
CREATE TABLE radar_analytics.catalog_products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_title text NOT NULL,
  identifiers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(identifiers) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_analytics.product_listing_links (
  catalog_product_id bigint NOT NULL REFERENCES radar_analytics.catalog_products(id) ON DELETE CASCADE,
  source_listing_id bigint NOT NULL REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  match_method text NOT NULL,
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_product_id, source_listing_id)
);

CREATE TABLE radar_analytics.sale_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_listing_id bigint NOT NULL REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  source_sale_id text,
  sold_price_jpy integer,
  sold_at timestamptz NOT NULL,
  evidence_url text,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (source_listing_id, source_sale_id, sold_at)
);

CREATE TABLE radar_analytics.ai_enrichments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_listing_id bigint REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  catalog_product_id bigint REFERENCES radar_analytics.catalog_products(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  output jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_listing_id IS NOT NULL) <> (catalog_product_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_run(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_run_id uuid := (p_payload ->> 'id')::uuid;
  v_query text := p_payload ->> 'query';
  v_query_key text := p_payload ->> 'queryKey';
  v_searched_at timestamptz := (p_payload ->> 'searchedAt')::timestamptz;
BEGIN
  IF v_query IS NULL OR v_query_key IS NULL OR v_query_key = '' THEN
    RAISE EXCEPTION 'analytics search run is missing query identity';
  END IF;

  INSERT INTO radar_analytics.search_runs(
    id,origin,query,query_key,filters,status,result_count,searched_at,ingested_at
  ) VALUES (
    v_run_id,
    COALESCE(p_payload ->> 'origin','manual_search'),
    v_query,
    v_query_key,
    COALESCE(p_payload -> 'filters','{}'::jsonb),
    p_payload ->> 'status',
    COALESCE((p_payload ->> 'resultCount')::integer,0),
    v_searched_at,
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    origin=EXCLUDED.origin,
    query=EXCLUDED.query,
    query_key=EXCLUDED.query_key,
    filters=EXCLUDED.filters,
    status=EXCLUDED.status,
    result_count=EXCLUDED.result_count,
    searched_at=EXCLUDED.searched_at,
    ingested_at=now();

  INSERT INTO radar_analytics.search_run_sources(
    run_id,source_id,status,coverage,result_count,parser_version,request_route,duration_ms
  )
  SELECT
    v_run_id,
    group_value ->> 'sourceId',
    group_value ->> 'status',
    NULLIF(group_value ->> 'coverage',''),
    jsonb_array_length(COALESCE(group_value -> 'listings','[]'::jsonb)),
    NULLIF(group_value ->> 'parserVersion',''),
    NULLIF(group_value ->> 'requestRoute',''),
    (group_value ->> 'durationMs')::integer
  FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
  ON CONFLICT (run_id,source_id) DO UPDATE SET
    status=EXCLUDED.status,
    coverage=EXCLUDED.coverage,
    result_count=EXCLUDED.result_count,
    parser_version=EXCLUDED.parser_version,
    request_route=EXCLUDED.request_route,
    duration_ms=EXCLUDED.duration_ms;

  WITH entries AS (
    SELECT
      group_value ->> 'sourceId' AS source_id,
      listing_value,
      position::integer
    FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings','[]'::jsonb))
      WITH ORDINALITY AS listings(listing_value,position)
    WHERE group_value ->> 'status' IN ('success','empty')
  )
  INSERT INTO radar_analytics.source_listings AS existing(
    source_id,source_item_id,identity_scope,canonical_url,title,description_excerpt,image_url,seller_name,shop_name,
    currency,current_price_jpy,original_price_jpy,price_basis,item_condition,availability,facts,raw_metadata,
    first_seen_at,last_seen_at,last_changed_at
  )
  SELECT
    source_id,
    listing_value ->> 'sourceItemId',
    listing_value ->> 'identityScope',
    listing_value ->> 'canonicalUrl',
    listing_value ->> 'title',
    NULLIF(listing_value ->> 'descriptionExcerpt',''),
    NULLIF(listing_value ->> 'imageUrl',''),
    NULLIF(listing_value ->> 'sellerName',''),
    NULLIF(listing_value ->> 'shopName',''),
    COALESCE(NULLIF(listing_value ->> 'currency',''),'JPY'),
    (listing_value ->> 'currentPrice')::integer,
    (listing_value ->> 'originalPrice')::integer,
    listing_value ->> 'priceBasis',
    listing_value ->> 'condition',
    listing_value ->> 'availability',
    COALESCE(listing_value -> 'facts','{}'::jsonb),
    COALESCE(listing_value -> 'rawMetadata','{}'::jsonb),
    v_searched_at,v_searched_at,v_searched_at
  FROM entries
  ON CONFLICT (source_id,source_item_id) DO UPDATE SET
    identity_scope=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.identity_scope ELSE existing.identity_scope END,
    canonical_url=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.canonical_url ELSE existing.canonical_url END,
    title=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.title ELSE existing.title END,
    description_excerpt=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.description_excerpt ELSE existing.description_excerpt END,
    image_url=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.image_url ELSE existing.image_url END,
    seller_name=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.seller_name ELSE existing.seller_name END,
    shop_name=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.shop_name ELSE existing.shop_name END,
    currency=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.currency ELSE existing.currency END,
    current_price_jpy=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.current_price_jpy ELSE existing.current_price_jpy END,
    original_price_jpy=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.original_price_jpy ELSE existing.original_price_jpy END,
    price_basis=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.price_basis ELSE existing.price_basis END,
    item_condition=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.item_condition ELSE existing.item_condition END,
    availability=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.availability ELSE existing.availability END,
    facts=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.facts ELSE existing.facts END,
    raw_metadata=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN EXCLUDED.raw_metadata ELSE existing.raw_metadata END,
    first_seen_at=LEAST(existing.first_seen_at,EXCLUDED.first_seen_at),
    last_changed_at=CASE
      WHEN EXCLUDED.last_seen_at >= existing.last_seen_at AND
        (existing.current_price_jpy,existing.availability,existing.title,existing.canonical_url)
        IS DISTINCT FROM
        (EXCLUDED.current_price_jpy,EXCLUDED.availability,EXCLUDED.title,EXCLUDED.canonical_url)
      THEN EXCLUDED.last_seen_at ELSE existing.last_changed_at END,
    last_seen_at=GREATEST(existing.last_seen_at,EXCLUDED.last_seen_at);

  -- A successful empty result closes the current visible window. Failed,
  -- disabled and cooldown groups never make a listing disappear.
  UPDATE radar_analytics.keyword_listings AS keyword_listing
  SET active_visible=false,
      last_left_run_id=CASE WHEN keyword_listing.active_visible THEN v_run_id ELSE keyword_listing.last_left_run_id END,
      latest_evaluated_at=v_searched_at
  FROM radar_analytics.source_listings AS source_listing
  WHERE keyword_listing.source_listing_id=source_listing.id
    AND keyword_listing.query_key=v_query_key
    AND v_searched_at >= keyword_listing.latest_evaluated_at
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
      WHERE group_value ->> 'sourceId'=source_listing.source_id
        AND group_value ->> 'status' IN ('success','empty')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings','[]'::jsonb)) AS listings(listing_value)
      WHERE group_value ->> 'sourceId'=source_listing.source_id
        AND group_value ->> 'status' IN ('success','empty')
        AND listing_value ->> 'sourceItemId'=source_listing.source_item_id
    );

  WITH entries AS (
    SELECT group_value ->> 'sourceId' AS source_id,listing_value
    FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings','[]'::jsonb)) AS listings(listing_value)
    WHERE group_value ->> 'status' IN ('success','empty')
  )
  INSERT INTO radar_analytics.keyword_listings AS existing(
    query_key,source_listing_id,first_seen_at,first_seen_run_id,last_seen_at,last_seen_run_id,
    latest_evaluated_at,appearances,active_visible
  )
  SELECT v_query_key,source_listing.id,v_searched_at,v_run_id,v_searched_at,v_run_id,v_searched_at,1,true
  FROM entries
  JOIN radar_analytics.source_listings AS source_listing
    ON source_listing.source_id=entries.source_id
   AND source_listing.source_item_id=entries.listing_value ->> 'sourceItemId'
  ON CONFLICT (query_key,source_listing_id) DO UPDATE SET
    first_seen_at=LEAST(existing.first_seen_at,EXCLUDED.first_seen_at),
    first_seen_run_id=CASE WHEN EXCLUDED.first_seen_at < existing.first_seen_at THEN v_run_id ELSE existing.first_seen_run_id END,
    last_seen_at=GREATEST(existing.last_seen_at,EXCLUDED.last_seen_at),
    last_seen_run_id=CASE WHEN EXCLUDED.last_seen_at >= existing.last_seen_at THEN v_run_id ELSE existing.last_seen_run_id END,
    latest_evaluated_at=GREATEST(existing.latest_evaluated_at,EXCLUDED.latest_evaluated_at),
    appearances=CASE WHEN existing.last_seen_run_id IS DISTINCT FROM v_run_id THEN existing.appearances + 1 ELSE existing.appearances END,
    active_visible=CASE WHEN EXCLUDED.latest_evaluated_at >= existing.latest_evaluated_at THEN true ELSE existing.active_visible END;

  WITH entries AS (
    SELECT
      group_value ->> 'sourceId' AS source_id,
      listing_value,
      position::integer
    FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb)) AS groups(group_value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings','[]'::jsonb))
      WITH ORDINALITY AS listings(listing_value,position)
    WHERE group_value ->> 'status' IN ('success','empty')
  )
  INSERT INTO radar_analytics.listing_observations AS existing(
    run_id,source_listing_id,source_id,position,price_jpy,original_price_jpy,availability,item_condition,is_new_for_query,observed_at
  )
  SELECT
    v_run_id,source_listing.id,entries.source_id,entries.position,
    (entries.listing_value ->> 'currentPrice')::integer,
    (entries.listing_value ->> 'originalPrice')::integer,
    entries.listing_value ->> 'availability',
    entries.listing_value ->> 'condition',
    keyword_listing.first_seen_run_id=v_run_id,
    v_searched_at
  FROM entries
  JOIN radar_analytics.source_listings AS source_listing
    ON source_listing.source_id=entries.source_id
   AND source_listing.source_item_id=entries.listing_value ->> 'sourceItemId'
  JOIN radar_analytics.keyword_listings AS keyword_listing
    ON keyword_listing.query_key=v_query_key AND keyword_listing.source_listing_id=source_listing.id
  ON CONFLICT (run_id,source_listing_id) DO UPDATE SET
    position=EXCLUDED.position,
    price_jpy=EXCLUDED.price_jpy,
    original_price_jpy=EXCLUDED.original_price_jpy,
    availability=EXCLUDED.availability,
    item_condition=EXCLUDED.item_condition,
    is_new_for_query=EXCLUDED.is_new_for_query,
    observed_at=EXCLUDED.observed_at;

  UPDATE radar_analytics.listing_observations AS observation
  SET is_new_for_query=(observation.run_id=keyword_listing.first_seen_run_id)
  FROM radar_analytics.keyword_listings AS keyword_listing,
       radar_analytics.search_runs AS observation_run
  WHERE observation.source_listing_id=keyword_listing.source_listing_id
    AND observation_run.id=observation.run_id
    AND observation_run.query_key=keyword_listing.query_key
    AND keyword_listing.query_key=v_query_key;

  UPDATE radar_analytics.search_run_sources AS source_run
  SET new_count=metrics.new_count,
      left_count=metrics.left_count,
      available_count=metrics.available_count,
      min_price_jpy=metrics.min_price_jpy,
      max_price_jpy=metrics.max_price_jpy,
      average_price_jpy=metrics.average_price_jpy
  FROM (
    SELECT
      source_run_inner.source_id,
      count(observation.source_listing_id) FILTER (WHERE observation.is_new_for_query)::integer AS new_count,
      (SELECT count(*)::integer
       FROM radar_analytics.keyword_listings AS keyword_listing
       JOIN radar_analytics.source_listings AS source_listing ON source_listing.id=keyword_listing.source_listing_id
       WHERE keyword_listing.query_key=v_query_key
         AND keyword_listing.last_left_run_id=v_run_id
         AND source_listing.source_id=source_run_inner.source_id) AS left_count,
      count(observation.source_listing_id) FILTER (WHERE observation.availability IN ('available','preorder','backorder'))::integer AS available_count,
      min(observation.price_jpy)::integer AS min_price_jpy,
      max(observation.price_jpy)::integer AS max_price_jpy,
      round(avg(observation.price_jpy),2) AS average_price_jpy
    FROM radar_analytics.search_run_sources AS source_run_inner
    LEFT JOIN radar_analytics.listing_observations AS observation
      ON observation.run_id=source_run_inner.run_id AND observation.source_id=source_run_inner.source_id
    WHERE source_run_inner.run_id=v_run_id
    GROUP BY source_run_inner.source_id
  ) AS metrics
  WHERE source_run.run_id=v_run_id AND source_run.source_id=metrics.source_id;
END
$$;

CREATE OR REPLACE VIEW radar_analytics.keyword_daily_metrics
WITH (security_invoker = true)
AS
WITH run_totals AS (
  SELECT
    run.id,
    timezone('Asia/Hong_Kong',run.searched_at)::date AS day,
    run.query,
    run.query_key,
    run.searched_at,
    COALESCE(sum(source.result_count),0)::integer AS visible_count,
    COALESCE(sum(source.new_count),0)::integer AS new_count,
    COALESCE(sum(source.left_count),0)::integer AS left_visible_window
  FROM radar_analytics.search_runs AS run
  LEFT JOIN radar_analytics.search_run_sources AS source ON source.run_id=run.id
  GROUP BY run.id
), latest AS (
  SELECT DISTINCT ON (day,query_key)
    day,query,query_key,visible_count
  FROM run_totals
  ORDER BY day,query_key,searched_at DESC,id DESC
), daily AS (
  SELECT day,query_key,sum(new_count)::integer AS new_count,
         sum(left_visible_window)::integer AS left_visible_window,
         count(*)::integer AS run_count
  FROM run_totals
  GROUP BY day,query_key
)
SELECT latest.day,latest.query,latest.query_key,latest.visible_count,
       daily.new_count,daily.left_visible_window,daily.run_count
FROM latest JOIN daily USING (day,query_key);

COMMENT ON VIEW radar_analytics.keyword_daily_metrics IS
  'Daily search-window metrics. left_visible_window means absent from a later successful visible window, never inferred sold.';

REVOKE ALL ON ALL TABLES IN SCHEMA radar_analytics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA radar_analytics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA radar_analytics FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA radar_analytics TO radar_analytics_runtime;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA radar_analytics TO radar_analytics_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA radar_analytics TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_search_run(jsonb) TO radar_analytics_runtime;
