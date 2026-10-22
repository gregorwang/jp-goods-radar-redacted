# Repository agent rules

## 1. 改动流程：开工前 → 验证 → 审查 → 提交 → 线上跑通

这个项目的 bug 大多不是"某一行写错了"，而是下面五种（2026-10-21 回看事故记录归纳）：
改 A 坏 B；两处必须一起改、只改了一处；坏了没人知道；本地好、线上坏；规则没想清楚、代码来回摆。
下面每一步各挡其中一种，不要跳。

### 1.1 开工前：先列影响范围

除了改文案、样式、文档，任何改动动手前先用大白话给用户列四件事：

1. **会碰到哪些现有功能。** 把要改的函数、表、字段、设置项全仓库搜一遍，看还有谁在用，
   不要只看要改的那一处。给来源加单独抓取频率时没查"保存档案"这条旧路径，
   结果每次保存档案都把频率冲掉（`329029c` 修）——坏的恰恰是一段没被改动的代码。
2. **可能坏在哪。** 尤其是坏了也没人会发现的地方：邮件照常到但内容不对、某个渠道静默失败。
3. **哪些东西必须一起改。** 成对的数值（第 3 节提到的排查手册里的超时表）；
   push 不会更新、要手动发布的部件（`apps/source-runner`、`apps/push-relay`）；
   数据库迁移（没有自动执行器，要手工跑）。
4. **做完后用户在线上看到什么就算成。** 说不出来，说明需求还没定清楚，先问，别先做。

碰了危险区（见 1.3）或会改变产品行为的，列完等用户看过再动手；其余的列完直接做。

### 1.2 验证：按改动类型挑着测，不跑全套

默认**不跑全套测试**（`pnpm test`、`pnpm test:all`）。全套几乎从不失败，但这不说明代码没问题：
测试是写代码时顺手写的，和代码共用同一套盲区；而且跑在假数据库上。这个项目真正出过的大事故——
SQL 在真库上报错、超时数值失配、发信密钥失效、Worker 调 Worker 被 1042 拦、抓取程序忘了手动发布——
全套测试一个都看不见。

| 改了什么 | 怎么验证 |
|---|---|
| 文案、样式、文档 | 不测。页面推上线由用户自己看，不起 Playwright、不起本地服务 |
| 普通逻辑 | 类型检查 + 只跑相关的那一个测试文件：`pnpm vitest run tests/<文件>.test.ts` |
| 修 bug（逻辑类） | 先写一个能复现它的小测试，确认它失败；修完再看它通过。每修一个 bug 留一颗钉子，同一个坑不踩第二次 |
| 修 bug（环境类：部署、密钥、渠道、超时） | 单元测试测不到，不写。把故障指纹和查法补进排查手册或巡检 |
| 判定逻辑（同款 / 疑似 / 排除 / 送达门槛） | 改前改后各跑一次判定考题集，对比哪些题的档位变了 |
| SQL、表结构 | `pnpm verify:sql`（见 1.6） |

- 需要 Docker 或 Workers 测试环境才能跑的测试，写好就行，不要自己去开 Docker、改端口配置；
  告诉用户"没跑，要跑需要什么"。
- 交付时说清楚哪些验证过、哪些没验证。不要把"类型检查过了"说成"做好了"。

判定考题集（**待建，2026-10-21**）：拿真实踩过的商品当考题，每题写明应判的档位。第一批就是第 4 节那几件：
版本错误的 `冴えない彼女の育てかた Fes. Fine A3プリモアート` 不应判成 `probable_exact`；
缩写标题的真品 `冴えカノ♭ A3プリモアート 深崎暮人` 不应被硬拒；
目标是爱蜜莉雅毛绒玩具时，拉姆手办应判不相关。以后用户每指出一次"判错了"，就加一题。

### 1.3 审查：只审危险区

改动碰到下面任何一块，交付前对这次改动跑一次 `/code-review`（只审改动本身，不用开分支）：

- 数据库、SQL、表结构
- 采集、判定代码（`apps/collector`、`packages/*`）
- 发送和通知（`apps/collector/src/notice-channel.ts` 及各渠道）
- 花钱的功能（AI 调用、GPU、付费接口）

只看改动的审查，看不到"没被改、但被波及"的代码，所以审查必须专门回答一句：
**改掉的东西还有谁在用？** 文案、样式、只有用户自用的主站页面不审。

### 1.4 提交和分支

