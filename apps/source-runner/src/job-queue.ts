import type { EmbeddedUpstreamResponseCapture } from "@jpgr/core";
import type { CreateJobBody } from "./schemas";
import type { RunnerExecutionOutcome, RunnerJobError, RunnerJobResult } from "./execution";

/**
 * 执行池。曾经整台 runner 只有一个执行槽，一个 AmiAmi 任务在跑时，煤炉、骏河屋、
 * 雅虎全都在后面干等——而它们只是发个普通 HTTP 请求，几乎零成本。
 *
 * - `heavy`：每次请求都 execFile 起一个 Python 进程（curl_cffi 指纹模拟），
 *   单进程几十到上百 MB，受 systemd 的 MemoryMax=1700M 约束，必须严格限并发。
 * - `http`：纯 fetch，等的是网络不是 CPU。按 1000 档案的规模估算整机也就每秒
 *   一个请求量级，这个池宽松得多。
 */
export type RunnerPoolId = "heavy" | "http";

export interface RunnerPoolLimits {
  /** 同时执行上限。 */
  concurrency: number;
  /** 排队 + 执行的总量上限；超过即对该池返回 queue_full，不影响其他池。 */
  queueDepth: number;
}

export const DEFAULT_POOL_LIMITS: Readonly<Record<RunnerPoolId, RunnerPoolLimits>> = {
  heavy: { concurrency: 2, queueDepth: 8 },
  http: { concurrency: 24, queueDepth: 64 },
};

/** AmiAmi 是目前唯一走子进程传输的来源（见 amiami-fetch.ts）。 */
export function poolForTask(task: CreateJobBody): RunnerPoolId {
  return task.sourceId === "amiami" ? "heavy" : "http";
}

const DEFAULT_TERMINAL_TTL_MS = 10 * 60 * 1_000;
/**
 * 执行器自身的预算是 JOB_TIMEOUT_MS（100s），但那只是一个 AbortSignal：它取消的是
 * 认这个信号的 fetch，而收尾（Playwright 浏览器关闭等）不受它约束。收尾一挂住，
 * 执行器的 promise 就永远不落地，占住的执行槽再也不释放。串行时代这意味着整台
 * runner 从此对所有来源返回 queue_full，且不打任何日志——生产上真的发生过一次，
 * 静默锁死 5 小时。这里给执行器一个硬上界：超过就判这一单失败并继续排空队列。
 *
 * 分池之后这个故障的影响面小了很多（挂住的只是所在池的一个槽），但看门狗仍然
 * 必须保留：没有它，同一个池被逐个耗尽仍然只是时间问题。
 */
const DEFAULT_JOB_WATCHDOG_MS = 150 * 1_000;

export type RunnerJobStatus = "queued" | "running" | "succeeded" | "failed";

interface RunnerJobBase {
  jobId: string;
  task: CreateJobBody;
  pool: RunnerPoolId;
  createdAt: string;
}

type RunnerJobRecord =
  | RunnerJobBase & { status: "queued" }
  | RunnerJobBase & { status: "running"; startedAt: string }
  | RunnerJobBase & {
      status: "succeeded";
      startedAt: string;
      finishedAt: string;
      expiresAt: number;
      result: RunnerJobResult;
      captures: readonly EmbeddedUpstreamResponseCapture[];
    }
  | RunnerJobBase & {
      status: "failed";
      startedAt: string;
      finishedAt: string;
      expiresAt: number;
      error: RunnerJobError;
      captures: readonly EmbeddedUpstreamResponseCapture[];
    };

export type RunnerJobSnapshot =
  | { jobId: string; status: "queued"; createdAt: string }
  | { jobId: string; status: "running"; createdAt: string; startedAt: string }
  | {
      jobId: string;
      status: "succeeded";
      createdAt: string;
      startedAt: string;
      finishedAt: string;
      result: RunnerJobResult;
      captures: readonly EmbeddedUpstreamResponseCapture[];
    }
  | {
      jobId: string;
      status: "failed";
      createdAt: string;
      startedAt: string;
      finishedAt: string;
      error: RunnerJobError;
      captures: readonly EmbeddedUpstreamResponseCapture[];
    };

export interface RunnerPoolHealth extends RunnerPoolLimits {
  queued: number;
  running: number;
}

