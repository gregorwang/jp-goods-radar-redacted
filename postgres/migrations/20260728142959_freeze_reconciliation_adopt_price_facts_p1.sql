-- Ordering exception: this forward-only repair must sort immediately before
-- 20260728143000. It adopts that exact file only when the already-applied
-- 164500 compatibility-wrapper state is proven byte/definition equivalent.
-- Do not add BEGIN/COMMIT: jpgr-apply-analytics-migrations supplies one outer
-- transaction and records this file's own checksum in that same transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;

DO $runner_contract$
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'jpgr_owner' THEN
    RAISE EXCEPTION
      'freeze reconciliation requires existing runner contract: session_user=postgres, current_user=jpgr_owner; got %, %',
      session_user, current_user;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname=session_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'freeze reconciliation requires a superuser session behind SET ROLE jpgr_owner';
  END IF;
END
$runner_contract$;

-- Fail fast instead of racing another migration runner or concurrent DDL.
LOCK TABLE jpgr_meta.schema_migrations
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE radar_core.listing_snapshots,
           radar_analytics.listing_observations,
           radar_analytics.sale_records,
           radar_analytics.source_listings,
           radar_analytics.market_ai_reports
  IN ACCESS SHARE MODE NOWAIT;
DO $lock_current_views$
BEGIN
  IF pg_catalog.to_regclass('radar_analytics.strategy_price_facts_core_v1') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE radar_analytics.strategy_price_facts_core_v1 IN ACCESS SHARE MODE NOWAIT';
  END IF;
  IF pg_catalog.to_regclass('radar_analytics.strategy_price_facts_v1') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE radar_analytics.strategy_price_facts_v1 IN ACCESS SHARE MODE NOWAIT';
  END IF;
END
$lock_current_views$;

-- The existing runner starts as OS/database superuser postgres and then SET ROLEs
-- to jpgr_owner. Temporarily regain the session role only for reading the exact
-- migration bytes and transferring the two mistakenly postgres-owned functions.
RESET ROLE;

DO $adopt_and_normalize$
DECLARE
  v_p1_version constant text :=
    '20260728143000_investment_price_facts_p1';
  v_p1_checksum constant text :=
    'b13587d2a6e737f2effb4f572af6bb58e07047f61a4bb2e5f1023be531387566';
  v_p1_path constant text :=
    '/opt/jpgr-db/migrations/20260728143000_investment_price_facts_p1.sql';
  v_legacy_version constant text :=
    '20260728164500_legacy_surugaya_official_list_facts';
  v_legacy_checksum constant text :=
    'd925d92d9ff4c8a40ae8cff5722b36b606a77ccb1574d660b5cda44b3f794398';
  v_identity_version constant text :=
    '20260728173000_exact_product_identity_v3';
  v_identity_checksum constant text :=
    '7b0b0248f029e22daaac0e7ea0af8cd893fe6d072085c37968b42ca060ac6b02';
  v_recorded text;
  v_legacy_recorded text;
  v_identity_recorded text;
  v_actual text;
  v_owner text;
  v_valid boolean;
