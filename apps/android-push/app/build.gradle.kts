import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    id("org.jetbrains.kotlin.kapt")
}

/**
 * 本机私有配置，放在 apps/android-push/local.properties（不进 git）：
 *   jpgr.push.deviceToken=...      push-relay 的 PUSH_DEVICE_TOKEN，装好就能连，不用在手机上手打
 *   jpgr.push.storeFile=...        发布签名 keystore 的绝对路径
 *   jpgr.push.storePassword=...    / jpgr.push.keyAlias=... / jpgr.push.keyPassword=...
 * 没有签名配置时 release 退回 debug 签名，照样能装。
 */
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.reader(Charsets.UTF_8).use { load(it) }
}
fun local(key: String): String = localProps.getProperty(key) ?: ""
fun quoted(value: String) = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "com.jpgr.push"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jpgr.push"
        minSdk = 31
        targetSdk = 36
        versionCode = 4
        versionName = "0.3.1"
        buildConfigField("String", "RELAY_BASE", quoted("https://jp-goods-radar-push-relay.your-subdomain.workers.dev"))
        // 主站：列表标注、等降价走它的 /api/device/…（同一个设备口令）。
        buildConfigField("String", "WEB_BASE", quoted("https://eru.example.com"))
        buildConfigField("String", "DEFAULT_DEVICE_TOKEN", quoted(local("jpgr.push.deviceToken")))
    }

    signingConfigs {
        create("release") {
            if (local("jpgr.push.storeFile").isNotEmpty()) {
                storeFile = file(local("jpgr.push.storeFile"))
                storePassword = local("jpgr.push.storePassword")
                keyAlias = local("jpgr.push.keyAlias")
                keyPassword = local("jpgr.push.keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (local("jpgr.push.storeFile").isNotEmpty()) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    kapt(libs.androidx.room.compiler)
    kapt(libs.kotlin.metadata.jvm)
}

kapt {
    correctErrorTypes = true
}
