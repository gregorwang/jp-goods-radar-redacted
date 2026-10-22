@file:OptIn(ExperimentalTextApi::class)

package com.jpgr.push.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.jpgr.push.R
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * 设计语言和日报邮件同一套（packages/email/src/design.ts）：
 * 白底 + 发丝线，宋体标题，数字用 Cormorant，墨色胶囊主按钮 + 下划线次按钮，
 * 天蓝只做点缀，荧光笔底色标「便宜」，赭红只给「贵了」和「拍卖」。不用阴影卡片、大圆角、Material 紫。
 */
object Palette {
    val Ink = Color(0xFF111111)
    val Ink2 = Color(0xFF4A4A4A)
    val Mute = Color(0xFF6B6B6B)
    val Faint = Color(0xFFA1A1A1)
    val Line = Color(0xFFE6E6E6)
    val LineSoft = Color(0xFFEFEFEF)
    val LineStrong = Color(0xFF9F9F9F)
    val Mist = Color(0xFFF4F6F7)
    val Sky = Color(0xFF45BFE8)
    val SkyText = Color(0xFF1A7CA3)
    val SkyTint = Color(0xFFEEF5F8)
    val SkySoft = Color(0xFFCDEBF6)
    val Marker = Color(0xFFF1EA8C)
    val Lemon = Color(0xFFE8E15D)
    val LemonText = Color(0xFF6B6420)
    val LemonTint = Color(0xFFFDFBE4)
    val Alert = Color(0xFFC24E1C)
    val AlertText = Color(0xFFA8431A)
    val White = Color.White
}

object Fonts {
    val Serif = FontFamily(Font(R.font.noto_serif_sc))
    val Num = FontFamily(
        Font(R.font.cormorant_garamond, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
    )
    val Sans = FontFamily.Default
}

fun serif(size: TextUnit, color: Color = Palette.Ink, spacing: TextUnit = 0.08.em) =
    TextStyle(fontFamily = Fonts.Serif, fontSize = size, color = color, letterSpacing = spacing, lineHeight = size * 1.45f)

fun sans(size: TextUnit, color: Color = Palette.Ink, spacing: TextUnit = 0.04.em) =
    TextStyle(fontFamily = Fonts.Sans, fontSize = size, color = color, letterSpacing = spacing, lineHeight = size * 1.65f)

fun num(size: TextUnit, color: Color = Palette.Ink) =
    TextStyle(fontFamily = Fonts.Num, fontSize = size, color = color, lineHeight = size * 1.1f)

@Composable
fun Txt(
    text: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
) {
    BasicText(text, modifier, style, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

/** 去掉按下时的系统水波纹，按下的反馈由各控件自己画。 */
@Composable
fun Modifier.tap(onClick: () -> Unit): Modifier =
    clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)

@Composable
fun Hairline(color: Color = Palette.LineSoft, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(color))
}

/** 墨色胶囊主按钮。 */
@Composable
fun InkButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .background(Palette.Ink, RoundedCornerShape(999.dp))
            .then(if (enabled) Modifier.tap(onClick) else Modifier)
            .padding(horizontal = 28.dp, vertical = 12.dp),
    ) {
        Txt("$label →", sans(14.sp, Palette.White, 0.16.em))
    }
}

/** 下划线次按钮 / 文字链接。 */
@Composable
fun LineButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Palette.Ink, textSize: TextUnit = 13.sp) {
    Txt(
        label,
        sans(textSize, color, 0.08.em),
        modifier
            .tap(onClick)
            .padding(vertical = 4.dp)
            .drawBehind {
                val y = size.height + 1.dp.toPx()
                drawLine(color, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
            },
    )
}

/** 发丝线圆角小签：来源。 */
@Composable
fun Pill(label: String, modifier: Modifier = Modifier) {
    Txt(
        label,
        sans(11.sp, Palette.Ink2, 0.08.em),
        modifier
            .border(1.dp, Color(0xFFCFCFCF), RoundedCornerShape(999.dp))
            .padding(horizontal = 9.dp, vertical = 1.dp),
        maxLines = 1,
    )
}

enum class TagTone { Alert, Bundle, Kind, Mute }

/** 方角标签：拍卖（赭红）/ 打包（柠檬）/ 性质（天蓝）。 */
@Composable
fun Tag(label: String, tone: TagTone, modifier: Modifier = Modifier) {
    val (border, text, fill) = when (tone) {
        TagTone.Alert -> Triple(Palette.Alert, Palette.AlertText, Palette.White)
        TagTone.Bundle -> Triple(Palette.Lemon, Palette.LemonText, Palette.LemonTint)
        TagTone.Kind -> Triple(Palette.SkySoft, Palette.SkyText, Palette.SkyTint)
        TagTone.Mute -> Triple(Palette.Line, Palette.Mute, Palette.White)
    }
    Txt(
        label,
        sans(11.sp, text, 0.1.em),
        modifier.background(fill).border(1.dp, border).padding(horizontal = 6.dp, vertical = 0.dp),
        maxLines = 1,
    )
}

@Composable
fun Dot(color: Color, size: Dp = 6.dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).background(color, CircleShape))
}

