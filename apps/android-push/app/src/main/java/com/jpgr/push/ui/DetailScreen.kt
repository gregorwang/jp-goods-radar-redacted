package com.jpgr.push.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.jpgr.push.PushApp
import com.jpgr.push.data.ItemOpenEntity
import com.jpgr.push.data.OtherSeller
import com.jpgr.push.data.PushItem
import com.jpgr.push.data.PushMessage
import com.jpgr.push.data.PushSales
import com.jpgr.push.service.Notifier
import kotlinx.coroutines.launch

/** 点开商品：装了煤炉 App 的会直接跳进 App（系统按链接分发）。 */
fun openUrl(context: Context, url: String?) {
    if (url == null) return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        // 没有能打开网页的 App，什么都不做。
    }
}

/** 「等降价」按钮在一张卡上的状态。 */
private data class WatchUi(val watching: Boolean, val busy: Boolean, val error: String?)

/**
 * 一次推送的清单：卡片布局和日报邮件一致——左栏来源 / 时间，中间商品图，右栏价格，标题占满下一行。
 * 打开就算看过（通知栏里那条一起收掉）；点进来源看过的卡片标「点开看过」；
 * 每张卡可以「等降价」（主站建单品档案，降价时发邮件）。
 */
@Composable
fun DetailScreen(messageId: Long, onBack: () -> Unit) {
    val app = remember { PushApp.instance }
    val dao = remember { app.db.messages() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val entity by dao.byId(messageId).collectAsState(initial = null)
    val message = remember(entity) { entity?.message() }
    val opened by dao.openedKeys().collectAsState(initial = emptyList())
    val openedSet = remember(opened) { opened.toHashSet() }
    var watched by remember { mutableStateOf<Set<String>>(emptySet()) }
    var busy by remember { mutableStateOf<Set<String>>(emptySet()) }
    var errors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    LaunchedEffect(messageId) {
        dao.markOpened(messageId, System.currentTimeMillis())
        Notifier.cancelMessage(context, messageId)
        watched = runCatching { app.device.watches(app.tokens.token()).active }.getOrDefault(emptySet())
    }

    fun openItem(item: PushItem) {
        scope.launch { dao.insertOpen(ItemOpenEntity(item.openKey, System.currentTimeMillis())) }
        openUrl(context, item.url)
    }

    fun toggleWatch(item: PushItem) {
        val itemId = item.sourceItemId ?: return
        val key = "${item.sourceId}|$itemId"
        if (key in busy) return
        scope.launch {
            busy = busy + key
            errors = errors - key
            try {
                if (key in watched) {
                    app.device.unwatch(app.tokens.token(), item.sourceId, itemId)
                    watched = watched - key
                } else {
                    app.device.watch(app.tokens.token(), item.sourceId, itemId)
                    watched = watched + key
                }
            } catch (error: Exception) {
                errors = errors + (key to (error.message ?: "没连上主站"))
            } finally {
                busy = busy - key
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        BrandBar { LineButton("← 收件", onBack, color = Palette.Ink2, textSize = 12.sp) }
        if (message == null) {
            Txt("这一条不在本机了（本机只留 30 天）。", sans(14.sp, Palette.Ink2), Modifier.padding(24.dp))
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item { Header(message) }
            items(message.items) { item ->
                val key = item.sourceItemId?.let { "${item.sourceId}|$it" }
                // 拍卖不比降价（当前出价只会涨），测试推送和旧消息没有商品号，都不给按钮。
                val watch = if (key == null || item.auction || message.kind == "test") null
                    else WatchUi(key in watched, key in busy, errors[key])
                ItemCard(item, item.openKey in openedSet, watch, onOpen = { openItem(item) }, onToggleWatch = { toggleWatch(item) })
            }
            item { Footer(message) }
        }
    }
}

@Composable
private fun Header(message: PushMessage) {
    Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 30.dp)) {
        Txt(if (message.kind == "test") "TEST" else "HOURLY", sans(11.sp, Palette.Mute, 0.2.em))
        Spacer(Modifier.height(6.dp))
        Txt(if (message.kind == "test") "测试推送" else message.profileName, serif(24.sp))
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Txt("${message.total}", num(40.sp))
            Txt(" 件新货", sans(13.sp, Palette.Mute))
            Spacer(Modifier.weight(1f))
            Txt(formatWhen(message.createdAt), sans(12.sp, Palette.SkyText))
        }
        if (message.failedSources.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            NoteRow("这一轮没抓成：${message.failedSources.joinToString("、")}。这些来源的新货要等下一轮。", Palette.Alert)
        }
        Spacer(Modifier.height(18.dp))
        Hairline(Palette.Ink)
    }
}

