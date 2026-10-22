-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Watch profile changes migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 档案改动记录（2026-10-16 用户定）：档案页上每次保存记一行「几点、改了哪项、从什么改成什么」，
-- 档案页底部列出来，只看、不能回滚。
--
-- 起因：10-16 早上把加藤惠改成每天一次时，保存顺手把「下次巡回」写成了前一天的时间，
-- 全部来源当场跑了一轮、多发了一封日报；事后只能翻 watch_bindings.updated_at 和 watch_runs 对时间才看出来。
--
-- monitor_rules.version 不是这个用途：它只管「发生什么时提醒我」那一块，供事件对账用；
-- 频率、关键词、通知去向改了它都不会变。
--
--   source_id     改的是某一个来源时填（频率、下次巡回、暂停 / 恢复某来源）；整份档案的设置为 NULL。
--                 同一次保存同步到多个来源时会写多行，页面按「同一分钟、同一项、同样的前后值」合成一行。
--   field         改了哪项，见 apps/web/src/lib/profile-change-log.ts 的 PROFILE_CHANGE_FIELDS
--   before_value / after_value  已经写成给人看的文字（「每小时」「10/16 17:00」），NULL 表示「空」
CREATE TABLE IF NOT EXISTS radar_core.watch_profile_changes (
    id text NOT NULL PRIMARY KEY,
    watch_profile_id text NOT NULL REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE,
    source_id text,
    field text NOT NULL,
    before_value text,
    after_value text,
    changed_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_profile_changes_profile
  ON radar_core.watch_profile_changes USING btree (watch_profile_id, changed_at DESC);
