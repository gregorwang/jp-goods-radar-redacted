--
-- PostgreSQL database dump
--

-- Unified PostgreSQL baseline for Worker runtime and analytics schemas.
DO $role$
BEGIN
  CREATE ROLE jpgr_owner NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$role$;

DO $role$
BEGIN
  CREATE ROLE radar_core_runtime NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$role$;

DO $role$
BEGIN
  CREATE ROLE radar_analytics_runtime NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$role$;

-- Dumped from database version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: radar_analytics; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA radar_analytics AUTHORIZATION jpgr_owner;


--
-- Name: radar_core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA radar_core AUTHORIZATION jpgr_owner;

-- Keep the canonical rebuild contract aligned with forward migrations:
-- application objects are owned by the non-login owner role, never by the
-- administrative session that happens to load this baseline.
SET ROLE jpgr_owner;

--
-- Name: assign_observation_price_basis(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.assign_observation_price_basis() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
BEGIN
  SELECT source_listing.price_basis INTO NEW.price_basis
  FROM radar_analytics.source_listings source_listing
  WHERE source_listing.id = NEW.source_listing_id;
  RETURN NEW;
END
$$;


--
-- Name: assign_source_listing_product_identity(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.assign_source_listing_product_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: clean_listing_observation_price(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.clean_listing_observation_price() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: clean_source_listing_price(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.clean_source_listing_price() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: ingest_ai_enrichments(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_ai_enrichments(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: ingest_ai_processing_batch(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_ai_processing_batch(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path TO 'pg_catalog', 'radar_analytics'
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
  ON CONFLICT (batch_id)
  DO NOTHING;

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


--
-- Name: ingest_operational_listing_bundle(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_operational_listing_bundle(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: ingest_product_identity_projection(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
DECLARE
  v_filtered_payload jsonb;
  v_canonical jsonb := p_payload -> 'canonicalProduct';
  v_variant jsonb := p_payload -> 'productVariant';
  v_projected_at timestamptz := (p_payload ->> 'projectedAt')::timestamptz;
BEGIN
  v_filtered_payload := jsonb_set(
    p_payload,
    '{memberships}',
    COALESCE((
      SELECT jsonb_agg(membership.value ORDER BY membership.ordinality)
      FROM jsonb_array_elements(COALESCE(p_payload -> 'memberships', '[]'::jsonb))
        WITH ORDINALITY AS membership(value, ordinality)
      JOIN radar_analytics.source_listings AS listing
        ON listing.source_id = membership.value ->> 'sourceId'
       AND listing.source_item_id = membership.value ->> 'sourceItemId'
    ), '[]'::jsonb),
    false
  );
  PERFORM radar_analytics.ingest_product_identity_projection_resolved(v_filtered_payload);

  UPDATE radar_analytics.canonical_products
  SET
    canonical_name = v_canonical ->> 'canonicalName',
    work_title = NULLIF(v_canonical ->> 'workTitle', ''),
    character_names = COALESCE(v_canonical -> 'characterNames', '[]'::jsonb),
    product_type = NULLIF(v_canonical ->> 'productType', ''),
    manufacturer = NULLIF(v_canonical ->> 'manufacturer', ''),
    series = NULLIF(v_canonical ->> 'series', ''),
    target_fingerprint = v_canonical -> 'targetFingerprint',
    updated_at = v_projected_at
  WHERE id = v_canonical ->> 'id'
    AND updated_at <= v_projected_at;

  UPDATE radar_analytics.product_variants
  SET
    variant_name = v_variant ->> 'variantName',
    model = NULLIF(v_variant ->> 'model', ''),
    jan = NULLIF(v_variant ->> 'jan', ''),
    size = NULLIF(v_variant ->> 'size', ''),
    attributes = COALESCE(v_variant -> 'attributes', '{}'::jsonb),
    target_fingerprint = v_variant -> 'targetFingerprint',
    updated_at = v_projected_at
  WHERE id = v_variant ->> 'id'
    AND updated_at <= v_projected_at;
END
$$;


--
-- Name: ingest_product_identity_projection_resolved(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_product_identity_projection_resolved(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
DECLARE
  v_canonical jsonb := p_payload -> 'canonicalProduct';
  v_variant jsonb := p_payload -> 'productVariant';
  v_profile jsonb := p_payload -> 'comparisonProfile';
  v_projected_at timestamptz := (p_payload ->> 'projectedAt')::timestamptz;
  v_search_run_id uuid;
  v_membership jsonb;
  v_source_listing_id bigint;
  v_current radar_analytics.product_listing_memberships%ROWTYPE;
BEGIN
  IF jsonb_typeof(v_canonical) <> 'object'
     OR jsonb_typeof(v_variant) <> 'object'
     OR jsonb_typeof(v_profile) <> 'object'
     OR jsonb_typeof(p_payload -> 'memberships') <> 'array' THEN
    RAISE EXCEPTION 'product_identity_projection_invalid';
  END IF;

  INSERT INTO radar_analytics.canonical_products(
    id, identity_hash, identity_version, canonical_name, work_title,
    character_names, product_type, manufacturer, series, target_fingerprint,
    created_at, updated_at
  ) VALUES (
    v_canonical ->> 'id', v_canonical ->> 'identityHash', v_canonical ->> 'identityVersion',
    v_canonical ->> 'canonicalName', NULLIF(v_canonical ->> 'workTitle', ''),
    COALESCE(v_canonical -> 'characterNames', '[]'::jsonb),
    NULLIF(v_canonical ->> 'productType', ''), NULLIF(v_canonical ->> 'manufacturer', ''),
    NULLIF(v_canonical ->> 'series', ''), v_canonical -> 'targetFingerprint',
    v_projected_at, v_projected_at
  )
  ON CONFLICT (id) DO UPDATE
    SET updated_at = GREATEST(radar_analytics.canonical_products.updated_at, EXCLUDED.updated_at);

  INSERT INTO radar_analytics.product_variants(
    id, canonical_product_id, identity_hash, identity_version, variant_name,
    model, jan, size, attributes, target_fingerprint, created_at, updated_at
  ) VALUES (
    v_variant ->> 'id', v_variant ->> 'canonicalProductId', v_variant ->> 'identityHash',
    v_variant ->> 'identityVersion', v_variant ->> 'variantName',
    NULLIF(v_variant ->> 'model', ''), NULLIF(v_variant ->> 'jan', ''),
    NULLIF(v_variant ->> 'size', ''), COALESCE(v_variant -> 'attributes', '{}'::jsonb),
    v_variant -> 'targetFingerprint', v_projected_at, v_projected_at
  )
  ON CONFLICT (id) DO UPDATE
    SET updated_at = GREATEST(radar_analytics.product_variants.updated_at, EXCLUDED.updated_at);

  UPDATE radar_analytics.comparison_profiles
  SET active = false, superseded_at = v_projected_at
  WHERE product_variant_id = v_variant ->> 'id'
    AND active
    AND id <> v_profile ->> 'id';

  INSERT INTO radar_analytics.comparison_profiles(
    id, product_variant_id, profile_version, rule_version, name, condition_policy,
    allowed_conditions, allowed_completeness, allowed_price_bases,
    allowed_official_statuses, active, created_at, superseded_at
  ) VALUES (
    v_profile ->> 'id', v_variant ->> 'id', (v_profile ->> 'profileVersion')::integer,
    v_profile ->> 'ruleVersion', v_profile ->> 'name', v_profile ->> 'conditionPolicy',
    v_profile -> 'allowedConditions', v_profile -> 'allowedCompleteness',
    v_profile -> 'allowedPriceBases', v_profile -> 'allowedOfficialStatuses',
    true, v_projected_at, NULL
  )
  ON CONFLICT (id) DO UPDATE SET active = true, superseded_at = NULL;

  SELECT run.id INTO v_search_run_id
  FROM radar_analytics.search_runs AS run
  WHERE run.id = (p_payload ->> 'searchHistoryId')::uuid;

  FOR v_membership IN
    SELECT value FROM jsonb_array_elements(p_payload -> 'memberships')
  LOOP
    SELECT listing.id INTO v_source_listing_id
    FROM radar_analytics.source_listings AS listing
    WHERE listing.source_id = v_membership ->> 'sourceId'
      AND listing.source_item_id = v_membership ->> 'sourceItemId';

    IF v_source_listing_id IS NULL THEN
      RAISE EXCEPTION 'product_identity_source_listing_missing:%:%',
        v_membership ->> 'sourceId', v_membership ->> 'sourceItemId';
    END IF;

    IF EXISTS (
      SELECT 1 FROM radar_analytics.product_listing_memberships
      WHERE id = v_membership ->> 'id'
    ) THEN
      CONTINUE;
    END IF;

    SELECT membership.* INTO v_current
    FROM radar_analytics.product_listing_memberships AS membership
    WHERE membership.product_variant_id = v_variant ->> 'id'
      AND membership.source_listing_id = v_source_listing_id
      AND membership.is_current
    FOR UPDATE;

    IF FOUND AND v_current.decision_source = 'human'
       AND (v_membership ->> 'decisionSource') <> 'human' THEN
      CONTINUE;
    END IF;

    IF FOUND AND v_current.valid_from >= v_projected_at
       AND (v_membership ->> 'decisionSource') <> 'human' THEN
      CONTINUE;
    END IF;

    IF FOUND THEN
      UPDATE radar_analytics.product_listing_memberships
      SET is_current = false, valid_to = v_projected_at
      WHERE id = v_current.id;
    END IF;

    INSERT INTO radar_analytics.product_listing_memberships(
      id, product_variant_id, source_listing_id, search_run_id, workflow_task_id,
      decision, decision_source, relation, confidence, membership_version,
      evidence, valid_from, valid_to, is_current, supersedes_membership_id, created_at
    ) VALUES (
      v_membership ->> 'id', v_variant ->> 'id', v_source_listing_id, v_search_run_id,
      p_payload ->> 'workflowTaskId', v_membership ->> 'decision',
      v_membership ->> 'decisionSource', v_membership ->> 'relation',
      v_membership ->> 'confidence', p_payload ->> 'membershipVersion',
      COALESCE(v_membership -> 'evidence', '{}'::jsonb), v_projected_at,
      NULL, true, CASE WHEN v_current.id IS NULL THEN NULL ELSE v_current.id END,
      v_projected_at
    );
  END LOOP;
END
$$;


--
-- Name: ingest_search_product_relations(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_search_product_relations(p_payload jsonb) RETURNS void
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $_$
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
$_$;


--
-- Name: ingest_search_run(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_search_run(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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
    run_id,source_listing_id,source_id,position,price_jpy,original_price_jpy,availability,item_condition,is_new_for_query,observed_at,payload_hash
  )
  SELECT
    v_run_id,source_listing.id,entries.source_id,entries.position,
    (entries.listing_value ->> 'currentPrice')::integer,
    (entries.listing_value ->> 'originalPrice')::integer,
    entries.listing_value ->> 'availability',
    entries.listing_value ->> 'condition',
    keyword_listing.first_seen_run_id=v_run_id,
    v_searched_at,
    md5(entries.listing_value::text)
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
    observed_at=EXCLUDED.observed_at,
    payload_hash=EXCLUDED.payload_hash;

  UPDATE radar_analytics.listing_observations AS observation
  SET is_new_for_query=(observation.run_id=keyword_listing.first_seen_run_id)
  FROM radar_analytics.keyword_listings AS keyword_listing,
       radar_analytics.search_runs AS observation_run
  WHERE observation.source_listing_id=keyword_listing.source_listing_id
    AND observation_run.id=observation.run_id
    AND observation_run.query_key=keyword_listing.query_key
    AND keyword_listing.query_key=v_query_key
    AND observation.is_new_for_query IS DISTINCT FROM (observation.run_id=keyword_listing.first_seen_run_id);

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


--
-- Name: ingest_search_run_v2(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_search_run_v2(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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

  -- 商品内容按内容指纹只存一份；观测行只记 payload_hash（ingest_search_run 插入时写好）。
  INSERT INTO radar_analytics.listing_payloads(payload_hash, payload)
  SELECT DISTINCT ON (md5(listing_value::text)) md5(listing_value::text), listing_value
  FROM jsonb_array_elements(COALESCE(p_payload -> 'groups', '[]'::jsonb)) AS groups(group_value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(group_value -> 'listings', '[]'::jsonb)) AS listings(listing_value)
  WHERE group_value ->> 'status' IN ('success', 'empty')
    AND jsonb_typeof(listing_value) = 'object'
  ON CONFLICT (payload_hash) DO NOTHING;
END
$$;


--
-- Name: ingest_search_run_v3(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_search_run_v3(p_payload jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
DECLARE
  v_run_id uuid := (p_payload ->> 'id')::uuid;
  v_scope jsonb := p_payload -> 'scopeVersion';
  v_scope_id text;
  group_value jsonb;
  health jsonb;
  group_status text;
BEGIN
  PERFORM radar_analytics.ingest_search_run_v2(p_payload);

  IF p_payload ->> 'origin' = 'watch_keyword' THEN
    UPDATE radar_analytics.search_runs
    SET subscription_key=p_payload ->> 'subscriptionKey',
        subscription_name=p_payload ->> 'subscriptionName',
        binding_id=p_payload ->> 'bindingId'
    WHERE id=v_run_id;
  END IF;

  IF v_scope IS NOT NULL THEN
    v_scope_id := v_scope ->> 'id';
    IF v_scope_id IS NULL OR v_scope ->> 'subscriptionKey' IS DISTINCT FROM p_payload ->> 'subscriptionKey' THEN
      RAISE EXCEPTION 'market scope identity does not match search run';
    END IF;
    INSERT INTO radar_analytics.market_scope_versions(
      id,subscription_key,subscription_name,query,version,scope_hash,definition,created_at
    ) VALUES (
      v_scope_id,v_scope ->> 'subscriptionKey',p_payload ->> 'subscriptionName',p_payload ->> 'query',
      (v_scope ->> 'version')::integer,v_scope ->> 'scopeHash',v_scope -> 'definition',
      (v_scope ->> 'createdAt')::timestamptz
    )
    ON CONFLICT (id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM radar_analytics.market_scope_versions scope
      WHERE scope.id=v_scope_id
        AND scope.subscription_key=v_scope ->> 'subscriptionKey'
        AND scope.version=(v_scope ->> 'version')::integer
        AND scope.scope_hash=v_scope ->> 'scopeHash'
        AND scope.definition=v_scope -> 'definition'
    ) THEN
      RAISE EXCEPTION 'market scope version conflicts with stored definition';
    END IF;
    UPDATE radar_analytics.search_runs SET scope_version_id=v_scope_id WHERE id=v_run_id;
  ELSE
    SELECT scope_version_id INTO v_scope_id FROM radar_analytics.search_runs WHERE id=v_run_id;
  END IF;

  FOR group_value IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload -> 'groups','[]'::jsonb))
  LOOP
    health := group_value -> 'health';
    group_status := group_value ->> 'status';
    INSERT INTO radar_analytics.source_health_snapshots(
      run_id,scope_version_id,subscription_key,source_id,observed_at,state,
      request_succeeded,parse_succeeded,coverage,raw_result_count,normalized_result_count,
      page_depth,cursor_termination_reason,response_content_hash,response_bytes,template_version,
      http_status,field_total,field_complete,captcha_detected,login_required,blocked_detected,
      abnormal_empty,freshness_sla_minutes,error_code,error_message
    ) VALUES (
      v_run_id,v_scope_id,p_payload ->> 'subscriptionKey',group_value ->> 'sourceId',
      (p_payload ->> 'searchedAt')::timestamptz,
      COALESCE(health ->> 'state',CASE group_status WHEN 'success' THEN 'healthy' WHEN 'empty' THEN 'empty'
        WHEN 'disabled' THEN 'disabled' WHEN 'cooldown' THEN 'cooldown' ELSE 'failed' END),
      COALESCE((health ->> 'requestSucceeded')::boolean,group_status IN ('success','empty')),
      COALESCE((health ->> 'parseSucceeded')::boolean,group_status IN ('success','empty')),
      NULLIF(group_value ->> 'coverage',''),
      COALESCE((health ->> 'rawResultCount')::integer,jsonb_array_length(COALESCE(group_value -> 'listings','[]'::jsonb))),
      COALESCE((health ->> 'normalizedResultCount')::integer,jsonb_array_length(COALESCE(group_value -> 'listings','[]'::jsonb))),
      COALESCE((health ->> 'pageDepth')::integer,CASE WHEN group_status IN ('success','empty') THEN 1 ELSE 0 END),
      COALESCE(NULLIF(health ->> 'cursorTerminationReason',''),'unknown'),
      NULLIF(health ->> 'responseContentHash',''),COALESCE((health ->> 'responseBytes')::integer,0),
      COALESCE(NULLIF(health ->> 'templateVersion',''),NULLIF(group_value ->> 'parserVersion','')),
      (health ->> 'httpStatus')::integer,COALESCE((health ->> 'fieldTotal')::integer,0),
      COALESCE((health ->> 'fieldComplete')::integer,0),COALESCE((health ->> 'captchaDetected')::boolean,false),
      COALESCE((health ->> 'loginRequired')::boolean,false),COALESCE((health ->> 'blockedDetected')::boolean,false),
      COALESCE((health ->> 'abnormalEmpty')::boolean,false),COALESCE((health ->> 'freshnessSlaMinutes')::integer,1440),
      NULLIF(group_value ->> 'errorCode',''),NULLIF(group_value ->> 'error','')
    )
    ON CONFLICT (run_id,source_id) DO NOTHING;
  END LOOP;
END
$$;


--
-- Name: ingest_source_response_captures(jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.ingest_source_response_captures(p_payload jsonb) RETURNS void
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
  INSERT INTO radar_analytics.source_response_captures(
    capture_id,run_id,source_id,ordinal,request_url,response_url,request_method,
    response_status,content_type,payload_kind,raw_payload,payload_bytes,content_hash,
    captured_at,duration_ms,truncated,error_message
  )
  SELECT
    capture_value ->> 'id',
    (p_payload ->> 'id')::uuid,
    capture_value ->> 'sourceId',
    (capture_value ->> 'ordinal')::integer,
    capture_value ->> 'requestUrl',
    NULLIF(capture_value ->> 'responseUrl',''),
    capture_value ->> 'requestMethod',
    (capture_value ->> 'responseStatus')::integer,
    NULLIF(capture_value ->> 'contentType',''),
    capture_value ->> 'payloadKind',
    CASE
      WHEN capture_value ->> 'payloadKind' = 'html' THEN NULL
      ELSE capture_value ->> 'rawPayload'
    END,
    COALESCE((capture_value ->> 'payloadBytes')::bigint,0),
    capture_value ->> 'contentHash',
    (capture_value ->> 'capturedAt')::timestamptz,
    COALESCE((capture_value ->> 'durationMs')::integer,0),
    COALESCE((capture_value ->> 'truncated')::boolean,false),
    NULLIF(capture_value ->> 'error','')
  FROM jsonb_array_elements(COALESCE(p_payload -> 'captures','[]'::jsonb)) AS captures(capture_value)
  ON CONFLICT (capture_id) DO NOTHING
$$;


--
-- Name: link_source_listing_product(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.link_source_listing_product() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: preserve_source_listing_evidence(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.preserve_source_listing_evidence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: refresh_observation_new_count(); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.refresh_observation_new_count() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
BEGIN
  UPDATE radar_analytics.search_run_sources AS source_run
  SET new_count=(
    SELECT count(*)::integer
    FROM radar_analytics.listing_observations AS observation
    WHERE observation.run_id=NEW.run_id
      AND observation.source_id=NEW.source_id
      AND observation.is_new_for_query
  )
  WHERE source_run.run_id=NEW.run_id AND source_run.source_id=NEW.source_id;
  RETURN NEW;
END
$$;


--
-- Name: resolve_product_identity(text, text, text, jsonb, jsonb); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.resolve_product_identity(p_source_id text, p_source_item_id text, p_title text, p_facts jsonb, p_raw_metadata jsonb) RETURNS TABLE(product_key text, match_method text)
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $_$
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
$_$;


--
-- Name: search_historical_product_listings(text[], text[], integer); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.search_historical_product_listings(p_source_ids text[], p_terms text[], p_limit integer DEFAULT 30) RETURNS TABLE(source_id text, source_item_id text, identity_scope text, canonical_url text, title text, description_excerpt text, image_url text, seller_name text, shop_name text, currency text, current_price_jpy integer, original_price_jpy integer, price_basis text, item_condition text, availability text, facts jsonb, raw_metadata jsonb, first_seen_at timestamp with time zone, last_seen_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


--
-- Name: upsert_source_listing(jsonb, timestamp with time zone); Type: FUNCTION; Schema: radar_analytics; Owner: -
--

CREATE FUNCTION radar_analytics.upsert_source_listing(p_listing jsonb, p_seen_at timestamp with time zone) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'radar_analytics'
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_enrichments; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.ai_enrichments (
    id bigint NOT NULL,
    source_listing_id bigint,
    catalog_product_id bigint,
    purpose text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    output jsonb NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text DEFAULT 'unknown'::text NOT NULL,
    input_hash text NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    batch_id text,
    CONSTRAINT ai_enrichments_check CHECK (((source_listing_id IS NOT NULL) <> (catalog_product_id IS NOT NULL))),
    CONSTRAINT ai_enrichments_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT ai_enrichments_evidence_object CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT ai_enrichments_input_object CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT ai_enrichments_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT ai_enrichments_output_object CHECK ((jsonb_typeof(output) = 'object'::text))
);


--
-- Name: ai_enrichments_id_seq; Type: SEQUENCE; Schema: radar_analytics; Owner: -
--

ALTER TABLE radar_analytics.ai_enrichments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME radar_analytics.ai_enrichments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_processing_batches; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.ai_processing_batches (
    batch_id text NOT NULL,
    purpose text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    input_hash text NOT NULL,
    input jsonb NOT NULL,
    raw_response text NOT NULL,
    status text NOT NULL,
    parsed_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT ai_processing_batches_input_check CHECK ((jsonb_typeof(input) = 'object'::text)),
    CONSTRAINT ai_processing_batches_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT ai_processing_batches_parsed_count_check CHECK ((parsed_count >= 0)),
    CONSTRAINT ai_processing_batches_status_check CHECK ((status = ANY (ARRAY['parsed'::text, 'partial'::text, 'unparsed'::text])))
);

COMMENT ON TABLE radar_analytics.ai_processing_batches IS
  'Immutable provider-response evidence. batch_id identifies one semantic request plus raw provider response; multiple responses for the same semantic input are expected.';


--
-- Name: canonical_products; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.canonical_products (
    id text NOT NULL,
    identity_hash text NOT NULL,
    identity_version text NOT NULL,
    canonical_name text NOT NULL,
    work_title text,
    character_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    product_type text,
    manufacturer text,
    series text,
    target_fingerprint jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT canonical_products_canonical_name_check CHECK ((btrim(canonical_name) <> ''::text)),
    CONSTRAINT canonical_products_character_names_check CHECK ((jsonb_typeof(character_names) = 'array'::text)),
    CONSTRAINT canonical_products_id_check CHECK ((id ~ '^cp_[0-9a-f]{24}$'::text)),
    CONSTRAINT canonical_products_identity_hash_check CHECK ((identity_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT canonical_products_target_fingerprint_check CHECK ((jsonb_typeof(target_fingerprint) = 'object'::text))
);


--
-- Name: catalog_products; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.catalog_products (
    id bigint NOT NULL,
    canonical_title text NOT NULL,
    identifiers jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    product_key text NOT NULL,
    identity_method text NOT NULL,
    CONSTRAINT catalog_products_identifiers_check CHECK ((jsonb_typeof(identifiers) = 'object'::text)),
    CONSTRAINT catalog_products_identity_method_check CHECK ((identity_method = ANY (ARRAY['identifier'::text, 'exact_title'::text, 'listing_identity'::text])))
);


--
-- Name: catalog_products_id_seq; Type: SEQUENCE; Schema: radar_analytics; Owner: -
--

ALTER TABLE radar_analytics.catalog_products ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME radar_analytics.catalog_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comparison_profiles; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.comparison_profiles (
    id text NOT NULL,
    product_variant_id text NOT NULL,
    profile_version integer NOT NULL,
    rule_version text NOT NULL,
    name text NOT NULL,
    condition_policy text NOT NULL,
    allowed_conditions jsonb NOT NULL,
    allowed_completeness jsonb NOT NULL,
    allowed_price_bases jsonb NOT NULL,
    allowed_official_statuses jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT comparison_profiles_allowed_completeness_check CHECK ((jsonb_typeof(allowed_completeness) = 'array'::text)),
    CONSTRAINT comparison_profiles_allowed_conditions_check CHECK ((jsonb_typeof(allowed_conditions) = 'array'::text)),
    CONSTRAINT comparison_profiles_allowed_official_statuses_check CHECK ((jsonb_typeof(allowed_official_statuses) = 'array'::text)),
    CONSTRAINT comparison_profiles_allowed_price_bases_check CHECK ((jsonb_typeof(allowed_price_bases) = 'array'::text)),
    CONSTRAINT comparison_profiles_condition_policy_check CHECK ((condition_policy = ANY (ARRAY['strict_same_condition'::text, 'broad_public_asking_price'::text]))),
    CONSTRAINT comparison_profiles_id_check CHECK ((id ~ '^cmp_[0-9a-f]{24}_v[0-9]+$'::text)),
    CONSTRAINT comparison_profiles_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT comparison_profiles_profile_version_check CHECK ((profile_version > 0))
);


--
-- Name: product_listing_memberships; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.product_listing_memberships (
    id text NOT NULL,
    product_variant_id text NOT NULL,
    source_listing_id bigint NOT NULL,
    search_run_id uuid,
    workflow_task_id text NOT NULL,
    decision text NOT NULL,
    decision_source text NOT NULL,
    relation text NOT NULL,
    confidence text NOT NULL,
    membership_version text NOT NULL,
    evidence jsonb NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    is_current boolean DEFAULT true NOT NULL,
    supersedes_membership_id text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT product_listing_memberships_check CHECK (((is_current AND (valid_to IS NULL)) OR ((NOT is_current) AND (valid_to IS NOT NULL)))),
    CONSTRAINT product_listing_memberships_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT product_listing_memberships_decision_check CHECK ((decision = ANY (ARRAY['confirmed'::text, 'rejected'::text, 'uncertain'::text]))),
    CONSTRAINT product_listing_memberships_decision_source_check CHECK ((decision_source = ANY (ARRAY['workflow_matcher'::text, 'workflow_ai'::text, 'human'::text]))),
    CONSTRAINT product_listing_memberships_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT product_listing_memberships_id_check CHECK ((id ~ '^pm_[0-9a-f]{32}$'::text)),
    CONSTRAINT product_listing_memberships_relation_check CHECK ((relation = ANY (ARRAY['exact'::text, 'probable_exact'::text, 'variant'::text, 'bundle'::text, 'related'::text, 'irrelevant'::text, 'uncertain'::text])))
);


--
-- Name: current_product_listing_memberships; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.current_product_listing_memberships WITH (security_invoker='true') AS
 SELECT id,
    product_variant_id,
    source_listing_id,
    search_run_id,
    workflow_task_id,
    decision,
    decision_source,
    relation,
    confidence,
    membership_version,
    evidence,
    valid_from,
    valid_to,
    is_current,
    supersedes_membership_id,
    created_at
   FROM radar_analytics.product_listing_memberships membership
  WHERE is_current;


--
-- Name: search_run_sources; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.search_run_sources (
    run_id uuid NOT NULL,
    source_id text NOT NULL,
    status text NOT NULL,
    coverage text,
    result_count integer DEFAULT 0 NOT NULL,
    new_count integer DEFAULT 0 NOT NULL,
    left_count integer DEFAULT 0 NOT NULL,
    available_count integer DEFAULT 0 NOT NULL,
    min_price_jpy integer,
    max_price_jpy integer,
    average_price_jpy numeric(12,2),
    parser_version text,
    request_route text,
    duration_ms integer,
    CONSTRAINT search_run_sources_available_count_check CHECK ((available_count >= 0)),
    CONSTRAINT search_run_sources_duration_ms_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT search_run_sources_left_count_check CHECK ((left_count >= 0)),
    CONSTRAINT search_run_sources_new_count_check CHECK ((new_count >= 0)),
    CONSTRAINT search_run_sources_result_count_check CHECK ((result_count >= 0)),
    CONSTRAINT search_run_sources_status_check CHECK ((status = ANY (ARRAY['success'::text, 'empty'::text, 'failed'::text, 'disabled'::text, 'cooldown'::text])))
);


--
-- Name: search_runs; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.search_runs (
    id uuid NOT NULL,
    origin text NOT NULL,
    query text NOT NULL,
    query_key text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    result_count integer DEFAULT 0 NOT NULL,
    searched_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    subscription_key text,
    subscription_name text,
    binding_id text,
    scope_version_id text,
    CONSTRAINT search_runs_filters_check CHECK ((jsonb_typeof(filters) = 'object'::text)),
    CONSTRAINT search_runs_origin_check CHECK ((origin = ANY (ARRAY['manual_search'::text, 'watch_keyword'::text, 'watch_item'::text]))),
    CONSTRAINT search_runs_result_count_check CHECK ((result_count >= 0)),
    CONSTRAINT search_runs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'partial'::text, 'empty'::text, 'failed'::text])))
);


--
-- Name: keyword_daily_metrics; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.keyword_daily_metrics WITH (security_invoker='true') AS
 WITH source_runs AS (
         SELECT run.id AS run_id,
            (timezone('Asia/Tokyo'::text, run.searched_at))::date AS day,
            run.query,
            run.query_key,
            run.searched_at,
            source.source_id,
            source.result_count,
            source.new_count,
            source.left_count
           FROM (radar_analytics.search_runs run
             JOIN radar_analytics.search_run_sources source ON ((source.run_id = run.id)))
          WHERE (source.status = ANY (ARRAY['success'::text, 'empty'::text]))
        ), latest_source_windows AS (
         SELECT DISTINCT ON (source_runs.day, source_runs.query_key, source_runs.source_id) source_runs.day,
            source_runs.query,
            source_runs.query_key,
            source_runs.source_id,
            source_runs.result_count
           FROM source_runs
          ORDER BY source_runs.day, source_runs.query_key, source_runs.source_id, source_runs.searched_at DESC, source_runs.run_id DESC
        ), daily_visible AS (
         SELECT latest_source_windows.day,
            max(latest_source_windows.query) AS query,
            latest_source_windows.query_key,
            (sum(latest_source_windows.result_count))::integer AS visible_count
           FROM latest_source_windows
          GROUP BY latest_source_windows.day, latest_source_windows.query_key
        ), daily_movement AS (
         SELECT source_runs.day,
            source_runs.query_key,
            (sum(source_runs.new_count))::integer AS new_count,
            (sum(source_runs.left_count))::integer AS left_visible_window,
            (count(DISTINCT source_runs.run_id))::integer AS run_count
           FROM source_runs
          GROUP BY source_runs.day, source_runs.query_key
        )
 SELECT visible.day,
    visible.query,
    visible.query_key,
    visible.visible_count,
    movement.new_count,
    movement.left_visible_window,
    movement.run_count
   FROM (daily_visible visible
     JOIN daily_movement movement USING (day, query_key));


--
-- Name: keyword_listings; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.keyword_listings (
    query_key text NOT NULL,
    source_listing_id bigint NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    first_seen_run_id uuid NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    last_seen_run_id uuid NOT NULL,
    latest_evaluated_at timestamp with time zone NOT NULL,
    last_left_run_id uuid,
    appearances integer DEFAULT 1 NOT NULL,
    active_visible boolean DEFAULT true NOT NULL,
    CONSTRAINT keyword_listings_appearances_check CHECK ((appearances >= 1))
);


--
-- Name: source_listings; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.source_listings (
    id bigint NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    identity_scope text NOT NULL,
    canonical_url text NOT NULL,
    title text NOT NULL,
    description_excerpt text,
    image_url text,
    seller_name text,
    shop_name text,
    currency text DEFAULT 'JPY'::text NOT NULL,
    current_price_jpy integer,
    original_price_jpy integer,
    price_basis text NOT NULL,
    item_condition text NOT NULL,
    availability text NOT NULL,
    facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    last_changed_at timestamp with time zone NOT NULL,
    product_key text NOT NULL,
    product_match_method text NOT NULL,
    source_listed_at text,
    source_updated_at text,
    price_status text DEFAULT 'missing'::text NOT NULL,
    CONSTRAINT source_listings_facts_check CHECK ((jsonb_typeof(facts) = 'object'::text)),
    CONSTRAINT source_listings_price_status_check CHECK ((price_status = ANY (ARRAY['valid'::text, 'missing'::text, 'invalid'::text]))),
    CONSTRAINT source_listings_product_match_method_check CHECK ((product_match_method = ANY (ARRAY['identifier'::text, 'exact_title'::text, 'listing_identity'::text]))),
    CONSTRAINT source_listings_raw_metadata_check CHECK ((jsonb_typeof(raw_metadata) = 'object'::text))
);


--
-- Name: latest_cleaned_listings; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.latest_cleaned_listings WITH (security_invoker='true') AS
 SELECT listing.id AS source_listing_id,
    listing.source_id,
    listing.source_item_id,
    listing.canonical_url,
    listing.title AS source_title,
        CASE
            WHEN ((listing.current_price_jpy > 0) AND (listing.current_price_jpy <= 1000000000)) THEN listing.current_price_jpy
            ELSE NULL::integer
        END AS cleaned_price_jpy,
        CASE
            WHEN (listing.current_price_jpy IS NULL) THEN 'missing'::text
            WHEN ((listing.current_price_jpy <= 0) OR (listing.current_price_jpy > 1000000000)) THEN 'invalid'::text
            ELSE 'valid'::text
        END AS price_status,
    listing.availability,
    listing.first_seen_at,
    listing.last_seen_at,
    jsonb_strip_nulls(jsonb_build_object('title', COALESCE((enrichment.output ->> 'translatedTitle'::text), listing.title), 'summary', (enrichment.output ->> 'summary'::text), 'relevance', COALESCE((enrichment.output ->> 'relevance'::text), 'uncertain'::text), 'relevanceReason', (enrichment.output ->> 'relevanceReason'::text), 'category', (enrichment.output ->> 'normalizedCategory'::text), 'productType', (enrichment.output ->> 'productType'::text), 'workTitle', (enrichment.output ->> 'workTitle'::text), 'series', (enrichment.output ->> 'series'::text), 'characters', (enrichment.output -> 'characters'::text), 'officialStatus', (enrichment.output ->> 'officialStatus'::text), 'condition', COALESCE((enrichment.output ->> 'normalizedCondition'::text), listing.item_condition), 'conditionNotes', (enrichment.output -> 'conditionNotes'::text), 'defects', (enrichment.output -> 'defects'::text), 'missingParts', (enrichment.output -> 'missingParts'::text), 'includedItems', (enrichment.output -> 'includedItems'::text), 'editionOrModel', (enrichment.output ->> 'editionOrModel'::text))) AS cleaned_core,
    jsonb_build_object('sourceFacts', listing.facts, 'sourceMetadata', listing.raw_metadata, 'aiExtraInfo', COALESCE((enrichment.output -> 'extraInfo'::text), '{}'::jsonb)) AS extra_info,
    enrichment.provider AS ai_provider,
    enrichment.model AS ai_model,
    enrichment.prompt_version AS ai_prompt_version,
    enrichment.created_at AS ai_cleaned_at
   FROM (radar_analytics.source_listings listing
     LEFT JOIN LATERAL ( SELECT ai.output,
            ai.provider,
            ai.model,
            ai.prompt_version,
            ai.created_at
           FROM radar_analytics.ai_enrichments ai
          WHERE ((ai.source_listing_id = listing.id) AND (ai.purpose = 'listing_semantics'::text))
          ORDER BY ai.created_at DESC, ai.id DESC
         LIMIT 1) enrichment ON (true));


--
-- Name: listing_observations; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.listing_observations (
    run_id uuid NOT NULL,
    source_listing_id bigint NOT NULL,
    source_id text NOT NULL,
    "position" integer NOT NULL,
    price_jpy integer,
    original_price_jpy integer,
    availability text NOT NULL,
    item_condition text NOT NULL,
    is_new_for_query boolean DEFAULT false NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    price_basis text DEFAULT 'listing_price'::text NOT NULL,
    listing_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_hash text,
    price_status text DEFAULT 'missing'::text NOT NULL,
    CONSTRAINT listing_observations_listing_payload_check CHECK ((jsonb_typeof(listing_payload) = 'object'::text)),
    CONSTRAINT listing_observations_position_check CHECK (("position" > 0)),
    CONSTRAINT listing_observations_price_basis_check CHECK ((price_basis = ANY (ARRAY['listing_price'::text, 'catalog_price'::text, 'offer_price'::text, 'auction_current_bid'::text]))),
    CONSTRAINT listing_observations_price_status_check CHECK ((price_status = ANY (ARRAY['valid'::text, 'missing'::text, 'invalid'::text])))
);


--
-- Name: listing_payloads; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.listing_payloads (
    payload_hash text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT listing_payloads_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT listing_payloads_pkey PRIMARY KEY (payload_hash)
);

COMMENT ON TABLE radar_analytics.listing_payloads IS '搜索结果里商品的整理后内容，按 md5(payload::text) 只存一份。listing_observations.payload_hash 指向这里';

GRANT SELECT,INSERT ON TABLE radar_analytics.listing_payloads TO radar_analytics_runtime;


--
-- Name: market_scope_versions; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.market_scope_versions (
    id text NOT NULL,
    subscription_key text NOT NULL,
    subscription_name text NOT NULL,
    query text NOT NULL,
    version integer NOT NULL,
    scope_hash text NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT market_scope_versions_definition_check CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT market_scope_versions_version_check CHECK ((version >= 0))
);


--
-- Name: source_health_snapshots; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.source_health_snapshots (
    run_id uuid NOT NULL,
    scope_version_id text,
    subscription_key text,
    source_id text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    request_succeeded boolean NOT NULL,
    parse_succeeded boolean NOT NULL,
    coverage text,
    raw_result_count integer DEFAULT 0 NOT NULL,
    normalized_result_count integer DEFAULT 0 NOT NULL,
    page_depth integer DEFAULT 0 NOT NULL,
    cursor_termination_reason text DEFAULT 'unknown'::text NOT NULL,
    response_content_hash text,
    response_bytes integer DEFAULT 0 NOT NULL,
    template_version text,
    http_status integer,
    field_total integer DEFAULT 0 NOT NULL,
    field_complete integer DEFAULT 0 NOT NULL,
    captcha_detected boolean DEFAULT false NOT NULL,
    login_required boolean DEFAULT false NOT NULL,
    blocked_detected boolean DEFAULT false NOT NULL,
    abnormal_empty boolean DEFAULT false NOT NULL,
    freshness_sla_minutes integer NOT NULL,
    error_code text,
    error_message text,
    CONSTRAINT source_health_snapshots_cursor_termination_reason_check CHECK ((cursor_termination_reason = ANY (ARRAY['exhausted'::text, 'budget_reached'::text, 'not_applicable'::text, 'unknown'::text]))),
    CONSTRAINT source_health_snapshots_field_complete_check CHECK ((field_complete >= 0)),
    CONSTRAINT source_health_snapshots_field_total_check CHECK ((field_total >= 0)),
    CONSTRAINT source_health_snapshots_freshness_sla_minutes_check CHECK ((freshness_sla_minutes > 0)),
    CONSTRAINT source_health_snapshots_normalized_result_count_check CHECK ((normalized_result_count >= 0)),
    CONSTRAINT source_health_snapshots_page_depth_check CHECK ((page_depth >= 0)),
    CONSTRAINT source_health_snapshots_raw_result_count_check CHECK ((raw_result_count >= 0)),
    CONSTRAINT source_health_snapshots_response_bytes_check CHECK ((response_bytes >= 0)),
    CONSTRAINT source_health_snapshots_state_check CHECK ((state = ANY (ARRAY['healthy'::text, 'empty'::text, 'suspected_degradation'::text, 'failed'::text, 'disabled'::text, 'cooldown'::text])))
);


--
-- Name: market_scope_daily_source_metrics; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.market_scope_daily_source_metrics WITH (security_invoker='true') AS
 WITH scope_bounds AS (
         SELECT scope.id AS scope_version_id,
            min((timezone('Asia/Tokyo'::text, run.searched_at))::date) AS first_day,
                CASE
                    WHEN (NOT (EXISTS ( SELECT 1
                       FROM radar_analytics.market_scope_versions newer
                      WHERE ((newer.subscription_key = scope.subscription_key) AND (newer.version > scope.version))))) THEN (timezone('Asia/Tokyo'::text, now()))::date
                    ELSE max((timezone('Asia/Tokyo'::text, run.searched_at))::date)
                END AS last_day
           FROM (radar_analytics.market_scope_versions scope
             JOIN radar_analytics.search_runs run ON ((run.scope_version_id = scope.id)))
          WHERE ((run.origin = 'watch_keyword'::text) AND (run.subscription_key IS NOT NULL))
          GROUP BY scope.id, scope.subscription_key, scope.version
        ), scope_days AS (
         SELECT (generate_series((bound.first_day)::timestamp with time zone, (bound.last_day)::timestamp with time zone, '1 day'::interval))::date AS day,
            bound.scope_version_id
           FROM scope_bounds bound
        ), expected_sources AS (
         SELECT scope.id AS scope_version_id,
            scope.subscription_key,
            scope.subscription_name,
            scope.query,
            scope.version AS scope_version,
            (source.value ->> 'sourceId'::text) AS source_id
           FROM (radar_analytics.market_scope_versions scope
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE((scope.definition -> 'sources'::text), '[]'::jsonb)) source(value))
        ), day_sources AS (
         SELECT day.day,
            source.scope_version_id,
            source.subscription_key,
            source.subscription_name,
            source.query,
            source.scope_version,
            source.source_id,
            LEAST(now(), (((day.day + 1))::timestamp without time zone AT TIME ZONE 'Asia/Tokyo'::text)) AS evaluated_at
           FROM (scope_days day
             JOIN expected_sources source USING (scope_version_id))
        ), source_evidence AS (
         SELECT day_source.day,
            day_source.scope_version_id,
            day_source.subscription_key,
            day_source.subscription_name,
            day_source.query,
            day_source.scope_version,
            day_source.source_id,
            day_source.evaluated_at,
            health.observed_at AS health_observed_at,
            health.state,
            health.request_succeeded,
            health.parse_succeeded,
            health.abnormal_empty,
            health.freshness_sla_minutes,
            valid_window.run_id AS window_run_id,
            valid_window.result_count,
            valid_window.successful_window_count,
            movement.new_count,
            movement.left_visible_window,
            movement.run_count,
            distribution.available_count,
            distribution.sold_out_count,
            distribution.priced_count,
            distribution.min_price_jpy,
            distribution.median_price_jpy,
            distribution.average_price_jpy,
            distribution.max_price_jpy,
            ((health.observed_at IS NOT NULL) AND ((day_source.evaluated_at - health.observed_at) <= ((health.freshness_sla_minutes)::double precision * '00:01:00'::interval))) AS is_fresh
           FROM ((((day_sources day_source
             LEFT JOIN LATERAL ( SELECT snapshot.run_id,
                    snapshot.scope_version_id,
                    snapshot.subscription_key,
                    snapshot.source_id,
                    snapshot.observed_at,
                    snapshot.state,
                    snapshot.request_succeeded,
                    snapshot.parse_succeeded,
                    snapshot.coverage,
                    snapshot.raw_result_count,
                    snapshot.normalized_result_count,
                    snapshot.page_depth,
                    snapshot.cursor_termination_reason,
                    snapshot.response_content_hash,
                    snapshot.response_bytes,
                    snapshot.template_version,
                    snapshot.http_status,
                    snapshot.field_total,
                    snapshot.field_complete,
                    snapshot.captcha_detected,
                    snapshot.login_required,
                    snapshot.blocked_detected,
                    snapshot.abnormal_empty,
                    snapshot.freshness_sla_minutes,
                    snapshot.error_code,
                    snapshot.error_message
                   FROM radar_analytics.source_health_snapshots snapshot
                  WHERE ((snapshot.scope_version_id = day_source.scope_version_id) AND (snapshot.source_id = day_source.source_id) AND (snapshot.observed_at <= day_source.evaluated_at))
                  ORDER BY snapshot.observed_at DESC, snapshot.run_id DESC
                 LIMIT 1) health ON (true))
             LEFT JOIN LATERAL ( SELECT run.id AS run_id,
                    source.result_count,
                    (count(*) OVER ())::integer AS successful_window_count
                   FROM (radar_analytics.search_runs run
                     JOIN radar_analytics.search_run_sources source ON ((source.run_id = run.id)))
                  WHERE ((run.scope_version_id = day_source.scope_version_id) AND (source.source_id = day_source.source_id) AND (source.status = ANY (ARRAY['success'::text, 'empty'::text])) AND (run.searched_at <= day_source.evaluated_at))
                  ORDER BY run.searched_at DESC, run.id DESC
                 LIMIT 1) valid_window ON (true))
             LEFT JOIN LATERAL ( SELECT (COALESCE(sum(source.new_count), (0)::bigint))::integer AS new_count,
                    (COALESCE(sum(source.left_count), (0)::bigint))::integer AS left_visible_window,
                    (count(*))::integer AS run_count
                   FROM (radar_analytics.search_runs run
                     JOIN radar_analytics.search_run_sources source ON ((source.run_id = run.id)))
                  WHERE ((run.scope_version_id = day_source.scope_version_id) AND (source.source_id = day_source.source_id) AND ((timezone('Asia/Tokyo'::text, run.searched_at))::date = day_source.day) AND (source.status = ANY (ARRAY['success'::text, 'empty'::text])))) movement ON (true))
             LEFT JOIN LATERAL ( SELECT (count(*) FILTER (WHERE (observation.availability = ANY (ARRAY['available'::text, 'preorder'::text, 'backorder'::text]))))::integer AS available_count,
                    (count(*) FILTER (WHERE (observation.availability = 'sold_out'::text)))::integer AS sold_out_count,
                    (count(observation.price_jpy))::integer AS priced_count,
                    min(observation.price_jpy) AS min_price_jpy,
                    (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((observation.price_jpy)::double precision)))::integer AS median_price_jpy,
                    round(avg(observation.price_jpy), 2) AS average_price_jpy,
                    max(observation.price_jpy) AS max_price_jpy
                   FROM radar_analytics.listing_observations observation
                  WHERE ((observation.run_id = valid_window.run_id) AND (observation.source_id = day_source.source_id))) distribution ON (true))
        )
 SELECT day,
    scope_version_id,
    scope_version,
    subscription_key,
    subscription_name,
    query,
    source_id,
    window_run_id,
    COALESCE(result_count, 0) AS visible_count,
    COALESCE(new_count, 0) AS new_count,
    COALESCE(left_visible_window, 0) AS left_visible_window,
    COALESCE(run_count, 0) AS run_count,
        CASE
            WHEN (is_fresh AND (state = ANY (ARRAY['healthy'::text, 'empty'::text]))) THEN 1
            ELSE 0
        END AS source_count,
    COALESCE(available_count, 0) AS available_count,
    COALESCE(sold_out_count, 0) AS sold_out_count,
    COALESCE(priced_count, 0) AS priced_count,
    min_price_jpy,
    median_price_jpy,
    average_price_jpy,
    max_price_jpy,
    1 AS expected_source_count,
        CASE
            WHEN (is_fresh AND (state = ANY (ARRAY['healthy'::text, 'empty'::text]))) THEN 1
            ELSE 0
        END AS successful_source_count,
        CASE
            WHEN (state = ANY (ARRAY['failed'::text, 'suspected_degradation'::text, 'disabled'::text, 'cooldown'::text])) THEN 1
            ELSE 0
        END AS failed_source_count,
        CASE
            WHEN (NOT COALESCE(is_fresh, false)) THEN 1
            ELSE 0
        END AS stale_source_count,
        CASE
            WHEN (is_fresh AND (state = ANY (ARRAY['healthy'::text, 'empty'::text]))) THEN 1.0
            ELSE 0.0
        END AS coverage_rate,
    ((COALESCE(successful_window_count, 0) < 2) OR (window_run_id IS NULL)) AS warmup,
        CASE
            WHEN ((COALESCE(successful_window_count, 0) < 2) OR (window_run_id IS NULL) OR (NOT COALESCE(is_fresh, false)) OR (state <> ALL (ARRAY['healthy'::text, 'empty'::text]))) THEN 'D'::text
            ELSE 'A'::text
        END AS quality_grade,
    ((COALESCE(successful_window_count, 0) >= 2) AND (window_run_id IS NOT NULL) AND COALESCE(is_fresh, false) AND (state = ANY (ARRAY['healthy'::text, 'empty'::text]))) AS interpretable,
    COALESCE(state, 'failed'::text) AS latest_state,
    health_observed_at,
    freshness_sla_minutes,
    COALESCE(request_succeeded, false) AS request_succeeded,
    COALESCE(parse_succeeded, false) AS parse_succeeded,
    COALESCE(abnormal_empty, false) AS abnormal_empty
   FROM source_evidence;


--
-- Name: market_scope_daily_metrics; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.market_scope_daily_metrics WITH (security_invoker='true') AS
 WITH totals AS (
         SELECT source.day,
            source.scope_version_id,
            max(source.scope_version) AS scope_version,
            source.subscription_key,
            max(source.subscription_name) AS subscription_name,
            max(source.query) AS query,
            (sum(source.visible_count))::integer AS visible_count,
            (sum(source.new_count))::integer AS new_count,
            (sum(source.left_visible_window))::integer AS left_visible_window,
            (sum(source.run_count))::integer AS run_count,
            (sum(source.successful_source_count))::integer AS source_count,
            (count(*))::integer AS expected_source_count,
            (sum(source.successful_source_count))::integer AS successful_source_count,
            (sum(source.failed_source_count))::integer AS failed_source_count,
            (sum(source.stale_source_count))::integer AS stale_source_count,
            bool_or(source.warmup) AS warmup,
            bool_or(source.abnormal_empty) AS abnormal_empty
           FROM radar_analytics.market_scope_daily_source_metrics source
          GROUP BY source.day, source.scope_version_id, source.subscription_key
        ), distribution AS (
         SELECT source.day,
            source.scope_version_id,
            (count(*) FILTER (WHERE (observation.availability = ANY (ARRAY['available'::text, 'preorder'::text, 'backorder'::text]))))::integer AS available_count,
            (count(*) FILTER (WHERE (observation.availability = 'sold_out'::text)))::integer AS sold_out_count,
            (count(observation.price_jpy))::integer AS priced_count,
            min(observation.price_jpy) AS min_price_jpy,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((observation.price_jpy)::double precision)))::integer AS median_price_jpy,
            round(avg(observation.price_jpy), 2) AS average_price_jpy,
            max(observation.price_jpy) AS max_price_jpy
           FROM (radar_analytics.market_scope_daily_source_metrics source
             LEFT JOIN radar_analytics.listing_observations observation ON (((observation.run_id = source.window_run_id) AND (observation.source_id = source.source_id))))
          GROUP BY source.day, source.scope_version_id
        ), measured AS (
         SELECT totals.day,
            totals.scope_version_id,
            totals.scope_version,
            totals.subscription_key,
            totals.subscription_name,
            totals.query,
            totals.visible_count,
            totals.new_count,
            totals.left_visible_window,
            totals.run_count,
            totals.source_count,
            totals.expected_source_count,
            totals.successful_source_count,
            totals.failed_source_count,
            totals.stale_source_count,
            totals.warmup,
            totals.abnormal_empty,
            COALESCE(distribution.available_count, 0) AS available_count,
            COALESCE(distribution.sold_out_count, 0) AS sold_out_count,
            COALESCE(distribution.priced_count, 0) AS priced_count,
            distribution.min_price_jpy,
            distribution.median_price_jpy,
            distribution.average_price_jpy,
            distribution.max_price_jpy
           FROM (totals
             LEFT JOIN distribution USING (day, scope_version_id))
        ), graded AS (
         SELECT measured.day,
            measured.scope_version_id,
            measured.scope_version,
            measured.subscription_key,
            measured.subscription_name,
            measured.query,
            measured.visible_count,
            measured.new_count,
            measured.left_visible_window,
            measured.run_count,
            measured.source_count,
            measured.expected_source_count,
            measured.successful_source_count,
            measured.failed_source_count,
            measured.stale_source_count,
            measured.warmup,
            measured.abnormal_empty,
            measured.available_count,
            measured.sold_out_count,
            measured.priced_count,
            measured.min_price_jpy,
            measured.median_price_jpy,
            measured.average_price_jpy,
            measured.max_price_jpy,
            ((measured.successful_source_count)::numeric / (NULLIF(measured.expected_source_count, 0))::numeric) AS coverage_rate,
                CASE
                    WHEN (measured.warmup OR (measured.expected_source_count = 0) OR (((measured.successful_source_count)::numeric / (NULLIF(measured.expected_source_count, 0))::numeric) < 0.5)) THEN 'D'::text
                    WHEN ((((measured.successful_source_count)::numeric / (NULLIF(measured.expected_source_count, 0))::numeric) < 0.75) OR measured.abnormal_empty) THEN 'C'::text
                    WHEN ((measured.successful_source_count < measured.expected_source_count) OR (measured.failed_source_count > 0) OR (measured.stale_source_count > 0)) THEN 'B'::text
                    ELSE 'A'::text
                END AS quality_grade
           FROM measured
        )
 SELECT day,
    scope_version_id,
    scope_version,
    subscription_key,
    subscription_name,
    query,
    visible_count,
    new_count,
    left_visible_window,
    run_count,
    source_count,
    expected_source_count,
    successful_source_count,
    failed_source_count,
    stale_source_count,
    warmup,
    abnormal_empty,
    available_count,
    sold_out_count,
    priced_count,
    min_price_jpy,
    median_price_jpy,
    average_price_jpy,
    max_price_jpy,
    coverage_rate,
    quality_grade,
    ((quality_grade = ANY (ARRAY['A'::text, 'B'::text])) AND (NOT warmup)) AS interpretable
   FROM graded;


--
-- Name: market_subscription_daily_metrics; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.market_subscription_daily_metrics WITH (security_invoker='true') AS
 WITH source_runs AS (
         SELECT run.id AS run_id,
            (timezone('Asia/Tokyo'::text, run.searched_at))::date AS day,
            run.subscription_key,
            COALESCE(run.subscription_name, run.query) AS subscription_name,
            run.query,
            run.query_key,
            run.searched_at,
            source.source_id,
            source.result_count,
            source.new_count,
            source.left_count
           FROM (radar_analytics.search_runs run
             JOIN radar_analytics.search_run_sources source ON ((source.run_id = run.id)))
          WHERE ((run.origin = 'watch_keyword'::text) AND (run.subscription_key IS NOT NULL) AND (source.status = ANY (ARRAY['success'::text, 'empty'::text])))
        ), latest_source_windows AS (
         SELECT DISTINCT ON (source_runs.day, source_runs.subscription_key, source_runs.source_id) source_runs.run_id,
            source_runs.day,
            source_runs.subscription_key,
            source_runs.subscription_name,
            source_runs.query,
            source_runs.query_key,
            source_runs.source_id,
            source_runs.result_count
           FROM source_runs
          ORDER BY source_runs.day, source_runs.subscription_key, source_runs.source_id, source_runs.searched_at DESC, source_runs.run_id DESC
        ), daily_visible AS (
         SELECT latest_source_windows.day,
            latest_source_windows.subscription_key,
            max(latest_source_windows.subscription_name) AS subscription_name,
            max(latest_source_windows.query) AS query,
            max(latest_source_windows.query_key) AS query_key,
            (sum(latest_source_windows.result_count))::integer AS visible_count,
            (count(DISTINCT latest_source_windows.source_id))::integer AS source_count
           FROM latest_source_windows
          GROUP BY latest_source_windows.day, latest_source_windows.subscription_key
        ), daily_movement AS (
         SELECT source_runs.day,
            source_runs.subscription_key,
            (sum(source_runs.new_count))::integer AS new_count,
            (sum(source_runs.left_count))::integer AS left_visible_window,
            (count(DISTINCT source_runs.run_id))::integer AS run_count
           FROM source_runs
          GROUP BY source_runs.day, source_runs.subscription_key
        ), latest_observations AS (
         SELECT latest.day,
            latest.subscription_key,
            observation.price_jpy,
            observation.availability
           FROM (latest_source_windows latest
             JOIN radar_analytics.listing_observations observation ON (((observation.run_id = latest.run_id) AND (observation.source_id = latest.source_id))))
        ), daily_distribution AS (
         SELECT latest_observations.day,
            latest_observations.subscription_key,
            (count(*) FILTER (WHERE (latest_observations.availability = ANY (ARRAY['available'::text, 'preorder'::text, 'backorder'::text]))))::integer AS available_count,
            (count(*) FILTER (WHERE (latest_observations.availability = 'sold_out'::text)))::integer AS sold_out_count,
            (count(latest_observations.price_jpy))::integer AS priced_count,
            min(latest_observations.price_jpy) AS min_price_jpy,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((latest_observations.price_jpy)::double precision)))::integer AS median_price_jpy,
            round(avg(latest_observations.price_jpy), 2) AS average_price_jpy,
            max(latest_observations.price_jpy) AS max_price_jpy
           FROM latest_observations
          GROUP BY latest_observations.day, latest_observations.subscription_key
        )
 SELECT visible.day,
    visible.subscription_key,
    visible.subscription_name,
    visible.query,
    visible.query_key,
    visible.visible_count,
    visible.source_count,
    movement.new_count,
    movement.left_visible_window,
    movement.run_count,
    COALESCE(distribution.available_count, 0) AS available_count,
    COALESCE(distribution.sold_out_count, 0) AS sold_out_count,
    COALESCE(distribution.priced_count, 0) AS priced_count,
    distribution.min_price_jpy,
    distribution.median_price_jpy,
    distribution.average_price_jpy,
    distribution.max_price_jpy
   FROM ((daily_visible visible
     JOIN daily_movement movement USING (day, subscription_key))
     LEFT JOIN daily_distribution distribution USING (day, subscription_key));


--
-- Name: market_subscription_daily_source_metrics; Type: VIEW; Schema: radar_analytics; Owner: -
--

CREATE VIEW radar_analytics.market_subscription_daily_source_metrics WITH (security_invoker='true') AS
 WITH source_runs AS (
         SELECT run.id AS run_id,
            (timezone('Asia/Tokyo'::text, run.searched_at))::date AS day,
            run.subscription_key,
            COALESCE(run.subscription_name, run.query) AS subscription_name,
            run.query,
            run.query_key,
            run.searched_at,
            source.source_id,
            source.result_count,
            source.new_count,
            source.left_count
           FROM (radar_analytics.search_runs run
             JOIN radar_analytics.search_run_sources source ON ((source.run_id = run.id)))
          WHERE ((run.origin = 'watch_keyword'::text) AND (run.subscription_key IS NOT NULL) AND (source.status = ANY (ARRAY['success'::text, 'empty'::text])))
        ), latest_source_window AS (
         SELECT DISTINCT ON (source_runs.day, source_runs.subscription_key, source_runs.source_id) source_runs.run_id,
            source_runs.day,
            source_runs.subscription_key,
            source_runs.subscription_name,
            source_runs.query,
            source_runs.query_key,
            source_runs.source_id,
            source_runs.result_count
           FROM source_runs
          ORDER BY source_runs.day, source_runs.subscription_key, source_runs.source_id, source_runs.searched_at DESC, source_runs.run_id DESC
        ), daily_movement AS (
         SELECT source_runs.day,
            source_runs.subscription_key,
            source_runs.source_id,
            (sum(source_runs.new_count))::integer AS new_count,
            (sum(source_runs.left_count))::integer AS left_visible_window,
            (count(DISTINCT source_runs.run_id))::integer AS run_count
           FROM source_runs
          GROUP BY source_runs.day, source_runs.subscription_key, source_runs.source_id
        ), latest_observations AS (
         SELECT latest_1.day,
            latest_1.subscription_key,
            latest_1.source_id,
            observation.price_jpy,
            observation.availability
           FROM (latest_source_window latest_1
             JOIN radar_analytics.listing_observations observation ON (((observation.run_id = latest_1.run_id) AND (observation.source_id = latest_1.source_id))))
        ), daily_distribution AS (
         SELECT latest_observations.day,
            latest_observations.subscription_key,
            latest_observations.source_id,
            (count(*) FILTER (WHERE (latest_observations.availability = ANY (ARRAY['available'::text, 'preorder'::text, 'backorder'::text]))))::integer AS available_count,
            (count(*) FILTER (WHERE (latest_observations.availability = 'sold_out'::text)))::integer AS sold_out_count,
            (count(latest_observations.price_jpy))::integer AS priced_count,
            min(latest_observations.price_jpy) AS min_price_jpy,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((latest_observations.price_jpy)::double precision)))::integer AS median_price_jpy,
            round(avg(latest_observations.price_jpy), 2) AS average_price_jpy,
            max(latest_observations.price_jpy) AS max_price_jpy
           FROM latest_observations
          GROUP BY latest_observations.day, latest_observations.subscription_key, latest_observations.source_id
        )
 SELECT latest.day,
    latest.subscription_key,
    latest.subscription_name,
    latest.query,
    latest.query_key,
    latest.source_id,
    latest.result_count AS visible_count,
    1 AS source_count,
    movement.new_count,
    movement.left_visible_window,
    movement.run_count,
    COALESCE(distribution.available_count, 0) AS available_count,
    COALESCE(distribution.sold_out_count, 0) AS sold_out_count,
    COALESCE(distribution.priced_count, 0) AS priced_count,
    distribution.min_price_jpy,
    distribution.median_price_jpy,
    distribution.average_price_jpy,
    distribution.max_price_jpy
   FROM ((latest_source_window latest
     JOIN daily_movement movement USING (day, subscription_key, source_id))
     LEFT JOIN daily_distribution distribution USING (day, subscription_key, source_id));


--
-- Name: operational_listing_snapshots; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.operational_listing_snapshots (
    external_snapshot_id text NOT NULL,
    source_listing_id bigint NOT NULL,
    watch_binding_id text,
    observed_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operational_listing_snapshots_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);


--
-- Name: product_listing_links; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.product_listing_links (
    catalog_product_id bigint NOT NULL,
    source_listing_id bigint NOT NULL,
    match_method text NOT NULL,
    confidence numeric(5,4),
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_listing_links_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT product_listing_links_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text))
);


--
-- Name: product_variants; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.product_variants (
    id text NOT NULL,
    canonical_product_id text NOT NULL,
    identity_hash text NOT NULL,
    identity_version text NOT NULL,
    variant_name text NOT NULL,
    model text,
    jan text,
    size text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_fingerprint jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT product_variants_attributes_check CHECK ((jsonb_typeof(attributes) = 'object'::text)),
    CONSTRAINT product_variants_id_check CHECK ((id ~ '^pv_[0-9a-f]{24}$'::text)),
    CONSTRAINT product_variants_identity_hash_check CHECK ((identity_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT product_variants_target_fingerprint_check CHECK ((jsonb_typeof(target_fingerprint) = 'object'::text)),
    CONSTRAINT product_variants_variant_name_check CHECK ((btrim(variant_name) <> ''::text))
);


--
-- Name: sale_records; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.sale_records (
    id bigint NOT NULL,
    source_listing_id bigint NOT NULL,
    source_sale_id text,
    sold_price_jpy integer,
    sold_at timestamp with time zone NOT NULL,
    evidence_url text,
    evidence jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sale_records_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text))
);


--
-- Name: sale_records_id_seq; Type: SEQUENCE; Schema: radar_analytics; Owner: -
--

ALTER TABLE radar_analytics.sale_records ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME radar_analytics.sale_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: search_product_relations; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.search_product_relations (
    search_run_id uuid NOT NULL,
    source_listing_id bigint NOT NULL,
    target jsonb NOT NULL,
    relation text NOT NULL,
    score integer NOT NULL,
    matcher_version text NOT NULL,
    evidence jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    CONSTRAINT search_product_relations_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT search_product_relations_relation_check CHECK ((relation = ANY (ARRAY['exact'::text, 'probable_exact'::text, 'variant'::text, 'bundle'::text, 'related'::text, 'irrelevant'::text, 'uncertain'::text]))),
    CONSTRAINT search_product_relations_score_check CHECK (((score >= 0) AND (score <= 100))),
    CONSTRAINT search_product_relations_target_check CHECK ((jsonb_typeof(target) = 'object'::text))
);


--
-- Name: source_listings_id_seq; Type: SEQUENCE; Schema: radar_analytics; Owner: -
--

ALTER TABLE radar_analytics.source_listings ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME radar_analytics.source_listings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_response_captures; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.source_response_captures (
    capture_id text NOT NULL,
    run_id uuid NOT NULL,
    source_id text NOT NULL,
    ordinal integer NOT NULL,
    request_url text NOT NULL,
    response_url text,
    request_method text NOT NULL,
    response_status integer,
    content_type text,
    payload_kind text NOT NULL,
    raw_payload text,
    payload_bytes bigint DEFAULT 0 NOT NULL,
    content_hash text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_response_captures_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT source_response_captures_html_metadata_only CHECK (((payload_kind <> 'html'::text) OR (raw_payload IS NULL))),
    CONSTRAINT source_response_captures_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT source_response_captures_payload_bytes_check CHECK ((payload_bytes >= 0)),
    CONSTRAINT source_response_captures_payload_kind_check CHECK ((payload_kind = ANY (ARRAY['json'::text, 'html'::text, 'text'::text, 'binary'::text, 'empty'::text, 'unreadable'::text])))
);


--
-- Name: source_run_artifacts; Type: TABLE; Schema: radar_analytics; Owner: -
--

CREATE TABLE radar_analytics.source_run_artifacts (
    run_id uuid NOT NULL,
    source_id text NOT NULL,
    artifact_kind text DEFAULT 'normalized_source_group'::text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    payload_bytes bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_run_artifacts_artifact_kind_check CHECK ((artifact_kind = 'normalized_source_group'::text)),
    CONSTRAINT source_run_artifacts_check CHECK (((payload ->> 'sourceId'::text) = source_id)),
    CONSTRAINT source_run_artifacts_payload_bytes_check CHECK ((payload_bytes >= 0)),
    CONSTRAINT source_run_artifacts_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);


--
-- Name: analytics_outbox; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.analytics_outbox (
    id text NOT NULL,
    kind text NOT NULL,
    reference_id text NOT NULL,
    payload_json text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts bigint DEFAULT '0'::bigint NOT NULL,
    queued_at text,
    processed_at text,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT ck_analytics_outbox_01 CHECK ((kind = ANY (ARRAY['preview_search'::text, 'watch_market'::text, 'ai_enrichment'::text, 'listing_backfill'::text, 'product_identity'::text]))),
    CONSTRAINT ck_analytics_outbox_02 CHECK (((payload_json IS NULL) OR pg_input_is_valid(payload_json, 'jsonb'::text))),
    CONSTRAINT ck_analytics_outbox_03 CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT ck_analytics_outbox_04 CHECK ((attempts >= 0))
);


--
-- Name: completion_notifications; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.completion_notifications (
    idempotency_key text NOT NULL,
    status text NOT NULL,
    attempts bigint DEFAULT '0'::bigint NOT NULL,
    resend_email_id text,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    sent_at text,
    CONSTRAINT ck_completion_notifications_01 CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: cost_profiles; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.cost_profiles (
    id text NOT NULL,
    profile_key text DEFAULT 'default'::text NOT NULL,
    version bigint NOT NULL,
    name text NOT NULL,
    exchange_rate_cny_per_100_jpy_milli bigint NOT NULL,
    exchange_rate_buffer_bps bigint DEFAULT '0'::bigint NOT NULL,
    proxy_fixed_fee_jpy bigint DEFAULT '0'::bigint NOT NULL,
    proxy_percent_bps bigint DEFAULT '0'::bigint NOT NULL,
    domestic_shipping_min_jpy bigint DEFAULT '0'::bigint NOT NULL,
    domestic_shipping_max_jpy bigint DEFAULT '0'::bigint NOT NULL,
    international_route_label text NOT NULL,
    first_weight_grams bigint NOT NULL,
    first_weight_min_jpy bigint NOT NULL,
    first_weight_max_jpy bigint NOT NULL,
    continued_weight_grams bigint NOT NULL,
    continued_weight_min_jpy bigint NOT NULL,
    continued_weight_max_jpy bigint NOT NULL,
    unknown_weight_min_grams bigint NOT NULL,
    unknown_weight_max_grams bigint NOT NULL,
    consolidation_share_bps bigint DEFAULT '10000'::bigint NOT NULL,
    tax_enabled bigint DEFAULT '0'::bigint NOT NULL,
    tax_bps bigint DEFAULT '0'::bigint NOT NULL,
    cost_buffer_bps bigint DEFAULT '0'::bigint NOT NULL,
    valid_from text NOT NULL,
    valid_to text,
    created_at text NOT NULL,
    created_by text DEFAULT 'user'::text NOT NULL,
    CONSTRAINT ck_cost_profiles_01 CHECK ((version >= 1)),
    CONSTRAINT ck_cost_profiles_02 CHECK (((length(name) >= 1) AND (length(name) <= 80))),
    CONSTRAINT ck_cost_profiles_03 CHECK (((exchange_rate_cny_per_100_jpy_milli >= 1) AND (exchange_rate_cny_per_100_jpy_milli <= 1000000))),
    CONSTRAINT ck_cost_profiles_04 CHECK (((exchange_rate_buffer_bps >= 0) AND (exchange_rate_buffer_bps <= 5000))),
    CONSTRAINT ck_cost_profiles_05 CHECK ((proxy_fixed_fee_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_06 CHECK (((proxy_percent_bps >= 0) AND (proxy_percent_bps <= 10000))),
    CONSTRAINT ck_cost_profiles_07 CHECK ((domestic_shipping_min_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_08 CHECK ((domestic_shipping_max_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_09 CHECK (((length(international_route_label) >= 1) AND (length(international_route_label) <= 80))),
    CONSTRAINT ck_cost_profiles_10 CHECK (((first_weight_grams >= 1) AND (first_weight_grams <= 100000))),
    CONSTRAINT ck_cost_profiles_11 CHECK ((first_weight_min_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_12 CHECK ((first_weight_max_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_13 CHECK (((continued_weight_grams >= 1) AND (continued_weight_grams <= 100000))),
    CONSTRAINT ck_cost_profiles_14 CHECK ((continued_weight_min_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_15 CHECK ((continued_weight_max_jpy >= 0)),
    CONSTRAINT ck_cost_profiles_16 CHECK (((unknown_weight_min_grams >= 1) AND (unknown_weight_min_grams <= 100000))),
    CONSTRAINT ck_cost_profiles_17 CHECK (((unknown_weight_max_grams >= 1) AND (unknown_weight_max_grams <= 100000))),
    CONSTRAINT ck_cost_profiles_18 CHECK (((consolidation_share_bps >= 1) AND (consolidation_share_bps <= 10000))),
    CONSTRAINT ck_cost_profiles_19 CHECK ((tax_enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_cost_profiles_20 CHECK (((tax_bps >= 0) AND (tax_bps <= 10000))),
    CONSTRAINT ck_cost_profiles_21 CHECK (((cost_buffer_bps >= 0) AND (cost_buffer_bps <= 5000))),
    CONSTRAINT ck_cost_profiles_22 CHECK ((created_by = ANY (ARRAY['user'::text, 'system'::text, 'migration'::text]))),
    CONSTRAINT ck_cost_profiles_23 CHECK ((domestic_shipping_max_jpy >= domestic_shipping_min_jpy)),
    CONSTRAINT ck_cost_profiles_24 CHECK ((first_weight_max_jpy >= first_weight_min_jpy)),
    CONSTRAINT ck_cost_profiles_25 CHECK ((continued_weight_max_jpy >= continued_weight_min_jpy)),
    CONSTRAINT ck_cost_profiles_26 CHECK ((unknown_weight_max_grams >= unknown_weight_min_grams)),
    CONSTRAINT ck_cost_profiles_27 CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: cron_heartbeats; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.cron_heartbeats (
    id text NOT NULL,
    scheduled_at text NOT NULL,
    observed_at text NOT NULL,
    due_bindings bigint DEFAULT '0'::bigint NOT NULL,
    enqueued_jobs bigint DEFAULT '0'::bigint NOT NULL,
    due_bindings_total bigint DEFAULT 0 NOT NULL,
    due_tracked_total bigint DEFAULT 0 NOT NULL,
    dispatch_ms bigint DEFAULT 0 NOT NULL
);


--
-- Name: daily_counters; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.daily_counters (
    day_utc text NOT NULL,
    queued_jobs bigint DEFAULT '0'::bigint NOT NULL,
    search_calls bigint DEFAULT '0'::bigint NOT NULL,
    detail_calls bigint DEFAULT '0'::bigint NOT NULL,
    emails_sent bigint DEFAULT '0'::bigint NOT NULL,
    emails_failed bigint DEFAULT '0'::bigint NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: email_deliveries; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.email_deliveries (
    id text NOT NULL,
    event_id text NOT NULL,
    idempotency_key text NOT NULL,
    resend_email_id text,
    status text NOT NULL,
    attempts bigint DEFAULT '0'::bigint NOT NULL,
    last_error text,
    created_at text NOT NULL,
    sent_at text,
    CONSTRAINT ck_email_deliveries_01 CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: events; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.events (
    id text NOT NULL,
    event_key text NOT NULL,
    event_type text NOT NULL,
    watch_profile_id text,
    watch_binding_id text,
    listing_id text,
    payload_json text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at text NOT NULL,
    sent_at text,
    delivery_not_before text,
    email_suppressed_at text,
    semantic_event_type text,
    CONSTRAINT ck_events_01 CHECK ((event_type = ANY (ARRAY['new_listing'::text, 'price_drop'::text, 'target_price'::text, 'restock'::text, 'sold_out'::text, 'source_error'::text, 'daily_digest'::text]))),
    CONSTRAINT ck_events_02 CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'suppressed'::text])))
);


--
-- Name: experimental_source_runtime; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.experimental_source_runtime (
    source_id text NOT NULL,
    next_request_at text,
    failure_window_started_at text,
    failure_count bigint DEFAULT '0'::bigint NOT NULL,
    circuit_until text,
    updated_at text NOT NULL,
    CONSTRAINT ck_experimental_source_runtime_01 CHECK ((failure_count >= 0))
);


--
-- Name: gemini_job_payload_chunks; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.gemini_job_payload_chunks (
    job_id text NOT NULL,
    chunk_index bigint NOT NULL,
    payload_chunk text NOT NULL,
    CONSTRAINT ck_gemini_job_payload_chunks_01 CHECK ((chunk_index >= 0))
);


--
-- Name: gemini_jobs; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.gemini_jobs (
    id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    dedupe_key text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    payload_json text NOT NULL,
    result_json text,
    total_items bigint DEFAULT '0'::bigint NOT NULL,
    completed_items bigint DEFAULT '0'::bigint NOT NULL,
    failed_items bigint DEFAULT '0'::bigint NOT NULL,
    binding_id text,
    watch_run_id text,
    trigger_type text,
    scan_started_at text,
    attempt_count bigint DEFAULT '0'::bigint NOT NULL,
    lease_expires_at text,
    next_attempt_at text,
    upstream_status bigint,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    completed_at text,
    CONSTRAINT ck_gemini_jobs_01 CHECK ((kind = ANY (ARRAY['listing_enrichment'::text, 'keyword_enrichment'::text, 'search_overview'::text, 'market_analysis'::text]))),
    CONSTRAINT ck_gemini_jobs_02 CHECK ((status = ANY (ARRAY['staging'::text, 'queued'::text, 'processing'::text, 'waiting_rate_limit'::text, 'completed'::text, 'partial'::text, 'failed'::text]))),
    CONSTRAINT ck_gemini_jobs_03 CHECK ((total_items >= 0)),
    CONSTRAINT ck_gemini_jobs_04 CHECK ((completed_items >= 0)),
    CONSTRAINT ck_gemini_jobs_05 CHECK ((failed_items >= 0)),
    CONSTRAINT ck_gemini_jobs_06 CHECK ((attempt_count >= 0))
);


--
-- Name: gemini_provider_cooldowns; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.gemini_provider_cooldowns (
    provider text NOT NULL,
    cooldown_until text NOT NULL,
    upstream_status bigint,
    last_error text,
    updated_at text NOT NULL
);


--
-- Name: gemini_request_reservations; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.gemini_request_reservations (
    id text NOT NULL,
    job_id text NOT NULL,
    reserved_at text NOT NULL
);


--
-- Name: gemini_token_reservations; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.gemini_token_reservations (
    id text NOT NULL,
    job_id text NOT NULL,
    estimated_input_tokens bigint NOT NULL,
    reserved_at text NOT NULL,
    CONSTRAINT ck_gemini_token_reservations_01 CHECK ((estimated_input_tokens > 0))
);


--
-- Name: hermes_deliveries; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.hermes_deliveries (
    id text NOT NULL,
    event_id text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    attempts bigint DEFAULT '0'::bigint NOT NULL,
    remote_delivery_id text,
    last_http_status bigint,
    last_error text,
    next_attempt_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    sent_at text,
    CONSTRAINT ck_hermes_deliveries_01 CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT ck_hermes_deliveries_02 CHECK ((attempts >= 0)),
    CONSTRAINT ck_hermes_deliveries_03 CHECK (((last_http_status IS NULL) OR ((last_http_status >= 100) AND (last_http_status <= 599))))
);


--
-- Name: listing_snapshots; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.listing_snapshots (
    id text NOT NULL,
    listing_id text NOT NULL,
    watch_binding_id text,
    price bigint,
    original_price bigint,
    price_basis text,
    currency text DEFAULT 'JPY'::text NOT NULL,
    availability text NOT NULL,
    item_condition text NOT NULL,
    state_hash text,
    observed_at text NOT NULL,
    content_hash text,
    product_facts_json text DEFAULT '{}'::text NOT NULL,
    CONSTRAINT ck_listing_snapshots_price_basis CHECK (((price_basis IS NULL) OR (price_basis = ANY (ARRAY['listing_price'::text, 'catalog_price'::text, 'offer_price'::text, 'auction_current_bid'::text]))))
);


--
-- Name: listings; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.listings (
    id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    identity_scope text NOT NULL,
    canonical_url text NOT NULL,
    title text NOT NULL,
    description_excerpt text,
    image_url text,
    seller_name text,
    shop_name text,
    currency text DEFAULT 'JPY'::text NOT NULL,
    current_price bigint,
    original_price bigint,
    price_basis text DEFAULT 'listing_price'::text NOT NULL,
    item_condition text DEFAULT 'unknown'::text NOT NULL,
    availability text DEFAULT 'unknown'::text NOT NULL,
    source_updated_at text,
    first_seen_at text NOT NULL,
    last_seen_at text NOT NULL,
    last_changed_at text NOT NULL,
    state_hash text,
    raw_metadata_json text DEFAULT '{}'::text NOT NULL,
    source_listed_at text,
    jan text,
    isbn text,
    model_number text,
    source_catalog_id text,
    brand text,
    manufacturer text,
    release_date text,
    preorder_deadline text,
    image_urls_json text DEFAULT '[]'::text NOT NULL,
    product_facts_json text DEFAULT '{}'::text NOT NULL,
    content_hash text,
    CONSTRAINT ck_listings_01 CHECK ((identity_scope = ANY (ARRAY['listing'::text, 'catalog'::text, 'offer'::text]))),
    CONSTRAINT ck_listings_02 CHECK ((item_condition = ANY (ARRAY['new'::text, 'used'::text, 'collectible'::text, 'refurbished'::text, 'unknown'::text]))),
    CONSTRAINT ck_listings_03 CHECK ((availability = ANY (ARRAY['available'::text, 'sold_out'::text, 'unavailable'::text, 'preorder'::text, 'backorder'::text, 'unknown'::text])))
);


--
-- Name: managed_api_billing_usage; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.managed_api_billing_usage (
    provider text NOT NULL,
    period_started_at text NOT NULL,
    period_ends_at text NOT NULL,
    runtime_budget bigint NOT NULL,
    runtime_calls bigint DEFAULT '0'::bigint NOT NULL,
    emergency_reserve bigint DEFAULT '0'::bigint NOT NULL,
    updated_at text NOT NULL,
    daily_day_jst text,
    daily_budget bigint DEFAULT '0'::bigint NOT NULL,
    daily_runtime_calls bigint DEFAULT '0'::bigint NOT NULL,
    CONSTRAINT ck_managed_api_billing_usage_01 CHECK ((runtime_budget >= 0)),
    CONSTRAINT ck_managed_api_billing_usage_02 CHECK ((runtime_calls >= 0)),
    CONSTRAINT ck_managed_api_billing_usage_03 CHECK ((emergency_reserve >= 0)),
    CONSTRAINT ck_managed_api_billing_usage_04 CHECK ((daily_budget >= 0)),
    CONSTRAINT ck_managed_api_billing_usage_05 CHECK ((daily_runtime_calls >= 0))
);


--
-- Name: managed_api_cache; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.managed_api_cache (
    provider text NOT NULL,
    cache_key text NOT NULL,
    response_json text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: managed_api_monthly_usage; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.managed_api_monthly_usage (
    provider text NOT NULL,
    month_utc text NOT NULL,
    runtime_budget bigint DEFAULT '40'::bigint NOT NULL,
    runtime_calls bigint DEFAULT '0'::bigint NOT NULL,
    emergency_reserve bigint DEFAULT '20'::bigint NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT ck_managed_api_monthly_usage_01 CHECK ((runtime_budget >= 0)),
    CONSTRAINT ck_managed_api_monthly_usage_02 CHECK ((runtime_calls >= 0)),
    CONSTRAINT ck_managed_api_monthly_usage_03 CHECK ((emergency_reserve >= 0))
);


--
-- Name: market_listing_cleaning_claims; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.market_listing_cleaning_claims (
    claim_key text NOT NULL,
    subscription_key text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    model text NOT NULL,
    prompt_version text NOT NULL,
    job_id text,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT ck_market_listing_cleaning_claims_01 CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])))
);


--
-- Name: market_scope_versions; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.market_scope_versions (
    id text NOT NULL,
    subscription_key text NOT NULL,
    watch_profile_id text NOT NULL,
    version bigint NOT NULL,
    scope_hash text NOT NULL,
    scope_json text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT ck_market_scope_versions_01 CHECK ((version > 0)),
    CONSTRAINT ck_market_scope_versions_02 CHECK (pg_input_is_valid(scope_json, 'jsonb'::text))
);


--
-- Name: monitor_events; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.monitor_events (
    id text NOT NULL,
    event_key text NOT NULL,
    event_type text NOT NULL,
    monitor_rule_id text NOT NULL,
    rule_key text NOT NULL,
    rule_version bigint NOT NULL,
    watch_profile_id text NOT NULL,
    watch_binding_id text,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    listing_id text,
    product_variant_id text,
    payload_json text NOT NULL,
    evidence_hash text NOT NULL,
    notification_eligibility text NOT NULL,
    suppression_reason text,
    legacy_event_id text,
    occurred_at text NOT NULL,
    detected_at text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT ck_monitor_events_01 CHECK ((event_type = ANY (ARRAY['listing.price_changed'::text, 'listing.availability_changed'::text, 'product.new_comparable_offer'::text, 'product.offer_below_target_listing_price'::text, 'product.offer_below_target_landed_cost'::text, 'product.condition_match_seen'::text, 'product.complete_set_seen'::text]))),
    CONSTRAINT ck_monitor_events_02 CHECK ((rule_version >= 1)),
    CONSTRAINT ck_monitor_events_03 CHECK ((subject_type = ANY (ARRAY['listing'::text, 'variant'::text, 'market'::text]))),
    CONSTRAINT ck_monitor_events_04 CHECK (pg_input_is_valid(payload_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_events_05 CHECK ((length(evidence_hash) = 64)),
    CONSTRAINT ck_monitor_events_06 CHECK ((notification_eligibility = ANY (ARRAY['instant'::text, 'digest'::text, 'quiet_hours'::text, 'cooldown'::text, 'record_only'::text])))
);


--
-- Name: monitor_rule_landed_cost_targets; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.monitor_rule_landed_cost_targets (
    monitor_rule_id text NOT NULL,
    cost_profile_id text NOT NULL,
    target_landed_cost_jpy bigint NOT NULL,
    threshold_policy text DEFAULT 'estimate_upper_bound_at_or_below'::text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT ck_monitor_rule_landed_cost_targets_01 CHECK ((target_landed_cost_jpy >= 0)),
    CONSTRAINT ck_monitor_rule_landed_cost_targets_02 CHECK ((threshold_policy = 'estimate_upper_bound_at_or_below'::text))
);


--
-- Name: monitor_rules; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.monitor_rules (
    id text NOT NULL,
    rule_key text NOT NULL,
    version bigint NOT NULL,
    watch_profile_id text NOT NULL,
    scope_type text NOT NULL,
    scope_id text NOT NULL,
    scope_identity_status text DEFAULT 'bound'::text NOT NULL,
    event_types_json text NOT NULL,
    source_allow_json text DEFAULT '[]'::text NOT NULL,
    source_deny_json text DEFAULT '[]'::text NOT NULL,
    conditions_json text DEFAULT '[]'::text NOT NULL,
    completeness_json text DEFAULT '[]'::text NOT NULL,
    target_listing_price bigint,
    target_landed_cost bigint,
    delivery_mode text DEFAULT 'instant'::text NOT NULL,
    quiet_hours_start text,
    quiet_hours_end text,
    timezone text DEFAULT 'Asia/Tokyo'::text NOT NULL,
    dedupe_window_minutes bigint DEFAULT '1440'::bigint NOT NULL,
    cooldown_minutes bigint DEFAULT '180'::bigint NOT NULL,
    stale_source_policy text DEFAULT 'annotate'::text NOT NULL,
    enabled bigint DEFAULT '1'::bigint NOT NULL,
    supersedes_rule_id text,
    valid_from text NOT NULL,
    valid_to text,
    created_at text NOT NULL,
    created_by text DEFAULT 'migration'::text NOT NULL,
    CONSTRAINT ck_monitor_rules_01 CHECK ((version >= 1)),
    CONSTRAINT ck_monitor_rules_02 CHECK ((scope_type = ANY (ARRAY['listing'::text, 'variant'::text, 'market'::text]))),
    CONSTRAINT ck_monitor_rules_03 CHECK ((scope_identity_status = ANY (ARRAY['bound'::text, 'pending'::text]))),
    CONSTRAINT ck_monitor_rules_04 CHECK (pg_input_is_valid(event_types_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_rules_05 CHECK (pg_input_is_valid(source_allow_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_rules_06 CHECK (pg_input_is_valid(source_deny_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_rules_07 CHECK (pg_input_is_valid(conditions_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_rules_08 CHECK (pg_input_is_valid(completeness_json, 'jsonb'::text)),
    CONSTRAINT ck_monitor_rules_09 CHECK (((target_listing_price IS NULL) OR (target_listing_price >= 0))),
    CONSTRAINT ck_monitor_rules_10 CHECK (((target_landed_cost IS NULL) OR (target_landed_cost >= 0))),
    CONSTRAINT ck_monitor_rules_11 CHECK ((delivery_mode = ANY (ARRAY['instant'::text, 'digest'::text]))),
    CONSTRAINT ck_monitor_rules_12 CHECK ((timezone = 'Asia/Tokyo'::text)),
    CONSTRAINT ck_monitor_rules_13 CHECK (((dedupe_window_minutes >= 1) AND (dedupe_window_minutes <= 10080))),
    CONSTRAINT ck_monitor_rules_14 CHECK (((cooldown_minutes >= 0) AND (cooldown_minutes <= 10080))),
    CONSTRAINT ck_monitor_rules_15 CHECK ((stale_source_policy = ANY (ARRAY['include'::text, 'annotate'::text, 'exclude'::text]))),
    CONSTRAINT ck_monitor_rules_16 CHECK ((enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_monitor_rules_17 CHECK ((created_by = ANY (ARRAY['migration'::text, 'user'::text, 'system'::text]))),
    CONSTRAINT ck_monitor_rules_18 CHECK (((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))),
    CONSTRAINT ck_monitor_rules_19 CHECK ((target_landed_cost IS NULL)),
    CONSTRAINT ck_monitor_rules_20 CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: notification_channels; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.notification_channels (
    channel text NOT NULL,
    enabled_at text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: p0_qualification_runs; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.p0_qualification_runs (
    id text NOT NULL,
    status text NOT NULL,
    triggered_by text DEFAULT 'admin'::text NOT NULL,
    started_at text NOT NULL,
    finished_at text,
    results_json text DEFAULT '[]'::text NOT NULL,
    error_message text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT ck_p0_qualification_runs_01 CHECK ((status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text, 'blocked'::text]))),
    CONSTRAINT ck_p0_qualification_runs_02 CHECK ((triggered_by = ANY (ARRAY['admin'::text, 'system'::text])))
);


--
-- Name: product_identity_projection_versions; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.product_identity_projection_versions (
    id text NOT NULL,
    projection_hash text NOT NULL,
    workflow_task_id text NOT NULL,
    search_history_id text NOT NULL,
    canonical_product_id text NOT NULL,
    product_variant_id text NOT NULL,
    comparison_profile_id text NOT NULL,
    identity_version text NOT NULL,
    membership_version text NOT NULL,
    projection_json text NOT NULL,
    membership_count bigint NOT NULL,
    confirmed_count bigint NOT NULL,
    rejected_count bigint NOT NULL,
    uncertain_count bigint NOT NULL,
    analytics_outbox_id text NOT NULL,
    projected_at text NOT NULL,
    CONSTRAINT ck_product_identity_projection_versions_01 CHECK ((length(projection_hash) = 64)),
    CONSTRAINT ck_product_identity_projection_versions_02 CHECK (pg_input_is_valid(projection_json, 'jsonb'::text)),
    CONSTRAINT ck_product_identity_projection_versions_03 CHECK ((membership_count >= 0)),
    CONSTRAINT ck_product_identity_projection_versions_04 CHECK ((confirmed_count >= 0)),
    CONSTRAINT ck_product_identity_projection_versions_05 CHECK ((rejected_count >= 0)),
    CONSTRAINT ck_product_identity_projection_versions_06 CHECK ((uncertain_count >= 0)),
    CONSTRAINT ck_product_identity_projection_versions_07 CHECK ((membership_count = ((confirmed_count + rejected_count) + uncertain_count)))
);


--
-- Name: product_search_workflow_results; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.product_search_workflow_results (
    task_id text NOT NULL,
    source_id text NOT NULL,
    group_json text NOT NULL,
    completed_at text NOT NULL,
    CONSTRAINT ck_product_search_workflow_results_01 CHECK (pg_input_is_valid(group_json, 'jsonb'::text))
);


--
-- Name: product_search_workflow_tasks; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.product_search_workflow_tasks (
    id text NOT NULL,
    status text NOT NULL,
    input_json text NOT NULL,
    plan_json text NOT NULL,
    history_id text,
    session_id text,
    journal_ready_at text,
    result_summary_json text,
    attempt_count bigint DEFAULT '0'::bigint NOT NULL,
    last_error text,
    created_at text NOT NULL,
    started_at text,
    updated_at text NOT NULL,
    completed_at text,
    ai_job_id text,
    ai_manifest_json text,
    ai_error text,
    ai_prepared_at text,
    CONSTRAINT ck_product_search_workflow_tasks_01 CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT ck_product_search_workflow_tasks_02 CHECK (pg_input_is_valid(input_json, 'jsonb'::text)),
    CONSTRAINT ck_product_search_workflow_tasks_03 CHECK (pg_input_is_valid(plan_json, 'jsonb'::text)),
    CONSTRAINT ck_product_search_workflow_tasks_04 CHECK (((result_summary_json IS NULL) OR pg_input_is_valid(result_summary_json, 'jsonb'::text))),
    CONSTRAINT ck_product_search_workflow_tasks_05 CHECK ((attempt_count >= 0)),
    CONSTRAINT ck_product_search_workflow_tasks_06 CHECK (((ai_manifest_json IS NULL) OR pg_input_is_valid(ai_manifest_json, 'jsonb'::text)))
);


--
-- Name: queue_dead_letters; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.queue_dead_letters (
    queue_name text NOT NULL,
    dead_letter_queue_name text NOT NULL,
    idempotency_key text NOT NULL,
    message_id text NOT NULL,
    message_type text NOT NULL,
    body_json text NOT NULL,
    deliveries bigint DEFAULT 1 NOT NULL,
    last_delivery_attempt bigint DEFAULT 1 NOT NULL,
    first_dead_lettered_at text NOT NULL,
    last_dead_lettered_at text NOT NULL,
    last_error text,
    CONSTRAINT queue_dead_letters_body_json_check CHECK (pg_input_is_valid(body_json, 'jsonb'::text)),
    CONSTRAINT queue_dead_letters_deliveries_check CHECK ((deliveries >= 1)),
    CONSTRAINT queue_dead_letters_last_delivery_attempt_check CHECK ((last_delivery_attempt >= 1))
);


--
-- Name: queue_message_receipts; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.queue_message_receipts (
    queue_name text NOT NULL,
    idempotency_key text NOT NULL,
    message_id text NOT NULL,
    message_type text NOT NULL,
    status text NOT NULL,
    deliveries bigint DEFAULT 1 NOT NULL,
    last_delivery_attempt bigint DEFAULT 1 NOT NULL,
    first_received_at text NOT NULL,
    last_received_at text NOT NULL,
    completed_at text,
    last_error text,
    CONSTRAINT queue_message_receipts_deliveries_check CHECK ((deliveries >= 1)),
    CONSTRAINT queue_message_receipts_last_delivery_attempt_check CHECK ((last_delivery_attempt >= 1)),
    CONSTRAINT queue_message_receipts_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text, 'dead_lettered'::text])))
);


--
-- Name: runtime_feature_flags; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.runtime_feature_flags (
    flag_key text NOT NULL,
    enabled bigint DEFAULT '0'::bigint NOT NULL,
    config_json text DEFAULT '{}'::text NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT ck_runtime_feature_flags_01 CHECK ((enabled = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_runtime_feature_flags_02 CHECK (pg_input_is_valid(config_json, 'jsonb'::text))
);


--
-- Name: search_candidate_hits; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_candidate_hits (
    search_history_id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    variant_id text NOT NULL,
    lane text NOT NULL,
    upstream_rank bigint NOT NULL,
    weight real NOT NULL,
    live_verified bigint DEFAULT '0'::bigint NOT NULL,
    CONSTRAINT ck_search_candidate_hits_01 CHECK ((lane = ANY (ARRAY['source_native'::text, 'historical_index'::text, 'web_search'::text]))),
    CONSTRAINT ck_search_candidate_hits_02 CHECK ((upstream_rank > 0)),
    CONSTRAINT ck_search_candidate_hits_03 CHECK ((live_verified = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: search_history; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_history (
    id text NOT NULL,
    query text NOT NULL,
    sources_json text NOT NULL,
    filters_json text NOT NULL,
    status text NOT NULL,
    result_count bigint DEFAULT '0'::bigint NOT NULL,
    source_summary_json text NOT NULL,
    searched_at text NOT NULL,
    search_mode text DEFAULT 'keyword'::text NOT NULL,
    target_json text,
    plan_json text,
    deep_search bigint DEFAULT '0'::bigint NOT NULL,
    session_id text,
    parent_history_id text,
    page_sequence bigint DEFAULT '1'::bigint NOT NULL,
    session_updated_at text,
    CONSTRAINT ck_search_history_01 CHECK (pg_input_is_valid(sources_json, 'jsonb'::text)),
    CONSTRAINT ck_search_history_02 CHECK (pg_input_is_valid(filters_json, 'jsonb'::text)),
    CONSTRAINT ck_search_history_03 CHECK ((status = ANY (ARRAY['success'::text, 'partial'::text, 'empty'::text, 'failed'::text]))),
    CONSTRAINT ck_search_history_04 CHECK (pg_input_is_valid(source_summary_json, 'jsonb'::text)),
    CONSTRAINT ck_search_history_05 CHECK ((search_mode = ANY (ARRAY['keyword'::text, 'exact_product'::text]))),
    CONSTRAINT ck_search_history_06 CHECK (((target_json IS NULL) OR pg_input_is_valid(target_json, 'jsonb'::text))),
    CONSTRAINT ck_search_history_07 CHECK (((plan_json IS NULL) OR pg_input_is_valid(plan_json, 'jsonb'::text))),
    CONSTRAINT ck_search_history_08 CHECK ((deep_search = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_search_history_09 CHECK ((page_sequence > 0))
);


--
-- Name: search_listing_index; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_listing_index (
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    title_normalized text NOT NULL,
    search_text text NOT NULL,
    listing_json text NOT NULL,
    first_seen_at text NOT NULL,
    last_seen_at text NOT NULL,
    last_live_verified_at text,
    CONSTRAINT ck_search_listing_index_01 CHECK (pg_input_is_valid(listing_json, 'jsonb'::text))
);


--
-- Name: search_product_relations; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_product_relations (
    search_history_id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    relation text NOT NULL,
    score bigint NOT NULL,
    matcher_version text NOT NULL,
    evidence_json text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT ck_search_product_relations_01 CHECK ((relation = ANY (ARRAY['exact'::text, 'probable_exact'::text, 'variant'::text, 'bundle'::text, 'related'::text, 'irrelevant'::text, 'uncertain'::text]))),
    CONSTRAINT ck_search_product_relations_02 CHECK (((score >= 0) AND (score <= 100))),
    CONSTRAINT ck_search_product_relations_03 CHECK (pg_input_is_valid(evidence_json, 'jsonb'::text))
);


--
-- Name: search_query_variants; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_query_variants (
    search_history_id text NOT NULL,
    variant_id text NOT NULL,
    query text NOT NULL,
    query_kind text NOT NULL,
    lane text NOT NULL,
    weight real NOT NULL,
    ordinal bigint NOT NULL,
    CONSTRAINT ck_search_query_variants_01 CHECK ((lane = ANY (ARRAY['source_native'::text, 'web_search'::text])))
);


--
-- Name: search_result_snapshots; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.search_result_snapshots (
    search_history_id text NOT NULL,
    source_id text NOT NULL,
    group_json text NOT NULL,
    captured_at text NOT NULL,
    CONSTRAINT ck_search_result_snapshots_01 CHECK (pg_input_is_valid(group_json, 'jsonb'::text))
);


--
-- Name: source_health_snapshots; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_health_snapshots (
    id text NOT NULL,
    source_id text NOT NULL,
    watch_binding_id text NOT NULL,
    watch_run_id text NOT NULL,
    observed_at text NOT NULL,
    state text NOT NULL,
    request_succeeded bigint DEFAULT '0'::bigint NOT NULL,
    parse_succeeded bigint DEFAULT '0'::bigint NOT NULL,
    coverage text DEFAULT 'unknown'::text NOT NULL,
    raw_result_count bigint DEFAULT '0'::bigint NOT NULL,
    normalized_result_count bigint DEFAULT '0'::bigint NOT NULL,
    page_depth bigint DEFAULT '0'::bigint NOT NULL,
    cursor_termination_reason text DEFAULT 'unknown'::text NOT NULL,
    response_content_hash text,
    response_bytes bigint DEFAULT '0'::bigint NOT NULL,
    template_version text,
    http_status bigint,
    field_total bigint DEFAULT '0'::bigint NOT NULL,
    field_complete bigint DEFAULT '0'::bigint NOT NULL,
    captcha_detected bigint DEFAULT '0'::bigint NOT NULL,
    login_required bigint DEFAULT '0'::bigint NOT NULL,
    blocked_detected bigint DEFAULT '0'::bigint NOT NULL,
    abnormal_empty bigint DEFAULT '0'::bigint NOT NULL,
    freshness_sla_minutes bigint NOT NULL,
    error_code text,
    error_message text,
    CONSTRAINT ck_source_health_snapshots_01 CHECK ((state = ANY (ARRAY['healthy'::text, 'empty'::text, 'suspected_degradation'::text, 'failed'::text, 'disabled'::text, 'cooldown'::text]))),
    CONSTRAINT ck_source_health_snapshots_02 CHECK ((request_succeeded = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_03 CHECK ((parse_succeeded = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_04 CHECK ((coverage = ANY (ARRAY['complete'::text, 'rolling_window'::text, 'best_effort'::text, 'unknown'::text]))),
    CONSTRAINT ck_source_health_snapshots_05 CHECK ((raw_result_count >= 0)),
    CONSTRAINT ck_source_health_snapshots_06 CHECK ((normalized_result_count >= 0)),
    CONSTRAINT ck_source_health_snapshots_07 CHECK ((page_depth >= 0)),
    CONSTRAINT ck_source_health_snapshots_08 CHECK ((cursor_termination_reason = ANY (ARRAY['exhausted'::text, 'budget_reached'::text, 'not_applicable'::text, 'unknown'::text]))),
    CONSTRAINT ck_source_health_snapshots_09 CHECK ((response_bytes >= 0)),
    CONSTRAINT ck_source_health_snapshots_10 CHECK ((field_total >= 0)),
    CONSTRAINT ck_source_health_snapshots_11 CHECK ((field_complete >= 0)),
    CONSTRAINT ck_source_health_snapshots_12 CHECK ((captcha_detected = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_13 CHECK ((login_required = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_14 CHECK ((blocked_detected = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_15 CHECK ((abnormal_empty = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_health_snapshots_16 CHECK ((freshness_sla_minutes > 0))
);


--
-- Name: source_history_anchors; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_history_anchors (
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    title_hint text NOT NULL,
    pinned bigint DEFAULT '0'::bigint NOT NULL,
    first_verified_at text NOT NULL,
    last_verified_at text NOT NULL,
    CONSTRAINT ck_source_history_anchors_01 CHECK ((pinned = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: source_probe_observations; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_probe_observations (
    id text NOT NULL,
    source_id text NOT NULL,
    window_started_at text NOT NULL,
    observed_at text NOT NULL,
    status text NOT NULL,
    coverage text DEFAULT 'unknown'::text NOT NULL,
    result_count bigint DEFAULT '0'::bigint NOT NULL,
    field_total bigint DEFAULT '0'::bigint NOT NULL,
    field_complete bigint DEFAULT '0'::bigint NOT NULL,
    http_status bigint,
    parser_version text,
    error_code text,
    error_message text,
    captcha_detected bigint DEFAULT '0'::bigint NOT NULL,
    cpu_limit_detected bigint DEFAULT '0'::bigint NOT NULL,
    login_required bigint DEFAULT '0'::bigint NOT NULL,
    CONSTRAINT ck_source_probe_observations_01 CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'rate_limited'::text, 'blocked'::text, 'skipped'::text]))),
    CONSTRAINT ck_source_probe_observations_02 CHECK ((coverage = ANY (ARRAY['complete'::text, 'rolling_window'::text, 'best_effort'::text, 'unknown'::text])))
);


--
-- Name: source_probe_window_history; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_probe_window_history (
    id text NOT NULL,
    source_id text NOT NULL,
    status text NOT NULL,
    request_route text NOT NULL,
    started_at text,
    planned_end_at text,
    finished_at text,
    total_runs bigint DEFAULT '0'::bigint NOT NULL,
    successful_runs bigint DEFAULT '0'::bigint NOT NULL,
    field_total bigint DEFAULT '0'::bigint NOT NULL,
    field_complete bigint DEFAULT '0'::bigint NOT NULL,
    captcha_runs bigint DEFAULT '0'::bigint NOT NULL,
    cpu_limit_runs bigint DEFAULT '0'::bigint NOT NULL,
    login_required_runs bigint DEFAULT '0'::bigint NOT NULL,
    decision_reason text,
    original_updated_at text NOT NULL,
    archived_at text NOT NULL,
    archive_reason text NOT NULL,
    next_request_route text NOT NULL,
    CONSTRAINT ck_source_probe_window_history_01 CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'failed'::text]))),
    CONSTRAINT ck_source_probe_window_history_02 CHECK ((request_route = ANY (ARRAY['direct'::text, 'mercari_service'::text]))),
    CONSTRAINT ck_source_probe_window_history_03 CHECK ((archive_reason = ANY (ARRAY['request_route_changed'::text, 'manual_restart'::text]))),
    CONSTRAINT ck_source_probe_window_history_04 CHECK ((next_request_route = ANY (ARRAY['direct'::text, 'mercari_service'::text])))
);


--
-- Name: source_probe_windows; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_probe_windows (
    source_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at text,
    planned_end_at text,
    finished_at text,
    total_runs bigint DEFAULT '0'::bigint NOT NULL,
    successful_runs bigint DEFAULT '0'::bigint NOT NULL,
    field_total bigint DEFAULT '0'::bigint NOT NULL,
    field_complete bigint DEFAULT '0'::bigint NOT NULL,
    captcha_runs bigint DEFAULT '0'::bigint NOT NULL,
    cpu_limit_runs bigint DEFAULT '0'::bigint NOT NULL,
    login_required_runs bigint DEFAULT '0'::bigint NOT NULL,
    decision_reason text,
    updated_at text NOT NULL,
    request_route text DEFAULT 'direct'::text NOT NULL,
    CONSTRAINT ck_source_probe_windows_01 CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'failed'::text]))),
    CONSTRAINT ck_source_probe_windows_02 CHECK ((request_route = ANY (ARRAY['direct'::text, 'mercari_service'::text])))
);


--
-- Name: source_registry; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_registry (
    id text NOT NULL,
    display_name text NOT NULL,
    transport text NOT NULL,
    identity_scope text NOT NULL,
    official_api bigint DEFAULT '0'::bigint NOT NULL,
    enabled bigint DEFAULT '0'::bigint NOT NULL,
    credential_status text DEFAULT 'not_required'::text NOT NULL,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    capabilities_json text DEFAULT '{}'::text NOT NULL,
    parser_version text,
    last_success_at text,
    last_failure_at text,
    consecutive_failures bigint DEFAULT '0'::bigint NOT NULL,
    cooldown_until text,
    last_http_status bigint,
    last_error_code text,
    last_error_message text,
    last_signature_success_at text,
    schema_version text,
    last_403_at text,
    last_429_at text,
    last_container_count bigint,
    last_page_bytes bigint,
    captcha_detected bigint DEFAULT '0'::bigint NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    request_route text DEFAULT 'direct'::text NOT NULL,
    cooldown_route text,
    CONSTRAINT ck_source_registry_01 CHECK ((transport = ANY (ARRAY['official_api'::text, 'internal_api'::text, 'html_endpoint'::text, 'managed_api'::text, 'manual'::text]))),
    CONSTRAINT ck_source_registry_02 CHECK ((identity_scope = ANY (ARRAY['listing'::text, 'catalog'::text, 'offer'::text]))),
    CONSTRAINT ck_source_registry_03 CHECK ((credential_status = ANY (ARRAY['not_required'::text, 'missing'::text, 'ready'::text, 'ineligible'::text, 'error'::text]))),
    CONSTRAINT ck_source_registry_04 CHECK ((health_status = ANY (ARRAY['healthy'::text, 'degraded'::text, 'blocked'::text, 'broken'::text, 'disabled'::text, 'unknown'::text]))),
    CONSTRAINT ck_source_registry_05 CHECK ((request_route = ANY (ARRAY['direct'::text, 'mercari_service'::text, 'managed_api'::text]))),
    CONSTRAINT ck_source_registry_06 CHECK (((cooldown_route IS NULL) OR (cooldown_route = ANY (ARRAY['direct'::text, 'mercari_service'::text, 'managed_api'::text]))))
);


--
-- Name: source_response_captures; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.source_response_captures (
    id text NOT NULL,
    run_id text NOT NULL,
    source_id text NOT NULL,
    ordinal bigint NOT NULL,
    request_url text NOT NULL,
    response_url text,
    request_method text NOT NULL,
    response_status bigint,
    content_type text,
    payload_kind text NOT NULL,
    raw_payload text,
    payload_bytes bigint DEFAULT '0'::bigint NOT NULL,
    content_hash text NOT NULL,
    captured_at text NOT NULL,
    duration_ms bigint DEFAULT '0'::bigint NOT NULL,
    truncated bigint DEFAULT '0'::bigint NOT NULL,
    error_message text,
    CONSTRAINT ck_source_response_captures_01 CHECK ((ordinal > 0)),
    CONSTRAINT ck_source_response_captures_02 CHECK ((payload_kind = ANY (ARRAY['json'::text, 'html'::text, 'text'::text, 'binary'::text, 'empty'::text, 'unreadable'::text]))),
    CONSTRAINT ck_source_response_captures_03 CHECK ((payload_bytes >= 0)),
    CONSTRAINT ck_source_response_captures_04 CHECK ((duration_ms >= 0)),
    CONSTRAINT ck_source_response_captures_05 CHECK ((truncated = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_source_response_captures_html_metadata_only CHECK (((payload_kind <> 'html'::text) OR (raw_payload IS NULL)))
);


--
-- Name: verification_checks; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.verification_checks (
    scope text NOT NULL,
    check_key text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    evidence_json text DEFAULT '{}'::text NOT NULL,
    verified_at text,
    updated_at text NOT NULL,
    CONSTRAINT ck_verification_checks_01 CHECK ((scope = ANY (ARRAY['p0'::text, 'final'::text]))),
    CONSTRAINT ck_verification_checks_02 CHECK ((status = ANY (ARRAY['pending'::text, 'passed'::text, 'failed'::text, 'blocked'::text])))
);


--
-- Name: watch_bindings; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.watch_bindings (
    id text NOT NULL,
    watch_profile_id text NOT NULL,
    source_id text NOT NULL,
    kind text NOT NULL,
    query text,
    search_url text,
    target_url text,
    source_config_json text DEFAULT '{}'::text NOT NULL,
    interval_minutes bigint DEFAULT '60'::bigint NOT NULL,
    next_run_at text NOT NULL,
    last_run_at text,
    last_success_at text,
    baseline_completed bigint DEFAULT '0'::bigint NOT NULL,
    notify_initial bigint DEFAULT '0'::bigint NOT NULL,
    notify_price_drop bigint DEFAULT '1'::bigint NOT NULL,
    notify_restock bigint DEFAULT '1'::bigint NOT NULL,
    notify_sold_out bigint DEFAULT '0'::bigint NOT NULL,
    target_price bigint,
    min_drop_amount bigint DEFAULT '1'::bigint NOT NULL,
    enabled bigint DEFAULT '1'::bigint NOT NULL,
    consecutive_failures bigint DEFAULT '0'::bigint NOT NULL,
    cooldown_until text,
    last_error_code text,
    last_error_message text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    monitoring_purpose text DEFAULT 'keyword_new_listing'::text NOT NULL,
    schedule_interval_minutes bigint DEFAULT '60'::bigint NOT NULL,
    source_item_id text,
    notify_new_listing bigint DEFAULT '1'::bigint NOT NULL,
    new_listing_watermark text,
    new_listing_anchored_at text,
    CONSTRAINT ck_watch_bindings_01 CHECK ((kind = ANY (ARRAY['keyword'::text, 'item'::text]))),
    CONSTRAINT ck_watch_bindings_02 CHECK ((interval_minutes >= 60)),
    CONSTRAINT ck_watch_bindings_03 CHECK ((monitoring_purpose = ANY (ARRAY['item_price'::text, 'keyword_new_listing'::text]))),
    CONSTRAINT ck_watch_bindings_04 CHECK (((schedule_interval_minutes >= 30) AND (schedule_interval_minutes <= 1440))),
    CONSTRAINT ck_watch_bindings_05 CHECK ((notify_new_listing = ANY (ARRAY[(0)::bigint, (1)::bigint])))
);


--
-- Name: watch_listing_matches; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.watch_listing_matches (
    watch_binding_id text NOT NULL,
    listing_id text NOT NULL,
    first_seen_at text NOT NULL,
    last_seen_at text NOT NULL,
    new_listing_notified_at text,
    acceptance_reason text DEFAULT 'legacy'::text NOT NULL,
    matcher_version text,
    semantic_prompt_version text,
    accepted_at text,
    tracking_status text DEFAULT 'discovery_only'::text NOT NULL,
    tracking_interval_minutes bigint DEFAULT '180'::bigint NOT NULL,
    tracking_next_run_at text,
    tracking_last_run_at text,
    tracking_last_success_at text,
    tracking_baseline_completed bigint DEFAULT '0'::bigint NOT NULL,
    tracking_consecutive_failures bigint DEFAULT '0'::bigint NOT NULL,
    tracking_cooldown_until text,
    tracking_last_error_code text,
    tracking_last_error_message text,
    tracking_missing_observations bigint DEFAULT '0'::bigint NOT NULL,
    tracking_last_price bigint,
    tracking_last_availability text,
    tracking_last_state_hash text,
    tracking_started_at text,
    tracking_ended_at text,
    tracking_terminal_reason text,
    CONSTRAINT ck_watch_listing_matches_01 CHECK ((acceptance_reason = ANY (ARRAY['legacy'::text, 'direct_item'::text, 'keyword_relevant'::text, 'deterministic_exact'::text, 'semantic_exact'::text, 'anchor_known'::text]))),
    CONSTRAINT ck_watch_listing_matches_02 CHECK ((tracking_status = ANY (ARRAY['discovery_only'::text, 'anchor_known'::text, 'active'::text, 'unavailable_pending'::text, 'waiting_restock'::text, 'terminal'::text, 'dismissed'::text, 'purchased'::text, 'paused'::text]))),
    CONSTRAINT ck_watch_listing_matches_03 CHECK (((tracking_interval_minutes >= 30) AND (tracking_interval_minutes <= 1440))),
    CONSTRAINT ck_watch_listing_matches_04 CHECK ((tracking_baseline_completed = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_watch_listing_matches_05 CHECK (((tracking_consecutive_failures >= 0) AND (tracking_missing_observations >= 0))),
    CONSTRAINT ck_watch_listing_matches_06 CHECK (((tracking_last_availability IS NULL) OR (tracking_last_availability = ANY (ARRAY['available'::text, 'sold_out'::text, 'unavailable'::text, 'preorder'::text, 'backorder'::text, 'unknown'::text]))))
);


--
-- Name: watch_profiles; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.watch_profiles (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    default_max_price bigint,
    include_terms_json text DEFAULT '[]'::text NOT NULL,
    exclude_terms_json text DEFAULT '[]'::text NOT NULL,
    enabled bigint DEFAULT '1'::bigint NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    dossier_kind text DEFAULT 'keyword'::text NOT NULL,
    product_variant_id text,
    product_identity_search_history_id text,
    offer_tracking_policy text DEFAULT 'search_window'::text NOT NULL,
    CONSTRAINT ck_watch_profiles_01 CHECK ((dossier_kind = ANY (ARRAY['item'::text, 'exact_product'::text, 'keyword'::text]))),
    CONSTRAINT ck_watch_profiles_02 CHECK ((offer_tracking_policy = ANY (ARRAY['search_window'::text, 'all_confirmed_offers'::text])))
);


--
-- Name: watch_runs; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.watch_runs (
    id text NOT NULL,
    watch_binding_id text NOT NULL,
    trigger_type text NOT NULL,
    status text NOT NULL,
    started_at text NOT NULL,
    finished_at text,
    duration_ms bigint,
    http_status bigint,
    result_count bigint DEFAULT '0'::bigint NOT NULL,
    new_count bigint DEFAULT '0'::bigint NOT NULL,
    changed_count bigint DEFAULT '0'::bigint NOT NULL,
    coverage text DEFAULT 'unknown'::text NOT NULL,
    parser_version text,
    error_code text,
    error_message text,
    field_total bigint DEFAULT '0'::bigint NOT NULL,
    field_complete bigint DEFAULT '0'::bigint NOT NULL,
    captcha_detected bigint DEFAULT '0'::bigint NOT NULL,
    cpu_limit_detected bigint DEFAULT '0'::bigint NOT NULL,
    login_required bigint DEFAULT '0'::bigint NOT NULL,
    CONSTRAINT ck_watch_runs_01 CHECK ((trigger_type = ANY (ARRAY['cron'::text, 'manual'::text, 'retry'::text, 'confirmation'::text]))),
    CONSTRAINT ck_watch_runs_02 CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text, 'skipped'::text, 'rate_limited'::text, 'blocked'::text]))),
    CONSTRAINT ck_watch_runs_03 CHECK ((coverage = ANY (ARRAY['complete'::text, 'rolling_window'::text, 'best_effort'::text, 'unknown'::text])))
);


--
-- Name: watch_run_listing_observations; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.watch_run_listing_observations (
    watch_run_id text NOT NULL,
    watch_binding_id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    canonical_url text NOT NULL,
    title text NOT NULL,
    image_url text,
    current_price bigint,
    original_price bigint,
    currency text NOT NULL,
    price_basis text NOT NULL,
    availability text NOT NULL,
    item_condition text NOT NULL,
    source_listed_at text,
    ordinal bigint NOT NULL,
    observed_at text NOT NULL,
    decision_status text DEFAULT 'pending'::text NOT NULL,
    decision_reason text,
    match_relation text,
    is_purchasable bigint DEFAULT '0'::bigint NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (watch_run_id, source_id, source_item_id),
    CONSTRAINT ck_watch_run_listing_observations_01 CHECK ((decision_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text, 'uncertain'::text]))),
    CONSTRAINT ck_watch_run_listing_observations_02 CHECK ((is_purchasable = ANY (ARRAY[(0)::bigint, (1)::bigint]))),
    CONSTRAINT ck_watch_run_listing_observations_03 CHECK ((ordinal > 0)),
    CONSTRAINT ck_watch_run_listing_observations_04 CHECK ((price_basis = ANY (ARRAY['listing_price'::text, 'catalog_price'::text, 'offer_price'::text, 'auction_current_bid'::text])))
);

CREATE INDEX idx_watch_run_listing_observations_binding_run
    ON radar_core.watch_run_listing_observations USING btree (watch_binding_id, watch_run_id, ordinal);


--
-- Name: web_search_cache; Type: TABLE; Schema: radar_core; Owner: -
--

CREATE TABLE radar_core.web_search_cache (
    query_key text NOT NULL,
    query text NOT NULL,
    response_json text NOT NULL,
    response_status bigint NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    CONSTRAINT ck_web_search_cache_01 CHECK (pg_input_is_valid(response_json, 'jsonb'::text))
);


--
-- Name: ai_enrichments ai_enrichments_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.ai_enrichments
    ADD CONSTRAINT ai_enrichments_pkey PRIMARY KEY (id);


--
-- Name: ai_processing_batches ai_processing_batches_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.ai_processing_batches
    ADD CONSTRAINT ai_processing_batches_pkey PRIMARY KEY (batch_id);


--
-- Name: canonical_products canonical_products_identity_hash_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.canonical_products
    ADD CONSTRAINT canonical_products_identity_hash_key UNIQUE (identity_hash);


--
-- Name: canonical_products canonical_products_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.canonical_products
    ADD CONSTRAINT canonical_products_pkey PRIMARY KEY (id);


--
-- Name: catalog_products catalog_products_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.catalog_products
    ADD CONSTRAINT catalog_products_pkey PRIMARY KEY (id);


--
-- Name: comparison_profiles comparison_profiles_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.comparison_profiles
    ADD CONSTRAINT comparison_profiles_pkey PRIMARY KEY (id);


--
-- Name: comparison_profiles comparison_profiles_product_variant_id_profile_version_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.comparison_profiles
    ADD CONSTRAINT comparison_profiles_product_variant_id_profile_version_key UNIQUE (product_variant_id, profile_version);


--
-- Name: keyword_listings keyword_listings_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.keyword_listings
    ADD CONSTRAINT keyword_listings_pkey PRIMARY KEY (query_key, source_listing_id);


--
-- Name: listing_observations listing_observations_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.listing_observations
    ADD CONSTRAINT listing_observations_pkey PRIMARY KEY (run_id, source_listing_id);


--
-- Name: market_scope_versions market_scope_versions_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.market_scope_versions
    ADD CONSTRAINT market_scope_versions_pkey PRIMARY KEY (id);


--
-- Name: market_scope_versions market_scope_versions_subscription_key_scope_hash_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.market_scope_versions
    ADD CONSTRAINT market_scope_versions_subscription_key_scope_hash_key UNIQUE (subscription_key, scope_hash);


--
-- Name: market_scope_versions market_scope_versions_subscription_key_version_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.market_scope_versions
    ADD CONSTRAINT market_scope_versions_subscription_key_version_key UNIQUE (subscription_key, version);


--
-- Name: operational_listing_snapshots operational_listing_snapshots_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.operational_listing_snapshots
    ADD CONSTRAINT operational_listing_snapshots_pkey PRIMARY KEY (external_snapshot_id);


--
-- Name: product_listing_links product_listing_links_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_links
    ADD CONSTRAINT product_listing_links_pkey PRIMARY KEY (catalog_product_id, source_listing_id);


--
-- Name: product_listing_memberships product_listing_memberships_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_memberships
    ADD CONSTRAINT product_listing_memberships_pkey PRIMARY KEY (id);


--
-- Name: product_variants product_variants_identity_hash_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_variants
    ADD CONSTRAINT product_variants_identity_hash_key UNIQUE (identity_hash);


--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);


--
-- Name: sale_records sale_records_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.sale_records
    ADD CONSTRAINT sale_records_pkey PRIMARY KEY (id);


--
-- Name: sale_records sale_records_source_listing_id_source_sale_id_sold_at_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.sale_records
    ADD CONSTRAINT sale_records_source_listing_id_source_sale_id_sold_at_key UNIQUE NULLS NOT DISTINCT (source_listing_id, source_sale_id, sold_at);


--
-- Name: search_product_relations search_product_relations_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_product_relations
    ADD CONSTRAINT search_product_relations_pkey PRIMARY KEY (search_run_id, source_listing_id, matcher_version);


--
-- Name: search_run_sources search_run_sources_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_run_sources
    ADD CONSTRAINT search_run_sources_pkey PRIMARY KEY (run_id, source_id);


--
-- Name: search_runs search_runs_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_runs
    ADD CONSTRAINT search_runs_pkey PRIMARY KEY (id);


--
-- Name: source_health_snapshots source_health_snapshots_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_pkey PRIMARY KEY (run_id, source_id);


--
-- Name: source_listings source_listings_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_listings
    ADD CONSTRAINT source_listings_pkey PRIMARY KEY (id);


--
-- Name: source_listings source_listings_source_id_source_item_id_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_listings
    ADD CONSTRAINT source_listings_source_id_source_item_id_key UNIQUE (source_id, source_item_id);


--
-- Name: source_response_captures source_response_captures_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_response_captures
    ADD CONSTRAINT source_response_captures_pkey PRIMARY KEY (capture_id);


--
-- Name: source_response_captures source_response_captures_run_id_source_id_ordinal_key; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_response_captures
    ADD CONSTRAINT source_response_captures_run_id_source_id_ordinal_key UNIQUE (run_id, source_id, ordinal);


--
-- Name: source_run_artifacts source_run_artifacts_pkey; Type: CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_run_artifacts
    ADD CONSTRAINT source_run_artifacts_pkey PRIMARY KEY (run_id, source_id, artifact_kind);


--
-- Name: watch_profiles idx_50231_sqlite_autoindex_watch_profiles_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_profiles
    ADD CONSTRAINT idx_50231_sqlite_autoindex_watch_profiles_1 PRIMARY KEY (id);


--
-- Name: watch_bindings idx_50240_sqlite_autoindex_watch_bindings_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_bindings
    ADD CONSTRAINT idx_50240_sqlite_autoindex_watch_bindings_1 PRIMARY KEY (id);


--
-- Name: listings idx_50258_sqlite_autoindex_listings_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.listings
    ADD CONSTRAINT idx_50258_sqlite_autoindex_listings_1 PRIMARY KEY (id);


--
-- Name: watch_listing_matches idx_50270_sqlite_autoindex_watch_listing_matches_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_listing_matches
    ADD CONSTRAINT idx_50270_sqlite_autoindex_watch_listing_matches_1 PRIMARY KEY (watch_binding_id, listing_id);


--
-- Name: listing_snapshots idx_50276_sqlite_autoindex_listing_snapshots_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.listing_snapshots
    ADD CONSTRAINT idx_50276_sqlite_autoindex_listing_snapshots_1 PRIMARY KEY (id);


--
-- Name: events idx_50283_sqlite_autoindex_events_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.events
    ADD CONSTRAINT idx_50283_sqlite_autoindex_events_1 PRIMARY KEY (id);


--
-- Name: email_deliveries idx_50289_sqlite_autoindex_email_deliveries_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.email_deliveries
    ADD CONSTRAINT idx_50289_sqlite_autoindex_email_deliveries_1 PRIMARY KEY (id);


--
-- Name: watch_runs idx_50295_sqlite_autoindex_watch_runs_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_runs
    ADD CONSTRAINT idx_50295_sqlite_autoindex_watch_runs_1 PRIMARY KEY (id);


--
-- Name: daily_counters idx_50309_sqlite_autoindex_daily_counters_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.daily_counters
    ADD CONSTRAINT idx_50309_sqlite_autoindex_daily_counters_1 PRIMARY KEY (day_utc);


--
-- Name: cron_heartbeats idx_50319_sqlite_autoindex_cron_heartbeats_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.cron_heartbeats
    ADD CONSTRAINT idx_50319_sqlite_autoindex_cron_heartbeats_1 PRIMARY KEY (id);


--
-- Name: verification_checks idx_50326_sqlite_autoindex_verification_checks_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.verification_checks
    ADD CONSTRAINT idx_50326_sqlite_autoindex_verification_checks_1 PRIMARY KEY (scope, check_key);


--
-- Name: source_probe_windows idx_50333_sqlite_autoindex_source_probe_windows_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_windows
    ADD CONSTRAINT idx_50333_sqlite_autoindex_source_probe_windows_1 PRIMARY KEY (source_id);


--
-- Name: completion_notifications idx_50347_sqlite_autoindex_completion_notifications_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.completion_notifications
    ADD CONSTRAINT idx_50347_sqlite_autoindex_completion_notifications_1 PRIMARY KEY (idempotency_key);


--
-- Name: p0_qualification_runs idx_50353_sqlite_autoindex_p0_qualification_runs_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.p0_qualification_runs
    ADD CONSTRAINT idx_50353_sqlite_autoindex_p0_qualification_runs_1 PRIMARY KEY (id);


--
-- Name: source_probe_observations idx_50360_sqlite_autoindex_source_probe_observations_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_observations
    ADD CONSTRAINT idx_50360_sqlite_autoindex_source_probe_observations_1 PRIMARY KEY (id);


--
-- Name: source_probe_window_history idx_50372_sqlite_autoindex_source_probe_window_history_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_window_history
    ADD CONSTRAINT idx_50372_sqlite_autoindex_source_probe_window_history_1 PRIMARY KEY (id);


--
-- Name: search_history idx_50384_sqlite_autoindex_search_history_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_history
    ADD CONSTRAINT idx_50384_sqlite_autoindex_search_history_1 PRIMARY KEY (id);


--
-- Name: search_result_snapshots idx_50393_sqlite_autoindex_search_result_snapshots_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_result_snapshots
    ADD CONSTRAINT idx_50393_sqlite_autoindex_search_result_snapshots_1 PRIMARY KEY (search_history_id, source_id);


--
-- Name: managed_api_monthly_usage idx_50398_sqlite_autoindex_managed_api_monthly_usage_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.managed_api_monthly_usage
    ADD CONSTRAINT idx_50398_sqlite_autoindex_managed_api_monthly_usage_1 PRIMARY KEY (provider, month_utc);


--
-- Name: managed_api_cache idx_50406_sqlite_autoindex_managed_api_cache_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.managed_api_cache
    ADD CONSTRAINT idx_50406_sqlite_autoindex_managed_api_cache_1 PRIMARY KEY (provider, cache_key);


--
-- Name: source_registry idx_50411_sqlite_autoindex_source_registry_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_registry
    ADD CONSTRAINT idx_50411_sqlite_autoindex_source_registry_1 PRIMARY KEY (id);


--
-- Name: source_history_anchors idx_50424_sqlite_autoindex_source_history_anchors_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_history_anchors
    ADD CONSTRAINT idx_50424_sqlite_autoindex_source_history_anchors_1 PRIMARY KEY (source_id, source_item_id);


--
-- Name: experimental_source_runtime idx_50430_sqlite_autoindex_experimental_source_runtime_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.experimental_source_runtime
    ADD CONSTRAINT idx_50430_sqlite_autoindex_experimental_source_runtime_1 PRIMARY KEY (source_id);


--
-- Name: source_response_captures idx_50436_sqlite_autoindex_source_response_captures_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_response_captures
    ADD CONSTRAINT idx_50436_sqlite_autoindex_source_response_captures_1 PRIMARY KEY (id);


--
-- Name: gemini_jobs idx_50444_sqlite_autoindex_gemini_jobs_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_jobs
    ADD CONSTRAINT idx_50444_sqlite_autoindex_gemini_jobs_1 PRIMARY KEY (id);


--
-- Name: gemini_job_payload_chunks idx_50453_sqlite_autoindex_gemini_job_payload_chunks_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_job_payload_chunks
    ADD CONSTRAINT idx_50453_sqlite_autoindex_gemini_job_payload_chunks_1 PRIMARY KEY (job_id, chunk_index);


--
-- Name: gemini_token_reservations idx_50458_sqlite_autoindex_gemini_token_reservations_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_token_reservations
    ADD CONSTRAINT idx_50458_sqlite_autoindex_gemini_token_reservations_1 PRIMARY KEY (id);


--
-- Name: search_query_variants idx_50463_sqlite_autoindex_search_query_variants_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_query_variants
    ADD CONSTRAINT idx_50463_sqlite_autoindex_search_query_variants_1 PRIMARY KEY (search_history_id, variant_id);


--
-- Name: search_candidate_hits idx_50468_sqlite_autoindex_search_candidate_hits_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_candidate_hits
    ADD CONSTRAINT idx_50468_sqlite_autoindex_search_candidate_hits_1 PRIMARY KEY (search_history_id, source_id, source_item_id, variant_id, lane);


--
-- Name: search_product_relations idx_50474_sqlite_autoindex_search_product_relations_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_product_relations
    ADD CONSTRAINT idx_50474_sqlite_autoindex_search_product_relations_1 PRIMARY KEY (search_history_id, source_id, source_item_id);


--
-- Name: search_listing_index idx_50479_sqlite_autoindex_search_listing_index_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_listing_index
    ADD CONSTRAINT idx_50479_sqlite_autoindex_search_listing_index_1 PRIMARY KEY (source_id, source_item_id);


--
-- Name: web_search_cache idx_50484_sqlite_autoindex_web_search_cache_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.web_search_cache
    ADD CONSTRAINT idx_50484_sqlite_autoindex_web_search_cache_1 PRIMARY KEY (query_key);


--
-- Name: product_search_workflow_tasks idx_50489_sqlite_autoindex_product_search_workflow_tasks_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_search_workflow_tasks
    ADD CONSTRAINT idx_50489_sqlite_autoindex_product_search_workflow_tasks_1 PRIMARY KEY (id);


--
-- Name: product_search_workflow_results idx_50495_sqlite_autoindex_product_search_workflow_results_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_search_workflow_results
    ADD CONSTRAINT idx_50495_sqlite_autoindex_product_search_workflow_results_1 PRIMARY KEY (task_id, source_id);


--
-- Name: market_listing_cleaning_claims idx_50500_sqlite_autoindex_market_listing_cleaning_claims_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.market_listing_cleaning_claims
    ADD CONSTRAINT idx_50500_sqlite_autoindex_market_listing_cleaning_claims_1 PRIMARY KEY (claim_key);


--
-- Name: gemini_request_reservations idx_50505_sqlite_autoindex_gemini_request_reservations_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_request_reservations
    ADD CONSTRAINT idx_50505_sqlite_autoindex_gemini_request_reservations_1 PRIMARY KEY (id);


--
-- Name: gemini_provider_cooldowns idx_50510_sqlite_autoindex_gemini_provider_cooldowns_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_provider_cooldowns
    ADD CONSTRAINT idx_50510_sqlite_autoindex_gemini_provider_cooldowns_1 PRIMARY KEY (provider);


--
-- Name: analytics_outbox idx_50515_sqlite_autoindex_analytics_outbox_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.analytics_outbox
    ADD CONSTRAINT idx_50515_sqlite_autoindex_analytics_outbox_1 PRIMARY KEY (id);


--
-- Name: runtime_feature_flags idx_50527_sqlite_autoindex_runtime_feature_flags_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.runtime_feature_flags
    ADD CONSTRAINT idx_50527_sqlite_autoindex_runtime_feature_flags_1 PRIMARY KEY (flag_key);


--
-- Name: monitor_rules idx_50534_sqlite_autoindex_monitor_rules_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rules
    ADD CONSTRAINT idx_50534_sqlite_autoindex_monitor_rules_1 PRIMARY KEY (id);


--
-- Name: monitor_events idx_50551_sqlite_autoindex_monitor_events_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT idx_50551_sqlite_autoindex_monitor_events_1 PRIMARY KEY (id);


--
-- Name: market_scope_versions idx_50556_sqlite_autoindex_market_scope_versions_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.market_scope_versions
    ADD CONSTRAINT idx_50556_sqlite_autoindex_market_scope_versions_1 PRIMARY KEY (id);


--
-- Name: source_health_snapshots idx_50561_sqlite_autoindex_source_health_snapshots_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_health_snapshots
    ADD CONSTRAINT idx_50561_sqlite_autoindex_source_health_snapshots_1 PRIMARY KEY (id);


--
-- Name: cost_profiles idx_50580_sqlite_autoindex_cost_profiles_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.cost_profiles
    ADD CONSTRAINT idx_50580_sqlite_autoindex_cost_profiles_1 PRIMARY KEY (id);


--
-- Name: monitor_rule_landed_cost_targets idx_50596_sqlite_autoindex_monitor_rule_landed_cost_targets_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rule_landed_cost_targets
    ADD CONSTRAINT idx_50596_sqlite_autoindex_monitor_rule_landed_cost_targets_1 PRIMARY KEY (monitor_rule_id);


--
-- Name: notification_channels idx_50602_sqlite_autoindex_notification_channels_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.notification_channels
    ADD CONSTRAINT idx_50602_sqlite_autoindex_notification_channels_1 PRIMARY KEY (channel);


--
-- Name: hermes_deliveries idx_50607_sqlite_autoindex_hermes_deliveries_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.hermes_deliveries
    ADD CONSTRAINT idx_50607_sqlite_autoindex_hermes_deliveries_1 PRIMARY KEY (id);


--
-- Name: managed_api_billing_usage idx_50613_sqlite_autoindex_managed_api_billing_usage_1; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.managed_api_billing_usage
    ADD CONSTRAINT idx_50613_sqlite_autoindex_managed_api_billing_usage_1 PRIMARY KEY (provider, period_started_at);


--
-- Name: product_identity_projection_versions pipv_outbox_key; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_identity_projection_versions
    ADD CONSTRAINT pipv_outbox_key UNIQUE (analytics_outbox_id);


--
-- Name: product_identity_projection_versions pipv_pkey; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_identity_projection_versions
    ADD CONSTRAINT pipv_pkey PRIMARY KEY (id);


--
-- Name: product_identity_projection_versions pipv_task_hash_key; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_identity_projection_versions
    ADD CONSTRAINT pipv_task_hash_key UNIQUE (workflow_task_id, projection_hash);


--
-- Name: queue_dead_letters queue_dead_letters_pkey; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.queue_dead_letters
    ADD CONSTRAINT queue_dead_letters_pkey PRIMARY KEY (queue_name, idempotency_key);


--
-- Name: queue_message_receipts queue_message_receipts_pkey; Type: CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.queue_message_receipts
    ADD CONSTRAINT queue_message_receipts_pkey PRIMARY KEY (queue_name, idempotency_key);


--
-- Name: ai_enrichments_batch_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX ai_enrichments_batch_idx ON radar_analytics.ai_enrichments USING btree (batch_id);


--
-- Name: ai_enrichments_listing_version_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE UNIQUE INDEX ai_enrichments_listing_version_idx ON radar_analytics.ai_enrichments USING btree (source_listing_id, purpose, provider, model, prompt_version, input_hash) WHERE (source_listing_id IS NOT NULL);


--
-- Name: ai_processing_batches_created_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX ai_processing_batches_created_idx ON radar_analytics.ai_processing_batches USING btree (created_at DESC);


--
-- Name: ai_processing_batches_semantic_input_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX ai_processing_batches_semantic_input_idx ON radar_analytics.ai_processing_batches USING btree (purpose, provider, model, prompt_version, input_hash, created_at DESC, batch_id);

COMMENT ON INDEX radar_analytics.ai_processing_batches_semantic_input_idx IS
  'Non-unique grouping and chronology index for retries of the same semantic input.';


--
-- Name: catalog_products_product_key_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE UNIQUE INDEX catalog_products_product_key_idx ON radar_analytics.catalog_products USING btree (product_key);


--
-- Name: comparison_profiles_active_variant_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE UNIQUE INDEX comparison_profiles_active_variant_idx ON radar_analytics.comparison_profiles USING btree (product_variant_id) WHERE active;


--
-- Name: comparison_profiles_variant_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX comparison_profiles_variant_idx ON radar_analytics.comparison_profiles USING btree (product_variant_id, profile_version DESC);


--
-- Name: keyword_listings_visible_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX keyword_listings_visible_idx ON radar_analytics.keyword_listings USING btree (query_key, active_visible, last_seen_at DESC);


--
-- Name: listing_observations_listing_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX listing_observations_listing_time_idx ON radar_analytics.listing_observations USING btree (source_listing_id, observed_at DESC);


--
-- Name: listing_observations_run_source_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX listing_observations_run_source_idx ON radar_analytics.listing_observations USING btree (run_id, source_id);


--
-- Name: market_scope_versions_latest_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX market_scope_versions_latest_idx ON radar_analytics.market_scope_versions USING btree (subscription_key, version DESC);


--
-- Name: operational_listing_snapshots_listing_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX operational_listing_snapshots_listing_time_idx ON radar_analytics.operational_listing_snapshots USING btree (source_listing_id, observed_at DESC);


--
-- Name: product_listing_links_source_listing_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE UNIQUE INDEX product_listing_links_source_listing_idx ON radar_analytics.product_listing_links USING btree (source_listing_id);


--
-- Name: product_listing_memberships_current_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE UNIQUE INDEX product_listing_memberships_current_idx ON radar_analytics.product_listing_memberships USING btree (product_variant_id, source_listing_id) WHERE is_current;


--
-- Name: product_listing_memberships_search_run_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_listing_memberships_search_run_idx ON radar_analytics.product_listing_memberships USING btree (search_run_id) WHERE (search_run_id IS NOT NULL);


--
-- Name: product_listing_memberships_source_listing_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_listing_memberships_source_listing_idx ON radar_analytics.product_listing_memberships USING btree (source_listing_id, valid_from DESC);


--
-- Name: product_listing_memberships_supersedes_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_listing_memberships_supersedes_idx ON radar_analytics.product_listing_memberships USING btree (supersedes_membership_id) WHERE (supersedes_membership_id IS NOT NULL);


--
-- Name: product_listing_memberships_variant_history_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_listing_memberships_variant_history_idx ON radar_analytics.product_listing_memberships USING btree (product_variant_id, valid_from DESC);


--
-- Name: product_listing_memberships_workflow_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_listing_memberships_workflow_idx ON radar_analytics.product_listing_memberships USING btree (workflow_task_id, valid_from DESC);


--
-- Name: product_variants_canonical_product_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX product_variants_canonical_product_idx ON radar_analytics.product_variants USING btree (canonical_product_id, created_at DESC);


--
-- Name: search_product_relations_listing_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_product_relations_listing_idx ON radar_analytics.search_product_relations USING btree (source_listing_id, observed_at DESC);


--
-- Name: search_product_relations_rank_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_product_relations_rank_idx ON radar_analytics.search_product_relations USING btree (relation, score DESC, observed_at DESC);


--
-- Name: search_run_sources_source_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_run_sources_source_idx ON radar_analytics.search_run_sources USING btree (source_id, run_id);


--
-- Name: search_runs_query_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_runs_query_time_idx ON radar_analytics.search_runs USING btree (query_key, searched_at DESC);


--
-- Name: search_runs_scope_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_runs_scope_time_idx ON radar_analytics.search_runs USING btree (scope_version_id, searched_at DESC) WHERE (origin = 'watch_keyword'::text);


--
-- Name: search_runs_subscription_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_runs_subscription_time_idx ON radar_analytics.search_runs USING btree (subscription_key, searched_at DESC) WHERE (origin = 'watch_keyword'::text);


--
-- Name: search_runs_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX search_runs_time_idx ON radar_analytics.search_runs USING btree (searched_at DESC);


--
-- Name: source_health_scope_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_health_scope_time_idx ON radar_analytics.source_health_snapshots USING btree (scope_version_id, source_id, observed_at DESC);


--
-- Name: source_health_source_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_health_source_time_idx ON radar_analytics.source_health_snapshots USING btree (source_id, observed_at DESC);


--
-- Name: source_listings_last_seen_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_listings_last_seen_idx ON radar_analytics.source_listings USING btree (last_seen_at DESC);


--
-- Name: source_listings_price_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_listings_price_idx ON radar_analytics.source_listings USING btree (source_id, current_price_jpy) WHERE (current_price_jpy IS NOT NULL);


--
-- Name: source_listings_search_document_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_listings_search_document_idx ON radar_analytics.source_listings USING gin (to_tsvector('simple'::regconfig, ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(description_excerpt, ''::text)) || ' '::text) || COALESCE((facts)::text, ''::text))));


--
-- Name: source_response_captures_run_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_response_captures_run_idx ON radar_analytics.source_response_captures USING btree (run_id, source_id, ordinal);


--
-- Name: source_response_captures_source_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_response_captures_source_time_idx ON radar_analytics.source_response_captures USING btree (source_id, captured_at DESC);


--
-- Name: source_run_artifacts_source_time_idx; Type: INDEX; Schema: radar_analytics; Owner: -
--

CREATE INDEX source_run_artifacts_source_time_idx ON radar_analytics.source_run_artifacts USING btree (source_id, captured_at DESC);


--
-- Name: idx_50231_idx_watch_profiles_dossier_kind; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50231_idx_watch_profiles_dossier_kind ON radar_core.watch_profiles USING btree (dossier_kind, enabled, updated_at);


--
-- Name: idx_50231_idx_watch_profiles_enabled; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50231_idx_watch_profiles_enabled ON radar_core.watch_profiles USING btree (enabled, updated_at);


--
-- Name: idx_50231_idx_watch_profiles_product_variant; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50231_idx_watch_profiles_product_variant ON radar_core.watch_profiles USING btree (product_variant_id, updated_at);


--
-- Name: idx_50240_idx_watch_bindings_due; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50240_idx_watch_bindings_due ON radar_core.watch_bindings USING btree (enabled, next_run_at);


--
-- Name: idx_50240_idx_watch_bindings_item_identity; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50240_idx_watch_bindings_item_identity ON radar_core.watch_bindings USING btree (source_id, source_item_id);


--
-- Name: idx_50240_idx_watch_bindings_profile; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50240_idx_watch_bindings_profile ON radar_core.watch_bindings USING btree (watch_profile_id, enabled);


--
-- Name: idx_50240_idx_watch_bindings_purpose_due; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50240_idx_watch_bindings_purpose_due ON radar_core.watch_bindings USING btree (monitoring_purpose, enabled, next_run_at);


--
-- Name: idx_50240_idx_watch_bindings_source; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50240_idx_watch_bindings_source ON radar_core.watch_bindings USING btree (source_id, enabled);


--
-- Name: idx_50258_idx_listings_isbn; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_isbn ON radar_core.listings USING btree (isbn);


--
-- Name: idx_50258_idx_listings_jan; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_jan ON radar_core.listings USING btree (jan);


--
-- Name: idx_50258_idx_listings_last_changed; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_last_changed ON radar_core.listings USING btree (last_changed_at);


--
-- Name: idx_50258_idx_listings_price; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_price ON radar_core.listings USING btree (current_price);


--
-- Name: idx_50258_idx_listings_release_date; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_release_date ON radar_core.listings USING btree (release_date);


--
-- Name: idx_50258_idx_listings_source_item; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50258_idx_listings_source_item ON radar_core.listings USING btree (source_id, source_item_id);


--
-- Name: idx_50258_sqlite_autoindex_listings_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50258_sqlite_autoindex_listings_2 ON radar_core.listings USING btree (source_id, source_item_id);


--
-- Name: idx_50270_idx_watch_listing_matches_listing; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50270_idx_watch_listing_matches_listing ON radar_core.watch_listing_matches USING btree (listing_id);


--
-- Name: idx_watch_listing_matches_tracking_due; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_watch_listing_matches_tracking_due ON radar_core.watch_listing_matches USING btree (tracking_status, tracking_next_run_at) WHERE (tracking_next_run_at IS NOT NULL);


--
-- Name: idx_50276_idx_listing_snapshots_item_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50276_idx_listing_snapshots_item_time ON radar_core.listing_snapshots USING btree (listing_id, observed_at);


--
-- Name: idx_50276_idx_listing_snapshots_observed; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50276_idx_listing_snapshots_observed ON radar_core.listing_snapshots USING btree (observed_at);


--
-- Name: idx_50283_idx_events_created; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_created ON radar_core.events USING btree (created_at);


--
-- Name: idx_50283_idx_events_delivery_due; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_delivery_due ON radar_core.events USING btree (status, delivery_not_before, created_at);


--
-- Name: idx_50283_idx_events_listing; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_listing ON radar_core.events USING btree (listing_id, created_at);


--
-- Name: idx_50283_idx_events_semantic_type_created; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_semantic_type_created ON radar_core.events USING btree (semantic_event_type, created_at);


--
-- Name: idx_50283_idx_events_status; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_status ON radar_core.events USING btree (status, created_at);


--
-- Name: idx_50283_idx_events_type_created; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50283_idx_events_type_created ON radar_core.events USING btree (event_type, created_at);


--
-- Name: idx_50283_sqlite_autoindex_events_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50283_sqlite_autoindex_events_2 ON radar_core.events USING btree (event_key);


--
-- Name: idx_50289_idx_email_deliveries_event; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50289_idx_email_deliveries_event ON radar_core.email_deliveries USING btree (event_id, status, created_at);


--
-- Name: idx_50289_idx_email_deliveries_status; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50289_idx_email_deliveries_status ON radar_core.email_deliveries USING btree (status, created_at);


--
-- Name: idx_50289_sqlite_autoindex_email_deliveries_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50289_sqlite_autoindex_email_deliveries_2 ON radar_core.email_deliveries USING btree (idempotency_key);


--
-- Name: idx_50295_idx_watch_runs_binding_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50295_idx_watch_runs_binding_time ON radar_core.watch_runs USING btree (watch_binding_id, started_at);


--
-- Name: idx_50295_idx_watch_runs_started; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50295_idx_watch_runs_started ON radar_core.watch_runs USING btree (started_at);


--
-- Name: idx_50295_idx_watch_runs_status_started; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50295_idx_watch_runs_status_started ON radar_core.watch_runs USING btree (status, started_at);


--
-- Name: idx_50319_idx_cron_heartbeats_observed; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50319_idx_cron_heartbeats_observed ON radar_core.cron_heartbeats USING btree (observed_at);


--
-- Name: idx_cron_heartbeats_scheduled; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_cron_heartbeats_scheduled ON radar_core.cron_heartbeats USING btree (scheduled_at DESC);


--
-- Name: idx_50326_idx_verification_checks_scope_status; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50326_idx_verification_checks_scope_status ON radar_core.verification_checks USING btree (scope, status);


--
-- Name: idx_50353_idx_p0_qualification_runs_started; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50353_idx_p0_qualification_runs_started ON radar_core.p0_qualification_runs USING btree (started_at);


--
-- Name: idx_50360_idx_probe_observations_source_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50360_idx_probe_observations_source_time ON radar_core.source_probe_observations USING btree (source_id, observed_at);


--
-- Name: idx_50372_idx_probe_window_history_source_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50372_idx_probe_window_history_source_time ON radar_core.source_probe_window_history USING btree (source_id, archived_at);


--
-- Name: idx_50372_sqlite_autoindex_source_probe_window_history_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50372_sqlite_autoindex_source_probe_window_history_2 ON radar_core.source_probe_window_history USING btree (source_id, started_at, request_route);


--
-- Name: idx_50384_idx_search_history_roots; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50384_idx_search_history_roots ON radar_core.search_history USING btree (parent_history_id, searched_at);


--
-- Name: idx_50384_idx_search_history_searched_at; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50384_idx_search_history_searched_at ON radar_core.search_history USING btree (searched_at);


--
-- Name: idx_50384_idx_search_history_session; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50384_idx_search_history_session ON radar_core.search_history USING btree (session_id, page_sequence);


--
-- Name: idx_50393_idx_search_result_snapshots_captured_at; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50393_idx_search_result_snapshots_captured_at ON radar_core.search_result_snapshots USING btree (captured_at);


--
-- Name: idx_50406_idx_managed_api_cache_expiry; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50406_idx_managed_api_cache_expiry ON radar_core.managed_api_cache USING btree (provider, expires_at);


--
-- Name: idx_50424_idx_source_history_anchors_priority; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50424_idx_source_history_anchors_priority ON radar_core.source_history_anchors USING btree (source_id, pinned, last_verified_at);


--
-- Name: idx_50436_idx_source_response_captures_run; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50436_idx_source_response_captures_run ON radar_core.source_response_captures USING btree (run_id, source_id, ordinal);


--
-- Name: idx_50436_idx_source_response_captures_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50436_idx_source_response_captures_time ON radar_core.source_response_captures USING btree (captured_at);


--
-- Name: idx_50436_sqlite_autoindex_source_response_captures_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50436_sqlite_autoindex_source_response_captures_2 ON radar_core.source_response_captures USING btree (run_id, source_id, ordinal);


--
-- Name: idx_50444_idx_gemini_jobs_dispatch; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50444_idx_gemini_jobs_dispatch ON radar_core.gemini_jobs USING btree (status, next_attempt_at, updated_at);


--
-- Name: idx_50444_idx_gemini_jobs_keyword_scan; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50444_idx_gemini_jobs_keyword_scan ON radar_core.gemini_jobs USING btree (binding_id, scan_started_at, status);


--
-- Name: idx_50444_sqlite_autoindex_gemini_jobs_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50444_sqlite_autoindex_gemini_jobs_2 ON radar_core.gemini_jobs USING btree (kind, dedupe_key);


--
-- Name: idx_50458_idx_gemini_token_reservations_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50458_idx_gemini_token_reservations_time ON radar_core.gemini_token_reservations USING btree (reserved_at);


--
-- Name: idx_50468_idx_search_candidate_hits_listing; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50468_idx_search_candidate_hits_listing ON radar_core.search_candidate_hits USING btree (source_id, source_item_id, search_history_id);


--
-- Name: idx_50474_idx_search_product_relations_relation; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50474_idx_search_product_relations_relation ON radar_core.search_product_relations USING btree (relation, score, created_at);


--
-- Name: idx_50479_idx_search_listing_index_last_seen; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50479_idx_search_listing_index_last_seen ON radar_core.search_listing_index USING btree (last_seen_at);


--
-- Name: idx_50479_idx_search_listing_index_title; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50479_idx_search_listing_index_title ON radar_core.search_listing_index USING btree (source_id, title_normalized);


--
-- Name: idx_50484_idx_web_search_cache_expires; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50484_idx_web_search_cache_expires ON radar_core.web_search_cache USING btree (expires_at);


--
-- Name: idx_50489_idx_product_search_workflow_tasks_ai_job; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50489_idx_product_search_workflow_tasks_ai_job ON radar_core.product_search_workflow_tasks USING btree (ai_job_id);


--
-- Name: idx_50489_idx_product_search_workflow_tasks_status; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50489_idx_product_search_workflow_tasks_status ON radar_core.product_search_workflow_tasks USING btree (status, updated_at);


--
-- Name: idx_50495_idx_product_search_workflow_results_task; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50495_idx_product_search_workflow_results_task ON radar_core.product_search_workflow_results USING btree (task_id, completed_at);


--
-- Name: idx_50500_idx_market_listing_cleaning_claims_job; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50500_idx_market_listing_cleaning_claims_job ON radar_core.market_listing_cleaning_claims USING btree (job_id, status, updated_at);


--
-- Name: idx_50500_idx_market_listing_cleaning_claims_listing; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50500_idx_market_listing_cleaning_claims_listing ON radar_core.market_listing_cleaning_claims USING btree (subscription_key, source_id, source_item_id);


--
-- Name: idx_50505_idx_gemini_request_reservations_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50505_idx_gemini_request_reservations_time ON radar_core.gemini_request_reservations USING btree (reserved_at);


--
-- Name: idx_50515_idx_analytics_outbox_pending; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50515_idx_analytics_outbox_pending ON radar_core.analytics_outbox USING btree (status, updated_at, created_at);


--
-- Name: idx_50515_idx_analytics_outbox_processed; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50515_idx_analytics_outbox_processed ON radar_core.analytics_outbox USING btree (status, processed_at);


--
-- Name: idx_50515_sqlite_autoindex_analytics_outbox_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50515_sqlite_autoindex_analytics_outbox_2 ON radar_core.analytics_outbox USING btree (kind, reference_id);


--
-- Name: idx_50522_idx_product_identity_projection_history; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50522_idx_product_identity_projection_history ON radar_core.product_identity_projection_versions USING btree (search_history_id, projected_at);


--
-- Name: idx_50522_idx_product_identity_projection_task; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50522_idx_product_identity_projection_task ON radar_core.product_identity_projection_versions USING btree (workflow_task_id, projected_at);


--
-- Name: idx_50522_idx_product_identity_projection_variant; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50522_idx_product_identity_projection_variant ON radar_core.product_identity_projection_versions USING btree (product_variant_id, projected_at);


--
-- Name: idx_50534_idx_monitor_rules_current; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50534_idx_monitor_rules_current ON radar_core.monitor_rules USING btree (rule_key) WHERE (valid_to IS NULL);


--
-- Name: idx_50534_idx_monitor_rules_profile; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50534_idx_monitor_rules_profile ON radar_core.monitor_rules USING btree (watch_profile_id, valid_to, version);


--
-- Name: idx_50534_idx_monitor_rules_scope; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50534_idx_monitor_rules_scope ON radar_core.monitor_rules USING btree (scope_type, scope_id, valid_to);


--
-- Name: idx_50534_sqlite_autoindex_monitor_rules_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50534_sqlite_autoindex_monitor_rules_2 ON radar_core.monitor_rules USING btree (rule_key, version);


--
-- Name: idx_50551_idx_monitor_events_detected; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50551_idx_monitor_events_detected ON radar_core.monitor_events USING btree (detected_at, id);


--
-- Name: idx_50551_idx_monitor_events_listing; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50551_idx_monitor_events_listing ON radar_core.monitor_events USING btree (listing_id, detected_at);


--
-- Name: idx_50551_idx_monitor_events_rule; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50551_idx_monitor_events_rule ON radar_core.monitor_events USING btree (monitor_rule_id, detected_at);


--
-- Name: idx_50551_idx_monitor_events_subject; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50551_idx_monitor_events_subject ON radar_core.monitor_events USING btree (subject_type, subject_id, event_type, detected_at);


--
-- Name: idx_50551_sqlite_autoindex_monitor_events_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50551_sqlite_autoindex_monitor_events_2 ON radar_core.monitor_events USING btree (event_key);


--
-- Name: idx_50556_idx_market_scope_versions_latest; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50556_idx_market_scope_versions_latest ON radar_core.market_scope_versions USING btree (subscription_key, version);


--
-- Name: idx_50556_sqlite_autoindex_market_scope_versions_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50556_sqlite_autoindex_market_scope_versions_2 ON radar_core.market_scope_versions USING btree (subscription_key, version);


--
-- Name: idx_50556_sqlite_autoindex_market_scope_versions_3; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50556_sqlite_autoindex_market_scope_versions_3 ON radar_core.market_scope_versions USING btree (subscription_key, scope_hash);


--
-- Name: idx_50561_idx_source_health_snapshots_binding_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50561_idx_source_health_snapshots_binding_time ON radar_core.source_health_snapshots USING btree (watch_binding_id, observed_at);


--
-- Name: idx_50561_idx_source_health_snapshots_source_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50561_idx_source_health_snapshots_source_time ON radar_core.source_health_snapshots USING btree (source_id, observed_at);


--
-- Name: idx_50561_idx_source_health_snapshots_state_time; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50561_idx_source_health_snapshots_state_time ON radar_core.source_health_snapshots USING btree (state, observed_at);


--
-- Name: idx_50561_sqlite_autoindex_source_health_snapshots_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50561_sqlite_autoindex_source_health_snapshots_2 ON radar_core.source_health_snapshots USING btree (watch_run_id);


--
-- Name: idx_50580_idx_cost_profiles_current; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50580_idx_cost_profiles_current ON radar_core.cost_profiles USING btree (profile_key);


--
-- Name: idx_50580_idx_cost_profiles_version; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50580_idx_cost_profiles_version ON radar_core.cost_profiles USING btree (profile_key, version);


--
-- Name: idx_50580_sqlite_autoindex_cost_profiles_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50580_sqlite_autoindex_cost_profiles_2 ON radar_core.cost_profiles USING btree (profile_key, version);


--
-- Name: idx_50596_idx_monitor_rule_landed_cost_profile; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50596_idx_monitor_rule_landed_cost_profile ON radar_core.monitor_rule_landed_cost_targets USING btree (cost_profile_id, monitor_rule_id);


--
-- Name: idx_50607_idx_hermes_deliveries_due; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50607_idx_hermes_deliveries_due ON radar_core.hermes_deliveries USING btree (status, next_attempt_at, updated_at);


--
-- Name: idx_50607_sqlite_autoindex_hermes_deliveries_2; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50607_sqlite_autoindex_hermes_deliveries_2 ON radar_core.hermes_deliveries USING btree (event_id);


--
-- Name: idx_50607_sqlite_autoindex_hermes_deliveries_3; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE UNIQUE INDEX idx_50607_sqlite_autoindex_hermes_deliveries_3 ON radar_core.hermes_deliveries USING btree (idempotency_key);


--
-- Name: idx_50613_idx_managed_api_billing_usage_latest; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_50613_idx_managed_api_billing_usage_latest ON radar_core.managed_api_billing_usage USING btree (provider, period_ends_at);


--
-- Name: idx_queue_dead_letters_last_seen; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_queue_dead_letters_last_seen ON radar_core.queue_dead_letters USING btree (last_dead_lettered_at);


--
-- Name: idx_queue_message_receipts_status_updated; Type: INDEX; Schema: radar_core; Owner: -
--

CREATE INDEX idx_queue_message_receipts_status_updated ON radar_core.queue_message_receipts USING btree (status, last_received_at);


--
-- Name: listing_observations listing_observations_05_clean_price; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER listing_observations_05_clean_price BEFORE INSERT OR UPDATE OF price_jpy ON radar_analytics.listing_observations FOR EACH ROW EXECUTE FUNCTION radar_analytics.clean_listing_observation_price();


--
-- Name: listing_observations listing_observations_assign_price_basis; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER listing_observations_assign_price_basis BEFORE INSERT OR UPDATE OF source_listing_id ON radar_analytics.listing_observations FOR EACH ROW EXECUTE FUNCTION radar_analytics.assign_observation_price_basis();


--
-- Name: listing_observations listing_observations_new_count_insert; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER listing_observations_new_count_insert AFTER INSERT ON radar_analytics.listing_observations FOR EACH ROW EXECUTE FUNCTION radar_analytics.refresh_observation_new_count();


--
-- Name: listing_observations listing_observations_new_count_update; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER listing_observations_new_count_update AFTER UPDATE OF is_new_for_query ON radar_analytics.listing_observations FOR EACH ROW WHEN ((old.is_new_for_query IS DISTINCT FROM new.is_new_for_query)) EXECUTE FUNCTION radar_analytics.refresh_observation_new_count();


--
-- Name: source_listings source_listings_00_preserve_evidence; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER source_listings_00_preserve_evidence BEFORE UPDATE ON radar_analytics.source_listings FOR EACH ROW EXECUTE FUNCTION radar_analytics.preserve_source_listing_evidence();


--
-- Name: source_listings source_listings_05_clean_price; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER source_listings_05_clean_price BEFORE INSERT OR UPDATE OF current_price_jpy ON radar_analytics.source_listings FOR EACH ROW EXECUTE FUNCTION radar_analytics.clean_source_listing_price();


--
-- Name: source_listings source_listings_assign_product_identity; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER source_listings_assign_product_identity BEFORE INSERT OR UPDATE OF source_id, source_item_id, title, facts, raw_metadata ON radar_analytics.source_listings FOR EACH ROW EXECUTE FUNCTION radar_analytics.assign_source_listing_product_identity();


--
-- Name: source_listings source_listings_link_product; Type: TRIGGER; Schema: radar_analytics; Owner: -
--

CREATE TRIGGER source_listings_link_product AFTER INSERT OR UPDATE OF product_key, product_match_method, title, facts, raw_metadata ON radar_analytics.source_listings FOR EACH ROW EXECUTE FUNCTION radar_analytics.link_source_listing_product();


--
-- Name: ai_enrichments ai_enrichments_batch_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.ai_enrichments
    ADD CONSTRAINT ai_enrichments_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES radar_analytics.ai_processing_batches(batch_id) ON DELETE SET NULL;


--
-- Name: ai_enrichments ai_enrichments_catalog_product_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.ai_enrichments
    ADD CONSTRAINT ai_enrichments_catalog_product_id_fkey FOREIGN KEY (catalog_product_id) REFERENCES radar_analytics.catalog_products(id) ON DELETE CASCADE;


--
-- Name: ai_enrichments ai_enrichments_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.ai_enrichments
    ADD CONSTRAINT ai_enrichments_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: comparison_profiles comparison_profiles_product_variant_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.comparison_profiles
    ADD CONSTRAINT comparison_profiles_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES radar_analytics.product_variants(id) ON DELETE CASCADE;


--
-- Name: keyword_listings keyword_listings_first_seen_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.keyword_listings
    ADD CONSTRAINT keyword_listings_first_seen_run_id_fkey FOREIGN KEY (first_seen_run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE RESTRICT;


--
-- Name: keyword_listings keyword_listings_last_left_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.keyword_listings
    ADD CONSTRAINT keyword_listings_last_left_run_id_fkey FOREIGN KEY (last_left_run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE SET NULL;


--
-- Name: keyword_listings keyword_listings_last_seen_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.keyword_listings
    ADD CONSTRAINT keyword_listings_last_seen_run_id_fkey FOREIGN KEY (last_seen_run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE RESTRICT;


--
-- Name: keyword_listings keyword_listings_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.keyword_listings
    ADD CONSTRAINT keyword_listings_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: listing_observations listing_observations_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.listing_observations
    ADD CONSTRAINT listing_observations_run_id_fkey FOREIGN KEY (run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE;


--
-- Name: listing_observations listing_observations_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.listing_observations
    ADD CONSTRAINT listing_observations_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: operational_listing_snapshots operational_listing_snapshots_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.operational_listing_snapshots
    ADD CONSTRAINT operational_listing_snapshots_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: product_listing_links product_listing_links_catalog_product_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_links
    ADD CONSTRAINT product_listing_links_catalog_product_id_fkey FOREIGN KEY (catalog_product_id) REFERENCES radar_analytics.catalog_products(id) ON DELETE CASCADE;


--
-- Name: product_listing_links product_listing_links_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_links
    ADD CONSTRAINT product_listing_links_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: product_listing_memberships product_listing_memberships_product_variant_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_memberships
    ADD CONSTRAINT product_listing_memberships_product_variant_id_fkey FOREIGN KEY (product_variant_id) REFERENCES radar_analytics.product_variants(id) ON DELETE CASCADE;


--
-- Name: product_listing_memberships product_listing_memberships_search_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_memberships
    ADD CONSTRAINT product_listing_memberships_search_run_id_fkey FOREIGN KEY (search_run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE SET NULL;


--
-- Name: product_listing_memberships product_listing_memberships_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_memberships
    ADD CONSTRAINT product_listing_memberships_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: product_listing_memberships product_listing_memberships_supersedes_membership_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_listing_memberships
    ADD CONSTRAINT product_listing_memberships_supersedes_membership_id_fkey FOREIGN KEY (supersedes_membership_id) REFERENCES radar_analytics.product_listing_memberships(id) ON DELETE SET NULL;


--
-- Name: product_variants product_variants_canonical_product_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.product_variants
    ADD CONSTRAINT product_variants_canonical_product_id_fkey FOREIGN KEY (canonical_product_id) REFERENCES radar_analytics.canonical_products(id) ON DELETE RESTRICT;


--
-- Name: sale_records sale_records_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.sale_records
    ADD CONSTRAINT sale_records_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: search_product_relations search_product_relations_search_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_product_relations
    ADD CONSTRAINT search_product_relations_search_run_id_fkey FOREIGN KEY (search_run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE;


--
-- Name: search_product_relations search_product_relations_source_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_product_relations
    ADD CONSTRAINT search_product_relations_source_listing_id_fkey FOREIGN KEY (source_listing_id) REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE;


--
-- Name: search_run_sources search_run_sources_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_run_sources
    ADD CONSTRAINT search_run_sources_run_id_fkey FOREIGN KEY (run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE;


--
-- Name: search_runs search_runs_scope_version_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.search_runs
    ADD CONSTRAINT search_runs_scope_version_id_fkey FOREIGN KEY (scope_version_id) REFERENCES radar_analytics.market_scope_versions(id) ON DELETE RESTRICT;


--
-- Name: source_health_snapshots source_health_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE;


--
-- Name: source_health_snapshots source_health_snapshots_scope_version_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_scope_version_id_fkey FOREIGN KEY (scope_version_id) REFERENCES radar_analytics.market_scope_versions(id) ON DELETE RESTRICT;


--
-- Name: source_response_captures source_response_captures_run_id_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_response_captures
    ADD CONSTRAINT source_response_captures_run_id_source_id_fkey FOREIGN KEY (run_id, source_id) REFERENCES radar_analytics.search_run_sources(run_id, source_id) ON DELETE CASCADE;


--
-- Name: source_run_artifacts source_run_artifacts_run_id_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_analytics; Owner: -
--

ALTER TABLE ONLY radar_analytics.source_run_artifacts
    ADD CONSTRAINT source_run_artifacts_run_id_source_id_fkey FOREIGN KEY (run_id, source_id) REFERENCES radar_analytics.search_run_sources(run_id, source_id) ON DELETE CASCADE;


--
-- Name: email_deliveries email_deliveries_event_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.email_deliveries
    ADD CONSTRAINT email_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES radar_core.events(id) ON DELETE CASCADE;


--
-- Name: events events_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.events
    ADD CONSTRAINT events_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES radar_core.listings(id) ON DELETE SET NULL;


--
-- Name: events events_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.events
    ADD CONSTRAINT events_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE SET NULL;


--
-- Name: events events_watch_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.events
    ADD CONSTRAINT events_watch_profile_id_fkey FOREIGN KEY (watch_profile_id) REFERENCES radar_core.watch_profiles(id) ON DELETE SET NULL;


--
-- Name: experimental_source_runtime experimental_source_runtime_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.experimental_source_runtime
    ADD CONSTRAINT experimental_source_runtime_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: gemini_job_payload_chunks gemini_job_payload_chunks_job_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_job_payload_chunks
    ADD CONSTRAINT gemini_job_payload_chunks_job_id_fkey FOREIGN KEY (job_id) REFERENCES radar_core.gemini_jobs(id) ON DELETE CASCADE;


--
-- Name: gemini_request_reservations gemini_request_reservations_job_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_request_reservations
    ADD CONSTRAINT gemini_request_reservations_job_id_fkey FOREIGN KEY (job_id) REFERENCES radar_core.gemini_jobs(id) ON DELETE CASCADE;


--
-- Name: gemini_token_reservations gemini_token_reservations_job_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.gemini_token_reservations
    ADD CONSTRAINT gemini_token_reservations_job_id_fkey FOREIGN KEY (job_id) REFERENCES radar_core.gemini_jobs(id) ON DELETE CASCADE;


--
-- Name: hermes_deliveries hermes_deliveries_event_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.hermes_deliveries
    ADD CONSTRAINT hermes_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES radar_core.events(id) ON DELETE CASCADE;


--
-- Name: listing_snapshots listing_snapshots_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.listing_snapshots
    ADD CONSTRAINT listing_snapshots_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES radar_core.listings(id) ON DELETE CASCADE;


--
-- Name: listing_snapshots listing_snapshots_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.listing_snapshots
    ADD CONSTRAINT listing_snapshots_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE SET NULL;


--
-- Name: listings listings_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.listings
    ADD CONSTRAINT listings_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE RESTRICT;


--
-- Name: market_listing_cleaning_claims market_listing_cleaning_claims_job_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.market_listing_cleaning_claims
    ADD CONSTRAINT market_listing_cleaning_claims_job_id_fkey FOREIGN KEY (job_id) REFERENCES radar_core.gemini_jobs(id) ON DELETE CASCADE;


--
-- Name: market_scope_versions market_scope_versions_watch_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.market_scope_versions
    ADD CONSTRAINT market_scope_versions_watch_profile_id_fkey FOREIGN KEY (watch_profile_id) REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE;


--
-- Name: monitor_events monitor_events_legacy_event_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT monitor_events_legacy_event_id_fkey FOREIGN KEY (legacy_event_id) REFERENCES radar_core.events(id) ON DELETE SET NULL;


--
-- Name: monitor_events monitor_events_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT monitor_events_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES radar_core.listings(id) ON DELETE SET NULL;


--
-- Name: monitor_events monitor_events_monitor_rule_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT monitor_events_monitor_rule_id_fkey FOREIGN KEY (monitor_rule_id) REFERENCES radar_core.monitor_rules(id) ON DELETE RESTRICT;


--
-- Name: monitor_events monitor_events_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT monitor_events_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE SET NULL;


--
-- Name: monitor_events monitor_events_watch_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_events
    ADD CONSTRAINT monitor_events_watch_profile_id_fkey FOREIGN KEY (watch_profile_id) REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE;


--
-- Name: monitor_rule_landed_cost_targets monitor_rule_landed_cost_targets_cost_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rule_landed_cost_targets
    ADD CONSTRAINT monitor_rule_landed_cost_targets_cost_profile_id_fkey FOREIGN KEY (cost_profile_id) REFERENCES radar_core.cost_profiles(id) ON DELETE RESTRICT;


--
-- Name: monitor_rule_landed_cost_targets monitor_rule_landed_cost_targets_monitor_rule_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rule_landed_cost_targets
    ADD CONSTRAINT monitor_rule_landed_cost_targets_monitor_rule_id_fkey FOREIGN KEY (monitor_rule_id) REFERENCES radar_core.monitor_rules(id) ON DELETE CASCADE;


--
-- Name: monitor_rules monitor_rules_supersedes_rule_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rules
    ADD CONSTRAINT monitor_rules_supersedes_rule_id_fkey FOREIGN KEY (supersedes_rule_id) REFERENCES radar_core.monitor_rules(id) ON DELETE SET NULL;


--
-- Name: monitor_rules monitor_rules_watch_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.monitor_rules
    ADD CONSTRAINT monitor_rules_watch_profile_id_fkey FOREIGN KEY (watch_profile_id) REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE;


--
-- Name: product_search_workflow_results product_search_workflow_results_task_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_search_workflow_results
    ADD CONSTRAINT product_search_workflow_results_task_id_fkey FOREIGN KEY (task_id) REFERENCES radar_core.product_search_workflow_tasks(id) ON DELETE CASCADE;


--
-- Name: product_search_workflow_tasks product_search_workflow_tasks_ai_job_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_search_workflow_tasks
    ADD CONSTRAINT product_search_workflow_tasks_ai_job_id_fkey FOREIGN KEY (ai_job_id) REFERENCES radar_core.gemini_jobs(id) ON DELETE SET NULL;


--
-- Name: product_search_workflow_tasks product_search_workflow_tasks_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.product_search_workflow_tasks
    ADD CONSTRAINT product_search_workflow_tasks_history_id_fkey FOREIGN KEY (history_id) REFERENCES radar_core.search_history(id) ON DELETE SET NULL;


--
-- Name: search_candidate_hits search_candidate_hits_search_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_candidate_hits
    ADD CONSTRAINT search_candidate_hits_search_history_id_fkey FOREIGN KEY (search_history_id) REFERENCES radar_core.search_history(id) ON DELETE CASCADE;


--
-- Name: search_history search_history_parent_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_history
    ADD CONSTRAINT search_history_parent_history_id_fkey FOREIGN KEY (parent_history_id) REFERENCES radar_core.search_history(id) ON DELETE CASCADE;


--
-- Name: search_product_relations search_product_relations_search_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_product_relations
    ADD CONSTRAINT search_product_relations_search_history_id_fkey FOREIGN KEY (search_history_id) REFERENCES radar_core.search_history(id) ON DELETE CASCADE;


--
-- Name: search_query_variants search_query_variants_search_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_query_variants
    ADD CONSTRAINT search_query_variants_search_history_id_fkey FOREIGN KEY (search_history_id) REFERENCES radar_core.search_history(id) ON DELETE CASCADE;


--
-- Name: search_result_snapshots search_result_snapshots_search_history_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.search_result_snapshots
    ADD CONSTRAINT search_result_snapshots_search_history_id_fkey FOREIGN KEY (search_history_id) REFERENCES radar_core.search_history(id) ON DELETE CASCADE;


--
-- Name: source_health_snapshots source_health_snapshots_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: source_health_snapshots source_health_snapshots_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;


--
-- Name: source_health_snapshots source_health_snapshots_watch_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_health_snapshots
    ADD CONSTRAINT source_health_snapshots_watch_run_id_fkey FOREIGN KEY (watch_run_id) REFERENCES radar_core.watch_runs(id) ON DELETE CASCADE;


--
-- Name: source_history_anchors source_history_anchors_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_history_anchors
    ADD CONSTRAINT source_history_anchors_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: source_probe_observations source_probe_observations_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_observations
    ADD CONSTRAINT source_probe_observations_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: source_probe_window_history source_probe_window_history_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_window_history
    ADD CONSTRAINT source_probe_window_history_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: source_probe_windows source_probe_windows_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.source_probe_windows
    ADD CONSTRAINT source_probe_windows_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE CASCADE;


--
-- Name: watch_bindings watch_bindings_source_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_bindings
    ADD CONSTRAINT watch_bindings_source_id_fkey FOREIGN KEY (source_id) REFERENCES radar_core.source_registry(id) ON DELETE RESTRICT;


--
-- Name: watch_bindings watch_bindings_watch_profile_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_bindings
    ADD CONSTRAINT watch_bindings_watch_profile_id_fkey FOREIGN KEY (watch_profile_id) REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE;


--
-- Name: watch_listing_matches watch_listing_matches_listing_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_listing_matches
    ADD CONSTRAINT watch_listing_matches_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES radar_core.listings(id) ON DELETE CASCADE;


--
-- Name: watch_listing_matches watch_listing_matches_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_listing_matches
    ADD CONSTRAINT watch_listing_matches_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;


--
-- Name: watch_run_listing_observations watch_run_listing_observations_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_run_listing_observations
    ADD CONSTRAINT watch_run_listing_observations_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;


--
-- Name: watch_run_listing_observations watch_run_listing_observations_watch_run_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_run_listing_observations
    ADD CONSTRAINT watch_run_listing_observations_watch_run_id_fkey FOREIGN KEY (watch_run_id) REFERENCES radar_core.watch_runs(id) ON DELETE CASCADE;


--
-- Name: watch_runs watch_runs_watch_binding_id_fkey; Type: FK CONSTRAINT; Schema: radar_core; Owner: -
--

ALTER TABLE ONLY radar_core.watch_runs
    ADD CONSTRAINT watch_runs_watch_binding_id_fkey FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;


--
-- Name: SCHEMA radar_analytics; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA radar_analytics TO radar_analytics_runtime;


--
-- Name: SCHEMA radar_core; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA radar_core TO radar_core_runtime;


--
-- Name: FUNCTION assign_observation_price_basis(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.assign_observation_price_basis() FROM PUBLIC;


--
-- Name: FUNCTION assign_source_listing_product_identity(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.assign_source_listing_product_identity() FROM PUBLIC;


--
-- Name: FUNCTION clean_listing_observation_price(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.clean_listing_observation_price() FROM PUBLIC;


--
-- Name: FUNCTION clean_source_listing_price(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.clean_source_listing_price() FROM PUBLIC;


--
-- Name: FUNCTION ingest_ai_enrichments(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_ai_enrichments(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_ai_enrichments(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_ai_processing_batch(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_ai_processing_batch(p_payload jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_ai_processing_batch(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_operational_listing_bundle(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_operational_listing_bundle(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_operational_listing_bundle(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_product_identity_projection(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_product_identity_projection_resolved(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection_resolved(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_product_identity_projection_resolved(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_search_product_relations(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_search_product_relations(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_search_product_relations(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_search_run(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_search_run(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_search_run(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_search_run_v2(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_search_run_v2(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_search_run_v2(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_search_run_v3(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_search_run_v3(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_search_run_v3(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION ingest_source_response_captures(p_payload jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.ingest_source_response_captures(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.ingest_source_response_captures(p_payload jsonb) TO radar_analytics_runtime;


--
-- Name: FUNCTION link_source_listing_product(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.link_source_listing_product() FROM PUBLIC;


--
-- Name: FUNCTION preserve_source_listing_evidence(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.preserve_source_listing_evidence() FROM PUBLIC;


--
-- Name: FUNCTION refresh_observation_new_count(); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.refresh_observation_new_count() FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.refresh_observation_new_count() TO radar_analytics_runtime;


--
-- Name: FUNCTION resolve_product_identity(p_source_id text, p_source_item_id text, p_title text, p_facts jsonb, p_raw_metadata jsonb); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.resolve_product_identity(p_source_id text, p_source_item_id text, p_title text, p_facts jsonb, p_raw_metadata jsonb) FROM PUBLIC;


--
-- Name: FUNCTION search_historical_product_listings(p_source_ids text[], p_terms text[], p_limit integer); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.search_historical_product_listings(p_source_ids text[], p_terms text[], p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.search_historical_product_listings(p_source_ids text[], p_terms text[], p_limit integer) TO radar_analytics_runtime;


--
-- Name: FUNCTION upsert_source_listing(p_listing jsonb, p_seen_at timestamp with time zone); Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL ON FUNCTION radar_analytics.upsert_source_listing(p_listing jsonb, p_seen_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION radar_analytics.upsert_source_listing(p_listing jsonb, p_seen_at timestamp with time zone) TO radar_analytics_runtime;


--
-- Name: TABLE ai_enrichments; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.ai_enrichments TO radar_analytics_runtime;


--
-- Name: SEQUENCE ai_enrichments_id_seq; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE radar_analytics.ai_enrichments_id_seq TO radar_analytics_runtime;


--
-- Name: TABLE ai_processing_batches; Type: ACL; Schema: radar_analytics; Owner: -
--

REVOKE ALL PRIVILEGES ON TABLE radar_analytics.ai_processing_batches
  FROM radar_analytics_runtime;
GRANT SELECT,INSERT ON TABLE radar_analytics.ai_processing_batches
  TO radar_analytics_runtime;


--
-- Name: TABLE canonical_products; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.canonical_products TO radar_analytics_runtime;


--
-- Name: TABLE catalog_products; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.catalog_products TO radar_analytics_runtime;


--
-- Name: SEQUENCE catalog_products_id_seq; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE radar_analytics.catalog_products_id_seq TO radar_analytics_runtime;


--
-- Name: TABLE comparison_profiles; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.comparison_profiles TO radar_analytics_runtime;


--
-- Name: TABLE product_listing_memberships; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.product_listing_memberships TO radar_analytics_runtime;


--
-- Name: TABLE current_product_listing_memberships; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.current_product_listing_memberships TO radar_analytics_runtime;


--
-- Name: TABLE search_run_sources; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.search_run_sources TO radar_analytics_runtime;


--
-- Name: TABLE search_runs; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.search_runs TO radar_analytics_runtime;


--
-- Name: TABLE keyword_daily_metrics; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.keyword_daily_metrics TO radar_analytics_runtime;


--
-- Name: TABLE keyword_listings; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.keyword_listings TO radar_analytics_runtime;


--
-- Name: TABLE source_listings; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.source_listings TO radar_analytics_runtime;


--
-- Name: TABLE latest_cleaned_listings; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.latest_cleaned_listings TO radar_analytics_runtime;


--
-- Name: TABLE listing_observations; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.listing_observations TO radar_analytics_runtime;


--
-- Name: TABLE market_scope_versions; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.market_scope_versions TO radar_analytics_runtime;


--
-- Name: TABLE source_health_snapshots; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.source_health_snapshots TO radar_analytics_runtime;


--
-- Name: TABLE market_scope_daily_source_metrics; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.market_scope_daily_source_metrics TO radar_analytics_runtime;


--
-- Name: TABLE market_scope_daily_metrics; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.market_scope_daily_metrics TO radar_analytics_runtime;


--
-- Name: TABLE market_subscription_daily_metrics; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.market_subscription_daily_metrics TO radar_analytics_runtime;


--
-- Name: TABLE market_subscription_daily_source_metrics; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT ON TABLE radar_analytics.market_subscription_daily_source_metrics TO radar_analytics_runtime;


--
-- Name: TABLE operational_listing_snapshots; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.operational_listing_snapshots TO radar_analytics_runtime;


--
-- Name: TABLE product_listing_links; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.product_listing_links TO radar_analytics_runtime;


--
-- Name: TABLE product_variants; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.product_variants TO radar_analytics_runtime;


--
-- Name: TABLE sale_records; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE radar_analytics.sale_records TO radar_analytics_runtime;


--
-- Name: SEQUENCE sale_records_id_seq; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE radar_analytics.sale_records_id_seq TO radar_analytics_runtime;


--
-- Name: TABLE search_product_relations; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.search_product_relations TO radar_analytics_runtime;


--
-- Name: SEQUENCE source_listings_id_seq; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE radar_analytics.source_listings_id_seq TO radar_analytics_runtime;


--
-- Name: TABLE source_response_captures; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.source_response_captures TO radar_analytics_runtime;


--
-- Name: TABLE source_run_artifacts; Type: ACL; Schema: radar_analytics; Owner: -
--

GRANT SELECT,INSERT ON TABLE radar_analytics.source_run_artifacts TO radar_analytics_runtime;


--
-- Name: TABLE analytics_outbox; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.analytics_outbox TO radar_core_runtime;


--
-- Name: TABLE completion_notifications; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.completion_notifications TO radar_core_runtime;


--
-- Name: TABLE cost_profiles; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.cost_profiles TO radar_core_runtime;


--
-- Name: TABLE cron_heartbeats; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.cron_heartbeats TO radar_core_runtime;


--
-- Name: TABLE daily_counters; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.daily_counters TO radar_core_runtime;


--
-- Name: TABLE email_deliveries; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.email_deliveries TO radar_core_runtime;


--
-- Name: TABLE events; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.events TO radar_core_runtime;


--
-- Name: TABLE experimental_source_runtime; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.experimental_source_runtime TO radar_core_runtime;


--
-- Name: TABLE gemini_job_payload_chunks; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.gemini_job_payload_chunks TO radar_core_runtime;


--
-- Name: TABLE gemini_jobs; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.gemini_jobs TO radar_core_runtime;


--
-- Name: TABLE gemini_provider_cooldowns; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.gemini_provider_cooldowns TO radar_core_runtime;


--
-- Name: TABLE gemini_request_reservations; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.gemini_request_reservations TO radar_core_runtime;


--
-- Name: TABLE gemini_token_reservations; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.gemini_token_reservations TO radar_core_runtime;


--
-- Name: TABLE hermes_deliveries; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.hermes_deliveries TO radar_core_runtime;


--
-- Name: TABLE listing_snapshots; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.listing_snapshots TO radar_core_runtime;


--
-- Name: TABLE listings; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.listings TO radar_core_runtime;


--
-- Name: TABLE managed_api_billing_usage; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.managed_api_billing_usage TO radar_core_runtime;


--
-- Name: TABLE managed_api_cache; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.managed_api_cache TO radar_core_runtime;


--
-- Name: TABLE managed_api_monthly_usage; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.managed_api_monthly_usage TO radar_core_runtime;


--
-- Name: TABLE market_listing_cleaning_claims; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.market_listing_cleaning_claims TO radar_core_runtime;


--
-- Name: TABLE market_scope_versions; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.market_scope_versions TO radar_core_runtime;


--
-- Name: TABLE monitor_events; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.monitor_events TO radar_core_runtime;


--
-- Name: TABLE monitor_rule_landed_cost_targets; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.monitor_rule_landed_cost_targets TO radar_core_runtime;


--
-- Name: TABLE monitor_rules; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.monitor_rules TO radar_core_runtime;


--
-- Name: TABLE notification_channels; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.notification_channels TO radar_core_runtime;


--
-- Name: TABLE p0_qualification_runs; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.p0_qualification_runs TO radar_core_runtime;


--
-- Name: TABLE product_identity_projection_versions; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.product_identity_projection_versions TO radar_core_runtime;


--
-- Name: TABLE product_search_workflow_results; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.product_search_workflow_results TO radar_core_runtime;


--
-- Name: TABLE product_search_workflow_tasks; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.product_search_workflow_tasks TO radar_core_runtime;


--
-- Name: TABLE queue_dead_letters; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.queue_dead_letters TO radar_core_runtime;


--
-- Name: TABLE queue_message_receipts; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.queue_message_receipts TO radar_core_runtime;


--
-- Name: TABLE runtime_feature_flags; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.runtime_feature_flags TO radar_core_runtime;


--
-- Name: TABLE search_candidate_hits; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_candidate_hits TO radar_core_runtime;


--
-- Name: TABLE search_history; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_history TO radar_core_runtime;


--
-- Name: TABLE search_listing_index; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_listing_index TO radar_core_runtime;


--
-- Name: TABLE search_product_relations; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_product_relations TO radar_core_runtime;


--
-- Name: TABLE search_query_variants; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_query_variants TO radar_core_runtime;


--
-- Name: TABLE search_result_snapshots; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.search_result_snapshots TO radar_core_runtime;


--
-- Name: TABLE source_health_snapshots; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_health_snapshots TO radar_core_runtime;


--
-- Name: TABLE source_history_anchors; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_history_anchors TO radar_core_runtime;


--
-- Name: TABLE source_probe_observations; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_probe_observations TO radar_core_runtime;


--
-- Name: TABLE source_probe_window_history; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_probe_window_history TO radar_core_runtime;


--
-- Name: TABLE source_probe_windows; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_probe_windows TO radar_core_runtime;


--
-- Name: TABLE source_registry; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_registry TO radar_core_runtime;


--
-- Name: TABLE source_response_captures; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.source_response_captures TO radar_core_runtime;


--
-- Name: TABLE verification_checks; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.verification_checks TO radar_core_runtime;


--
-- Name: TABLE watch_bindings; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.watch_bindings TO radar_core_runtime;


--
-- Name: TABLE watch_listing_matches; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.watch_listing_matches TO radar_core_runtime;


--
-- Name: TABLE watch_profiles; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.watch_profiles TO radar_core_runtime;


--
-- Name: TABLE watch_runs; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.watch_runs TO radar_core_runtime;


--
-- Name: TABLE watch_run_listing_observations; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.watch_run_listing_observations TO radar_core_runtime;


--
-- Name: TABLE web_search_cache; Type: ACL; Schema: radar_core; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE radar_core.web_search_cache TO radar_core_runtime;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: radar_core; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE jpgr_owner IN SCHEMA radar_core GRANT ALL ON SEQUENCES TO radar_core_runtime;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: radar_core; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE jpgr_owner IN SCHEMA radar_core GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO radar_core_runtime;

--
-- P1 investment price facts and verified-sale evidence
--

CREATE UNIQUE INDEX sale_records_verified_yahoo_sale_unique_idx
  ON radar_analytics.sale_records(source_listing_id,source_sale_id)
  WHERE source_sale_id IS NOT NULL
    AND evidence ->> 'evidenceBoundary' = 'source_closed_auction_with_positive_bid';

CREATE FUNCTION radar_analytics.safe_positive_jpy(p_value text) RETURNS integer
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT CASE
    WHEN btrim(COALESCE(p_value,'')) ~ '^[1-9][0-9]{0,9}$' THEN
      CASE WHEN btrim(p_value)::numeric <= 1000000000 THEN btrim(p_value)::integer ELSE NULL END
    ELSE NULL
  END
$$;

ALTER FUNCTION radar_analytics.safe_positive_jpy(text) OWNER TO jpgr_owner;

CREATE FUNCTION radar_analytics.capture_verified_sale_evidence() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'radar_analytics'
    AS $$
DECLARE
  v_evidence jsonb := NEW.raw_metadata -> 'verifiedSaleEvidence';
  v_sold_price integer;
  v_bid_count integer;
  v_sold_at timestamptz;
BEGIN
  IF NEW.source_id <> 'yahoo_auctions_jp'
    OR jsonb_typeof(v_evidence) IS DISTINCT FROM 'object'
    OR v_evidence ->> 'evidenceVersion' IS DISTINCT FROM 'verified-sale-v1'
    OR v_evidence ->> 'kind' IS DISTINCT FROM 'closed_auction_with_bid'
    OR v_evidence ->> 'sourceStatus' IS DISTINCT FROM 'CLOSED'
    OR v_evidence ->> 'sourceSaleId' IS DISTINCT FROM NEW.source_item_id
  THEN
    RETURN NEW;
  END IF;

  v_sold_price := radar_analytics.safe_positive_jpy(v_evidence ->> 'soldPriceJpy');
  v_bid_count := radar_analytics.safe_positive_jpy(v_evidence ->> 'bidCount');
  IF v_sold_price IS NULL
    OR v_bid_count IS NULL
    OR NEW.current_price_jpy IS DISTINCT FROM v_sold_price
  THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_sold_at := (v_evidence ->> 'soldAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  IF v_sold_at > NEW.last_seen_at + interval '5 minutes' THEN
    RETURN NEW;
  END IF;

  INSERT INTO radar_analytics.sale_records(
    source_listing_id,source_sale_id,sold_price_jpy,sold_at,evidence_url,evidence
  ) VALUES (
    NEW.id,
    NEW.source_item_id,
    v_sold_price,
    v_sold_at,
    NEW.canonical_url,
    v_evidence || jsonb_build_object(
      'evidenceBoundary','source_closed_auction_with_positive_bid',
      'capturedFrom','source_listing.raw_metadata'
    )
  )
  ON CONFLICT (source_listing_id,source_sale_id)
    WHERE source_sale_id IS NOT NULL
      AND evidence ->> 'evidenceBoundary' = 'source_closed_auction_with_positive_bid'
  DO NOTHING;
  RETURN NEW;
END
$$;

ALTER FUNCTION radar_analytics.capture_verified_sale_evidence() OWNER TO jpgr_owner;

CREATE TRIGGER source_listings_capture_verified_sale
AFTER INSERT OR UPDATE OF current_price_jpy,raw_metadata,last_seen_at
ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.capture_verified_sale_evidence();

CREATE VIEW radar_analytics.strategy_price_facts_core_v1
WITH (security_invoker='true')
AS
WITH observation_base AS (
  SELECT
    observation.run_id,
    observation.source_listing_id,
    observation.price_jpy,
    observation.original_price_jpy,
    observation.price_basis,
    observation.item_condition,
    observation.availability,
    observation.observed_at,
    observation.position,
    observation.is_new_for_query,
    observation.payload_hash,
    COALESCE(observation_payload.payload, observation.listing_payload) AS listing_payload,
    listing.source_id,
    listing.source_item_id,
    listing.product_key,
    listing.product_match_method,
    listing.title,
    listing.canonical_url,
    listing.currency,
    search_run.ingested_at AS knowledge_at,
    CASE
      WHEN jsonb_typeof(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}') = 'array'
      THEN COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}'
      ELSE '[]'::jsonb
    END AS price_references
  FROM radar_analytics.listing_observations AS observation
  LEFT JOIN radar_analytics.listing_payloads AS observation_payload ON observation_payload.payload_hash=observation.payload_hash
  JOIN radar_analytics.source_listings AS listing ON listing.id=observation.source_listing_id
  JOIN radar_analytics.search_runs AS search_run ON search_run.id=observation.run_id
),
observation_facts AS (
  SELECT
    'search:' || base.run_id::text || ':' || base.source_listing_id::text || ':ask' AS price_fact_id,
    CASE
      WHEN base.price_basis='auction_current_bid' THEN 'auction_current_bid'
      WHEN base.availability='sold_out' THEN 'source_sold_status_price'
      WHEN base.item_condition='new'
        OR (base.source_id IN ('rakuten_ichiba','rakuten_books','yahoo_shopping','charaon','cospa','animate')
          AND base.item_condition<>'used')
      THEN 'new_retail_ask'
      ELSE 'acquisition_ask'
    END AS price_role,
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,base.price_jpy::integer AS amount_jpy,base.currency,base.price_basis,
    base.item_condition,base.availability,
    CASE WHEN base.listing_payload #>> '{facts,priceContext,taxStatus}' IN ('included','excluded','unknown')
      THEN base.listing_payload #>> '{facts,priceContext,taxStatus}' ELSE 'unknown' END AS tax_status,
    CASE WHEN base.listing_payload #>> '{facts,priceContext,shippingStatus}' IN ('included','separate','free','unknown')
      THEN base.listing_payload #>> '{facts,priceContext,shippingStatus}' ELSE 'unknown' END AS shipping_status,
    base.observed_at AS occurred_at,base.knowledge_at,'search_observation'::text AS evidence_kind,
    base.run_id::text AS evidence_id,base.canonical_url AS evidence_url,
    jsonb_strip_nulls(jsonb_build_object(
      'payloadHash',base.payload_hash,'position',base.position,'isNewForQuery',base.is_new_for_query
    )) AS evidence
  FROM observation_base AS base
  WHERE base.price_jpy > 0

  UNION ALL

  SELECT
    'search:' || base.run_id::text || ':' || base.source_listing_id::text || ':reference:' || reference.ordinality::text,
    reference.value ->> 'kind',
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,
    radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'),
    COALESCE(NULLIF(reference.value ->> 'currency',''),base.currency),
    base.price_basis,base.item_condition,base.availability,
    CASE WHEN reference.value ->> 'taxStatus' IN ('included','excluded','unknown')
      THEN reference.value ->> 'taxStatus' ELSE 'unknown' END,
    CASE WHEN reference.value ->> 'shippingStatus' IN ('included','separate','free','unknown')
      THEN reference.value ->> 'shippingStatus' ELSE 'unknown' END,
    base.observed_at,base.knowledge_at,'search_observation'::text,base.run_id::text,base.canonical_url,
    jsonb_strip_nulls(jsonb_build_object(
      'payloadHash',base.payload_hash,'sourceLabel',reference.value ->> 'sourceLabel'
    ))
  FROM observation_base AS base
  CROSS JOIN LATERAL jsonb_array_elements(base.price_references)
    WITH ORDINALITY AS reference(value,ordinality)
  WHERE reference.value ->> 'kind' IN ('official_list','source_compare_at')
    AND radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy') IS NOT NULL

  UNION ALL

  SELECT
    'search:' || base.run_id::text || ':' || base.source_listing_id::text || ':legacy-reference',
    'source_compare_at',
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,base.original_price_jpy::integer,base.currency,base.price_basis,
    base.item_condition,base.availability,'unknown','unknown',
    base.observed_at,base.knowledge_at,'search_observation'::text,base.run_id::text,base.canonical_url,
    jsonb_strip_nulls(jsonb_build_object('payloadHash',base.payload_hash,'legacyOriginalPrice',true))
  FROM observation_base AS base
  WHERE base.original_price_jpy > 0 AND jsonb_array_length(base.price_references)=0
),
operational_base AS (
  SELECT
    snapshot.external_snapshot_id,
    snapshot.source_listing_id,
    radar_analytics.safe_positive_jpy(snapshot.payload ->> 'price') AS price_jpy,
    radar_analytics.safe_positive_jpy(snapshot.payload ->> 'originalPrice') AS original_price_jpy,
    CASE WHEN snapshot.payload ->> 'priceBasis' IN ('listing_price','catalog_price','offer_price','auction_current_bid')
      THEN snapshot.payload ->> 'priceBasis' ELSE NULL END AS price_basis,
    COALESCE(NULLIF(snapshot.payload ->> 'condition',''),listing.item_condition) AS item_condition,
    COALESCE(NULLIF(snapshot.payload ->> 'availability',''),listing.availability) AS availability,
    COALESCE(NULLIF(snapshot.payload ->> 'currency',''),listing.currency) AS currency,
    snapshot.observed_at,
    snapshot.created_at AS knowledge_at,
    snapshot.content_hash,
    snapshot.payload,
    listing.source_id,
    listing.source_item_id,
    listing.product_key,
    listing.product_match_method,
    listing.title,
    listing.canonical_url,
    CASE
      WHEN jsonb_typeof(snapshot.payload #> '{facts,priceReferences}') = 'array'
      THEN snapshot.payload #> '{facts,priceReferences}'
      ELSE '[]'::jsonb
    END AS price_references
  FROM radar_analytics.operational_listing_snapshots AS snapshot
  JOIN radar_analytics.source_listings AS listing ON listing.id=snapshot.source_listing_id
),
operational_facts AS (
  SELECT
    'operational:' || base.external_snapshot_id || ':ask',
    CASE
      WHEN base.price_basis='auction_current_bid' THEN 'auction_current_bid'
      WHEN base.availability='sold_out' THEN 'source_sold_status_price'
      WHEN base.price_basis IS NULL THEN 'unclassified_ask'
      WHEN base.item_condition='new'
        OR (base.source_id IN ('rakuten_ichiba','rakuten_books','yahoo_shopping','charaon','cospa','animate')
          AND base.item_condition<>'used')
      THEN 'new_retail_ask'
      ELSE 'acquisition_ask'
    END,
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,base.price_jpy,base.currency,COALESCE(base.price_basis,'unknown'),
    base.item_condition,base.availability,
    CASE WHEN base.payload #>> '{facts,priceContext,taxStatus}' IN ('included','excluded','unknown')
      THEN base.payload #>> '{facts,priceContext,taxStatus}' ELSE 'unknown' END,
    CASE WHEN base.payload #>> '{facts,priceContext,shippingStatus}' IN ('included','separate','free','unknown')
      THEN base.payload #>> '{facts,priceContext,shippingStatus}' ELSE 'unknown' END,
    base.observed_at,base.knowledge_at,'operational_snapshot'::text,base.external_snapshot_id,
    base.canonical_url,jsonb_build_object('contentHash',base.content_hash)
  FROM operational_base AS base
  WHERE base.price_jpy IS NOT NULL

  UNION ALL

  SELECT
    'operational:' || base.external_snapshot_id || ':reference:' || reference.ordinality::text,
    reference.value ->> 'kind',
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,
    radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'),
    COALESCE(NULLIF(reference.value ->> 'currency',''),base.currency),COALESCE(base.price_basis,'unknown'),
    base.item_condition,base.availability,
    CASE WHEN reference.value ->> 'taxStatus' IN ('included','excluded','unknown')
      THEN reference.value ->> 'taxStatus' ELSE 'unknown' END,
    CASE WHEN reference.value ->> 'shippingStatus' IN ('included','separate','free','unknown')
      THEN reference.value ->> 'shippingStatus' ELSE 'unknown' END,
    base.observed_at,base.knowledge_at,'operational_snapshot'::text,base.external_snapshot_id,
    base.canonical_url,jsonb_strip_nulls(jsonb_build_object(
      'contentHash',base.content_hash,'sourceLabel',reference.value ->> 'sourceLabel'
    ))
  FROM operational_base AS base
  CROSS JOIN LATERAL jsonb_array_elements(base.price_references)
    WITH ORDINALITY AS reference(value,ordinality)
  WHERE reference.value ->> 'kind' IN ('official_list','source_compare_at')
    AND radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy') IS NOT NULL

  UNION ALL

  SELECT
    'operational:' || base.external_snapshot_id || ':legacy-reference',
    'source_compare_at',
    base.source_listing_id,base.source_id,base.source_item_id,base.product_key,base.product_match_method,
    base.title,base.canonical_url,base.original_price_jpy,base.currency,COALESCE(base.price_basis,'unknown'),
    base.item_condition,base.availability,'unknown','unknown',
    base.observed_at,base.knowledge_at,'operational_snapshot'::text,base.external_snapshot_id,
    base.canonical_url,jsonb_build_object('contentHash',base.content_hash,'legacyOriginalPrice',true)
  FROM operational_base AS base
  WHERE base.original_price_jpy IS NOT NULL AND jsonb_array_length(base.price_references)=0
),
verified_sale_facts AS (
  SELECT
    'verified-sale:' || sale.id::text AS price_fact_id,
    'verified_sale'::text AS price_role,
    listing.id AS source_listing_id,listing.source_id,listing.source_item_id,
    listing.product_key,listing.product_match_method,listing.title,listing.canonical_url,
    sale.sold_price_jpy::integer AS amount_jpy,listing.currency,'listing_price'::text AS price_basis,
    listing.item_condition,listing.availability,'unknown'::text AS tax_status,'unknown'::text AS shipping_status,
    sale.sold_at AS occurred_at,sale.recorded_at AS knowledge_at,'verified_sale_record'::text AS evidence_kind,
    sale.id::text AS evidence_id,COALESCE(sale.evidence_url,listing.canonical_url) AS evidence_url,sale.evidence
  FROM radar_analytics.sale_records AS sale
  JOIN radar_analytics.source_listings AS listing ON listing.id=sale.source_listing_id
  WHERE sale.sold_price_jpy > 0
),
all_facts AS (
  SELECT * FROM observation_facts
  UNION ALL
  SELECT * FROM operational_facts
  UNION ALL
  SELECT * FROM verified_sale_facts
)
SELECT
  'price-facts-v1'::text AS fact_semantics_version,
  fact.price_fact_id,
  fact.price_role,
  identity.product_variant_id,
  identity.identity_known_at,
  fact.source_listing_id,
  fact.source_id,
  fact.source_item_id,
  fact.product_key,
  fact.product_match_method,
  fact.title,
  fact.canonical_url,
  fact.amount_jpy,
  fact.currency,
  fact.price_basis,
  fact.item_condition,
  fact.availability,
  fact.tax_status,
  fact.shipping_status,
  fact.occurred_at,
  fact.knowledge_at,
  fact.evidence_kind,
  fact.evidence_id,
  fact.evidence_url,
  fact.evidence
FROM all_facts AS fact
LEFT JOIN LATERAL (
  SELECT
    membership.product_variant_id,
    membership.valid_from AS identity_known_at
  FROM radar_analytics.product_listing_memberships AS membership
  WHERE membership.source_listing_id=fact.source_listing_id
    AND membership.decision='confirmed'
    AND membership.is_current
  ORDER BY membership.valid_from DESC,membership.id DESC
  LIMIT 1
) AS identity ON true;

CREATE VIEW radar_analytics.strategy_price_facts_v1
WITH (security_invoker='true')
AS
WITH legacy_surugaya_official_list AS (
  SELECT
    'price-facts-v1'::text AS fact_semantics_version,
    'search:' || observation.run_id::text || ':' || observation.source_listing_id::text
      || ':legacy-official-list' AS price_fact_id,
    'official_list'::text AS price_role,
    identity.product_variant_id,
    identity.identity_known_at,
    observation.source_listing_id,
    listing.source_id,
    listing.source_item_id,
    listing.product_key,
    listing.product_match_method,
    listing.title,
    listing.canonical_url,
    radar_analytics.safe_positive_jpy(
      COALESCE(observation_payload.payload, observation.listing_payload) #>> '{rawMetadata,referenceListPrice}'
    ) AS amount_jpy,
    listing.currency,
    COALESCE(observation.price_basis,'unknown') AS price_basis,
    observation.item_condition,
    observation.availability,
    'unknown'::text AS tax_status,
    'unknown'::text AS shipping_status,
    observation.observed_at AS occurred_at,
    search_run.ingested_at AS knowledge_at,
    'search_observation'::text AS evidence_kind,
    observation.run_id::text AS evidence_id,
    listing.canonical_url AS evidence_url,
    jsonb_build_object(
      'payloadHash',observation.payload_hash,
      'sourceLabel','骏河屋商品详情「定価」',
      'legacyRawMetadataReferenceListPrice',true
    ) AS evidence
  FROM radar_analytics.listing_observations AS observation
  LEFT JOIN radar_analytics.listing_payloads AS observation_payload ON observation_payload.payload_hash=observation.payload_hash
  JOIN radar_analytics.source_listings AS listing
    ON listing.id=observation.source_listing_id
  JOIN radar_analytics.search_runs AS search_run
    ON search_run.id=observation.run_id
  LEFT JOIN LATERAL (
    SELECT
      membership.product_variant_id,
      membership.valid_from AS identity_known_at
    FROM radar_analytics.product_listing_memberships AS membership
    WHERE membership.source_listing_id=observation.source_listing_id
      AND membership.decision='confirmed'
      AND membership.is_current
    ORDER BY membership.valid_from DESC,membership.id DESC
    LIMIT 1
  ) AS identity ON true
  WHERE listing.source_id='surugaya'
    AND radar_analytics.safe_positive_jpy(
      COALESCE(observation_payload.payload, observation.listing_payload) #>> '{rawMetadata,referenceListPrice}'
    ) IS NOT NULL
    AND radar_analytics.safe_positive_jpy(
      COALESCE(observation_payload.payload, observation.listing_payload) ->> 'originalPrice'
    ) IS NULL
    AND CASE
      WHEN jsonb_typeof(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}')='array'
      THEN jsonb_array_length(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}')=0
      ELSE true
    END
)
SELECT * FROM radar_analytics.strategy_price_facts_core_v1
UNION ALL
SELECT * FROM legacy_surugaya_official_list;

REVOKE ALL ON FUNCTION radar_analytics.safe_positive_jpy(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radar_analytics.safe_positive_jpy(text) TO radar_analytics_runtime;
REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence()
  FROM radar_analytics_runtime;
COMMENT ON VIEW radar_analytics.strategy_price_facts_core_v1 IS
  'Internal P1 core facts retained behind the public compatibility wrapper.';
REVOKE ALL ON TABLE radar_analytics.strategy_price_facts_core_v1 FROM PUBLIC;
GRANT SELECT ON TABLE radar_analytics.strategy_price_facts_core_v1
  TO radar_analytics_runtime;
REVOKE ALL ON TABLE radar_analytics.strategy_price_facts_v1 FROM PUBLIC;
GRANT SELECT ON TABLE radar_analytics.strategy_price_facts_v1 TO radar_analytics_runtime;

COMMENT ON COLUMN radar_core.listing_snapshots.price_basis IS
  'Point-in-time price meaning. Null is retained for legacy snapshots rather than guessing from the latest listing state.';
COMMENT ON VIEW radar_analytics.strategy_price_facts_v1 IS
  'P1 point-in-time price-fact contract, including explicit historical Surugaya list-price evidence.';
COMMENT ON COLUMN radar_analytics.strategy_price_facts_v1.knowledge_at IS
  'First database knowledge timestamp. Point-in-time backtests must filter knowledge_at <= decision time.';

RESET ROLE;

--
-- PostgreSQL database dump complete
--
