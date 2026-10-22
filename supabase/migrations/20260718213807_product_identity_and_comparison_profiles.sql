-- Stable product identity is intentionally separate from source listings.
-- A listing remains source-owned evidence; membership is a versioned claim
-- produced by a Workflow (or, later, by an explicit human decision).
CREATE TABLE radar_analytics.canonical_products (
  id text PRIMARY KEY CHECK (id ~ '^cp_[0-9a-f]{24}$'),
  identity_hash text NOT NULL UNIQUE CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  identity_version text NOT NULL,
  canonical_name text NOT NULL CHECK (btrim(canonical_name) <> ''),
  work_title text,
  character_names jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(character_names) = 'array'),
  product_type text,
  manufacturer text,
  series text,
  target_fingerprint jsonb NOT NULL
    CHECK (jsonb_typeof(target_fingerprint) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE radar_analytics.product_variants (
  id text PRIMARY KEY CHECK (id ~ '^pv_[0-9a-f]{24}$'),
  canonical_product_id text NOT NULL
    REFERENCES radar_analytics.canonical_products(id) ON DELETE RESTRICT,
  identity_hash text NOT NULL UNIQUE CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  identity_version text NOT NULL,
  variant_name text NOT NULL CHECK (btrim(variant_name) <> ''),
  model text,
  jan text,
  size text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object'),
  target_fingerprint jsonb NOT NULL
    CHECK (jsonb_typeof(target_fingerprint) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX product_variants_canonical_product_idx
  ON radar_analytics.product_variants(canonical_product_id, created_at DESC);

-- A profile is a versioned rule set. The comparison bucket itself is emitted
-- per analysis and is never treated as permanent product identity.
CREATE TABLE radar_analytics.comparison_profiles (
  id text PRIMARY KEY CHECK (id ~ '^cmp_[0-9a-f]{24}_v[0-9]+$'),
  product_variant_id text NOT NULL
    REFERENCES radar_analytics.product_variants(id) ON DELETE CASCADE,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  rule_version text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  condition_policy text NOT NULL
    CHECK (condition_policy IN ('strict_same_condition', 'broad_public_asking_price')),
  allowed_conditions jsonb NOT NULL CHECK (jsonb_typeof(allowed_conditions) = 'array'),
  allowed_completeness jsonb NOT NULL CHECK (jsonb_typeof(allowed_completeness) = 'array'),
  allowed_price_bases jsonb NOT NULL CHECK (jsonb_typeof(allowed_price_bases) = 'array'),
  allowed_official_statuses jsonb NOT NULL CHECK (jsonb_typeof(allowed_official_statuses) = 'array'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  superseded_at timestamptz,
  UNIQUE (product_variant_id, profile_version)
);

CREATE UNIQUE INDEX comparison_profiles_active_variant_idx
  ON radar_analytics.comparison_profiles(product_variant_id)
  WHERE active;
CREATE INDEX comparison_profiles_variant_idx
  ON radar_analytics.comparison_profiles(product_variant_id, profile_version DESC);

CREATE TABLE radar_analytics.product_listing_memberships (
  id text PRIMARY KEY CHECK (id ~ '^pm_[0-9a-f]{32}$'),
  product_variant_id text NOT NULL
    REFERENCES radar_analytics.product_variants(id) ON DELETE CASCADE,
  source_listing_id bigint NOT NULL
    REFERENCES radar_analytics.source_listings(id) ON DELETE CASCADE,
  search_run_id uuid
    REFERENCES radar_analytics.search_runs(id) ON DELETE SET NULL,
  workflow_task_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('confirmed', 'rejected', 'uncertain')),
  decision_source text NOT NULL
    CHECK (decision_source IN ('workflow_matcher', 'workflow_ai', 'human')),
  relation text NOT NULL
    CHECK (relation IN ('exact', 'probable_exact', 'variant', 'bundle', 'related', 'irrelevant', 'uncertain')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  membership_version text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  is_current boolean NOT NULL DEFAULT true,
  supersedes_membership_id text
    REFERENCES radar_analytics.product_listing_memberships(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  CHECK ((is_current AND valid_to IS NULL) OR (NOT is_current AND valid_to IS NOT NULL))
);

CREATE UNIQUE INDEX product_listing_memberships_current_idx
  ON radar_analytics.product_listing_memberships(product_variant_id, source_listing_id)
  WHERE is_current;
CREATE INDEX product_listing_memberships_variant_history_idx
  ON radar_analytics.product_listing_memberships(product_variant_id, valid_from DESC);
CREATE INDEX product_listing_memberships_source_listing_idx
  ON radar_analytics.product_listing_memberships(source_listing_id, valid_from DESC);
CREATE INDEX product_listing_memberships_search_run_idx
  ON radar_analytics.product_listing_memberships(search_run_id)
  WHERE search_run_id IS NOT NULL;
CREATE INDEX product_listing_memberships_workflow_idx
  ON radar_analytics.product_listing_memberships(workflow_task_id, valid_from DESC);
CREATE INDEX product_listing_memberships_supersedes_idx
  ON radar_analytics.product_listing_memberships(supersedes_membership_id)
  WHERE supersedes_membership_id IS NOT NULL;

CREATE VIEW radar_analytics.current_product_listing_memberships
WITH (security_invoker = true)
AS
SELECT membership.*
FROM radar_analytics.product_listing_memberships AS membership
WHERE membership.is_current;

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

    -- An automatic replay may add evidence, but it may never replace an
    -- explicit human identity decision.
    IF FOUND AND v_current.decision_source = 'human'
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

REVOKE ALL ON radar_analytics.canonical_products FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.product_variants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.comparison_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.product_listing_memberships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.current_product_listing_memberships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON radar_analytics.canonical_products TO radar_analytics_runtime;
GRANT SELECT, INSERT, UPDATE ON radar_analytics.product_variants TO radar_analytics_runtime;
GRANT SELECT, INSERT, UPDATE ON radar_analytics.comparison_profiles TO radar_analytics_runtime;
GRANT SELECT, INSERT, UPDATE ON radar_analytics.product_listing_memberships TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.current_product_listing_memberships TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  TO radar_analytics_runtime;

COMMENT ON TABLE radar_analytics.canonical_products IS
  'Stable official product concepts derived from explicit exact-product targets; never source listing rows.';
COMMENT ON TABLE radar_analytics.product_variants IS
  'Conservative sellable variant identities. Ambiguous variants remain separate instead of being collapsed.';
COMMENT ON TABLE radar_analytics.product_listing_memberships IS
  'Append-only versioned claims connecting source listings to variants. Sold status is not transaction proof.';
COMMENT ON TABLE radar_analytics.comparison_profiles IS
  'Versioned sample-selection rules. A concrete comparison bucket is computed per analysis.';
