# 视觉本地化审计

- [x] 未复制原站 title、meta、schema 与品牌名
- [~] 按所有者明确要求临时使用 3 张原站占位素材：`radar-shadow.png`、`radar-title-placeholder.png`、`paper-noise.png`；未使用人物、书籍、音乐或视频素材
- [x] 未保留原站社交分享、购买与官方外链
- [x] 未引入 GTM、像素、热图或第三方统计
- [x] 字体使用本地系统日文字体栈，不请求 Google Fonts
- [x] 页面内容全部改写为日淘商品雷达业务
- [x] 桌面与 390px 移动端通过浏览器截图验收
- [x] 占位素材集中在 `apps/web/public/art/`，后续可用 AI 原创图同名替换
- [ ] v4 Web Worker 需在 Linux CI 完成 OpenNext workerd 集成验证后部署
