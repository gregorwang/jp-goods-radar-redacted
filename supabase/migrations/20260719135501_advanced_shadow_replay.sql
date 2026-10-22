-- Persist compact, leakage-safe advanced-intelligence shadow replay results.
-- Raw listing payloads and observations remain in their existing immutable
-- evidence tables; this layer stores only versioned deterministic features,
-- gates, and hashes required to audit a replay.

CREATE TABLE radar_analytics.advanced_shadow_replay_runs (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE CHECK (btrim(dedupe_key) <> ''),
  replay_day date NOT NULL,
  as_of timestamptz NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'backfill')),
  runner_version text NOT NULL CHECK (btrim(runner_version) <> ''),
  metric_version text NOT NULL CHECK (btrim(metric_version) <> ''),
  policy_version text NOT NULL CHECK (btrim(policy_version) <> ''),
  corpus_hash text NOT NULL CHECK (corpus_hash ~ '^[a-f0-9]{64}$'),
  confirmed_variant_count integer NOT NULL CHECK (confirmed_variant_count >= 0),
  confirmed_listing_count integer NOT NULL CHECK (confirmed_listing_count >= 0),
  verified_sale_count integer NOT NULL CHECK (verified_sale_count >= 0),
  observation_span_days numeric(12,1) NOT NULL CHECK (observation_span_days >= 0),
  result_variant_count integer NOT NULL CHECK (result_variant_count >= 0),
  shadow_ready_capability_count integer NOT NULL CHECK (shadow_ready_capability_count >= 0),
  insufficient_capability_count integer NOT NULL CHECK (insufficient_capability_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (replay_day = timezone('Asia/Tokyo', as_of)::date)
);

CREATE INDEX advanced_shadow_replay_runs_time_idx
  ON radar_analytics.advanced_shadow_replay_runs(as_of DESC, id DESC);

CREATE TABLE radar_analytics.advanced_shadow_replay_variants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL
    REFERENCES radar_analytics.advanced_shadow_replay_runs(id) ON DELETE RESTRICT,
  product_variant_id text NOT NULL
    REFERENCES radar_analytics.product_variants(id) ON DELETE RESTRICT,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  independent_appearance_min integer NOT NULL CHECK (independent_appearance_min >= 0),
  independent_appearance_max integer NOT NULL CHECK (independent_appearance_max >= independent_appearance_min),
  source_count integer NOT NULL CHECK (source_count >= 0),
  source_dated_listing_count integer NOT NULL CHECK (source_dated_listing_count >= 0),
  source_date_coverage_percent integer NOT NULL CHECK (source_date_coverage_percent BETWEEN 0 AND 100),
  source_date_span_days numeric(12,1) NOT NULL CHECK (source_date_span_days >= 0),
  source_month_count integer NOT NULL CHECK (source_month_count >= 0),
  observation_span_days numeric(12,1) NOT NULL CHECK (observation_span_days >= 0),
  completed_active_duration_count integer NOT NULL CHECK (completed_active_duration_count >= 0),
  right_censored_active_count integer NOT NULL CHECK (right_censored_active_count >= 0),
  verified_sale_count integer NOT NULL CHECK (verified_sale_count >= 0),
  verified_sale_price_count integer NOT NULL CHECK (verified_sale_price_count >= 0),
  comparable_price_sample_count integer NOT NULL CHECK (comparable_price_sample_count >= 0),
  landed_cost_offer_count integer NOT NULL CHECK (landed_cost_offer_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, product_variant_id)
);

CREATE INDEX advanced_shadow_replay_variants_product_idx
  ON radar_analytics.advanced_shadow_replay_variants(product_variant_id, run_id);

CREATE TABLE radar_analytics.advanced_shadow_replay_capabilities (
  variant_result_id bigint NOT NULL
    REFERENCES radar_analytics.advanced_shadow_replay_variants(id) ON DELETE RESTRICT,
  capability text NOT NULL
    CHECK (capability IN ('scarcity', 'liquidity', 'seasonality', 'dealScore', 'resaleEconomics')),
  status text NOT NULL CHECK (status IN ('insufficient_evidence', 'shadow_ready')),
  production_output_allowed boolean NOT NULL DEFAULT false
    CHECK (production_output_allowed = false),
  failure_reasons jsonb NOT NULL CHECK (jsonb_typeof(failure_reasons) = 'array'),
  gates jsonb NOT NULL CHECK (jsonb_typeof(gates) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_result_id, capability)
);

