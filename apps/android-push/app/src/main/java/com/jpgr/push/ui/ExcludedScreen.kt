package com.jpgr.push.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import com.jpgr.push.net.ExcludedItem
import kotlinx.coroutines.launch

/**
 * 被筛掉的：推送档案里被排除词挡掉、没推给你的商品（2026-10-12 用户要的——加了排除词又怕漏，隔几天回头扫一眼）。
 * 按 IP 分开，再按命中的排除词分；每行写明被哪个词挡的，只在说明 / 店名里命中的（最可能挡错）标赭红。
 * 不该挡的点「挡错了」：只是对排除词的反馈（存成一条不挂日报的 keep 记录），用来收窄那条词；
 * 不是第二种标注——标注只有「不想看」一种（用户 2026-10-12 定）。点图或标题直接去来源看。
 */
@Composable
fun ExcludedScreen(onBack: () -> Unit) {
    val app = remember { PushApp.instance }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var items by remember { mutableStateOf<List<ExcludedItem>?>(null) }
    var windowDays by remember { mutableIntStateOf(7) }
    var error by remember { mutableStateOf<String?>(null) }
    var profile by remember { mutableStateOf<String?>(null) }
    var term by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<Set<String>>(emptySet()) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        error = null
        try {
            val page = app.device.excluded(app.tokens.token())
            profiles = page.profiles
            items = page.items
            windowDays = page.windowDays
            if (profile == null || page.profiles.none { it.first == profile }) {
                profile = page.profiles.maxByOrNull { (id, _) -> page.items.count { it.profileId == id } }?.first
            }
        } catch (failure: Exception) {
            error = failure.message ?: "没连上主站"
            if (items == null) items = emptyList()
        }
    }

    fun toggleWanted(item: ExcludedItem) {
        if (item.key in busy) return
        val before = items
        items = items?.map { if (it.key == item.key) it.copy(wanted = !item.wanted) else it }
        busy = busy + item.key
        error = null
        scope.launch {
            try {
                app.device.want(app.tokens.token(), item, !item.wanted)
            } catch (failure: Exception) {
                items = before
                error = "没存上：${failure.message ?: "没连上主站"}"
            } finally {
                busy = busy - item.key
            }
        }
    }

    val inProfile = items.orEmpty().filter { it.profileId == profile }
    val terms = inProfile.groupingBy { it.term }.eachCount().entries.sortedByDescending { it.value }
    val shown = inProfile.filter { term == null || it.term == term }

    Column(Modifier.fillMaxSize()) {
        BrandBar {
            LineButton("刷新", { reload += 1 }, color = Palette.Ink2, textSize = 12.sp)
            Spacer(Modifier.width(18.dp))
            LineButton("← 收件", onBack, color = Palette.Ink2, textSize = 12.sp)
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 30.dp, bottom = 10.dp)) {
                    Txt("FILTERED", sans(11.sp, Palette.Mute, 0.2.em))
                    Spacer(Modifier.height(6.dp))
                    Txt("被筛掉的", serif(28.sp))
                    Spacer(Modifier.height(6.dp))
                    Txt(
                        "最近 $windowDays 天上架、被排除词挡掉没推给你的商品。哪件不该挡，点「挡错了」，我据此把那条排除词改窄。",
                        sans(13.sp, Palette.Ink2),
                    )
                }
                IpTabs(profiles, { id -> items.orEmpty().count { it.profileId == id } }, profile) {
                    profile = it
                    term = null
                }
                if (terms.size > 1) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        UnderlineTab("全部词", term == null, { term = null })
                        terms.forEach { (value, count) -> UnderlineTab("「$value」$count", term == value, { term = value }) }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Hairline(Palette.Ink, Modifier.padding(horizontal = 24.dp))
                error?.let { Txt(it, sans(12.sp, Palette.AlertText), Modifier.padding(horizontal = 24.dp, vertical = 10.dp)) }
            }
            when {
                items == null -> item { Txt("正在拉取…", sans(14.sp, Palette.Mute), Modifier.padding(24.dp)) }
                shown.isEmpty() -> item { Txt("这个 IP 最近没有被挡掉的商品。", sans(14.sp, Palette.Mute), Modifier.padding(24.dp)) }
                else -> shown.groupBy { dayOf(it.listedAt) }.forEach { (day, dayItems) ->
                    item(key = "day:$day") {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 18.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.Bottom,
                        ) {
                            Txt(dayLabel(day), serif(15.sp))
                            Spacer(Modifier.width(10.dp))
                            Txt("${dayItems.size} 件", sans(12.sp, Palette.Mute))
                        }
                    }
                    items(dayItems, key = { it.key }) { item ->
                        ExcludedRow(item, item.key in busy, onOpen = { openUrl(context, item.url) }, onWant = { toggleWanted(item) })
                    }
                }
            }
            item { Spacer(Modifier.height(40.dp)) }
        }
    }
}

@Composable
private fun ExcludedRow(item: ExcludedItem, busy: Boolean, onOpen: () -> Unit, onWant: () -> Unit) {
    Column(Modifier.padding(horizontal = 24.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).tap(onOpen), verticalAlignment = Alignment.CenterVertically) {
                val thumb = Modifier.size(64.dp).background(Palette.Mist)
                if (item.imageUrl != null) {
                    AsyncImage(model = item.imageUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = thumb)
                } else {
                    Spacer(thumb)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Txt(item.title, sans(13.sp, Palette.Ink, 0.02.em), maxLines = 2)
                    Row(verticalAlignment = Alignment.Bottom) {
                        Txt((if (item.auction) "拍 " else "") + (item.price?.let(::formatNumber) ?: "—"), num(17.sp))
                        Txt(" 円 · ${item.sourceName}", sans(11.sp, Palette.Mute), maxLines = 1)
                    }
                    Txt(
                        "被「${item.term}」挡掉" + if (item.inTitle) "" else " · 只在说明里出现",
                        sans(11.sp, if (item.inTitle) Palette.Mute else Palette.AlertText),
                        maxLines = 1,
                    )
                }
            }
            Spacer(Modifier.width(10.dp))
            ChoiceButton("挡错了", item.wanted, Palette.SkyText, onWant, enabled = !busy)
        }
        Hairline()
    }
}
