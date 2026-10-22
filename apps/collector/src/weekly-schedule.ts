/**
 * 每日体检每小时第 10 分钟尝试一次；当天（东京日期）已经跑完就直接跳过，
 * 所以实际是每天 00:10 JST 跑一次，失败了下一个小时自动补。
 * 周一 00:10 JST 的那一次早于 09:15 的周报，周报总能读到当天的结论。
 */
export function isHealthCheckTick(scheduledAt: string): boolean {
  return new Date(scheduledAt).getUTCMinutes() === 10;
}

/** Monday 09:15 in Tokyo (00:15 UTC), matching the worker's minute cron. */
export function isWeeklyMarketDigestTick(scheduledAt: string): boolean {
  const date = new Date(scheduledAt);
  return date.getUTCDay() === 1 && date.getUTCHours() === 0 && date.getUTCMinutes() === 15;
}
