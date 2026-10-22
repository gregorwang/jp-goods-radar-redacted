-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing group jobs migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 首次建档回执的图片分组任务（apps/image-dedup，collector 的 listing-grouping.ts 每两分钟推进一次）。
-- 一行 = 一封回执的分组算到哪了。没有行 = 还没开始；结果写进 listing_same_groups。
--   status   queued（手工要求重跑）/ running（已交给 Modal，call_id 是 Modal 的任务编号）/ done / failed
--   attempts 已经交给 Modal 几次；failed 且没到上限的会被再次提交
-- 重跑一封：UPDATE radar_core.listing_group_jobs SET status='queued', attempts=0 WHERE event_id='…';
--   没有行的老回执：INSERT INTO radar_core.listing_group_jobs(event_id,status) VALUES('…','queued');
--   旧分组在新结果写入前一直有效，清单页不会中途退回同名折叠。
CREATE TABLE IF NOT EXISTS radar_core.listing_group_jobs (
    event_id text PRIMARY KEY REFERENCES radar_core.events(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    call_id text,
    attempts integer NOT NULL DEFAULT 0,
    error text,
    stats_json text,
    started_at text,
    finished_at text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_group_jobs_status ON radar_core.listing_group_jobs(status);
