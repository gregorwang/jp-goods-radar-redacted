package com.jpgr.push.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.jpgr.push.PushApp
import com.jpgr.push.R
import com.jpgr.push.data.PushMessage
import com.jpgr.push.ui.MainActivity
import com.jpgr.push.ui.formatClock
import com.jpgr.push.ui.formatYen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 两个通知渠道（工程文档 §6.2）：
 *   新货推送  高重要性，响铃 + 横幅；点开进这一次推送的清单
 *   连接状态  低重要性，前台服务的常驻通知，静音、不弹
 * 以后秒级推送（kind = instant）单独一个渠道，见 §9。
 */
object Notifier {
    const val CHANNEL_GOODS = "goods"
    const val CHANNEL_CONNECTION = "connection"
    const val SERVICE_NOTIFICATION_ID = 1
    const val EXTRA_MESSAGE_ID = "messageId"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_GOODS, "新货推送", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "关键词巡回每一轮的新货"
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, "连接状态", NotificationManager.IMPORTANCE_LOW).apply {
                description = "保持和推送服务器的连接（常驻，不响不弹）"
                setShowBadge(false)
            },
        )
    }

    private fun openApp(context: Context, messageId: Long?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (messageId != null) intent.putExtra(EXTRA_MESSAGE_ID, messageId)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun statusLine(state: PushState.Snapshot): String = when (state.conn) {
        PushState.Conn.ONLINE ->
            "保持连接中 · 最后心跳 ${if (state.lastPongAt > 0) formatClock(state.lastPongAt) else "—"}"
        PushState.Conn.CONNECTING -> "正在连接…"
        PushState.Conn.BACKOFF ->
            if (state.retryAt == null) "连不上：${state.lastError ?: "口令不对"}，请到连接页检查"
            else "重连中 · ${formatClock(state.retryAt)} 再试"
        PushState.Conn.NO_TOKEN -> "还没填设备口令，点开去填"
        PushState.Conn.STOPPED -> "已停止"
    }

    fun serviceNotification(context: Context, state: PushState.Snapshot): Notification =
        Notification.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("格银推送")
            .setContentText(statusLine(state))
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openApp(context, null, 0))
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    fun updateServiceNotification(context: Context, state: PushState.Snapshot) {
        context.getSystemService(NotificationManager::class.java)
            .notify(SERVICE_NOTIFICATION_ID, serviceNotification(context, state))
    }

    /** 「赛车初音 · 3 件新货」；正文前 3 件「标题 ¥价格」；有图时用大图展示首件。 */
    suspend fun notifyMessage(context: Context, message: PushMessage) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        val title = if (message.kind == "test") "测试推送 · 通道正常"
            else "${message.shortName} · ${message.total} 件新货"
        val lines = message.items.take(3).map { item ->
            "${item.title.take(40)} ${if (item.auction) "拍 " else ""}${formatYen(item.price)}"
        }
        val picture = message.items.firstNotNullOfOrNull { it.imageUrl }?.let { loadBitmap(it) }
        val builder = Notification.Builder(context, CHANNEL_GOODS)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF45BFE8.toInt())
            .setContentTitle(title)
            .setContentText(lines.firstOrNull() ?: "点开查看")
            .setWhen(message.createdAt)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(openApp(context, message.id, message.id.toInt()))
        if (picture != null) {
            builder.setLargeIcon(picture)
            builder.setStyle(
                Notification.BigPictureStyle()
                    .bigPicture(picture)
                    .bigLargeIcon(null as android.graphics.drawable.Icon?)
                    .setSummaryText(lines.joinToString("\n")),
            )
        } else {
            builder.setStyle(Notification.InboxStyle().also { style -> lines.forEach(style::addLine) })
        }
        manager.notify(message.id.toInt() + 100, builder.build())
    }

    /** 在 App 里看过这一次推送了，通知栏里那条也收掉。 */
    fun cancelMessage(context: Context, messageId: Long) {
        context.getSystemService(NotificationManager::class.java).cancel(messageId.toInt() + 100)
    }

    /** 全部标为已读时，通知栏里的新货通知一起收掉（常驻的连接通知不动）。 */
    fun cancelAllMessages(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.id != SERVICE_NOTIFICATION_ID }.forEach { manager.cancel(it.id) }
    }

    /** 首件图，最多等 6 秒；拿不到就发不带图的通知，不耽误。 */
    private suspend fun loadBitmap(url: String): Bitmap? = withContext(Dispatchers.IO) {
        runCatching {
            val client = PushApp.instance.http.newBuilder().callTimeout(6, TimeUnit.SECONDS).build()
            client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val bytes = response.body?.bytes() ?: return@use null
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        }.getOrNull()
    }
}
