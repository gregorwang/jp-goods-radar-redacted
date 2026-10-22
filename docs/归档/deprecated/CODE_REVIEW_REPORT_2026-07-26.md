# 全项目深度 Review 报告（2026-07-26）

> 审查方式：Fable 5 主模型统筹裁决，6 个 Opus 5 子 agent 并行深查（Collector 后端 / Web 管理站 / 共享包 / 全仓安全 / 数据层与运维 / 产品业务逻辑），共产出约 90 条经代码验证的发现。本报告为主模型裁决后的合并版本：跨 agent 重复发现已合并，方案冲突已裁定，所有修复指令精确到 file:line，可由任意模型（包括 Sonnet）机械执行。
>
> 基线 commit：`91cd347`。所有行号以该基线为准；修复后行号会漂移，执行时以引用的代码片段为锚点定位。

---

## 0. 总体结论

**架构与安全基本面是好的。** ECDSA 服务签名（scope 隔离、±5 分钟时间窗、raw r‖s 强校验）、SQL 全参数化、出站 URL 全部主机白名单、邮件 HTML 转义、Workers 集成测试（70+ 用例）都做得扎实。全仓无 `as any`/`@ts-ignore`，无提交的密钥（472 个 git 跟踪文件全量扫描通过）。

**但产品核心承诺——"降价/补货了就告诉我"——目前存在多个会让通知永久丢失的缺陷**，且它们会互相叠加：

1. 事件 key 无时间维度 → 同价位的重复降价/补货**永远**不再通知；
2. 每日汇总（digest）第二次触发时把所有待发事件静默压制，且连带杀掉微信通道、吞掉静默时段延后的事件；
3. 单条无法渲染的事件会永久阻塞**全部**后续邮件（毒丸）；
4. monitor v2 默认 180 分钟冷却把"更深的降价"直接丢弃且 UI 无法复活；
5. AI 相关性判定失败的商品被标记"已匹配"但永不发事件。

**运维侧有三个定时炸弹**：raw capture 等 10+ 张表无任何保留策略（D1 10GB 上限终会耗尽）；主队列消费者吞错误不留日志、死信队列无消费者；生产部署无 typecheck 门禁且从不自动应用 D1 迁移。

**安全侧无可直接利用的 P0**，但登录无暴力破解防护 + 会话 30 天不可吊销 + 全站无安全响应头，三者叠加后单密码体系的容错为零，裁定为最高优先级修复之一。

---

## 1. 主模型裁决记录（方案冲突的裁定）

| 冲突点 | 候选方案 | 裁定 |
|---|---|---|
| 事件 key 判别式 | ① `stateHash.slice(0,16)` 窗口（Collector agent）② `observedAt` 小时桶 + 转移描述（Packages agent） | **采纳②**。①对"同价位补货循环"无效——restock 循环中 stateHash 完全相同，key 仍碰撞。②的转移描述（`old->new`）+ 小时桶既保住同轮重试幂等，又允许真实的再次发生。 |
| 每日汇总修复 | ① digest key 加 UUID + 按 id 精确压制（Packages）② 新增 `email_suppressed_at` 列使邮件/微信解耦（Business #4）③ 压制语句补 `delivery_not_before` 条件（Business #5） | **三者合并**：按 id 精确压制（候选查询本身过滤 `delivery_not_before`，故③自动被①覆盖）+ 压制改写 `email_suppressed_at` 新列而非 `status`（②），Hermes 查询不变。 |
| 登录限流实现 | 安全 agent 版（简单计数）vs Web agent 版（滑动窗口 + Retry-After + 日志） | **采纳 Web 版**（更完整），与会话吊销表合并为同一个迁移 `0041`。 |
| `email_deliveries` 索引 | `(event_id,status)` ×2 agent、`(event_id,created_at DESC)` ×1 | **合并为一个** `(event_id, status, created_at)`：前缀覆盖 NOT EXISTS 热查询，event_id 前缀也已把 events 路由的相关子查询收敛到个位数行。 |
| jobs 队列 `max_concurrency` | 4（Collector）/ 2（Ops、Business）/ 1 | **裁定 2**。对上游礼貌性优先于吞吐；80 绑定、最小 30 分钟间隔下 2 并发绰绰有余，观察 429 率后再调。 |
| 保留策略实现 | Collector 版（3 张表）vs Ops 版（10 张表 + 配套索引迁移） | **采纳 Ops 版**（超集），挂到每小时维护 tick，逐条 try/catch。 |
| `validOrigin` 修复 | 两个 agent 各提出不同白名单实现 | **采纳最简形式**：直接删除 `x-forwarded-host` 读取，仅与 `new URL(request.url).host` 比较。Workers 上 `request.url` 即真实主机，无需白名单常量。 |
| Mercari DPoP DER 转换 | 修长度判定 vs 删除死代码 | **删除**。WebCrypto ECDSA 本就返回 raw r‖s，DER 分支不可达，留着只是未测试的负债。 |

