/**
 * 通知登记簿（radar_core.notice_deliveries）里各渠道共用的投递边界。
 * collector 的发送循环（apps/collector/src/notice-delivery.ts）和这里的取件 SQL 读同一份数。
 */
import type { NoticeChannel } from "./types";

/** 认领后这么久还停在 sending，当作那次发送中途死掉了，可以重新认领。 */
export const NOTICE_SENDING_STALE_MS = 15 * 60 * 1_000;

/**
 * 每个渠道最多试几次，到了就记成 abandoned、退出队列（不压队头）。
 * 邮件给得多一些：12 次按下面的退避大约撑两天，Resend 出一整天故障也补得回来。
 */
export const NOTICE_MAX_ATTEMPTS: Readonly<Record<NoticeChannel, number>> = {
  email: 12,
  feishu: 8,
  hermes: 8,
};

/** 第 n 次失败后等多久再试；超过表长按最后一档。 */
export const NOTICE_RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60] as const;

/** 飞书、微信只投这么近的通知；更老的发出去也没用了。邮件不设上限，只看次数。 */
export const NOTICE_MAX_EVENT_AGE_MS = 3 * 24 * 60 * 60 * 1_000;

export function noticeRetryDelaySeconds(attempt: number, providerDelaySeconds: number | null = null): number {
  const index = Math.min(Math.max(0, attempt - 1), NOTICE_RETRY_DELAYS_SECONDS.length - 1);
  return Math.max(NOTICE_RETRY_DELAYS_SECONDS[index] ?? 60, providerDelaySeconds ?? 0);
}
