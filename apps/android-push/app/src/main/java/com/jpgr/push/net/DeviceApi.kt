package com.jpgr.push.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/** 一件待标的商品（主站 /api/device/labels）。 */
data class LabelItem(
    val profileId: String,
    val digestEventId: String,
    val digestAt: Long,
    val sourceId: String,
    val sourceName: String,
    val sourceItemId: String,
    val title: String,
    val url: String?,
    val imageUrl: String?,
    val price: Long?,
    val auction: Boolean,
    /** hide = 不想看，keep = 还想看，null = 没标。 */
    val verdict: String?,
) {
    val key: String get() = "$profileId|$sourceId|$sourceItemId"
}

data class LabelPage(val profiles: List<Pair<String, String>>, val items: List<LabelItem>, val windowDays: Int)

/** 一件被排除词挡掉的商品。term：命中的排除词；inTitle=false 表示只在说明或店名里出现，最容易是误伤。 */
data class ExcludedItem(
    val profileId: String,
    val sourceId: String,
    val sourceName: String,
    val sourceItemId: String,
    val title: String,
    val url: String?,
    val imageUrl: String?,
    val price: Long?,
    val auction: Boolean,
    val listedAt: Long,
    val term: String,
    val inTitle: Boolean,
    val wanted: Boolean,
) {
    val key: String get() = "$profileId|$sourceId|$sourceItemId"
}

data class ExcludedPage(val profiles: List<Pair<String, String>>, val items: List<ExcludedItem>, val windowDays: Int)

data class WatchState(val active: Set<String>, val limit: Int, val activeCount: Int)

/**
 * 主站给手机开的窄接口（apps/web/src/app/api/device/…）：只有列表标注和「等降价」两件事。
 * 和 push-relay 用同一个设备口令。
 */
