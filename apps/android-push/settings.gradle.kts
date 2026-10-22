pluginManagement {
    buildscript {
        repositories {
            mavenCentral()
            maven { url = uri("https://storage.googleapis.com/r8-releases/raw") }
        }
        dependencies {
            // Kotlin 2.4 的元数据需要 R8 9.1.29 以上（AGP 8.13 自带的版本读不了）。
            classpath("com.android.tools:r8:9.1.29")
        }
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "jpgr-android-push"
include(":app")
