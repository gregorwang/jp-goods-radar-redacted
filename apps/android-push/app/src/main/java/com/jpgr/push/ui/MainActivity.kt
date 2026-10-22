package com.jpgr.push.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.jpgr.push.service.Notifier
import com.jpgr.push.service.PushService

/** 五屏：收件、一次推送的清单、标注、被筛掉的、连接。不用导航库，一个状态切换就够了。 */
sealed interface Screen {
    data object Inbox : Screen
    data class Detail(val messageId: Long) : Screen
    data object Connection : Screen
    data object Labels : Screen
    data object Excluded : Screen
}

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Inbox)

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openFrom(intent)
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PushService.start(this)
        setContent {
            Box(Modifier.fillMaxSize().background(Palette.White).safeDrawingPadding()) {
                when (val current = screen) {
                    Screen.Inbox -> InboxScreen(
                        onOpen = { screen = Screen.Detail(it) },
                        onConnection = { screen = Screen.Connection },
                        onLabels = { screen = Screen.Labels },
                        onExcluded = { screen = Screen.Excluded },
                    )
                    is Screen.Detail -> {
                        BackHandler { screen = Screen.Inbox }
                        DetailScreen(current.messageId, onBack = { screen = Screen.Inbox })
                    }
                    Screen.Labels -> {
                        BackHandler { screen = Screen.Inbox }
                        LabelScreen(onBack = { screen = Screen.Inbox })
                    }
                    Screen.Excluded -> {
                        BackHandler { screen = Screen.Inbox }
                        ExcludedScreen(onBack = { screen = Screen.Inbox })
                    }
                    Screen.Connection -> {
                        BackHandler { screen = Screen.Inbox }
                        ConnectionScreen(onBack = { screen = Screen.Inbox })
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openFrom(intent)
    }

    /** 点通知进来：直接打开那一次推送的清单。 */
    private fun openFrom(intent: Intent?) {
        val id = intent?.getLongExtra(Notifier.EXTRA_MESSAGE_ID, -1L) ?: -1L
        if (id > 0) screen = Screen.Detail(id)
    }
}