@Composable
private fun NoteRow(text: String, dot: androidx.compose.ui.graphics.Color) {
    Column {
        Hairline()
        Row(Modifier.padding(vertical = 12.dp)) {
            Dot(dot, 7.dp, Modifier.padding(top = 7.dp))
            Spacer(Modifier.width(11.dp))
            Txt(text, sans(12.sp, Palette.Ink2))
        }
        Hairline()
    }
}

@Composable
private fun Footer(message: PushMessage) {
    Column(Modifier.padding(24.dp)) {
        if (message.groupTotal > message.items.size) {
            NoteRow(
                "同名合并后共 ${message.groupTotal} 张卡片，这一条太大，只带了前 ${message.items.size} 张（单品在前、按价格从低到高）。",
                Palette.Lemon,
            )
            Spacer(Modifier.height(18.dp))
        }
        Txt("价格是推送那一刻平台上的价格；拍卖是当前出价，不是成交价。", sans(12.sp, Palette.Mute))
        Spacer(Modifier.height(8.dp))
        Txt("「等降价」：主站每隔几小时复查一次价格，降了发邮件通知。同时最多盯 30 件。", sans(12.sp, Palette.Mute))
        Spacer(Modifier.height(40.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemCard(item: PushItem, opened: Boolean, watch: WatchUi?, onOpen: () -> Unit, onToggleWatch: () -> Unit) {
    val dimmed = item.recovered
    Column(Modifier.tap(onOpen).padding(horizontal = 24.dp)) {
        Spacer(Modifier.height(18.dp))
        Row(Modifier.fillMaxWidth()) {
            // 左栏：来源 / 上架 / 更新
            Column(Modifier.weight(if (item.imageUrl != null) 0.24f else 0.5f)) {
                Txt(item.sourceLabel, sans(11.sp, if (dimmed) Palette.Mute else Palette.Ink), maxLines = 2)
                if (dimmed) {
                    Spacer(Modifier.height(6.dp))
                    Txt("恢复识别 · 以前采集过，这一轮才通过筛选", sans(11.sp, Palette.Mute))
                } else {
                    listingTiming(item.listedAt, item.updatedAt).reversed().forEach {
                        Spacer(Modifier.height(6.dp))
                        Txt(it.replace(" ", ""), sans(11.sp, Palette.SkyText), maxLines = 1)
                    }
                }
            }
            // 中间：商品图（二次元周边先看图，图放视线第一落点）
            if (item.imageUrl != null) {
                AsyncImage(
                    model = item.imageUrl,
                    contentDescription = item.title,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.weight(0.52f).padding(horizontal = 6.dp).aspectRatio(1f).background(Palette.Mist),
                )
            }
            // 右栏：标签 + 价格
            Column(Modifier.weight(if (item.imageUrl != null) 0.24f else 0.5f), horizontalAlignment = Alignment.End) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (item.auction) Tag("拍卖", TagTone.Alert)
                    if (item.bundle) Tag("打包", TagTone.Bundle)
                }
                if (item.auction || item.bundle) Spacer(Modifier.height(6.dp))
                if (item.auction) {
                    Txt(
                        "当前出价" + (item.bidCount?.let { " · $it 次" } ?: ""),
                        sans(11.sp, Palette.Mute),
                        maxLines = 1,
                    )
                }
                PriceText(item.price, if (dimmed) Palette.Ink2 else Palette.Ink)
                item.auctionEndsAt?.let {
                    Txt("${formatWhen(it)} 截止", sans(11.sp, Palette.AlertText), maxLines = 1)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Txt(item.title, sans(14.sp, if (dimmed || opened) Palette.Mute else Palette.Ink, 0.02.em))
        item.sales?.let { SalesRow(it) }
        if (item.others.isNotEmpty()) Others(item.others)
        if (opened || watch != null) ActionRow(opened, watch, onToggleWatch)
        Spacer(Modifier.height(16.dp))
        Hairline(Palette.Line)
    }
}

/** 卡片底下一行：左边「点开看过」，右边「等降价 / 等降价中 · 不等了」。 */
@Composable
private fun ActionRow(opened: Boolean, watch: WatchUi?, onToggleWatch: () -> Unit) {
    Spacer(Modifier.height(12.dp))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (opened) Tag("点开看过", TagTone.Mute)
        Spacer(Modifier.weight(1f))
        when {
            watch == null -> Unit
            watch.busy -> Txt("稍等…", sans(12.sp, Palette.Mute))
            watch.watching -> {
                Dot(Palette.Sky, 6.dp)
                Spacer(Modifier.width(6.dp))
                Txt("等降价中", sans(12.sp, Palette.SkyText))
                Spacer(Modifier.width(12.dp))
                LineButton("不等了", onToggleWatch, color = Palette.Mute, textSize = 12.sp)
            }
            else -> LineButton("等降价", onToggleWatch, color = Palette.Ink, textSize = 12.sp)
        }
    }
    watch?.error?.let {
        Spacer(Modifier.height(4.dp))
        Txt(it, sans(12.sp, Palette.AlertText))
    }
}

@Composable
private fun PriceText(price: Long?, color: androidx.compose.ui.graphics.Color) {
    if (price == null) {
        Txt("价格未取得", sans(13.sp, Palette.Mute))
        return
    }
    Row(verticalAlignment = Alignment.Bottom) {
        Txt(formatNumber(price), num(24.sp, color), maxLines = 1)
        Txt(" 円", sans(12.sp, Palette.Ink2))
    }
}

/** 同款成交 / 同款行情：数字放大，结论单独上色——便宜荧光笔底色，贵了赭红，持平正文灰。 */
@Composable
private fun SalesRow(sales: PushSales) {
    Spacer(Modifier.height(10.dp))
    Hairline()
    Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Txt(sales.label, sans(12.sp, Palette.Mute, 0.06.em), Modifier.width(68.dp))
        Txt("中位 ", sans(12.sp, Palette.Ink2))
        Txt(formatNumber(sales.median), num(18.sp))
        Txt(" 円 · ${sales.n} 笔", sans(12.sp, Palette.Mute))
        Spacer(Modifier.weight(1f))
        when (sales.verdict) {
            "cheaper" -> Txt(sales.verdictText ?: "便宜", sans(12.sp, Palette.Ink), Modifier.background(Palette.Marker).padding(horizontal = 4.dp))
            "pricier" -> Txt(sales.verdictText ?: "贵了", sans(12.sp, Palette.AlertText))
            "even" -> Txt(sales.verdictText ?: "基本持平", sans(12.sp, Palette.Ink2))
        }
    }
}

/** 同名的其余卖家：价格就是链接，点哪个开哪个。 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Others(others: List<OtherSeller>) {
    val context = LocalContext.current
    val prices = others.filter { !it.auction }.mapNotNull { it.price }.filter { it in 2 until 1_000_000 }
    val range = when {
        others.size < 2 || prices.isEmpty() -> ""
        prices.min() == prices.max() -> " · ${formatYen(prices.min())}"
        else -> " · ${formatYen(prices.min())}～${formatYen(prices.max())}"
    }
    Spacer(Modifier.height(12.dp))
    Column(Modifier.fillMaxWidth().background(Palette.Mist).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Txt("同名另有 ${others.size} 件$range", sans(12.sp, Palette.Ink))
        Spacer(Modifier.height(4.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            others.forEach { other ->
                Row(Modifier.tap { openUrl(context, other.url) }, verticalAlignment = Alignment.Bottom) {
                    Txt(
                        (if (other.auction) "拍 " else "") + (other.price?.let(::formatNumber) ?: "—"),
                        num(16.sp),
                        Modifier.padding(bottom = 1.dp),
                    )
                    Txt(" ${other.sourceLabel}", sans(11.sp, Palette.Mute), maxLines = 1)
                }
            }
        }
    }
}

