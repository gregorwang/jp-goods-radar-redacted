import type { PendingEmailRow, RadarRepository } from "@jpgr/db";
import {
  HERMES_NOTIFICATION_EVENT_TYPE,
  HermesWebhookError,
  sendHermesNotification,
} from "@jpgr/notifications";
import { renderEventNotification } from "./notification-template";
import { ChannelSendError, runNoticeChannel } from "./notice-channel";

/**
 * 微信（Hermes）渠道。当前停用（`HERMES_NOTIFICATIONS_ENABLED=false`）：Hermes Webhook 自 2026-08 起持续返回 502。
 * 取件、认领、重试、放弃都走通知登记簿的共用循环（notice-channel.ts），这里只有「取哪些」和「怎么发」。
 * 渠道启用时间之前的通知不投（notification_channels 里的 hermes_weixin），失败有次数和 3 天年龄上限。
 */
const HERMES_DELIVERY_LIMIT = 20;
const CHANNEL_ACTIVATION_GRACE_MS = 5 * 60 * 1_000;

type HermesRuntimeConfig =
  | { enabled: false }
  | { enabled: true; url: string; secret: string };

function runtimeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function hermesRuntimeConfig(env: Env): HermesRuntimeConfig {
  if (runtimeString(env.HERMES_NOTIFICATIONS_ENABLED).toLowerCase() !== "true") return { enabled: false };
  const url = runtimeString(env.HERMES_WEBHOOK_URL).trim();
  const secret = runtimeString(env.HERMES_WEBHOOK_SECRET);
  return url && secret.trim() ? { enabled: true, url, secret } : { enabled: false };
}

export async function deliverPendingHermesNotifications(
  env: Env,
  repository: RadarRepository,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const config = hermesRuntimeConfig(env);
  if (!config.enabled) return 0;
  const enabledAt = await repository.ensureNoticeChannelEnabledAt(
    "hermes_weixin",
    new Date(Date.now() - CHANNEL_ACTIVATION_GRACE_MS).toISOString(),
  );
  const run = await runNoticeChannel<PendingEmailRow>(repository, {
    channel: "hermes",
    eventFollows: false,
    pending: () => repository.pendingHermesNotices(enabledAt, HERMES_DELIVERY_LIMIT),
    async send(row) {
      const notification = renderEventNotification(row);
      try {
        const receipt = await sendHermesNotification({
          url: config.url,
          secret: config.secret,
          requestId: `hermes_weixin:${row.event_key}`,
          payload: {
            event_type: HERMES_NOTIFICATION_EVENT_TYPE,
            event_key: row.event_key,
            notification_type: row.event_type,
            message: `${notification.subject}\n\n${notification.text}`,
            occurred_at: row.event_created_at,
            source: "jp-goods-radar",
          },
        }, fetcher);
        return {
          kind: "sent",
          remoteId: receipt.deliveryId,
          httpStatus: receipt.httpStatus,
          confirmed: true,
          log: { notificationType: row.event_type, duplicate: receipt.duplicate },
        };
      } catch (error) {
        if (error instanceof HermesWebhookError) {
          throw new ChannelSendError(error.message, error.httpStatus, error.retryAfterSeconds);
        }
        throw error;
      }
    },
  });
  return run.sent;
}
import type { RuntimeEnv as Env } from "./runtime-env";
