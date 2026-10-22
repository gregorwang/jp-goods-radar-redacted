import { unauthorized } from "@/lib/api-auth";
import { getEnv } from "@/lib/cloudflare";
import { SOURCE_IDS, type SourceId } from "@jpgr/core";

interface RawCaptureRow {
  id: string;
  source_id: SourceId;
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

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const url = new URL(request.url);
  const historyId = url.searchParams.get("historyId") ?? "";
  const sourceId = url.searchParams.get("sourceId") ?? "";
  if (!UUID.test(historyId) || !SOURCE_IDS.includes(sourceId as SourceId)) {
    return Response.json({ error: "invalid_raw_capture_request" }, { status: 400 });
  }
  const rows = await getEnv().DB.prepare(
    `SELECT id,source_id,ordinal,request_url,response_url,request_method,response_status,
            content_type,payload_kind,raw_payload,payload_bytes,content_hash,captured_at,
            duration_ms,truncated,error_message
     FROM source_response_captures
     WHERE run_id IN (
       SELECT id FROM search_history
       WHERE COALESCE(session_id,id)=COALESCE((SELECT session_id FROM search_history WHERE id=?),?)
     ) AND source_id=?
     ORDER BY captured_at,ordinal`,
  ).bind(historyId, historyId, sourceId).all<RawCaptureRow>();
  return Response.json({
    items: rows.results.map((row) => ({
      id: row.id,
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
  });
}