export interface RunnerQueueHealth {
  accepting: boolean;
  queued: number;
  running: number;
  retained: number;
  pools: Record<RunnerPoolId, RunnerPoolHealth>;
}

type Executor = (task: CreateJobBody) => Promise<RunnerExecutionOutcome>;

export type EnqueueResult =
  | { ok: true; job: RunnerJobSnapshot }
  | { ok: false; code: "queue_full" | "queue_stopping" };

function snapshot(record: RunnerJobRecord): RunnerJobSnapshot {
  if (record.status === "queued") {
    return { jobId: record.jobId, status: record.status, createdAt: record.createdAt };
  }
  if (record.status === "running") {
    return { jobId: record.jobId, status: record.status, createdAt: record.createdAt, startedAt: record.startedAt };
  }
  if (record.status === "succeeded") {
    return {
      jobId: record.jobId,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      result: record.result,
      captures: record.captures,
    };
  }
  return {
    jobId: record.jobId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    captures: record.captures,
  };
}

function unexpectedFailure(error: unknown): RunnerExecutionOutcome {
  return {
    ok: false,
    error: {
      code: "source_runner_unhandled_failure",
      message: error instanceof Error ? error.message.slice(0, 500) : "来源任务发生未处理错误",
      upstreamStatus: 500,
      retryable: true,
      retryAfterSeconds: null,
    },
    captures: [],
  };
}

export class PooledJobQueue {
  readonly #jobs = new Map<string, RunnerJobRecord>();
  /** 全局 FIFO；启动时按池的余量跳过排不进去的任务，所以满池不会挡住别的池。 */
  readonly #pending: string[] = [];
  readonly #running = new Set<string>();
  /** #pump 的内层判断在热路径上，别让它每次都去遍历 #running。 */
  readonly #runningByPool: Record<RunnerPoolId, number> = { heavy: 0, http: 0 };
  readonly #executor: Executor;
  readonly #limits: Record<RunnerPoolId, RunnerPoolLimits>;
  readonly #terminalTtlMs: number;
  readonly #jobWatchdogMs: number;
  #accepting = true;
  #pumping = false;
  #idleWaiters: Array<() => void> = [];

