-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Daily health check migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 每日体检。
--
-- 2026-09-28 手工翻库时发现的问题——一个单品监控 5 周没成功过一次、Amazon 连续失败
-- 15 次、成交记录 9/13 起不再写入、日报每天静默截掉几十条——全都早就躺在现有的表里，
-- 只是没有任何东西去看。所以这里不新增埋点，只把"去看"这件事做成每天自动跑的一组
-- 查询，结论落在这两张表里，由每周一的精确同款周报读出来。
--
-- 一条 finding 是一个"还没好的问题"：同一 (check_key, subject_key) 每天被再次发现时
-- 只刷新 last_seen_at；某天不再出现就记 resolved_at；恢复后又出现算新的一段，
-- first_seen_at 重置。持续了几天 = last_seen_at - first_seen_at。
CREATE TABLE IF NOT EXISTS radar_core.health_check_findings (
    check_key text NOT NULL,
    subject_key text NOT NULL,
    severity text NOT NULL,
    source_id text,
    title text NOT NULL,
    detail text NOT NULL,
    first_seen_at text NOT NULL,
    last_seen_at text NOT NULL,
    resolved_at text,
    CONSTRAINT pk_health_check_findings PRIMARY KEY (check_key, subject_key),
    CONSTRAINT ck_health_check_findings_01
      CHECK (severity = ANY (ARRAY['warning'::text, 'critical'::text]))
);

CREATE INDEX IF NOT EXISTS idx_health_check_findings_last_seen
  ON radar_core.health_check_findings USING btree (last_seen_at);

-- 一天一行（东京日期）。周报据此说明"本周体检跑了几天"，体检自己停了也看得出来。
CREATE TABLE IF NOT EXISTS radar_core.health_check_runs (
    day text NOT NULL,
    started_at text NOT NULL,
    finished_at text,
    finding_count integer NOT NULL DEFAULT 0,
    failed_checks text NOT NULL DEFAULT '[]',
    CONSTRAINT pk_health_check_runs PRIMARY KEY (day)
);

-- VPS 磁盘用量。Worker 看不到 VPS 的文件系统，由 VPS 上的 jpgr-disk-usage.timer
-- 以 postgres 身份定时写入；体检只读最新一行。
CREATE TABLE IF NOT EXISTS radar_core.host_disk_usage (
    host text NOT NULL,
    mount text NOT NULL,
    observed_at text NOT NULL,
    size_bytes bigint NOT NULL,
    used_bytes bigint NOT NULL,
    CONSTRAINT pk_host_disk_usage PRIMARY KEY (host, mount, observed_at)
);
