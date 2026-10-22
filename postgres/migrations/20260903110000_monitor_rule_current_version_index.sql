-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
-- Historical rules share a rule_key. Only the current version must be unique;
-- (rule_key, version) remains unique across the complete history.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Monitor rule version index repair requires the migration runner';
  END IF;
END
$runner_contract$;

-- Keep replacement atomic so concurrent saves never see an unprotected table.
LOCK TABLE radar_core.monitor_rules IN SHARE ROW EXCLUSIVE MODE;
DROP INDEX radar_core.idx_50534_idx_monitor_rules_current;
CREATE UNIQUE INDEX idx_50534_idx_monitor_rules_current
  ON radar_core.monitor_rules (rule_key) WHERE valid_to IS NULL;