- 直接在 `main` 上提交，平时不开分支（一个人开发，分支的协作价值用不上）。只在用户要求时提交。
- **每次提交只做一件事。** 回退靠提交，不靠分支。
- push 到 `main` 会自动部署 web 和 collector，所以半成品不能进 `main`。只有要做好几天、
  中途不能上线的大改（判定逻辑大改、表结构大改）才开分支，做完再合回。

### 1.5 完成的标准

线上跑通一次才算完成，本地预览和类型检查都不算。要手动发布的部件，要确认已经发布。

### 1.6 `pnpm verify:sql` 是部署门禁，不是测试

- `pnpm verify:sql` is a deployment gate: it takes every
  static `.prepare(...)` statement in `apps/collector/src`, `apps/web/src` and
  `packages/db/src`, rewrites `?` to `$n` exactly as the runtime does, and
  PREPAREs each one against the production database. Run it before shipping any
  change that touches SQL. `pnpm deploy:collector` and `pnpm deploy:web` run it
  automatically; `deploy:collector:only` deliberately does not.
- Why it exists: parameter type inference happens only at PostgreSQL's PREPARE
  step, so neither typecheck nor the unit tests (which use a fake D1) can see
  it. On 2026-09-04 a `WHEN ? IS NULL` shipped this way and every keyword
  collection run failed overnight with `42P08 could not determine data type of
  parameter $1`, while the digest emails kept arriving and looked healthy.
  Set `JPGR_SKIP_SQL_VERIFY=1` only when the database is genuinely unreachable.
- Where the gate actually runs now: **`git push`**, via `.githooks/pre-push`
  (`git config core.hooksPath .githooks`; a fresh clone must set that once).
  `jp-goods-radar-web` and `jp-goods-radar-collector` are both deployed by
  Cloudflare Workers Builds on push, and the build box has no SSH key for the
  VPS — `verify:sql` is `ssh root@… psql`, so it cannot run there. Push is the
  last checkpoint that still holds the key. The hook only fires when the push
  touches `apps/collector/src`, `apps/web/src`, `packages/db/src` or `postgres/`.

## 2. Database access

Production uses PostgreSQL 17 on the VPS. The database is `jpgr`; its main schemas are `radar_core`, `radar_analytics`, and `jpgr_meta`.

Access it over SSH:

```powershell
ssh root@203.0.113.10 "sudo -u postgres psql -X -d jpgr"
```

Cloudflare Workers access the same database through Hyperdrive. `PRIMARY_DB` and `ANALYTICS_DB` are two bindings for the same PostgreSQL instance.

## 3. Architecture

- `apps/web`: Next.js admin UI deployed as a Cloudflare Worker.
- `apps/collector`: Cloudflare Worker for scheduled collection, queues, monitoring, and notifications.
- `apps/mercari-service`: Vercel source adapter for endpoints that need a dedicated service.
- `apps/source-runner`: VPS service for public HTML collection.
- `apps/push-relay`: owner-only push relay: the Android app (Durable Object WebSocket) and, since 2026-10-13, Feishu (owner DM + a group webhook). Deployed by hand with `pnpm --filter @jpgr/push-relay run deploy`, not by Workers Builds. **推送 / 飞书 / App 的事先读 `docs/常用/自用推送渠道-总览.md`。**
- `apps/android-push`: the owner's native Android push app (Kotlin/Compose, sideloaded). Not part of the pnpm workspace; built with Gradle. See its README.
- `packages/*`: shared domain logic, adapters, database access, analytics, AI, email, notifications, and validation.
- `postgres/`: current PostgreSQL schema baseline and migrations.
- Notifications: every notice has one row per channel (email / feishu / hermes) in
  `radar_core.notice_deliveries`, and all channels share one send loop
  (`apps/collector/src/notice-channel.ts`). A new channel only adds its pick-up SQL and its send step;
  do not write another claim / retry state machine. Which channel a notice goes to is decided by the
  dossier's `notify_email` / `notify_feishu`.

**关键词日报没发出来时，先读 `docs/常用/行情邮件未送达-排查手册-20260922.md`。** 里面有分诊顺序
（抓取 → AI 判定 → 日报聚合 → 发送，先定位断在哪一段，不要猜原因）、已知故障的指纹和修法，
以及一张**必须成对的超时数值表**——代码里的等待时长必须小于 PostgreSQL 角色 `jpgr_app` 的
`idle_in_transaction_session_timeout`，这对数字失配过一次，整天的判定结果无声丢光，
而类型检查和 `verify:sql` 都看不见它。

## 4. 注意力是最稀缺的资源（产品判据，改匹配 / 过滤 / 通知逻辑前必读）

