-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Keyword new-listing anchor attempts migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 锚定轮的尝试计数。
--
-- 首次锚定轮用 8 页预算把存量一次性挖出来，并且不推上新。但那一轮可能没读满预算就停：
-- 后续页失败是被容忍的（保留已采到的页、停止回溯、整轮仍报 success），于是"只挖到 1 页"
-- 和"完整挖了 8 页"在库里长得一模一样。此前 new_listing_anchored_at 无条件落锁，
-- 一次截断就把深挖机会永久用掉——09-05 路人女主的 rakuten_ichiba 第 2 页吃了 429，
-- 锚定深度停在 30 条，而日常轮要读 5 页，差出来的存量会在下一轮冒充成上新。
--
-- 改为：截断且没够到日常深度的锚定轮不落锁，下一轮重来。这一列记录已经试了几次，
-- 用完上界（NEW_LISTING_ANCHOR_MAX_ATTEMPTS）就接受既有深度，避免某个来源永远锚不上、
-- 从而永远不推上新。
ALTER TABLE radar_core.watch_bindings
  ADD COLUMN IF NOT EXISTS new_listing_anchor_attempts integer NOT NULL DEFAULT 0;
