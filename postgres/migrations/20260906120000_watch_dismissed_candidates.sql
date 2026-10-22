-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Watch dismissed candidates migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 用户对"疑似同款"候选的判定回写。
--
-- AGENTS.md §4 要求证据不足只降档、不丢弃，于是精确同款雷达的摘要里多了一个
-- 「疑似同款」分区，把未确认但共享身份的候选照发。代价是这个分区没有收敛出口：
-- 判定为 probable_exact 的候选每一轮都会重新出现，用户看过一遍也没用——为了把
-- 被埋六天的存量捞出来，prepareKeywordDigest 里特意让 probable_exact 不受
-- "只在首次观察时露出"的限制。收敛只能靠用户的判断，不能靠时间。
--
-- 这张表就是那个出口，两种理由的语义不同：
--   not_same_product 系统判错了。这条商品的所有通知永久静音，同时是匹配器的标注样本。
--   too_expensive    是同款但价格不要。不再作为"新发现"打扰，但降价 / 到达目标价照常提醒
--                    ——用户排除它的原因正是价格，那价格变化恰恰是唯一值得重新叫他的事。
--
-- 按 (binding, source, source_item_id) 定位而不是 listing_id：疑似候选还没有成为匹配，
-- 库里没有 watch_listing_matches 行，现有的「已忽略」按钮点都没得点。
CREATE TABLE IF NOT EXISTS radar_core.watch_dismissed_candidates (
    watch_binding_id text NOT NULL,
    source_id text NOT NULL,
    source_item_id text NOT NULL,
    reason text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT pk_watch_dismissed_candidates PRIMARY KEY (watch_binding_id, source_id, source_item_id),
    CONSTRAINT ck_watch_dismissed_candidates_01
      CHECK (reason = ANY (ARRAY['not_same_product'::text, 'too_expensive'::text]))
);

ALTER TABLE radar_core.watch_dismissed_candidates
  DROP CONSTRAINT IF EXISTS watch_dismissed_candidates_watch_binding_id_fkey;
ALTER TABLE radar_core.watch_dismissed_candidates
  ADD CONSTRAINT watch_dismissed_candidates_watch_binding_id_fkey
  FOREIGN KEY (watch_binding_id) REFERENCES radar_core.watch_bindings(id) ON DELETE CASCADE;

-- 通知侧每封信都要按 (source_id, source_item_id) 反查，绕开主键前缀。
CREATE INDEX IF NOT EXISTS idx_watch_dismissed_candidates_item
  ON radar_core.watch_dismissed_candidates USING btree (source_id, source_item_id);
