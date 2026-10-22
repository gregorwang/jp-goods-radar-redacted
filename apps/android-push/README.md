# 格银推送（安卓）

你自己手机上的推送 App：常驻长连接，收关键词档案每小时那一轮的新货。
设计和取舍见 `docs/进行中/安卓推送App-工程文档-20261011.md`；服务端是 `apps/push-relay`。

## 构建

命令行里没有 `java`，用 Android Studio 自带的 JBR：

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleRelease
# 产物：app\build\outputs\apk\release\app-release.apk
```

`local.properties`（不进 git）里要有 `sdk.dir`、`jpgr.push.deviceToken` 和签名四项，见 `app/build.gradle.kts` 顶部注释。
签名文件在 `C:\Users\me\.jpgr\android-push-release.jks`。**升级必须用同一个签名**，否则装不上，只能卸载重装（本地收件记录会丢）。
每次发新包把 `versionCode` 加一。

## 字体

`res/font` 里的 Noto Serif SC（标题）和 Cormorant Garamond（价格数字）都是 SIL Open Font License 1.1，
分别来自 notofonts/noto-cjk 和 google/fonts。正文用系统字体。
