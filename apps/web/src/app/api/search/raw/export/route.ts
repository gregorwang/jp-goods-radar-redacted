import { unauthorized } from "@/lib/api-auth";
import { getEnv } from "@/lib/cloudflare";

interface SearchExportHistoryRow {
  id: string;
  query: string;
  status: string;
  result_count: number;
  searched_at: string;
  sources_json: string;
  filters_json: string;
  plan_json: string | null;
}

interface SearchExportCaptureRow {
  id: string;
  run_id: string;
  source_id: string;
  ordinal: number;
  request_url: string;
  response_url: string | null;
  request_method: string;
  response_status: number | null;
  content_type: string | null;
  payload_kind: string;
  raw_payload: string | null;
  payload_bytes: number;
  content_hash: string;
  captured_at: string;
  duration_ms: number;
  truncated: number;
  error_message: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsedJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const historyId = new URL(request.url).searchParams.get("historyId") ?? "";
  if (!UUID.test(historyId)) return Response.json({ error: "invalid_raw_export_request" }, { status: 400 });

  const [history, captures] = await Promise.all([
    getEnv().DB.prepare(
      `SELECT id,query,status,result_count,searched_at,sources_json,filters_json,plan_json
       FROM search_history
       WHERE id=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
         AND parent_history_id IS NULL`,
    ).bind(historyId, historyId).first<SearchExportHistoryRow>(),
    getEnv().DB.prepare(
      `SELECT id,run_id,source_id,ordinal,request_url,response_url,request_method,response_status,
              content_type,payload_kind,raw_payload,payload_bytes,content_hash,captured_at,
              duration_ms,truncated,error_message
       FROM source_response_captures
       WHERE run_id IN (
         SELECT id FROM search_history
         WHERE COALESCE(session_id,id)=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
       )
       ORDER BY captured_at,source_id,ordinal`,
    ).bind(historyId, historyId).all<SearchExportCaptureRow>(),
  ]);
  if (!history) return Response.json({ error: "search_run_not_found" }, { status: 404 });

  const body = JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    history: {
      id: history.id,
      query: history.query,
      status: history.status,
      resultCount: history.result_count,
      searchedAt: history.searched_at,
      sources: parsedJson(history.sources_json),
      filters: parsedJson(history.filters_json),
      plan: parsedJson(history.plan_json),
    },
    captures: captures.results.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sourceId: row.source_id,
      ordinal: row.ordinal,
      requestUrl: row.request_url,
      responseUrl: row.response_url,
      requestMethod: row.request_method,
      responseStatus: row.response_status,
      contentType: row.content_type,
      payloadKind: row.payload_kind,
      rawPayload: row.raw_payload,
      payloadBytes: row.payload_bytes,
      contentHash: row.content_hash,
      capturedAt: row.captured_at,
      durationMs: row.duration_ms,
      truncated: row.truncated === 1,
      error: row.error_message,
    })),
  }, null, 2);
  return new Response(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="search-evidence-${history.id}.json"`,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
