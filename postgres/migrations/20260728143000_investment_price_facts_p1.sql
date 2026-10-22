BEGIN;

ALTER TABLE radar_core.listing_snapshots
  ADD COLUMN IF NOT EXISTS price_basis text;
ALTER TABLE radar_core.listing_snapshots
  DROP CONSTRAINT IF EXISTS ck_listing_snapshots_price_basis;
ALTER TABLE radar_core.listing_snapshots
  ADD CONSTRAINT ck_listing_snapshots_price_basis
  CHECK (
    price_basis IS NULL
    OR price_basis IN ('listing_price','catalog_price','offer_price','auction_current_bid')
  ) NOT VALID;
ALTER TABLE radar_core.listing_snapshots
  VALIDATE CONSTRAINT ck_listing_snapshots_price_basis;

ALTER TABLE radar_analytics.listing_observations
  DROP CONSTRAINT IF EXISTS listing_observations_price_basis_check;
ALTER TABLE radar_analytics.listing_observations
  ADD CONSTRAINT listing_observations_price_basis_check
  CHECK (price_basis IN ('listing_price','catalog_price','offer_price','auction_current_bid')) NOT VALID;
ALTER TABLE radar_analytics.listing_observations
  VALIDATE CONSTRAINT listing_observations_price_basis_check;

CREATE UNIQUE INDEX IF NOT EXISTS sale_records_verified_yahoo_sale_unique_idx
  ON radar_analytics.sale_records(source_listing_id,source_sale_id)
  WHERE source_sale_id IS NOT NULL
    AND evidence ->> 'evidenceBoundary' = 'source_closed_auction_with_positive_bid';

CREATE OR REPLACE FUNCTION radar_analytics.safe_positive_jpy(p_value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN btrim(COALESCE(p_value,'')) ~ '^[1-9][0-9]{0,9}$' THEN
      CASE WHEN btrim(p_value)::numeric <= 1000000000 THEN btrim(p_value)::integer ELSE NULL END
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION radar_analytics.capture_verified_sale_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, radar_analytics
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

DROP TRIGGER IF EXISTS source_listings_capture_verified_sale ON radar_analytics.source_listings;
CREATE TRIGGER source_listings_capture_verified_sale
AFTER INSERT OR UPDATE OF current_price_jpy,raw_metadata,last_seen_at
ON radar_analytics.source_listings
FOR EACH ROW EXECUTE FUNCTION radar_analytics.capture_verified_sale_evidence();

CREATE OR REPLACE VIEW radar_analytics.strategy_price_facts_v1
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
    observation.listing_payload,
    listing.source_id,
    listing.source_item_id,
    listing.product_key,
    listing.product_match_method,
    listing.title,
    listing.canonical_url,
    listing.currency,
    search_run.ingested_at AS knowledge_at,
    CASE
      WHEN jsonb_typeof(observation.listing_payload #> '{facts,priceReferences}') = 'array'
      THEN observation.listing_payload #> '{facts,priceReferences}'
      ELSE '[]'::jsonb
    END AS price_references
  FROM radar_analytics.listing_observations AS observation
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

REVOKE ALL ON FUNCTION radar_analytics.safe_positive_jpy(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION radar_analytics.safe_positive_jpy(text) TO radar_analytics_runtime;
REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence() FROM PUBLIC;
REVOKE ALL ON TABLE radar_analytics.strategy_price_facts_v1 FROM PUBLIC;
GRANT SELECT ON TABLE radar_analytics.strategy_price_facts_v1 TO radar_analytics_runtime;

COMMENT ON COLUMN radar_core.listing_snapshots.price_basis IS
  'Point-in-time price meaning. Null is retained for legacy snapshots rather than guessing from the latest listing state.';
COMMENT ON VIEW radar_analytics.strategy_price_facts_v1 IS
  'P1 point-in-time price-fact contract for Databricks. Asking prices, explicit references, and verified sales remain distinct.';
COMMENT ON COLUMN radar_analytics.strategy_price_facts_v1.knowledge_at IS
  'First database knowledge timestamp. Point-in-time backtests must filter knowledge_at <= decision time.';

COMMIT;
