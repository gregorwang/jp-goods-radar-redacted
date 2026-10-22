-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Dossier delivery channels migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 档案决定通知发到哪（docs/进行中/档案决定送达渠道-待开发-20261013.md，2026-10-14 用户定）。
--
-- 每个档案两个独立开关，管这个档案的全部通知（关键词每小时 / 每天一轮的日报、精确同款上新、降价等商品变化）：
--   notify_email   1 = 发邮件
--   notify_feishu  1 = 发飞书（群 webhook 为主，飞书应用私聊备用；发群由「推送」页每个群勾的档案决定）
-- 两个都关 = 只巡回、不通知。只开飞书时，飞书没送到就改发邮件（apps/collector/src/push-delivery.ts）。
-- 来源故障提醒、精确同款周报不属于单个档案，不受这两个开关管，照发邮件。
--
-- 默认：邮件开、飞书关（新建档案、以及除下面 4 个以外的所有档案）。
ALTER TABLE radar_core.watch_profiles
  ADD COLUMN IF NOT EXISTS notify_email bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notify_feishu bigint NOT NULL DEFAULT 0;

ALTER TABLE radar_core.watch_profiles
  ADD CONSTRAINT ck_watch_profiles_06 CHECK (notify_email = ANY (ARRAY[0::bigint,1::bigint])),
  ADD CONSTRAINT ck_watch_profiles_07 CHECK (notify_feishu = ANY (ARRAY[0::bigint,1::bigint]));

-- 原来在每小时推送名单（owner_push_v1.config_json.profileIds）里的 4 个关键词档案：邮件开、飞书开（用户定）。
UPDATE radar_core.watch_profiles p SET notify_feishu = 1
WHERE p.id IN (
  SELECT jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(f.config_json::jsonb->'profileIds') = 'array' THEN f.config_json::jsonb->'profileIds' ELSE '[]'::jsonb END)
  FROM radar_core.runtime_feature_flags f WHERE f.flag_key = 'owner_push_v1'
);

-- 名单和 emailOff 从此不再读：清掉，免得以后有人以为改它还管用。owner_push_v1.enabled 仍是飞书 / App 这一路的总闸。
UPDATE radar_core.runtime_feature_flags SET config_json = '{}', updated_at = now()::text
WHERE flag_key = 'owner_push_v1';

-- 推送投递记录多三列：
--   handed_over_at     这份通知的邮件被拿走、交给飞书的时间（只开飞书的档案）。只有它有值的才会在飞书没送到时退回邮件——
--                      email_suppressed_at 还被超量汇总等别的路径用，单看它分不清。
--   relay_outcome      推送服务回报的飞书结果：delivered（至少一个群或私聊收到了）/ failed（一个都没收到）。
--                      status='sent' 只说明推送服务收下了，飞书发没发出去要看这一列。
--   relay_outcome_error  没送到的原因，退回邮件时写进邮件开头那句话。
ALTER TABLE radar_core.push_deliveries
  ADD COLUMN IF NOT EXISTS handed_over_at text,
  ADD COLUMN IF NOT EXISTS relay_outcome text,
  ADD COLUMN IF NOT EXISTS relay_outcome_at text,
  ADD COLUMN IF NOT EXISTS relay_outcome_error text;

ALTER TABLE radar_core.push_deliveries
  ADD CONSTRAINT ck_push_deliveries_relay_outcome CHECK (relay_outcome IS NULL OR relay_outcome = ANY (ARRAY['delivered'::text, 'failed'::text]));

-- 上线前已经推出去的不再回头查结果（推送服务那时还不记结果），当作送到了。
UPDATE radar_core.push_deliveries SET relay_outcome = 'delivered', relay_outcome_at = COALESCE(sent_at, updated_at)
WHERE status = 'sent' AND relay_outcome IS NULL;

-- 等结果的那几行（status='sent'、结果还没回来）每分钟查一次。
CREATE INDEX IF NOT EXISTS idx_push_deliveries_awaiting_outcome
  ON radar_core.push_deliveries USING btree (sent_at) WHERE status = 'sent' AND relay_outcome IS NULL;
