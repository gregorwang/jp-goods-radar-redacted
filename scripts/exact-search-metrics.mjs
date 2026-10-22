/**
 * 精确搜索效果指标（计划 §13.4）。**只读**。
 *
 * 这是 P5 的量具。P1～P4 已于 2026-09-12 03:41Z 部署，但**逐查询覆盖与详情账本
 * 只有新搜索才会写**——历史任务重判补不出这两项。那两栏为空只说明部署后还没跑过
 * 搜索，不说明功能没生效。
 *
 * 每个指标都按 §13.4 的「正确口径」实现，并且刻意不提供那一列的「禁止口径」：
 *
 *   确认精度   只报分母（人工有据核对过多少条），不报比例。模型自评 high 不是正确，
 *              没有人工标签就没有精度可言——报一个算出来的数字等于编造。
 *   未决率     分候选证据不足 / 未调度 / 技术失败 / 能力缺失四类，不合成一个模糊总数。
 *   候选膨胀   逐查询新增、重复、强冲突，不看最终展示条数。
 *   查询覆盖   逐查询页数、游标、停止原因，不拿单一主查询的 total 代替全部。
 *   模型可靠性 契约通过、引用通过分别记，不算 JSON.parse 成功率。
 *
 * 用法：
 *   node scripts/exact-search-metrics.mjs              # 最近 7 天
 *   node scripts/exact-search-metrics.mjs 2026-09-10   # 指定起始日（JST）
 */
import { spawnSync } from "node:child_process";

const SSH_TARGET = process.env.JPGR_DB_SSH_TARGET ?? "root@203.0.113.10";
const PSQL = process.env.JPGR_PSQL_COMMAND ?? "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d jpgr";

const since = process.argv[2]
  ? `${process.argv[2]}T00:00:00+09:00`
  : new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

