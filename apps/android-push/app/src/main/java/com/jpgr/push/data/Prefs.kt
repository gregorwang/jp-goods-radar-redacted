// security-crypto 1.1.0 整个库被标成废弃（官方建议改用 DataStore + Keystore 自己加密），但仍是现成最省事的加密存储；只存一个口令，够用。
@file:Suppress("DEPRECATION")

package com.jpgr.push.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.jpgr.push.BuildConfig

/**
 * 设备口令只存在加密的 SharedPreferences 里（工程文档 §7）。
 * 安装包里带了默认口令（local.properties 的 jpgr.push.deviceToken）时，第一次打开直接用它。
 */
class TokenStore(context: Context) {
    private val prefs: SharedPreferences = runCatching { open(context) }.getOrElse {
        // 密钥库坏了（极少见，比如系统还原后）：清掉重来，口令重新填一次。
        context.deleteSharedPreferences(FILE)
        open(context)
    }

    fun token(): String = prefs.getString(KEY, null) ?: BuildConfig.DEFAULT_DEVICE_TOKEN

    fun fromBuild(): Boolean = prefs.getString(KEY, null) == null && BuildConfig.DEFAULT_DEVICE_TOKEN.isNotEmpty()

    fun save(token: String) {
        prefs.edit().putString(KEY, token.trim()).apply()
    }

    private companion object {
        const val FILE = "secure"
        const val KEY = "device_token"

        fun open(context: Context): SharedPreferences {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                context, FILE, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}

/** 连接页显示用的几个时间点，进程重启后也要能看到。 */
class StatusPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("status", Context.MODE_PRIVATE)

    var lastPongAt: Long
        get() = prefs.getLong("last_pong_at", 0)
        set(value) = prefs.edit().putLong("last_pong_at", value).apply()

    var lastMessageAt: Long
        get() = prefs.getLong("last_message_at", 0)
        set(value) = prefs.edit().putLong("last_message_at", value).apply()

    var lastConnectedAt: Long
        get() = prefs.getLong("last_connected_at", 0)
        set(value) = prefs.edit().putLong("last_connected_at", value).apply()
}
