-- Applied by hand (see docs): sudo -u postgres psql, BEGIN; SET ROLE jpgr_owner; \i this file.
-- 之后单独跑（不能在事务里）：VACUUM (FULL, ANALYZE) radar_analytics.listing_observations;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Listing payload inline clear migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 20261014130000 的第二步：所有读取方（两个价格视图、packages/analytics 的商品变体查询）
-- 都已改读 COALESCE(listing_payloads.payload, listing_observations.listing_payload)，
-- 这里把旧列里重复存的整份内容清成 '{}'。清之前确认每一行的内容都已在 listing_payloads 里。
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM radar_analytics.listing_observations AS observation
    LEFT JOIN radar_analytics.listing_payloads AS payload ON payload.payload_hash = observation.payload_hash
    WHERE observation.listing_payload <> '{}'::jsonb
      AND payload.payload IS DISTINCT FROM observation.listing_payload
  ) THEN
    RAISE EXCEPTION 'some inline listing_payload is not in listing_payloads; refusing to clear';
  END IF;
END
$guard$;

UPDATE radar_analytics.listing_observations
SET listing_payload = '{}'::jsonb
WHERE listing_payload <> '{}'::jsonb;

COMMENT ON COLUMN radar_analytics.listing_observations.listing_payload IS
  '已停用，恒为 {}。商品内容在 radar_analytics.listing_payloads，按 payload_hash 取';
