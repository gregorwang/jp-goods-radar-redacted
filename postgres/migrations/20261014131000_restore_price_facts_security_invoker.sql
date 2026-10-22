-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Price facts security_invoker migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 20261014130000 用 CREATE OR REPLACE VIEW 改写两个价格视图时没带 WITH 选项，
-- PostgreSQL 会把视图的 reloptions 整体替换成空，security_invoker 因此丢了
-- （20260728143000 / 20260728164500 建视图时都带着它）。这里补回去。
ALTER VIEW radar_analytics.strategy_price_facts_core_v1 SET (security_invoker = true);
ALTER VIEW radar_analytics.strategy_price_facts_v1 SET (security_invoker = true);
