import type { SourceId } from "@jpgr/core";

/**
 * 必须保持全局串行的来源。
 *
 * 乐天的调用节拍器（`request-pacer.ts`）只在单次 Worker 执行内共享。多个消费者并发
 * 时，每个实例都以为自己独占应用配额并同时打出首个请求——2026-09-05 那次 429 就是
 * 这么来的（当天 1.06 秒的间隔被拒，0.27 秒的却是 200，说明配额之外还叠了出口维度）。
 *
 * 把这些来源单独送进 `max_concurrency: 1` 的队列，其余来源才能安全地并发消费。等到
 * 有了跨实例共享的限流（发号器），这张表可以缩短甚至清空；在那之前，宁可保守。
 */
const SERIAL_MONITOR_SOURCE_IDS = ["rakuten_ichiba", "rakuten_books"] as const satisfies readonly SourceId[];

export function requiresSerialMonitorQueue(sourceId: SourceId): boolean {
  return (SERIAL_MONITOR_SOURCE_IDS as readonly SourceId[]).includes(sourceId);
}

interface MonitorQueueBindings {
  MONITOR_QUEUE: Queue;
  MONITOR_SERIAL_QUEUE: Queue;
}

/**
 * 选择这条任务该进哪条队列。
 *
 * `sourceId` 为空时取串行队列：调用方拿不到来源（例如手动 `/internal/run/` 只有
 * bindingId）时，慢一点永远比把某个来源打到限流安全。不打上游的任务（分析入库、
 * 关键词摘要收尾）本来就不受来源节拍约束，调用方直接用 `MONITOR_QUEUE` 即可，
 * 不必经过这里。
 */
export function monitorQueueFor(env: MonitorQueueBindings, sourceId: SourceId | null | undefined): Queue {
  if (!sourceId) return env.MONITOR_SERIAL_QUEUE;
  return requiresSerialMonitorQueue(sourceId) ? env.MONITOR_SERIAL_QUEUE : env.MONITOR_QUEUE;
}
