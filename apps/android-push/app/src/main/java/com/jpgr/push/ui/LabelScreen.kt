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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import com.jpgr.push.PushApp
import com.jpgr.push.net.LabelItem
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private enum class LabelTab { Todo, Done }

/**
 * 列表标注（2026-10-12 用户要的）：最近几天推过的商品按 IP 分开，一行一件，每行右边只有一个「不想看」，
 * 点一下就存，再点一次撤销。没点的就当可以留——不设「还想看」，免得两种结论互相打架（用户定）。
 * 「没标的」这一栏里刚标完的那行变淡但留在原位，方便看出标到哪儿了；切栏或刷新才收走。
 * 结论存在主站（digest_item_labels），和主站标注页是同一份。
 */
@Composable
fun LabelScreen(onBack: () -> Unit) {
    val app = remember { PushApp.instance }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var profiles by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var items by remember { mutableStateOf<List<LabelItem>?>(null) }
    var windowDays by remember { mutableIntStateOf(7) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf(LabelTab.Todo) }
    var profileFilter by remember { mutableStateOf<String?>(null) }
    /** 进「没标的」那一刻还没标的那些：标完不立刻消失。 */
    var todoSnapshot by remember { mutableStateOf<Set<String>>(emptySet()) }
    var busy by remember { mutableStateOf<Set<String>>(emptySet()) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        loadError = null
        try {
            val page = app.device.labels(app.tokens.token())
            profiles = page.profiles
            // 只有「不想看」一种结论（2026-10-12 用户定：想看 / 不想看两套会互相打架）。以前标的「还想看」当没标。
            items = page.items.map { if (it.verdict == "keep") it.copy(verdict = null) else it }
            windowDays = page.windowDays
            todoSnapshot = page.items.filter { it.verdict == null }.map { it.key }.toSet()
            // 按 IP 分开标：默认打开没标的最多的那个 IP。
            if (profileFilter == null || page.profiles.none { it.first == profileFilter }) {
                profileFilter = page.profiles.maxByOrNull { (id, _) -> page.items.count { it.profileId == id && it.verdict == null } }?.first
            }
        } catch (error: Exception) {
            loadError = error.message ?: "没连上主站"
            if (items == null) items = emptyList()
        }
    }

    fun toggleHide(item: LabelItem) {
        if (item.key in busy) return
        val next = if (item.verdict == "hide") null else "hide"
        val before = items
        items = items?.map { if (it.key == item.key) it.copy(verdict = next) else it }
        busy = busy + item.key
        saveError = null
        scope.launch {
            try {
                app.device.label(app.tokens.token(), item, next ?: "undo")
            } catch (error: Exception) {
                items = before
                saveError = "没存上：${error.message ?: "没连上主站"}"
            } finally {
                busy = busy - item.key
            }
        }
    }

    val all = items.orEmpty().filter { it.profileId == profileFilter }
    val todoCount = all.count { it.verdict == null }
    val doneCount = all.size - todoCount
    val shown = when (tab) {
        LabelTab.Todo -> all.filter { it.key in todoSnapshot }
        LabelTab.Done -> all.filter { it.verdict != null && it.key !in todoSnapshot }
    }

    Column(Modifier.fillMaxSize()) {
        BrandBar {
            LineButton("刷新", { reload += 1 }, color = Palette.Ink2, textSize = 12.sp)
            Spacer(Modifier.width(18.dp))
            LineButton("← 收件", onBack, color = Palette.Ink2, textSize = 12.sp)
        }
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 30.dp, bottom = 10.dp)) {
                    Txt("LABEL", sans(11.sp, Palette.Mute, 0.2.em))
                    Spacer(Modifier.height(6.dp))
                    Txt("标注", serif(28.sp))
                    Spacer(Modifier.height(6.dp))
                    Txt("最近 $windowDays 天推过的商品，按 IP 分开。不想再看到这类的点「不想看」，再点一次撤销；没点的就当可以留。攒够了我按这些总结排除规则。", sans(13.sp, Palette.Ink2))
                }
                // 第一层：按 IP 分开（每个 IP 一栏，后面是没标的件数），不混在一个列表里。
                IpTabs(profiles, { id -> items.orEmpty().count { it.profileId == id && it.verdict == null } }, profileFilter) { id ->
                    profileFilter = id
                    if (tab == LabelTab.Todo) todoSnapshot = items.orEmpty().filter { it.verdict == null }.map { it.key }.toSet()
                }
                Spacer(Modifier.height(4.dp))
                Row(Modifier.padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                    UnderlineTab("没标的 $todoCount", tab == LabelTab.Todo, {
                        tab = LabelTab.Todo
                        todoSnapshot = items.orEmpty().filter { it.verdict == null }.map { it.key }.toSet()
                    })
                    UnderlineTab("不想看的 $doneCount", tab == LabelTab.Done, {
                        tab = LabelTab.Done
                        todoSnapshot = emptySet()
                    })
                }
                Spacer(Modifier.height(6.dp))
                Hairline(Palette.Ink, Modifier.padding(horizontal = 24.dp))
                (saveError ?: loadError)?.let {
                    Txt(it, sans(12.sp, Palette.AlertText), Modifier.padding(horizontal = 24.dp, vertical = 10.dp))
                }
            }
            when {
                items == null -> item { Txt("正在拉取…", sans(14.sp, Palette.Mute), Modifier.padding(24.dp)) }
                shown.isEmpty() -> item {
                    Txt(
                        if (tab == LabelTab.Todo) "都看完了。" else "还没有点过「不想看」的。",
                        sans(14.sp, Palette.Mute),
                        Modifier.padding(24.dp),
                    )
                }
                // 按推送日分段，一天一个小标题：标完今天的就可以停，不用一口气标完三天。
                else -> shown.groupBy { dayOf(it.digestAt) }.forEach { (day, dayItems) ->
                    item(key = "day:$day") {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 18.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.Bottom,
                        ) {
                            Txt(dayLabel(day), serif(15.sp))
                            Spacer(Modifier.width(10.dp))
                            Txt("${dayItems.size} 件 · 没标 ${dayItems.count { it.verdict == null }}", sans(12.sp, Palette.Mute))
                        }
                    }
                    items(dayItems, key = { it.key }) { item ->
                        LabelRow(
                            item = item,
                            profileName = null,
                            busy = item.key in busy,
                            onOpen = { openUrl(context, item.url) },
                            onHide = { toggleHide(item) },
                        )
                    }
                }
            }
            item { Spacer(Modifier.height(40.dp)) }
        }
    }
}

