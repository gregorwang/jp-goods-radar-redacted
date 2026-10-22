-- Applied by jpgr-apply-analytics-migrations in its outer transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'Exact-product price drop migration requires the migration runner';
  END IF;
END
$runner_contract$;

-- 精确同款档案：已发现的每件同款降价时提醒。
--
-- 同款档案默认 all_confirmed_offers，每件确认同款早就在被独立检查价格，但降价提醒
-- 被写死关掉了两层：绑定上的 notify_price_drop 恒为 0，规则的 event_types 也不允许
-- listing.price_changed。于是价格一直在盯，降了却从不发信，只有跨过目标价才提醒。
-- 用户的真实用法是"邮件里看过这件同款，没买，等它降价"，结果只能给每条链接再手工
-- 建一份单品监控。档案一多，这条路就走不通了。
--
-- 存量同款档案打开（用户明确要求，不按新建/存量区分）。嫌吵可以在规则里取消勾选。
--
-- 例外：设了目标价的档案不动。那种档案是在蹲一个好价（例如市场天天有人出，
-- 但只想等 ¥3,700 以下），降 100 日元就发信正是用户不想要的；它们继续只在
-- 降到目标价时提醒。判断以当前规则的 target_listing_price 为准。

UPDATE radar_core.watch_bindings b
SET notify_price_drop = 1,
    updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM radar_core.watch_profiles p
WHERE p.id = b.watch_profile_id
  AND p.dossier_kind = 'exact_product'
  AND b.kind = 'keyword'
  AND b.notify_price_drop = 0
  AND NOT EXISTS (
    SELECT 1 FROM radar_core.monitor_rules r
    WHERE r.watch_profile_id = p.id AND r.valid_to IS NULL AND r.target_listing_price IS NOT NULL
  );

-- 规则是版本化的：不改写旧版本，而是关闭当前版本、追加一个带 listing.price_changed
-- 的新版本，这样历史提醒仍能按当时的规则复查。当前版本唯一索引不允许两条同时
-- valid_to IS NULL，所以逐条先关再插。
DO $exact_price_drop_rules$
DECLARE
  rule radar_core.monitor_rules%ROWTYPE;
  ts text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  FOR rule IN
    SELECT r.*
    FROM radar_core.monitor_rules r
    JOIN radar_core.watch_profiles p ON p.id = r.watch_profile_id
    WHERE p.dossier_kind = 'exact_product'
      AND r.valid_to IS NULL
      AND r.target_listing_price IS NULL
      AND NOT (r.event_types_json::jsonb ? 'listing.price_changed')
  LOOP
    UPDATE radar_core.monitor_rules SET valid_to = ts WHERE id = rule.id;
    INSERT INTO radar_core.monitor_rules(
      id, rule_key, version, watch_profile_id, scope_type, scope_id, scope_identity_status,
      event_types_json, source_allow_json, source_deny_json, conditions_json, completeness_json,
      target_listing_price, target_landed_cost, delivery_mode, quiet_hours_start, quiet_hours_end,
      timezone, dedupe_window_minutes, cooldown_minutes, stale_source_policy, enabled,
      supersedes_rule_id, valid_from, valid_to, created_at, created_by
    ) VALUES (
      gen_random_uuid()::text, rule.rule_key, rule.version + 1, rule.watch_profile_id,
      rule.scope_type, rule.scope_id, rule.scope_identity_status,
      (rule.event_types_json::jsonb || '["listing.price_changed"]'::jsonb)::text,
      rule.source_allow_json, rule.source_deny_json, rule.conditions_json, rule.completeness_json,
      rule.target_listing_price, rule.target_landed_cost, rule.delivery_mode,
      rule.quiet_hours_start, rule.quiet_hours_end, rule.timezone, rule.dedupe_window_minutes,
      rule.cooldown_minutes, rule.stale_source_policy, rule.enabled,
      rule.id, ts, NULL, ts, 'migration'
    );
  END LOOP;
END
$exact_price_drop_rules$;
