-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Gemini product-target kind migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 新增 gemini_jobs.kind = 'product_target'：建档时把用户填的日文商品名抽成结构化字段。
--
-- 目标侧的指纹此前完全由正则启发式拆分（namedProductTypes 39 条品类词、namedColors
-- 29 条颜色词、detectedSize、productNameQualifier）。开放词汇追不上封闭词表，而且
-- 拆错时不是"字段缺失"而是"自信地填进错误的槽位"：线上 5 个雷达里，初音ミク 和
-- 高木さん 被当成作品名、A3プリモアート 被当成角色，レーシングVer./浴衣Ver./F：NEX限定
-- 这些版本词被 productNameQualifier 当作品相噪音直接删掉——而版本恰恰是这个领域
-- 唯一的判别符。候选侧本来就在过同一个 Gemini 抽取器（listing-enrichment 的 schema
-- 里 productType / workTitle / series / characters / editionOrModel 一应俱全），
-- 只有目标侧没有，两边根本不对称。
--
-- 这个 kind 每个档案只调用一次，按 (kind, dedupe_key) 唯一索引天然缓存：同一个商品名
-- 加同一个 prompt 版本命中同一行，不会重复计费。抽取失败时调用方回退到原有启发式，
-- 不阻塞建档（AGENTS.md §4：宁可降级，不可拦住用户）。
ALTER TABLE radar_core.gemini_jobs DROP CONSTRAINT IF EXISTS ck_gemini_jobs_01;
ALTER TABLE radar_core.gemini_jobs ADD CONSTRAINT ck_gemini_jobs_01
  CHECK (kind = ANY (ARRAY[
    'listing_enrichment'::text,
    'keyword_enrichment'::text,
    'search_overview'::text,
    'market_analysis'::text,
    'product_target'::text
  ]));
