# UI 本地化记录

- 视觉母版：`C:/Users/me/proui/kakekoi-home-clone`
- 模式：视觉语言与动效本地化，业务内容完全替换
- 原站许可：未声明；按所有者要求，当前版本临时使用标题、shadow 与纸张 noise 三张占位素材，不使用角色图、剧情文案、视频或购买链接
- 保留的设计 DNA：长页章节感、强留白、纵排标签、明朝体标题、细线、雾蓝透明层、亮黄信号色、柔和 reveal 与移动抽屉式导航节奏
- 技术迁移：原站静态 HTML/GSAP/Splide/Lenis 的表现被重构为 Next.js 组件、CSS token 和轻量 CSS 动画
- 占位替换点：`apps/web/public/art/`。后续 AI 原创素材保持同名替换即可，不需要重做登录页结构与动效
- 可访问性：支持 `prefers-reduced-motion`，核心数据不依赖动画才能阅读
- 响应式证据：`tests/artifacts/dashboard-desktop.png`、`tests/artifacts/dashboard-mobile.png`
