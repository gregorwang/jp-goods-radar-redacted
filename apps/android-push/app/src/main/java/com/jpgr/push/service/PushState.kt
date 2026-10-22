package com.jpgr.push.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** 连接状态，服务写、界面读。 */
object PushState {
    enum class Conn { NO_TOKEN, CONNECTING, ONLINE, BACKOFF, STOPPED }

    data class Snapshot(
        val conn: Conn = Conn.STOPPED,
        val serviceRunning: Boolean = false,
        /** 下一次重连的时间（BACKOFF 时）。 */
        val retryAt: Long? = null,
        val lastError: String? = null,
        val lastPongAt: Long = 0,
        val lastMessageAt: Long = 0,
        val lastConnectedAt: Long = 0,
    )

    private val mutable = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = mutable

    fun update(transform: (Snapshot) -> Snapshot) = mutable.update(transform)
}