function run(label, sql) {
  const oneLine = sql.replace(/\s+/gu, " ").trim();
  const result = spawnSync("ssh", [SSH_TARGET, `${PSQL} -c ${JSON.stringify(oneLine)}`], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  process.stdout.write(`\n── ${label} ──\n`);
  process.stdout.write(result.status === 0 ? result.stdout : (result.stderr || "查询失败\n"));
}

process.stdout.write(`精确搜索指标基线　起始：${since}\n`);
process.stdout.write("逐查询覆盖与详情账本只由新搜索写入；为空 = 部署后还没跑过搜索，不是功能没生效。\n");

// 任务层：处理完成与覆盖完成是两件事（§9.3）。
run("任务处理与覆盖", `
  SELECT
    count(*) AS tasks,
    count(*) FILTER (WHERE status='completed') AS completed,
    count(*) FILTER (WHERE status='failed') AS failed,
    count(*) FILTER (WHERE result_summary_json::jsonb -> 'runQuality' ->> 'processing' = 'complete') AS processing_complete,
    count(*) FILTER (WHERE result_summary_json::jsonb -> 'runQuality' ->> 'processing' = 'partial') AS processing_partial,
    count(*) FILTER (WHERE result_summary_json::jsonb -> 'runQuality' ->> 'coverage' = 'partial') AS coverage_partial,
    count(*) FILTER (WHERE result_summary_json::jsonb -> 'runQuality' IS NULL) AS legacy_no_run_quality
  FROM radar_core.product_search_workflow_tasks
  WHERE created_at::timestamptz >= '${since}'
    AND plan_json::jsonb ->> 'mode' = 'exact_product'
`);

// 未决必须分得清「还没轮到」「模型坏了」「看过了但证据不够」（§13.4）。
run("未决率分解（按理由码）", `
  SELECT membership.evidence ->> 'reasonCode' AS reason_code,
         membership.decision,
         count(*) AS listings
  FROM radar_analytics.product_listing_memberships AS membership
  WHERE membership.is_current
    AND membership.created_at >= '${since}'
  GROUP BY 1,2
  ORDER BY listings DESC
  LIMIT 40
`);

// 候选膨胀要能解释回查询（§6.5）。逐查询新增、重复、强冲突。
run("候选膨胀（逐查询）", `
  SELECT coverage ->> 'purpose' AS purpose,
         count(*) AS queries,
         sum((coverage ->> 'rawReturned')::int) AS raw_returned,
         sum((coverage ->> 'uniqueNewListings')::int) AS unique_new,
         sum((coverage ->> 'duplicateListings')::int) AS duplicates,
         sum((coverage ->> 'hardConflictCount')::int) AS hard_conflicts
  FROM radar_core.product_search_workflow_results AS result,
       LATERAL jsonb_array_elements(COALESCE(result.group_json::jsonb -> 'queryCoverage','[]'::jsonb)) AS coverage
  WHERE result.completed_at::timestamptz >= '${since}'
  GROUP BY 1
  ORDER BY raw_returned DESC
`);

// exhausted 只表示这条查询的分页耗尽，不表示全网搜尽（§6.6）。
run("查询覆盖与停止原因", `
  SELECT coverage ->> 'stopReason' AS stop_reason,
         coverage ->> 'coverage' AS coverage_state,
         count(*) AS queries,
         count(*) FILTER (WHERE coverage ->> 'nextCursor' <> 'null') AS with_next_page
  FROM radar_core.product_search_workflow_results AS result,
       LATERAL jsonb_array_elements(COALESCE(result.group_json::jsonb -> 'queryCoverage','[]'::jsonb)) AS coverage
  WHERE result.completed_at::timestamptz >= '${since}'
  GROUP BY 1,2
  ORDER BY queries DESC
`);

// 详情调度：这次请求冲着解决什么去的，以及来源能力缺口（§6.8、§7.3）。
run("详情动作与来源能力", `
  SELECT result.source_id,
         sum(COALESCE((result.group_json::jsonb -> 'detailLedger' ->> 'requested')::int,0)) AS detail_requests,
         sum(jsonb_array_length(COALESCE(jsonb_path_query_array(result.group_json::jsonb,'$.detailLedger.resolved.*'),'[]'::jsonb))) AS resolved,
         sum(jsonb_array_length(COALESCE(jsonb_path_query_array(result.group_json::jsonb,'$.detailLedger.failed.*'),'[]'::jsonb))) AS failed,
         sum(jsonb_array_length(COALESCE(jsonb_path_query_array(result.group_json::jsonb,'$.detailLedger.unsupported.*'),'[]'::jsonb))) AS unsupported
  FROM radar_core.product_search_workflow_results AS result
  WHERE result.completed_at::timestamptz >= '${since}'
  GROUP BY 1
  HAVING sum(COALESCE((result.group_json::jsonb -> 'detailLedger' ->> 'requested')::int,0)) > 0
  ORDER BY detail_requests DESC
`);

// 模型可靠性：契约通过与引用通过分开记，不是 JSON.parse 成功率（§13.4）。
run("模型批次结果", `
  SELECT prompt_version,status,count(*) AS jobs,
         sum(completed_items) AS completed_items,
         sum(failed_items) AS failed_items
  FROM radar_core.gemini_jobs
  WHERE created_at::timestamptz >= '${since}'
    AND kind IN ('listing_enrichment','keyword_enrichment')
  GROUP BY 1,2
  ORDER BY jobs DESC
`);

// 确认精度只报分母。没有人工标签就没有精度——算一个数字出来等于编造（§13.2）。
run("可人工核对的确认（只报分母，不报精度）", `
  SELECT membership.membership_version,
         count(*) FILTER (WHERE membership.decision='confirmed') AS confirmed,
         count(*) FILTER (WHERE membership.decision='confirmed'
           AND membership.decision_source='human') AS human_reviewed,
         count(*) FILTER (WHERE membership.decision='confirmed'
           AND membership.evidence ->> 'reasonCode' = 'identifier_match') AS by_identifier,
         count(*) FILTER (WHERE membership.decision='confirmed'
           AND membership.evidence ->> 'reasonCode' = 'semantic_same_product') AS by_cited_semantics
  FROM radar_analytics.product_listing_memberships AS membership
  WHERE membership.is_current AND membership.created_at >= '${since}'
  GROUP BY 1
  ORDER BY confirmed DESC
`);

process.stdout.write("\n以上为只读统计。精度、误拒这两项需要人工标签，脚本不会替你算——");
process.stdout.write("没有标签时正确的做法是标注「无法建立标签」，不是凑一个数字出来（§13.2）。\n");
