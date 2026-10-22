-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Watch run query attempts migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 每一轮巡检实际发到来源站的搜索词，一个词一行（apps/collector/src/query-attempts.ts）。
--
-- 精确同款雷达每轮先打主词（完整商品名），本轮没捞到可买的同款才追加一条短召回词；
-- 普通关键词档案只有一条主词。过去实际发出的词只能从煤炉的响应体里还原，其余来源
-- 走备用通道（Firecrawl / 采集服务任务）后，请求地址里看不到词，于是"主词和补搜各找回
-- 多少、确认同款是哪条词找回来的"一直无从统计（index.ts EXACT_PRODUCT_WATCH_FALLBACK_VARIANTS）。
--
--   upstream_count       来源返回、经来源侧筛选后的件数
--   candidate_count      其中收进候选的件数（每条词最多前 EXACT_PRODUCT_CANDIDATES_PER_QUERY 名）
--   new_candidate_count  前面的词没捞到、靠这条词才第一次出现的件数
--   source_item_ids_json 收进候选的商品编号，按来源排名，用来和 watch_run_listing_observations
--                        对上"确认同款是哪条词找回来的"
--
-- 不挂 watch_runs 外键：watch_runs 只留 90 天，这张表要攒更久才看得出规律，单独留 365 天。
CREATE TABLE IF NOT EXISTS radar_core.watch_run_query_attempts (
    watch_run_id text NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal > 0),
    watch_binding_id text NOT NULL,
    source_id text NOT NULL,
    role text NOT NULL CHECK (role = ANY (ARRAY['main'::text, 'fallback'::text])),
    variant_kind text NOT NULL,
    query text NOT NULL,
    outcome text NOT NULL CHECK (outcome = ANY (ARRAY['succeeded'::text, 'failed'::text])),
    upstream_count bigint NOT NULL DEFAULT 0 CHECK (upstream_count >= 0),
    candidate_count bigint NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    new_candidate_count bigint NOT NULL DEFAULT 0 CHECK (new_candidate_count >= 0),
    source_item_ids_json text NOT NULL DEFAULT '[]',
    error_message text,
    duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at text NOT NULL,
    PRIMARY KEY (watch_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_watch_run_query_attempts_binding_time
  ON radar_core.watch_run_query_attempts USING btree (watch_binding_id, created_at);
CREATE INDEX IF NOT EXISTS idx_watch_run_query_attempts_source_time
  ON radar_core.watch_run_query_attempts USING btree (source_id, created_at);
CREATE INDEX IF NOT EXISTS idx_watch_run_query_attempts_time
  ON radar_core.watch_run_query_attempts USING btree (created_at);
