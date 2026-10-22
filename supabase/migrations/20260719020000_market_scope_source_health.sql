CREATE TABLE radar_analytics.market_scope_versions (
  id text PRIMARY KEY,
  subscription_key text NOT NULL,
  subscription_name text NOT NULL,
  query text NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  scope_hash text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (subscription_key, version),
  UNIQUE (subscription_key, scope_hash)
);

CREATE INDEX market_scope_versions_latest_idx
  ON radar_analytics.market_scope_versions(subscription_key, version DESC);

ALTER TABLE radar_analytics.search_runs
  ADD COLUMN scope_version_id text
  REFERENCES radar_analytics.market_scope_versions(id) ON DELETE RESTRICT;

CREATE INDEX search_runs_scope_time_idx
  ON radar_analytics.search_runs(scope_version_id, searched_at DESC)
  WHERE origin = 'watch_keyword';

-- Existing observations remain available as an explicit legacy scope. The
-- first post-migration run creates version 1, so charts never join legacy and
-- current configurations into one line.
INSERT INTO radar_analytics.market_scope_versions(
  id,subscription_key,subscription_name,query,version,scope_hash,definition,created_at
)
SELECT
  'legacy:' || md5(run.subscription_key),
  run.subscription_key,
  (array_agg(COALESCE(run.subscription_name,run.query) ORDER BY run.searched_at DESC))[1],
  (array_agg(run.query ORDER BY run.searched_at DESC))[1],
  0,
  'legacy:' || md5(run.subscription_key),
  jsonb_build_object(
    'schemaVersion','legacy',
    'query',(array_agg(run.query ORDER BY run.searched_at DESC))[1],
    'sources',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('sourceId',source_id,'sourceConfig','{}'::jsonb) ORDER BY source_id)
      FROM (
        SELECT DISTINCT source.source_id
        FROM radar_analytics.search_runs source_run
        JOIN radar_analytics.search_run_sources source ON source.run_id=source_run.id
        WHERE source_run.subscription_key=run.subscription_key
      ) distinct_sources
    ),'[]'::jsonb)
  ),
  min(run.searched_at)
FROM radar_analytics.search_runs run
WHERE run.origin='watch_keyword' AND run.subscription_key IS NOT NULL
GROUP BY run.subscription_key
ON CONFLICT (subscription_key,version) DO NOTHING;

UPDATE radar_analytics.search_runs run
SET scope_version_id='legacy:' || md5(run.subscription_key)
WHERE run.origin='watch_keyword' AND run.subscription_key IS NOT NULL
  AND run.scope_version_id IS NULL;

CREATE TABLE radar_analytics.source_health_snapshots (
  run_id uuid NOT NULL REFERENCES radar_analytics.search_runs(id) ON DELETE CASCADE,
  scope_version_id text REFERENCES radar_analytics.market_scope_versions(id) ON DELETE RESTRICT,
  subscription_key text,
  source_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN (
    'healthy','empty','suspected_degradation','failed','disabled','cooldown'
  )),
  request_succeeded boolean NOT NULL,
  parse_succeeded boolean NOT NULL,
  coverage text,
  raw_result_count integer NOT NULL DEFAULT 0 CHECK (raw_result_count >= 0),
  normalized_result_count integer NOT NULL DEFAULT 0 CHECK (normalized_result_count >= 0),
  page_depth integer NOT NULL DEFAULT 0 CHECK (page_depth >= 0),
  cursor_termination_reason text NOT NULL DEFAULT 'unknown' CHECK (
    cursor_termination_reason IN ('exhausted','budget_reached','not_applicable','unknown')
  ),
  response_content_hash text,
  response_bytes integer NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  template_version text,
  http_status integer,
  field_total integer NOT NULL DEFAULT 0 CHECK (field_total >= 0),
  field_complete integer NOT NULL DEFAULT 0 CHECK (field_complete >= 0),
  captcha_detected boolean NOT NULL DEFAULT false,
  login_required boolean NOT NULL DEFAULT false,
  blocked_detected boolean NOT NULL DEFAULT false,
  abnormal_empty boolean NOT NULL DEFAULT false,
  freshness_sla_minutes integer NOT NULL CHECK (freshness_sla_minutes > 0),
  error_code text,
  error_message text,
  PRIMARY KEY (run_id,source_id)
);

