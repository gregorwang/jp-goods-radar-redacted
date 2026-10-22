-- Retire the historical in-app AI market-report store. The product no longer
-- renders, generates, or reads these reports; durable market evidence remains
-- in the other radar_analytics relations for Databricks and product workflows.
--
-- Do not add BEGIN/COMMIT: jpgr-apply-analytics-migrations provides one outer
-- transaction and records this file's checksum in that same transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION
      'market-report retirement requires runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = session_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'market-report retirement requires a superuser session behind SET ROLE jpgr_owner';
  END IF;
END
$runner_contract$;

-- Fail fast instead of waiting behind an unexpected legacy consumer or a
-- concurrent schema change. No application runtime should access this table.
LOCK TABLE jpgr_meta.schema_migrations
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE radar_analytics.market_ai_reports
  IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $precondition$
BEGIN
  IF pg_catalog.to_regclass('radar_analytics.market_ai_reports') IS NULL THEN
    RAISE EXCEPTION 'market_ai_reports is already absent; refusing an unreviewed migration state';
  END IF;
END
$precondition$;

-- RESTRICT is intentional: any unreviewed view, function, or foreign-key
-- dependency must make the transaction fail rather than be removed implicitly.
DROP TABLE radar_analytics.market_ai_reports RESTRICT;

DO $postcondition$
BEGIN
  IF pg_catalog.to_regclass('radar_analytics.market_ai_reports') IS NOT NULL THEN
    RAISE EXCEPTION 'market_ai_reports still exists after retirement';
  END IF;
END
$postcondition$;
