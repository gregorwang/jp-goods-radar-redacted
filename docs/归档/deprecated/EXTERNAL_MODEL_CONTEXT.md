# 格银西里尔（JP Goods Radar）项目事实背景包

> 文档性质：供无法直接读取本仓库的外部模型理解项目现状时使用的背景材料。
> 文档语言：中文；项目中的商品、来源名称、字段和值可能为日文或英文。
> 编写基线：本地仓库的 main 分支，最近提交 a629387；整理日期为 2026-08-09（Asia/Tokyo）。
> 重要边界：本文只描述当前可由代码、配置、数据库和仓库文档核对的事实。它不是架构方案、迁移方案、容量结论、成本测算、任务清单或技术选型建议。

## 1. 本文的用途与非用途

“格银西里尔”目前是一个真实运行中的日本商品搜索、关注和监控系统。网页端的外部模型通常不能访问本地 Git 仓库、Cloudflare Worker 配置、PostgreSQL schema、Worker 源码、测试夹具或历史迁移；因此，仅凭一句“我有一个日淘监控项目”无法可靠理解它的实际状态。

本文的作用是把这些仓库内可核对的事实集中为一个自包含背景包。使用者可以把全文作为与外部模型讨论前的上下文，再自行提出、质疑和追问具体问题。本文本身不提前替外部模型回答任何问题。

本文刻意不做以下事情：

- 不判断当前架构是否“正确”或“最佳”；
- 不提出应当迁往何处、应当保留或移除何种云服务；
- 不给出机器规格、预算、吞吐量或容量结论；
- 不设计未实现的用户、组织、权限、隔离、迁移或运维方案；
- 不把历史设计文档、旧的 P0 状态快照或配置注释误写成当前线上实时状态；
- 不包含任何密钥、密码、数据库连接串、私有 IP、Webhook secret 或生产凭据。

“事实”也有时效边界。本文以仓库内容为准，不能证明某个第三方来源此刻仍可访问、某个 Worker 当前健康、某项凭据当前仍有效，或某个云平台上刚刚发生的变化。涉及线上即时状态时，应当另行检查实际控制台、日志、数据库或部署版本。

## 2. 项目名称、定位与产品边界

项目的中文名称是“格银西里尔”，代码仓库和运行资源常使用 “JP Goods Radar” 或 “jpgr” 作为英文/内部名称。它最初定位为单人自用的跨平台日淘商品雷达：帮助操作者在多个日本商品来源中搜索商品、保存搜索历史、创建关键词或指定商品的关注档案、周期性采样来源结果、记录价格和库存变化，并通过邮件与 Hermes 微信通道接收通知。

该系统不是以下类型的产品：

- 不是电商交易平台：不提供下单、支付、代购、履约、物流、退款或卖家管理；
- 不是通用网页爬虫：来源、请求操作、URL 形态和数据结构都被代码固定或严格校验；
- 不是“全网完整索引”：许多 HTML 来源只承诺滚动窗口或尽力覆盖，不能把当前返回结果解释为整个站点的完整库存；
- 不是自动投资顾问：它记录行情样本、价格事实、严格成交证据和到手成本情景，但不自动生成“买入/卖出”信号；
- 不是市场分析报告生成器：应用本身不再生成市场分析报告，临时探索、图表、深度行情研究和回测被划到外部 Databricks 工作区；

项目的核心原则是“先留证，再计算，再做可重跑的语义衍生”。来源采集成功与否不依赖 AI；确定性事实如价格、库存、首次出现、状态差异和数量由程序或 SQL 处理；语义性问题如商品相关性、中文标题、品相、缺件、品类、作品名和角色识别由独立 AI 清洗任务处理。来源事实与 AI 衍生结果必须分层，AI 的失败不能使已采集的证据失效。

## 3. 当前用户界面与可见产品功能

Web 管理端是一个中文为主、面向管理员的 Next.js 应用。登录后主要导航包括：

- “今日情报 / Dashboard”：聚合当日概览、运行状态、事件和来源情况；
- “跨站搜索 / Search”：对选定来源执行即时搜索，呈现各来源独立的成功、空结果、失败、警告、覆盖范围、分页或请求证据；
- “关注档案 / Watches”：创建、编辑、暂停、恢复、删除和立即运行关注档案与来源绑定；
- “商品库 / Listings”：浏览已经由系统持久化的商品、详情、来源字段、快照、价格曲线或库存时间线；
- “变化与通知 / Events”：查看事件，重试邮件投递或抑制不需要的事件；
- “来源控制台 / Sources”：查看来源能力、启用状态、健康度、冷却、探针和测试入口；
- “搜索历史 / Search history”：读取已保存的搜索会话和结果快照；
- “商品情报 / Intelligence”：展示同款身份、价格事实、成本配置、到手成本与相关的确定性投影；
- 公开的 Rakuten 来源展示页：与私有管理端分开，具有独立缓存边界。

管理端页面与 API 默认设置为私有且不缓存；公开 Rakuten 页面及其公开数据端点才允许短期边缘缓存。前端有严格的内容安全策略、禁止被嵌入的响应头、Cookie 变化缓存隔离和 HTTPS 安全头。图片主要来自来源站点或本地资源，前端不把平台 API 凭据发送到浏览器。

### 3.1 即时搜索

管理员在搜索页提交关键词、来源、筛选条件或参考 URL。Web 路由验证管理员会话和同源请求后，通过 Cloudflare Worker service binding 调用 Collector 的内部搜索端点；浏览器不直接调用外部来源。每个来源独立执行、独立汇总，因此一个来源失败不会把其他来源的成功结果变为整体失败。

