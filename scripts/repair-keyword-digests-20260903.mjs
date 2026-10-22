// Narrow, evidence-based repair for the two investigated September 3 digests.
// Defaults to a read-only preview. --apply saves a complete row backup first,
// then uses one transaction with optimistic guards. Never replays deliveries.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = "keyword-digest-classification-20260903-v1";
const profileIds = ["8e4f3341-c6b9-48bc-a73f-490fcf7a3eb4", "9a16aeee-3e0c-4512-aa96-8dad3d5ecdd9"];
const digestIds = ["3f028524-9463-46ff-b55f-ed4ef1d55fcb", "5562aefd-e95f-4bbc-98fb-c1e176ce7d25"];
const warningId = "6767b8e3-2f76-4a49-bedf-40b268ec6050";
const filteredRunId = "d280fc49-b35c-4368-a473-d2346808c366";
const start = "2026-09-03T10:38:59.084Z";
const end = "2026-09-03T11:19:14.467Z";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const list = (values) => values.map(literal).join(",");
function sql(query) {
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "root@203.0.113.10",
    "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atq -d jpgr"], {
    input: query, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
const scope = `watch_profile_id IN (${list(profileIds)}) AND created_at>=${literal(start)} AND created_at<=${literal(end)}`;
const runScope = `watch_binding_id IN (SELECT id FROM watch_bindings WHERE watch_profile_id IN (${list(profileIds)})) AND started_at>=${literal(start)} AND started_at<=${literal(end)}`;
const snapshot = JSON.parse(sql(`BEGIN READ ONLY;
SET LOCAL search_path TO radar_core,public;
SET LOCAL statement_timeout='20s';
SELECT json_build_object(
 'events',(SELECT json_agg(e) FROM events e WHERE ${scope}),
 'runs',(SELECT json_agg(r) FROM watch_runs r WHERE ${runScope}),
 'health',(SELECT json_agg(h) FROM source_health_snapshots h WHERE watch_run_id=${literal(filteredRunId)}),
 'candidates',(SELECT json_agg(c) FROM (
   SELECT e.id,e.watch_binding_id,l.source_id,l.canonical_url,
     (SELECT min(o.observed_at) FROM watch_run_listing_observations o WHERE o.watch_binding_id=e.watch_binding_id
      AND o.source_id=l.source_id AND o.source_item_id=l.source_item_id AND o.observed_at<${literal(start)}) previous_observed_at
   FROM events e JOIN listings l ON l.id=e.listing_id WHERE e.event_type='new_listing' AND e.${scope}
 ) c),
 'bindings',(SELECT json_agg(b) FROM watch_bindings b WHERE watch_profile_id IN (${list(profileIds)})),
 'history',(SELECT json_agg(h) FROM (SELECT b.watch_profile_id,count(*) count,min(m.first_seen_at) first_seen_at
   FROM watch_listing_matches m JOIN watch_bindings b ON b.id=m.watch_binding_id
   WHERE b.watch_profile_id IN (${list(profileIds)}) AND m.first_seen_at<'2026-09-03'
   GROUP BY b.watch_profile_id) h)
);
COMMIT;`));
const digests = digestIds.map((id) => snapshot.events.find((event) => event.id === id));
if (digests.some((digest) => !digest)) throw new Error("Expected digest missing; repair aborted");
if (digests.every((digest) => JSON.parse(digest.payload_json).correction?.version === version)) {
  console.log(JSON.stringify({ status: "already_repaired", version }));
  process.exit(0);
}
if (digests.some((digest) => JSON.parse(digest.payload_json).kind !== "keyword_initial_baseline")) {
  throw new Error("Digest classification changed; investigate before retrying");
}
const recovered = snapshot.candidates.filter((candidate) => candidate.previous_observed_at);
if (snapshot.candidates.length !== 75 || recovered.length !== 34) throw new Error("Evidence counts changed; repair aborted");
const recoveredIds = new Set(recovered.map((candidate) => candidate.id));
const correction = { version, appliedAt: new Date().toISOString(), reason: "区分来源基线、首次发现和历史商品恢复识别；正常排除不记作来源失败" };
const updates = [];
function update(table, row, fields) {
  updates.push({ table, before: row, fields });
}
for (const digest of digests) {
  const payload = JSON.parse(digest.payload_json);
  const candidates = snapshot.candidates.filter((candidate) => snapshot.events.find((event) => event.id === candidate.id).watch_profile_id === digest.watch_profile_id);
  const restored = candidates.filter((candidate) => recoveredIds.has(candidate.id));
  const byUrl = new Map(candidates.map((candidate) => [`${candidate.source_id}:${candidate.canonical_url}`, candidate]));
  const items = payload.items.map((item) => {
    if (item.sourceId === "amiami") return { ...item, category: "baseline" };
    const candidate = byUrl.get(`${item.sourceId}:${item.url}`);
    if (!candidate) throw new Error("Digest item has no matching evidence");
    return { ...item, category: recoveredIds.has(candidate.id) ? "recovered" : "new" };
  });
  if (items.filter((item) => item.category === "baseline").length !== payload.baselineTotal
      || candidates.length !== payload.newTotal || items.length !== payload.total) throw new Error("Digest item totals do not reconcile");
  update("events", digest, { payload_json: JSON.stringify({ ...payload,
    kind: "keyword_scan_summary", newTotal: candidates.length - restored.length, recoveredTotal: restored.length,
    baselineSourceIds: ["amiami"], items,
    failedSources: (payload.failedSources ?? []).filter((source) => source !== "rakuten_ichiba" || digest.watch_profile_id !== profileIds[0]),
    sourceIssues: (payload.sourceIssues ?? []).filter((issue) => issue.errorCode !== "keyword_rules_filtered_all"),
    correction: { ...correction, originalKind: payload.kind, originalNewTotal: payload.newTotal },
  }) });
}
for (const candidate of recovered) {
  const row = snapshot.events.find((event) => event.id === candidate.id);
  update("events", row, { payload_json: JSON.stringify({ ...JSON.parse(row.payload_json),
    discoveryKind: "recovered_match", previousObservedAt: candidate.previous_observed_at, correction,
  }) });
}
const message = "采集成功，已抓取 30 条商品，均为命中排除词的 Anna Emilia 餐具，本轮无符合条件商品。原始采集证据已保留。";
const warning = snapshot.events.find((event) => event.id === warningId);
if (!warning || JSON.parse(warning.payload_json).code !== "keyword_rules_filtered_all") throw new Error("Expected filter warning missing");
update("events", warning, { payload_json: JSON.stringify({ ...JSON.parse(warning.payload_json), code: "keyword_rules_excluded_all", message, correction }) });
for (const row of snapshot.runs) {
  const binding = snapshot.bindings.find((item) => item.id === row.watch_binding_id);
  const restored = recovered.filter((candidate) => candidate.watch_binding_id === row.watch_binding_id).length;
  if (binding.source_id === "amiami") update("watch_runs", row, { new_count: 0 });
  else if (restored) {
    if (row.new_count < restored) throw new Error("Run count would become negative");
    update("watch_runs", row, { new_count: row.new_count - restored });
  } else if (row.id === filteredRunId) update("watch_runs", row, { status: "success", error_code: "keyword_rules_excluded_all", error_message: message });
}
for (const row of snapshot.health) update("source_health_snapshots", row, { error_code: "keyword_rules_excluded_all", error_message: message });
const summary = updates.filter((entry) => entry.table === "events" && digestIds.includes(entry.before.id))
  .map((entry) => { const p = JSON.parse(entry.fields.payload_json); return { profile: p.profileName, newTotal: p.newTotal, recoveredTotal: p.recoveredTotal, baselineTotal: p.baselineTotal }; });
console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "apply" : "preview", rows: updates.length, summary, history: snapshot.history }));
if (!process.argv.includes("--apply")) process.exit(0);
const backupDirectory = resolve("local-exports", "repairs", version, correction.appliedAt.replaceAll(":", "-"));
mkdirSync(backupDirectory, { recursive: true });
writeFileSync(resolve(backupDirectory, "before.json"), JSON.stringify(snapshot, null, 2), { flag: "wx" });
writeFileSync(resolve(backupDirectory, "changes.json"), JSON.stringify(updates, null, 2), { flag: "wx" });
const mutation = updates.map(({ table, before, fields }) => `DO $repair$
DECLARE affected integer;
BEGIN
 UPDATE ${table} old SET ${Object.entries(fields).map(([key, value]) => `${key}=${typeof value === "number" ? value : literal(value)}`).join(",")}
 WHERE id=${literal(before.id)} AND to_jsonb(old)=${literal(JSON.stringify(before))}::jsonb;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'Repair conflict in ${table} ${before.id}'; END IF;
END $repair$;`).join("\n");
sql(`BEGIN; SET LOCAL search_path TO radar_core,public; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n${mutation}\nCOMMIT;`);
writeFileSync(resolve(backupDirectory, "applied.json"), JSON.stringify({ version, summary, appliedAt: new Date().toISOString() }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ status: "repaired", rows: updates.length, backupDirectory, summary }));
