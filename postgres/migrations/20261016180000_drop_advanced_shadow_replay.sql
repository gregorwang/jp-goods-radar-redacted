-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Drop advanced shadow replay migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 影子回放下线（2026-10-16 用户定）。7 月 19 日上线的"高级情报影子演练"：每晚把确认同款过一遍
-- 划算度 / 流动性 / 稀缺 / 价差 / 季节性五道门槛，结果只写库不给人看。
-- 91 天 1695 件次、每件 5 项，一次都没过门槛（门槛要两年数据，现有用法永远够不着），
-- 也没有任何页面读它。代码同批删除；同款行情情报页（唯一读 advanced_intelligence_readiness_v1
-- 的地方）一起删了。landed_cost_v1 / cost_profiles 不动：提醒引擎的"到手价低于目标"还引用它们。
DROP FUNCTION IF EXISTS radar_analytics.record_advanced_shadow_replay(jsonb);
DROP TABLE IF EXISTS radar_analytics.advanced_shadow_replay_capabilities;
DROP TABLE IF EXISTS radar_analytics.advanced_shadow_replay_variants;
DROP TABLE IF EXISTS radar_analytics.advanced_shadow_replay_runs;

DELETE FROM radar_core.runtime_feature_flags
WHERE flag_key IN ('advanced_shadow_replay_v1', 'advanced_intelligence_readiness_v1');
