import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { CreateJobBody } from "./schemas";
import { createJobBodySchema } from "./schemas";
import type { RunnerExecutionOutcome } from "./execution";
import { executeRunnerTask } from "./execution";
import { SOURCE_RUNNER_SEARCH_IDS, type SourceRunnerSearchId } from "./source-policy";

const goldenExpectationSchema = z.object({
  minResultCount: z.number().int().min(0).max(120).default(1),
  parserVersionPrefix: z.string().trim().min(1).max(120).optional(),
}).strict();

const goldenCaseSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  task: z.unknown(),
  expect: goldenExpectationSchema,
}).strict();

const goldenSuiteSchema = z.object({
  schema: z.literal(1),
  sources: z.partialRecord(
    z.enum(SOURCE_RUNNER_SEARCH_IDS),
    z.array(goldenCaseSchema).min(1).max(5),
  ),
}).strict();

export interface GoldenRegressionCase {
  name: string;
  task: CreateJobBody & { operation: "search" };
  expect: {
    minResultCount: number;
    parserVersionPrefix?: string;
  };
}

export interface GoldenRegressionCaseResult {
  name: string;
  ok: boolean;
  elapsedMs: number;
  result?: {
    resultCount: number;
    parserVersion: string;
    fetchedAt: string;
  };
  error?: {
    code: string;
    message: string;
    upstreamStatus: number | null;
  };
}

export interface GoldenRegressionResult {
  ok: boolean;
  sourceId: SourceRunnerSearchId;
  caseCount: number;
  passed: number;
  failed: number;
  cases: GoldenRegressionCaseResult[];
  error?: "golden_regression_failed";
}

type RunnerExecutor = (task: CreateJobBody) => Promise<RunnerExecutionOutcome>;

export function parseGoldenSuite(value: unknown, sourceId: SourceRunnerSearchId): GoldenRegressionCase[] {
  const parsed = goldenSuiteSchema.parse(value);
  const cases = parsed.sources[sourceId];
  if (!cases) throw new Error(`golden_source_not_provisioned:${sourceId}`);
  return cases.map((candidate): GoldenRegressionCase => {
    const task = createJobBodySchema.parse(candidate.task);
    if (task.sourceId !== sourceId || task.operation !== "search") {
      throw new Error(`golden_task_scope_rejected:${candidate.name}`);
    }
    return {
      name: candidate.name,
      task,
      expect: candidate.expect,
    };
  });
}

export async function loadGoldenSuite(path: string, sourceId: SourceRunnerSearchId): Promise<GoldenRegressionCase[]> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 256_000) throw new Error("golden_suite_file_invalid");
  return parseGoldenSuite(JSON.parse(await readFile(path, "utf8")), sourceId);
}

export async function runGoldenRegression(
  sourceId: SourceRunnerSearchId,
  cases: readonly GoldenRegressionCase[],
  executor: RunnerExecutor = executeRunnerTask,
): Promise<GoldenRegressionResult> {
  const results: GoldenRegressionCaseResult[] = [];
  for (const goldenCase of cases) {
    const startedAt = Date.now();
    try {
      const outcome = await executor(goldenCase.task);
      const elapsedMs = Date.now() - startedAt;
      if (!outcome.ok) {
        results.push({
          name: goldenCase.name,
          ok: false,
          elapsedMs,
          error: {
            code: outcome.error.code,
            message: outcome.error.message.slice(0, 500),
            upstreamStatus: outcome.error.upstreamStatus,
          },
        });
        continue;
      }
      if (!("listings" in outcome.result)) {
        results.push({
          name: goldenCase.name,
          ok: false,
          elapsedMs,
          error: {
            code: "golden_search_result_required",
            message: "黄金回归任务没有返回搜索结果",
            upstreamStatus: null,
          },
        });
        continue;
      }
      const resultCount = outcome.result.listings.length;
      const parserVersion = outcome.result.parserVersion;
      const countMatches = resultCount >= goldenCase.expect.minResultCount;
      const parserMatches = goldenCase.expect.parserVersionPrefix === undefined
        || parserVersion.startsWith(goldenCase.expect.parserVersionPrefix);
      results.push({
        name: goldenCase.name,
        ok: countMatches && parserMatches,
        elapsedMs,
        result: {
          resultCount,
          parserVersion,
          fetchedAt: outcome.result.fetchedAt,
        },
        ...(!countMatches
          ? {
              error: {
                code: "golden_result_count_below_minimum",
                message: `期望至少 ${goldenCase.expect.minResultCount} 条结果，实际 ${resultCount} 条`,
                upstreamStatus: null,
              },
            }
          : !parserMatches
            ? {
                error: {
                  code: "golden_parser_version_mismatch",
                  message: "解析器版本不符合黄金任务约束",
                  upstreamStatus: null,
                },
              }
            : {}),
      });
    } catch (error) {
      results.push({
        name: goldenCase.name,
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: {
          code: "golden_task_exception",
          message: error instanceof Error ? error.message.slice(0, 500) : "黄金任务发生未知异常",
          upstreamStatus: null,
        },
      });
    }
  }
  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    sourceId,
    caseCount: results.length,
    passed,
    failed,
    cases: results,
    ...(failed > 0 ? { error: "golden_regression_failed" as const } : {}),
  };
}
