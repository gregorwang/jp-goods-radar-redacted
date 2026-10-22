-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing payload dedup migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- listing_observations 每轮每件商品存一整份商品内容（listing_payload，约 1.5 KB），
-- 同一件商品每小时一份、内容一模一样。2026-10-14：16.8 万行里不重复的内容只有 6.3 万份；
-- 每行单独压缩只省 8%（重复是跨行的），所以改成按内容指纹只存一份。
--
-- 第一步（本文件）：建 listing_payloads 并回填；入库改为只往 listing_payloads 写内容、
-- 观测行插入时写好 payload_hash；两个价格视图改读 COALESCE(指纹表, 旧列)，输出逐行不变。
-- 第二步（20261014140000）：读取代码上线后，把旧列清成 '{}' 再 VACUUM FULL。
-- 旧列先留着（默认 '{}'），过渡期新旧两种行都能读。

CREATE TABLE radar_analytics.listing_payloads (
  payload_hash text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE radar_analytics.listing_payloads IS
  '搜索结果里商品的整理后内容，按 md5(payload::text) 只存一份。listing_observations.payload_hash 指向这里';
GRANT SELECT, INSERT ON radar_analytics.listing_payloads TO radar_analytics_runtime;

INSERT INTO radar_analytics.listing_payloads(payload_hash, payload, created_at)
SELECT DISTINCT ON (payload_hash) payload_hash, listing_payload, observed_at
FROM radar_analytics.listing_observations
WHERE listing_payload <> '{}'::jsonb AND payload_hash IS NOT NULL
ORDER BY payload_hash, observed_at;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_run(p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'radar_analytics'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_run_v2(p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'radar_analytics'
AS $function$
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
$function$;

CREATE OR REPLACE VIEW radar_analytics.strategy_price_facts_core_v1 AS
WITH observation_base AS (
         SELECT observation.run_id,
            observation.source_listing_id,
            observation.price_jpy,
            observation.original_price_jpy,
            observation.price_basis,
            observation.item_condition,
            observation.availability,
            observation.observed_at,
            observation."position",
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
                    WHEN jsonb_typeof(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}'::text[]) = 'array'::text THEN COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}'::text[]
                    ELSE '[]'::jsonb
                END AS price_references
           FROM radar_analytics.listing_observations observation
             LEFT JOIN radar_analytics.listing_payloads observation_payload ON observation_payload.payload_hash = observation.payload_hash
             JOIN radar_analytics.source_listings listing ON listing.id = observation.source_listing_id
             JOIN radar_analytics.search_runs search_run ON search_run.id = observation.run_id
        ), observation_facts AS (
         SELECT ((('search:'::text || base.run_id::text) || ':'::text) || base.source_listing_id::text) || ':ask'::text AS price_fact_id,
                CASE
                    WHEN base.price_basis = 'auction_current_bid'::text THEN 'auction_current_bid'::text
                    WHEN base.availability = 'sold_out'::text THEN 'source_sold_status_price'::text
                    WHEN base.item_condition = 'new'::text OR (base.source_id = ANY (ARRAY['rakuten_ichiba'::text, 'rakuten_books'::text, 'yahoo_shopping'::text, 'charaon'::text, 'cospa'::text, 'animate'::text])) AND base.item_condition <> 'used'::text THEN 'new_retail_ask'::text
                    ELSE 'acquisition_ask'::text
                END AS price_role,
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            base.price_jpy AS amount_jpy,
            base.currency,
            base.price_basis,
            base.item_condition,
            base.availability,
                CASE
                    WHEN (base.listing_payload #>> '{facts,priceContext,taxStatus}'::text[]) = ANY (ARRAY['included'::text, 'excluded'::text, 'unknown'::text]) THEN base.listing_payload #>> '{facts,priceContext,taxStatus}'::text[]
                    ELSE 'unknown'::text
                END AS tax_status,
                CASE
                    WHEN (base.listing_payload #>> '{facts,priceContext,shippingStatus}'::text[]) = ANY (ARRAY['included'::text, 'separate'::text, 'free'::text, 'unknown'::text]) THEN base.listing_payload #>> '{facts,priceContext,shippingStatus}'::text[]
                    ELSE 'unknown'::text
                END AS shipping_status,
            base.observed_at AS occurred_at,
            base.knowledge_at,
            'search_observation'::text AS evidence_kind,
            base.run_id::text AS evidence_id,
            base.canonical_url AS evidence_url,
            jsonb_strip_nulls(jsonb_build_object('payloadHash', base.payload_hash, 'position', base."position", 'isNewForQuery', base.is_new_for_query)) AS evidence
           FROM observation_base base
          WHERE base.price_jpy > 0
        UNION ALL
         SELECT (((('search:'::text || base.run_id::text) || ':'::text) || base.source_listing_id::text) || ':reference:'::text) || reference.ordinality::text,
            reference.value ->> 'kind'::text,
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'::text) AS safe_positive_jpy,
            COALESCE(NULLIF(reference.value ->> 'currency'::text, ''::text), base.currency) AS "coalesce",
            base.price_basis,
            base.item_condition,
            base.availability,
                CASE
                    WHEN (reference.value ->> 'taxStatus'::text) = ANY (ARRAY['included'::text, 'excluded'::text, 'unknown'::text]) THEN reference.value ->> 'taxStatus'::text
                    ELSE 'unknown'::text
                END AS "case",
                CASE
                    WHEN (reference.value ->> 'shippingStatus'::text) = ANY (ARRAY['included'::text, 'separate'::text, 'free'::text, 'unknown'::text]) THEN reference.value ->> 'shippingStatus'::text
                    ELSE 'unknown'::text
                END AS "case",
            base.observed_at,
            base.knowledge_at,
            'search_observation'::text AS text,
            base.run_id::text AS run_id,
            base.canonical_url,
            jsonb_strip_nulls(jsonb_build_object('payloadHash', base.payload_hash, 'sourceLabel', reference.value ->> 'sourceLabel'::text)) AS jsonb_strip_nulls
           FROM observation_base base
             CROSS JOIN LATERAL jsonb_array_elements(base.price_references) WITH ORDINALITY reference(value, ordinality)
          WHERE ((reference.value ->> 'kind'::text) = ANY (ARRAY['official_list'::text, 'source_compare_at'::text])) AND radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'::text) IS NOT NULL
        UNION ALL
         SELECT ((('search:'::text || base.run_id::text) || ':'::text) || base.source_listing_id::text) || ':legacy-reference'::text,
            'source_compare_at'::text,
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            base.original_price_jpy,
            base.currency,
            base.price_basis,
            base.item_condition,
            base.availability,
            'unknown'::text,
            'unknown'::text,
            base.observed_at,
            base.knowledge_at,
            'search_observation'::text AS text,
            base.run_id::text AS run_id,
            base.canonical_url,
            jsonb_strip_nulls(jsonb_build_object('payloadHash', base.payload_hash, 'legacyOriginalPrice', true)) AS jsonb_strip_nulls
           FROM observation_base base
          WHERE base.original_price_jpy > 0 AND jsonb_array_length(base.price_references) = 0
        ), operational_base AS (
         SELECT snapshot.external_snapshot_id,
            snapshot.source_listing_id,
            radar_analytics.safe_positive_jpy(snapshot.payload ->> 'price'::text) AS price_jpy,
            radar_analytics.safe_positive_jpy(snapshot.payload ->> 'originalPrice'::text) AS original_price_jpy,
                CASE
                    WHEN (snapshot.payload ->> 'priceBasis'::text) = ANY (ARRAY['listing_price'::text, 'catalog_price'::text, 'offer_price'::text, 'auction_current_bid'::text]) THEN snapshot.payload ->> 'priceBasis'::text
                    ELSE NULL::text
                END AS price_basis,
            COALESCE(NULLIF(snapshot.payload ->> 'condition'::text, ''::text), listing.item_condition) AS item_condition,
            COALESCE(NULLIF(snapshot.payload ->> 'availability'::text, ''::text), listing.availability) AS availability,
            COALESCE(NULLIF(snapshot.payload ->> 'currency'::text, ''::text), listing.currency) AS currency,
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
                    WHEN jsonb_typeof(snapshot.payload #> '{facts,priceReferences}'::text[]) = 'array'::text THEN snapshot.payload #> '{facts,priceReferences}'::text[]
                    ELSE '[]'::jsonb
                END AS price_references
           FROM radar_analytics.operational_listing_snapshots snapshot
             JOIN radar_analytics.source_listings listing ON listing.id = snapshot.source_listing_id
        ), operational_facts AS (
         SELECT ('operational:'::text || base.external_snapshot_id) || ':ask'::text AS "?column?",
                CASE
                    WHEN base.price_basis = 'auction_current_bid'::text THEN 'auction_current_bid'::text
                    WHEN base.availability = 'sold_out'::text THEN 'source_sold_status_price'::text
                    WHEN base.price_basis IS NULL THEN 'unclassified_ask'::text
                    WHEN base.item_condition = 'new'::text OR (base.source_id = ANY (ARRAY['rakuten_ichiba'::text, 'rakuten_books'::text, 'yahoo_shopping'::text, 'charaon'::text, 'cospa'::text, 'animate'::text])) AND base.item_condition <> 'used'::text THEN 'new_retail_ask'::text
                    ELSE 'acquisition_ask'::text
                END AS "case",
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            base.price_jpy,
            base.currency,
            COALESCE(base.price_basis, 'unknown'::text) AS "coalesce",
            base.item_condition,
            base.availability,
                CASE
                    WHEN (base.payload #>> '{facts,priceContext,taxStatus}'::text[]) = ANY (ARRAY['included'::text, 'excluded'::text, 'unknown'::text]) THEN base.payload #>> '{facts,priceContext,taxStatus}'::text[]
                    ELSE 'unknown'::text
                END AS "case",
                CASE
                    WHEN (base.payload #>> '{facts,priceContext,shippingStatus}'::text[]) = ANY (ARRAY['included'::text, 'separate'::text, 'free'::text, 'unknown'::text]) THEN base.payload #>> '{facts,priceContext,shippingStatus}'::text[]
                    ELSE 'unknown'::text
                END AS "case",
            base.observed_at,
            base.knowledge_at,
            'operational_snapshot'::text AS text,
            base.external_snapshot_id,
            base.canonical_url,
            jsonb_build_object('contentHash', base.content_hash) AS jsonb_build_object
           FROM operational_base base
          WHERE base.price_jpy IS NOT NULL
        UNION ALL
         SELECT (('operational:'::text || base.external_snapshot_id) || ':reference:'::text) || reference.ordinality::text,
            reference.value ->> 'kind'::text,
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'::text) AS safe_positive_jpy,
            COALESCE(NULLIF(reference.value ->> 'currency'::text, ''::text), base.currency) AS "coalesce",
            COALESCE(base.price_basis, 'unknown'::text) AS "coalesce",
            base.item_condition,
            base.availability,
                CASE
                    WHEN (reference.value ->> 'taxStatus'::text) = ANY (ARRAY['included'::text, 'excluded'::text, 'unknown'::text]) THEN reference.value ->> 'taxStatus'::text
                    ELSE 'unknown'::text
                END AS "case",
                CASE
                    WHEN (reference.value ->> 'shippingStatus'::text) = ANY (ARRAY['included'::text, 'separate'::text, 'free'::text, 'unknown'::text]) THEN reference.value ->> 'shippingStatus'::text
                    ELSE 'unknown'::text
                END AS "case",
            base.observed_at,
            base.knowledge_at,
            'operational_snapshot'::text AS text,
            base.external_snapshot_id,
            base.canonical_url,
            jsonb_strip_nulls(jsonb_build_object('contentHash', base.content_hash, 'sourceLabel', reference.value ->> 'sourceLabel'::text)) AS jsonb_strip_nulls
           FROM operational_base base
             CROSS JOIN LATERAL jsonb_array_elements(base.price_references) WITH ORDINALITY reference(value, ordinality)
          WHERE ((reference.value ->> 'kind'::text) = ANY (ARRAY['official_list'::text, 'source_compare_at'::text])) AND radar_analytics.safe_positive_jpy(reference.value ->> 'amountJpy'::text) IS NOT NULL
        UNION ALL
         SELECT ('operational:'::text || base.external_snapshot_id) || ':legacy-reference'::text,
            'source_compare_at'::text,
            base.source_listing_id,
            base.source_id,
            base.source_item_id,
            base.product_key,
            base.product_match_method,
            base.title,
            base.canonical_url,
            base.original_price_jpy,
            base.currency,
            COALESCE(base.price_basis, 'unknown'::text) AS "coalesce",
            base.item_condition,
            base.availability,
            'unknown'::text,
            'unknown'::text,
            base.observed_at,
            base.knowledge_at,
            'operational_snapshot'::text AS text,
            base.external_snapshot_id,
            base.canonical_url,
            jsonb_build_object('contentHash', base.content_hash, 'legacyOriginalPrice', true) AS jsonb_build_object
           FROM operational_base base
          WHERE base.original_price_jpy IS NOT NULL AND jsonb_array_length(base.price_references) = 0
        ), verified_sale_facts AS (
         SELECT 'verified-sale:'::text || sale.id::text AS price_fact_id,
            'verified_sale'::text AS price_role,
            listing.id AS source_listing_id,
            listing.source_id,
            listing.source_item_id,
            listing.product_key,
            listing.product_match_method,
            listing.title,
            listing.canonical_url,
            sale.sold_price_jpy AS amount_jpy,
            listing.currency,
            'listing_price'::text AS price_basis,
            listing.item_condition,
            listing.availability,
            'unknown'::text AS tax_status,
            'unknown'::text AS shipping_status,
            sale.sold_at AS occurred_at,
            sale.recorded_at AS knowledge_at,
            'verified_sale_record'::text AS evidence_kind,
            sale.id::text AS evidence_id,
            COALESCE(sale.evidence_url, listing.canonical_url) AS evidence_url,
            sale.evidence
           FROM radar_analytics.sale_records sale
             JOIN radar_analytics.source_listings listing ON listing.id = sale.source_listing_id
          WHERE sale.sold_price_jpy > 0
        ), all_facts AS (
         SELECT observation_facts.price_fact_id,
            observation_facts.price_role,
            observation_facts.source_listing_id,
            observation_facts.source_id,
            observation_facts.source_item_id,
            observation_facts.product_key,
            observation_facts.product_match_method,
            observation_facts.title,
            observation_facts.canonical_url,
            observation_facts.amount_jpy,
            observation_facts.currency,
            observation_facts.price_basis,
            observation_facts.item_condition,
            observation_facts.availability,
            observation_facts.tax_status,
            observation_facts.shipping_status,
            observation_facts.occurred_at,
            observation_facts.knowledge_at,
            observation_facts.evidence_kind,
            observation_facts.evidence_id,
            observation_facts.evidence_url,
            observation_facts.evidence
           FROM observation_facts
        UNION ALL
         SELECT operational_facts."?column?",
            operational_facts."case",
            operational_facts.source_listing_id,
            operational_facts.source_id,
            operational_facts.source_item_id,
            operational_facts.product_key,
            operational_facts.product_match_method,
            operational_facts.title,
            operational_facts.canonical_url,
            operational_facts.price_jpy,
            operational_facts.currency,
            operational_facts."coalesce",
            operational_facts.item_condition,
            operational_facts.availability,
            operational_facts.case_1 AS "case",
            operational_facts.case_2 AS "case",
            operational_facts.observed_at,
            operational_facts.knowledge_at,
            operational_facts.text,
            operational_facts.external_snapshot_id,
            operational_facts.canonical_url_1 AS canonical_url,
            operational_facts.jsonb_build_object
           FROM operational_facts operational_facts("?column?", "case", source_listing_id, source_id, source_item_id, product_key, product_match_method, title, canonical_url, price_jpy, currency, "coalesce", item_condition, availability, case_1, case_2, observed_at, knowledge_at, text, external_snapshot_id, canonical_url_1, jsonb_build_object)
        UNION ALL
         SELECT verified_sale_facts.price_fact_id,
            verified_sale_facts.price_role,
            verified_sale_facts.source_listing_id,
            verified_sale_facts.source_id,
            verified_sale_facts.source_item_id,
            verified_sale_facts.product_key,
            verified_sale_facts.product_match_method,
            verified_sale_facts.title,
            verified_sale_facts.canonical_url,
            verified_sale_facts.amount_jpy,
            verified_sale_facts.currency,
            verified_sale_facts.price_basis,
            verified_sale_facts.item_condition,
            verified_sale_facts.availability,
            verified_sale_facts.tax_status,
            verified_sale_facts.shipping_status,
            verified_sale_facts.occurred_at,
            verified_sale_facts.knowledge_at,
            verified_sale_facts.evidence_kind,
            verified_sale_facts.evidence_id,
            verified_sale_facts.evidence_url,
            verified_sale_facts.evidence
           FROM verified_sale_facts
        )
 SELECT 'price-facts-v1'::text AS fact_semantics_version,
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
   FROM all_facts fact
     LEFT JOIN LATERAL ( SELECT membership.product_variant_id,
            membership.valid_from AS identity_known_at
           FROM radar_analytics.product_listing_memberships membership
          WHERE membership.source_listing_id = fact.source_listing_id AND membership.decision = 'confirmed'::text AND membership.is_current
          ORDER BY membership.valid_from DESC, membership.id DESC
         LIMIT 1) identity ON true;

CREATE OR REPLACE VIEW radar_analytics.strategy_price_facts_v1 AS
WITH legacy_surugaya_official_list AS (
         SELECT 'price-facts-v1'::text AS fact_semantics_version,
            ((('search:'::text || observation.run_id::text) || ':'::text) || observation.source_listing_id::text) || ':legacy-official-list'::text AS price_fact_id,
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
            radar_analytics.safe_positive_jpy(COALESCE(observation_payload.payload, observation.listing_payload) #>> '{rawMetadata,referenceListPrice}'::text[]) AS amount_jpy,
            listing.currency,
            COALESCE(observation.price_basis, 'unknown'::text) AS price_basis,
            observation.item_condition,
            observation.availability,
            'unknown'::text AS tax_status,
            'unknown'::text AS shipping_status,
            observation.observed_at AS occurred_at,
            search_run.ingested_at AS knowledge_at,
            'search_observation'::text AS evidence_kind,
            observation.run_id::text AS evidence_id,
            listing.canonical_url AS evidence_url,
            jsonb_build_object('payloadHash', observation.payload_hash, 'sourceLabel', '骏河屋商品详情「定価」', 'legacyRawMetadataReferenceListPrice', true) AS evidence
           FROM radar_analytics.listing_observations observation
             LEFT JOIN radar_analytics.listing_payloads observation_payload ON observation_payload.payload_hash = observation.payload_hash
             JOIN radar_analytics.source_listings listing ON listing.id = observation.source_listing_id
             JOIN radar_analytics.search_runs search_run ON search_run.id = observation.run_id
             LEFT JOIN LATERAL ( SELECT membership.product_variant_id,
                    membership.valid_from AS identity_known_at
                   FROM radar_analytics.product_listing_memberships membership
                  WHERE membership.source_listing_id = observation.source_listing_id AND membership.decision = 'confirmed'::text AND membership.is_current
                  ORDER BY membership.valid_from DESC, membership.id DESC
                 LIMIT 1) identity ON true
          WHERE listing.source_id = 'surugaya'::text AND radar_analytics.safe_positive_jpy(COALESCE(observation_payload.payload, observation.listing_payload) #>> '{rawMetadata,referenceListPrice}'::text[]) IS NOT NULL AND radar_analytics.safe_positive_jpy(COALESCE(observation_payload.payload, observation.listing_payload) ->> 'originalPrice'::text) IS NULL AND
                CASE
                    WHEN jsonb_typeof(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}'::text[]) = 'array'::text THEN jsonb_array_length(COALESCE(observation_payload.payload, observation.listing_payload) #> '{facts,priceReferences}'::text[]) = 0
                    ELSE true
                END
        )
 SELECT strategy_price_facts_core_v1.fact_semantics_version,
    strategy_price_facts_core_v1.price_fact_id,
    strategy_price_facts_core_v1.price_role,
    strategy_price_facts_core_v1.product_variant_id,
    strategy_price_facts_core_v1.identity_known_at,
    strategy_price_facts_core_v1.source_listing_id,
    strategy_price_facts_core_v1.source_id,
    strategy_price_facts_core_v1.source_item_id,
    strategy_price_facts_core_v1.product_key,
    strategy_price_facts_core_v1.product_match_method,
    strategy_price_facts_core_v1.title,
    strategy_price_facts_core_v1.canonical_url,
    strategy_price_facts_core_v1.amount_jpy,
    strategy_price_facts_core_v1.currency,
    strategy_price_facts_core_v1.price_basis,
    strategy_price_facts_core_v1.item_condition,
    strategy_price_facts_core_v1.availability,
    strategy_price_facts_core_v1.tax_status,
    strategy_price_facts_core_v1.shipping_status,
    strategy_price_facts_core_v1.occurred_at,
    strategy_price_facts_core_v1.knowledge_at,
    strategy_price_facts_core_v1.evidence_kind,
    strategy_price_facts_core_v1.evidence_id,
    strategy_price_facts_core_v1.evidence_url,
    strategy_price_facts_core_v1.evidence
   FROM radar_analytics.strategy_price_facts_core_v1
UNION ALL
 SELECT legacy_surugaya_official_list.fact_semantics_version,
    legacy_surugaya_official_list.price_fact_id,
    legacy_surugaya_official_list.price_role,
    legacy_surugaya_official_list.product_variant_id,
    legacy_surugaya_official_list.identity_known_at,
    legacy_surugaya_official_list.source_listing_id,
    legacy_surugaya_official_list.source_id,
    legacy_surugaya_official_list.source_item_id,
    legacy_surugaya_official_list.product_key,
    legacy_surugaya_official_list.product_match_method,
    legacy_surugaya_official_list.title,
    legacy_surugaya_official_list.canonical_url,
    legacy_surugaya_official_list.amount_jpy,
    legacy_surugaya_official_list.currency,
    legacy_surugaya_official_list.price_basis,
    legacy_surugaya_official_list.item_condition,
    legacy_surugaya_official_list.availability,
    legacy_surugaya_official_list.tax_status,
    legacy_surugaya_official_list.shipping_status,
    legacy_surugaya_official_list.occurred_at,
    legacy_surugaya_official_list.knowledge_at,
    legacy_surugaya_official_list.evidence_kind,
    legacy_surugaya_official_list.evidence_id,
    legacy_surugaya_official_list.evidence_url,
    legacy_surugaya_official_list.evidence
   FROM legacy_surugaya_official_list;
