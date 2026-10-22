-- Market-day boundaries are Japanese business days. Replacing these views is
-- additive at the API contract level: column names and types stay unchanged.

CREATE OR REPLACE VIEW radar_analytics.keyword_daily_metrics
WITH (security_invoker = true)
AS
WITH source_runs AS (
  SELECT
    run.id AS run_id,
    timezone('Asia/Tokyo',run.searched_at)::date AS day,
    run.query,
    run.query_key,
    run.searched_at,
    source.source_id,
    source.result_count,
    source.new_count,
    source.left_count
  FROM radar_analytics.search_runs AS run
  JOIN radar_analytics.search_run_sources AS source ON source.run_id=run.id
  WHERE source.status IN ('success','empty')
), latest_source_windows AS (
  SELECT DISTINCT ON (day,query_key,source_id)
    day,query,query_key,source_id,result_count
  FROM source_runs
  ORDER BY day,query_key,source_id,searched_at DESC,run_id DESC
), daily_visible AS (
  SELECT day,max(query) AS query,query_key,
         sum(result_count)::integer AS visible_count
  FROM latest_source_windows
  GROUP BY day,query_key
), daily_movement AS (
  SELECT day,query_key,
         sum(new_count)::integer AS new_count,
         sum(left_count)::integer AS left_visible_window,
         count(DISTINCT run_id)::integer AS run_count
  FROM source_runs
  GROUP BY day,query_key
)
SELECT visible.day,visible.query,visible.query_key,visible.visible_count,
       movement.new_count,movement.left_visible_window,movement.run_count
FROM daily_visible AS visible
JOIN daily_movement AS movement USING (day,query_key);

CREATE OR REPLACE VIEW radar_analytics.market_subscription_daily_metrics
WITH (security_invoker = true)
AS
WITH source_runs AS (
  SELECT
    run.id AS run_id,
    timezone('Asia/Tokyo',run.searched_at)::date AS day,
    run.subscription_key,
    COALESCE(run.subscription_name,run.query) AS subscription_name,
    run.query,
    run.query_key,
    run.searched_at,
    source.source_id,
    source.result_count,
    source.new_count,
    source.left_count
  FROM radar_analytics.search_runs AS run
  JOIN radar_analytics.search_run_sources AS source ON source.run_id=run.id
  WHERE run.origin='watch_keyword'
    AND run.subscription_key IS NOT NULL
    AND source.status IN ('success','empty')
), latest_source_windows AS (
  SELECT DISTINCT ON (day,subscription_key,source_id)
    run_id,day,subscription_key,subscription_name,query,query_key,source_id,result_count
  FROM source_runs
  ORDER BY day,subscription_key,source_id,searched_at DESC,run_id DESC
), daily_visible AS (
  SELECT day,subscription_key,max(subscription_name) AS subscription_name,
         max(query) AS query,max(query_key) AS query_key,
         sum(result_count)::integer AS visible_count,
         count(DISTINCT source_id)::integer AS source_count
  FROM latest_source_windows
  GROUP BY day,subscription_key
), daily_movement AS (
  SELECT day,subscription_key,
         sum(new_count)::integer AS new_count,
         sum(left_count)::integer AS left_visible_window,
         count(DISTINCT run_id)::integer AS run_count
  FROM source_runs
  GROUP BY day,subscription_key
), latest_observations AS (
  SELECT latest.day,latest.subscription_key,observation.price_jpy,observation.availability
  FROM latest_source_windows AS latest
  JOIN radar_analytics.listing_observations AS observation
    ON observation.run_id=latest.run_id AND observation.source_id=latest.source_id
), daily_distribution AS (
  SELECT day,subscription_key,
         count(*) FILTER (WHERE availability IN ('available','preorder','backorder'))::integer AS available_count,
         count(*) FILTER (WHERE availability='sold_out')::integer AS sold_out_count,
         count(price_jpy)::integer AS priced_count,
         min(price_jpy)::integer AS min_price_jpy,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price_jpy)::integer AS median_price_jpy,
         round(avg(price_jpy),2) AS average_price_jpy,
         max(price_jpy)::integer AS max_price_jpy
  FROM latest_observations
  GROUP BY day,subscription_key
)
SELECT visible.day,visible.subscription_key,visible.subscription_name,visible.query,visible.query_key,
       visible.visible_count,visible.source_count,
       movement.new_count,movement.left_visible_window,movement.run_count,
       COALESCE(distribution.available_count,0)::integer AS available_count,
       COALESCE(distribution.sold_out_count,0)::integer AS sold_out_count,
       COALESCE(distribution.priced_count,0)::integer AS priced_count,
       distribution.min_price_jpy,distribution.median_price_jpy,
       distribution.average_price_jpy,distribution.max_price_jpy