这套系统的产出不是"找到的商品"，是"值得用户花时间看的商品"。算成本时按这个算：

- **一封该发的邮件**：用户看一眼就下单，价值等于那件商品。C2C、拍卖、限定周边
  多为一次性挂牌，售出即终局（见 `packages/core/src/watch-semantics.ts` 的
  `ONE_OFF_LISTING_SOURCES`），没有"下次再说"。
- **一封不该发的邮件**：代价不是"多看一眼"。它消耗用户当天的注意力预算，并且拉低
  下一封邮件被打开的概率。连发三封 AI 自己都写明"角色不对、品类不对"的邮件，
  第四封真品就没人看了——**误报的终局仍然是漏报**，只是漏在收件箱里，不在代码里。

由此推出的硬性规则：

- **系统的职责是给出结论，不是把选择题转交给用户。** 一条候选如果已经能说清
  "它和目标差在哪、为什么不是"，这件事就判完了，不要再包装成"待你判断"发出去。
  把自己有能力做的判断转嫁给用户不是谨慎，是失职。
- **判定档位和送达门槛是两件事，永远不要焊死。** 判定档位
  （`decision_status` × `match_relation` × AI 的 `relevance`）描述系统怎么看这条候选，
  力求准确；送达门槛描述什么档位值得打扰人。二值化的"发 / 不发"是这里每一次事故的
  共同根因：一旦"发"等于"确认"，想不误报就只剩"删掉"一条路，真品就是这么没的。
- **送达门槛必须是每个档案一个设置，不能有全局开关。** 同一个"高度疑似"，
  对求了三年的绝版是必须看，对随手加的便宜货是骚扰。这个权重只有用户知道，
  系统无权替所有商品统一定值。
- **默认取最严的一档：只发确认同款。** 默认值服务的是"还没想清楚这件商品对自己
  多重要"的人，那种状态下少打扰比多打扰安全——想多看的人会主动去调，
  被烦到的人只会从此不再打开邮件。放宽是用户的显式选择，不是系统的善意推定。
- **拒绝要有反证，降档要写清缺什么。** "没找到证据"和"找到了反证"在代码里不能同分：
  硬标识符（JAN / 型号）冲突、命中用户填写的排除词、AI 明确判 `irrelevant`
  是反证，可以定案；字面覆盖不达标、模型没把握是证据不足，只能降档。
  降档时那行差异说明（目标有什么、这条缺什么）是这条记录的全部价值，
  写不出具体缺了哪个词，等于没降档。
- **把代码有把握的事做厚，没把握的事做薄。** "指出哪些词对不上"是确定性的，
  代码做得对；"替用户下同款与否的结论"光靠字面做不对——所以那一步交给 AI，
  并且把 AI 的表态原样落库、参与判定，而不是只当成一段展示文本挂在理由里。
- 中间档位在数据模型里已经存在：`radar_core.watch_run_listing_observations.decision_status`
  的 CHECK 约束包含 `uncertain`。新增判定时优先落到已有档位，不要新造一个静默状态。

为什么写下来——两次方向相反的事故，同一个根因：

2026-09-05，一个精确同款雷达把版本错误的
`冴えない彼女の育てかた Fes. Fine A3プリモアート` 判成 68 分 `probable_exact`，
戴着"确认同款"的帽子发了邮件；**同一轮**里真正正确的缩写标题
`冴えカノ♭ A3プリモアート 深崎暮人` 只有 38 分，落到 `related`，
被 `exactProductIdentityDecision` 无条件硬拒、连语义复核都没送。又松又漏。

2026-09-06，上一次的修补走到了另一头：`related` 且 AI 已经明确写下
"角色为拉姆，且品类是手办，与目标爱蜜莉雅毛绒玩具不符"的候选，照样进了
「疑似同款」分区，以「2 件疑似同款待你判断」为标题发了出去。AI 的结论存在，
还被拼进 `decision_reason` 给用户看了，却从未参与决策——
`exactProductIdentityDecision` 在读 AI 输出之前就按 relation 短路，
摘要查询也只看 `decision_status` 和 `match_relation`。

两次的根因是同一个：**输出是二值的，判定和送达没有分开。**
分档标注 + 每档案可配的送达门槛，这两个毛病才一起消失。

## 5. 试验靠开关，不靠分支

新的判定 / 过滤功能必须能按档案开关，默认关；先在一个档案上打开跑稳，再推广到其他档案（参考图找货就是这个模式）。
