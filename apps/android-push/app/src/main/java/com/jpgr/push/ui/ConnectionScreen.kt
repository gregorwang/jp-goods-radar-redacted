package com.jpgr.push.ui

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.jpgr.push.BuildConfig
import com.jpgr.push.PushApp
import com.jpgr.push.service.PushService
import com.jpgr.push.service.PushState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

private data class Check(
    val title: String,
    /** null = 系统不给读，只能请用户自己确认。 */
    val ok: Boolean?,
    val hint: String,
    val action: (Context) -> Unit,
)

private fun appDetails(context: Context) {
    context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}

/** 小米的自启动管理页；不同系统版本的入口不一样，挨个试，都不行就退到应用详情。 */
private fun openAutostart(context: Context) {
    val candidates = listOf(
        ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
        ComponentName("com.miui.securitycenter", "com.miui.appmanager.ApplicationsDetailsActivity"),
    )
    for (component in candidates) {
        val intent = Intent().setComponent(component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("package_name", context.packageName)
        if (runCatching { context.startActivity(intent) }.isSuccess) return
    }
    appDetails(context)
}

private fun checks(context: Context): List<Check> {
    val notifications = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    val battery = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
    val restricted = context.getSystemService(ActivityManager::class.java).isBackgroundRestricted
    return listOf(
        Check("通知权限", notifications, "关着就什么都弹不出来。") {
            it.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, it.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        },
        Check("电池优化白名单", battery, "不在白名单时，锁屏久了系统会断网，推送要等到下一次维护窗口（几分钟到十几分钟）。") {
            it.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${it.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        },
        Check(
            "自启动",
            null,
            "小米不让 App 读这个开关，请自己确认已打开。跳不过去时：手机管家 → 应用管理 → 权限 → 自启动管理 → 格银推送。",
            ::openAutostart,
        ),
        Check(
            "省电策略：无限制",
            if (restricted) false else null,
            "应用详情 → 省电策略 → 无限制。再在最近任务里把本 App 下拉锁定，划掉其他 App 时它不会被一起清掉。",
            ::appDetails,
        ),
    )
}

/** 连接：状态、设备口令、后台保活四项检查、测试推送。 */
@Composable
fun ConnectionScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val app = PushApp.instance
    val state by PushState.state.collectAsState()
    val scope = rememberCoroutineScope()
    var resumeTick by remember { mutableIntStateOf(0) }
    var tokenInput by remember { mutableStateOf("") }
    var tokenNote by remember { mutableStateOf<String?>(null) }
    var testNote by remember { mutableStateOf<String?>(null) }
    var serverNote by remember { mutableStateOf<String?>(null) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    LifecycleResumeEffect(Unit) {
        resumeTick += 1
        onPauseOrDispose { }
    }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    LaunchedEffect(resumeTick, state.conn) {
        serverNote = runCatching {
            val status = app.relay.status(app.tokens.token())
            val ack = status.optString("lastAckAt").takeIf { it.isNotEmpty() && it != "null" }
                ?.let { runCatching { formatWhen(Instant.parse(it).toEpochMilli()) }.getOrNull() }
            "服务器上现在有 ${status.optInt("connections")} 个连接" + (ack?.let { "，最后一次送达确认 $it" } ?: "")
        }.getOrElse { "读不到服务器状态：${it.message}" }
    }
    val checkList = remember(resumeTick) { checks(context) }

    Column(Modifier.fillMaxSize()) {
        BrandBar { LineButton("← 收件", onBack, color = Palette.Ink2, textSize = 12.sp) }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
            Spacer(Modifier.height(30.dp))
            Txt("CONNECTION", sans(11.sp, Palette.Mute, 0.2.em))
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(connectionColor(state.conn), 9.dp)
                Spacer(Modifier.width(12.dp))
                Txt(connectionLabel(state), serif(28.sp))
            }
            Spacer(Modifier.height(16.dp))
            Hairline(Palette.Ink)
            StatusLine("最后心跳", if (state.lastPongAt > 0) "${formatClockSeconds(state.lastPongAt)}（${timeAgo(state.lastPongAt, now)}）" else "—")
            StatusLine("最后收到推送", if (state.lastMessageAt > 0) formatWhen(state.lastMessageAt) else "—")
            StatusLine("这次连上", if (state.lastConnectedAt > 0) formatWhen(state.lastConnectedAt) else "—")
            if (state.conn == PushState.Conn.BACKOFF && state.retryAt != null) {
                StatusLine("下次重试", "${maxOf(0L, (state.retryAt!! - now) / 1000)} 秒后")
            }
            state.lastError?.let { StatusLine("上次断开", it, Palette.AlertText) }
            serverNote?.let {
                Spacer(Modifier.height(10.dp))
                Txt(it, sans(12.sp, Palette.Mute))
            }
            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                InkButton("发一条测试推送", {
                    testNote = "发送中…"
                    scope.launch {
                        testNote = runCatching { app.relay.sendTest(app.tokens.token()) }.fold(
                            { "已发出（第 ${it.optLong("id")} 条，送到 ${it.optInt("delivered")} 个连接）。几秒内应该弹通知。" },
                            { "没发出去：${it.message}" },
                        )
                    }
                })
                Spacer(Modifier.width(20.dp))
                LineButton("立即重连", { PushService.start(context, PushService.ACTION_RECONNECT) })
            }
            testNote?.let {
                Spacer(Modifier.height(10.dp))
                Txt(it, sans(12.sp, Palette.Ink2))
            }

            Section("后台常驻", "小米杀后台很凶，下面四项都要开。点右边直接跳到对应设置页，回来自动刷新状态。")
            checkList.forEach { CheckRow(it, context) }

            Section("设备口令", if (app.tokens.fromBuild()) "已用安装包里带的口令。换口令时在下面填新的，保存后自动重连。" else "和推送服务器的 PUSH_DEVICE_TOKEN 一致。保存后自动重连。")
            Spacer(Modifier.height(12.dp))
            BasicTextField(
                value = tokenInput,
                onValueChange = { tokenInput = it.trim() },
                singleLine = true,
                textStyle = sans(14.sp),
                cursorBrush = SolidColor(Palette.Ink),
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).drawBehind {
                    val y = size.height + 6.dp.toPx()
                    drawLine(Palette.LineStrong, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
                },
                decorationBox = { field ->
                    if (tokenInput.isEmpty()) Txt(if (app.tokens.token().isEmpty()) "粘贴口令" else "已保存（填新的会覆盖）", sans(14.sp, Palette.Faint))
                    field()
                },
            )
            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                InkButton("保存口令", {
                    if (tokenInput.length < 32) {
                        tokenNote = "口令太短（至少 32 个字符），没有保存。"
                    } else {
                        app.tokens.save(tokenInput)
                        tokenInput = ""
                        tokenNote = "已保存，正在重连。"
                        PushService.start(context, PushService.ACTION_RECONNECT)
                    }
                }, enabled = tokenInput.isNotEmpty())
            }
            tokenNote?.let {
                Spacer(Modifier.height(10.dp))
                Txt(it, sans(12.sp, Palette.Ink2))
            }
            Spacer(Modifier.height(36.dp))
            Hairline(Palette.Line)
            Spacer(Modifier.height(14.dp))
            Txt("版本 ${BuildConfig.VERSION_NAME} · ${BuildConfig.RELAY_BASE.removePrefix("https://")}", sans(11.sp, Palette.Faint))
            Spacer(Modifier.height(40.dp))
        }
    }
}

