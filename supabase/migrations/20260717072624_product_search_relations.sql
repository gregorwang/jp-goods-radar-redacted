-- Target-dependent matching is a versioned derivative of immutable source
-- evidence. A listing may be exact for one target and a variant for another.
CREATE TABLE radar_analytics.search_product_relations (
  search_run_id uuid NOT NULL
    REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE,
  source_listing_id bigint NOT NULL
    REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  relation text NOT NULL
    CHECK (relation IN ('exact', 'probable_exact', 'variant', 'bundle', 'related', 'irrelevant', 'uncertain')),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  matcher_version text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (search_run_id, source_listing_id, matcher_version)
);

CREATE INDEX search_product_relations_listing_idx
  ON radar_analytics.search_product_relations(source_listing_id, observed_at DESC);
CREATE INDEX search_product_relations_rank_idx
  ON radar_analytics.search_product_relations(relation, score DESC, observed_at DESC);

-- The explicit regconfig makes this expression immutable and indexable. The
-- simple dictionary preserves Japanese product tokens instead of stemming them.
CREATE INDEX source_listings_search_document_idx
  ON radar_analytics.source_listings USING gin (
    to_tsvector(
      'simple'::regconfig,
      COALESCE(title, '') || ' ' || COALESCE(description_excerpt, '') || ' '
        || COALESCE(facts::text, '')
    )
  );

CREATE OR REPLACE FUNCTION radar_analytics.search_historical_product_listings(
  p_source_ids text[],
  p_terms text[],
  p_limit integer DEFAULT 30
)
RETURNS TABLE (
  source_id text,
  source_item_id text,
  identity_scope text,
  canonical_url text,
  title text,
  description_excerpt text,
  image_url text,
  seller_name text,
  shop_name text,
  currency text,
  current_price_jpy integer,
  original_price_jpy integer,
  price_basis text,
  item_condition text,
  availability text,
  facts jsonb,
  raw_metadata jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, radar_analytics
AS $$
  WITH normalized_terms AS (
    SELECT DISTINCT lower(normalize(trim(term), NFKC)) AS term
    FROM unnest(COALESCE(p_terms, ARRAY[]::text[])) AS value(term)
    WHERE trim(term) <> ''
    LIMIT 12
  ), fts_ranked AS (
    SELECT listing.id, count(*)::integer AS matched_terms
    FROM normalized_terms target
    JOIN radar_analytics.source_listings listing
      ON to_tsvector(
           'simple'::regconfig,
           COALESCE(listing.title, '') || ' '
             || COALESCE(listing.description_excerpt, '') || ' '
             || COALESCE(listing.facts::text, '')
         ) @@ plainto_tsquery('simple'::regconfig, target.term)
    WHERE COALESCE(array_length(p_source_ids, 1), 0) = 0
       OR listing.source_id = ANY(p_source_ids)
    GROUP BY listing.id
  ), recent_pool AS (
    SELECT listing.*
    FROM radar_analytics.source_listings listing
    WHERE COALESCE(array_length(p_source_ids, 1), 0) = 0
       OR listing.source_id = ANY(p_source_ids)
    ORDER BY listing.last_seen_at DESC
    LIMIT 2000
  ), substring_ranked AS (
    SELECT listing.id, count(*)::integer AS matched_terms
    FROM recent_pool listing
    JOIN normalized_terms target
      ON lower(normalize(
           COALESCE(listing.title, '') || ' '
             || COALESCE(listing.description_excerpt, '') || ' '
             || COALESCE(listing.facts::text, ''),
           NFKC
         )) LIKE '%' || target.term || '%'
    GROUP BY listing.id
  ), candidate_ids AS (
    SELECT id, max(matched_terms)::integer AS matched_terms
    FROM (
      SELECT * FROM fts_ranked
      UNION ALL
      SELECT * FROM substring_ranked
    ) candidates
    GROUP BY id
  )
  SELECT
    listing.source_id,
    listing.source_item_id,
    listing.identity_scope,
    listing.canonical_url,
    listing.title,
    listing.description_excerpt,
    listing.image_url,
    listing.seller_name,
    listing.shop_name,
    listing.currency,
    listing.current_price_jpy,
    listing.original_price_jpy,
    listing.price_basis,
    listing.item_condition,
    listing.availability,
    listing.facts,
    listing.raw_metadata,
    listing.first_seen_at,
    listing.last_seen_at
  FROM candidate_ids candidate
  JOIN radar_analytics.source_listings listing ON listing.id = candidate.id
  ORDER BY candidate.matched_terms DESC, listing.last_seen_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
$$;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_product_relations(p_payload jsonb)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, radar_analytics
AS $$
  INSERT INTO radar_analytics.search_product_relations(
    search_run_id, source_listing_id, target, relation, score,
    matcher_version, evidence, observed_at
  )
  SELECT
    (p_payload ->> 'id')::uuid,
    listing.id,
    CASE
      WHEN jsonb_typeof(p_payload #> '{filters,target}') = 'object'
      THEN p_payload #> '{filters,target}'
      ELSE '{}'::jsonb
    END,
    candidate.evidence #>> '{match,relation}',
    (candidate.evidence #>> '{match,score}')::integer,
    candidate.evidence #>> '{match,version}',
    candidate.evidence,
    (p_payload ->> 'searchedAt')::timestamptz
  FROM jsonb_array_elements(COALESCE(p_payload -> 'groups', '[]'::jsonb)) AS groups(group_value)
  CROSS JOIN LATERAL jsonb_each(
    CASE
      WHEN jsonb_typeof(group_value -> 'candidateEvidence') = 'object'
      THEN group_value -> 'candidateEvidence'
      ELSE '{}'::jsonb
    END
  ) AS candidate(source_item_id, evidence)
  JOIN radar_analytics.source_listings listing
    ON listing.source_id = group_value ->> 'sourceId'
   AND listing.source_item_id = candidate.source_item_id
  WHERE p_payload #>> '{filters,searchMode}' = 'exact_product'
    AND jsonb_typeof(candidate.evidence) = 'object'
    AND jsonb_typeof(candidate.evidence -> 'match') = 'object'
    AND candidate.evidence #>> '{match,relation}' IN (
      'exact', 'probable_exact', 'variant', 'bundle', 'related', 'irrelevant', 'uncertain'
    )
    AND candidate.evidence #>> '{match,score}' ~ '^[0-9]{1,3}$'
    AND (candidate.evidence #>> '{match,score}')::integer BETWEEN 0 AND 100
    AND COALESCE(candidate.evidence #>> '{match,version}', '') <> ''
  ON CONFLICT (search_run_id, source_listing_id, matcher_version) DO NOTHING
$$;

REVOKE ALL ON radar_analytics.search_product_relations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.search_historical_product_listings(text[], text[], integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_search_product_relations(jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON radar_analytics.search_product_relations TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.search_historical_product_listings(text[], text[], integer)
  TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_search_product_relations(jsonb)
  TO radar_analytics_runtime;

COMMENT ON TABLE radar_analytics.search_product_relations IS
  'Versioned target-dependent product relations. Source listings and conservative catalog identity remain unchanged.';
