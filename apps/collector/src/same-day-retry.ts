import { adaptiveItemScheduleEnabled, type FinalizeKeywordDigestJob, type MonitorJob } from "@jpgr/core";
import { SAME_DAY_RETRY_DELAY_SECONDS, type WatchBindingRow } from "@jpgr/db";
import { monitorQueueFor } from "./monitor-queue";

/**
 * 这条绑定的新品是否进关键词摘要；进的话，是否按"初始基线"渲染。
 * 定时调度和当天补跑共用这一个判断，两处分组规则不能各写一份。
 */
export function keywordDigestMembership(binding: WatchBindingRow): { member: boolean; initialBaseline: boolean } {
  const member = binding.monitoring_purpose === "keyword_new_listing"
    && binding.notify_new_listing === 1
    && (binding.baseline_completed === 1
      || binding.profile_dossier_kind === "keyword"
      || binding.profile_dossier_kind === "exact_product");
  // Only a broad keyword radar owns a silent initial market baseline.
  // Exact-product first-run matches are normal discoveries and must be
  // rendered by the exact-product digest path.
  //
  // 深度锚定轮同理：它一次性把此前只读一页而漏掉的存量挖出来，那些不是当天的新品，
  // 但也不能凭空消失——按基线渲染，让这一轮的量在摘要里可见。
  const initialBaseline = member
    && binding.profile_dossier_kind === "keyword"
    && (binding.baseline_completed === 0 || !binding.new_listing_anchored_at);
  return { member, initialBaseline };
}

/**
 * 当天补跑（煤炉每日档案首次失败后 2 小时，规则见 @jpgr/db 的 sameDayRetryEligible）。
 *
 * 补跑走队列里的一条延迟任务，不改 next_run_at——否则 reserveBinding 会以补跑时间为基准
 * 往后排，以后每天的运行时间都漂 2 小时。补跑不是定时调度派发的那一批，所以它的摘要也要
 * 自己排：和调度一样排一条 finalize_keyword_digest。补跑抓到值得看的新货就补发一封；
 * 什么都没有时 prepareKeywordDigest 返回 null，不发信。
 */
export async function scheduleSameDayRetry(
  env: Env,
  binding: WatchBindingRow,
  failedRunStartedAt: string,
  digestDelaySeconds: number,
): Promise<void> {
  // 开了自适应节奏的单品档案，failBinding 已经把 next_run_at 拉到冷却到期那一刻（约 2 小时后），
  // 调度器会自己补跑；这里再排一条就会跑两次。
  if (adaptiveItemScheduleEnabled(binding)) return;
  const queuedAt = new Date().toISOString();
  await monitorQueueFor(env, binding.source_id).send({
    type: "run_binding",
    idempotencyKey: `run_binding:${binding.id}:retry:${failedRunStartedAt}`,
    bindingId: binding.id,
    trigger: "retry",
    queuedAt,
  } satisfies MonitorJob, { delaySeconds: SAME_DAY_RETRY_DELAY_SECONDS });

  const digest = keywordDigestMembership(binding);
  if (!digest.member) return;
  // 摘要按 started_at >= scanStartedAt 找这一轮的运行。队列延迟是"至少"，补跑只会晚不会早；
  // 留一分钟余量，免得边界上的时钟差把补跑那次运行漏掉。
  const scanStartedAt = new Date(Date.now() + (SAME_DAY_RETRY_DELAY_SECONDS - 60) * 1_000).toISOString();
  const digestKey = `keyword_digest:${binding.watch_profile_id}:${scanStartedAt}`;
  await env.MONITOR_QUEUE.send({
    type: "finalize_keyword_digest",
    idempotencyKey: `${digestKey}:1`,
    profileId: binding.watch_profile_id,
    bindingIds: [binding.id],
    ...(digest.initialBaseline ? { initialBaselineBindingIds: [binding.id] } : {}),
    scanStartedAt,
    digestKey,
    finalizeAttempt: 1,
    queuedAt,
  } satisfies FinalizeKeywordDigestJob, { delaySeconds: SAME_DAY_RETRY_DELAY_SECONDS + digestDelaySeconds });
}

import type { RuntimeEnv as Env } from "./runtime-env";
