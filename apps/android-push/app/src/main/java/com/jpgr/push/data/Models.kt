package com.jpgr.push.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * push-relay 推来的一条消息。结构由 collector 的 push-delivery.ts（PushMessage）定义，
 * 排序和同名折叠已经在服务端做完，这里照顺序显示。
 */
data class PushMessage(
    val id: Long,
    val eventKey: String,
    val kind: String,
    val profileId: String,
    val profileName: String,
    val createdAt: Long,
    val total: Int,
    val groupTotal: Int,
    val failedSources: List<String>,
    val items: List<PushItem>,
) {
    /** 「赛车初音上新」→「赛车初音」：通知标题后面已经写了「几件新货」。 */
    val shortName: String get() = profileName.removeSuffix("上新").trim().ifEmpty { profileName }
}

data class PushItem(
    val sourceId: String,
    /** 来源商品号：「等降价」按它找商品。旧消息没有这个字段。 */
    val sourceItemId: String?,
    val sourceLabel: String,
    val title: String,
    val price: Long?,
    val auction: Boolean,
    val bidCount: Int?,
    val auctionEndsAt: Long?,
    val bundle: Boolean,
    val recovered: Boolean,
    val imageUrl: String?,
    val url: String?,
    val listedAt: Long?,
    val updatedAt: Long?,
    val sales: PushSales?,
    val others: List<OtherSeller>,
) {
    /** 本机记「点开过」用的键：有链接用链接，没有就用来源 + 标题。 */
    val openKey: String get() = url ?: "$sourceId|$title"
}

data class PushSales(
    val label: String,
    val median: Long,
    val n: Int,
    /** cheaper / pricier / even；拍卖不比，为 null。 */
    val verdict: String?,
    val verdictText: String?,
)

data class OtherSeller(val sourceLabel: String, val price: Long?, val auction: Boolean, val url: String?)

private fun JSONObject.str(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null

private fun JSONObject.long(key: String): Long? =
    if (has(key) && !isNull(key)) optDouble(key).takeIf { !it.isNaN() }?.toLong() else null

private fun JSONObject.time(key: String): Long? =
    str(key)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

fun parsePushMessage(json: JSONObject): PushMessage {
    val items = json.optJSONArray("items").objects().map { item ->
        val sales = item.optJSONObject("sales")?.let {
            PushSales(
                label = it.str("label") ?: "同款成交",
                median = it.long("median") ?: 0,
                n = it.optInt("n"),
                verdict = it.str("verdict"),
                verdictText = it.str("verdictText"),
            )
        }?.takeIf { it.median > 0 }
        PushItem(
            sourceId = item.str("sourceId") ?: "",
            sourceItemId = item.str("sourceItemId"),
            sourceLabel = item.str("sourceLabel") ?: item.str("sourceId") ?: "未知来源",
            title = item.str("title") ?: "未命名商品",
            price = item.long("price"),
            auction = item.optBoolean("auction"),
            bidCount = item.long("bidCount")?.toInt(),
            auctionEndsAt = item.time("auctionEndsAt"),
            bundle = item.optBoolean("bundle"),
            recovered = item.optBoolean("recovered"),
            imageUrl = item.str("imageUrl"),
            url = item.str("url"),
            listedAt = item.time("listedAt"),
            updatedAt = item.time("updatedAt"),
            sales = sales,
            others = item.optJSONArray("others").objects().map {
                OtherSeller(it.str("sourceLabel") ?: "", it.long("price"), it.optBoolean("auction"), it.str("url"))
            },
        )
    }
    return PushMessage(
        id = json.optLong("id"),
        eventKey = json.str("eventKey") ?: "",
        kind = json.str("kind") ?: "hourly_digest",
        profileId = json.str("profileId") ?: "",
        profileName = json.str("profileName") ?: "关键词雷达",
        createdAt = json.time("createdAt") ?: System.currentTimeMillis(),
        total = json.optInt("total", items.size),
        groupTotal = json.optInt("groupTotal", items.size),
        failedSources = json.optJSONArray("failedSources")?.let { array ->
            (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotEmpty) }
        } ?: emptyList(),
        items = items,
    )
}
