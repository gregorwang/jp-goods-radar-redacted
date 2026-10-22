-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Owner push migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 主人手机的推送通道（docs/进行中/安卓推送App-工程文档-20261011.md §5）。
--
-- 1. 开关，插成关着（AGENTS.md §5：试验靠开关，默认关）。只投 config_json.profileIds 里列出的档案：
--    UPDATE radar_core.runtime_feature_flags
--      SET enabled=1, config_json='{"profileIds":["<档案 id>"]}', updated_at=now()::text
--      WHERE flag_key='owner_push_v1';
--    第一次打开时 collector 记下通道启用时间，那之前的日报不补推（apps/collector/src/push-delivery.ts）。
INSERT INTO radar_core.runtime_feature_flags(flag_key, enabled, config_json, updated_at) VALUES
  ('owner_push_v1', 0, '{"profileIds":[]}', now()::text)
ON CONFLICT (flag_key) DO NOTHING;

-- 2. 投递记录，一封日报一行。结构照抄 hermes_deliveries（同一套认领 / 重试状态机），
--    多一个 skipped：这一封没有新货（只有建档存量），不推，但要记一行，免得每分钟被重新取出来。
--   remote_message_id  push-relay 那边的消息编号（App 收件列表里的 id）
CREATE TABLE IF NOT EXISTS radar_core.push_deliveries (
    id text NOT NULL PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    idempotency_key text NOT NULL,
    status text NOT NULL CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])),
    attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    remote_message_id bigint,
    last_http_status bigint CHECK (last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599)),
    last_error text,
    next_attempt_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    sent_at text
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_status ON radar_core.push_deliveries USING btree (status, next_attempt_at);