BEGIN
  IF current_user <> session_user OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'RESET ROLE did not restore the expected postgres session role';
  END IF;

  -- SQL-level byte verification is possible on PostgreSQL 17 without pgcrypto:
  -- pg_catalog.sha256(bytea) is built in. This fails closed if the file is absent
  -- or any byte/line-ending differs from the reviewed repository artifact.
  v_actual := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.pg_read_binary_file(v_p1_path)),
    'hex'
  );
  IF v_actual IS DISTINCT FROM v_p1_checksum THEN
    RAISE EXCEPTION '143000 file checksum mismatch: expected %, got %',
      v_p1_checksum, v_actual;
  END IF;

  SELECT checksum_sha256 INTO v_recorded
  FROM jpgr_meta.schema_migrations
  WHERE version=v_p1_version;
  IF v_recorded IS NOT NULL AND v_recorded <> v_p1_checksum THEN
    RAISE EXCEPTION '143000 ledger checksum mismatch: expected %, got %',
      v_p1_checksum, v_recorded;
  END IF;

  SELECT checksum_sha256 INTO v_legacy_recorded
  FROM jpgr_meta.schema_migrations
  WHERE version=v_legacy_version;
  IF v_legacy_recorded IS NOT NULL
     AND v_legacy_recorded <> v_legacy_checksum THEN
    RAISE EXCEPTION '164500 ledger checksum mismatch: expected %, got %',
      v_legacy_checksum, v_legacy_recorded;
  END IF;

  SELECT checksum_sha256 INTO v_identity_recorded
  FROM jpgr_meta.schema_migrations
  WHERE version=v_identity_version;
  IF v_identity_recorded IS NOT NULL
     AND v_identity_recorded <> v_identity_checksum THEN
    RAISE EXCEPTION '173000 ledger checksum mismatch: expected %, got %',
      v_identity_checksum, v_identity_recorded;
  END IF;

  -- Clean/pre-143000 path: do not adopt. The runner records this repair, then
  -- applies 143000, 164500 and 173000 normally in filename order. Reject every
  -- partial footprint rather than guessing that 143000 ran.
  IF v_recorded IS NULL AND v_legacy_recorded IS NULL THEN
    IF pg_catalog.to_regclass('radar_analytics.strategy_price_facts_core_v1') IS NULL
       AND pg_catalog.to_regclass('radar_analytics.strategy_price_facts_v1') IS NULL
       AND pg_catalog.to_regclass('radar_analytics.sale_records_verified_yahoo_sale_unique_idx') IS NULL
       AND pg_catalog.to_regprocedure('radar_analytics.safe_positive_jpy(text)') IS NULL
       AND pg_catalog.to_regprocedure('radar_analytics.capture_verified_sale_evidence()') IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger
         WHERE tgrelid='radar_analytics.source_listings'::pg_catalog.regclass
           AND tgname='source_listings_capture_verified_sale'
           AND NOT tgisinternal
       )
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute
         WHERE attrelid='radar_core.listing_snapshots'::pg_catalog.regclass
           AND attname='price_basis' AND attnum>0 AND NOT attisdropped
       )
       AND NOT EXISTS (
         SELECT 1
         FROM jpgr_meta.schema_migrations
         WHERE version=v_identity_version
       )
    THEN
      RETURN;
    END IF;
    RAISE EXCEPTION
      '143000 is unrecorded but a partial/newer footprint exists; refusing adoption';
  END IF;

  -- Production/adopted path must already be the exact 164500 compatibility
  -- state. This is what proves adoption will not replace the legacy wrapper.
  IF v_legacy_recorded IS DISTINCT FROM v_legacy_checksum THEN
    RAISE EXCEPTION
      '143000 adoption requires exact applied 164500 wrapper checksum; got %',
      v_legacy_recorded;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid='radar_core.listing_snapshots'::pg_catalog.regclass
      AND attname='price_basis' AND attnum>0 AND NOT attisdropped
      AND atttypid='pg_catalog.text'::pg_catalog.regtype
      AND NOT attnotnull AND NOT atthasdef
  ) THEN
    RAISE EXCEPTION 'listing_snapshots.price_basis is absent or has unexpected type/null/default semantics';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_constraintdef(con.oid,false),'UTF8')),'hex'),
         con.convalidated
    INTO v_actual,v_valid
  FROM pg_catalog.pg_constraint con
  WHERE con.conrelid='radar_core.listing_snapshots'::pg_catalog.regclass
    AND con.conname='ck_listing_snapshots_price_basis';
  IF NOT FOUND OR NOT v_valid OR v_actual IS DISTINCT FROM
     'a106b191df3965424b10d37aa13347b5dbf608342c31352c7246dd2d66fc2622' THEN
    RAISE EXCEPTION 'ck_listing_snapshots_price_basis is absent, unvalidated, or definition-drifted';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_constraintdef(con.oid,false),'UTF8')),'hex'),
         con.convalidated
    INTO v_actual,v_valid
  FROM pg_catalog.pg_constraint con
  WHERE con.conrelid='radar_analytics.listing_observations'::pg_catalog.regclass
    AND con.conname='listing_observations_price_basis_check';
  IF NOT FOUND OR NOT v_valid OR v_actual IS DISTINCT FROM
     '1ad3065665a787e0c8f0204a0557d961cc37ed507a40a78d6eb297c2a55817ac' THEN
    RAISE EXCEPTION 'listing_observations_price_basis_check is absent, unvalidated, or definition-drifted';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             pg_catalog.pg_get_indexdef(i.indexrelid),'UTF8')),'hex'),
         i.indisvalid AND i.indisready AND i.indisunique
    INTO v_actual,v_valid
  FROM pg_catalog.pg_index i
  WHERE i.indexrelid=
    pg_catalog.to_regclass('radar_analytics.sale_records_verified_yahoo_sale_unique_idx');
  IF NOT FOUND OR NOT v_valid OR v_actual IS DISTINCT FROM
     '26a29a642e2d76777e0c5f98d64bae262624bdb71375063d4b2a09244f29d501' THEN
    RAISE EXCEPTION 'verified Yahoo sale unique index is absent, invalid, or definition-drifted';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(p.proowner),
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')
    INTO v_owner,v_actual
  FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('radar_analytics.safe_positive_jpy(text)');
  IF NOT FOUND OR v_owner NOT IN ('postgres','jpgr_owner') OR
     v_actual IS DISTINCT FROM
     'c1888f7f464458f4325d4f82db533b09ca6c7e00848a13b08aeec5b8c04dc09e' THEN
    RAISE EXCEPTION 'safe_positive_jpy is absent, unexpectedly owned, or definition-drifted';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(p.proowner),
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')
    INTO v_owner,v_actual
  FROM pg_catalog.pg_proc p
  WHERE p.oid=pg_catalog.to_regprocedure('radar_analytics.capture_verified_sale_evidence()');
  IF NOT FOUND OR v_owner NOT IN ('postgres','jpgr_owner') OR
     v_actual IS DISTINCT FROM
     'd968833692d3ba2978b7d0328ce946ad39b7f42b00703b6770ecbe5fa3082fab' THEN
    RAISE EXCEPTION 'capture_verified_sale_evidence is absent, unexpectedly owned, or definition-drifted';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_triggerdef(t.oid,false),'UTF8')),'hex'),
         t.tgenabled='O'
    INTO v_actual,v_valid
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid='radar_analytics.source_listings'::pg_catalog.regclass
    AND t.tgname='source_listings_capture_verified_sale'
    AND NOT t.tgisinternal;
  IF NOT FOUND OR NOT v_valid OR v_actual IS DISTINCT FROM
     'ba48ca09363d0340cd1befa294598df6598c3ac0f50aed2167d3aa3e96eeacbb' THEN
    RAISE EXCEPTION 'verified-sale trigger is absent, disabled, or definition-drifted';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner),
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_viewdef(c.oid,false),'UTF8')),'hex')
    INTO v_owner,v_actual
  FROM pg_catalog.pg_class c
  WHERE c.oid=pg_catalog.to_regclass('radar_analytics.strategy_price_facts_core_v1')
    AND c.relkind='v'
    AND 'security_invoker=true'=ANY(COALESCE(c.reloptions,ARRAY[]::text[]));
  IF NOT FOUND OR v_owner <> 'jpgr_owner' OR v_actual IS DISTINCT FROM
     '56f2983f87b524e23fefe51f3e4fd6f7739de91b07dc9ee726093d5e555ecfc5' THEN
    RAISE EXCEPTION 'strategy_price_facts_core_v1 is absent or definition/owner/security_invoker drifted';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner),
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.pg_get_viewdef(c.oid,false),'UTF8')),'hex')
    INTO v_owner,v_actual
  FROM pg_catalog.pg_class c
  WHERE c.oid=pg_catalog.to_regclass('radar_analytics.strategy_price_facts_v1')
    AND c.relkind='v'
    AND 'security_invoker=true'=ANY(COALESCE(c.reloptions,ARRAY[]::text[]));
  IF NOT FOUND OR v_owner <> 'jpgr_owner' OR v_actual IS DISTINCT FROM
     'dc10cc3cb3b8c2f5f6e7f24973c7f44dfece1723fd49d0e2d574633d5f12bdd9' THEN
    RAISE EXCEPTION 'legacy strategy_price_facts_v1 wrapper is absent or definition/owner/security_invoker drifted';
  END IF;

  IF pg_catalog.obj_description(
       'radar_analytics.strategy_price_facts_core_v1'::pg_catalog.regclass,
       'pg_class') IS DISTINCT FROM
       'Internal P1 core facts retained behind the public compatibility wrapper.'
     OR pg_catalog.obj_description(
       'radar_analytics.strategy_price_facts_v1'::pg_catalog.regclass,
       'pg_class') IS DISTINCT FROM
       'P1 point-in-time price-fact contract, including explicit historical Surugaya list-price evidence.'
  THEN
    RAISE EXCEPTION 'price-fact view comments do not match the adopted 164500 contract';
  END IF;

  -- Adopt only after every byte/schema/wrapper assertion passed. Never update a
  -- mismatching ledger row.
  INSERT INTO jpgr_meta.schema_migrations(version,checksum_sha256)
  VALUES (v_p1_version,v_p1_checksum)
  ON CONFLICT (version) DO NOTHING;

  SELECT checksum_sha256 INTO v_recorded
  FROM jpgr_meta.schema_migrations
  WHERE version=v_p1_version;
  IF v_recorded IS DISTINCT FROM v_p1_checksum THEN
    RAISE EXCEPTION '143000 checksum adoption failed';
  END IF;

  -- Current live owner is postgres for both; no CREATE OR REPLACE is used, so
  -- bodies, trigger and both views remain byte-for-byte untouched.
  EXECUTE 'ALTER FUNCTION radar_analytics.safe_positive_jpy(text) OWNER TO jpgr_owner';
  EXECUTE 'ALTER FUNCTION radar_analytics.capture_verified_sale_evidence() OWNER TO jpgr_owner';
