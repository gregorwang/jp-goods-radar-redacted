-- Durable pre-parser source evidence. Adapters may evolve, but the response
-- that produced a run remains available for replay and AI cleaning.
CREATE TABLE radar_analytics.source_response_captures (
  capture_id text PRIMARY KEY,
  run_id uuid NOT NULL,
  source_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  request_url text NOT NULL,
  response_url text,
  request_method text NOT NULL,
  response_status integer,
  content_type text,
  payload_kind text NOT NULL
    CHECK (payload_kind IN ('json','html','text','binary','empty','unreadable')),
  raw_payload text,
  payload_bytes bigint NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  content_hash text NOT NULL,
  captured_at timestamptz NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  truncated boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_id, ordinal),
  FOREIGN KEY (run_id, source_id)
    REFERENCES radar_analytics.search_run_sources(run_id, source_id)
    ON DELETE CASCADE
);

CREATE INDEX source_response_captures_source_time_idx
  ON radar_analytics.source_response_captures(source_id, captured_at DESC);

CREATE INDEX source_response_captures_run_idx
  ON radar_analytics.source_response_captures(run_id, source_id, ordinal);

CREATE OR REPLACE FUNCTION radar_analytics.ingest_source_response_captures(p_payload jsonb)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, radar_analytics
AS $$
  INSERT INTO radar_analytics.source_response_captures(
    capture_id,run_id,source_id,ordinal,request_url,response_url,request_method,
    response_status,content_type,payload_kind,raw_payload,payload_bytes,content_hash,
    captured_at,duration_ms,truncated,error_message
  )
  SELECT
    capture_value ->> 'id',
    (p_payload ->> 'id')::uuid,
    capture_value ->> 'sourceId',
    (capture_value ->> 'ordinal')::integer,
    capture_value ->> 'requestUrl',
    NULLIF(capture_value ->> 'responseUrl',''),
    capture_value ->> 'requestMethod',
    (capture_value ->> 'responseStatus')::integer,
    NULLIF(capture_value ->> 'contentType',''),
    capture_value ->> 'payloadKind',
    capture_value ->> 'rawPayload',
    COALESCE((capture_value ->> 'payloadBytes')::bigint,0),
    capture_value ->> 'contentHash',
    (capture_value ->> 'capturedAt')::timestamptz,
    COALESCE((capture_value ->> 'durationMs')::integer,0),
    COALESCE((capture_value ->> 'truncated')::boolean,false),
    NULLIF(capture_value ->> 'error','')
  FROM jsonb_array_elements(COALESCE(p_payload -> 'captures','[]'::jsonb)) AS captures(capture_value)
  ON CONFLICT (capture_id) DO NOTHING
$$;

COMMENT ON TABLE radar_analytics.source_response_captures IS
  'Source HTTP response bodies captured before parsing or semantic filtering. Credentials and request headers are never stored.';
COMMENT ON COLUMN radar_analytics.source_response_captures.raw_payload IS
  'Exact bounded text body received from the source. truncated=true means the upstream body exceeded the capture safety boundary.';

REVOKE ALL ON radar_analytics.source_response_captures FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION radar_analytics.ingest_source_response_captures(jsonb) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON radar_analytics.source_response_captures TO radar_analytics_runtime;
GRANT EXECUTE ON FUNCTION radar_analytics.ingest_source_response_captures(jsonb) TO radar_analytics_runtime;
