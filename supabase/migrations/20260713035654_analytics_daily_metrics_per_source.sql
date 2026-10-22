CREATE OR REPLACE VIEW radar_analytics.keyword_daily_metrics
WITH (security_invoker = true)
AS
WITH source_runs AS (
  SELECT
    run.id AS run_id,
    timezone('Asia/Hong_Kong',run.searched_at)::date AS day,
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

COMMENT ON VIEW radar_analytics.keyword_daily_metrics IS
  'Daily metrics use the last successful visible window per query and source. Failed sources never erase a prior source window; left_visible_window is not inferred sold.';