END
$adopt_and_normalize$;

SET ROLE jpgr_owner;

-- Reassert the intended function ACL after ownership transfer. The trigger
-- function is callable only through its trigger; safe_positive_jpy remains
-- executable by the analytics runtime because the security-invoker views use it.
DO $function_acl$
BEGIN
  IF pg_catalog.to_regprocedure('radar_analytics.safe_positive_jpy(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION radar_analytics.safe_positive_jpy(text) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION radar_analytics.safe_positive_jpy(text) TO radar_analytics_runtime';
  END IF;
  IF pg_catalog.to_regprocedure('radar_analytics.capture_verified_sale_evidence()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence() FROM radar_analytics_runtime';
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='jpgr_app') THEN
      EXECUTE 'REVOKE ALL ON FUNCTION radar_analytics.capture_verified_sale_evidence() FROM jpgr_app';
    END IF;
  END IF;
END
$function_acl$;

-- Remove table-level and any possible direct column-level privilege. Owner
-- jpgr_owner keeps history readable for compatibility; no row is changed.
REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports
  FROM radar_analytics_runtime;
DO $market_report_acl$
DECLARE
  v_columns text;
  v_privilege text;
  v_role text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(attname),', ' ORDER BY attnum)
    INTO v_columns
  FROM pg_catalog.pg_attribute
  WHERE attrelid='radar_analytics.market_ai_reports'::pg_catalog.regclass
    AND attnum>0 AND NOT attisdropped;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE radar_analytics.market_ai_reports FROM PUBLIC',
      v_privilege,v_columns);
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['radar_analytics_runtime','jpgr_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE radar_analytics.market_ai_reports FROM %I',
        v_role);
      FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
        EXECUTE pg_catalog.format(
          'REVOKE %s (%s) ON TABLE radar_analytics.market_ai_reports FROM %I',
          v_privilege,v_columns,v_role);
      END LOOP;
    END IF;
  END LOOP;
