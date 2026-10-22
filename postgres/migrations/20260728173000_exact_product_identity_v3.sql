BEGIN;

-- A corrected fingerprint must enrich the existing product identity instead of
-- creating a second variant for the same concrete canonical name. The caller
-- resolves the stable IDs; this wrapper applies only the newest descriptive
-- fields after the append-only projection has been ingested.
CREATE OR REPLACE FUNCTION radar_analytics.ingest_product_identity_projection(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, radar_analytics
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

REVOKE ALL ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_product_identity_projection(jsonb)
  TO radar_analytics_runtime;

-- v1 treated generic "relevant" as enough to confirm exact identity. Preserve
-- those rows as history, but remove them from the current decision surface
-- until a v3 projection re-evaluates the listing.
WITH legacy AS (
  SELECT membership.*
  FROM radar_analytics.product_listing_memberships AS membership
  WHERE membership.is_current
    AND membership.decision = 'confirmed'
    AND membership.decision_source <> 'human'
    AND membership.membership_version = 'product-listing-membership-v1'
),
closed AS (
  UPDATE radar_analytics.product_listing_memberships AS membership
  SET
    is_current = false,
    valid_to = GREATEST(clock_timestamp(), membership.valid_from + interval '1 microsecond')
  FROM legacy
  WHERE membership.id = legacy.id
  RETURNING membership.*
)
INSERT INTO radar_analytics.product_listing_memberships(
  id,
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
)
SELECT
  'pm_' || md5(closed.id || ':product-listing-membership-v3-quarantine'),
  closed.product_variant_id,
  closed.source_listing_id,
  closed.search_run_id,
  'migration:exact-product-identity-v3',
  CASE WHEN closed.relation = 'related' THEN 'rejected' ELSE 'uncertain' END,
  'workflow_matcher',
  closed.relation,
  CASE WHEN closed.relation = 'related' THEN 'high' ELSE 'low' END,
  'product-listing-membership-v3',
  closed.evidence || jsonb_build_object(
    'origin', 'exact_product_identity_v3_quarantine',
    'previousMembershipId', closed.id,
    'reason', CASE
      WHEN closed.relation = 'related' THEN 'related_is_not_exact_identity'
      ELSE 'legacy_ai_relevance_requires_v3_recheck'
    END
  ),
  closed.valid_to,
  NULL,
  true,
  closed.id,
  closed.valid_to
FROM closed
ON CONFLICT (id) DO NOTHING;

-- Repair the two active P1 targets whose automatic parser had placed product
-- attributes in the character field. The canonical name stays unchanged, so
-- the runtime resolver reuses the existing product variant IDs.
UPDATE radar_core.watch_bindings
SET
  source_config_json = jsonb_set(
    jsonb_set(
      source_config_json::jsonb,
      '{productTarget}',
      '{
        "canonicalName": "初音ミク レーシングVer. ミニ色紙 Tony 浴衣Ver.",
        "workTitle": "VOCALOID",
        "characters": ["初音ミク"],
        "productType": "ミニ色紙",
        "series": "レーシングVer.",
        "aliases": [
          "初音ミク レーシングVer. Tony 浴衣Ver. ミニ色紙",
          "初音ミク Tony 浴衣Ver. ミニ色紙"
        ],
        "excludedTerms": ["アクリルキーホルダー", "缶バッジ", "タペストリー"]
      }'::jsonb,
      true
    ),
    '{intentKind}',
    '"fingerprint"'::jsonb,
    true
  )::text,
  updated_at = clock_timestamp()::text
WHERE watch_profile_id = '756cac4b-8d4b-471d-a6f6-aab5da7957cc';

UPDATE radar_core.watch_bindings
SET
  source_config_json = jsonb_set(
    jsonb_set(
      source_config_json::jsonb,
      '{productTarget}',
      '{
        "canonicalName": "高木さん からかいパーカー グレー Lサイズ",
        "workTitle": "からかい上手の高木さん",
        "characters": ["高木さん"],
        "productType": "パーカー",
        "series": "ゲッサン 2017年11月号 応募者全員サービス",
        "size": "Lサイズ",
        "color": "グレー",
        "aliases": [
          "高木さん からかいパーカー グレー Lサイズ",
          "からかい上手の高木さん パーカー グレー Lサイズ"
        ],
        "excludedTerms": ["フェイスタオル", "タオル", "セット", "まとめ売り"]
      }'::jsonb,
      true
    ),
    '{intentKind}',
    '"fingerprint"'::jsonb,
    true
  )::text,
  updated_at = clock_timestamp()::text
WHERE watch_profile_id = 'f8ede393-d7bf-495b-82f6-2efb1fd2c0ea';

COMMIT;
