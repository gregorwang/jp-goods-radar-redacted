-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Exact reference images migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 精确同款按参考图找货（docs/进行中/精确同款参考图-交接-20261009.md）。

-- 1. 两个花钱功能的开关，插成关着（Modal 额度不够，2026-10-09 用户定：链路搭好、开关关着）。
--    关着时完全不调用 Modal，$0。打开 / 关掉见 docs/成本/成本账本.md §5：
--    UPDATE radar_core.runtime_feature_flags SET enabled=1, updated_at=now()::text WHERE flag_key='…';
--   exact_reference_image_v1   精确同款按用户给的参考图给候选打分（collector 的 exact-reference-image.ts）
--   listing_image_grouping_v1  建档回执的图片分组（collector 的 listing-grouping.ts）
INSERT INTO radar_core.runtime_feature_flags(flag_key, enabled, config_json, updated_at) VALUES
  ('exact_reference_image_v1', 0, '{"schemaVersion":1}', now()::text),
  ('listing_image_grouping_v1', 0, '{"schemaVersion":1}', now()::text)
ON CONFLICT (flag_key) DO NOTHING;

-- 2. 用户给的参考图，每个精确同款档案 1～2 张。图少，直接存库，不开 R2。
--    上传时在浏览器里缩到长边 ≤1024 的 JPEG（约 100～300KB），存 base64 文本：
--    Hyperdrive 这条链路上没有用过二进制参数，文本最稳；一张图 base64 后不到 0.5MB。
CREATE TABLE IF NOT EXISTS radar_core.watch_profile_reference_images (
    watch_profile_id text NOT NULL REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2),
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    image_base64 text NOT NULL CHECK (length(image_base64) BETWEEN 1 AND 2000000),
    width integer,
    height integer,
    created_at text NOT NULL,
    PRIMARY KEY (watch_profile_id, ordinal)
);

-- 3. 图片打分落库，像 ai_relevance 一样参与判定（AGENTS.md §4：结论要落成可查询的列，
--    不能只拼进 decision_reason）。没打过分的都是 NULL——开关关着时整列都是 NULL。
--   image_sim            整体相似度（DINOv2 + SigLIP 余弦平均），取最好的那张参考图
--   image_inliers        细节点：两张图上能一一对上、位置关系也对得上的点数
--   image_verdict        按当时的门槛判出的结论：match（图片对上）/ mismatch（没对上）
--   image_reference_key  打分时用的是哪一组参考图（换了参考图就重新打分，不复用旧分）
ALTER TABLE radar_core.watch_run_listing_observations
  ADD COLUMN IF NOT EXISTS image_sim real,
  ADD COLUMN IF NOT EXISTS image_inliers integer,
  ADD COLUMN IF NOT EXISTS image_verdict text,
  ADD COLUMN IF NOT EXISTS image_reference_key text;
ALTER TABLE radar_core.watch_run_listing_observations
  ADD CONSTRAINT ck_watch_run_listing_observations_07 CHECK (
    image_verdict IS NULL OR image_verdict = ANY (ARRAY['match'::text, 'mismatch'::text])
  );

-- 4. 标题没能确认、图片和参考图对上的候选，确认同款的理由是"参考图"，不是文字。
--    单独一个 acceptance_reason，事后能查出哪些确认是图片给的。
ALTER TABLE radar_core.watch_listing_matches DROP CONSTRAINT ck_watch_listing_matches_01;
ALTER TABLE radar_core.watch_listing_matches ADD CONSTRAINT ck_watch_listing_matches_01 CHECK (
  acceptance_reason = ANY (ARRAY['legacy'::text, 'direct_item'::text, 'keyword_relevant'::text,
    'deterministic_exact'::text, 'semantic_exact'::text, 'anchor_known'::text, 'image_reference'::text])
);
