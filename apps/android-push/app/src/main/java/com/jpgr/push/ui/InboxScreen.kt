package com.jpgr.push.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.jpgr.push.PushApp
import com.jpgr.push.data.MessageEntity
import com.jpgr.push.data.RoundSummary
import com.jpgr.push.data.Rounds
import com.jpgr.push.service.Notifier
import com.jpgr.push.service.PushState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun connectionColor(conn: PushState.Conn): Color = when (conn) {
    PushState.Conn.ONLINE -> Palette.Sky
    PushState.Conn.CONNECTING, PushState.Conn.BACKOFF -> Palette.Lemon
    PushState.Conn.NO_TOKEN, PushState.Conn.STOPPED -> Palette.Alert
}

fun connectionLabel(state: PushState.Snapshot): String = when (state.conn) {
    PushState.Conn.ONLINE -> "在线"
    PushState.Conn.CONNECTING -> "连接中"
    PushState.Conn.BACKOFF -> if (state.retryAt == null) "连不上" else "重连中"
    PushState.Conn.NO_TOKEN -> "未填口令"
    PushState.Conn.STOPPED -> "未连接"
}

/** 过了下一轮开跑时间这么久还没收到新的一轮，就提示巡回可能卡住了（一轮通常 15–25 分钟跑完）。 */
private const val ROUND_LATE_MS = 45 * 60_000L

/** 收件：顶上一行巡回状态，下面按时间倒序列出每一次推送，没看过的带天蓝圆点。 */
@Composable
fun InboxScreen(onOpen: (Long) -> Unit, onConnection: () -> Unit, onLabels: () -> Unit, onExcluded: () -> Unit) {
    val app = remember { PushApp.instance }
    val dao = remember { app.db.messages() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val messages by dao.all().collectAsState(initial = null)
    val opened by dao.openedKeys().collectAsState(initial = emptyList())
    val openedSet = remember(opened) { opened.toHashSet() }
    val state by PushState.state.collectAsState()
    val rounds by Rounds.state.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

    // 每 30 秒走一次表：「巡回可能卡住了」要靠时间推移才会出现。
    LaunchedEffect(Unit) {
        runCatching { app.relay.rounds(app.tokens.token()) }.getOrNull()
            ?.let { list -> Rounds.upsert(context, list.mapNotNull(Rounds::parse)) }
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }

    val unread = messages.orEmpty().count { it.openedAt == null }

    Column(Modifier.fillMaxSize()) {
        BrandBar {
            LineButton("标注", onLabels, color = Palette.Ink2, textSize = 12.sp)
            Spacer(Modifier.width(14.dp))
            LineButton("筛掉的", onExcluded, color = Palette.Ink2, textSize = 12.sp)
            Spacer(Modifier.width(14.dp))
            Row(Modifier.tap(onConnection).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Dot(connectionColor(state.conn), 7.dp)
                Spacer(Modifier.width(8.dp))
                LineButton("连接 · ${connectionLabel(state)}", onConnection, color = Palette.Ink2, textSize = 12.sp)
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 30.dp, bottom = 14.dp)) {
                    Txt("INBOX", sans(11.sp, Palette.Mute, 0.2.em))
                    Spacer(Modifier.height(6.dp))
                    Txt("收件", serif(28.sp))
                }
                RoundStatus(Rounds.summary(rounds.values, now), now)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Txt(if (unread == 0) "都看过了" else "$unread 条没看", sans(13.sp, if (unread == 0) Palette.Mute else Palette.Ink))
                    Spacer(Modifier.weight(1f))
                    if (unread > 0) {
                        LineButton("全部标为已读", {
                            scope.launch {
                                dao.markAllOpened(System.currentTimeMillis())
                                Notifier.cancelAllMessages(context)
                            }
                        }, color = Palette.Ink2, textSize = 12.sp)
                    }
                }
                Hairline(Palette.Ink, Modifier.padding(horizontal = 24.dp))
            }
            val list = messages
            if (list != null && list.isEmpty()) {
                item { EmptyInbox(onConnection) }
            }
            items(list.orEmpty(), key = { it.id }) { message ->
                InboxRow(message, openedSet) { onOpen(message.id) }
            }
            item { Spacer(Modifier.height(40.dp)) }
        }
    }
}

