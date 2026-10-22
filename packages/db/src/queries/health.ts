/**
 * 每日体检：把"有没有东西悄悄坏了"做成每天自动跑的一组只读查询。
 *
 * 不新增埋点——2026-09-28 手工翻库时找到的问题（单品监控 5 周没成功、Amazon 连续失败
 * 15 次、成交记录停写、日报静默截断）全都早就在现有表里，缺的只是有人去看。结论落在
 * health_check_findings，每周一的精确同款周报在最底部读出来。
 *
 * 每项检查独立 try/catch：一项查询出错不影响其他项，出错本身也记成一条 finding。
 */
/**
 * 本文件是 `RadarRepository` 的一部分，排在 OpsRepository 之后（见 `repository.ts`）。
 */
import type { SourceId } from "@jpgr/core";
import type {
  HealthFinding,
  HealthSeverity,
  WeeklyHealthSummary,
} from "../types";
import type { OperationalPreparedStatement } from "../database";
import { japanDayKey, JAPAN_OFFSET_MS } from "./shared";
import { OpsRepository } from "./ops";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

interface DetectedFinding {
  checkKey: string;
  subjectKey: string;
  severity: HealthSeverity;
  sourceId: SourceId | null;
  title: string;
  detail: string;
}

/** 数据流新鲜度：每一行都是"这张表正常情况下多久之内必有新数据"。 */
const DATA_STREAMS: ReadonlyArray<{
  key: "watch_runs" | "email_sent" | "ai_done" | "analytics_sync" | "disk";
  label: string;
  maxHours: number;
  severity: HealthSeverity;
  meaning: string;
}> = [
  { key: "watch_runs", label: "抓取运行记录", maxHours: 6, severity: "critical", meaning: "所有监控都没有在跑。" },
  { key: "email_sent", label: "邮件发送", maxHours: 48, severity: "warning", meaning: "日报和提醒可能都没有发出去。" },
  { key: "ai_done", label: "AI 判定", maxHours: 48, severity: "warning", meaning: "新抓到的商品没有经过判定，进不了日报。" },
  // 运行时角色只能读 radar_core（verify:sql 以 radar_core_runtime 校验），分析库本身看不到，
  // 所以用发件箱最近一次成功投递代表"分析库同步还活着"。成交记录停更因此不在体检范围内。
  { key: "analytics_sync", label: "分析库同步", maxHours: 48, severity: "warning", meaning: "抓取结果没有同步进分析库。" },
  { key: "disk", label: "服务器磁盘采样", maxHours: 48, severity: "warning", meaning: "VPS 上的 jpgr-disk-usage.timer 可能停了，磁盘满了也不会知道。" },
];

const RUN_STATUS_LABELS: Record<string, string> = {
  success: "成功",
  failed: "失败",
  skipped: "跳过",
  running: "运行中",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 东京时间「9-13 16:28」。 */
function tokyoText(value: string | number): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  const text = new Date(ms + JAPAN_OFFSET_MS).toISOString();
  return `${Number(text.slice(5, 7))}-${Number(text.slice(8, 10))} ${text.slice(11, 16)}`;
}

