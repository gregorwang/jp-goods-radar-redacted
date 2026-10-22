-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
-- 可以重复跑：上线前跑一次（建表 + 搬旧记录），collector 新版本上线后再跑一次（补上中间那几分钟旧代码写进旧表的记录）。
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Notice deliveries migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 三条发送队列合成一张登记簿（docs/进行中/基础设施-待办-20261014.md 第 1 项，2026-10-14 用户定）。
--
-- 以前邮件、飞书、微信各有一张投递记录（email_deliveries / push_deliveries / hermes_deliveries），
-- 取件、认领、重试、放弃各写一遍，飞书那套是照抄微信的。现在一份通知在每个渠道一行：
--   channel          email / feishu / hermes
--   status           pending 等着发 · sending 正在发 · sent 渠道收下了 · failed 这次没发成、到点重试
--                    skipped 没东西可发（日报里只有建档存量）· abandoned 不再发（原因在 last_error）
--   outcome          到没到：delivered / failed。邮件、微信收下即到；飞书要等推送服务事后回报
--   fallback_reason  这一行是因为别的渠道没送到才补的邮件：写在邮件最上面的那句原因
-- 「发到哪」仍由档案的 notify_email / notify_feishu 决定（apps/collector/src/notice-delivery.ts）。
-- 旧的三张表先留着不写，Databricks 的历史档案还在用；确认一周没问题再删。
CREATE TABLE IF NOT EXISTS radar_core.notice_deliveries (
    id text NOT NULL PRIMARY KEY,
    event_id text NOT NULL REFERENCES radar_core.events(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel = ANY (ARRAY['email'::text, 'feishu'::text, 'hermes'::text])),
    status text NOT NULL CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'abandoned'::text])),
    attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at text,
    remote_id text,
    last_http_status bigint CHECK (last_http_status IS NULL OR (last_http_status >= 100 AND last_http_status <= 599)),
    last_error text,
    outcome text CHECK (outcome IS NULL OR outcome = ANY (ARRAY['delivered'::text, 'failed'::text])),
    outcome_at text,
    outcome_error text,
    fallback_reason text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    sent_at text,
    CONSTRAINT notice_deliveries_event_channel_key UNIQUE (event_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_notice_deliveries_channel_status
  ON radar_core.notice_deliveries USING btree (channel, status, next_attempt_at);
-- 每天发了几封、最后一封什么时候发的（每日体检、事件台的共用额度）。
CREATE INDEX IF NOT EXISTS idx_notice_deliveries_channel_sent
  ON radar_core.notice_deliveries USING btree (channel, sent_at) WHERE status = 'sent';
-- 等飞书结果的那几行，每分钟查一次。
CREATE INDEX IF NOT EXISTS idx_notice_deliveries_awaiting_outcome
  ON radar_core.notice_deliveries USING btree (channel, sent_at) WHERE status = 'sent' AND outcome IS NULL;

-- 搬旧记录。同一份通知同一个渠道已经有行时，只在旧表那行更新得更晚时才覆盖：
-- 新代码动过的行 updated_at 一定更晚，不会被旧数据盖掉。

-- 邮件：sent 收下即到；其余（failed，和发到一半的 pending）记成 failed，新代码会接着重试——
-- Resend 按 event_key 幂等，已经发出去的不会再发第二封。
INSERT INTO radar_core.notice_deliveries AS n
  (id, event_id, channel, status, attempts, remote_id, last_error, outcome, outcome_at, created_at, updated_at, sent_at)
SELECT d.id, d.event_id, 'email',
       CASE WHEN d.status = 'sent' THEN 'sent' ELSE 'failed' END,
       d.attempts, d.resend_email_id, d.last_error,
       CASE WHEN d.status = 'sent' THEN 'delivered' END,
       CASE WHEN d.status = 'sent' THEN d.sent_at END,
       d.created_at, COALESCE(d.sent_at, d.created_at), d.sent_at
FROM radar_core.email_deliveries d
ON CONFLICT (event_id, channel) DO UPDATE SET
  status = EXCLUDED.status, attempts = EXCLUDED.attempts, remote_id = EXCLUDED.remote_id,
  last_error = EXCLUDED.last_error, outcome = EXCLUDED.outcome, outcome_at = EXCLUDED.outcome_at,
  updated_at = EXCLUDED.updated_at, sent_at = EXCLUDED.sent_at
WHERE EXCLUDED.updated_at > n.updated_at;

-- 飞书：退回过邮件的（last_error='handed_back_to_email'）记成 abandoned。
INSERT INTO radar_core.notice_deliveries AS n
  (id, event_id, channel, status, attempts, next_attempt_at, remote_id, last_http_status, last_error,
   outcome, outcome_at, outcome_error, created_at, updated_at, sent_at)
SELECT d.id, d.event_id, 'feishu',
       CASE WHEN d.last_error = 'handed_back_to_email' THEN 'abandoned' ELSE d.status END,
       d.attempts, d.next_attempt_at, d.remote_message_id::text, d.last_http_status,
       CASE WHEN d.last_error = 'handed_back_to_email' THEN 'returned_to_email' ELSE d.last_error END,
       d.relay_outcome, d.relay_outcome_at, d.relay_outcome_error,
       d.created_at, d.updated_at, d.sent_at
FROM radar_core.push_deliveries d
JOIN radar_core.events e ON e.id = d.event_id
ON CONFLICT (event_id, channel) DO UPDATE SET
  status = EXCLUDED.status, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at,
  remote_id = EXCLUDED.remote_id, last_http_status = EXCLUDED.last_http_status, last_error = EXCLUDED.last_error,
  outcome = EXCLUDED.outcome, outcome_at = EXCLUDED.outcome_at, outcome_error = EXCLUDED.outcome_error,
  updated_at = EXCLUDED.updated_at, sent_at = EXCLUDED.sent_at
WHERE EXCLUDED.updated_at > n.updated_at;

-- 飞书退回邮件、邮件还没发出去的：补一行邮件，带上原因（以前存在 push_deliveries.relay_outcome_error）。
INSERT INTO radar_core.notice_deliveries AS n
  (id, event_id, channel, status, attempts, fallback_reason, created_at, updated_at)
SELECT gen_random_uuid()::text, d.event_id, 'email', 'pending', 0, d.relay_outcome_error, d.updated_at, d.updated_at
FROM radar_core.push_deliveries d
JOIN radar_core.events e ON e.id = d.event_id
WHERE d.last_error = 'handed_back_to_email' AND e.status IN ('pending', 'failed')
ON CONFLICT (event_id, channel) DO UPDATE SET fallback_reason = COALESCE(n.fallback_reason, EXCLUDED.fallback_reason);

-- 微信：状态原样搬。
INSERT INTO radar_core.notice_deliveries AS n
  (id, event_id, channel, status, attempts, next_attempt_at, remote_id, last_http_status, last_error,
   outcome, outcome_at, created_at, updated_at, sent_at)
SELECT d.id, d.event_id, 'hermes', d.status, d.attempts, d.next_attempt_at, d.remote_delivery_id,
       d.last_http_status, d.last_error,
       CASE WHEN d.status = 'sent' THEN 'delivered' END,
       CASE WHEN d.status = 'sent' THEN d.sent_at END,
       d.created_at, d.updated_at, d.sent_at
FROM radar_core.hermes_deliveries d
ON CONFLICT (event_id, channel) DO UPDATE SET
  status = EXCLUDED.status, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at,
  remote_id = EXCLUDED.remote_id, last_http_status = EXCLUDED.last_http_status, last_error = EXCLUDED.last_error,
  outcome = EXCLUDED.outcome, outcome_at = EXCLUDED.outcome_at, updated_at = EXCLUDED.updated_at, sent_at = EXCLUDED.sent_at
WHERE EXCLUDED.updated_at > n.updated_at;

-- 以前「只开飞书」是靠给通知打 email_suppressed_at 把它从邮件队列拿走的；新代码改看档案开关，不再打这个标记。
-- 还在飞书路上的那几份把标记清掉，否则飞书没送到时补的邮件会被这个旧标记挡住。
-- 旧代码还在跑时清了也无妨：它发邮件前会重新拿走；新代码上线后第二次跑这个文件就清干净了。
UPDATE radar_core.events e SET email_suppressed_at = NULL
FROM radar_core.push_deliveries d
WHERE d.event_id = e.id AND d.handed_over_at IS NOT NULL
  AND e.status IN ('pending', 'failed') AND e.email_suppressed_at IS NOT NULL;