/**
 * 「上一轮 08:26 跑完 · 3 件新货」「下一轮 09:05 开跑」。过了下一轮开跑时间 45 分钟还没收到新的一轮，
 * 换成赭红的「巡回可能卡住了」——这样不用一直开着 App 刷，看一眼就知道系统还活着。
 */
@Composable
private fun RoundStatus(summary: RoundSummary?, now: Long) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp).background(Palette.Mist).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (summary == null) {
            Txt("还没收到巡回状态。下一轮跑完就会显示在这里。", sans(12.sp, Palette.Mute))
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Txt("上一轮 ", sans(13.sp, Palette.Ink2))
            Txt(formatWhen(summary.lastFinishedAt), sans(13.sp, Palette.Ink))
            Txt(" 跑完 · ", sans(13.sp, Palette.Ink2))
            Txt(
                if (summary.newItems == 0) "没有新货" else "${summary.newItems} 件新货",
                sans(13.sp, if (summary.newItems == 0) Palette.Mute else Palette.Ink),
            )
        }
        val next = summary.nextRunAt
        val late = next != null && now > next + ROUND_LATE_MS && summary.lastFinishedAt < next
        when {
            late -> Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(Palette.Alert, 7.dp)
                Spacer(Modifier.width(8.dp))
                Txt("应在 ${formatClock(next!!)} 开跑的那一轮还没跑完，巡回可能卡住了", sans(12.sp, Palette.AlertText))
            }
            next != null -> Txt("下一轮 ${formatWhen(next)} 开跑，跑完约 15–20 分钟后推送", sans(12.sp, Palette.SkyText))
            else -> Txt("下一轮时间未知", sans(12.sp, Palette.Mute))
        }
        if (summary.failedSources.isNotEmpty()) {
            Txt("这一轮没抓成：${summary.failedSources.joinToString("、")}", sans(12.sp, Palette.AlertText))
        }
    }
}

@Composable
private fun InboxRow(message: MessageEntity, opened: Set<String>, onClick: () -> Unit) {
    val unread = message.openedAt == null
    // 点进来源看过几件（只有看过的推送才数，没看过的肯定是 0）。
    val clicked = remember(message.id, opened, unread) {
        if (unread || opened.isEmpty()) 0 else runCatching { message.message().items.count { it.openKey in opened } }.getOrDefault(0)
    }
    Column(Modifier.tap(onClick).padding(horizontal = 24.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            // 没看过：天蓝圆点；看过：留同样宽度的空白，标题对齐。
            if (unread) Dot(Palette.Sky, 8.dp) else Spacer(Modifier.size(8.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Txt(
                    if (message.kind == "test") "测试推送" else message.profileName,
                    serif(17.sp, if (unread) Palette.Ink else Palette.Ink2),
                    maxLines = 1,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Txt(
                        if (message.kind == "test") "通道检查" else "${message.total} 件新货",
                        sans(13.sp, if (unread) Palette.Ink else Palette.Mute),
                    )
                    Txt("　${formatWhen(message.createdAt)}", sans(12.sp, Palette.SkyText))
                    if (clicked > 0) Txt("　点开过 $clicked 件", sans(12.sp, Palette.Mute))
                }
            }
            Spacer(Modifier.width(14.dp))
            val thumb = Modifier.size(56.dp).background(Palette.Mist).alpha(if (unread) 1f else 0.6f)
            if (message.firstImage != null) {
                AsyncImage(model = message.firstImage, contentDescription = null, contentScale = ContentScale.Crop, modifier = thumb)
            } else {
                Spacer(thumb)
            }
        }
        Hairline()
    }
}

@Composable
private fun EmptyInbox(onConnection: () -> Unit) {
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Txt(
            "还没有推送。连接正常时，下一轮巡回有新货就会出现在这里，同时弹出通知。",
            sans(14.sp, Palette.Ink2),
        )
        InkButton("去连接页", onConnection)
    }
}