  constructor(
    executor: Executor,
    options: {
      pools?: Partial<Record<RunnerPoolId, Partial<RunnerPoolLimits>>>;
      terminalTtlMs?: number;
      jobWatchdogMs?: number;
    } = {},
  ) {
    this.#executor = executor;
    this.#limits = {
      heavy: { ...DEFAULT_POOL_LIMITS.heavy, ...options.pools?.heavy },
      http: { ...DEFAULT_POOL_LIMITS.http, ...options.pools?.http },
    };
    this.#terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.#jobWatchdogMs = options.jobWatchdogMs ?? DEFAULT_JOB_WATCHDOG_MS;
  }

  enqueue(task: CreateJobBody): EnqueueResult {
    this.#prune();
    if (!this.#accepting) return { ok: false, code: "queue_stopping" };
    const pool = poolForTask(task);
    if (this.#occupancy(pool) >= this.#limits[pool].queueDepth) return { ok: false, code: "queue_full" };
    const jobId = crypto.randomUUID();
    const record: RunnerJobRecord = {
      jobId,
      task,
      pool,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.#jobs.set(jobId, record);
    this.#pending.push(jobId);
    this.#pump();
    return { ok: true, job: snapshot(record) };
  }

  get(jobId: string): RunnerJobSnapshot | undefined {
    this.#prune();
    const record = this.#jobs.get(jobId);
    return record ? snapshot(record) : undefined;
  }

  health(): RunnerQueueHealth {
    this.#prune();
    const pools = {} as Record<RunnerPoolId, RunnerPoolHealth>;
    for (const pool of Object.keys(this.#limits) as RunnerPoolId[]) {
      pools[pool] = {
        ...this.#limits[pool],
        queued: this.#countPending(pool),
        running: this.#countRunning(pool),
      };
    }
    return {
      accepting: this.#accepting,
      queued: this.#pending.length,
      running: this.#running.size,
      retained: this.#jobs.size,
      pools,
    };
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async onIdle(timeoutMs = 20_000): Promise<boolean> {
    if (this.#isIdle()) return true;
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#idleWaiters = this.#idleWaiters.filter((candidate) => candidate !== waiter);
        resolve(false);
      }, timeoutMs);
      this.#idleWaiters.push(waiter);
    });
  }

  #isIdle(): boolean {
    return this.#running.size === 0 && this.#pending.length === 0;
  }

  #countRunning(pool: RunnerPoolId): number {
    return this.#runningByPool[pool];
  }

  #countPending(pool: RunnerPoolId): number {
    let total = 0;
    for (const jobId of this.#pending) if (this.#jobs.get(jobId)?.pool === pool) total += 1;
    return total;
  }

  /** 排队 + 执行的总量，就是 queueDepth 约束的对象。 */
  #occupancy(pool: RunnerPoolId): number {
    return this.#countPending(pool) + this.#countRunning(pool);
  }

  async #withWatchdog(jobId: string, execution: Promise<RunnerExecutionOutcome>): Promise<RunnerExecutionOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<RunnerExecutionOutcome>((resolve) => {
      timer = setTimeout(() => {
        console.warn(JSON.stringify({
          event: "source_runner_job_watchdog_expired",
          watchdogMs: this.#jobWatchdogMs,
          jobId,
          pool: this.#jobs.get(jobId)?.pool,
        }));
        resolve(unexpectedFailure(new Error(`采集任务超过 ${this.#jobWatchdogMs}ms 未返回，已放弃等待`)));
      }, this.#jobWatchdogMs);
    });
    try {
      // 被放弃的 promise 仍可能在之后 reject，不接住会变成未处理拒绝。
      execution.catch(() => undefined);
      return await Promise.race([execution, watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 同步扫一遍待办，把所有池里还有余量的任务启动起来。
   *
   * 关键在于它是「跳过」而不是「停下」：某个池满了，后面属于别的池的任务照样能
   * 起跑。这正是串行时代 AmiAmi 会连带阻塞煤炉、骏河屋、雅虎的那个问题。
   * 池内仍然严格 FIFO。
   */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const index = this.#pending.findIndex((jobId) => {
          const record = this.#jobs.get(jobId);
          if (!record || record.status !== "queued") return true; // 顺手清掉陈迹
          return this.#countRunning(record.pool) < this.#limits[record.pool].concurrency;
        });
        if (index === -1) break;
        const jobId = this.#pending.splice(index, 1)[0];
        if (!jobId) break;
        const queued = this.#jobs.get(jobId);
        if (!queued || queued.status !== "queued") continue;
        this.#start(jobId, queued);
      }
    } finally {
      this.#pumping = false;
    }
    if (this.#isIdle()) this.#releaseIdleWaiters();
  }

  #start(jobId: string, queued: RunnerJobRecord & { status: "queued" }): void {
    const startedAt = new Date().toISOString();
    const running: RunnerJobRecord = { ...queued, status: "running", startedAt };
    this.#jobs.set(jobId, running);
    this.#running.add(jobId);
    this.#runningByPool[running.pool] += 1;
    void this.#run(jobId, running);
  }

  async #run(jobId: string, running: RunnerJobRecord & { status: "running" }): Promise<void> {
    let outcome: RunnerExecutionOutcome;
    try {
      // 放弃的任务可能还挂在后台，但队列必须继续排空：宁可让一单被判超时，
      // 也不能让它把所在池的槽位永久占死。
      outcome = await this.#withWatchdog(jobId, this.#executor(running.task));
    } catch (error) {
      outcome = unexpectedFailure(error);
    }
    const finishedAt = new Date().toISOString();
    const expiresAt = Date.now() + this.#terminalTtlMs;
    this.#jobs.set(jobId, outcome.ok
      ? { ...running, status: "succeeded", finishedAt, expiresAt, result: outcome.result, captures: outcome.captures }
      : { ...running, status: "failed", finishedAt, expiresAt, error: outcome.error, captures: outcome.captures });
    this.#running.delete(jobId);
    this.#runningByPool[running.pool] -= 1;
    // 腾出一个槽，看看有没有任务能补上；#pump 结束时会处理 idle 通知。
    this.#pump();
  }

  #releaseIdleWaiters(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  #prune(now = Date.now()): void {
    for (const [jobId, record] of this.#jobs) {
      if ((record.status === "succeeded" || record.status === "failed") && record.expiresAt <= now) {
        this.#jobs.delete(jobId);
      }
    }
  }
}
