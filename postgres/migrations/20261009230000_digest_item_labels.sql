-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Digest item labels migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 日报标注：主人在后台「日报标注」页把已发出的关键词日报逐件标「不想再看到 / 还想看」。
--
-- 用法（2026-10-09 和用户定的）：用户有空标一轮，Claude 读 verdict='hide' 且 reviewed_at 为空的标题，
-- 归纳成屏蔽单品（watch_profile_muted_products），用 verdict='keep' 的核对不误伤，再把读过的记上 reviewed_at。
-- 不做自动化：垃圾标题量小，人工归纳更准。
--
-- 一件商品（档案 + 来源 + 来源商品号）只有一个结论，在哪封日报里标的记在 digest_event_id。
-- 标题、链接、图、价格是标注那一刻从日报载荷里抄下来的快照：商品下架后照样能读。
CREATE TABLE IF NOT EXISTS radar_core.digest_item_labels (
    watch_profile_id text NOT NULL REFERENCES radar_core.watch_profiles(id) ON DELETE CASCADE,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('hide', 'keep')),
    title text NOT NULL,
    url text,
    image_url text,
    price bigint,
    digest_event_id text,
    labeled_at text NOT NULL,
    reviewed_at text,
    PRIMARY KEY (watch_profile_id, source_id, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_digest_item_labels_pending
  ON radar_core.digest_item_labels USING btree (watch_profile_id, verdict, reviewed_at);
