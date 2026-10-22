-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Cron dispatch observability migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 让"系统追不追得上"这件事第一次变得可测。
--
-- 原来的 cron_heartbeats 有两个结构性缺陷，叠加之后它在最需要它的时候恰好失效：
--
-- 1. due_bindings 记的是 dueBindings(MAX_ACTIVE_BINDINGS) 返回的**条数**，
--    而那个查询带 LIMIT 80。也就是说这个指标的取值上限就是 80——积压一旦超过
--    一跳的派发量，它就永远显示 80，再也分辨不出是刚好 80 还是欠了 8000。
-- 2. 写入点在 getUTCMinutes()===7 的每小时维护块里，一天只有 24 个采样点，
--    每个采样点只反映整点过 7 分那一秒的瞬时状态。2026-09-09 查到的 24 小时
--    记录里 due_bindings 全是 0，这既不能证明没有积压，也不能证明有。
--
-- 所以新增三列，并把写入改成每跳一次：
--   due_bindings_total / due_tracked_total —— 不带 LIMIT 的真实待办量，
--     这是唯一能回答"欠账在涨还是在还"的数
--   dispatch_ms —— 一跳里预约 + 入队总共花了多久。派发循环是串行的
--     （每个绑定一次 reserve 一次 send），这个数决定 cron 自己什么时候变成瓶颈
--
-- 每分钟一行、保留 30 天约 4.3 万行，对这张表可以忽略。
ALTER TABLE radar_core.cron_heartbeats
  ADD COLUMN IF NOT EXISTS due_bindings_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_tracked_total bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_ms bigint NOT NULL DEFAULT 0;

-- 按时间倒序取最近若干跳是这张表唯一的读法（观察积压曲线），observed_at 上
-- 已有索引；scheduled_at 用于和 Workers 侧的 cron 时间对齐，补一个。
CREATE INDEX IF NOT EXISTS idx_cron_heartbeats_scheduled
  ON radar_core.cron_heartbeats (scheduled_at DESC);