/** 顶部品牌行：天蓝圆点 + 格银西里尔，右边放这一屏的操作。 */
@Composable
fun BrandBar(right: @Composable () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(Palette.Sky)
        Spacer(Modifier.width(10.dp))
        Txt("格银西里尔", serif(15.sp, spacing = 0.14.em))
        Spacer(Modifier.weight(1f))
        right()
    }
    Hairline(Palette.Line)
}

/** 下划线标签（分段选择）：选中的墨色加下划线，其余弱灰。不用原生 Tab / 下拉。 */
@Composable
fun UnderlineTab(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val color = if (selected) Palette.Ink else Palette.Mute
    Txt(
        label,
        sans(13.sp, color, 0.06.em),
        modifier
            .tap(onClick)
            .padding(vertical = 6.dp)
            .drawBehind {
                if (selected) {
                    val y = size.height - 1.dp.toPx()
                    drawLine(Palette.Ink, Offset(0f, y), Offset(size.width, y), 2.dp.toPx())
                }
            },
        maxLines = 1,
    )
}

/** 小号胶囊按钮（标注行里那两个）：选中时实心，未选中发丝线描边。 */
@Composable
fun ChoiceButton(label: String, selected: Boolean, tone: Color, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .then(
                if (selected) Modifier.background(tone, RoundedCornerShape(999.dp))
                else Modifier.border(1.dp, Palette.LineStrong, RoundedCornerShape(999.dp)),
            )
            .then(if (enabled) Modifier.tap(onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Txt(label, sans(13.sp, if (selected) Palette.White else Palette.Ink, 0.08.em), maxLines = 1)
    }
}

// ---- 格式 ----

private val zone: ZoneId get() = ZoneId.systemDefault()
private val clock = DateTimeFormatter.ofPattern("HH:mm", Locale.CHINA)
private val clockSeconds = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.CHINA)
private val monthDay = DateTimeFormatter.ofPattern("M月d日 HH:mm", Locale.CHINA)

fun formatClock(millis: Long): String = clock.format(Instant.ofEpochMilli(millis).atZone(zone))

fun formatClockSeconds(millis: Long): String = clockSeconds.format(Instant.ofEpochMilli(millis).atZone(zone))

/** 今天的只写时刻，昨天写「昨天」，明天写「明天」（下一轮巡回的时间），其余写月日。 */
fun formatWhen(millis: Long): String {
    val at = Instant.ofEpochMilli(millis).atZone(zone)
    val today = LocalDate.now(zone)
    return when (at.toLocalDate()) {
        today -> "今天 ${clock.format(at)}"
        today.minusDays(1) -> "昨天 ${clock.format(at)}"
        today.plusDays(1) -> "明天 ${clock.format(at)}"
        else -> monthDay.format(at)
    }
}

fun formatYen(price: Long?): String = if (price == null) "价格未取得" else "%,d 円".format(price)

fun formatNumber(value: Long): String = "%,d".format(value)

/** 和日报邮件的 timeAgo 同一口径。 */
fun timeAgo(millis: Long?, now: Long = System.currentTimeMillis()): String? {
    if (millis == null) return null
    val minutes = maxOf(0L, (now - millis) / 60_000)
    return when {
        minutes < 60 -> "${maxOf(1L, minutes)} 分钟前"
        minutes < 48 * 60 -> "${minutes / 60} 小时前"
        else -> "${minutes / (24 * 60)} 天前"
    }
}

/** 上架和更新差不到一小时只说一个；差得多两个都说（邮件 listingTiming 同一规则）。 */
fun listingTiming(listedAt: Long?, updatedAt: Long?): List<String> {
    val listed = timeAgo(listedAt)
    val updated = timeAgo(updatedAt)
    if (listed != null && updated != null && listedAt != null && updatedAt != null && updatedAt - listedAt >= 60 * 60_000) {
        return listOf("${updated}更新", "${listed}上架")
    }
    if (listed != null) return listOf("${listed}上架")
    return listOfNotNull(updated?.let { "${it}更新" })
}
