import { unauthorized } from "@/lib/api-auth";
import { getEnv } from "@/lib/cloudflare";
import type { SourceRequestRoute } from "@jpgr/core";
import { OVERNIGHT_COLLECTION_OVERRIDE_FLAG, overnightCollectionPolicy } from "@jpgr/core";
import {
  isRakutenSourceId,
  rakutenMonitoringEnabledForSource,
  type RakutenRuntimePolicy,
} from "@/lib/rakuten-policy";

interface RuntimeSourceStatus {
  sourceId: string;
  adapterAvailable: boolean;
  historySearchSupported: boolean;
  credentialStatus: string;
  requestRoute?: SourceRequestRoute;
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  const env = getEnv();
  const healthRollupCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [result, checks, completion, qualification, observations, probeHistory, healthRollups, healthObservations, overnightFlag] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id,s.display_name,s.transport,s.official_api,s.enabled,s.credential_status,s.health_status,s.parser_version,
       s.last_success_at,s.last_failure_at,s.consecutive_failures,s.cooldown_until,s.last_http_status,s.last_error_code,s.last_error_message,
       s.request_route,s.cooldown_route,
       s.last_signature_success_at,s.schema_version,s.last_403_at,s.last_429_at,s.last_container_count,s.last_page_bytes,s.captcha_detected,
       p.status probe_status,p.started_at probe_started_at,p.planned_end_at probe_planned_end_at,p.total_runs probe_total_runs,
       p.successful_runs probe_successful_runs,p.field_total probe_field_total,p.field_complete probe_field_complete,
       p.captcha_runs probe_captcha_runs,p.cpu_limit_runs probe_cpu_limit_runs,p.login_required_runs probe_login_required_runs,
       p.decision_reason probe_decision_reason,p.request_route probe_request_route
       FROM source_registry s LEFT JOIN source_probe_windows p ON p.source_id=s.id
       ORDER BY s.official_api DESC,s.display_name`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT scope,check_key,label,status,verified_at FROM verification_checks ORDER BY scope,check_key",
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT status,sent_at,last_error FROM completion_notifications WHERE idempotency_key='final_acceptance:v4'",
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT id,status,started_at,finished_at,results_json,error_message FROM p0_qualification_runs ORDER BY started_at DESC LIMIT 1",
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id,source_id,window_started_at,observed_at,status,coverage,result_count,field_total,field_complete,
       http_status,parser_version,error_code,error_message,captcha_detected,cpu_limit_detected,login_required
       FROM source_probe_observations ORDER BY observed_at DESC LIMIT 36`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id,source_id,status,request_route,started_at,planned_end_at,finished_at,total_runs,successful_runs,
       field_total,field_complete,decision_reason,archived_at,archive_reason,next_request_route
       FROM source_probe_window_history ORDER BY archived_at DESC LIMIT 12`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `WITH aggregate AS (
         SELECT source_id,count(*) total_runs,
                sum(CASE WHEN state NOT IN ('disabled','cooldown') THEN 1 ELSE 0 END) attempted_runs,
                sum(request_succeeded) request_successes,
                sum(parse_succeeded) parse_successes,sum(abnormal_empty) abnormal_empty_runs,
                sum(field_total) field_total,sum(field_complete) field_complete
          FROM source_health_snapshots WHERE observed_at>=? GROUP BY source_id
       )
       SELECT aggregate.*,latest.state latest_state,latest.observed_at latest_observed_at,
              latest.freshness_sla_minutes,latest.error_code latest_error_code
       FROM aggregate LEFT JOIN source_health_snapshots latest ON latest.id=(
         SELECT snapshot.id FROM source_health_snapshots snapshot
         WHERE snapshot.source_id=aggregate.source_id ORDER BY snapshot.observed_at DESC LIMIT 1
       )`,
    ).bind(healthRollupCutoff).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id,source_id,observed_at,state,request_succeeded,parse_succeeded,raw_result_count,
              normalized_result_count,page_depth,cursor_termination_reason,field_total,field_complete,
              http_status,abnormal_empty,error_code,error_message
       FROM source_health_snapshots ORDER BY observed_at DESC LIMIT 48`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT enabled,config_json FROM runtime_feature_flags WHERE flag_key=?",
    ).bind(OVERNIGHT_COLLECTION_OVERRIDE_FLAG).first<{ enabled: number; config_json: string }>(),
  ]);
  let runtime = new Map<string, RuntimeSourceStatus>();
  let resend: Record<string, unknown> = { configured: false };
  let rakuten: RakutenRuntimePolicy = { affiliateMode: false, privateMonitoringEnabled: false, publicPreviewEnabled: false };
  let mercari: Record<string, unknown> = { independentServiceConfigured: false, requestRoute: "direct" };
  let surugaya: Record<string, unknown> = { independentServiceConfigured: false, requestRoute: "direct" };
  let yahooAuctions: Record<string, unknown> = { experimentalEnabled: false, requestRoute: "direct" };
  let yahooFleamarket: Record<string, unknown> = { cloudflareDirectEnabled: false, browserRunFallbackConfigured: false, requestRoute: "direct" };
  let browserRun: Record<string, unknown> = { configured: false, sources: [] };
  let sourceRunner: Record<string, unknown> = { configured: false, sources: [], concurrency: 1 };
  let amazon: Record<string, unknown> = { configured: false, requestRoute: "direct" };
  let sourceService: Record<string, unknown> = { configured: false, requestRoute: "direct", sources: ["charaon", "cospa", "animate"] };
  try {
    const response = await env.COLLECTOR.fetch("http://collector/internal/source-status");
    const body = await response.json() as { sources?: RuntimeSourceStatus[]; resend?: Record<string, unknown>; rakuten?: RakutenRuntimePolicy;
      mercari?: Record<string, unknown>; surugaya?: Record<string, unknown>; yahooAuctions?: Record<string, unknown>;
      yahooFleamarket?: Record<string, unknown>; browserRun?: Record<string, unknown>;
      sourceRunner?: Record<string, unknown>;
      amazon?: Record<string, unknown>;
      sourceService?: Record<string, unknown> };
    runtime = new Map((body.sources ?? []).map((source) => [source.sourceId, source]));
    resend = body.resend ?? resend;
    rakuten = body.rakuten ?? rakuten;
    mercari = body.mercari ?? mercari;
    surugaya = body.surugaya ?? surugaya;
    yahooAuctions = body.yahooAuctions ?? yahooAuctions;
    yahooFleamarket = body.yahooFleamarket ?? yahooFleamarket;
    browserRun = body.browserRun ?? browserRun;
    sourceRunner = body.sourceRunner ?? sourceRunner;
    amazon = body.amazon ?? amazon;
    sourceService = body.sourceService ?? sourceService;
  } catch {
    // PostgreSQL remains the source of truth if the service binding is temporarily unavailable.
  }
  const healthBySource = new Map(healthRollups.results.map((row) => [String(row.source_id), row]));
  const items = result.results.map((row) => {
    const status = runtime.get(String(row.id));
    const sourceId = String(row.id);
    const rakutenAllowed = !isRakutenSourceId(sourceId) || rakutenMonitoringEnabledForSource(sourceId, rakuten);
    const monitoringAllowed = row.enabled === 1 && rakutenAllowed
      && (row.id !== "amazon_jp" || amazon.monitoringEnabled === true)
      && (row.id !== "yahoo_auctions_jp" || yahooAuctions.experimentalEnabled === true);
    const health = healthBySource.get(sourceId);
    const latestObservedAt = typeof health?.latest_observed_at === "string" ? health.latest_observed_at : null;
    const freshnessSlaMinutes = Number(health?.freshness_sla_minutes ?? 0);
    const fresh = Boolean(latestObservedAt && freshnessSlaMinutes > 0
      && Date.now() - Date.parse(latestObservedAt) <= freshnessSlaMinutes * 60_000);
    return { ...row, adapter_available: status?.adapterAvailable ?? false, credential_status: status?.credentialStatus ?? row.credential_status,
      request_route: status?.requestRoute ?? row.request_route,
      history_search_supported: status?.historySearchSupported ?? row.id === "mercari_jp",
      monitoring_allowed: monitoringAllowed,
      health_24h: health ? {
        totalRuns: Number(health.total_runs ?? 0),
        attemptedRuns: Number(health.attempted_runs ?? 0),
        requestSuccesses: Number(health.request_successes ?? 0),
        parseSuccesses: Number(health.parse_successes ?? 0),
        abnormalEmptyRuns: Number(health.abnormal_empty_runs ?? 0),
        fieldTotal: Number(health.field_total ?? 0),
        fieldComplete: Number(health.field_complete ?? 0),
        latestState: String(health.latest_state ?? "failed"),
        latestObservedAt,
        freshnessSlaMinutes,
        fresh,
      } : null };
  });
  return Response.json({ items, resend, rakuten, mercari, surugaya, yahooAuctions, yahooFleamarket, browserRun, sourceRunner, amazon, sourceService,
    collectionPolicy: overnightCollectionPolicy(new Date(), overnightFlag), verification: checks.results, completion, qualification,
    probeObservations: observations.results, probeHistory: probeHistory.results, healthObservations: healthObservations.results });
}
