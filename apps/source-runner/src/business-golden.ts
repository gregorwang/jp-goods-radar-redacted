import { isAbsolute } from "node:path";
import { loadGoldenSuite, runGoldenRegression } from "./golden-regression";
import { SOURCE_RUNNER_SEARCH_IDS } from "./source-policy";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  const sourceId = SOURCE_RUNNER_SEARCH_IDS.find((candidate) => candidate === process.argv[2]);
  const suitePath = process.argv[3]
    ?? process.env.EMT_SRE_GOLDEN_TASKS
    ?? "/var/lib/jpgr-source-runner/business-repair/golden-tasks.json";
  if (!sourceId) {
    emit({ ok: false, error: "golden_source_id_rejected" });
    return 2;
  }
  if (!isAbsolute(suitePath)) {
    emit({ ok: false, error: "golden_suite_path_must_be_absolute" });
    return 2;
  }
  try {
    const cases = await loadGoldenSuite(suitePath, sourceId);
    const result = await runGoldenRegression(sourceId, cases);
    emit(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    emit({
      ok: false,
      sourceId,
      error: error instanceof Error ? error.message.slice(0, 500) : "golden_regression_failed",
    });
    return 2;
  }
}

process.exitCode = await main();