FROM daily_visible AS visible
JOIN daily_movement AS movement USING (day,subscription_key)
LEFT JOIN daily_distribution AS distribution USING (day,subscription_key);

CREATE OR REPLACE VIEW radar_analytics.market_subscription_daily_source_metrics
WITH (security_invoker = true)
AS
WITH source_runs AS (
  SELECT
    run.id AS run_id,
    timezone('Asia/Tokyo', run.searched_at)::date AS day,
    run.subscription_key,
    COALESCE(run.subscription_name, run.query) AS subscription_name,
    run.query,
    run.query_key,
    run.searched_at,
    source.source_id,
    source.result_count,
    source.new_count,
    source.left_count
  FROM radar_analytics.search_runs AS run
  JOIN radar_analytics.search_run_sources AS source ON source.run_id = run.id
  WHERE run.origin = 'watch_keyword'
    AND run.subscription_key IS NOT NULL
    AND source.status IN ('success', 'empty')
), latest_source_window AS (
  SELECT DISTINCT ON (day, subscription_key, source_id)
    run_id, day, subscription_key, subscription_name, query, query_key,
    source_id, result_count
  FROM source_runs
  ORDER BY day, subscription_key, source_id, searched_at DESC, run_id DESC
), daily_movement AS (
  SELECT day, subscription_key, source_id,
         sum(new_count)::integer AS new_count,
         sum(left_count)::integer AS left_visible_window,
         count(DISTINCT run_id)::integer AS run_count
  FROM source_runs
  GROUP BY day, subscription_key, source_id
), latest_observations AS (
  SELECT latest.day, latest.subscription_key, latest.source_id,
         observation.price_jpy, observation.availability
  FROM latest_source_window AS latest
  JOIN radar_analytics.listing_observations AS observation
    ON observation.run_id = latest.run_id
   AND observation.source_id = latest.source_id
), daily_distribution AS (
  SELECT day, subscription_key, source_id,
         count(*) FILTER (WHERE availability IN ('available', 'preorder', 'backorder'))::integer AS available_count,
         count(*) FILTER (WHERE availability = 'sold_out')::integer AS sold_out_count,
         count(price_jpy)::integer AS priced_count,
         min(price_jpy)::integer AS min_price_jpy,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price_jpy)::integer AS median_price_jpy,
         round(avg(price_jpy), 2) AS average_price_jpy,
         max(price_jpy)::integer AS max_price_jpy
  FROM latest_observations
  GROUP BY day, subscription_key, source_id
)
SELECT latest.day, latest.subscription_key, latest.subscription_name,
       latest.query, latest.query_key, latest.source_id,
       latest.result_count::integer AS visible_count,
       1::integer AS source_count,
       movement.new_count, movement.left_visible_window, movement.run_count,
       COALESCE(distribution.available_count, 0)::integer AS available_count,
       COALESCE(distribution.sold_out_count, 0)::integer AS sold_out_count,
       COALESCE(distribution.priced_count, 0)::integer AS priced_count,
       distribution.min_price_jpy, distribution.median_price_jpy,
       distribution.average_price_jpy, distribution.max_price_jpy
FROM latest_source_window AS latest
JOIN daily_movement AS movement USING (day, subscription_key, source_id)
LEFT JOIN daily_distribution AS distribution USING (day, subscription_key, source_id);

COMMENT ON VIEW radar_analytics.keyword_daily_metrics IS
  'Daily metrics use Asia/Tokyo day boundaries and the last successful visible window per query and source. Failed sources never erase a prior source window; left_visible_window is not inferred sold.';
COMMENT ON VIEW radar_analytics.market_subscription_daily_metrics IS
  'Scheduled keyword-market observations grouped by Asia/Tokyo day. Missing listings mean left visible window; they are not inferred sold.';
COMMENT ON VIEW radar_analytics.market_subscription_daily_source_metrics IS
  'Daily scheduled market metrics at the source boundary, grouped by Asia/Tokyo day; each value can be traced to one latest successful source window.';

REVOKE ALL ON radar_analytics.keyword_daily_metrics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.market_subscription_daily_metrics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON radar_analytics.market_subscription_daily_source_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON radar_analytics.keyword_daily_metrics TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.market_subscription_daily_metrics TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.market_subscription_daily_source_metrics TO radar_analytics_runtime;
