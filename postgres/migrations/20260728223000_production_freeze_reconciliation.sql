SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;

DO $ai_batch_precondition$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid,false)
    INTO v_definition
  FROM pg_catalog.pg_constraint
  WHERE conrelid='radar_analytics.ai_processing_batches'::pg_catalog.regclass
    AND conname=
      'ai_processing_batches_purpose_provider_model_prompt_version_key';

  IF v_definition IS NOT NULL AND v_definition <>
     'UNIQUE (purpose, provider, model, prompt_version, input_hash)' THEN
    RAISE EXCEPTION 'unexpected AI batch semantic unique definition: %',
      v_definition;
  END IF;
  IF v_definition IS NULL
     AND pg_catalog.to_regclass(
       'radar_analytics.ai_processing_batches_semantic_input_idx') IS NULL
  THEN
    RAISE EXCEPTION
      'neither the reviewed AI batch semantic unique nor replacement index exists';
  END IF;
END
$ai_batch_precondition$;

-- batch_id hashes the provider response as well as the semantic input. Preserve
-- every distinct response attempt; the enrichment uniqueness boundary remains
-- the deterministic listing/input projection below.
ALTER TABLE radar_analytics.ai_processing_batches
  DROP CONSTRAINT IF EXISTS
    ai_processing_batches_purpose_provider_model_prompt_version_key;

CREATE INDEX IF NOT EXISTS ai_processing_batches_semantic_input_idx
  ON radar_analytics.ai_processing_batches(
    purpose,provider,model,prompt_version,input_hash,created_at DESC,batch_id
  );

COMMENT ON TABLE radar_analytics.ai_processing_batches IS
  'Immutable provider-response evidence. batch_id identifies one semantic request plus raw provider response; multiple responses for the same semantic input are expected.';
COMMENT ON INDEX radar_analytics.ai_processing_batches_semantic_input_idx IS
  'Non-unique grouping and chronology index for retries of the same semantic input.';

CREATE OR REPLACE FUNCTION radar_analytics.ingest_ai_processing_batch(
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,radar_analytics
AS $$
DECLARE
  v_batch_id text := p_payload ->> 'batchId';
  v_batch jsonb := p_payload -> 'batch';
  v_records jsonb := COALESCE(p_payload -> 'records','[]'::jsonb);
  v_parsed_count integer;
  record_value jsonb;
  v_listing_id bigint;
  v_observed_at timestamptz;
BEGIN
  IF jsonb_typeof(v_batch) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_records) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='AI processing payload must contain an object batch and array records';
  END IF;

  v_parsed_count := jsonb_array_length(v_records);
  IF (v_batch ->> 'status'='unparsed' AND v_parsed_count<>0)
     OR (v_batch ->> 'status' IN ('parsed','partial') AND v_parsed_count=0)
  THEN
    RAISE EXCEPTION USING
      ERRCODE='22023',
      MESSAGE='AI processing batch status and parsed record count disagree';
  END IF;

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
    v_parsed_count,
    COALESCE(v_batch -> 'metadata','{}'::jsonb),
    (v_batch ->> 'observedAt')::timestamptz
  )
  ON CONFLICT (batch_id) DO NOTHING;

  -- A caller reusing one response identity for different evidence must fail
  -- closed instead of attaching records to an unrelated raw provider output.
  IF NOT EXISTS (
    SELECT 1
    FROM radar_analytics.ai_processing_batches AS existing
    WHERE existing.batch_id=v_batch_id
      AND existing.purpose IS NOT DISTINCT FROM v_batch ->> 'purpose'
      AND existing.provider IS NOT DISTINCT FROM v_batch ->> 'provider'
      AND existing.model IS NOT DISTINCT FROM v_batch ->> 'model'
      AND existing.prompt_version IS NOT DISTINCT FROM
        v_batch ->> 'promptVersion'
      AND existing.input_hash IS NOT DISTINCT FROM v_batch ->> 'inputHash'
      AND existing.input=COALESCE(v_batch -> 'input','{}'::jsonb)
      AND existing.raw_response=COALESCE(v_batch ->> 'rawResponse','')
      AND existing.status IS NOT DISTINCT FROM v_batch ->> 'status'
      AND existing.parsed_count=v_parsed_count
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23505',
      MESSAGE='AI processing batch_id collision or inconsistent replay';
  END IF;

  FOR record_value IN
    SELECT value FROM jsonb_array_elements(v_records)
  LOOP
    IF record_value ->> 'purpose' IS DISTINCT FROM v_batch ->> 'purpose'
       OR record_value ->> 'provider' IS DISTINCT FROM v_batch ->> 'provider'
       OR record_value ->> 'model' IS DISTINCT FROM v_batch ->> 'model'
       OR record_value ->> 'promptVersion' IS DISTINCT FROM
         v_batch ->> 'promptVersion'
    THEN
      RAISE EXCEPTION USING
        ERRCODE='22023',
        MESSAGE='AI enrichment record contract differs from its response batch';
    END IF;

    v_observed_at := COALESCE(
      (record_value ->> 'observedAt')::timestamptz,
      now()
    );
    v_listing_id := radar_analytics.upsert_source_listing(
      record_value -> 'listing',
      v_observed_at
    );

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

ALTER FUNCTION radar_analytics.ingest_ai_processing_batch(jsonb)
  OWNER TO jpgr_owner;
REVOKE ALL ON FUNCTION radar_analytics.ingest_ai_processing_batch(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_ai_processing_batch(jsonb)
  TO radar_analytics_runtime;

REVOKE ALL PRIVILEGES ON TABLE radar_analytics.ai_processing_batches
  FROM radar_analytics_runtime;
GRANT SELECT,INSERT ON TABLE radar_analytics.ai_processing_batches
  TO radar_analytics_runtime;

-- Historical rows remain owner-readable for compatibility, but application
-- runtime roles must not read or mutate reports that the application no
-- longer owns.
REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports
  FROM radar_analytics_runtime;
DO $revoke_market_ai_reports_from_app$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname='jpgr_app'
  ) THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports FROM jpgr_app';
  END IF;
END
$revoke_market_ai_reports_from_app$;

COMMENT ON TABLE radar_analytics.market_ai_reports IS
  'Historical compatibility state only. Application runtime roles have no access; ad hoc analysis belongs in Databricks.';

DO $ai_batch_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid=
      'radar_analytics.ai_processing_batches'::pg_catalog.regclass
      AND conname=
        'ai_processing_batches_purpose_provider_model_prompt_version_key'
  ) THEN
    RAISE EXCEPTION 'AI batch semantic unique constraint still exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index
    WHERE indexrelid=pg_catalog.to_regclass(
      'radar_analytics.ai_processing_batches_semantic_input_idx')
      AND indisvalid
      AND indisready
      AND NOT indisunique
  ) THEN
    RAISE EXCEPTION
      'non-unique AI batch semantic response index is absent or invalid';
  END IF;
  IF (
    SELECT prosecdef
    FROM pg_catalog.pg_proc
    WHERE oid=
      'radar_analytics.ingest_ai_processing_batch(jsonb)'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'ingest_ai_processing_batch must remain SECURITY INVOKER';
  END IF;
  IF pg_catalog.has_table_privilege(
       'radar_analytics_runtime',
       'radar_analytics.ai_processing_batches',
       'UPDATE'
     )
  THEN
    RAISE EXCEPTION
      'runtime unexpectedly has UPDATE on ai_processing_batches';
  END IF;
END
$ai_batch_postcondition$;