**否决/降级项**：
- Collector agent 关于"subrequest 上限 10,000"的表述未独立核实，但其对 `acquireRequestSlot` 自旋的修复（退避 + 迭代上限）与上限数值无关，照常采纳。
- `/api/sources` 8 查询合并（Web #16 前半）降级为 P2 观察项——已正确并行化，单人使用下不构成瓶颈。
- Python 验证脚本清理（Ops #17）降级为文档化即可，不删除。

---

## 2. P0 —— 立即修复（10 项）

### P0-1 邮件毒丸：单条坏事件永久阻塞全部通知
`apps/collector/src/index.ts:1044-1055`（已抽查确认 `:1045-1046` 渲染先于登记）

`renderEventNotification(row)` 在 `beginEmail` **之前**调用；joined listing 缺字段时它抛异常，`email_deliveries` 无记录、事件停留 `pending`，而 `pendingEmails()` 按 `created_at ASC` 排序 → 同一条永远排第一，此后所有邮件被阻塞。

**修复**：把渲染移入 try 并失败即记录、不再抛出：
```ts
async function deliverEmailRow(env: Env, repository: RadarRepository, row: PendingEmailRow): Promise<void> {
  const deliveryId = await repository.beginEmail(row.event_id, row.event_key);
  let template: RenderedNotification;
  try {
    template = renderEventNotification(row);
  } catch (error) {
    await repository.failEmail(deliveryId, row.event_id, error instanceof Error ? error.message : "通知渲染失败");
    await env.DB.prepare("UPDATE events SET status='suppressed' WHERE id=?").bind(row.event_id).run();
    console.error(JSON.stringify({ event: "email_render_failed", eventId: row.event_id, eventType: row.event_type }));
    return;
  }
  try {
    const resendId = await sendResendEmail({ apiKey: env.RESEND_API_KEY, from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO,
      subject: template.subject, html: template.html, text: template.text, idempotencyKey: row.event_key });
    await repository.finishEmail(deliveryId, row.event_id, resendId);
  } catch (error) {
    await repository.failEmail(deliveryId, row.event_id, error instanceof Error ? error.message : "邮件发送失败");
    throw error;
  }
}
```
顶部补 `import type { RenderedNotification } from "./notification-template";`。同时把 `index.ts:1033-1035` 的循环改为逐条 try/catch、末尾统一 rethrow 最后一个错误，避免一条传输失败放弃整批。

### P0-2 通知失败把成功采集改写为失败并触发冷却
`apps/collector/src/index.ts:894-909, 910-1015`

`deliverPendingNotifications`（`:905`、`:908`）在采集主 try 内且会 rethrow → Resend 一次 500 就走 catch：`failBinding` + `finishRun(failed)` + 冷却（2 次失败 2h、3 次 6h）+ 来源标 degraded + queue 重试整个绑定（重新抓上游）。**Resend 故障会导致监控被挂起。**

**修复**（4 步，照 Collector agent F2 原文执行）：
1. `:559` 后声明 `let deliverNotificationsAfterRun = false; let collectionError: unknown;`
2. `:894-909` 的两处 dispatch 调用改为置 `deliverNotificationsAfterRun = true`（保留 `prepareKeywordDigest` 调用本身）；
3. catch 内 `:1013` 改为置 flag；`:1014` 的 `throw error` 改为 `collectionError = error;`
4. try/catch 之后统一补发：
```ts
  if (deliverNotificationsAfterRun) {
    try { await deliverPendingNotifications(env, repository); }
    catch (error) { console.error(JSON.stringify({ event: "notification_dispatch_failed_after_run", bindingId: binding.id, runId: run.id,
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown" })); }
  }
  if (collectionError) throw collectionError;
```
（`:938`、`:973` 两处 early return 保持原样。）

### P0-3 数据保留缺失 + capture 超 D1 行上限
写入方 `apps/collector/src/index.ts:695, 912`；唯一清理挂在手动搜索路径 `:1867-1870`；`apps/collector/src/source-capture.ts:9, 353-360`

10+ 张表随 cron 无界增长（`watch_runs`、`listing_snapshots`、`source_health_snapshots`、`events`、`email_deliveries`、`source_response_captures` 存整页 HTML…），D1 硬上限 10GB。另外 `MAX_CAPTURE_BYTES = 4_000_000` 超过 D1 单值 2MB 上限，且 `stageSourceCaptures` 单次 `batch()` 不分块——一条超大 capture 使整批失败，还因在采集 try 内把成功抓取改写为失败（与 P0-2 叠加）。

**修复**：
1. `source-capture.ts:9` → `const MAX_CAPTURE_BYTES = 1_500_000;`
2. `stageSourceCaptures` 改为每 5 条一个 batch、逐块 try/catch 记 `console.error`（capture 是尽力而为的证据，不允许拖垮采集）；
3. 新迁移 `migrations/0041_retention_and_indexes.sql`（索引部分见 P1-D）；
4. `index.ts` 每小时维护 tick（`recordCronHeartbeat` 之后）新增 `pruneOperationalHistory(env)`，内容照 Ops agent #3 的 10 条 DELETE（capture 14 天、watch_runs 90 天、listing_snapshots 180 天、source_health_snapshots/probe_observations 90 天、cron_heartbeats 30 天、managed_api_cache 过期+1 天、analytics_outbox 已成功 30 天、已发送 email_deliveries 180 天、已 sent/suppressed events 180 天），整体 try/catch。**注意顺序：先删 `email_deliveries` 再删 `events`**（FK）。
5. 顺带把 `index.ts:1859-1870` 挂在每次手动搜索上的两条 DELETE 移除（由 cron 统一负责），并把 `search_history` 的 trim 加入同一 prune 函数。