搜索结果使用统一的 NormalizedListing 结构。统一字段至少包括来源 ID、来源商品 ID、实体范围、规范 URL、标题、描述摘要、图片、卖家/店铺、币种、当前价、原价、价格性质、品相、库存状态、来源提供的时间、结构化商品事实和来源特有元数据。统一结构的目标是让界面、监控和数据库使用同一种基本语言，而不是在每个页面直接解析各来源网页。

即时搜索会形成可持久化的搜索历史和结果快照。对于“精确商品”模式，系统还存在 Cloudflare Workflow、查询变体、候选聚合、详情复核、确定性匹配和后续语义复核等运行结构。它们用于把“普通关键词搜索”与“我想找的是某一个具体同款/变体”区分开来。精确同款模式不会把“看起来相关”自动等同于“身份确认”。

### 3.2 关注档案、来源绑定与巡检

一个关注档案（watch profile）是用户层面的业务容器，目前由单管理员创建。它可包含名称、说明、默认价格上限、包含词、排除词、启用状态，以及档案类型。代码中档案类型包括：

- item：单个商品；
- exact_product：精确同款或指定变体；
- keyword：关键词发现；
- market：关键词市场采样。

一个档案可以拥有一个或多个来源绑定（watch binding）。绑定决定具体来源、关键词或目标 URL/商品 ID、来源特有配置、运行频率、下一次运行时间、通知开关、价格阈值、最小价差、当前冷却与失败状态。绑定类型主要分为 keyword 和 item；监控目的包括 item_price、keyword_new_listing 与 keyword_market。当前数据库约束允许调度频率在 30 分钟到 1 天之间，旧字段中仍保留以分钟计的兼容值。

用户可以从搜索结果保存关键词订阅，也可以从某个商品详情创建指定商品关注。代码对一次性挂牌与目录型 SKU 有不同的业务语义：Mercari、Yahoo! オークション、Yahoo! フリマ、eBay 之类的一次性挂牌在售出/交易终局后不会有真正的“补货”；而目录型店铺 SKU 可能再次上架，因此售罄后仍可保留补货监控。

### 3.3 运行后的状态差异与事件

Collector 每次完成绑定采样后，会把新结果与之前的持久化状态和快照比较。事件算法使用稳定的 event key，并在价格转换等事件中引入时间桶，目的是使同一轮重试保持幂等，同时允许以后真正再次发生的状态转换重新产生事件。

已实现的业务事件语义包含新挂牌、确认后的降价、涨价、目标价命中、补货、售罄、来源错误、摘要和单品监控完成等。新挂牌通常要求商品处于可购买状态；价格下降需要比较前后可比较价格、满足最小差额，并经过后续确认；目标价使用确认后的新价格；补货识别为不可用状态恢复为 available；售罄通知需要对应开关。对于已建立基线的关键词绑定，异常地从典型结果数量跌至零且不是来源明确验证的空窗口，会被识别为可能的解析/来源退化，而不是直接当作真实全站空结果。

通知投递从采集主流程中分离：采集成功不会因为邮件或微信投递失败而被改写为采集失败。Resend 邮件和 Hermes 微信 Webhook 有各自的持久化投递记录、尝试次数、错误状态和幂等键。邮件存在每日发送上限和 digest 合并行为；任一通道的失败不改变另一通道的结果。

## 4. 来源范围、来源类型与采集边界

核心领域类型中声明的来源 ID 包括：

~~~text
rakuten_ichiba
rakuten_books
yahoo_shopping
yahoo_auctions_jp
yahoo_fleamarket_jp
amazon_jp
ebay
mercari_jp
surugaya
charaon
cospa
animate
~~~

“声明了来源 ID”不等于当前都有可运行适配器。当前适配器注册表实际挂载 Rakuten Ichiba、Rakuten Books、Yahoo! Shopping、Yahoo! オークション、Yahoo! フリマ、Mercari Japan、骏河屋、CharaON、COSPA、Animate 和 Amazon Japan；eBay 目前出现在领域枚举与一次性挂牌语义中，但不在当前本地适配器注册表中。

来源可使用的传输类型包括 official_api、internal_api、html_endpoint、managed_api 和 manual。实体范围可为 listing、catalog 或 offer；覆盖范围被明确表示为 complete、rolling_window、best_effort 或 unknown。接口层把来源能力拆成关键词搜索、单品查询、最新排序、价格筛选、品相筛选、已售历史能力等；不能把一个来源有“搜索”能力推导为它有完整的历史成交或库存能力。

### 4.1 Rakuten

Rakuten Ichiba 和 Rakuten Books 使用正式 API 适配器。仓库中有 Rakuten 凭据和合规闸门的配置接口，但绝不保存实际凭据。公开 Rakuten 页面与私有监控的边界不同：代码和配置中存在对私有定时监控的来源级开关，默认不把“能即时搜索”自动视为“已获准进行私有定时监控”。Rakuten 页面要求来源隔离、授权标识与来源提供的商品链接。

### 4.2 Mercari

Mercari Japan 的类型为 internal_api。Collector 通过一个固定用途的东京 Vercel 服务调用其适配器；服务只接受带时间戳、作用域和 P-256/ECDSA 签名的短时请求。Mercari 请求会使用 DPoP，但项目不使用用户登录态、Cookie、代理轮换或验证码绕过。Vercel 服务的端点和入参 schema 仅允许固定的 Mercari 搜索和商品 ID/官方 URL 形态，不能被调用成任意转发代理。