CREATE OR REPLACE FUNCTION radar_analytics.record_advanced_shadow_replay(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, radar_analytics
AS $$
DECLARE
  v_run_id uuid;
  v_existing_id uuid;
  v_dedupe_key text;
  v_as_of timestamptz;
  v_replay_day date;
  v_variant jsonb;
  v_variant_result_id bigint;
  v_capability record;
  v_variant_count integer;
  v_shadow_ready_count integer;
  v_insufficient_count integer;
  v_capability_key_count integer;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload -> 'corpus') <> 'object'
     OR jsonb_typeof(p_payload -> 'variants') <> 'array' THEN
    RAISE EXCEPTION 'advanced_shadow_replay_payload_invalid';
  END IF;

  v_run_id := (p_payload ->> 'id')::uuid;
  v_dedupe_key := btrim(p_payload ->> 'dedupeKey');
  v_as_of := (p_payload ->> 'asOf')::timestamptz;
  v_replay_day := (p_payload ->> 'replayDay')::date;
  IF v_dedupe_key IS NULL OR v_dedupe_key = ''
     OR v_as_of > now() + interval '5 minutes'
     OR v_replay_day <> timezone('Asia/Tokyo', v_as_of)::date THEN
    RAISE EXCEPTION 'advanced_shadow_replay_identity_invalid';
  END IF;

  SELECT id INTO v_existing_id
  FROM radar_analytics.advanced_shadow_replay_runs
  WHERE dedupe_key = v_dedupe_key;
  IF FOUND THEN
    RETURN v_existing_id;
  END IF;

  v_variant_count := jsonb_array_length(p_payload -> 'variants');
  SELECT
    count(*) FILTER (WHERE capability.value ->> 'status' = 'shadow_ready')::integer,
    count(*) FILTER (WHERE capability.value ->> 'status' = 'insufficient_evidence')::integer
  INTO v_shadow_ready_count, v_insufficient_count
  FROM jsonb_array_elements(p_payload -> 'variants') AS variants(value)
  CROSS JOIN LATERAL jsonb_each(variants.value -> 'capabilities') AS capability(key, value);

  IF coalesce(v_shadow_ready_count, 0) + coalesce(v_insufficient_count, 0) <> v_variant_count * 5 THEN
    RAISE EXCEPTION 'advanced_shadow_replay_capability_count_invalid';
  END IF;

  INSERT INTO radar_analytics.advanced_shadow_replay_runs(
    id, dedupe_key, replay_day, as_of, trigger_type, runner_version,
    metric_version, policy_version, corpus_hash,
    confirmed_variant_count, confirmed_listing_count, verified_sale_count,
    observation_span_days, result_variant_count,
    shadow_ready_capability_count, insufficient_capability_count
  ) VALUES (
    v_run_id, v_dedupe_key, v_replay_day, v_as_of,
    p_payload ->> 'triggerType', p_payload ->> 'runnerVersion',
    p_payload ->> 'metricVersion', p_payload ->> 'policyVersion',
    p_payload ->> 'corpusHash',
    (p_payload #>> '{corpus,confirmedVariantCount}')::integer,
    (p_payload #>> '{corpus,confirmedListingCount}')::integer,
    (p_payload #>> '{corpus,verifiedSaleCount}')::integer,
    (p_payload #>> '{corpus,observationSpanDays}')::numeric,
    v_variant_count, coalesce(v_shadow_ready_count, 0), coalesce(v_insufficient_count, 0)
  );

  FOR v_variant IN
    SELECT value FROM jsonb_array_elements(p_payload -> 'variants')
  LOOP
    IF jsonb_typeof(v_variant -> 'evidence') <> 'object'
       OR jsonb_typeof(v_variant -> 'capabilities') <> 'object'
       OR NOT ((v_variant -> 'capabilities') ?& ARRAY[
         'scarcity', 'liquidity', 'seasonality', 'dealScore', 'resaleEconomics'
       ]) THEN
      RAISE EXCEPTION 'advanced_shadow_replay_variant_invalid';
    END IF;
    SELECT count(*)::integer INTO v_capability_key_count
    FROM jsonb_object_keys(v_variant -> 'capabilities');
    IF v_capability_key_count <> 5 THEN
      RAISE EXCEPTION 'advanced_shadow_replay_variant_capabilities_invalid';
    END IF;

    INSERT INTO radar_analytics.advanced_shadow_replay_variants(
      run_id, product_variant_id, evidence_hash,
      independent_appearance_min, independent_appearance_max, source_count,
      source_dated_listing_count, source_date_coverage_percent,
      source_date_span_days, source_month_count, observation_span_days,
      completed_active_duration_count, right_censored_active_count,
      verified_sale_count, verified_sale_price_count,
      comparable_price_sample_count, landed_cost_offer_count
    ) VALUES (
      v_run_id, v_variant ->> 'productVariantId', v_variant ->> 'evidenceHash',
      (v_variant #>> '{evidence,independentAppearanceMin}')::integer,
      (v_variant #>> '{evidence,independentAppearanceMax}')::integer,
      (v_variant #>> '{evidence,sourceCount}')::integer,
      (v_variant #>> '{evidence,sourceDatedListingCount}')::integer,
      (v_variant #>> '{evidence,sourceDateCoveragePercent}')::integer,
      (v_variant #>> '{evidence,sourceDateSpanDays}')::numeric,
      (v_variant #>> '{evidence,sourceMonthCount}')::integer,
      (v_variant #>> '{evidence,observationSpanDays}')::numeric,
      (v_variant #>> '{evidence,completedActiveDurationCount}')::integer,
      (v_variant #>> '{evidence,rightCensoredActiveCount}')::integer,
      (v_variant #>> '{evidence,verifiedSaleCount}')::integer,
      (v_variant #>> '{evidence,verifiedSalePriceCount}')::integer,
      (v_variant #>> '{evidence,comparablePriceSampleCount}')::integer,
      (v_variant #>> '{evidence,landedCostOfferCount}')::integer
    ) RETURNING id INTO v_variant_result_id;

    FOR v_capability IN
      SELECT key, value FROM jsonb_each(v_variant -> 'capabilities')
    LOOP
      IF jsonb_typeof(v_capability.value -> 'reasons') <> 'array'
         OR jsonb_typeof(v_capability.value -> 'gates') <> 'array'
         OR coalesce((v_capability.value ->> 'productionOutputAllowed')::boolean, false) THEN
        RAISE EXCEPTION 'advanced_shadow_replay_capability_invalid:%', v_capability.key;
      END IF;
      INSERT INTO radar_analytics.advanced_shadow_replay_capabilities(
        variant_result_id, capability, status, production_output_allowed,
        failure_reasons, gates
      ) VALUES (
        v_variant_result_id, v_capability.key, v_capability.value ->> 'status', false,
        v_capability.value -> 'reasons', v_capability.value -> 'gates'
      );
    END LOOP;
  END LOOP;

  RETURN v_run_id;
END
$$;

ALTER TABLE radar_analytics.advanced_shadow_replay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_analytics.advanced_shadow_replay_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_analytics.advanced_shadow_replay_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY advanced_shadow_replay_runs_runtime_select
  ON radar_analytics.advanced_shadow_replay_runs
  FOR SELECT TO radar_analytics_runtime USING (true);
CREATE POLICY advanced_shadow_replay_variants_runtime_select
  ON radar_analytics.advanced_shadow_replay_variants
  FOR SELECT TO radar_analytics_runtime USING (true);
CREATE POLICY advanced_shadow_replay_capabilities_runtime_select
  ON radar_analytics.advanced_shadow_replay_capabilities
  FOR SELECT TO radar_analytics_runtime USING (true);

REVOKE ALL ON radar_analytics.advanced_shadow_replay_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.advanced_shadow_replay_variants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.advanced_shadow_replay_capabilities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.record_advanced_shadow_replay(jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON radar_analytics.advanced_shadow_replay_runs TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.advanced_shadow_replay_variants TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.advanced_shadow_replay_capabilities TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.record_advanced_shadow_replay(jsonb)
  TO radar_analytics_runtime;

COMMENT ON TABLE radar_analytics.advanced_shadow_replay_runs IS
  'Append-only replay manifests at an explicit evidence cutoff; never a production model approval.';
COMMENT ON TABLE radar_analytics.advanced_shadow_replay_variants IS
  'Compact deterministic feature snapshots; raw listing and response payloads remain in their source evidence tables.';
COMMENT ON TABLE radar_analytics.advanced_shadow_replay_capabilities IS
  'Versioned readiness gate outcomes. production_output_allowed is structurally locked to false.';
