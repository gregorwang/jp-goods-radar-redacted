# 新会话交接

更新时间：2026-07-26（Asia/Tokyo）

仓库：`C:\Users\me\qianfantian`　生产分支：`main`

**本文件此前列出的四个问题已全部修复。** 当前待办来自 2026-07-26 的全项目 review，见 `docs/CODE_REVIEW_REPORT_2026-07-26.md`。开始工作前请先 `git log` 与 `wrangler versions list` 确认线上实际版本，不要凭本文件的历史描述重做已完成的部分。

## 一、项目已经确定的数据原则

整体数据流保持为：

```text
来源接口 → 尽量完整抽取 → 原始数据保存到 PG → 按问题性质处理 → 统一结果提供给前端
                                                ├─ 价格、库存、计数、时间等确定性字段：程序 / SQL
                                                └─ 相关性、分类、翻译、品相、缺件、版本等语义字段：AI
```

核心约束：

- 抽取层只负责拿数据，不在入库前做语义过滤或删除。
- PG 是完整、可回放的数据仓库。
- AI 输出是版本化衍生数据，不能覆盖原始证据。
- AI 判断为无关的商品只在前端隐藏或不通知，原始商品仍保留。
- 降价、涨价、库存变化、首次出现、数量、均价和中位价不调用 AI。
- 前端展示统一核心字段，长尾字段放"更多信息"，并允许查看来源原始数据。
- 来源差异不再由前端大量兼容判断解决。

## 二、历史问题的关闭证据

不要重新实现下列任何一项。

| 历史问题 | 状态 | 证据 |
| --- | --- | --- |
| Gemini 免费层 429 共享额度、无专用队列 | 已修 | `GEMINI_QUEUE` 生产者与 `jp-goods-radar-gemini` 消费者（`max_concurrency: 1`）见 `apps/collector/wrangler.jsonc`；`gemini_provider_cooldowns`、`gemini_token_reservations`、`gemini_request_reservations` 见 `migrations/0022`、`0026`。按 Token 预算分批与 429 延迟重排队在 `apps/collector/src/gemini-jobs.ts` |
| 商品 AI 整理只是浏览器内异步 | 已修 | `gemini_jobs` 持久化任务表 + Queue 后台执行；回归用例见 `tests/workers/collector.integration.test.ts`（"persists a listing AI task before queue processing"） |
| Mercari `ITEM_TYPE_BEYOND` 链接拼错 | 已修 | `packages/adapters/src/mercari/normalize.ts` 按 `itemType` 选择 `shops/product` 或 `item` 路径 |
| Mercari 保存的不是真正上游原始响应 | 已修 | Vercel 服务用 `apps/mercari-service/src/upstream-capture.ts` 捕获 Mercari 上游正文（脱敏 URL、限长、哈希），经 `meta.upstreamCaptures` 回传；Collector 的 `separateEmbeddedUpstreamCaptures`（`apps/collector/src/source-capture.ts`）把它拆成独立 capture 行。生产 D1 实测：`mercari_jp` 有 538 行上游原始 capture 与 535 行 Vercel 信封 capture 成对存在。该设计不新增列，而是往同表写额外行——按"迁移里没有新列"判断会误判为未修 |

原文件中"当前问题 1~4"的详细分析已随问题关闭一并移除；需要考古时查 git 历史。

## 三、不要回退的约束

除 `AGENTS.md` 中的交付与 AI 边界规则外，还有两条来自历史踩坑：

- 不要重新引入关键词前置裁剪、标题分段过滤、固定词表删结果，或"AI 输出整份拒绝"逻辑。
- 不要用浏览器自动点击触发真实 AI 请求产生费用；需要真实模型验证时交给用户手动实测。

## 四、当前待办

见 `docs/CODE_REVIEW_REPORT_2026-07-26.md`。该报告按 P0/P1/P2 分级并给出精确到 file:line 的修改指令，其中"修复路线图"一节说明了分批顺序与每批的验证命令。批①②③（通知生命线、数据保留与队列、安全加固）已完成并上线，报告内的其余批次仍待处理。