@Composable
private fun StatusLine(label: String, value: String, color: Color = Palette.Ink) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Txt(label, sans(12.sp, Palette.Mute, 0.06.em), Modifier.width(96.dp))
        Txt(value, sans(13.sp, color), Modifier.weight(1f))
    }
    Hairline()
}

@Composable
private fun Section(title: String, note: String) {
    Spacer(Modifier.height(40.dp))
    Txt(title, serif(20.sp))
    Spacer(Modifier.height(6.dp))
    Txt(note, sans(12.sp, Palette.Mute))
    Spacer(Modifier.height(10.dp))
    Hairline(Palette.Ink)
}

@Composable
private fun CheckRow(check: Check, context: Context) {
    Row(
        Modifier.fillMaxWidth().tap { check.action(context) }.padding(vertical = 14.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Txt(check.title, sans(14.sp))
                Spacer(Modifier.width(10.dp))
                when (check.ok) {
                    true -> Txt("已开", sans(12.sp, Palette.SkyText))
                    false -> Txt("没开", sans(12.sp, Palette.AlertText))
                    null -> Txt("请自己确认", sans(12.sp, Palette.LemonText))
                }
            }
            Spacer(Modifier.height(4.dp))
            Txt(check.hint, sans(12.sp, Palette.Mute))
        }
        LineButton("去设置", { check.action(context) }, color = Palette.Ink2, textSize = 12.sp)
    }
    Hairline()
}