### P0-4 事件 key 无时间维度：重复降价/补货永久静默
`packages/core/src/events.ts:46-79` + `events.event_key UNIQUE`（`0001_init.sql:132`）+ `INSERT OR IGNORE`（`repository.ts:895-911`）

¥5000→¥4000→¥5000→¥4000：第二次降价 key 相同，被 IGNORE **永远丢弃**。restock/sold_out 用 stateHash 做判别式，同价循环下同样碰撞。这是降价雷达主功能的静默失效。

**修复**（裁决后的合并方案）：`EventEvaluationInput` 增加 `observedAt: string`；`evaluateListingEvents` 顶部 `const cycle = input.observedAt.slice(0, 13);`（小时桶）；四个 key 改为：
```ts
eventKey: key("price_drop", `${oldPrice}->${newPrice}@${cycle}`),
eventKey: key("target_price", `${input.targetPrice}:${newPrice}@${cycle}`),
eventKey: key("restock", `${input.previous.availability}->available@${cycle}`),
eventKey: key("sold_out", `available->sold_out@${cycle}`),
```
三个调用点（`apps/collector/src/index.ts:824`、`:1148`、`gemini-jobs.ts:1517`）传 `observedAt: result.fetchedAt`（无则 `new Date().toISOString()`）。更新 `packages/core` 相应单测的 key 形状断言。`target_price` 保持每小时桶最多一次即为合理去重。

### P0-5 每日汇总压制体系：三个叠加缺陷
`packages/db/src/repository.ts:1494-1532`（digest key 冲突 + 全量压制）、`:1559`（Hermes 取件排除 suppressed）、`:1525`（压制无 `delivery_not_before` 条件，已抽查确认）

同一 JST 日第二次触发：digest 事件已 `sent`，`ON CONFLICT` 不产生新 digest，但第二条语句仍把**所有** pending/failed 事件压制 → 既不进邮件也永不再入汇总；`status='suppressed'` 同时使 Hermes 微信通道取不到件（违反 README 承诺的双通道独立）；静默时段延后（`delivery_not_before` 未到）的事件被压制却没进 digest 正文——两个通道里都消失。

**修复**（合并方案，一次到位）：
1. 迁移 `0041` 增加列：`ALTER TABLE events ADD COLUMN email_suppressed_at TEXT;`
2. `prepareDailyDigest` 重写：
   - digest key 改 `daily_digest:${day}:${crypto.randomUUID()}`，INSERT 去掉 ON CONFLICT；
   - 候选 SELECT 增选 `e.id`，捕获 `eventIds`；
   - 压制语句改为按 id 分块：`UPDATE events SET email_suppressed_at=? WHERE id IN (...) AND email_suppressed_at IS NULL`（不再动 `status`）；
   - `total` 用 `eventIds.length`，删除独立 COUNT 查询。
3. `pendingEmails`/`pendingEmailCount`（`:1384`、`:1403` 附近）WHERE 增加 `AND e.email_suppressed_at IS NULL`；`pendingHermesNotifications` **不加**该条件（微信不受邮件配额影响）。
4. `prepareKeywordDigest` 的压制（`:1478`）同样改写 `email_suppressed_at`。

### P0-6 monitor v2 冷却把更深的降价直接丢弃
`packages/db/src/repository.ts:1113-1141`；默认 `cooldown_minutes=180`（`0031:85-86`）

¥5000→¥4500（通知）→30 分钟后 ¥3000：同类型同 subject 在 180 分钟窗口内 → legacy 事件直接 `suppressed`，而 retry-email API 只认 `failed`，UI 无法复活。restock/sold_out 共用 `availability_changed` 冷却桶，第二次补货被第一次售罄的冷却吞掉。

**修复**（照 Business agent #2）：
1. `coolingDown && !duplicate` 时不 `suppressLegacy`，改设 `deliveryNotBefore = 最近一次 detected_at + cooldown`，eligibility 保持 `rule.delivery_mode`（冷却=延后，不=丢弃）；
2. 幅度豁免：`payload.newPrice <= 0.9 * payload.oldPrice` 或 `<= rule.target_listing_price` 时绕过冷却（duplicate 判定保留）；
3. `listing.availability_changed` 的 dedupe subject 拆为 `subjectId + ':' + payload.currentAvailability`。

### P0-7 AI 相关性闸门吞掉关键词新品 + 基线提前置位
`apps/collector/src/gemini-jobs.ts:1521-1537`；`apps/collector/src/index.ts:766`

