export interface StrongReminderPolicy {
  enabled: boolean;
  intervalMinutes: number;
  repeatCount: number;
}

export const DEFAULT_STRONG_REMINDER_INTERVAL_MINUTES = 20;
export const DEFAULT_STRONG_REMINDER_REPEAT_COUNT = 3;

export function strongReminderPolicyFromSourceConfig(
  sourceConfig: Record<string, unknown>,
): StrongReminderPolicy {
  const raw = sourceConfig.strongReminder;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      enabled: false,
      intervalMinutes: DEFAULT_STRONG_REMINDER_INTERVAL_MINUTES,
      repeatCount: DEFAULT_STRONG_REMINDER_REPEAT_COUNT,
    };
  }
  const value = raw as Record<string, unknown>;
  const interval = typeof value.intervalMinutes === "number" && Number.isInteger(value.intervalMinutes)
    ? Math.max(5, Math.min(120, value.intervalMinutes))
    : DEFAULT_STRONG_REMINDER_INTERVAL_MINUTES;
  const count = typeof value.repeatCount === "number" && Number.isInteger(value.repeatCount)
    ? Math.max(2, Math.min(5, value.repeatCount))
    : DEFAULT_STRONG_REMINDER_REPEAT_COUNT;
  return {
    enabled: value.enabled === true,
    intervalMinutes: interval,
    repeatCount: count,
  };
}

export function strongReminderDeliveryTimes(
  detectedAt: string,
  policy: StrongReminderPolicy,
): string[] {
  const start = Date.parse(detectedAt);
  if (!policy.enabled || !Number.isFinite(start)) return [];
  return Array.from({ length: policy.repeatCount }, (_value, index) => (
    new Date(start + index * policy.intervalMinutes * 60_000).toISOString()
  ));
}