END
$market_report_acl$;

COMMENT ON TABLE radar_analytics.market_ai_reports IS
  'Historical compatibility state only. Application runtime roles have no access; ad hoc analysis belongs in Databricks.';

DO $postconditions$
DECLARE
  v_role text;
  v_privilege text;
  v_recorded text;
BEGIN
  -- On the production adoption path, exact ledger adoption is mandatory. On a
  -- genuinely clean pre-143000 path it intentionally remains absent until the
  -- runner reaches 143000 next.
  IF EXISTS (
    SELECT 1 FROM jpgr_meta.schema_migrations
    WHERE version='20260728164500_legacy_surugaya_official_list_facts'
  ) THEN
    SELECT checksum_sha256 INTO v_recorded
    FROM jpgr_meta.schema_migrations
    WHERE version='20260728143000_investment_price_facts_p1';
    IF v_recorded IS DISTINCT FROM
       'b13587d2a6e737f2effb4f572af6bb58e07047f61a4bb2e5f1023be531387566' THEN
      RAISE EXCEPTION 'postcondition failed: 143000 exact checksum not adopted';
    END IF;
  END IF;

  IF pg_catalog.to_regprocedure('radar_analytics.safe_positive_jpy(text)') IS NOT NULL
     AND (SELECT pg_catalog.pg_get_userbyid(proowner)
          FROM pg_catalog.pg_proc
          WHERE oid=pg_catalog.to_regprocedure(
            'radar_analytics.safe_positive_jpy(text)')) <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'postcondition failed: safe_positive_jpy owner';
  END IF;
  IF pg_catalog.to_regprocedure('radar_analytics.capture_verified_sale_evidence()') IS NOT NULL
     AND (SELECT pg_catalog.pg_get_userbyid(proowner)
          FROM pg_catalog.pg_proc
          WHERE oid=pg_catalog.to_regprocedure(
            'radar_analytics.capture_verified_sale_evidence()')) <> 'jpgr_owner' THEN
    RAISE EXCEPTION 'postcondition failed: capture_verified_sale_evidence owner';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['radar_analytics_runtime','jpgr_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
      FOREACH v_privilege IN ARRAY
        ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
      LOOP
        IF pg_catalog.has_table_privilege(
             v_role::name,
             'radar_analytics.market_ai_reports'::pg_catalog.regclass,
             v_privilege) THEN
          RAISE EXCEPTION 'postcondition failed: role % retains table privilege % on market_ai_reports',
            v_role,v_privilege;
        END IF;
      END LOOP;
      FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(
             v_role::name,
             'radar_analytics.market_ai_reports'::pg_catalog.regclass,
             v_privilege) THEN
          RAISE EXCEPTION 'postcondition failed: role % retains column privilege % on market_ai_reports',
            v_role,v_privilege;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
    WHERE c.oid='radar_analytics.market_ai_reports'::pg_catalog.regclass
      AND acl.grantee=0
  ) THEN
    RAISE EXCEPTION 'postcondition failed: PUBLIC retains market_ai_reports privilege';
  END IF;
END
$postconditions$;
