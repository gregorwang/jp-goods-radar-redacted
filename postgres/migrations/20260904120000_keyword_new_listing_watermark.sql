-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Keyword new-listing watermark migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 关键词上新的增量锚点。
--
-- 此前"上新"完全依赖 ID 差集，而已知 ID 集合一半来自 90 天就会被清理的
-- watch_run_listing_observations，且窗口只读一页，于是"没见过"既可能是真的新上架，
-- 也可能只是窗口漂移把老商品带了进来。
--
-- new_listing_watermark 记录该绑定已经覆盖到的最新上架时间（来源提供 sourceListedAt 时）。
-- new_listing_anchored_at 记录首次深度锚定完成的时间；为 NULL 表示这个绑定还没有建立过
-- 可信的深度基线，下一轮会用更大的页预算重新锚定，且那一轮不产生上新通知。
ALTER TABLE radar_core.watch_bindings
  ADD COLUMN IF NOT EXISTS new_listing_watermark text,
  ADD COLUMN IF NOT EXISTS new_listing_anchored_at text;