`persistListing({linkToWatch:true})` 先写 `watch_listing_matches`，之后 Gemini 单项失败（`result.items[i]=null`）→ `continue` 不发事件；下轮 `isNewMatch=false` → **该新品永远静默**。且 `runBinding` 对 keyword 绑定无条件 `completeBinding()`，首轮 Gemini 整体失败时基线被标完成而无数据 → 第二轮全量商品误判为新品洪水。

**修复**：
1. 非 exact_product 也改两阶段：先 `persistListing({linkToWatch:false})`，仅当 `relevance === "relevant"`（或该项 `states[index]==="ready"`）后调用 `acceptListingMatch` 写入匹配；`failed` 项记入 gemini job 的重试集合，下轮重判；
2. `baseline_completed` 改由 `finalizeKeywordJob` 成功后回写，删除 `index.ts:766` 的无条件 `completeBinding()`。

### P0-8 生产部署无门禁、迁移不自动应用
`apps/web/package.json:9`；无 `.github/`；collector 手动部署

web/collector/D1 schema 三者可处于三个版本；`0040` 建的表 collector 先部署即硬崩。

**修复**：
1. `apps/web/package.json` deploy 改为 `"pnpm --filter @jpgr/web typecheck && pnpm --filter @jpgr/web lint && opennextjs-cloudflare build && opennextjs-cloudflare deploy"`；
2. 根 `package.json` 加 `"predeploy:collector": "pnpm --filter @jpgr/collector typecheck && pnpm exec wrangler d1 migrations apply jp-goods-radar --remote --config apps/collector/wrangler.jsonc"`；
3. README 补回滚路径（collector: `wrangler rollback`；web: Workers Builds 控制台回滚；**D1 迁移不回滚**，因此今后迁移必须只增不破坏——现有 7 个 DROP-rebuild 迁移的教训见 P1-J）。

### P0-9 队列错误静默 + 死信队列无人消费
`apps/collector/src/index.ts:2976-2982`；`apps/collector/wrangler.jsonc:44-62`

主消费者 catch 无任何日志；两个 DLQ 全仓无消费者，3 次重试后消息静默过期——所有监控/降价确认/汇总最终化都可能无声丢失。

**修复**：
1. catch 内补结构化 `console.warn`（messageType/attempts/retryable/errorName/errorMessage，照 Ops #2 代码）；
2. wrangler.jsonc consumers 追加两个 DLQ 消费者（`max_retries: 0`），queue() 入口加 `if (batch.queue.endsWith("-dlq"))` 分支逐条 `console.error({event:"dead_letter",...})` 后 ack；
3. 同文件 jobs 消费者块加 `"max_concurrency": 2`（裁决值，兼修上游并发轰炸——Collector F8/Ops #9/Business #15 三方印证）。

### P0-10 管理员登录无暴力破解防护 + 会话不可吊销
`apps/web/src/app/api/auth/login/route.ts:4`；`apps/web/src/lib/auth.ts:70-82`

单密码 gate 全系统，可无限速猜测；会话为无状态 HMAC token，30 天有效，登出仅删本地 cookie，泄露后无法吊销。

**修复**（合并为迁移 `0041` 的一部分 + 两个文件改写）：
1. 迁移建 `admin_login_attempts(bucket PK, attempts, window_started_at, locked_until)` 与 `admin_sessions(nonce PK, created_at, expires_at)`；
2. login route 照 Web agent #1 的完整版本重写（15 分钟窗口 8 次、锁 30 分钟、429 + Retry-After、`cf-connecting-ip` 分桶、失败记结构化日志、成功清桶）；
3. `auth.ts`：`createAdminSession` 把 `nonce` 落入 `admin_sessions`，`maxAge` 30 天→7 天，`secure: true`（去掉 NODE_ENV 条件）；`hasAdminSession` 校验 nonce 在表且未过期；`deleteAdminSession` 删表内 nonce（真吊销）。

---

## 3. P1 —— 高优先级（按主题分组）

### A. 安全加固
| # | 问题 | 位置 | 修复要点 |
|---|---|---|---|
| A1 | Vercel 服务无重放防护（source-runner 有） | `apps/mercari-service/src/auth.ts:30-63` | 移植 source-runner 的 `SignatureReplayGuard`：`seen Map` + `request_replayed` 失败类型；PR 注明 per-instance 局限，硬保证需 KV |
| A2 | 7 个 handler 先 zod 校验（泄漏 schema）后验签，且签的是 zod 转换后对象 | `apps/mercari-service/api/*.ts` | 全部调换两行顺序：先 `verifyServiceRequest(request, scope, request.body)` 再 `safeParse`。一并修复 `z.string().trim()` 导致的签名消息不一致 |
| A3 | 全站无安全响应头 | `apps/web/next.config.ts` | 加 `headers()`：CSP（`frame-ancestors 'none'` 为关键）、XFO DENY、nosniff、Referrer-Policy、HSTS、Permissions-Policy（照安全 agent P1-3 的值） |
| A4 | `validOrigin` 信任 `X-Forwarded-Host` | `apps/web/src/lib/auth.ts:90-103` | **裁决版**：删除 forwardedHost 读取，仅比较 `new URL(request.url).host` |
| A5 | 健康端点泄漏来源清单与队列水位 | `apps/source-runner/src/server.ts:156-167`、`apps/mercari-service/api/health.ts:11-19` | 公开路径只留 `{service, version}`；详情移到签名保护的 `POST /v1/health` |
| A6 | source-runner 直连 fetch 不复验重定向目标 | `apps/source-runner/src/adaptive-fetch.ts:196-219` | `redirect:"manual"` + 逐跳 `requireAllowedSourceRunnerUrl`，深度上限 3 |
| A7 | `.gitignore` 缺目录 | `.gitignore` | 追加 `.deploy/`、`supabase/.temp/`、`.tmp-source-test/`、`tmp/` |
| A8 | sslip.io 第三方通配 DNS 承载 source-runner 与 Hermes | `apps/collector/wrangler.jsonc:72,78` | 架构建议：迁到自控域名（响应未签名，仅 TLS 保护） |

