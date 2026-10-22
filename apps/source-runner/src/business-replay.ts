import { BusinessRepairStore, boundedIncidentCaptures } from "./business-repair";
import { executeRunnerTask } from "./execution";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  const incidentPath = process.argv[2];
  if (!incidentPath) {
    emit({ ok: false, error: "business_repair_incident_required" });
    return 2;
  }
  const store = new BusinessRepairStore(
    process.env.BUSINESS_REPAIR_DIR ?? "/var/lib/jpgr-source-runner/business-repair",
  );
  try {
    const task = await store.readIncidentTask(incidentPath);
    const outcome = await executeRunnerTask(task);
    if (!outcome.ok) {
      emit({
        ok: false,
        sourceId: task.sourceId,
        operation: task.operation,
        error: outcome.error,
        captures: boundedIncidentCaptures(outcome.captures),
      });
      return 1;
    }
    const result = outcome.result;
    emit({
      ok: true,
      sourceId: task.sourceId,
      operation: task.operation,
      result: "listings" in result
        ? {
            resultCount: result.listings.length,
            parserVersion: result.parserVersion,
            fetchedAt: result.fetchedAt,
          }
        : {
            sourceItemId: result.sourceItemId,
            availability: result.availability,
            sourceUpdatedAt: result.sourceUpdatedAt,
          },
    });
    return 0;
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "business_replay_failed",
    });
    return 2;
  }
}

process.exitCode = await main();
