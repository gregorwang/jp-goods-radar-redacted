package com.jpgr.push.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * 最近几小时每一批巡回（push-relay 的 /rounds 和 {"type":"round"} 帧，collector 每跑完一批报一次，没新货也报）。
 * 首页顶上那行「上一轮几点跑完 · 几件新货 · 下一轮几点开跑」就靠它——没有它，"没推送"分不清是没货还是没跑。
 * 同一档案一小时里会分几批开跑（雅虎拍卖晚几分钟），所以按 (档案, 开跑时间) 存，算总数时把同一轮的几批加起来。
 */
data class RoundInfo(
    val profileId: String,
    val profileName: String,
    val scanStartedAt: Long,
    val finishedAt: Long,
    val newItems: Int,
    val failedSources: List<String>,
    val nextRunAt: Long?,
)

/** 首页那一行要的几个数（所有推送档案合起来）。 */
data class RoundSummary(
    /** 最近一轮（开跑时间和最晚一批相差 30 分钟内的都算同一轮）里最晚跑完的时间。 */
    val lastFinishedAt: Long,
    val profiles: Int,
    val newItems: Int,
    val failedSources: List<String>,
    /** 最近这一轮各批报上来的下一次开跑里最早的那个。 */
    val nextRunAt: Long?,
)

object Rounds {
    private const val PREFS = "rounds"
    private const val KEY = "latest"
    private const val SAME_ROUND_MS = 30 * 60_000L
    private const val KEEP_MS = 12 * 60 * 60_000L

    /** 键：档案 | 开跑时间。 */
    private val mutable = MutableStateFlow<Map<String, RoundInfo>>(emptyMap())
    val state: StateFlow<Map<String, RoundInfo>> = mutable

    private val RoundInfo.batchKey: String get() = "$profileId|$scanStartedAt"

    private fun parseTime(value: String?): Long? =
        value?.takeIf { it.isNotEmpty() && it != "null" }?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

    fun parse(json: JSONObject): RoundInfo? {
        val profileId = json.optString("profileId").takeIf { it.isNotEmpty() } ?: return null
        val finishedAt = parseTime(json.optString("finishedAt")) ?: return null
        val failed = json.optJSONArray("failedSources")
        return RoundInfo(
            profileId = profileId,
            profileName = json.optString("profileName").ifEmpty { "关键词雷达" },
            scanStartedAt = parseTime(json.optString("scanStartedAt")) ?: finishedAt,
            finishedAt = finishedAt,
            newItems = json.optInt("newItems"),
            failedSources = if (failed == null) emptyList() else (0 until failed.length()).mapNotNull { failed.optString(it).takeIf(String::isNotEmpty) },
            nextRunAt = if (json.isNull("nextRunAt")) null else parseTime(json.optString("nextRunAt")),
        )
    }

    private fun toJson(round: RoundInfo): JSONObject = JSONObject()
        .put("profileId", round.profileId)
        .put("profileName", round.profileName)
        .put("scanStartedAt", Instant.ofEpochMilli(round.scanStartedAt).toString())
        .put("finishedAt", Instant.ofEpochMilli(round.finishedAt).toString())
        .put("newItems", round.newItems)
        .put("failedSources", JSONArray(round.failedSources))
        .put("nextRunAt", round.nextRunAt?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)

    fun load(context: Context) {
        val text = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return
        mutable.value = (0 until array.length()).mapNotNull { array.optJSONObject(it)?.let(::parse) }.associateBy { it.batchKey }
    }

    /** 收到几批：同一批（档案 + 开跑时间）以更晚跑完的为准；只留最近 12 小时。 */
    fun upsert(context: Context, rounds: List<RoundInfo>) {
        val cutoff = System.currentTimeMillis() - KEEP_MS
        mutable.update { current ->
            val next = current.filterValues { it.finishedAt >= cutoff }.toMutableMap()
            for (round in rounds) {
                if (round.finishedAt < cutoff) continue
                val existing = next[round.batchKey]
                if (existing == null || existing.finishedAt <= round.finishedAt) next[round.batchKey] = round
            }
            next
        }
        val array = JSONArray()
        mutable.value.values.forEach { array.put(toJson(it)) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, array.toString()).apply()
    }

    fun summary(rounds: Collection<RoundInfo>, now: Long = System.currentTimeMillis()): RoundSummary? {
        if (rounds.isEmpty()) return null
        val latestStart = rounds.maxOf { it.scanStartedAt }
        val current = rounds.filter { latestStart - it.scanStartedAt <= SAME_ROUND_MS }
        return RoundSummary(
            lastFinishedAt = current.maxOf { it.finishedAt },
            profiles = current.map { it.profileId }.distinct().size,
            newItems = current.sumOf { it.newItems },
            failedSources = current.flatMap { it.failedSources }.distinct(),
            // 只看最近这一轮报上来的下一次开跑：更早几批报的「下一轮」早就过去了。
            nextRunAt = current.mapNotNull { it.nextRunAt }.minOrNull(),
        )
    }
}
