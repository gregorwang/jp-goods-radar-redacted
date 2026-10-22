-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing detail hydration timestamp migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 详情补抓的去重水位。
--
-- 精确同款巡检每轮会对得分最高的 4 条候选补抓商品详情页（apps/collector/src/index.ts
-- 的 executeExactProductSearch）。原来那道"补抓过就跳过"的守卫读的是
-- listing.rawMetadata.detailHydrated，而这个字段全仓库只有 surugaya-direct 会写，
-- 其余来源的搜索结果里根本没有它——守卫永远不成立，于是同一件商品每天被重复补抓
-- 4 轮 × 8 来源，详情页比搜索页更像爬虫行为，既烧配额也拉低 IP reputation。
--
-- 补抓结果本来就会经 persistListing 落库，但 raw_metadata_json 在每次 upsert 时被
-- 整体覆盖，下一轮纯搜索的写入会把 detailHydrated 抹掉。所以水位必须是独立列：
-- 只有真正来自详情抓取的写入才推进它，纯搜索写入用 COALESCE 保留原值。
ALTER TABLE radar_core.listings
  ADD COLUMN IF NOT EXISTS detail_hydrated_at text;
