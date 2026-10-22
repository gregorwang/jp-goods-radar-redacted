-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Keyword digest extras migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 关键词日报每件商品下面附带的价格参考，按档案开关（packages/core/src/digest-extras.ts）。
--
-- 日报发信前会调 teika-lookup 的 /enrich，拿回官方定価、AI 预测价和同款成交。有的档案
-- 主人根本不看原价（2026-10-11：赛车初音只想看上新），那几行对他是噪音；AI 预测价还要
-- 唤醒 Modal 的 GPU，按开机秒数计费。关掉的部分就不再请求，不只是不显示。
--
--   digest_price_reference
--     official_and_ai  官方定価 + AI 预测价。默认，也是迁移前的行为。
--     official_only    只显示查到的官方定価，不调估价模型。
--     off              原价一行都不显示，定価也不查（同款成交仍可单独开着）。
--   digest_show_sales  同款行情 / 同款成交（1 = 显示）。
--
-- 两项都关时整个 /enrich 都不调。默认值保持迁移前的行为：这里管的是一封要发的邮件里
-- 多几行，不是"发不发"，不受 AGENTS.md §4「默认最严」约束；存量档案不该一上线就少了内容。
ALTER TABLE radar_core.watch_profiles
  ADD COLUMN IF NOT EXISTS digest_price_reference text NOT NULL DEFAULT 'official_and_ai',
  ADD COLUMN IF NOT EXISTS digest_show_sales bigint NOT NULL DEFAULT 1;

ALTER TABLE radar_core.watch_profiles
  ADD CONSTRAINT ck_watch_profiles_04 CHECK (
    digest_price_reference = ANY (ARRAY['official_and_ai'::text,'official_only'::text,'off'::text])
  ),
  ADD CONSTRAINT ck_watch_profiles_05 CHECK (digest_show_sales = ANY (ARRAY[0::bigint,1::bigint]));

-- 新建关键词档案的默认值。它只在建档那一刻被读一次，不是总开关：每封日报只看自己档案的设置，
-- 改默认值不会动已有档案（要改已有档案，后台有「应用到全部关键词档案」，那是一次性批量写入）。
INSERT INTO radar_core.runtime_feature_flags(flag_key, enabled, config_json, updated_at)
VALUES (
  'keyword_digest_extras_defaults',
  1,
  '{"schemaVersion":1,"priceReference":"official_and_ai","showSales":true}',
  now()::text
)
ON CONFLICT (flag_key) DO NOTHING;
