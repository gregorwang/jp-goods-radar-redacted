export interface WatchProfileResumeBinding {
  id: string;
  sourceId: string;
  enabled: boolean;
}

export type WatchProfileResumeSkipReason = "source_monitoring_not_allowed";

export interface WatchProfileResumeSkip {
  bindingId: string;
  sourceId: string;
  reason: WatchProfileResumeSkipReason;
}

export interface WatchProfileResumePlan {
  resumeIds: string[];
  alreadyActiveCount: number;
  skipped: WatchProfileResumeSkip[];
}

export function planWatchProfileResume(
  bindings: readonly WatchProfileResumeBinding[],
  policy: ReadonlyMap<string, { monitoringAllowed: boolean }>,
): WatchProfileResumePlan {
  const eligible = bindings.filter((binding) => policy.get(binding.sourceId)?.monitoringAllowed === true);
  const alreadyActiveCount = eligible.filter((binding) => binding.enabled).length;
  const inactive = eligible.filter((binding) => !binding.enabled);
  const resumeIds = inactive.map((binding) => binding.id);
  const skipped: WatchProfileResumeSkip[] = [
    ...bindings
      .filter((binding) => policy.get(binding.sourceId)?.monitoringAllowed !== true)
      .map((binding) => ({
        bindingId: binding.id,
        sourceId: binding.sourceId,
        reason: "source_monitoring_not_allowed" as const,
      })),
  ];
  return { resumeIds, alreadyActiveCount, skipped };
}