CREATE INDEX source_health_scope_time_idx
  ON radar_analytics.source_health_snapshots(scope_version_id,source_id,observed_at DESC);
CREATE INDEX source_health_source_time_idx
  ON radar_analytics.source_health_snapshots(source_id,observed_at DESC);

INSERT INTO radar_analytics.source_health_snapshots(
  run_id,scope_version_id,subscription_key,source_id,observed_at,state,
  request_succeeded,parse_succeeded,coverage,raw_result_count,normalized_result_count,
  page_depth,cursor_termination_reason,template_version,field_total,field_complete,
  captcha_detected,login_required,blocked_detected,abnormal_empty,freshness_sla_minutes,
  error_code,error_message
)
SELECT
  source.run_id,run.scope_version_id,run.subscription_key,source.source_id,run.searched_at,
  CASE source.status
    WHEN 'success' THEN 'healthy'
    WHEN 'empty' THEN 'empty'
    WHEN 'disabled' THEN 'disabled'
    WHEN 'cooldown' THEN 'cooldown'
    ELSE 'failed'
  END,
  source.status IN ('success','empty'),source.status IN ('success','empty'),source.coverage,
  source.result_count,source.result_count,CASE WHEN source.status IN ('success','empty') THEN 1 ELSE 0 END,
  'unknown',source.parser_version,0,0,false,false,false,false,1440,NULL,NULL
FROM radar_analytics.search_run_sources source
JOIN radar_analytics.search_runs run ON run.id=source.run_id
ON CONFLICT (run_id,source_id) DO NOTHING;

