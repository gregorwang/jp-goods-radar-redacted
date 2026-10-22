-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing same groups migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 按图片判出来的同款分组（docs/研究/图片去重-实测-20261008.md）。一行 = 一封日报里的一件商品属于哪一组。
-- 清单页有这封日报的分组就按它合并，没有就退回同名折叠。分组是事后算的，所以不写进 events.payload_json。
--   group_key  同一封日报里值相同的合成一张卡；没合进任何组的商品也写一行，各自一个值（不再按标题合并）
--   method     哪一版流程算的，比如 image_v3
CREATE TABLE IF NOT EXISTS radar_core.listing_same_groups (
    event_id text NOT NULL REFERENCES radar_core.events(id) ON DELETE CASCADE,
    item_url text NOT NULL,
    group_key text NOT NULL,
    method text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, item_url)
);

