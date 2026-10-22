export type WatchLifecycleStatus = "active" | "partial" | "paused" | "completed" | "archived";
export type WatchLifecycleReason = "user_paused" | "user_purchased" | "terminal_listing" | null;

export interface WatchCompletionEventRow {
  watch_profile_id: string;
  payload_json: string;
  created_at: string;
}

function completionKind(payloadJson: string | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const kind = (payload as Record<string, unknown>).kind;
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
}

export function watchLifecycle(input: {
  enabled: number | boolean;
  activeBindingCount: number;
  bindingCount: number;
  completion?: Pick<WatchCompletionEventRow, "payload_json"> | null;
}): { status: WatchLifecycleStatus; reason: WatchLifecycleReason } {
  const kind = completionKind(input.completion?.payload_json);
  if (kind === "user_purchased") return { status: "archived", reason: "user_purchased" };
  if (kind === "terminal_item_watch_completed") return { status: "completed", reason: "terminal_listing" };
  if (!input.enabled || input.activeBindingCount === 0) return { status: "paused", reason: "user_paused" };
  if (input.activeBindingCount < input.bindingCount) return { status: "partial", reason: null };
  return { status: "active", reason: null };
}

export function watchLifecycleLabel(status: WatchLifecycleStatus, reason: WatchLifecycleReason): string {
  if (status === "archived" && reason === "user_purchased") return "已购买归档";
  if (status === "completed") return "监控已完成";
  if (status === "paused") return "已暂停";
  if (status === "partial") return "部分运行";
  return "运行中";
}

export function watchOverviewLabel(input: {
  status: WatchLifecycleStatus;
  reason: WatchLifecycleReason;
  failingBindingCount: number;
  pausedBindingCount: number;
}): string {
  if (input.status === "archived" || input.status === "completed" || input.status === "paused") {
    return watchLifecycleLabel(input.status, input.reason);
  }
  if (input.failingBindingCount > 0) return "有来源需处理";
  if (input.pausedBindingCount > 0 || input.status === "partial") return "有来源暂停";
  return "运行中";
}

export function isTerminalWatchLifecycle(status: WatchLifecycleStatus): boolean {
  return status === "archived" || status === "completed";
}