CREATE OR REPLACE FUNCTION radar_analytics.ingest_search_run_v3(p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, radar_analytics
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

CREATE VIEW radar_analytics.market_scope_daily_source_metrics
WITH (security_invoker = true)
AS
WITH scope_bounds AS (
  SELECT scope.id AS scope_version_id,
         min(timezone('Asia/Tokyo',run.searched_at)::date) AS first_day,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM radar_analytics.market_scope_versions newer
           WHERE newer.subscription_key=scope.subscription_key AND newer.version>scope.version
         ) THEN timezone('Asia/Tokyo',now())::date
         ELSE max(timezone('Asia/Tokyo',run.searched_at)::date) END AS last_day
  FROM radar_analytics.market_scope_versions scope
  JOIN radar_analytics.search_runs run ON run.scope_version_id=scope.id
  WHERE run.origin='watch_keyword' AND run.subscription_key IS NOT NULL
  GROUP BY scope.id,scope.subscription_key,scope.version
), scope_days AS (
  SELECT generate_series(bound.first_day,bound.last_day,interval '1 day')::date AS day,
         bound.scope_version_id
  FROM scope_bounds bound
), expected_sources AS (
  SELECT scope.id AS scope_version_id,scope.subscription_key,scope.subscription_name,scope.query,
         scope.version AS scope_version,source.value ->> 'sourceId' AS source_id
  FROM radar_analytics.market_scope_versions scope
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(scope.definition -> 'sources','[]'::jsonb)) source(value)
), day_sources AS (
  SELECT day.day,source.*,
         LEAST(now(),((day.day + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')) AS evaluated_at
  FROM scope_days day JOIN expected_sources source USING (scope_version_id)
), source_evidence AS (
  SELECT day_source.*,health.observed_at AS health_observed_at,health.state,health.request_succeeded,
         health.parse_succeeded,health.abnormal_empty,health.freshness_sla_minutes,
         valid_window.run_id AS window_run_id,valid_window.result_count,valid_window.successful_window_count,
         movement.new_count,movement.left_visible_window,movement.run_count,
         distribution.available_count,distribution.sold_out_count,distribution.priced_count,
         distribution.min_price_jpy,distribution.median_price_jpy,
         distribution.average_price_jpy,distribution.max_price_jpy,
         health.observed_at IS NOT NULL
           AND day_source.evaluated_at-health.observed_at <= health.freshness_sla_minutes * interval '1 minute' AS is_fresh
  FROM day_sources day_source
  LEFT JOIN LATERAL (
    SELECT snapshot.* FROM radar_analytics.source_health_snapshots snapshot
    WHERE snapshot.scope_version_id=day_source.scope_version_id
      AND snapshot.source_id=day_source.source_id AND snapshot.observed_at<=day_source.evaluated_at
    ORDER BY snapshot.observed_at DESC,snapshot.run_id DESC LIMIT 1
  ) health ON true
  LEFT JOIN LATERAL (
    SELECT run.id AS run_id,source.result_count,count(*) OVER ()::integer AS successful_window_count
    FROM radar_analytics.search_runs run
    JOIN radar_analytics.search_run_sources source ON source.run_id=run.id
    WHERE run.scope_version_id=day_source.scope_version_id AND source.source_id=day_source.source_id
      AND source.status IN ('success','empty') AND run.searched_at<=day_source.evaluated_at
    ORDER BY run.searched_at DESC,run.id DESC LIMIT 1
  ) valid_window ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(source.new_count),0)::integer AS new_count,
           COALESCE(sum(source.left_count),0)::integer AS left_visible_window,
           count(*)::integer AS run_count
    FROM radar_analytics.search_runs run
    JOIN radar_analytics.search_run_sources source ON source.run_id=run.id
    WHERE run.scope_version_id=day_source.scope_version_id AND source.source_id=day_source.source_id
      AND timezone('Asia/Tokyo',run.searched_at)::date=day_source.day
      AND source.status IN ('success','empty')
  ) movement ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE observation.availability IN ('available','preorder','backorder'))::integer AS available_count,
           count(*) FILTER (WHERE observation.availability='sold_out')::integer AS sold_out_count,
           count(observation.price_jpy)::integer AS priced_count,min(observation.price_jpy)::integer AS min_price_jpy,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY observation.price_jpy)::integer AS median_price_jpy,
           round(avg(observation.price_jpy),2) AS average_price_jpy,max(observation.price_jpy)::integer AS max_price_jpy
    FROM radar_analytics.listing_observations observation
    WHERE observation.run_id=valid_window.run_id AND observation.source_id=day_source.source_id
  ) distribution ON true
)
SELECT day,scope_version_id,scope_version,subscription_key,subscription_name,query,source_id,window_run_id,
       COALESCE(result_count,0)::integer AS visible_count,COALESCE(new_count,0)::integer AS new_count,
       COALESCE(left_visible_window,0)::integer AS left_visible_window,COALESCE(run_count,0)::integer AS run_count,
       CASE WHEN is_fresh AND state IN ('healthy','empty') THEN 1 ELSE 0 END::integer AS source_count,
       COALESCE(available_count,0)::integer AS available_count,COALESCE(sold_out_count,0)::integer AS sold_out_count,
       COALESCE(priced_count,0)::integer AS priced_count,min_price_jpy,median_price_jpy,average_price_jpy,max_price_jpy,
       1::integer AS expected_source_count,
       CASE WHEN is_fresh AND state IN ('healthy','empty') THEN 1 ELSE 0 END::integer AS successful_source_count,
       CASE WHEN state IN ('failed','suspected_degradation','disabled','cooldown') THEN 1 ELSE 0 END::integer AS failed_source_count,
       CASE WHEN NOT COALESCE(is_fresh,false) THEN 1 ELSE 0 END::integer AS stale_source_count,
       CASE WHEN is_fresh AND state IN ('healthy','empty') THEN 1.0 ELSE 0.0 END::numeric AS coverage_rate,
       COALESCE(successful_window_count,0)<2 OR window_run_id IS NULL AS warmup,
       CASE WHEN COALESCE(successful_window_count,0)<2 OR window_run_id IS NULL OR NOT COALESCE(is_fresh,false)
                 OR state NOT IN ('healthy','empty') THEN 'D' ELSE 'A' END AS quality_grade,
       COALESCE(successful_window_count,0)>=2 AND window_run_id IS NOT NULL AND COALESCE(is_fresh,false)
                 AND state IN ('healthy','empty') AS interpretable,
       COALESCE(state,'failed') AS latest_state,health_observed_at,freshness_sla_minutes,
       COALESCE(request_succeeded,false) AS request_succeeded,COALESCE(parse_succeeded,false) AS parse_succeeded,
       COALESCE(abnormal_empty,false) AS abnormal_empty
FROM source_evidence;

