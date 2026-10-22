-- Analytics outbox delivery is at-least-once and may be reordered. A stale
-- automatic projection must never replace a newer automatic decision or an
-- explicit human decision.
CREATE OR REPLACE FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, radar_analytics
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

REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  TO radar_analytics_runtime;
