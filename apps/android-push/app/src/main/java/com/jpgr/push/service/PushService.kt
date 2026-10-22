package com.jpgr.push.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.jpgr.push.PushApp
import com.jpgr.push.data.MessageEntity
import com.jpgr.push.data.Rounds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * 常驻前台服务：守着到 push-relay 的 WebSocket（工程文档 §6.3）。
 *
 *   - 心跳：每 4 分钟一次（HeartbeatReceiver 的精确闹钟，深度休眠也会醒），发文本 `ping`，
 *     10 秒内没收到 `pong` 就当断线，立刻重连。
 *   - 重连：指数退避 1s→2s→…→60s 封顶；网络恢复 / 换网时立刻重连。
 *   - 每次连上（收到 hello）先 GET /messages?after=<本地最大 id> 补发，补到的照常弹通知，同一 id 不重复弹。
 *
 * 所有状态改动都在 [serial] 上做（单线程），OkHttp 的回调线程只负责把事件投递过来。
 */
class PushService : Service() {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val serial = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + serial)
    private val app get() = application as PushApp

    private var socket: WebSocket? = null
    /** 每次新建连接加一；旧连接迟到的回调按它丢掉。 */
    private var generation = 0
    private var attempt = 0
    private var reconnectJob: Job? = null
    private var pongTimeout: Job? = null
    private var currentNetwork: Network? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground()
        val prefs = app.status
        PushState.update {
            it.copy(
                serviceRunning = true,
                lastPongAt = prefs.lastPongAt,
                lastMessageAt = prefs.lastMessageAt,
                lastConnectedAt = prefs.lastConnectedAt,
            )
        }
        registerNetworkCallback()
        scope.launch { connect() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 每次 startForegroundService 都要在 5 秒内再调一次 startForeground。
        goForeground()
        when (intent?.action) {
            ACTION_HEARTBEAT -> scope.launch { heartbeat() }
            ACTION_RECONNECT -> scope.launch { reconnectNow("手动重连") }
            ACTION_ENSURE -> scope.launch { if (socket == null && reconnectJob?.isActive != true) connect() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        socket?.close(1000, "service stopped")
        socket = null
        HeartbeatReceiver.cancel(this)
        PushState.update { it.copy(serviceRunning = false, conn = PushState.Conn.STOPPED) }
        scope.cancel()
        super.onDestroy()
    }

    private fun goForeground() {
        startForeground(
            Notifier.SERVICE_NOTIFICATION_ID,
            Notifier.serviceNotification(this, PushState.state.value),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
    }

    private fun refreshServiceNotification() {
        Notifier.updateServiceNotification(this, PushState.state.value)
    }

    // ---- 连接 ----

    private fun connect() {
        val token = app.tokens.token()
        if (token.isEmpty()) {
            PushState.update { it.copy(conn = PushState.Conn.NO_TOKEN, lastError = null) }
            refreshServiceNotification()
            return
        }
        reconnectJob?.cancel()
        socket?.cancel()
        val myGeneration = ++generation
        PushState.update { it.copy(conn = PushState.Conn.CONNECTING, retryAt = null) }
        refreshServiceNotification()
        socket = app.relay.connect(token, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                scope.launch { if (myGeneration == generation) onOpened() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { if (myGeneration == generation) onText(webSocket, text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch { if (myGeneration == generation) onDropped("连接被关闭（$code）") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = if (response?.code == 401) "口令不对（401）" else t.message ?: t.javaClass.simpleName
                scope.launch { if (myGeneration == generation) onDropped(why, unauthorized = response?.code == 401) }
            }
        })
    }

    private fun onOpened() {
        attempt = 0
        val now = System.currentTimeMillis()
        app.status.lastConnectedAt = now
        app.status.lastPongAt = now
        PushState.update {
            it.copy(conn = PushState.Conn.ONLINE, lastError = null, lastConnectedAt = now, lastPongAt = now)
        }
        refreshServiceNotification()
        HeartbeatReceiver.schedule(this)
    }

    private fun onDropped(why: String, unauthorized: Boolean = false) {
        socket = null
        pongTimeout?.cancel()
        Log.i(TAG, "dropped: $why")
        PushState.update { it.copy(lastError = why) }
        // 口令错了重连也没用，等用户在连接页改口令（保存时会触发重连）。
        if (unauthorized) {
            PushState.update { it.copy(conn = PushState.Conn.BACKOFF, retryAt = null) }
            refreshServiceNotification()
            return
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        val seconds = minOf(60L, 1L shl minOf(attempt, 6))
        attempt += 1
        val retryAt = System.currentTimeMillis() + seconds * 1000
        PushState.update { it.copy(conn = PushState.Conn.BACKOFF, retryAt = retryAt) }
        refreshServiceNotification()
        reconnectJob = scope.launch {
            delay(seconds * 1000)
            connect()
        }
    }

    private fun reconnectNow(why: String) {
        Log.i(TAG, "reconnect now: $why")
        attempt = 0
        reconnectJob?.cancel()
        connect()
    }

    // ---- 心跳 ----

    private suspend fun heartbeat() {
        val wake = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jpgr:heartbeat")
        wake.acquire(30_000)
        try {
            HeartbeatReceiver.schedule(this)
            val current = socket
            if (current == null) {
                if (reconnectJob?.isActive != true) connect()
            } else {
                current.send("ping")
                pongTimeout?.cancel()
                pongTimeout = scope.launch {
                    delay(PONG_TIMEOUT_MS)
                    if (socket === current) {
                        current.cancel()
                        onDropped("心跳 10 秒没回应")
                    }
                }
            }
            // 给 pong / 重连 / 补发留出时间再放掉唤醒锁。
            delay(PONG_TIMEOUT_MS + 2_000)
        } finally {
            if (wake.isHeld) wake.release()
        }
    }

    // ---- 收消息 ----

    private suspend fun onText(webSocket: WebSocket, text: String) {
        if (text == "pong") {
            pongTimeout?.cancel()
            val now = System.currentTimeMillis()
            app.status.lastPongAt = now
            PushState.update { it.copy(lastPongAt = now) }
            refreshServiceNotification()
            return
        }
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (frame.optString("type")) {
            "hello" -> {
                syncRounds()
                catchUp(frame.optLong("latestId"))
            }
            "message" -> frame.optJSONObject("message")?.let { store(it, notify = true, socket = webSocket) }
            // 某个档案跑完一轮（没新货也报）：只更新首页那一行，不弹通知。
            "round" -> frame.optJSONObject("round")?.let(Rounds::parse)?.let { Rounds.upsert(this, listOf(it)) }
        }
    }

    /** 连上时把各档案最近一轮拉一遍：断线期间跑完的那几轮帧收不到。 */
    private suspend fun syncRounds() {
        val rounds = runCatching { app.relay.rounds(app.tokens.token()) }.getOrNull() ?: return
        Rounds.upsert(this, rounds.mapNotNull(Rounds::parse))
    }

    private suspend fun catchUp(latestId: Long) {
        val dao = app.db.messages()
        val localMax = dao.maxId() ?: 0
        if (latestId <= localMax) return
        // 第一次装好时本地是空的：把服务器上最近 7 天的拉下来当历史，不一条条弹通知。
        val firstSync = localMax == 0L
        val missed = runCatching { app.relay.messagesAfter(app.tokens.token(), localMax) }
            .onFailure { PushState.update { state -> state.copy(lastError = "补发失败：${it.message}") } }
            .getOrNull() ?: return
        for (message in missed) store(message, notify = !firstSync, socket = socket)
    }

    private suspend fun store(json: JSONObject, notify: Boolean, socket: WebSocket?) {
        val entity = runCatching { MessageEntity.from(json, System.currentTimeMillis()) }.getOrNull() ?: return
        val inserted = app.db.messages().insert(entity) != -1L
        socket?.send("""{"ack":${entity.id}}""")
        if (!inserted) return
        val now = System.currentTimeMillis()
        app.status.lastMessageAt = now
        PushState.update { it.copy(lastMessageAt = now) }
        if (notify) Notifier.notifyMessage(this, entity.message())
        app.db.messages().prune(now - KEEP_MS)
        app.db.messages().pruneOpens(now - KEEP_MS)
    }

    // ---- 网络 ----

    private fun registerNetworkCallback() {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch {
                    val changed = currentNetwork != null && currentNetwork != network
                    currentNetwork = network
                    // 换了网（Wi-Fi ↔ 流量），旧连接走的是旧网，等心跳发现要几分钟，直接重连。
                    if (changed || socket == null) reconnectNow(if (changed) "换网" else "网络恢复")
                }
            }

            override fun onLost(network: Network) {
                scope.launch { if (currentNetwork == network) currentNetwork = null }
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = Unit
        }
        connectivity.registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }

    companion object {
        private const val TAG = "PushService"
        const val ACTION_HEARTBEAT = "com.jpgr.push.HEARTBEAT"
        const val ACTION_RECONNECT = "com.jpgr.push.RECONNECT"
        const val ACTION_ENSURE = "com.jpgr.push.ENSURE"
        private const val PONG_TIMEOUT_MS = 10_000L
        /** 本地留 30 天；服务器只留 7 天。 */
        private const val KEEP_MS = 30L * 24 * 60 * 60 * 1000

        fun start(context: Context, action: String = ACTION_ENSURE) {
            val intent = Intent(context, PushService::class.java).setAction(action)
            // 后台拉起前台服务在 Android 12+ 有限制：电池优化白名单、精确闹钟、开机广播都豁免；
            // 不在豁免里时会抛异常，这里吞掉，等看门狗或用户打开 App 再拉。
            runCatching { context.startForegroundService(intent) }
                .onFailure { Log.w(TAG, "start failed: ${it.message}") }
        }
    }
}
