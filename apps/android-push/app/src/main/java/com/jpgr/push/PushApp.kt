package com.jpgr.push

import android.app.Application
import com.jpgr.push.data.PushDatabase
import com.jpgr.push.data.Rounds
import com.jpgr.push.data.StatusPrefs
import com.jpgr.push.data.TokenStore
import com.jpgr.push.net.DeviceApi
import com.jpgr.push.net.RelayApi
import com.jpgr.push.service.Notifier
import com.jpgr.push.service.PushService
import com.jpgr.push.service.Watchdog
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class PushApp : Application() {
    lateinit var db: PushDatabase
        private set
    lateinit var tokens: TokenStore
        private set
    lateinit var status: StatusPrefs
        private set
    lateinit var relay: RelayApi
        private set
    /** 主站给手机开的窄接口：列表标注、等降价。 */
    lateinit var device: DeviceApi
        private set

    /** 长连接和普通请求共用一个客户端。读超时 0：WebSocket 闲着时不该被客户端自己掐掉，断线靠心跳发现。 */
    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        db = PushDatabase.open(this)
        tokens = TokenStore(this)
        status = StatusPrefs(this)
        relay = RelayApi(http, BuildConfig.RELAY_BASE)
        device = DeviceApi(http, BuildConfig.WEB_BASE)
        Rounds.load(this)
        Notifier.createChannels(this)
        Watchdog.schedule(this)
        if (tokens.token().isNotEmpty()) PushService.start(this)
    }

    companion object {
        lateinit var instance: PushApp
            private set
    }
}