### B. Workers Cache 陷阱（有严格顺序）
`/sources/rakuten` 声称的 1h 边缘缓存实际不存在（页面纯客户端渲染、wrangler 无 `cache` 块、OpenNext 无 incrementalCache）；而一旦开启 Workers Cache，所有管理端 API 因缺 `Cache-Control` 会被 RFC9111 启发式缓存 2 小时并泄漏给匿名请求。

**必须先 B1 后 B2**：
- **B1**：新建 `apps/web/src/lib/api-response.ts` 导出 `privateJson()`（`Cache-Control: private, no-store` + `Vary: Cookie`）；`api-auth.ts`/`api-mutation.ts` 改用它；`apps/web/src/app/api/**` 全部 `Response.json(` 机械替换为 `privateJson(`（除 `api/public/rakuten`）；proxy 型 `new Response(...)` 手动补头。
- **B2**：`/sources/rakuten` 改服务端渲染（page 直接 `env.COLLECTOR.fetch`，`public-rakuten-results.tsx` 去掉 `"use client"` 改纯展示组件，删除 `api/public/rakuten` 路由），然后 wrangler.jsonc 加 `"cache": { "enabled": true }`。

### C. 可靠性（Collector/Packages）
| # | 问题 | 位置 | 修复要点 |
|---|---|---|---|
| C1 | cron 领取与预约不原子，重叠 tick 双派发 | `index.ts:1381-1393`、`repository.ts:210-220` | `reserveBinding` 改 CAS（`WHERE id=? AND next_run_at=?`）返回 boolean，输者 `continue`；更新测试调用点 |
| C2 | 邮件日配额并发下可超发 | `index.ts:1018-1042` | 新增 `reserveEmailSlot(limit)` 原子 UPDATE（`WHERE emails_sent < ?`），发送前占位；`finishEmail` 里删除重复计数；`MAX_EMAILS_PER_DAY` 加 NaN 防御 |
| C3 | `analytics_outbox` 卡 `processing` 永不恢复 | `analytics.ts:612-632` | 恢复查询加 `OR (status='processing' AND updated_at<15分钟前)` |
| C4 | 三处 fetch 帮助函数体读取阶段的 abort 逃逸为原始 DOMException | `packages/adapters/src/http.ts:115`、`html.ts:172`、`surugaya/request.ts:139`；另 `source-runner-client.ts:273-285`（超时死代码） | 四处都把 body 读取/轮询 sleep 包进与 fetch 相同的 AdapterError 转换 |
| C5 | 数字 HTML 实体越界抛 RangeError 炸整轮解析 | `html.ts:199-206` | `codePoint()` 守卫（0..0x10FFFF、排除代理区），非法实体原样返回 |
| C6 | 骏河屋尾斜杠产生双重身份 → 假新品事件 | `surugaya/normalize.ts:30-34` | 提取 id 前 `url.pathname.replace(/\/+$/,"")`，清空 search/hash |
| C7 | 拍卖易变字段（bid_count/left_time…）进 content_hash → 每轮全部"变化" | `repository.ts:696-706` | `VOLATILE_DISPLAY_FACT_KEYS` 过滤集 + `contentHashFacts()`（照 Packages P1-6 代码） |
| C8 | Mercari 无出价拍卖 `0 ?? x` 得 0 → 价格全丢 | `mercari/normalize.ts:201-207` | `highestBid > 0` 才用，否则回退 startingPrice → item.price |
| C9 | `beginEmail` 把已 sent 的投递重置回 pending | `repository.ts:1633-1646` | ON CONFLICT 加 `WHERE status <> 'sent'`；读回真实 id；`sent` 时抛 `email_already_sent` 由调用方按跳过处理 |
| C10 | Yahoo 拍卖时隙获取 25ms 忙自旋（最坏 60 秒 ×3 D1/次） | `yahoo-auctions-runtime.ts:96-157` | bootstrap 提出循环、指数退避（25ms→500ms 封顶）、40 次迭代硬上限 |
| C11 | Resend 传输无超时无界读 | `packages/email/src/resend.ts:11-27` | `AbortSignal.timeout(10_000)` + `text().slice(0,4096)` 后解析（照 Packages P2-19 代码） |