CREATE VIEW radar_analytics.market_scope_daily_metrics
WITH (security_invoker = true)
AS
WITH totals AS (
  SELECT source.day,source.scope_version_id,max(source.scope_version)::integer AS scope_version,
         source.subscription_key,max(source.subscription_name) AS subscription_name,max(source.query) AS query,
         sum(source.visible_count)::integer AS visible_count,sum(source.new_count)::integer AS new_count,
         sum(source.left_visible_window)::integer AS left_visible_window,sum(source.run_count)::integer AS run_count,
         sum(source.successful_source_count)::integer AS source_count,
         count(*)::integer AS expected_source_count,sum(source.successful_source_count)::integer AS successful_source_count,
         sum(source.failed_source_count)::integer AS failed_source_count,sum(source.stale_source_count)::integer AS stale_source_count,
         bool_or(source.warmup) AS warmup,bool_or(source.abnormal_empty) AS abnormal_empty
  FROM radar_analytics.market_scope_daily_source_metrics source
  GROUP BY source.day,source.scope_version_id,source.subscription_key
), distribution AS (
  SELECT source.day,source.scope_version_id,
         count(*) FILTER (WHERE observation.availability IN ('available','preorder','backorder'))::integer AS available_count,
         count(*) FILTER (WHERE observation.availability='sold_out')::integer AS sold_out_count,
         count(observation.price_jpy)::integer AS priced_count,
         min(observation.price_jpy)::integer AS min_price_jpy,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY observation.price_jpy)::integer AS median_price_jpy,
         round(avg(observation.price_jpy),2) AS average_price_jpy,
         max(observation.price_jpy)::integer AS max_price_jpy
  FROM radar_analytics.market_scope_daily_source_metrics source
  LEFT JOIN radar_analytics.listing_observations observation
    ON observation.run_id=source.window_run_id AND observation.source_id=source.source_id
  GROUP BY source.day,source.scope_version_id
), measured AS (
  SELECT totals.*,
         COALESCE(distribution.available_count,0)::integer AS available_count,
         COALESCE(distribution.sold_out_count,0)::integer AS sold_out_count,
         COALESCE(distribution.priced_count,0)::integer AS priced_count,
         distribution.min_price_jpy,distribution.median_price_jpy,
         distribution.average_price_jpy,distribution.max_price_jpy
  FROM totals
  LEFT JOIN distribution USING (day,scope_version_id)
), graded AS (
  SELECT measured.*,(successful_source_count::numeric/NULLIF(expected_source_count,0)) AS coverage_rate,
         CASE
           WHEN warmup OR expected_source_count=0 OR successful_source_count::numeric/NULLIF(expected_source_count,0)<0.5 THEN 'D'
           WHEN successful_source_count::numeric/NULLIF(expected_source_count,0)<0.75 OR abnormal_empty THEN 'C'
           WHEN successful_source_count<expected_source_count OR failed_source_count>0 OR stale_source_count>0 THEN 'B'
           ELSE 'A'
         END AS quality_grade
  FROM measured
)
SELECT graded.*,quality_grade IN ('A','B') AND NOT warmup AS interpretable
FROM graded;

COMMENT ON TABLE radar_analytics.market_scope_versions IS
  'Immutable semantic scope for comparable market observations. Operational enable/cooldown state is excluded.';
COMMENT ON TABLE radar_analytics.source_health_snapshots IS
  'Immutable per-run source health. Failed or suspicious observations never close the last successful visible window.';
COMMENT ON VIEW radar_analytics.market_scope_daily_metrics IS
  'Coverage-aware Tokyo-day market metrics. Values carry the last successful source window while quality records failures and staleness.';

REVOKE ALL ON radar_analytics.market_scope_versions FROM PUBLIC,anon,authenticated;
REVOKE ALL ON radar_analytics.source_health_snapshots FROM PUBLIC,anon,authenticated;
REVOKE ALL ON radar_analytics.market_scope_daily_source_metrics FROM PUBLIC,anon,authenticated;
REVOKE ALL ON radar_analytics.market_scope_daily_metrics FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_search_run_v3(jsonb) FROM PUBLIC,anon,authenticated;

GRANT SELECT,INSERT ON radar_analytics.market_scope_versions TO radar_analytics_runtime;
GRANT SELECT,INSERT ON radar_analytics.source_health_snapshots TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.market_scope_daily_source_metrics TO radar_analytics_runtime;
GRANT SELECT ON radar_analytics.market_scope_daily_metrics TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_search_run_v3(jsonb) TO radar_analytics_runtime;
