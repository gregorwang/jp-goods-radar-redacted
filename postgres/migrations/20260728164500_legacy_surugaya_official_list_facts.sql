BEGIN;

-- Before priceReferences became a first-class normalized fact, the Surugaya
-- detail parser already preserved its explicit 「定価」 value as
-- rawMetadata.referenceListPrice. Keep that point-in-time evidence usable
-- without rewriting the immutable source observation.
ALTER VIEW radar_analytics.strategy_price_facts_v1
  RENAME TO strategy_price_facts_core_v1;

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
      observation.listing_payload #>> '{rawMetadata,referenceListPrice}'
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
      observation.listing_payload #>> '{rawMetadata,referenceListPrice}'
    ) IS NOT NULL
    AND radar_analytics.safe_positive_jpy(
      observation.listing_payload ->> 'originalPrice'
    ) IS NULL
    AND CASE
      WHEN jsonb_typeof(observation.listing_payload #> '{facts,priceReferences}')='array'
      THEN jsonb_array_length(observation.listing_payload #> '{facts,priceReferences}')=0
      ELSE true
    END
)
SELECT * FROM radar_analytics.strategy_price_facts_core_v1
UNION ALL
SELECT * FROM legacy_surugaya_official_list;

REVOKE ALL ON TABLE radar_analytics.strategy_price_facts_v1 FROM PUBLIC;
GRANT SELECT ON TABLE radar_analytics.strategy_price_facts_v1 TO radar_analytics_runtime;

COMMENT ON VIEW radar_analytics.strategy_price_facts_core_v1 IS
  'Internal P1 core facts retained behind the public compatibility wrapper.';
COMMENT ON VIEW radar_analytics.strategy_price_facts_v1 IS
  'P1 point-in-time price-fact contract, including explicit historical Surugaya list-price evidence.';
COMMENT ON COLUMN radar_analytics.strategy_price_facts_v1.knowledge_at IS
  'First database knowledge timestamp. Point-in-time backtests must filter knowledge_at <= decision time.';

COMMIT;
