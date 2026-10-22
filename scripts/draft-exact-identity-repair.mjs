/**
 * 定向重判草案（计划 §10.4）。**只读**。
 *
 * 拿冻结的历史任务（默认是 2026-09-10 的 T5、T6），用当前代码里的判定规则重算一遍，
 * 和旧规则的判定逐条对比，输出差异报告。
 *
 * 为什么默认只读、也没有 `--apply`：
 *
 *   P1～P3 的代码还没部署。此刻往库里写新版判定，等于让 v5 的判定和线上仍在产出的
 *   v4 判定同时争 `is_current` —— 计划 §14.2 明令禁止「两个版本同时竞争」。正确顺序
 *   是先部署、再迁移。这个脚本的用途是**在部署前先看清影响**：哪些拒绝会变成未决、
 *   哪些未决会变成确认、有没有确认被收回。
 *
 * 迁移本身（写 is_current / valid_to / supersedes_membership_id）是部署之后的独立
 * 一步，要单独实现并单独审查，不放在这里顺手做掉。
 *
 * 用法：
 *   node scripts/draft-exact-identity-repair.mjs
 *   node scripts/draft-exact-identity-repair.mjs <taskId> [<taskId> ...]
 */
import { spawnSync } from "node:child_process";
import { exactProductIdentityDecision } from "../apps/collector/src/exact-identity-decision.ts";
import { assessProductMatch, buildProductMatchCorpus } from "../packages/core/src/product-search.ts";

const SSH_TARGET = process.env.JPGR_DB_SSH_TARGET ?? "root@203.0.113.10";
const PSQL = process.env.JPGR_PSQL_COMMAND ?? "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d jpgr";

/** 2026-09-10 的 T5（徽章混款）与 T6（A3 复制画）。计划 §17.3 指定的首批范围。 */
const DEFAULT_TASK_IDS = [
  "84d2e85e-d203-4ed6-bf35-2fa456440bcd",
  "19667c6b-5605-407a-895e-0ddc0c784a61",
];

function parsed(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * 每行只取**一列 JSON**。
 *
 * 不用多列 + 分隔符：商品标题里什么字符都可能有，而 psql 的 -F 又不接受转义序列
 * （写 -F'\t' 传过去的是反斜杠加 t 两个字符，不是制表符，于是每一行都切不开）。
 * 一列 JSON 就没有分隔符这回事了。
 */
function queryJson(sql) {
  // SQL 必须压成一行：JSON.stringify 会把换行变成两个字符的转义序列，远端 shell
  // 不解释它，psql 拿到的就是一个反斜杠，直接语法错误。
  const oneLine = sql.replace(/\s+/gu, " ").trim();
  const result = spawnSync("ssh", [SSH_TARGET, `${PSQL} -t -A -c ${JSON.stringify(oneLine)}`], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "psql 查询失败\n");
    process.exit(1);
  }
  return result.stdout.split("\n").filter((line) => line.trim()).flatMap((line) => {
    const value = parsed(line);
    return value === undefined ? [] : [value];
  });
}

/** 旧版 `exactProductIdentityDecision` 的判定，仅用于生成对比基线。 */
function legacyDecision(relation, output) {
  if (relation === "exact") return "confirmed";
  if (relation === "variant" || relation === "bundle" || relation === "irrelevant") return "rejected";
  const relevance = output?.relevance;
  const confidence = output?.confidence === "high" || output?.confidence === "medium" ? output.confidence : "low";
  if (relation === "related") {
    if (relevance === "relevant") return "uncertain";
    return "rejected";
  }
  if (relation !== "probable_exact") {
    if (relevance === "irrelevant" && confidence === "high") return "rejected";
    return "uncertain";
  }
  if (relevance === "relevant") {
    const multiple = Array.isArray(output?.includedItems) && output.includedItems.length > 1;
    const missing = Array.isArray(output?.missingParts) && output.missingParts.length > 0;
    return confidence === "high" && !multiple && !missing ? "confirmed" : "uncertain";
  }
  if (relevance === "irrelevant") return "rejected";
  return "uncertain";
}

const taskIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TASK_IDS;
const idList = taskIds.map((id) => `'${id.replace(/'/gu, "''")}'`).join(",");

const tasks = queryJson(
  `SELECT json_build_object('id',id,'manifest',COALESCE(ai_manifest_json,'{}')::json,'plan',plan_json::json)::text
   FROM radar_core.product_search_workflow_tasks WHERE id IN (${idList})`,
);
const planByTask = new Map(tasks.map((row) => [row.id, row.plan ?? {}]));
const groups = queryJson(
  `SELECT json_build_object('taskId',task_id,'sourceId',source_id,'group',group_json::json)::text
   FROM radar_core.product_search_workflow_results WHERE task_id IN (${idList})`,
);

const manifestByTask = new Map(tasks.map((row) => [row.id, row.manifest ?? {}]));
const groupsByTask = new Map();
for (const row of groups) {
  if (!row.group) continue;
  groupsByTask.set(row.taskId, [...(groupsByTask.get(row.taskId) ?? []), row.group]);
}

for (const taskId of taskIds) {
  const manifest = manifestByTask.get(taskId) ?? {};
  const outcomes = new Map();
  for (const [index, key] of (manifest.candidateKeys ?? []).entries()) {
    const state = manifest.settledStates?.[index];
    const item = manifest.settledItems?.[index] ?? undefined;
    outcomes.set(key, state === "ready" && item
      ? { output: item, status: "ready" }
      : { status: state === "failed" ? "contract_error" : "missing" });
  }
  const transitions = new Map();
  const reasonCodes = new Map();
  let evaluated = 0;
  let reviewed = 0;
  // 匹配必须用**当前代码**重算，不能回放库里存的那份。
  // 存的是旧匹配器的输出，里面没有新增的差异维度（比如候选多出来的版本标记），
  // 直接拿来用会把新规则量成“没效果”。目标指纹仍然用当时冻结的那份。
  const target = manifest.__target ?? planByTask.get(taskId)?.target;
  for (const group of groupsByTask.get(taskId) ?? []) {
    const corpus = target ? buildProductMatchCorpus(group.listings ?? [], target) : undefined;
    for (const listing of group.listings ?? []) {
      const stored = group.candidateEvidence?.[listing.sourceItemId];
      if (!stored?.match) continue;
      const match = target
        ? assessProductMatch(listing, target, stored.hits ?? [], corpus)
        : stored.match;
      evaluated += 1;
      const outcome = outcomes.get(`${listing.sourceId}:${listing.sourceItemId}`);
      if (outcome?.status === "ready") reviewed += 1;
      const legacy = legacyDecision(match.relation, outcome?.output);
      const next = exactProductIdentityDecision({
        relation: match.relation,
        ...(outcome?.output ? { output: outcome.output } : {}),
        match: {
          ...(match.difference ? { difference: match.difference } : {}),
          conflicts: match.conflicts,
          matchedFields: match.matchedFields,
        },
        aiItemStatus: outcome?.status ?? "not_executed",
      });
      const transition = `${legacy} → ${next.decision}`;
      transitions.set(transition, (transitions.get(transition) ?? 0) + 1);
      reasonCodes.set(next.reasonCode, (reasonCodes.get(next.reasonCode) ?? 0) + 1);
    }
  }
  process.stdout.write(`\n任务 ${taskId}\n`);
  process.stdout.write(`  可重算候选：${evaluated}（其中模型给出有效表态的：${reviewed}）\n`);
  process.stdout.write("  判定迁移（旧 → 新）：\n");
  for (const [transition, count] of [...transitions].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${transition.padEnd(26)} ${count}\n`);
  }
  process.stdout.write("  新判定理由码分布：\n");
  for (const [code, count] of [...reasonCodes].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${code.padEnd(32)} ${count}\n`);
  }
}
process.stdout.write("\n这是只读草案，没有写入任何一行。迁移是部署之后的独立一步。\n");
