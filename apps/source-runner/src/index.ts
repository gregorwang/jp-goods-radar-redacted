import { BusinessRepairStore, executeWithBusinessRepair } from "./business-repair";
import { executeRunnerTask } from "./execution";
import { DEFAULT_POOL_LIMITS, PooledJobQueue } from "./job-queue";
import { createSourceRunnerServer } from "./server";

function configuredInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = configuredInteger(process.env.PORT, 8788, 1, 65_535);
// 两个池分别配置。上限刻意留得比默认值高，方便临时上调而不用改代码；
// 真正的约束是 systemd 的 MemoryMax/CPUQuota，heavy 池尤其不要随手放大。
const pools = {
  heavy: {
    concurrency: configuredInteger(process.env.HEAVY_POOL_CONCURRENCY, DEFAULT_POOL_LIMITS.heavy.concurrency, 1, 8),
    queueDepth: configuredInteger(process.env.HEAVY_POOL_QUEUE_DEPTH, DEFAULT_POOL_LIMITS.heavy.queueDepth, 1, 64),
  },
  http: {
    concurrency: configuredInteger(process.env.HTTP_POOL_CONCURRENCY, DEFAULT_POOL_LIMITS.http.concurrency, 1, 128),
    queueDepth: configuredInteger(process.env.HTTP_POOL_QUEUE_DEPTH, DEFAULT_POOL_LIMITS.http.queueDepth, 1, 512),
  },
};
const businessRepair = new BusinessRepairStore(process.env.BUSINESS_REPAIR_DIR);
const queue = new PooledJobQueue(
  (task) => executeWithBusinessRepair(businessRepair, task, executeRunnerTask),
  { pools },
);
const { server } = createSourceRunnerServer({ queue, pools });

server.listen(port, host, () => {
  console.info(JSON.stringify({
    event: "source_runner_started",
    host,
    port,
    pools,
    businessRepairEnabled: businessRepair.enabled,
  }));
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: "source_runner_stopping", signal }));
  queue.stopAccepting();
  server.close();
  const idle = await queue.onIdle(20_000);
  console.info(JSON.stringify({ event: "source_runner_stopped", idle }));
  process.exit(idle ? 0 : 1);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
