BEGIN;

UPDATE radar_analytics.source_response_captures
SET raw_payload = NULL
WHERE payload_kind = 'html' AND raw_payload IS NOT NULL;

ALTER TABLE radar_analytics.source_response_captures
  DROP CONSTRAINT IF EXISTS source_response_captures_html_metadata_only;
ALTER TABLE radar_analytics.source_response_captures
  ADD CONSTRAINT source_response_captures_html_metadata_only
  CHECK (payload_kind <> 'html' OR raw_payload IS NULL) NOT VALID;
ALTER TABLE radar_analytics.source_response_captures
  VALIDATE CONSTRAINT source_response_captures_html_metadata_only;

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
    CASE
      WHEN capture_value ->> 'payloadKind' = 'html' THEN NULL
      ELSE capture_value ->> 'rawPayload'
    END,
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
  'Transport metadata and bounded structured response evidence captured before semantic processing; complete HTML bodies are not retained.';
COMMENT ON COLUMN radar_analytics.source_response_captures.raw_payload IS
  'Bounded structured response text when analytically useful. Always null for HTML captures.';

COMMIT;
