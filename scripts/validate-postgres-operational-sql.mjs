import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const roots = [
  resolve("apps/collector/src"),
  resolve("apps/web/src"),
  resolve("packages/db/src"),
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

const transpiled = ts.transpileModule(
  readFileSync(resolve("packages/db/src/postgres-parameters.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  },
).outputText;
const postgresModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
const { numberPostgresParameters } = postgresModule;
if (typeof numberPostgresParameters !== "function") {
  throw new Error("PostgreSQL parameter formatter was not loaded");
}

function staticSql(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return staticSql(node.expression);
  return null;
}

const queries = [];
const unresolved = [];
for (const path of roots.flatMap(files)) {
  const sourceText = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "prepare"
      && node.arguments.length > 0
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const sql = staticSql(node.arguments[0]);
      const location = {
        file: path.slice(resolve(".").length + 1).replaceAll("\\", "/"),
        line: position.line + 1,
      };
      if (sql === null) unresolved.push(location);
      else queries.push({ ...location, sql: numberPostgresParameters(sql).replace(/;\s*$/u, "") });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const representativeDynamicQueries = [
  {
    file: "apps/collector/src/gemini-jobs.ts",
    line: 546,
    sql: "SELECT claim_key,job_id FROM market_listing_cleaning_claims WHERE claim_key IN (?,?)",
  },
  {
    file: "apps/collector/src/gemini-jobs.ts",
    line: 2240,
    sql: `SELECT COUNT(*) count FROM gemini_jobs
      WHERE kind='keyword_enrichment' AND binding_id IN (?,?) AND scan_started_at>=?
        AND status NOT IN ('completed','partial','failed')`,
  },
  {
    file: "apps/web/src/app/api/events/route.ts",
    line: 108,
    sql: `SELECT me.id,me.event_type,me.notification_eligibility status,
      me.detected_at created_at,legacy.sent_at,me.payload_json,
      l.id listing_id,l.title,l.canonical_url,l.image_url,l.source_item_id,l.seller_name,l.shop_name,
      l.source_id,COALESCE(s.display_name,l.source_id) source_display_name,
      l.current_price,l.original_price,l.item_condition,l.availability,
      me.watch_profile_id item_watch_profile_id,me.watch_profile_id,
      me.monitor_rule_id,me.rule_version,me.evidence_hash,me.occurred_at,me.detected_at,
      me.notification_eligibility,me.suppression_reason,me.subject_type,me.subject_id,
      (SELECT d.attempts FROM email_deliveries d WHERE d.event_id=legacy.id ORDER BY d.created_at DESC LIMIT 1) attempts,
      (SELECT d.last_error FROM email_deliveries d WHERE d.event_id=legacy.id ORDER BY d.created_at DESC LIMIT 1) last_error
      FROM monitor_events me
      LEFT JOIN listings l ON l.id=me.listing_id
      LEFT JOIN source_registry s ON s.id=l.source_id
      LEFT JOIN events legacy ON legacy.id=me.legacy_event_id
      WHERE me.event_type=? AND l.source_id=?
        AND (me.detected_at < ? OR (me.detected_at = ? AND me.id < ?))
      ORDER BY me.detected_at DESC,me.id DESC LIMIT ?`,
  },
  {
    file: "apps/web/src/app/api/events/route.ts",
    line: 122,
    sql: `SELECT COUNT(*) count FROM monitor_events me
      LEFT JOIN listings l ON l.id=me.listing_id
      LEFT JOIN source_registry s ON s.id=l.source_id
      LEFT JOIN events legacy ON legacy.id=me.legacy_event_id
      WHERE me.event_type=? AND l.source_id=?`,
  },
  {
    file: "apps/web/src/app/api/events/route.ts",
    line: 221,
    sql: `SELECT e.id,COALESCE(e.semantic_event_type,e.event_type) event_type,
      e.status,e.created_at,e.sent_at,e.payload_json,
      l.id listing_id,l.title,l.canonical_url,l.image_url,l.source_item_id,l.seller_name,l.shop_name,
      COALESCE(l.source_id,b.source_id) source_id,
      COALESCE(s.display_name,l.source_id,b.source_id) source_display_name,
      l.current_price,l.original_price,l.item_condition,l.availability,e.watch_profile_id,
      (SELECT item_binding.watch_profile_id FROM watch_bindings item_binding
       JOIN watch_profiles item_profile ON item_profile.id=item_binding.watch_profile_id
       WHERE item_binding.kind='item' AND item_binding.source_id=l.source_id
         AND item_binding.source_item_id=l.source_item_id
       ORDER BY item_profile.enabled DESC,item_binding.enabled DESC,item_binding.updated_at DESC LIMIT 1) item_watch_profile_id,
      (SELECT d.attempts FROM email_deliveries d WHERE d.event_id=e.id ORDER BY d.created_at DESC LIMIT 1) attempts,
      (SELECT d.last_error FROM email_deliveries d WHERE d.event_id=e.id ORDER BY d.created_at DESC LIMIT 1) last_error
      FROM events e
      LEFT JOIN listings l ON l.id=e.listing_id
      LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
      LEFT JOIN source_registry s ON s.id=COALESCE(l.source_id,b.source_id)
      WHERE COALESCE(e.semantic_event_type,e.event_type)=? AND COALESCE(l.source_id,b.source_id)=?
        AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))
      ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
  },
  {
    file: "apps/web/src/app/api/events/route.ts",
    line: 241,
    sql: `SELECT COUNT(*) count FROM events e
      LEFT JOIN listings l ON l.id=e.listing_id
      LEFT JOIN watch_bindings b ON b.id=e.watch_binding_id
      LEFT JOIN source_registry s ON s.id=COALESCE(l.source_id,b.source_id)
      WHERE COALESCE(e.semantic_event_type,e.event_type)=? AND COALESCE(l.source_id,b.source_id)=?`,
  },
  {
    file: "apps/web/src/app/api/listings/route.ts",
    line: 12,
    sql: `SELECT l.id,l.title,l.source_id,l.source_item_id,l.canonical_url,l.image_url,l.current_price,l.original_price,
      l.availability,l.item_condition,l.brand,l.manufacturer,l.jan,l.isbn,l.model_number,l.release_date,l.preorder_deadline,
      l.first_seen_at,l.last_seen_at,l.last_changed_at,b.id watch_binding_id,b.watch_profile_id,
      CASE WHEN b.enabled=1 AND p.enabled=1 THEN 1 ELSE 0 END watch_enabled,
      b.monitoring_purpose,b.schedule_interval_minutes,b.next_run_at
      FROM listings l
      JOIN watch_bindings b ON b.kind='item' AND b.monitoring_purpose='item_price'
        AND b.source_id=l.source_id AND b.source_item_id=l.source_item_id
      JOIN watch_profiles p ON p.id=b.watch_profile_id
      WHERE l.source_id=? AND (l.title LIKE ? ESCAPE '\\' OR l.source_item_id LIKE ? ESCAPE '\\')
      ORDER BY l.last_changed_at DESC LIMIT 200`,
  },
  {
    file: "apps/web/src/app/api/watch-bindings/[id]/route.ts",
    line: 113,
    sql: `UPDATE watch_bindings SET monitoring_purpose=?,query=?,search_url=?,target_url=?,
      interval_minutes=?,schedule_interval_minutes=?,next_run_at=?,source_config_json=?,target_price=?,
      min_drop_amount=?,notify_new_listing=?,notify_price_drop=?,notify_restock=?,notify_sold_out=?,
      enabled=?,cooldown_until=?,updated_at=? WHERE id=?`,
  },
  {
    file: "apps/web/src/app/api/watch-profiles/[id]/route.ts",
    line: 56,
    sql: `UPDATE watch_profiles SET name=?,description=?,default_max_price=?,include_terms_json=?,
      exclude_terms_json=?,enabled=?,updated_at=? WHERE id=?`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 235,
    sql: "UPDATE watch_bindings SET baseline_completed=0,next_run_at=?,updated_at=? WHERE id=? AND kind='keyword'",
  },
  {
    file: "packages/db/src/repository.ts",
    line: 235,
    sql: "UPDATE watch_bindings SET baseline_completed=0,next_run_at=?,updated_at=? WHERE watch_profile_id=? AND kind='keyword'",
  },
  {
    file: "packages/db/src/repository.ts",
    line: 239,
    sql: `UPDATE events SET status='suppressed' WHERE status IN ('pending','failed')
      AND ((watch_binding_id=? AND event_type='new_listing') OR (watch_profile_id=? AND event_type='daily_digest'))`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 239,
    sql: `UPDATE events SET status='suppressed' WHERE status IN ('pending','failed')
      AND (watch_profile_id=? AND (event_type='daily_digest' OR (
        event_type='new_listing' AND EXISTS (
          SELECT 1 FROM watch_bindings b WHERE b.id=events.watch_binding_id AND b.kind='keyword'
        ))))`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 863,
    sql: `SELECT b.id binding_id,b.source_id,
      (SELECT r.status FROM watch_runs r WHERE r.watch_binding_id=b.id AND r.started_at>=?
       ORDER BY r.started_at DESC LIMIT 1) run_status
      FROM watch_bindings b WHERE b.id IN (?,?)`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 897,
    sql: `SELECT l.id,l.source_id,l.source_item_id,l.current_price,l.availability,l.state_hash,l.content_hash,
      (SELECT 1 FROM watch_listing_matches m WHERE m.watch_binding_id=? AND m.listing_id=l.id) matched
      FROM listings l WHERE (l.source_id=? AND l.source_item_id=?) OR (l.source_id=? AND l.source_item_id=?)`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 1082,
    sql: "SELECT id,event_key FROM events WHERE event_key IN (?,?)",
  },
  {
    file: "packages/db/src/repository.ts",
    line: 1114,
    sql: `SELECT l.id,l.first_seen_at,l.last_changed_at,l.current_price,l.currency,l.item_condition,l.availability,
      l.price_basis,l.product_facts_json,s.health_status source_health_status
      FROM listings l LEFT JOIN source_registry s ON s.id=l.source_id WHERE l.id IN (?,?)`,
  },
  ...["queued_jobs", "search_calls", "detail_calls", "emails_sent", "emails_failed"].map((column) => ({
    file: "packages/db/src/repository.ts",
    line: 1790,
    sql: `INSERT INTO daily_counters (day_utc, ${column}, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(day_utc) DO UPDATE SET ${column} = daily_counters.${column} + excluded.${column},
      updated_at = excluded.updated_at`,
  })),
  {
    file: "packages/db/src/repository.ts",
    line: 2047,
    sql: `SELECT e.id event_id,e.watch_binding_id,e.listing_id,l.source_id,l.title,l.canonical_url,
      l.current_price,l.image_url,b.query
      FROM events e JOIN watch_bindings b ON b.id=e.watch_binding_id
      JOIN listings l ON l.id=e.listing_id
      WHERE e.watch_profile_id=? AND e.watch_binding_id IN (?,?)
        AND e.event_type='new_listing' AND e.status IN ('pending','failed')
        AND e.created_at>=? AND e.created_at<=?
        AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.event_id=e.id AND d.status='sent')
      ORDER BY l.source_id,e.created_at,l.title LIMIT 2000`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 2102,
    sql: "UPDATE events SET status='suppressed' WHERE id IN (?,?) AND status IN ('pending','failed')",
  },
  {
    file: "packages/db/src/repository.ts",
    line: 2106,
    sql: `UPDATE watch_listing_matches SET new_listing_notified_at=?
      WHERE EXISTS (SELECT 1 FROM events e WHERE e.id IN (?,?)
        AND e.watch_binding_id=watch_listing_matches.watch_binding_id
        AND e.listing_id=watch_listing_matches.listing_id)`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 2149,
    sql: "UPDATE events SET email_suppressed_at=? WHERE id IN (?,?) AND email_suppressed_at IS NULL",
  },
  // The two suspect queries only differ in their gate, and both are dynamic
  // (the binding list is interpolated). They read columns added on 2026-09-06,
  // so leaving them out of this list would ship an unprepared statement against
  // a just-migrated table — exactly the 42P08 shape AGENTS.md §1 describes.
  {
    file: "packages/db/src/repository.ts",
    line: 3023,
    sql: `SELECT o.source_id,o.title,o.canonical_url,o.current_price,o.image_url,
      o.match_relation,o.decision_reason
      FROM watch_run_listing_observations o
      WHERE o.watch_binding_id IN (?,?)
      AND o.observed_at>=? AND o.observed_at<=?
      AND o.is_purchasable=1
      AND o.decision_status='uncertain'
      AND COALESCE(o.ai_relevance,'uncertain')<>'irrelevant'
      AND (COALESCE(o.match_relation,'uncertain')='probable_exact'
       OR NOT EXISTS (SELECT 1 FROM watch_run_listing_observations p
        WHERE p.watch_binding_id=o.watch_binding_id AND p.source_id=o.source_id
          AND p.source_item_id=o.source_item_id AND p.observed_at<?))
      AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
       WHERE x.watch_binding_id=o.watch_binding_id AND x.source_id=o.source_id
         AND x.source_item_id=o.source_item_id)
      ORDER BY CASE COALESCE(o.match_relation,'uncertain')
       WHEN 'probable_exact' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'related' THEN 2 ELSE 3 END,
       o.source_id,o.title
      LIMIT 200`,
  },
  {
    file: "packages/db/src/repository.ts",
    line: 3045,
    sql: `SELECT o.source_id,o.title,o.canonical_url,o.current_price,o.image_url,
      o.match_relation,o.decision_reason
      FROM watch_run_listing_observations o
      WHERE o.watch_binding_id IN (?,?)
      AND o.observed_at>=? AND o.observed_at<=?
      AND o.is_purchasable=1
      AND o.decision_status IN ('uncertain','rejected')
      AND COALESCE(o.match_relation,'uncertain') IN ('probable_exact','uncertain','related','bundle')
      AND (COALESCE(o.match_relation,'uncertain')='probable_exact'
       OR NOT EXISTS (SELECT 1 FROM watch_run_listing_observations p
        WHERE p.watch_binding_id=o.watch_binding_id AND p.source_id=o.source_id
          AND p.source_item_id=o.source_item_id AND p.observed_at<?))
      AND NOT EXISTS (SELECT 1 FROM watch_dismissed_candidates x
       WHERE x.watch_binding_id=o.watch_binding_id AND x.source_id=o.source_id
         AND x.source_item_id=o.source_item_id)
      ORDER BY CASE COALESCE(o.match_relation,'uncertain')
       WHEN 'probable_exact' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'related' THEN 2 ELSE 3 END,
       o.source_id,o.title
      LIMIT 200`,
  },
];
const staticQueryCount = queries.length;
queries.push(...representativeDynamicQueries.map((query) => ({
  ...query,
  sql: numberPostgresParameters(query.sql).replace(/;\s*$/u, ""),
})));

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const blocks = queries.map((query, index) => {
  const name = `operational_sql_${String(index + 1).padStart(4, "0")}`;
  const prepare = `PREPARE ${name} AS ${query.sql}`;
  return [
    "DO $validate_query$",
    "BEGIN",
    "  BEGIN",
    `    EXECUTE ${literal(prepare)};`,
    `    EXECUTE ${literal(`DEALLOCATE ${name}`)};`,
    "  EXCEPTION WHEN OTHERS THEN",
    "    INSERT INTO operational_sql_validation_errors(file_path,line_number,sqlstate,error_message)",
    `    VALUES (${literal(query.file)},${query.line},SQLSTATE,SQLERRM);`,
    "    BEGIN",
    `      EXECUTE ${literal(`DEALLOCATE ${name}`)};`,
    "    EXCEPTION WHEN OTHERS THEN",
    "      NULL;",
    "    END;",
    "  END;",
    "END",
    "$validate_query$;",
  ].join("\n");
});

process.stderr.write(
  `static operational queries: ${staticQueryCount}; `
  + `representative dynamic queries: ${representativeDynamicQueries.length}; `
  + `dynamic call sites reviewed: ${unresolved.length}\n`,
);
for (const location of unresolved) {
  process.stderr.write(`dynamic ${location.file}:${location.line}\n`);
}
process.stdout.write([
  "\\set ON_ERROR_STOP on",
  "CREATE TEMP TABLE operational_sql_validation_errors(",
  "  file_path text NOT NULL,",
  "  line_number integer NOT NULL,",
  "  sqlstate text NOT NULL,",
  "  error_message text NOT NULL",
  ");",
  "GRANT INSERT,SELECT ON operational_sql_validation_errors TO radar_core_runtime;",
  "SET ROLE radar_core_runtime;",
  "SET search_path TO radar_core,public;",
  ...blocks,
  "SELECT count(*) AS static_queries_checked FROM (VALUES",
  ...queries.map((_, index) => `  (${index + 1})${index === queries.length - 1 ? "" : ","}`),
  ") checked(query_number);",
  "TABLE operational_sql_validation_errors;",
  "",
].join("\n"));
