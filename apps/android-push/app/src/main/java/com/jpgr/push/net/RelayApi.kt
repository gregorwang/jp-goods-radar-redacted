package com.jpgr.push.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class RelayException(message: String, val httpStatus: Int? = null) : IOException(message)

/** push-relay 的几个接口（apps/push-relay/src/index.ts）。 */
class RelayApi(private val http: OkHttpClient, private val base: String) {
    private val rest = http.newBuilder().readTimeout(20, TimeUnit.SECONDS).build()

    fun connect(token: String, listener: WebSocketListener): WebSocket {
        val url = base.replaceFirst("https://", "wss://") + "/connect"
        return http.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $token").build(), listener)
    }

    /** after 之后的全部消息，从旧到新。一页 50 条，翻到底。 */
    suspend fun messagesAfter(token: String, after: Long): List<JSONObject> = withContext(Dispatchers.IO) {
        val all = mutableListOf<JSONObject>()
        var cursor = after
        while (true) {
            val body = get(token, "/messages?after=$cursor&limit=50")
            val array = body.optJSONArray("messages") ?: break
            val page = (0 until array.length()).mapNotNull { array.optJSONObject(it) }
            all += page
            if (page.size < 50) break
            cursor = page.last().optLong("id", cursor)
        }
        all
    }

    suspend fun sendTest(token: String): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$base/test").header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null)).build()
        execute(request)
    }

    /** 各档案最近一轮巡回（apps/push-relay 的 /rounds）。 */
    suspend fun rounds(token: String): List<JSONObject> = withContext(Dispatchers.IO) {
        val array = get(token, "/rounds").optJSONArray("rounds") ?: return@withContext emptyList()
        (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }

    suspend fun status(token: String): JSONObject = withContext(Dispatchers.IO) { get(token, "/status") }

    private fun get(token: String, path: String): JSONObject =
        execute(Request.Builder().url(base + path).header("Authorization", "Bearer $token").build())

    private fun execute(request: Request): JSONObject {
        rest.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 401) throw RelayException("口令不对（401）", 401)
            if (!response.isSuccessful) throw RelayException("服务器返回 ${response.code}", response.code)
            return JSONObject(text)
        }
    }
}
