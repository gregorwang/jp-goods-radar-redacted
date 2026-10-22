-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Suspect notice policy migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 每个精确同款档案自己决定"什么档位值得发邮件"（AGENTS.md §4）。
--
-- 在此之前送达门槛是硬编码的：只要候选可购买、decision_status 是 uncertain 或
-- rejected、match_relation 属于 probable_exact/uncertain/related/bundle，就一律进
-- 「疑似同款」分区发出去，零确认时还会单独发一封「N 件疑似同款待你判断」。
-- 于是 2026-09-06 出现了这样的邮件：AI 自己在理由里写着"角色为拉姆，且品类是手办，
-- 与目标爱蜜莉雅毛绒玩具不符"，系统仍然把它送进了收件箱。判定是对的，送达是错的。
--
-- 判定档位和送达门槛必须分开。同一个"高度疑似"，对求了三年的绝版是必须看，对随手
-- 加的便宜货是骚扰——这个权重只有用户知道，所以它是每个档案一个设置，没有全局开关。
--
--   confirmed_only    只发确认同款。默认，也是存量档案的迁移目标。
--   strong_suspects   确认同款 + 高度疑似（AI 未否定的 probable_exact / uncertain）。
--   all_suspects      迁移前的行为，related / bundle 也发。给"宁可多看一眼"的人。
ALTER TABLE radar_core.watch_profiles
  ADD COLUMN suspect_notice_policy text NOT NULL DEFAULT 'confirmed_only',
  ADD CONSTRAINT ck_watch_profiles_03 CHECK (
    suspect_notice_policy = ANY (ARRAY['confirmed_only'::text,'strong_suspects'::text,'all_suspects'::text])
  );

-- 存量档案一并落到最严的一档。默认值服务的是"还没想清楚这件商品对自己多重要"的人，
-- 那种状态下少打扰比多打扰安全：想多看的人会主动去调，被烦到的人只会不再打开邮件。
UPDATE radar_core.watch_profiles
SET suspect_notice_policy = 'confirmed_only'
WHERE dossier_kind = 'exact_product';

-- AI 的相关性表态落库。
--
-- 模型早就在给这个结论（listingEnrichmentSchema.relevance，三值），它也被拼进
-- decision_reason 展示给用户看了，但从未参与决策，也从未成为可查询的列：
-- exactProductIdentityDecision 在读 AI 输出之前就按 match_relation 短路，摘要查询
-- 只看 decision_status 和 match_relation。"AI 说不是"和"匹配器分数不够"在库里同分，
-- 于是 SQL 层想筛也筛不了。
--
-- 落成两列之后，中间档 strong_suspects 才有真正的判据：AI 明确 irrelevant 的不发，
-- AI 说 relevant 或说不准的才留在"高度疑似"里。
ALTER TABLE radar_core.watch_run_listing_observations
  ADD COLUMN ai_relevance text,
  ADD COLUMN ai_confidence text,
  ADD CONSTRAINT ck_watch_run_listing_observations_05 CHECK (
    ai_relevance IS NULL
    OR ai_relevance = ANY (ARRAY['relevant'::text,'irrelevant'::text,'uncertain'::text])
  ),
  ADD CONSTRAINT ck_watch_run_listing_observations_06 CHECK (
    ai_confidence IS NULL
    OR ai_confidence = ANY (ARRAY['high'::text,'medium'::text,'low'::text])
  );
