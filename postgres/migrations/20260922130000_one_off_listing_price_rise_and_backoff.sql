-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'One-off listing price-rise migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 一次性挂牌：涨价提醒 + 退避封顶的存量修复。
--
-- 2026-09-22 的事故：一条 27500 日元的绝版 Mercari 挂牌稳定三周，自适应退避把
-- 检查间隔拉到 45.8 小时。卖家涨到 33000、随后被人买走，两件事整段落在同一个
-- 盲区里，一封通知都没有。代码里 price_rise 的事件类型、邮件模板、投递优先级
-- 全都齐备，唯独 notifyPriceRise 在 collector 的 7 个调用点被硬编码成 false，
-- 数据库连开关列都没有——涨价不是这次没发，是从来不会发。
--
-- 退避上限已在 packages/core/src/item-schedule.ts 按来源封顶（一次性挂牌 6 小时），
-- readItemScheduleState 会把存量的 intervalMinutes 自动夹回去。但 next_run_at 是
-- 已经写进表里的时刻，夹不回来：这次事故那条的下一次检查排在 45 小时之后。
-- 这里把被退避推远的排期拉回来，否则封顶要等下一次自然到期才生效。

ALTER TABLE radar_core.watch_bindings
  ADD COLUMN IF NOT EXISTS notify_price_rise bigint NOT NULL DEFAULT 0;

DO $price_rise_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'radar_core.watch_bindings'::regclass AND conname = 'ck_watch_bindings_notify_price_rise'
  ) THEN
    ALTER TABLE radar_core.watch_bindings
      ADD CONSTRAINT ck_watch_bindings_notify_price_rise CHECK (notify_price_rise = ANY (ARRAY[0::bigint, 1::bigint]));
  END IF;
END
$price_rise_check$;

-- 默认只对一次性挂牌的单品监控打开。
--
-- 为什么不是全局默认开：对商家目录商品，涨价是常态价格波动，下次还能买，
-- 发信只是消耗注意力。为什么这一档默认开：用户手工为某条 C2C 挂牌建单品监控，
-- 本身就已经表达了"我在等这件东西"；这类挂牌售出即终局，涨价往往是它要走的
-- 前兆，属于"看一眼就要做决定"的信号，不是背景噪音。
-- 关键词绑定一律不开：那是在看市场，不是在等某一件。

UPDATE radar_core.watch_bindings b
SET notify_price_rise = 1,
    updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM radar_core.watch_profiles p
WHERE p.id = b.watch_profile_id
  AND b.kind = 'item'
  AND b.monitoring_purpose = 'item_price'
  AND b.source_id IN ('mercari_jp', 'yahoo_auctions_jp', 'yahoo_fleamarket_jp', 'ebay')
  AND b.notify_price_rise = 0;

-- 把被退避推到封顶之外的排期拉回来。上限与 ONE_OFF_MAX_INTERVAL_MINUTES 一致：
-- 6 小时，但绝不早于用户自己设定的基础间隔（只加密，不越过用户的显式选择）。
UPDATE radar_core.watch_bindings b
SET next_run_at = to_char(
      (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(mins => GREATEST(b.schedule_interval_minutes, 360)::int),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM radar_core.watch_profiles p
WHERE p.id = b.watch_profile_id
  AND b.enabled = 1
  AND b.kind = 'item'
  AND b.monitoring_purpose = 'item_price'
  AND b.source_id IN ('mercari_jp', 'yahoo_fleamarket_jp', 'ebay')
  AND b.next_run_at > to_char(
      (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(mins => GREATEST(b.schedule_interval_minutes, 360)::int),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