### 4.3 公开 HTML 与实验来源

骏河屋、Yahoo! Shopping、Yahoo! オークション、Yahoo! フリマ、Amazon Japan、CharaON、COSPA 与 Animate 主要依赖公开 HTML、JSON-LD 或页面内结构化数据。当前路由可能是 Cloudflare 直连，也可能在规定条件下使用东京固定用途服务、新加坡 Source Runner、浏览器回退或受预算限制的托管回退。路由选择、超时、页面数、分页间隔、冷却、失败与回退证据都属于当前运行逻辑的一部分。

项目对 HTML 来源采用保守边界：

- 只访问固定域名和固定操作，不接受调用方提供的任意上游 URL；
- 对响应正文、超时和分页有上限；
- CAPTCHA、403、429、结构变化、登录要求、异常空结果或解析失败不能被伪装成正常商品结果；
- 分页、滚动窗口和来源排序决定了可见结果范围；很多来源不应被理解成全站完整库存；
- 搜索和详情可能分开，详情用于补全 JAN、厂商、作品、发售日期、规格、图片或官方定价等字段；
- 来源错误通常只影响该来源，不应拖垮其他来源、数据库或通知系统。

Yahoo! オークション的已结束搜索和详情有额外的“严格成交证据”语义：只有来源明确结束、至少有一次出价、存在合法最终价格和结束时间、且具有稳定来源 ID 的记录才会进入 verified_sale 候选。普通 sold_out、下架、页面消失或未中标不能自动证明成交。

### 4.4 Source Runner

Source Runner 是部署在新加坡 VPS 的 Node.js/Playwright 服务，当前作为不稳定公开 HTML 来源的受控执行器之一。其公开网络面由 Caddy 反向代理；Node 本身绑定在 127.0.0.1。对外仅暴露健康检查及已签名的任务创建/查询接口，健康检查只返回存活信息，不返回来源名单和队列深度。

Runner 的请求是“来源 ID + 操作 + 已验证参数”，不是任意 URL。它有单个内存串行任务队列、队列深度上限和短时任务状态。普通 HTTP 是主要路径；仅在受限的 403/challenge 情况下临时启动匿名、无持久化 userDataDir 的 Chromium，并在任务结束时关闭。服务配置还包含 systemd 资源限制、专用低权限用户、内存上限、CPU 配额、Caddy 的正文上限，以及本地业务修复事件 spool 相关代码/文档。

Runner 的存在不等于所有来源都必然经 VPS 采集。当前仓库中有直连、Vercel 服务、Runner、Browser Run 和受预算限制托管回退等多条受控路径；某条来源在某一时刻的真实选路和可用性属于运行状态，而不是仅从本文即可断言的永久事实。

## 5. Monorepo 结构与各模块职责

