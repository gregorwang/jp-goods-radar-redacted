-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing interest observations migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 商品热度（2026-10-16 用户定）：用户从收件箱亲手挑出来「盯住」的单品，每次单品巡回打开详情页时
-- 把点赞数（煤炉 いいね / PayPayフリマ 收藏 / 雅虎拍卖 ウォッチ）和评论数记下来，涨了就发「有人盯上了」。
--
-- 起因：10-16 一件加藤惠公仔上午有人点了一个赞，下午就卖掉了；用户自己的交易经验是
-- 「有赞有评论的几乎都会卖出去」。这两个数只在详情页里有，关键词搜索结果不带，
-- 而 listings.raw_metadata_json 每次被搜索结果覆盖，存不住上一次的值，所以单独一张表。
--
-- 只在数值和上一行不同时才写（第一次看到也写一行当基线），所以一件商品一般只有几行。
-- 以后要验证「点赞涨了的商品几天内卖掉」时，拿这张表和 listing_snapshots 的售罄时间对。
--   like_count / comment_count  NULL = 这次来源没给这个数（不是 0）
CREATE TABLE IF NOT EXISTS radar_core.listing_interest_observations (
    listing_id text NOT NULL REFERENCES radar_core.listings(id) ON DELETE CASCADE,
    observed_at text NOT NULL,
    like_count integer,
    comment_count integer,
    PRIMARY KEY (listing_id, observed_at)
);