### D. 性能与索引（合并为迁移 `0041_retention_and_indexes.sql`）
```sql
CREATE INDEX IF NOT EXISTS idx_email_deliveries_event ON email_deliveries(event_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_watch_runs_status_started ON watch_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_watch_runs_started ON watch_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_listing_snapshots_observed ON listing_snapshots(observed_at);
CREATE INDEX IF NOT EXISTS idx_analytics_outbox_processed ON analytics_outbox(status, processed_at);
```
（与 P0-3 的保留策略、P0-5/P0-10 的新表/新列合并成同一个迁移文件，一次 apply。）

其余性能项：
- **D1** `persistListing` 每 listing 3 次串行往返 ×90 listings：加 `findListingsWithMatchState` 批量预读（照 Collector F11 代码），`index.ts:797` 与 `gemini-jobs.ts:1518` 两处循环前预取；
- **D2** `insertEventBatch` N+1（每事件 4-6 查询）：legacy id 预取合并成一个 batch、landed-cost 三查询提升到循环外、listing 上下文按 chunk 预取（照 Packages P1-9）；
- **D3** 每分钟 cron 跑三个维护函数（README 说每小时）：`index.ts:1416-1430` 三个调用移到 hourly 守卫之后；
- **D4** 每小时维护链无错误隔离，一步失败跳过通知投递：`:1438-1444` 用 `step(name, task)` 包装器逐步 try/catch；`:2926` 的 `ctx.waitUntil` 补 `.catch` 结构化日志；probe 搜索补 `AbortSignal.timeout(25_000)`；
- **D5** `/api/listings/[id]/snapshots` 无 LIMIT：包一层 `ORDER BY observed_at DESC LIMIT 500` 再正序（照 Web #13）。

### E. Web 体验与正确性
| # | 问题 | 修复要点 |
|---|---|---|
| E1 | 4 个主界面把加载失败渲染成"空数据"（sources 页尤其危险） | `listing-manager`/`source-manager`/`watch-manager`/`search-studio` 照 `event-manager.tsx:338-346` 已有模式补 `loadState` 三态 + `role="alert"` 重试按钮 |
| E2 | 全 app 无 `error.tsx`/`loading.tsx`/`not-found.tsx` | 按 Web #6 建三个文件于 `(app)` 段 |
| E3 | `[variantId]` 页仅靠 layout 鉴权 | 页面顶部补 `hasAdminSession()` 检查；新建 `middleware.ts` 做 cookie 存在性预检（纵深防御，保留现有逐路由鉴权） |
| E4 | 两个轮询循环卸载后继续跑 5-10 分钟 | `search-studio.tsx:152-177`、`analytics-view.tsx:468-513` 穿 `AbortSignal` + 卸载 abort |
| E5 | `apiFetch` 假定响应必为 JSON | `client-api.ts:7` 改 text→尝试 parse→友好错误（照 Web #14） |
| E6 | 时间戳三种时区行为并存（页头声称 Asia/Tokyo） | 新建 `lib/format-time.ts` 的 `tokyoDateTime/tokyoFull`，全组件替换（~30 处） |
| E7 | LIKE 通配符未转义；login next 白名单漏 2 条路由；AI 上游错误未脱敏 | 分别照 Web #12（ESCAPE '\\'）、#11（正则前缀白名单）、#15（复用 `safeAiError`）修 |

### F. 业务语义（产品承诺兑现）
| # | 问题 | 修复要点 |
|---|---|---|
| F1 | 售罄的商家 SKU（骏河屋中古/乐天）无法建补货监控——README 首行承诺的核心场景 | `watch-semantics.ts:7-13` 引入来源级 `oneOffListing`（mercari/两个 yahoo 拍卖类=true），规则改 `catalog || !oneOffListing || !terminal`；此类 watch 默认 `notifyRestock=1, notifyPriceDrop=0` |
| F2 | 降价邮件不含旧价/降幅（开发文档 §32.2 明确规定的格式） | `templates.ts:48` 的 `_detail` 实际使用：subject `[降价 ¥{dropAmount}] {title}｜¥{old} → ¥{new}`，正文补旧价/新价/降幅行 |
| F3 | 雅虎拍卖当前出价与一口价混为可比价 → 假"低于目标价"告警 + 参考价污染 | `priceBasis` 增 `"auction_current_bid"`；目标价判定排除之；流拍（bidCount=0）样本从参考中位数剔除（照 Business #7 三处） |
| F4 | 目标价/落地成本/品相/齐套 4 类 product.* 事件只在 new_listing 分支判定，存量商品降价永不触发 | `repository.ts:996` 条件扩为 `new_listing || price_drop || target_price`；trigger 字段改用 `event.type` |
| F5 | 落地成本目标用区间上界 + 要求 variant scope → 生产中基本不可达 | 加 `threshold_policy`（默认中点）；允许 `scope_type='listing'`；重量未知时通知内标注估算依据 |
| F6 | parser 结构错误首次即静默停用来源+全部绑定，通知门槛却是 3 次 → 永远先停用后通知（且"结果骤降为 0"也走此路径） | 通知门槛加 `|| parserFailure || captcha`；abnormalEmpty 改 6h 冷却、连续 3 轮才停用；`probe_no_go` 同样补 source_error 事件 |
| F7 | 通知 FIFO 无优先级，紧急 target_price 排在积压 new_listing 后 | `pendingEmails` ORDER BY 加事件类型 CASE 优先级；`overflow` 判定 `>=` 改 `>` |
| F8 | 关键词上新只看第一页 30 条（market 反而有翻页——分工反了） | keyword_new_listing 接翻页：整页无已知 ID 且未达 marketDefaultPages 则下一页，遇重叠即停；基线未完成只取 1 页 |
| F9 | `delivery_mode`（instant/digest）UI 可配但投递层完全不读 | 要么接线（`pendingEmails` LEFT JOIN monitor_events 过滤 digest）要么隐藏该选择器——不许存在空开关 |
| F10 | 入队抖动 0-20 秒（文档写 0-180 秒） | `index.ts:1216` `% 21` → `% 181`；同 source 的多绑定追加 `index*15` 秒 |

