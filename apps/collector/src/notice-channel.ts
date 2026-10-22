/**
 * 通知登记簿的发送循环：所有渠道共用一个（docs/常用/自用推送渠道-总览.md 第 1 节那张图）。
 *
 * 一份通知在每个渠道（邮件 / 飞书 / 微信）占 radar_core.notice_deliveries 的一行。循环每次做同样几步：
 *   取件（各渠道自己的 pending：哪些通知该我发）→ 放行（邮件看每天的额度）→ 认领那一行 → 发 →
 *   收下了记 sent / 没东西可发记 skipped / 没发成记 failed、按退避到点再试 / 次数用完记 abandoned。
 * 各渠道只写「取件」和「怎么发」两段（NoticeChannelDriver）。加一个渠道（Telegram、企业微信……）：
 *   1. notice_deliveries.channel 的 CHECK 加上它，packages/db 的 NoticeChannel / NOTICE_MAX_ATTEMPTS 加上它；
 *   2. 写一条取件 SQL（参考 delivery.ts 的 pendingHermesNotices）和一个 driver；
 *   3. 在 notice-delivery.ts 的 deliverPendingNotifications 里跑它。
 *
 * 发送是一次网络调用，发生在任何数据库事务之外（认领和收尾各是一条独立语句），
 * 所以这里的等待不和 jpgr_app 的 idle_in_transaction_session_timeout 成对（AGENTS.md §3）。
 */
import type { NoticeChannel, NoticeClaim, RadarRepository } from "@jpgr/db";
import { NOTICE_MAX_ATTEMPTS, noticeRetryDelaySeconds } from "@jpgr/db";

/** 渠道报错时带上 HTTP 状态和对方要求的等待秒数，循环按它们记录、退避。 */
export class ChannelSendError extends Error {
  constructor(message: string, readonly httpStatus: number | null, readonly retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ChannelSendError";
  }
}

export type NoticeSendResult =
  /** confirmed=true：收下即到（邮件、微信）；false：到没到等渠道事后回报（飞书）。 */
  | { kind: "sent"; remoteId: string | null; httpStatus: number | null; confirmed: boolean; log?: Record<string, unknown> }
  /** 没东西可发（日报里只有建档存量）。 */
  | { kind: "skipped"; reason: string }
  /** 永远发不出去（渲染不出来），不再重试。 */
  | { kind: "abandoned"; reason: string };

export interface NoticeChannelDriver<Row extends { event_id: string }> {
  channel: NoticeChannel;
  /** 通知本身（events.status）跟着这个渠道记成已发出 / 失败。只有邮件是 true，见 delivery.ts 的 finishNotice。 */
  eventFollows: boolean;
  pending(): Promise<Row[]>;
  /** 发每一条之前：send 照发；skip 这条不发（也不认领）；stop 这一批到此为止。 */
  admit?(row: Row): Promise<"send" | "skip" | "stop">;
  send(row: Row, claim: NoticeClaim): Promise<NoticeSendResult>;
}

export interface NoticeChannelRun {
  sent: number;
  /** admit 叫停了这一批（邮件：当天额度用完）。 */
  stopped: boolean;
  /** 这一批最后一个发送错误。单条失败不挡后面的；调用方决定要不要再抛出去。 */
  lastError: unknown;
}

export async function runNoticeChannel<Row extends { event_id: string }>(
  repository: RadarRepository,
  driver: NoticeChannelDriver<Row>,
): Promise<NoticeChannelRun> {
  const run: NoticeChannelRun = { sent: 0, stopped: false, lastError: undefined };
  const rows = await driver.pending();
  for (const row of rows) {
    if (driver.admit) {
      const verdict = await driver.admit(row);
      if (verdict === "skip") continue;
      if (verdict === "stop") {
        run.stopped = true;
        break;
      }
    }
    const claim = await repository.claimNotice(driver.channel, row.event_id);
    if (!claim) continue;
    let result: NoticeSendResult;
    try {
      result = await driver.send(row, claim);
    } catch (error) {
      run.lastError = error;
      await recordFailure(repository, driver, row.event_id, claim, error);
      continue;
    }
    if (result.kind === "sent") {
      await repository.finishNotice(claim, {
        eventId: row.event_id,
        remoteId: result.remoteId,
        httpStatus: result.httpStatus,
        confirmed: result.confirmed,
        eventFollows: driver.eventFollows,
      });
      run.sent += 1;
      console.log(JSON.stringify({
        event: "notice_delivered",
        channel: driver.channel,
        eventId: row.event_id,
        attempt: claim.attempts,
        remoteId: result.remoteId,
        ...result.log,
      }));
    } else if (result.kind === "skipped") {
      await repository.skipNotice(claim, result.reason);
    } else {
      await repository.abandonNotice(claim, {
        eventId: row.event_id,
        reason: result.reason,
        httpStatus: null,
        eventFollows: driver.eventFollows,
      });
      console.error(JSON.stringify({
        event: "notice_abandoned",
        channel: driver.channel,
        eventId: row.event_id,
        reason: result.reason.slice(0, 300),
      }));
    }
  }
  return run;
}

async function recordFailure<Row extends { event_id: string }>(
  repository: RadarRepository,
  driver: NoticeChannelDriver<Row>,
  eventId: string,
  claim: NoticeClaim,
  error: unknown,
): Promise<void> {
  const httpStatus = error instanceof ChannelSendError ? error.httpStatus : null;
  const providerDelay = error instanceof ChannelSendError ? error.retryAfterSeconds : null;
  const message = error instanceof Error ? error.message : `${driver.channel} 发送失败`;
  const exhausted = claim.attempts >= NOTICE_MAX_ATTEMPTS[driver.channel];
  const delaySeconds = noticeRetryDelaySeconds(claim.attempts, providerDelay);
  if (exhausted) {
    await repository.abandonNotice(claim, {
      eventId,
      reason: `试了 ${claim.attempts} 次都没发出去：${message}`,
      httpStatus,
      eventFollows: driver.eventFollows,
    });
  } else {
    await repository.failNotice(claim, {
      eventId,
      message,
      httpStatus,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
      eventFollows: driver.eventFollows,
    });
  }
  console.error(JSON.stringify({
    event: "notice_failed",
    channel: driver.channel,
    eventId,
    attempt: claim.attempts,
    httpStatus,
    abandoned: exhausted,
    retryAfterSeconds: exhausted ? null : delaySeconds,
    errorMessage: message.slice(0, 300),
  }));
}
