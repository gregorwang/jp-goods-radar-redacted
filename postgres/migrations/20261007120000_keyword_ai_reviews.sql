-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Keyword AI reviews migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 关键词档案的 AI 复核结论。
--
-- 关键词日报只发 AI 判为 relevant 的商品（送达门槛对关键词档案恒为 confirmed_only），
-- 所以 AI 拒掉或拿不准的商品，用户永远看不见——AI 判错了也没人知道。复核页把其中
-- 最可能被误杀的那一小撮挑出来给人看，这张表记下人的结论：
--   ai_correct  AI 没判错，这条不再出现在复核队列里。
--   ai_wrong    AI 判错了，其实是相关商品。采集侧此后对这条商品不再采信 AI 的否定，
--               按已确认处理（降价、售罄等照常提醒）；同时这是 AI 的错判样本。
--
-- 和 watch_dismissed_candidates 分开：那张表是精确同款雷达的"别再提醒我"，
-- 会被投递查询当成过滤器读；这张表方向相反，而且只在复核页和采集定稿时读。
--
-- match_created 记录"改判为相关"时是否由复核页新建了 watch_listing_matches 行。
-- 撤销时只删自己建的那一行，不碰 AI 本来就确认过的匹配。
CREATE TABLE IF NOT EXISTS radar_core.keyword_ai_reviews (
    watch_binding_id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    verdict text NOT NULL,
    ai_relevance text,
    match_created boolean DEFAULT false NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT pk_keyword_ai_reviews PRIMARY KEY (watch_binding_id, source_id, source_item_id),
    CONSTRAINT ck_keyword_ai_reviews_01
      CHECK (verdict = ANY (ARRAY['ai_correct'::text, 'ai_wrong'::text]))
);

ALTER TABLE radar_core.keyword_ai_reviews
  DROP CONSTRAINT IF EXISTS keyword_ai_reviews_watch_binding_id_fkey;
ALTER TABLE radar_core.keyword_ai_reviews
  ADD CONSTRAINT keyword_ai_reviews_watch_binding_id_fkey
  FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;

-- 复核页按档案读近 30 天的观测；现有索引只有 (watch_binding_id, watch_run_id, ordinal)，
-- 按 observed_at 截窗口时要扫完一个绑定的全部历史。
CREATE INDEX IF NOT EXISTS idx_watch_run_listing_observations_binding_observed
  ON radar_core.watch_run_listing_observations USING btree (watch_binding_id, observed_at);