---

## 4. P2 —— 择机处理

- **代码去重**：`mergedRequestEvidence` 双实现语义分叉（统一用 `market-pagination.ts` 版导出）；`listingForDeterministicState`/`validComparablePrice` 两处逐字重复（上移 `@jpgr/core`——此项实际影响 state hash 一致性，靠前处理）；两套 yen 解析器合并并加 `¥/円` 锚定；ECDSA 签名 key 每次 poll 重复 import（模块级 memoize）。
- **数据卫生**：`incrementCounter` 列名插值加运行时白名单；`prepareKeywordDigest` 无界 SELECT 加 `LIMIT 2000`；Animate 全页匹配 `N件` 的终止条件收敛到结果头部区域；骏河屋 marketplace-only 商品价格回退；邮件 subject CRLF 清洗；`dailyDigestEmail` 的 `item.url` 过 `safeHttpUrl`（两个 agent 独立发现）。
- **时间体系**：邮件配额（UTC 日）/仪表盘（香港日）/digest（JST 日）三套"一天"统一为 JST；迁移与代码混用 `datetime('now')` 与 ISO 格式（`acceptance.ts:29` 的 `Date.parse` 在非 UTC Node 下偏移）——今后迁移统一 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`。
- **流程规范**：迁移中不再放运营状态变更（0036/0037/0038 整个文件都是——复跑会重置生产探针窗口；该用已有的 `/internal/start-probe` 接口）；DROP-rebuild 迁移必须同时带两个 PRAGMA；每次 remote apply 前记录 D1 Time Travel bookmark。
- **文档漂移**：HANDOFF_CURRENT_ISSUES.md 中 4 项已修 3 项、引用的文件已不存在（新 session 会重复实现已完成的功能——收敛到仅剩 issue 6）；README 的 Hermes"默认关闭"与已提交的 `HERMES_NOTIFICATIONS_ENABLED: "true"` 矛盾；supabase/（Hyperdrive `ANALYTICS_DB`，18 个 Postgres 迁移，手动 apply）完全缺席架构章节；"80 binding 预算"测试只覆盖调度侧，创建侧 409 无测试且 80 硬编码两处会漂移。
- **测试缺口**：鉴权零测试（会话签名篡改/过期/validOrigin）——把纯函数抽到 `auth-core.ts`（无 next 依赖）后补 `tests/auth.test.ts`；Python 脚本补一段 `tests/README.md` 说明手动性质。
- **配额治理**：Amazon(OpenWebNinja) 完全没有用量账本（30 分钟频率绑定=1440 次/月可无声打爆套餐）——接入 `reserveManagedApiCall`；Firecrawl 900/账期在骏河屋被封时 9.4 天烧完——加日预算 `total/30`；任一 provider 到 warning 线时产生 source_error 事件。
- **业务机会**（低成本高价值，按序）：涨价提醒（`evaluateListingEvents` 已有 old/new，加一个分支）；补货邮件附 `medianObservedActiveDurationDays`（lifecycle 已算出）；终止型监控自动退休（一次性挂牌来源连续 N 天 sold_out → 停用+"监控完成"通知）；主动式 JST 09:00 早间 digest；`assessKeywordWindow` 死代码接线替代激进的"骤降为 0 即停用"；`marketPageBudget` 放开 `maxPage` 上限；跨来源比价按品相分桶 + `catalog:` key 加 `sourceId` 前缀（一行，防目录号碰撞）；Yahoo Shopping 静默丢弃品相/有货过滤需 UI 明示。

---

## 5. 修复路线图与执行状态（2026-07-27 更新）

| 批次 | 内容 | 状态 |
|---|---|---|
| **①通知生命线** | P0-1/2/4/5/6/7 + C9 + F2 | ✅ 已上线（commit `96f9dd4`，迁移 `0041`，collector `6928b98f`） |
| **②数据与队列** | P0-3 + P0-9 + C1/C2/C3 + 迁移 0042 | ✅ 已上线（commit `e208f0e`，collector `78bcb9cd`） |
| **③安全** | A1-A7 + B1 + P0-10 部分 | ✅ 已上线（commit `34ec523`，web `f8c78f13`）。**P0-10 的代码级登录限流已否决**：改由 Cloudflare WAF 速率限制规则承担，配合长随机密码；会话吊销表同样否决（每请求一次 D1 读的代价对单人系统不划算），改为文档化"轮换 `SESSION_SIGNING_SECRET` 即作废全部会话"。cookie `secure:true` 与 7 天有效期已落地 |
| **④部署门禁** | P0-8 + 文档漂移修正 | ✅ 已上线（commit `9f340b3`） |
| **⑤适配器与性能** | C4-C8/C10/C11 + D3/D4/D5 + B2 | ✅ 主批次已上线（同 `9f340b3`）；D1/D2 后于批次⑦完成 |
| **⑥业务语义** | F1/F3-F7/F10 | ✅ 主批次已上线（同 `9f340b3`）；F8/F9 与 E 组后于批次⑦完成 |
| **⑦路线图收尾** | E 组、F8/F9、D1/D2、P2 数据卫生与配额治理、全部低成本业务机会 | ✅ 代码与本地 workerd/D1 回归已完成；生产以本节后续验收记录和 Git 历史为准 |

### 原“仍未完成”清单的收尾结果

1. **E 组前端**：错误/加载边界、四个主界面的显式失败态、页面级鉴权、轮询 AbortSignal、非 JSON API 错误、东京时间格式与 LIKE 转义已完成（主要见 `ac4b56a`）。
2. **F8/F9**：关键词上新按“整页无已知 ID”继续翻页；`delivery_mode` 不再作为可任意切换的空开关，界面按档案语义固定显示即时事件或合并摘要。
3. **D1/D2**：采集窗口先批量预读 listing/match 状态，事件插入批量预读 legacy key、listing、rule 与落地成本上下文，消除按商品/事件串行读取。
4. **P2 与数据卫生**：请求证据、确定性 listing、日元解析实现已收敛；Animate 终止条件、JST 日界、迁移 PRAGMA/运营状态、Time Travel bookmark 门禁均完成。
5. **配额治理**：Amazon/OpenWebNinja 每次真实 HTTP 请求进入原子月度账本并在阈值产生事件；Firecrawl 同时受账期预算和 JST 单日 30 次上限约束。
6. **业务机会**：涨价提醒、补货邮件历史在售时长、一次性挂牌连续 7 天终局自动退休与完成通知、JST 09:00 晨报、异常关键词窗口保护、市场页数放开、按品相比价与 Yahoo Shopping 过滤能力提示均完成。
7. **测试补齐**：鉴权篡改/过期/origin、80 binding 统一上限、预算硬停止、自动退休、生命周期中位数与晨报幂等均有自动化覆盖。

**明确暂缓**：Supabase `public` schema 权限调整不属于本轮施工范围，按用户决定保持现状。

### 生产验收记录（2026-07-27 00:20 JST）

- 安全头全部生效：`/login` 返回完整 CSP（含 `frame-ancestors 'none'`）、HSTS、XFO、nosniff、Referrer-Policy、Permissions-Policy。
- 缓存边界正确：`/sources/rakuten` 首次 `CF-Cache-Status: MISS` → 再次 `HIT`（`Age: 8`），且 HTML 内含 24 个 `product-card`（服务端渲染生效，无客户端占位符）；`/dashboard` 与 `/api/dashboard` 为 `private, no-store` + `CF-Cache-Status: BYPASS`。
- Collector 健康：43 个绑定、11 个来源在线，Mercari/骏河屋/COSPA 最近运行均 success，0 条积压事件，心跳落在每小时第 7 分钟。
- 保留清理确认执行：数据库体积 297.7 MB → 295.6 MB。首次清理待删行数为 0（最老 capture 未满 14 天），因此不存在打爆 D1 免费层每日 10 万写入配额的风险。
- 队列消费者齐全：`jobs`（并发 2）、`gemini`（并发 1）、两个 DLQ。

**待用户执行**：① Cloudflare 控制台配置 `/api/auth/login` 的 WAF 速率限制规则（建议同 IP 10 秒 5 次 → 阻断 60 秒）；② 部署 `apps/mercari-service`（Vercel）与 `apps/source-runner`（新加坡 VPS）——两者的改动与 Collector 无版本耦合，晚部署不会破坏现有链路。

---

## 6. 已确认干净的区域（免复查）

签名方案密码学正确性（scope 隔离/raw r‖s/时间窗）；密钥轮换脚本（stdin 直通 wrangler secret，不落盘）；全仓无提交密钥；SQL 全参数化（仅 `incrementCounter` 列名插值一处，编译期安全）；XSS 面（唯一 `dangerouslySetInnerHTML` 渲染常量；listing URL 入库前 https+主机白名单校验）；38 个管理 API 路由鉴权覆盖完整；SSRF 面全出站主机白名单；collector `workers_dev:false` 无路由，`/internal/*` 仅 service binding 可达；landed-cost 整数运算与 CNY 分换算维度正确；systemd 单元加固到位；`compatibility_date` 均为当月；observability 全开。
