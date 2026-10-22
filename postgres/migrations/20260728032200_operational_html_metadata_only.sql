BEGIN;

UPDATE radar_core.source_response_captures
SET raw_payload = NULL
WHERE payload_kind = 'html' AND raw_payload IS NOT NULL;

ALTER TABLE radar_core.source_response_captures
  DROP CONSTRAINT IF EXISTS ck_source_response_captures_html_metadata_only;
ALTER TABLE radar_core.source_response_captures
  ADD CONSTRAINT ck_source_response_captures_html_metadata_only
  CHECK (payload_kind <> 'html' OR raw_payload IS NULL) NOT VALID;
ALTER TABLE radar_core.source_response_captures
  VALIDATE CONSTRAINT ck_source_response_captures_html_metadata_only;

COMMENT ON SCHEMA radar_core IS
  'PostgreSQL operational store used by the web and collector Workers through Hyperdrive.';
COMMENT ON TABLE radar_core.source_response_captures IS
  'Transport metadata and bounded structured response evidence; complete HTML bodies are not retained.';
COMMENT ON COLUMN radar_core.source_response_captures.raw_payload IS
  'Bounded structured response text when analytically useful. Always null for HTML captures.';

COMMIT;