/** IP（档案）选择行：每个 IP 一个下划线标签，后面跟一个数（没标的 / 被筛掉的件数）。横向可滑。 */
@Composable
internal fun IpTabs(profiles: List<Pair<String, String>>, count: (String) -> Int, selected: String?, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        profiles.forEach { (id, name) ->
            UnderlineTab("${name.removeSuffix("上新")} ${count(id)}", selected == id, { onSelect(id) })
        }
    }
}

internal fun dayOf(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate()

internal fun dayLabel(day: LocalDate): String {
    val today = LocalDate.now(ZoneId.systemDefault())
    return when (day) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else -> "${day.monthValue}月${day.dayOfMonth}日"
    }
}

@Composable
private fun LabelRow(item: LabelItem, profileName: String?, busy: Boolean, onOpen: () -> Unit, onHide: () -> Unit) {
    // 「没标的」里刚点了不想看：变淡，但留在原位。
    val settled = item.verdict != null
    Column(Modifier.padding(horizontal = 24.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).tap(onOpen).alpha(if (settled) 0.45f else 1f), verticalAlignment = Alignment.CenterVertically) {
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
                        Txt(
                            (if (item.auction) "拍 " else "") + (item.price?.let(::formatNumber) ?: "—"),
                            num(17.sp),
                        )
                        Txt(" 円 · ${item.sourceName}", sans(11.sp, Palette.Mute), maxLines = 1)
                    }
                    Txt(
                        listOfNotNull(profileName, formatWhen(item.digestAt)).joinToString(" · "),
                        sans(11.sp, Palette.SkyText),
                        maxLines = 1,
                    )
                }
            }
            Spacer(Modifier.width(10.dp))
            ChoiceButton("不想看", item.verdict == "hide", Palette.Alert, onHide, enabled = !busy)
        }
        Hairline()
    }
}
