import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const vpsHost = process.env.JPGR_VPS_HOST?.trim() || "203.0.113.10";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function query(sql) {
  const output = execFileSync("ssh", [
    "-o", "BatchMode=yes",
    `root@${vpsHost}`,
    "sudo -u postgres psql -X -d jpgr -Atq",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: `SET search_path TO radar_core,public;\nSELECT COALESCE(json_agg(result_row),'[]'::json) FROM (${sql}) AS result_row;\n`,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const parsed = JSON.parse(output.trim());
  if (!Array.isArray(parsed)) throw new Error("PostgreSQL query did not return a JSON array.");
  return parsed;
}

function parseJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeSegment(value) {
  return String(value).replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

function payloadExtension(capture) {
  if (capture.payload_kind === "json" || String(capture.content_type).includes("json")) return "json";
  if (capture.payload_kind === "html" || String(capture.content_type).includes("html")) return "html";
  return "txt";
}

function timestampSegment() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

const requestedHistoryId = argument("--history");
if (requestedHistoryId && !UUID.test(requestedHistoryId)) {
  throw new Error("--history must be a UUID from search_history.");
}

const latest = requestedHistoryId
  ? [{ id: requestedHistoryId }]
  : query("SELECT id FROM search_history WHERE parent_history_id IS NULL ORDER BY searched_at DESC LIMIT 1");
const selectedId = latest[0]?.id;
if (!selectedId || !UUID.test(selectedId)) throw new Error("No search run is available to export.");

const rootRows = query(`SELECT id FROM search_history WHERE id=COALESCE((SELECT session_id FROM search_history WHERE id='${selectedId}'),'${selectedId}') AND parent_history_id IS NULL LIMIT 1`);
const rootId = rootRows[0]?.id;
if (!rootId || !UUID.test(rootId)) throw new Error(`Search run ${selectedId} was not found.`);

const historyRows = query(`SELECT * FROM search_history WHERE COALESCE(session_id,id)='${rootId}' ORDER BY page_sequence,id`);
const captures = query(`SELECT * FROM source_response_captures WHERE run_id IN (SELECT id FROM search_history WHERE COALESCE(session_id,id)='${rootId}') ORDER BY captured_at,source_id,ordinal`);
const snapshots = query(`SELECT snapshot.* FROM search_result_snapshots snapshot JOIN search_history history ON history.id=snapshot.search_history_id WHERE COALESCE(history.session_id,history.id)='${rootId}' ORDER BY history.page_sequence,snapshot.source_id`);
const variants = query(`SELECT variant.* FROM search_query_variants variant JOIN search_history history ON history.id=variant.search_history_id WHERE COALESCE(history.session_id,history.id)='${rootId}' ORDER BY history.page_sequence,variant.ordinal`);
const hits = query(`SELECT hit.* FROM search_candidate_hits hit JOIN search_history history ON history.id=hit.search_history_id WHERE COALESCE(history.session_id,history.id)='${rootId}' ORDER BY history.page_sequence,hit.source_id,hit.source_item_id,hit.upstream_rank`);
const relations = query(`SELECT relation.* FROM search_product_relations relation JOIN search_history history ON history.id=relation.search_history_id WHERE COALESCE(history.session_id,history.id)='${rootId}' ORDER BY history.page_sequence,relation.source_id,relation.source_item_id`);

const requestedOutput = argument("--output");
const outputRoot = requestedOutput
  ? path.resolve(repositoryRoot, requestedOutput)
  : path.join(repositoryRoot, "local-exports");
const outputDirectory = path.join(outputRoot, `${timestampSegment()}-${rootId}`);
const rawDirectory = path.join(outputDirectory, "raw");
const snapshotDirectory = path.join(outputDirectory, "normalized-snapshots");
await mkdir(rawDirectory, { recursive: true });
await mkdir(snapshotDirectory, { recursive: true });

const normalizedHistory = historyRows.map((row) => ({
  ...row,
  sources_json: parseJson(row.sources_json),
  filters_json: parseJson(row.filters_json),
  source_summary_json: parseJson(row.source_summary_json),
  target_json: parseJson(row.target_json),
  plan_json: parseJson(row.plan_json),
}));
const captureIndex = [];
for (let index = 0; index < captures.length; index += 1) {
  const capture = captures[index];
  const filename = `${String(index + 1).padStart(3, "0")}-${safeSegment(capture.source_id)}-${safeSegment(capture.run_id).slice(0, 8)}-${capture.ordinal}.${payloadExtension(capture)}`;
  if (capture.raw_payload !== null && capture.raw_payload !== undefined) {
    await writeFile(path.join(rawDirectory, filename), String(capture.raw_payload), "utf8");
  }
  const { raw_payload: _rawPayload, ...metadata } = capture;
  captureIndex.push({ ...metadata, local_file: capture.raw_payload == null ? null : `raw/${filename}` });
}

for (let index = 0; index < snapshots.length; index += 1) {
  const snapshot = snapshots[index];
  const filename = `${String(index + 1).padStart(3, "0")}-${safeSegment(snapshot.source_id)}-page-${safeSegment(snapshot.search_history_id).slice(0, 8)}.json`;
  await writeFile(path.join(snapshotDirectory, filename), `${JSON.stringify(parseJson(snapshot.group_json), null, 2)}\n`, "utf8");
}

const manifest = {
  formatVersion: 1,
  exportedAt: new Date().toISOString(),
  searchRunId: rootId,
  counts: {
    historyPages: historyRows.length,
    rawCaptures: captures.length,
    normalizedSnapshots: snapshots.length,
    queryVariants: variants.length,
    candidateHits: hits.length,
    productRelations: relations.length,
  },
  notes: [
    "raw/ contains bounded structured response evidence; complete HTML bodies are never stored.",
    "Request and response URLs are the sanitized evidence URLs stored by the collector.",
    "A truncated flag means the capture reached the collector's bounded payload limit.",
    "normalized-snapshots/ contains the post-adapter source groups used by the search result UI.",
  ],
};

await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDirectory, "search-run.json"), `${JSON.stringify({
  history: normalizedHistory,
  queryVariants: variants,
  candidateHits: hits,
  productRelations: relations.map((row) => ({ ...row, evidence_json: parseJson(row.evidence_json) })),
}, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDirectory, "capture-index.json"), `${JSON.stringify(captureIndex, null, 2)}\n`, "utf8");
await copyFile(
  path.join(repositoryRoot, "docs", "deprecated", "RAW_SOURCE_DATA_AI_CLEANING_REVIEW.md"),
  path.join(outputDirectory, "CLEANING_LOGIC_REVIEW.md"),
);
await writeFile(path.join(outputDirectory, "README.md"), `# Search evidence export\n\n- Search run: \`${rootId}\`\n- Exported: ${manifest.exportedAt}\n- Raw captures: ${captures.length}\n- Normalized source snapshots: ${snapshots.length}\n\n## Reading order\n\n1. Start with \`manifest.json\` for scope and counts.\n2. Use \`capture-index.json\` to map a request, hash, status and truncation flag to a file under \`raw/\`.\n3. Compare that file with the matching source group under \`normalized-snapshots/\`.\n4. Read \`CLEANING_LOGIC_REVIEW.md\` for the repository's parsing and AI-cleaning audit.\n\nThis export is evidence only. It does not issue any new marketplace request.\n`, "utf8");

process.stdout.write(`${outputDirectory}\n`);
