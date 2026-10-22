/**
 * 通知怎么发出去：邮件渠道，以及把邮件、微信、飞书三个渠道串起来的入口。
 *
 * 一份通知在每个渠道占通知登记簿（radar_core.notice_deliveries）的一行，三个渠道共用 notice-channel.ts 的发送循环。
 * 「发到哪」由档案的 notify_email / notify_feishu 决定，具体写在各渠道的取件 SQL 里
 * （packages/db 的 delivery.ts 邮件、push.ts 飞书）；飞书没送到补邮件见 push-delivery.ts。
 */
import type { PendingEmailRow, RadarRepository } from "@jpgr/db";
import { sendResendEmail, withTopNotice } from "@jpgr/email";
import { deliverPendingHermesNotifications } from "./hermes-delivery";
import { renderEventNotification } from "./notification-template";
import { ChannelSendError, runNoticeChannel } from "./notice-channel";
import { deliverPendingPushNotifications, pushFallbackNotice, routeDossierNotifications } from "./push-delivery";
import type { RuntimeEnv as Env } from "./runtime-env";

/** 一批最多发几封；剩下的下一次再发。 */
const EMAIL_BATCH_LIMIT = 20;

/**
 * 发所有渠道的待发通知。先按档案开关收尾（飞书结果、补邮件、作废），再依次跑邮件、微信、飞书。
 * 微信和飞书失败只记日志，不挡邮件；邮件的发送错误在最后抛出去，调用方（采集任务、日报收尾）照旧能看到。
 */
export async function deliverPendingNotifications(env: Env, repository: RadarRepository): Promise<void> {
  await routeDossierNotifications(env, repository);
  let emailError: unknown;
  try {
    await deliverPendingEmails(env, repository);
  } catch (error) {
    emailError = error;
  }
  try {
    await deliverPendingHermesNotifications(env, repository);
  } catch (error) {
    console.error(JSON.stringify({
      event: "hermes_notification_dispatch_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
  try {
    await deliverPendingPushNotifications(env, repository);
  } catch (error) {
    console.error(JSON.stringify({
      event: "owner_push_dispatch_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }));
  }
  if (emailError) throw emailError;
}

/**
 * 每分钟跟进一次飞书：通知原本只在有新通知生成、或整点维护时才投，推送服务回报的结果没人及时来问
 * （10-14 实测：一份日报推出去十几分钟还没查结果）。问结果、补邮件、补推推送服务没接住的；真补了邮件才把邮件跑一遍。
 */
export async function followUpNotices(env: Env, repository: RadarRepository): Promise<void> {
  const returned = await routeDossierNotifications(env, repository);
  await deliverPendingPushNotifications(env, repository);
  if (returned > 0) await deliverPendingNotifications(env, repository);
}

function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY)
    && !env.ALERT_EMAIL_TO.endsWith("@example.com")
    && !env.ALERT_EMAIL_FROM.includes("example.com");
}

/**
 * 邮件渠道。每天最多 MAX_EMAILS_PER_DAY 封（Resend 免费额度，硬上限 80）：
 * 待发的比剩下的额度多时，先按优先级（到目标价、降价……）逐封发，留最后一封把其余的合成一封汇总。
 */
async function deliverPendingEmails(env: Env, repository: RadarRepository): Promise<void> {
  if (!emailConfigured(env)) return;
  const configuredLimit = Number(env.MAX_EMAILS_PER_DAY);
  const limit = Math.max(1, Math.min(Number.isFinite(configuredLimit) ? configuredLimit : 20, 80));
  const remaining = Math.max(0, limit - await repository.emailsSentToday());
  const pendingCount = await repository.pendingEmailCount();
  if (pendingCount === 0) return;

  const overflow = pendingCount > remaining;
  if (remaining === 0) {
    await repository.prepareDailyDigest();
    return;
  }

  const individualBudget = overflow ? Math.max(0, remaining - 1) : remaining;
  const run = await runNoticeChannel<PendingEmailRow>(repository, emailDriver(env, repository, limit, {
    pending: () => repository.pendingEmails(Math.min(individualBudget, EMAIL_BATCH_LIMIT)),
  }));
  if (run.lastError) throw run.lastError;

  if (overflow && !run.stopped) {
    await repository.prepareDailyDigest();
    const digest = (await repository.pendingEmails(1)).filter((row) => row.event_type === "daily_digest");
    const digestRun = await runNoticeChannel<PendingEmailRow>(repository, emailDriver(env, repository, limit, {
      pending: async () => digest,
    }));
    if (digestRun.lastError) throw digestRun.lastError;
  }
}

function emailDriver(
  env: Env,
  repository: RadarRepository,
  dailyLimit: number,
  input: { pending: () => Promise<PendingEmailRow[]> },
) {
  return {
    channel: "email" as const,
    eventFollows: true,
    pending: input.pending,
    async admit(row: PendingEmailRow): Promise<"send" | "skip" | "stop"> {
      if (!strongReminderStillEligible(row)) {
        await repository.suppressEvent(row.event_id);
        return "skip";
      }
      // 配额在发送前原子占位：并发投递方不会共同读到同一个 remaining 而超发。
      if (!await repository.reserveEmailSlot(dailyLimit)) {
        await repository.prepareDailyDigest();
        return "stop";
      }
      return "send";
    },
    async send(row: PendingEmailRow) {
      let template: ReturnType<typeof renderEventNotification>;
      try {
        template = renderEventNotification(row);
        // 只开飞书的档案、飞书没送到补发的邮件：开头写明为什么收到的是邮件。
        if (row.fallback_reason) template = withTopNotice(template, pushFallbackNotice(row.fallback_reason));
      } catch (error) {
        // 渲染永远失败的通知必须移出邮件队列，否则会按 created_at 永久排在前面、挡住后面所有通知。
        await repository.markEmailUnrenderable(row.event_id);
        console.error(JSON.stringify({ event: "email_render_failed", eventId: row.event_id, eventType: row.event_type }));
        return { kind: "abandoned" as const, reason: error instanceof Error ? error.message : "通知渲染失败" };
      }
      try {
        const resendId = await sendResendEmail({
          apiKey: env.RESEND_API_KEY,
          from: env.ALERT_EMAIL_FROM,
          to: env.ALERT_EMAIL_TO,
          subject: template.subject,
          html: template.html,
          text: template.text,
          // Resend 按它幂等：同一份通知重试不会收到两封（换表前后也是同一个 key）。
          idempotencyKey: row.event_key,
        });
        return { kind: "sent" as const, remoteId: resendId, httpStatus: null, confirmed: true, log: { eventType: row.event_type } };
      } catch (error) {
        const status = error instanceof Error ? /\((\d{3})\)/u.exec(error.message)?.[1] : undefined;
        throw new ChannelSendError(error instanceof Error ? error.message : "邮件发送失败", status ? Number(status) : null);
      }
    },
  };
}

/** 到目标价的强提醒：发之前再核一次，档案停了、价格回去了、卖完了的不发。 */
function strongReminderStillEligible(row: PendingEmailRow): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    return true;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const reminder = (payload as Record<string, unknown>).strongReminder;
  if (!reminder || typeof reminder !== "object" || Array.isArray(reminder)) return true;
  const targetPrice = (payload as Record<string, unknown>).targetPrice;
  return Number(row.binding_enabled) === 1
    && Number(row.profile_enabled) === 1
    && row.current_price !== null
    && typeof targetPrice === "number"
    && row.current_price <= targetPrice
    && row.price_basis !== "auction_current_bid"
    && row.availability !== null
    && ["available", "preorder", "backorder"].includes(row.availability);
}