仓库使用 pnpm workspace，工作区范围为 apps/* 与 packages/*。主语言是 TypeScript；前端使用 React 与 Next.js，后端部分同时运行在 Cloudflare Workers、Vercel Serverless 和 VPS Node 进程中。

### 5.1 应用目录

| 路径 | 当前职责 |
| --- | --- |
| apps/web | Next.js App Router 管理站，经 OpenNext 构建为 Cloudflare Worker；提供登录、页面和 Web API。 |
| apps/collector | 独立 Cloudflare Worker；负责 Cron、Queue consumer、采集、巡检、事件、通知、来源测试、AI 任务编排和内部搜索。 |
| apps/mercari-service | 名称保留自历史，但实际上是东京 Vercel 的固定用途来源适配服务；处理 Mercari 以及部分固定来源服务调用。 |
| apps/source-runner | 新加坡 VPS 上的 Node.js/Playwright 来源运行器；以 Caddy + systemd 部署。 |

### 5.2 共享包

| 路径 | 当前职责 |
| --- | --- |
| packages/core | 来源 ID、统一商品类型、状态哈希、事件算法、监控语义、价格事实、成本、商品匹配、分页与安全辅助函数。 |
| packages/adapters | 各来源的请求、解析、标准化和错误处理；包含 Rakuten、Mercari、Yahoo、Amazon、骏河屋和固定 HTML 店铺适配器。 |
| packages/db | PostgreSQL/Hyperdrive 的 repository、查询参数、数据库接口和运营数据访问。 |
| packages/analytics | 面向分析 schema 的证据读取、清洗候选、市场范围和历史商品读取。 |
| packages/ai | Google AI Studio 请求构造、结构化输出解析、限流预算、重试延迟解析和商品语义清洗定义。 |
| packages/validation | Zod schema；用于 HTTP、任务、来源结果、AI 结果和业务载荷校验。 |
| packages/email | Resend REST 调用与邮件模板。 |
| packages/notifications | Hermes Webhook 的 HMAC 签名和有界 HTTP 投递。 |

共享包通常用 TypeScript 源文件互相引用；Web 的 Webpack/OpenNext 配置专门处理共享包的 ESM 相对 .js 导入在开发源码中的扩展名回退。根 package 要求 Node.js 不低于 20.9，并使用 pnpm 9。

## 6. 当前运行拓扑与请求路径

当前生产架构不是“全部运行在一个 VPS”的单体部署，而是多运行环境协作：

~~~text
管理员浏览器
    │
    ▼
Cloudflare 上的 Web Worker（Next.js + OpenNext）
    │  内部 service binding / Hyperdrive
    ├──────────────► Cloudflare 上的 Collector Worker
    │                    │
    │                    ├── Cloudflare Queues / Cron / Workflow / Browser binding
    │                    ├── 各来源适配器与受控公开请求
    │                    ├── 东京 Vercel 固定用途来源服务
    │                    ├── 新加坡 VPS Source Runner（已签名任务）
    │                    ├── Google AI Studio 直接 HTTPS
    │                    ├── Resend / Hermes
    │                    └── Hyperdrive
    │
    └────────────────────────────────────────────► VPS PostgreSQL 17（jpgr）
                                                        │
                                                        └── R2 加密备份 / 外部 Databricks 读取
~~~

Web Worker 与 Collector Worker 是不同的 Worker 服务。Web 的 wrangler 配置有 Collector service binding、Web 自引用 binding、Hyperdrive PostgreSQL binding 和普通监控队列 producer。Collector 的 wrangler 配置有两个指向同一 PostgreSQL 实例的 Hyperdrive binding、Browser binding、产品搜索 Workflow、普通监控队列、Gemini 队列、死信队列和停车队列。

Collector 对内部搜索预览、单品预览、来源状态、来源测试、P0 验证等提供内部路由。Web API 不将这些原始 Collector 路由直接暴露给浏览器，而是先进行 Web 管理员会话校验，再通过 Worker service binding 进行调用。来源服务与 Source Runner 也各自有签名、时间窗、作用域、入参和重放保护，不把它们设计为通用代理。

### 6.1 Web 层

Web 使用 Next.js 16、React 19、OpenNext Cloudflare 运行时和 pg/pg-cloudflare。它的 API 路由主要可归为：

- 登录、登出、会话；
- Dashboard、来源、事件、商品库；
- 搜索预览、原始导出、单品预览、搜索历史；
- 关注档案、来源绑定、暂停/恢复、立即运行、运行历史和匹配商品；
- 单品监控、成本配置、精确商品情报；
- 来源启用/停用/测试、P0 验证；
- 保留的 AI 相关入口和 analytics 同步/影子回放接口。

这里的“Web API 存在某个路径”不应被理解为所有功能均向匿名用户开放。私有读取端点使用管理员会话校验，变更端点还校验请求 Origin。Next 配置把管理端和 /api 路径标为 private, no-store，并设置 Vary: Cookie；公开 Rakuten 路径另行声明短期缓存。

### 6.2 Collector 层

Collector 是业务调度与后台处理的中心。它会：

- 从数据库领取到期的 watch binding；
- 在数据库中原子预约绑定，避免同一绑定被重复领取；
- 创建 watch run，调用对应适配器或受控路由；
- 捕获来源响应元数据和受限结构化响应；
- 对结果进行确定性过滤、异常窗口识别、商品持久化、快照与状态哈希比较；
- 产生事件、安排价格二次确认、投递通知；
- 向 analytics outbox 写入数据并安排分析/清洗后处理；
- 维护来源冷却、探针、健康状态、完成通知、历史保留清理和 Cron 心跳；
- 接收 Queue 消息，处理重试、死信持久化和最终停车。

Cron 配置为每分钟触发。当前说明中约定：每分钟主要领取到期关注；每小时第 7 分钟运行心跳、保留清理、探针和维护任务。调度并不意味着每分钟对每个来源请求；每个 binding 自身有下一次运行时间、频率、冷却和容量边界。

### 6.3 Queue、工作流与死信

Collector 配置了普通监控队列和 Gemini 队列。普通监控队列每批一条、并发上限为 2；Gemini 队列每批一条、并发上限为 1。设置的目的在于限制同一时间对外部来源或模型的压力，而不是把所有待处理工作无限并发。

两个主队列各自有 DLQ。DLQ consumer 会优先把失败投递的业务事实持久化；若这一持久化链路持续失败，消息会在多次、较长间隔重试后进入没有 consumer 的 parking queue，等待人工恢复。队列消息在数据库中也有 receipt、尝试、错误、死信与幂等记录，因此 Cloudflare Queue 本身不是唯一的失败证据位置。

产品精确搜索还配置了 Cloudflare Workflow。搜索历史、workflow task、每来源 workflow result、AI job、AI manifest 和商品身份投影都有对应的持久化表或载荷；这说明某些用户发起的搜索可在页面请求之外继续完成，并不依赖浏览器一直保持打开。

## 7. 监控调度、来源健康与运行保护

每个 binding 都有 enabled、next_run_at、last_run_at、last_success_at、baseline_completed、consecutive_failures、cooldown_until、last_error_code 和 last_error_message 等运行状态。Collector 读取 due bindings 后进行预约；如果绑定已禁用、来源不存在、来源未允许定时监控或仍处于冷却期，会把该轮记录为对应的跳过/失败语义，而不是偷偷执行。

来源健康不是单一布尔值。source_registry、source_health_snapshots、source_probe_observations、source_probe_windows、source_probe_window_history、experimental_source_runtime 与 watch_runs 共同记录：

- 来源是否启用、凭据状态、健康状态、传输类型、实体范围、能力、解析器版本；
- 上次成功/失败、连续失败、HTTP 状态、403/429、冷却截止时间与错误摘要；
- 结果数量、字段完整度、CAPTCHA、CPU 限制、登录需求和覆盖范围；
- 探针窗口开始/结束、计划结束时间、成功次数、字段完整率、路径变化及决策证据；
- 某些实验来源的请求节奏、失败窗口和电路断开时间。

适配器、路由与解析层会保留 requestEvidence，例如请求库存模式、原始和标准化结果数、已取页数、解析接受/拒绝数、详情补充数和是否为已验证空结果。这样“返回零件商品”与“来源出错或页面结构改变导致看起来是零件商品”在数据模型中并不等价。

来源发生 403、429 或可重试错误时，系统可解析 Retry-After、记录冷却并按来源隔离。某些路径有严格超时、正文上限和受控回退。回退发生时会记录主路径失败证据、实际路由和缓存状态；不能把回退成功误称为从未发生过主路径失败。

## 8. PostgreSQL：唯一生产运营数据库与 schema 分层

当前生产运营数据库是 VPS PostgreSQL 17 中名为 jpgr 的数据库。README 与 Wrangler 配置描述：Web/Collector 的 PRIMARY_DB 和 Collector 的 ANALYTICS_DB 都指向同一个私有 Hyperdrive 配置，经 Workers VPC 与 Cloudflare Tunnel 访问 VPS PostgreSQL。项目不再把 Supabase 作为当前目标运行库；supabase/migrations 目录保留为 radar_analytics 的历史迁移来源。

数据库至少有三个逻辑 schema：

| Schema | 当前角色 |
| --- | --- |
| radar_core | 搜索、监控、通知、队列、来源健康、成本配置等运营数据。 |
| radar_analytics | 来源证据、观察记录、AI 清洗、商品身份、价格事实和面向 Databricks 的确定性视图。 |
| jpgr_meta | 迁移版本与导入/冻结相关元数据。 |

数据库角色、视图权限和函数权限也在 schema 基线与迁移中管理。应用使用 runtime 角色访问必要的表/函数；历史 market_ai_reports 表被保留作兼容状态，但运行时权限被显式撤销，应用不应读写该表。

### 8.1 radar_core：运营事实

radar_core 的核心实体可按业务用途分组理解：

| 实体组 | 代表表 | 当前含义 |
| --- | --- | --- |
| 关注与调度 | watch_profiles、watch_bindings、watch_runs、monitor_rules、monitor_events | 档案、来源绑定、每轮执行、规则和监控事件。 |
| 商品运营镜像 | listings、listing_snapshots、watch_listing_matches | 当前商品行、随时间变化的快照、某绑定接受了哪些来源商品。 |
| 搜索与工作流 | search_history、search_result_snapshots、search_candidate_hits、search_query_variants、product_search_workflow_tasks、product_search_workflow_results | 搜索会话、分页结果、精确同款候选与异步工作流状态。 |
| 来源运行状态 | source_registry、source_health_snapshots、source_probe_observations、source_probe_windows、source_probe_window_history、experimental_source_runtime | 能力、健康、探针、窗口、限流与冷却。 |
| 事件与投递 | events、email_deliveries、hermes_deliveries、notification_channels、completion_notifications | 业务事件、邮件/微信投递、通知通道与完成通知幂等状态。 |
| 队列与后台任务 | queue_message_receipts、queue_dead_letters、analytics_outbox、gemini_jobs、gemini_job_payload_chunks、gemini_provider_cooldowns、gemini_request_reservations、gemini_token_reservations | Queue 消息证据、死信、跨 schema outbox、模型任务、限流与预算预约。 |
| 运行维护 | cron_heartbeats、daily_counters、verification_checks、p0_qualification_runs、runtime_feature_flags | 心跳、每日计数、验证证据、P0 运行与功能标志。 |
| 成本与受控外部额度 | cost_profiles、managed_api_cache、managed_api_monthly_usage、managed_api_billing_usage 等 | 版本化成本参数、托管 API 缓存与额度使用。 |

其中 watch_profiles 与 watch_bindings 没有 tenant_id、user_id、organization_id 或类似归属字段。当前 session payload 的主体固定为 admin；数据库中也没有用于应用用户登录、成员关系、角色、组织、订阅、账单或配额的正式实体。

### 8.2 radar_analytics：证据、观察、衍生和分析入口

radar_analytics 将可分析的数据与运行时业务控制分开。它的主要实体包括：

| 实体组 | 代表表/视图 | 当前含义 |
| --- | --- | --- |
| 搜索运行与范围 | search_runs、search_run_sources、market_scope_versions、market_scope_daily_metrics、market_scope_daily_source_metrics | 一次搜索/采样、每来源结果、版本化市场范围与按日指标。 |
| 来源商品与观察 | source_listings、listing_observations、keyword_listings、source_run_artifacts、source_response_captures、operational_listing_snapshots | 来源商品的稳定行、逐次观察、关键词归属、规范化来源组、响应捕获和运营快照。 |
| AI 语义衍生 | ai_processing_batches、ai_enrichments、latest_cleaned_listings | 模型请求/响应证据、逐条清洗结果、最新清洗投影。 |
| 商品身份和比较 | canonical_products、catalog_products、product_variants、comparison_profiles、product_listing_memberships、product_listing_links、current_product_listing_memberships | 规范商品、变体、比较档案、来源商品归属以及当前有效身份关系。 |
| 历史成交和价格 | sale_records、strategy_price_facts_core_v1、strategy_price_facts_v1 | 严格成交记录与可用于点时回测的价格事实视图。 |
| 历史兼容 | market_ai_reports | 迁移历史兼容状态；当前应用运行时不读写。 |

source_listings 表将来源 ID 与来源商品 ID 作为可寻址商品事实；listing_observations 记录它在某次 run 中的价格、库存、内容哈希、标准化载荷和观察时间。AI 清洗、商品身份判断和销售记录不是对这条来源观察的覆盖，而是通过外键、版本、输入哈希、证据与时间字段建立的后续关系。

### 8.3 运行数据与分析数据的桥接

Collector 在 watch run 完成后可把 analytics 相关载荷写入 radar_core.analytics_outbox。outbox 记录类型包括 preview_search、watch_market、ai_enrichment、listing_backfill 与 product_identity，并有 pending、queued、processing、succeeded、failed、skipped 等状态、尝试次数、错误和时间。该设计表明运营采集与后续 analytics/AI 处理具有明确的异步边界。

核心 schema 和分析 schema 中都存在商品快照、来源响应或健康等相近概念；它们的目的不同：前者支撑运行、监控和用户界面，后者支撑可追溯证据、历史观察和外部分析。外部模型不应简单假设两边任一同名概念总是一一对应或可以无条件互相替代。

## 9. 证据保存、原始数据与保留窗口

项目规定采集必须先保留完整的结构化来源证据，再进行语义处理。这里的“完整”并不意味着把任意网页正文永久塞进数据库：

- 公开 HTML 在内存中解析；
- 数据库保留请求/响应 URL、请求方法、响应状态、内容类型、字节数、内容哈希、捕获时间、耗时、截断标志、受限错误摘要和解析得到的商品字段；
- HTML capture 有数据库约束：payload_kind 为 html 时 raw_payload 必须为 NULL，即不持久化完整 HTML 正文；
- JSON、文本或经隔离服务回传的有界结构化响应可按规则保留，但同样受大小、脱敏和边界约束；
- 正常化后的商品字段可以包含 title、descriptionExcerpt、价格、状态、事实、来源元数据和来源证据；
- 请求头、含密钥的请求体、Cookie、登录态、凭据 URL 和任意未审计外部正文不应进入运行日志或数据库。

内容哈希、来源商品 ID、规范 URL、采集时间、解析器版本、请求证据与状态使得同一来源事实可以追溯、去重、再处理或比较。历史 AI 版本、prompt 版本、模型名、输入哈希、模型原文和结构化输出也用于追溯；它们不会覆盖来源载荷。

README 记录了当前运营保留策略：capture 元数据及有界结构化响应 14 天，watch_runs 90 天，listing_snapshots 180 天，探针观测 90 天，Cron 心跳 30 天，完成的 Queue receipt 30 天，失败 receipt 180 天，死信 365 天，已结算 analytics outbox 30 天，已发送邮件投递和已结算事件 180 天，search_history 最近 50 组。该段描述的是仓库当前约定的保留窗口；实际生产数据量和清理执行结果需要以数据库/运行记录为准。

数据库备份由 VPS 端 pg_dump 流式加密后上传至私有 R2 桶，使用 AES-256 加密文件和 SHA-256 manifest。文档中描述的恢复演练会使用随机临时数据库进行验证并删除临时库，不覆盖生产 jpgr。恢复密钥不进入仓库、VPS 或 R2。

## 10. 商品身份、价格事实与成本语义

项目不是简单把不同来源的“价格”放在一个列中比较。核心类型和 P1 数据文档明确区分价格的业务含义：

| 价格角色 | 当前含义 |
| --- | --- |
| acquisition_ask | C2C、二手店等当前可购买报价。 |
| new_retail_ask | Amazon、Yahoo! Shopping 等新品零售当前报价。 |
| auction_current_bid | 未结束拍卖的当前出价，不是固定成交价。 |
| unclassified_ask | 尚未可靠判定为新品/二手的当前报价。 |
| source_sold_status_price | 来源页面在已售罄状态下保留的价格；不自动代表成交。 |
| official_list | 来源明确给出的官方定价，例如“定価”。 |
| source_compare_at | 来源页面的划线价/比较价，不自动等于官方定价。 |
| verified_sale | 满足严格来源证据条件的已结束拍卖成交记录。 |

每个价格事实可携带币种、税费状态、运费状态、来源 URL、内容哈希、发生时间和证据。strategy_price_facts_v1 视图提供至少三个时间概念：

- occurred_at：价格或成交实际发生的时间；
- knowledge_at：系统最早知道该事实的时间；
- identity_known_at：系统确认它属于当前商品实体/变体的时间。

这三个时间字段服务于“不能用未来已知信息回测过去”的事实表达。本文不对如何做回测、如何估值或如何使用这些数据提出建议；它只说明当前视图就是以这种时间边界提供给 Databricks 等外部分析环境。

精确商品身份也不是单一标题模糊匹配。系统可以利用 JAN、ISBN、ASIN、型号、来源商品 ID、规范化精确标题、目标指纹、查询变体、详情补全、确定性匹配和 AI 语义判断。product_listing_memberships 的关系类型可表达 exact、probable_exact、variant、bundle、related、irrelevant 或 uncertain。当前更严格的版本规则明确：related 与 uncertain 不应因为“相关”而升级为同款；AI 只能在规定条件下提升具有足够置信与单件/完整性证据的候选。

cost_profiles 保存版本化的成本参数，包括汇率、汇率缓冲、代购/平台费用、日本国内运费、国际运费区间、重量、税费、成本缓冲等。核心包还能基于买入、运费、费用、卖出平台费、卖出运费、退货/损耗准备等字段输出到手成本和收益情景。当前产品边界明确把它视为可审计的确定性/影子计算，而非生产买入建议。

## 11. AI：位置、职责、请求边界与持久化

AI 在当前项目中是“后置、版本化、可失败”的语义清洗组件，不是能自行调度工具的 Agent。Collector 使用 GOOGLE_AI_API_KEY 直接通过 HTTPS 调用 Google AI Studio；项目禁止使用 Cloudflare AI Gateway、Workers AI binding、Unified Billing 或 Cloudflare 托管的 @cf 模型来替代该路径。密钥只应保存在 Collector 的加密 Worker secret，不进入源代码、Wrangler vars、浏览器、日志或数据库行。

当前 listing enrichment 定义使用 Google AI Studio provider 和代码中指定的 Gemini 模型/提示词版本。模型请求要求结构化 JSON，清洗内容包括：

- 搜索目标的语义相关性：relevant、irrelevant 或 uncertain；
- 中文标题翻译和简短摘要；
- 标准化类别、行情大类、商品类型、作品、系列、角色；
- 官方/同人状态；
- 标准化品相、品相说明、瑕疵、缺件、包含物、版本/型号；
- 可供人工核对的短证据片段与置信度。

提示词明确要求模型不要推测或改写价格、库存、首次出现、涨跌或数量等确定性字段，也不要给购物建议或价值判断。模型看到的是经过边界控制的商品输入、查询和相关性上下文；模型输出是衍生解释，不是来源事实本身。

Gemini 任务有独立 Queue，消费并发为 1。数据库中有 gemini_jobs、分块载荷、provider cooldown、请求预约和 token 预约，以执行 RPM/TPM 预算、批处理和 429 延迟重排。对 Google 非 2xx 响应，代码尝试保留经过脱敏和长度限制的传输错误信息及 upstream status，而不是只记录一个笼统失败状态；完整模型请求不应被日志记录。

在 analytics schema 中：

- ai_processing_batches 保存不可变的提供方响应证据，包括 semantic input、provider、model、prompt version、input hash、raw response、解析状态和元数据；
- ai_enrichments 保存关联到 source_listing 的结构化清洗投影、证据、置信度、输入哈希和版本；
- 同一语义输入可有多次提供方响应记录，模型重试和原始响应不是被静默覆盖；
- 对某条来源商品的清洗结果有唯一性边界，但源商品和源观察仍保留；
- 最新清洗视图只是一种读取投影，不会删除历史版本。

自动语义清洗的触发时机是“入库后的独立衍生”。读取来源证据、普通商品库、价格视图或确定性聚合本身不应隐式触发模型调用。市场分析报告表的历史迁移状态仍在数据库基线中，但当前应用运行时被禁止读写；临时市场研究属于外部 Databricks 工作区。

## 12. 认证、授权、密钥与网络安全事实

当前 Web 认证是单管理员认证。登录密码不是明文存储；配置使用 ADMIN_AUTH_SECRET 与 ADMIN_PASSWORD_DIGEST，密码验证以 HMAC-SHA256 摘要和常量时间比较完成。登录成功后生成自包含、带 HMAC 签名的 session token；payload 的 subject 固定为 admin，含过期时间与 nonce。README 说明会话有效期为 7 天，服务端不保存会话状态；退出登录主要清理浏览器 Cookie，若要全局使已签发 session 失效则需要轮换 session signing secret。

当前实现没有：

- 多个登录主体；
- 用户注册、找回密码、邮箱验证或 OAuth；
- 用户表、组织表、团队成员表、角色权限表；
- tenant_id 级别的数据归属、行级隔离或每用户来源/队列/模型配额；

这些均是当前事实陈述，不是本文要求采用何种替代设计。

Web 对变更型 API 额外校验 Origin；登录端点的暴力破解防护在部署说明中交由 Cloudflare WAF 规则承担。Next 响应配置 CSP、X-Frame-Options: DENY、X-Content-Type-Options、Referrer-Policy、Permissions-Policy、HSTS 和私有页 no-store。来源服务请求有时间戳、签名和有限重放保护；Source Runner 有自己的签名验证和内存重放 guard。Vercel 服务的单实例 replay guard 是尽力而为的当前实现，而非跨实例的持久化全局防重放保证。

外部来源和服务调用采用 allowlist 思想。固定用途服务的 schema 会校验来源 ID、查询长度、筛选条件、分页范围、商品 ID 或官方 HTTPS URL 的 host/path；请求不应携带任意 URL、用户名密码、任意端口或凭据片段。敏感文本、Bearer token、API key、长随机串和 URL 会在若干错误处理路径中被压缩/脱敏。

## 13. 部署、发布、备份与运行环境

当前发布与运行分工如下：

| 组件 | 当前部署/运行方式 |
| --- | --- |
| Web | Cloudflare Workers Builds 从 main 构建；apps/web 是 Worker root；Next 构建固定使用 webpack，并保留 NEXT_PRIVATE_MINIMAL_MODE=1。 |
| Collector | 独立 Cloudflare Worker；当前通过 pnpm deploy:collector 等命令手动部署。 |
| PostgreSQL | VPS 上 PostgreSQL 17，Cloudflare Hyperdrive/Workers VPC/Tunnel 访问。 |
| Mercari service | Vercel 东京区域（hnd1）的固定用途服务。 |
| Source Runner | 新加坡 VPS，Node + Playwright + Caddy + systemd。 |
| 异地备份 | 私有 Cloudflare R2 桶保存 VPS PostgreSQL 的加密备份。 |
| 邮件/微信 | Resend REST API 与 Hermes Webhook。 |
| 外部分析 | Databricks 读取确定性证据和视图；不由应用直接生成市场报告。 |

GitHub 在项目约定中是源代码管理，不承担 GitHub Actions 构建/部署或 artifact 中转。Web 的生产 Worker 由 Cloudflare Workers Builds 处理；PostgreSQL schema 变更与 Worker 发布分开，部署命令不会自动修改生产数据库。生产分支是 main，仓库约定采用直接提交和直接推送，不采用默认的 PR 合并门禁。

Source Runner 的 systemd 单元使用低权限用户，Node 监听 loopback，Caddy 对外反代指定路径。单元配置给 Runner 设置了队列深度、Playwright 浏览器路径、业务修复目录、MemoryHigh、MemoryMax、CPUQuota、TasksMax、文件系统保护和只允许必要写入目录等运行参数。该资源配置仅描述当前 Runner 服务的部署文件；不代表整个项目运行在同一台或同一规格的 VPS 上。

## 14. 测试、迁移和历史文档的时间层次

根目录有 Vitest 单元测试与使用 Cloudflare 官方 Worker 测试池的 Worker 集成测试。测试覆盖适配器、认证、监控语义、事件、价格事实、来源分页、来源捕获、队列投递安全、Gemini 调度、商品身份、成本、来源策略和 PostgreSQL 运行 SQL 等领域。Worker 集成测试可使用独立 PostgreSQL 17 容器。仓库约定小范围改动只运行相关测试/类型检查，而不固定运行完整浏览器回归、全部 Worker 测试或生产构建。

数据库基线位于 postgres/schema.sql；postgres/migrations 存放基线之后针对当前统一 PostgreSQL 的增量迁移。supabase/migrations 是 radar_analytics 以前迁移来源的历史目录，不能据此推断 Supabase 仍是当前生产数据库。近期 PostgreSQL 迁移涉及 HTML metadata-only 规则、P1 价格事实、骏河屋官方定价兼容、精确商品身份 v3 和生产冻结校验等。

仓库中还有 P0_STATUS.md、HANDOFF_CURRENT_ISSUES.md、若干 phase/implementation 文档、审计报告和 UI 复盘。这些文件的价值主要是保留当时的验证、问题、决策和历史上下文，但其日期、数据库名称、部署状态或待办可能已被后续代码/迁移替代。特别是早期文档中出现的 D1、Supabase、旧探针窗口或旧 UI 状态，不应被外部模型当成无条件的当前生产事实；当前 schema、Wrangler 配置、应用代码和根 README 是更接近当前实现的材料。

## 15. 术语速览

| 术语 | 在本项目中的含义 |
| --- | --- |
| Web | 面向管理员的 Next.js/OpenNext Cloudflare Worker。 |
| Collector | 后台业务 Worker；负责调度、采集、事件、Queue 和 AI 编排。 |
| Adapter | 将某个来源的 API/HTML/页面数据转换成统一商品结构的代码模块。 |
| Source | 商品来源站点或服务，如 Rakuten、Mercari、Yahoo、骏河屋等。 |
| Watch profile | 一组关注意图的业务档案。 |
| Watch binding | 将一个档案绑定到某个来源及具体查询/单品和调度策略的记录。 |
| Watch run | 某个 binding 的一次具体执行记录。 |
| Listing | 来源商品的统一表示；不等于全局规范商品。 |
| Snapshot / observation | 某一时刻看到的商品状态或载荷。 |
| Source evidence / capture | 请求、响应、哈希、状态、字节数与抽取字段组成的可审计来源证据。 |
| Identity scope | 商品实体范围：单个挂牌、目录商品或报价。 |
| Exact product | 以具体同款/变体为目标的搜索和身份识别模式。 |
| Outbox | 将已完成的运营事实异步交给 analytics/AI 后续处理的持久化桥梁。 |
| DLQ / parking queue | 多次失败消息的死信与最终人工恢复停放位置。 |
| Hyperdrive | Cloudflare Worker 到 PostgreSQL 的连接加速/连接管理绑定。 |
| Gemini job | 一次持久化的 Google AI Studio 语义清洗任务，而非对话式 Agent。 |
| rawMetadata | 来源特有、未必适合直接在 UI 渲染的结构化元数据。 |
| verified_sale | 满足严格拍卖结束、正出价、最终价格、结束时间与稳定来源 ID 证据的成交记录。 |
| knowledge_at | 系统最早知道某个事实的时间，用于避免回测使用未来信息。 |

## 16. 仓库中的主要核对入口

下列文件是本文内容的主要来源，列出它们是为了方便仓库拥有者日后复核，而不是要求外部模型访问它们：

- 根 README.md：项目定位、运行资源、部署、保留窗口、来源边界和运维说明；
- AGENTS.md：仓库交付规则与 AI 推理边界；
- package.json 与 pnpm-workspace.yaml：工作区、Node/pnpm 与根命令；
- apps/web/wrangler.jsonc、apps/web/next.config.ts、apps/web/src/app 与 apps/web/src/lib：Web 运行、缓存、安全、认证与 API；
- apps/collector/wrangler.jsonc、apps/collector/src/index.ts、apps/collector/src/gemini-jobs.ts、apps/collector/src/source-execution.ts：Cron、Queue、采集、路由和 AI 任务；
- apps/mercari-service：东京固定用途服务的签名、schema 和来源端点；
- apps/source-runner：新加坡 VPS Runner 的服务代码、部署 unit、Caddy 配置和 README；
- packages/core、packages/adapters、packages/db、packages/analytics、packages/ai、packages/validation：领域模型、来源适配、数据库与 AI 合约；
- postgres/schema.sql 与 postgres/migrations：统一 PostgreSQL 的当前基线和增量；
- docs/investment-data-p1.md：价格事实、严格成交证据、点时字段和 Databricks 边界。

本文到此为止只提供系统当前背景，不预设外部模型应回答什么问题，也不包含任何方案结论。
