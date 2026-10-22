package com.jpgr.push.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * 心跳闹钟。用 setExactAndAllowWhileIdle：普通的 delay 在深度休眠里会被无限推迟，
 * 闹钟能把手机叫醒。系统在休眠时会把同一个 App 的这种闹钟限到大约每 9 分钟一次，
 * 那几分钟里断了线由下一次心跳发现，消息靠重连补发，不会丢。
 */
class HeartbeatReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        PushService.start(context, PushService.ACTION_HEARTBEAT)
    }

    companion object {
        private const val INTERVAL_MS = 4 * 60 * 1000L

        private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, 1, Intent(context, HeartbeatReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        fun schedule(context: Context) {
            val alarms = context.getSystemService(AlarmManager::class.java)
            val at = SystemClock.elapsedRealtime() + INTERVAL_MS
            if (alarms.canScheduleExactAlarms()) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending(context))
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending(context))
            }
        }

        fun cancel(context: Context) {
            context.getSystemService(AlarmManager::class.java).cancel(pending(context))
        }
    }
}

/** 开机、App 更新后不用打开 App 就自己连上。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            PushService.start(context)
        }
    }
}

/** 看门狗：每 15 分钟看一眼服务在不在、连没连着，不在就拉起来。 */
class Watchdog(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        PushService.start(applicationContext)
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "watchdog",
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<Watchdog>(15, TimeUnit.MINUTES).build(),
            )
        }
    }
}
