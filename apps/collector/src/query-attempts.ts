import type { OperationalDatabase } from "@jpgr/db";

/** 一轮巡检里实际发到来源站的一条搜索词（radar_core.watch_run_query_attempts）。 */
export interface WatchQueryAttempt {
  role: "main" | "fallback";
  variantKind: string;
  query: string;
  outcome: "succeeded" | "failed";
  upstreamCount: number;
  candidateCount: number;
  newCandidateCount: number;
  sourceItemIds: string[];
  errorMessage?: string;
  durationMs: number;
}

/**
 * 搜索词记录是给以后调召回规则用的统计，尽力而为：写失败只打日志，
 * 绝不能把一轮成功的采集拖成失败。
 */
export async function stageWatchQueryAttempts(
  db: OperationalDatabase,
  run: { id: string; bindingId: string; sourceId: string },
  attempts: readonly WatchQueryAttempt[],
): Promise<void> {
  if (attempts.length === 0) return;
  const createdAt = new Date().toISOString();
  try {
    await db.batch(attempts.map((attempt, index) => db.prepare(
      `INSERT INTO watch_run_query_attempts(
         watch_run_id,ordinal,watch_binding_id,source_id,role,variant_kind,query,outcome,
         upstream_count,candidate_count,new_candidate_count,source_item_ids_json,error_message,duration_ms,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      run.id,
      index + 1,
      run.bindingId,
      run.sourceId,
      attempt.role,
      attempt.variantKind,
      attempt.query.slice(0, 500),
      attempt.outcome,
      attempt.upstreamCount,
      attempt.candidateCount,
      attempt.newCandidateCount,
      JSON.stringify(attempt.sourceItemIds.slice(0, 100)),
      attempt.errorMessage?.slice(0, 300) ?? null,
      Math.max(0, Math.round(attempt.durationMs)),
      createdAt,
    )));
  } catch (error) {
    console.error(JSON.stringify({
      event: "watch_query_attempts_stage_failed",
      runId: run.id,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
}
