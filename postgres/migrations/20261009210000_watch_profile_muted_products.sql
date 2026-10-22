-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Watch profile muted products migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 关键词档案的「屏蔽单品」（packages/core/src/muted-products.ts）。
--
-- 景品、一番赏这类出货量巨大的商品每天都有新卖家挂出来，日报按链接去重拦不住。
-- 一行 = 一件不想再看到的商品：term_groups_json 是若干词组（JSON 字符串数组），
-- 标题里每组都命中才算这件商品，组内 `|` 分隔别名。
-- 采集侧在 AI 之前就挡掉（观察记录写 rejected + 理由），日报组装时再按标题过滤一遍，
-- 让今天新屏蔽的商品当天的日报里就消失。
--
-- sample_* 记的是用户从哪件商品点进来屏蔽的，只用于后台展示"屏蔽的是这个"。
CREATE TABLE IF NOT EXISTS radar_core.watch_profile_muted_products (
    id text PRIMARY KEY,
    watch_profile_id text NOT NULL REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE,
    term_groups_json text NOT NULL CHECK (length(term_groups_json) BETWEEN 2 AND 2000),
    sample_title text,
    sample_url text,
    sample_image_url text,
    created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_profile_muted_products_profile
  ON radar_core.watch_profile_muted_products USING btree (watch_profile_id, created_at);

-- 关键词档案的最低价：低于它的商品不进日报（NULL = 不限）。
-- 这是送达门槛，不是搜索条件：不传给来源、不改搜索范围，所以改它不会重置基线、不会再发一封建档回执。
-- 拍卖按当前出价比（1 円起拍的也会被挡掉，用户 10-09 认可）；价格缺失的不挡。
ALTER TABLE radar_core.watch_profiles
  ADD COLUMN IF NOT EXISTS min_listing_price bigint
  CHECK (min_listing_price IS NULL OR min_listing_price >= 0);
