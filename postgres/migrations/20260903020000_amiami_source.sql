-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'AmiAmi source registration requires the migration runner';
  END IF;
END
$runner_contract$;

INSERT INTO radar_core.source_registry (
  id, display_name, transport, identity_scope, official_api, enabled,
  credential_status, health_status, capabilities_json, parser_version,
  request_route, created_at, updated_at
) VALUES (
  'amiami', 'AmiAmi（あみあみ）', 'internal_api', 'catalog', 0, 1,
  'not_required', 'unknown',
  '{"keywordSearch":true,"itemLookup":true,"newestSort":true,"priceFilter":true,"conditionFilter":true,"supportsUsed":true,"supportsSoldOut":true,"historySearchSupported":false}',
  'amiami-json-ja-v1', 'mercari_service',
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) ON CONFLICT (id) DO NOTHING;
