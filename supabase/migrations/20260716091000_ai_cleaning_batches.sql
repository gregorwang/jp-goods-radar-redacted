-- Preserve each successful provider response even when only part of its
-- structured output can be projected onto listings.
CREATE TABLE radar_analytics.ai_processing_batches (
  batch_id text PRIMARY KEY,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  raw_response text NOT NULL,
  status text NOT NULL CHECK (status IN ('parsed','partial','unparsed')),
  parsed_count integer NOT NULL DEFAULT 0 CHECK (parsed_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (purpose, provider, model, prompt_version, input_hash)
);

CREATE INDEX ai_processing_batches_created_idx
  ON radar_analytics.ai_processing_batches(created_at DESC);

ALTER TABLE radar_analytics.ai_enrichments
  ADD COLUMN batch_id text REFERENCES radar_analytics.ai_processing_batches(batch_id) ON DELETE SET NULL;

CREATE INDEX ai_enrichments_batch_idx
  ON radar_analytics.ai_enrichments(batch_id);

CREATE OR REPLACE FUNCTION radar_analytics.ingest_ai_processing_batch(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_batch_id text := p_payload ->> 'batchId';
  v_batch jsonb := p_payload -> 'batch';
  record_value jsonb;
  v_listing_id bigint;
  v_observed_at timestamptz;
BEGIN
  INSERT INTO radar_analytics.ai_processing_batches(
    batch_id,purpose,provider,model,prompt_version,input_hash,input,raw_response,
    status,parsed_count,metadata,created_at
  ) VALUES (
    v_batch_id,
    v_batch ->> 'purpose',
    v_batch ->> 'provider',
    v_batch ->> 'model',
    v_batch ->> 'promptVersion',
    v_batch ->> 'inputHash',
    COALESCE(v_batch -> 'input','{}'::jsonb),
    COALESCE(v_batch ->> 'rawResponse',''),
    v_batch ->> 'status',
    jsonb_array_length(COALESCE(p_payload -> 'records','[]'::jsonb)),
    COALESCE(v_batch -> 'metadata','{}'::jsonb),
    (v_batch ->> 'observedAt')::timestamptz
  )
  ON CONFLICT (batch_id) DO NOTHING;

  FOR record_value IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload -> 'records','[]'::jsonb))
  LOOP
    v_observed_at := COALESCE((record_value ->> 'observedAt')::timestamptz, now());
    v_listing_id := radar_analytics.upsert_source_listing(record_value -> 'listing', v_observed_at);

    INSERT INTO radar_analytics.ai_enrichments(
      source_listing_id,batch_id,purpose,provider,model,prompt_version,
      input_hash,input,output,evidence,confidence,metadata,created_at
    ) VALUES (
      v_listing_id,
      v_batch_id,
      record_value ->> 'purpose',
      record_value ->> 'provider',
      record_value ->> 'model',
      record_value ->> 'promptVersion',
      record_value ->> 'inputHash',
      record_value -> 'input',
      record_value -> 'output',
      COALESCE(record_value -> 'evidence','{}'::jsonb),
      NULLIF(record_value ->> 'confidence',''),
      COALESCE(record_value -> 'metadata','{}'::jsonb),
      v_observed_at
    )
    ON CONFLICT (
      source_listing_id,purpose,provider,model,prompt_version,input_hash
    ) WHERE source_listing_id IS NOT NULL DO NOTHING;
  END LOOP;
END
$$;

COMMENT ON TABLE radar_analytics.ai_processing_batches IS
  'Immutable AI inputs and raw provider responses. Partial parsing never discards the provider output.';

CREATE VIEW radar_analytics.latest_cleaned_listings
WITH (security_invoker = true)
AS
SELECT
  listing.id AS source_listing_id,
  listing.source_id,
  listing.source_item_id,
  listing.canonical_url,
  listing.title AS source_title,
  CASE WHEN listing.current_price_jpy > 0 AND listing.current_price_jpy <= 1000000000
    THEN listing.current_price_jpy ELSE NULL END AS cleaned_price_jpy,
  CASE WHEN listing.current_price_jpy IS NULL THEN 'missing'
    WHEN listing.current_price_jpy <= 0 OR listing.current_price_jpy > 1000000000 THEN 'invalid'
    ELSE 'valid' END AS price_status,
  listing.availability,
  listing.first_seen_at,
  listing.last_seen_at,
  jsonb_strip_nulls(jsonb_build_object(
    'title', COALESCE(enrichment.output ->> 'translatedTitle', listing.title),
    'summary', enrichment.output ->> 'summary',
    'relevance', COALESCE(enrichment.output ->> 'relevance', 'uncertain'),
    'relevanceReason', enrichment.output ->> 'relevanceReason',
    'category', enrichment.output ->> 'normalizedCategory',
    'productType', enrichment.output ->> 'productType',
    'workTitle', enrichment.output ->> 'workTitle',
    'series', enrichment.output ->> 'series',
    'characters', enrichment.output -> 'characters',
    'officialStatus', enrichment.output ->> 'officialStatus',
    'condition', COALESCE(enrichment.output ->> 'normalizedCondition', listing.item_condition),
    'conditionNotes', enrichment.output -> 'conditionNotes',
    'defects', enrichment.output -> 'defects',
    'missingParts', enrichment.output -> 'missingParts',
    'includedItems', enrichment.output -> 'includedItems',
    'editionOrModel', enrichment.output ->> 'editionOrModel'
  )) AS cleaned_core,
  jsonb_build_object(
    'sourceFacts', listing.facts,
    'sourceMetadata', listing.raw_metadata,
    'aiExtraInfo', COALESCE(enrichment.output -> 'extraInfo', '{}'::jsonb)
  ) AS extra_info,
  enrichment.provider AS ai_provider,
  enrichment.model AS ai_model,
  enrichment.prompt_version AS ai_prompt_version,
  enrichment.created_at AS ai_cleaned_at
FROM radar_analytics.source_listings AS listing
LEFT JOIN LATERAL (
  SELECT ai.output,ai.provider,ai.model,ai.prompt_version,ai.created_at
  FROM radar_analytics.ai_enrichments AS ai
  WHERE ai.source_listing_id=listing.id AND ai.purpose='listing_semantics'
  ORDER BY ai.created_at DESC,ai.id DESC
  LIMIT 1
) AS enrichment ON true;

COMMENT ON VIEW radar_analytics.latest_cleaned_listings IS
  'Unified frontend projection: deterministic core fields, latest versioned AI semantics, and source-specific extra_info.';

REVOKE ALL ON radar_analytics.ai_processing_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.latest_cleaned_listings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_ai_processing_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON radar_analytics.ai_processing_batches TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.latest_cleaned_listings TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_ai_processing_batch(jsonb) TO radar_analytics_runtime;