function ageText(ms: number): string {
  return ms >= 2 * DAY_MS ? `${Math.floor(ms / DAY_MS)} 天` : `${Math.max(1, Math.floor(ms / HOUR_MS))} 小时`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 去掉错误原文里每次都不同的 UUID，让同一种错误落到同一个 subject。 */
function errorShape(message: string | null): string {
  return (message ?? "")
    .split("；")[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "…")
    .trim()
    .slice(0, 120);
}

export abstract class HealthRepository extends OpsRepository {
  /**
   * 每个东京日期跑一次；当天已经跑完就直接返回。cron 每小时第 10 分钟调用一次，
   * 所以当天第一跳失败了，下一个小时会自动再试。
   */
  async runDailyHealthCheck(now = Date.now()): Promise<{ ran: boolean; findings: number }> {
    const day = japanDayKey(now);
    const existing = await this.db.prepare(
      "SELECT finished_at FROM health_check_runs WHERE day=?",
    ).bind(day).first<{ finished_at: string | null }>();
    if (existing?.finished_at) return { ran: false, findings: 0 };
    const startedAt = iso(now);
    await this.db.prepare(
      `INSERT INTO health_check_runs(day,started_at) VALUES(?,?)
       ON CONFLICT (day) DO UPDATE SET started_at=excluded.started_at`,
    ).bind(day, startedAt).run();

    const checks: ReadonlyArray<[string, () => Promise<DetectedFinding[]>]> = [
      ["monitor_no_success", () => this.checkMonitorsWithoutSuccess(now)],
      ["source_all_empty", () => this.checkSourcesAllEmpty(now)],
      ["source_parse_failed", () => this.checkSourcesParseFailed(now)],
      ["data_stale", () => this.checkStaleDataStreams(now)],
      ["dead_letters", () => this.checkDeadLetters(now)],
      ["ai_judgement", () => this.checkAiJudgement(now)],
      ["keyword_digest", () => this.checkKeywordDigests(now)],
      ["email_failed", () => this.checkFailedEmails(now)],
      ["disk_usage", () => this.checkDiskUsage()],
    ];
    const findings: DetectedFinding[] = [];
    const completedChecks: string[] = ["health_check_failed"];
    const failedChecks: string[] = [];
    for (const [checkKey, run] of checks) {
      try {
        findings.push(...await run());
        completedChecks.push(checkKey);
      } catch (error) {
        failedChecks.push(checkKey);
        findings.push({
          checkKey: "health_check_failed",
          subjectKey: checkKey,
          severity: "warning",
          sourceId: null,
          title: `体检项「${checkKey}」自身出错`,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        });
      }
    }

    const statements: OperationalPreparedStatement[] = findings.map((finding) => this.db.prepare(
      `INSERT INTO health_check_findings(
         check_key,subject_key,severity,source_id,title,detail,first_seen_at,last_seen_at,resolved_at
       ) VALUES(?,?,?,?,?,?,?,?,NULL)
       ON CONFLICT (check_key,subject_key) DO UPDATE SET
         severity=excluded.severity,source_id=excluded.source_id,title=excluded.title,detail=excluded.detail,
         first_seen_at=CASE WHEN health_check_findings.resolved_at IS NULL
           THEN health_check_findings.first_seen_at ELSE excluded.first_seen_at END,
         last_seen_at=excluded.last_seen_at,resolved_at=NULL`,
    ).bind(
      finding.checkKey,
      finding.subjectKey,
      finding.severity,
      finding.sourceId,
      finding.title,
      finding.detail,
      startedAt,
      startedAt,
    ));
    // 只有这次真正跑完的检查项，才能断定"今天没再出现 = 已经好了"。
    for (const checkKey of completedChecks) {
      statements.push(this.db.prepare(
        `UPDATE health_check_findings SET resolved_at=?
         WHERE check_key=? AND resolved_at IS NULL AND last_seen_at<?`,
      ).bind(startedAt, checkKey, startedAt));
    }
    statements.push(this.db.prepare(
      "UPDATE health_check_runs SET finished_at=?,finding_count=?,failed_checks=? WHERE day=?",
    ).bind(iso(Date.now()), findings.length, JSON.stringify(failedChecks), day));
    await this.db.batch(statements);
    return { ran: true, findings: findings.length };
  }

  /** 周报读取：本周出现过或本周恢复的问题，外加体检跑了几天。 */
  async weeklyHealthSummary(startedAt: string, endedAt: string): Promise<WeeklyHealthSummary> {
    const [findings, runs] = await Promise.all([
      this.db.prepare(
        `SELECT check_key,subject_key,severity,source_id,title,detail,first_seen_at,last_seen_at,resolved_at
         FROM health_check_findings
         WHERE last_seen_at>=? OR resolved_at>=?
         ORDER BY CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END,
           CASE severity WHEN 'critical' THEN 0 ELSE 1 END,first_seen_at`,
      ).bind(startedAt, startedAt).all<{
        check_key: string;
        subject_key: string;
        severity: HealthSeverity;
        source_id: SourceId | null;
        title: string;
        detail: string;
        first_seen_at: string;
        last_seen_at: string;
        resolved_at: string | null;
      }>(),
      this.db.prepare(
        `SELECT COUNT(*) completed FROM health_check_runs
         WHERE finished_at IS NOT NULL AND started_at>=? AND started_at<?`,
      ).bind(startedAt, endedAt).first<{ completed: number | string }>(),
    ]);
    return {
      completedRuns: Number(runs?.completed ?? 0),
      days: Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / DAY_MS)),
      findings: findings.results.map((row): HealthFinding => ({
        checkKey: row.check_key,
        subjectKey: row.subject_key,
        severity: row.severity,
        sourceId: row.source_id,
        title: row.title,
        detail: row.detail,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        resolvedAt: row.resolved_at,
      })),
    };
  }

  /**
   * 监控长时间没有成功。阈值是 3 天与 3 个巡回间隔取大。
   * 专门抓"不算失败、所以不报错"的情况：生产中乐天一个单品页 404 后一直被记成
   * skipped，失败计数始终为 0，5 周没有任何提醒。
   */
  private async checkMonitorsWithoutSuccess(now: number): Promise<DetectedFinding[]> {
    const floor = iso(now - 3 * DAY_MS);
    const rows = await this.db.prepare(
      `SELECT b.id,b.source_id,b.interval_minutes,b.created_at,b.last_success_at,
         b.last_error_code,b.last_error_message,p.name profile_name
       FROM watch_bindings b JOIN watch_profiles p ON p.id=b.watch_profile_id
       WHERE b.enabled=1 AND p.enabled=1 AND b.created_at<? AND COALESCE(b.last_success_at,'')<?`,
    ).bind(floor, floor).all<{
      id: string;
      source_id: SourceId;
      interval_minutes: number | string;
      created_at: string;
      last_success_at: string | null;
      last_error_code: string | null;
      last_error_message: string | null;
      profile_name: string;
    }>();
    const findings: DetectedFinding[] = [];
    for (const row of rows.results) {
      const threshold = Math.max(3 * DAY_MS, 3 * Number(row.interval_minutes) * 60_000);
      const since = Date.parse(row.last_success_at ?? row.created_at);
      if (!Number.isFinite(since) || now - since < threshold) continue;
      const latest = await this.db.prepare(
        "SELECT status,error_code FROM watch_runs WHERE watch_binding_id=? ORDER BY started_at DESC LIMIT 1",
      ).bind(row.id).first<{ status: string; error_code: string | null }>();
      const days = Math.floor((now - since) / DAY_MS);
      findings.push({
        checkKey: "monitor_no_success",
        subjectKey: row.id,
        severity: "warning",
        sourceId: row.source_id,
        title: row.last_success_at
          ? `「${row.profile_name}」${days} 天没有成功抓取`
          : `「${row.profile_name}」创建 ${days} 天以来从未成功抓取`,
        detail: row.last_error_code
          ? `最近的错误：${row.last_error_code}${row.last_error_message ? `：${row.last_error_message.slice(0, 160)}` : ""}`
          : latest
            ? `最近一次运行是「${RUN_STATUS_LABELS[latest.status] ?? latest.status}」${latest.error_code ? `（${latest.error_code}）` : ""}，没有被记为失败，所以不会触发错误提醒。可能商品已下架，确认后可以关掉这个监控。`
            : "最近没有运行记录。",
      });
    }
    return findings;
  }

  /**
   * 来源突然全空：最近 2 天成功跑了至少 3 次、一条都没搜到，而之前一周有结果。
   * 解析器把改版后的页面误认成"没有结果"时，运行是"成功"的，错误提醒永远不会响。
   */
  private async checkSourcesAllEmpty(now: number): Promise<DetectedFinding[]> {
    const recent = iso(now - 2 * DAY_MS);
    const rows = await this.db.prepare(
      `SELECT b.source_id,
         COUNT(*) FILTER (WHERE r.started_at>=?) recent_runs,
         COALESCE(SUM(r.result_count) FILTER (WHERE r.started_at>=?),0) recent_items,
         COALESCE(SUM(r.result_count) FILTER (WHERE r.started_at<?),0) prior_items
       FROM watch_runs r JOIN watch_bindings b ON b.id=r.watch_binding_id
       WHERE r.status='success' AND r.started_at>=?
       GROUP BY b.source_id`,
    ).bind(recent, recent, recent, iso(now - 9 * DAY_MS)).all<{
      source_id: SourceId;
      recent_runs: number | string;
      recent_items: number | string;
      prior_items: number | string;
    }>();
    return rows.results
      .filter((row) => Number(row.recent_runs) >= 3 && Number(row.recent_items) === 0 && Number(row.prior_items) > 0)
      .map((row) => ({
        checkKey: "source_all_empty",
        subjectKey: row.source_id,
        severity: "critical" as const,
        sourceId: row.source_id,
        title: "最近 2 天搜到的商品全是 0 条",
        detail: `最近 2 天成功运行 ${Number(row.recent_runs)} 次，全部 0 条；之前一周共 ${Number(row.prior_items)} 条。可能是页面改版后被误认成"没有结果"。`,
      }));
  }

  /**
   * 来源"看不懂"：最近 2 天至少跑了 3 次，其中 ≥5% 是页面结构报错。
   * 结构报错 = 请求成功了、但页面和解析代码对不上，几乎总是对方改版——需要人去改适配器，
   * 等它自己好不了。判据与 `isParserFailureCode` 同一份（parser_structure_error / *_schema_changed）。
   * 近 14 天全来源 0 次（docs/研究/三种空与解析失败率-排查-20261011.md），所以响了就是真有事。
   */
  private async checkSourcesParseFailed(now: number): Promise<DetectedFinding[]> {
    const rows = await this.db.prepare(
      `SELECT b.source_id,
         COUNT(*) runs,
         COUNT(*) FILTER (WHERE r.error_code='parser_structure_error'
           OR r.error_code LIKE '%\\_schema\\_changed') parse_failed,
         MAX(r.error_message) FILTER (WHERE r.error_code='parser_structure_error'
           OR r.error_code LIKE '%\\_schema\\_changed') sample_message
       FROM watch_runs r JOIN watch_bindings b ON b.id=r.watch_binding_id
       WHERE r.status<>'skipped' AND r.started_at>=?
       GROUP BY b.source_id`,
    ).bind(iso(now - 2 * DAY_MS)).all<{
      source_id: SourceId;
      runs: number | string;
      parse_failed: number | string;
      sample_message: string | null;
    }>();
    return rows.results
      .filter((row) => Number(row.runs) >= 3 && Number(row.parse_failed) / Number(row.runs) >= 0.05)
      .map((row) => {
        const runs = Number(row.runs);
        const failed = Number(row.parse_failed);
        return {
          checkKey: "source_parse_failed",
          subjectKey: row.source_id,
          severity: "critical" as const,
          sourceId: row.source_id,
          title: "页面看不懂了，对方可能改版",
          detail: `最近 2 天运行 ${runs} 次，其中 ${failed} 次（${Math.round(failed / runs * 100)}%）页面结构对不上`
            + `${row.sample_message ? `，例如：${errorShape(row.sample_message)}` : ""}。需要按新页面修改这个来源的读取代码。`,
        };
      });
  }

  private async checkStaleDataStreams(now: number): Promise<DetectedFinding[]> {
    const row = await this.db.prepare(
      `SELECT
         (SELECT MAX(started_at) FROM watch_runs) watch_runs,
         (SELECT MAX(sent_at) FROM notice_deliveries WHERE channel='email' AND status='sent') email_sent,
         (SELECT MAX(completed_at) FROM gemini_jobs) ai_done,
         (SELECT MAX(processed_at) FROM analytics_outbox WHERE status='succeeded') analytics_sync,
         (SELECT MAX(observed_at) FROM host_disk_usage) disk`,
    ).first<Record<(typeof DATA_STREAMS)[number]["key"], string | null>>();
    const findings: DetectedFinding[] = [];
    for (const stream of DATA_STREAMS) {
      const value = row?.[stream.key] ?? null;
      const lastMs = value === null ? Number.NaN : Date.parse(value);
      if (Number.isFinite(lastMs) && now - lastMs <= stream.maxHours * HOUR_MS) continue;
      findings.push({
        checkKey: "data_stale",
        subjectKey: stream.key,
        severity: stream.severity,
        sourceId: null,
        title: Number.isFinite(lastMs)
          ? `${stream.label}已经 ${ageText(now - lastMs)}没有新数据`
          : `${stream.label}从来没有写入过数据`,
        detail: `${Number.isFinite(lastMs) ? `最后一条在 ${tokyoText(lastMs)}（东京时间）。` : ""}${stream.meaning}`,
      });
    }
    return findings;
  }

  private async checkDeadLetters(now: number): Promise<DetectedFinding[]> {
    const rows = await this.db.prepare(
      `SELECT message_type,last_error,COUNT(*) letters FROM queue_dead_letters
       WHERE last_dead_lettered_at>=? GROUP BY message_type,last_error`,
    ).bind(iso(now - DAY_MS)).all<{ message_type: string; last_error: string | null; letters: number | string }>();
    const grouped = new Map<string, { type: string; error: string; letters: number }>();
    for (const row of rows.results) {
      const error = errorShape(row.last_error);
      const key = `${row.message_type}:${error}`;
      const entry = grouped.get(key) ?? { type: row.message_type, error, letters: 0 };
      entry.letters += Number(row.letters);
      grouped.set(key, entry);
    }
    return [...grouped].map(([subjectKey, entry]) => ({
      checkKey: "dead_letters",
      subjectKey: subjectKey.slice(0, 200),
      severity: "warning" as const,
      sourceId: null,
      title: `队列死信 ${entry.letters} 条（${entry.type}）`,
      detail: entry.error || "没有错误信息。",
    }));
  }

  private async checkAiJudgement(now: number): Promise<DetectedFinding[]> {
    const [jobs, stuck] = await Promise.all([
      this.db.prepare(
        `SELECT COUNT(*) FILTER (WHERE status='failed') failed,COUNT(*) FILTER (WHERE status='partial') partial,
           MAX(last_error) last_error
         FROM gemini_jobs WHERE status IN ('failed','partial') AND updated_at>=?`,
      ).bind(iso(now - DAY_MS)).first<{ failed: number | string; partial: number | string; last_error: string | null }>(),
      // 超过 14 天的卡死候选已经没有补救价值，不再每周重复报。
      // 后面的轮次又抓到并判过的不算：抓取中途卡死或整轮被跳过时，已记下的条目会一直挂着
      // pending，但每小时巡回会重新抓到它们。2026-10-20 报的 223 条里 213 条早已判过。
      this.db.prepare(
        `SELECT COUNT(*) candidates,MIN(o.observed_at) oldest FROM watch_run_listing_observations o
         WHERE o.decision_status='pending' AND o.observed_at<? AND o.observed_at>=?
         AND NOT EXISTS (
           SELECT 1 FROM watch_run_listing_observations later
           WHERE later.watch_binding_id=o.watch_binding_id AND later.source_item_id=o.source_item_id
             AND later.observed_at>o.observed_at AND later.decision_status<>'pending'
         )`,
      ).bind(iso(now - 2 * DAY_MS), iso(now - 14 * DAY_MS)).first<{ candidates: number | string; oldest: string | null }>(),
    ]);
    const findings: DetectedFinding[] = [];
    const failed = Number(jobs?.failed ?? 0);
    const partial = Number(jobs?.partial ?? 0);
    if (failed + partial > 0) {
      findings.push({
        checkKey: "ai_judgement",
        subjectKey: "jobs_failed",
        severity: "warning",
        sourceId: null,
        title: `AI 判定任务 24 小时内失败 ${failed} 个、部分失败 ${partial} 个`,
        detail: jobs?.last_error ? `最近的错误：${jobs.last_error.slice(0, 200)}` : "没有错误信息。",
      });
    }
    const candidates = Number(stuck?.candidates ?? 0);
    if (candidates > 0) {
      findings.push({
        checkKey: "ai_judgement",
        subjectKey: "stuck_pending",
        severity: "warning",
        sourceId: null,
        title: `${candidates} 条候选卡在"待判定"超过 2 天，之后也没再判过`,
        detail: `最早一条在 ${stuck?.oldest ? tokyoText(stuck.oldest) : "未知时间"}。这些候选不会进日报，也不会再被判定。`,
      });
    }
    return findings;
  }

  /**
   * 关键词日报：条数突然暴涨（超过 200 且超过平时中位数 3 倍），以及补充信息
   * （定价 / 二手行情）失败或数据停更。补充数据来自对方每日同步，断了会静默变旧。
   */
  private async checkKeywordDigests(now: number): Promise<DetectedFinding[]> {
    const rows = await this.db.prepare(
      `SELECT e.watch_profile_id,p.name,e.created_at,
         (e.payload_json::jsonb->>'total') total,
         (e.payload_json::jsonb->'enrichment'->>'status') enrichment_status,
         (e.payload_json::jsonb->'enrichment'->>'dataAsOf') data_as_of,
         (e.payload_json::jsonb->'enrichment'->>'error') enrichment_error
       FROM events e JOIN watch_profiles p ON p.id=e.watch_profile_id
       WHERE e.event_type='daily_digest' AND p.dossier_kind='keyword' AND e.created_at>=?
       ORDER BY e.created_at`,
    ).bind(iso(now - 15 * DAY_MS)).all<{
      watch_profile_id: string;
      name: string;
      created_at: string;
      total: string | null;
      enrichment_status: string | null;
      data_as_of: string | null;
      enrichment_error: string | null;
    }>();
    const dayAgo = iso(now - DAY_MS);
    const findings: DetectedFinding[] = [];
    const byProfile = new Map<string, typeof rows.results>();
    for (const row of rows.results) {
      byProfile.set(row.watch_profile_id, [...byProfile.get(row.watch_profile_id) ?? [], row]);
    }
    for (const [profileId, digests] of byProfile) {
      const latest = digests[digests.length - 1]!;
      if (latest.created_at < dayAgo) continue;
      const total = Number(latest.total ?? 0);
      const usual = median(digests.slice(0, -1).map((digest) => Number(digest.total ?? 0)));
      if (total > Math.max(200, usual * 3)) {
        findings.push({
          checkKey: "keyword_digest",
          subjectKey: `spike:${profileId}`,
          severity: "warning",
          sourceId: null,
          title: `「${latest.name}」日报 ${total} 条，平时约 ${Math.round(usual)} 条`,
          detail: "可能是来源恢复后一次性补进了积压，或者关键词覆盖面变宽了。",
        });
      }
    }
    const recent = rows.results.filter((row) => row.created_at >= dayAgo);
    const failures = recent.filter((row) => row.enrichment_status === "failed");
    if (failures.length > 0) {
      findings.push({
        checkKey: "keyword_digest",
        subjectKey: "enrichment_failed",
        severity: "warning",
        sourceId: null,
        title: `日报补充信息（定价 / 二手行情）24 小时内失败 ${failures.length} 次`,
        detail: `最近的错误：${failures[failures.length - 1]!.enrichment_error?.slice(0, 200) ?? "没有错误信息"}`,
      });
    }
    const dataAsOf = rows.results
      .map((row) => row.data_as_of)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort()
      .at(-1);
    if (dataAsOf && now - Date.parse(dataAsOf) > 3 * DAY_MS) {
      findings.push({
        checkKey: "keyword_digest",
        subjectKey: "enrichment_stale",
        severity: "warning",
        sourceId: null,
        title: `二手行情数据已经 ${ageText(now - Date.parse(dataAsOf))}没有更新`,
        detail: `日报里的行情数据停在 ${tokyoText(dataAsOf)}（东京时间），对方的每日同步可能断了。`,
      });
    }
    return findings;
  }

  private async checkFailedEmails(now: number): Promise<DetectedFinding[]> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) emails,MAX(last_error) last_error FROM notice_deliveries
       WHERE channel='email' AND updated_at>=?
       AND (status='failed' OR (status='abandoned' AND COALESCE(last_error,'')<>'folded_into_digest'))`,
    ).bind(iso(now - DAY_MS)).first<{ emails: number | string; last_error: string | null }>();
    const emails = Number(row?.emails ?? 0);
    if (emails === 0) return [];
    return [{
      checkKey: "email_failed",
      subjectKey: "resend",
      severity: "critical",
      sourceId: null,
      title: `24 小时内有 ${emails} 封邮件发送失败`,
      detail: row?.last_error ? `最近的错误：${row.last_error.slice(0, 200)}` : "没有错误信息。",
    }];
  }

  private async checkDiskUsage(): Promise<DetectedFinding[]> {
    const rows = await this.db.prepare(
      `SELECT DISTINCT ON (host,mount) host,mount,observed_at,size_bytes,used_bytes
       FROM host_disk_usage ORDER BY host,mount,observed_at DESC`,
    ).all<{ host: string; mount: string; observed_at: string; size_bytes: number | string; used_bytes: number | string }>();
    const findings: DetectedFinding[] = [];
    for (const row of rows.results) {
      const size = Number(row.size_bytes);
      const used = Number(row.used_bytes);
      if (!(size > 0)) continue;
      const ratio = used / size;
      if (ratio < 0.8) continue;
      findings.push({
        checkKey: "disk_usage",
        subjectKey: `${row.host}:${row.mount}`,
        severity: ratio >= 0.9 ? "critical" : "warning",
        sourceId: null,
        title: `服务器磁盘已用 ${Math.round(ratio * 100)}%`,
        detail: `${row.host} 的 ${row.mount} 还剩 ${((size - used) / 1024 ** 3).toFixed(1)} GB（采样于 ${tokyoText(row.observed_at)}，东京时间）。`,
      });
    }
    return findings;
  }
}