class DeviceApi(http: OkHttpClient, private val base: String) {
    private val client = http.newBuilder().readTimeout(20, TimeUnit.SECONDS).build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun labels(token: String): LabelPage = withContext(Dispatchers.IO) {
        val body = execute(request(token, "/api/device/labels").build())
        val profiles = body.optJSONArray("profiles")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { it.optString("id") to it.optString("name") }
        } ?: emptyList()
        val items = body.optJSONArray("items")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { item ->
                LabelItem(
                    profileId = item.optString("profileId"),
                    digestEventId = item.optString("digestEventId"),
                    digestAt = runCatching { Instant.parse(item.optString("digestAt")).toEpochMilli() }.getOrDefault(0L),
                    sourceId = item.optString("sourceId"),
                    sourceName = item.optString("sourceName"),
                    sourceItemId = item.optString("sourceItemId"),
                    title = item.optString("title").ifEmpty { "未命名商品" },
                    url = item.optString("url").takeIf { !item.isNull("url") && it.isNotEmpty() },
                    imageUrl = item.optString("imageUrl").takeIf { !item.isNull("imageUrl") && it.isNotEmpty() },
                    price = if (item.isNull("price")) null else item.optLong("price"),
                    auction = item.optBoolean("auction"),
                    verdict = item.optString("verdict").takeIf { !item.isNull("verdict") && it.isNotEmpty() },
                )
            }
        } ?: emptyList()
        LabelPage(profiles, items, body.optInt("windowDays", 7))
    }

    /** verdict：hide / keep / undo。 */
    suspend fun label(token: String, item: LabelItem, verdict: String) = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("profileId", item.profileId)
            .put("digestEventId", item.digestEventId)
            .put("sourceId", item.sourceId)
            .put("sourceItemId", item.sourceItemId)
            .put("verdict", verdict)
        execute(request(token, "/api/device/labels").post(payload.toString().toRequestBody(jsonType)).build())
        Unit
    }

    /** 被排除词挡掉、没进推送的商品（主站 /api/device/excluded）。 */
    suspend fun excluded(token: String): ExcludedPage = withContext(Dispatchers.IO) {
        val body = execute(request(token, "/api/device/excluded").build())
        val profiles = body.optJSONArray("profiles")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { it.optString("id") to it.optString("name") }
        } ?: emptyList()
        val items = body.optJSONArray("items")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { item ->
                ExcludedItem(
                    profileId = item.optString("profileId"),
                    sourceId = item.optString("sourceId"),
                    sourceName = item.optString("sourceName"),
                    sourceItemId = item.optString("sourceItemId"),
                    title = item.optString("title").ifEmpty { "未命名商品" },
                    url = item.optString("url").takeIf { !item.isNull("url") && it.isNotEmpty() },
                    imageUrl = item.optString("imageUrl").takeIf { !item.isNull("imageUrl") && it.isNotEmpty() },
                    price = if (item.isNull("price")) null else item.optLong("price"),
                    auction = item.optBoolean("auction"),
                    listedAt = runCatching { Instant.parse(item.optString("listedAt")).toEpochMilli() }.getOrDefault(0L),
                    term = item.optString("term"),
                    inTitle = item.optBoolean("inTitle"),
                    wanted = item.optBoolean("wanted"),
                )
            }
        } ?: emptyList()
        ExcludedPage(profiles, items, body.optInt("windowDays", 7))
    }

    /** 「挡错了」：对排除词的反馈（服务端存成不挂日报的 keep 记录）；wanted=false 撤销。 */
    suspend fun want(token: String, item: ExcludedItem, wanted: Boolean) = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("profileId", item.profileId)
            .put("sourceId", item.sourceId)
            .put("sourceItemId", item.sourceItemId)
            .put("wanted", wanted)
        execute(request(token, "/api/device/excluded").post(payload.toString().toRequestBody(jsonType)).build())
        Unit
    }

    suspend fun watches(token: String): WatchState = withContext(Dispatchers.IO) {
        val body = execute(request(token, "/api/device/watches").build())
        val array = body.optJSONArray("items")
        val active = if (array == null) emptySet() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
            .filter { it.optBoolean("active") }
            .map { "${it.optString("sourceId")}|${it.optString("sourceItemId")}" }
            .toSet()
        WatchState(active, body.optInt("limit", 30), body.optInt("active", active.size))
    }

    /** 开始等降价；返回 true 表示在盯了（false：来源暂停了监控，档案建了但没在跑）。 */
    suspend fun watch(token: String, sourceId: String, sourceItemId: String): Boolean = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("sourceId", sourceId).put("sourceItemId", sourceItemId)
        execute(request(token, "/api/device/watches").post(payload.toString().toRequestBody(jsonType)).build())
            .optBoolean("watching", true)
    }

    suspend fun unwatch(token: String, sourceId: String, sourceItemId: String) = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("sourceId", sourceId).put("sourceItemId", sourceItemId)
        execute(request(token, "/api/device/watches").delete(payload.toString().toRequestBody(jsonType)).build())
        Unit
    }

    private fun request(token: String, path: String): Request.Builder =
        Request.Builder().url(base + path).header("Authorization", "Bearer $token")

    private fun execute(request: Request): JSONObject {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (response.code == 401) throw RelayException("口令不对（401）", 401)
            if (!response.isSuccessful) {
                throw RelayException(readableError(json?.optString("error"), response.code), response.code)
            }
            return json ?: JSONObject()
        }
    }

    /** 服务端错误码 → 给人看的话。 */
    private fun readableError(code: String?, status: Int): String = when (code) {
        "watch_limit_reached" -> "同时最多盯 30 件，先取消几件再加"
        "terminal_listing_requires_product_radar" -> "已经卖掉或下架了，没法等降价"
        "watch_profile_completed" -> "这件以前标过已买到，不再盯"
        "listing_not_found" -> "库里找不到这件商品"
        "source_monitoring_paused" -> "这个来源的单品监控暂停中"
        "digest_not_found", "digest_item_not_found" -> "这条日报已经过期了"
        null, "" -> "服务器返回 $status"
        else -> "出错了：$code"
    }
}
