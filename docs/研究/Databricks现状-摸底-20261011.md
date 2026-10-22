# Databricks 现状 · 摸底（2026-10-11）

下面"已经有的 / 缺的"是只读摸底的结果。同一天已经补上缺口 1 和 2，见文末「10-11 已做」。

## 已经有的

- **每日镜像**：VPS 定时器 `jpgr-databricks-sync`，每天 04:30（服务器时间）把 `radar_core` / `radar_analytics` / `jpgr_meta`
  共 89 张表同步到 `workspace` 目录下同名 schema。10-11 这次成功（49/89 张表有变化，71.7 万行校验通过）。
  说明在 VPS `/etc/jpgr-databricks/README.md`。
- **整理层 `workspace.jpgr_ai`**：22 个视图，全部带英文说明。主题是**行情**：当前在售、每日价格分布、降价、
  数据源健康、搜索表现、Yahoo 拍卖去重/落札、Amazon 需求信号、P1 价格事实、三个"商品提醒"候选。
  定义在 VPS `/etc/jpgr-databricks/jpgr_databricks_views.sql`，每次同步后重建。
- **Genie 空间「JPGR 市场情报 Agent」**（`your-genie-room-id`）：接了 9 个视图、6 个示例问题和对应的标准 SQL，
  以及一段中文口径说明（日元、JST、只用 valid 价格、当前可买怎么筛）。配置在 VPS `/etc/jpgr-databricks/jpgr_genie_space.json`，
  用 `/usr/local/sbin/configure-jpgr-genie` 重新应用。
- **两个已发布仪表盘**：「JPGR 市场情报总览」「JPGR P1 价格数据体检」。

## 缺的

1. **历史会被删掉，而且 Databricks 也跟着删。**
   collector 每小时的 `pruneOperationalHistory`（`apps/collector/src/index.ts:2434`）删 90 天前的 `watch_runs`，
   外键级联删掉对应的 `watch_run_listing_observations`（判定记录）和 `source_health_snapshots`。
   另外 `listing_snapshots`、`email_deliveries` 留 180 天。
   同步用的是 `CREATE OR REPLACE TABLE`，生产库删了什么，镜像第二天就跟着没了；Delta 的时间回溯默认只有 7 天左右。
   生产库最早一条 `watch_runs` 是 2026-07-13，**正好 90 天前——从今天起最老的判定记录开始被删。**
2. **判定质量完全没进整理层和 Genie。** 原始表在：`watch_run_listing_observations`（约 11.5 万条，08-22 起，
   带 `decision_status` × `match_relation`）、`digest_item_labels`（165 条人工标注）、`watch_profile_muted_products`（2 条）、
   `email_deliveries`（407 条）、`watch_profiles`（16 个档案）。但没有一个视图解释这些字段，Genie 也没接。
3. **本机 Databricks CLI 登录过期**（`jpgr-local` profile），要用时需重新 `databricks auth login --profile jpgr-local`。
   服务器上的 `jpgr-free` 凭据正常。

## 判定档位分布（全量，截至 10-11 镜像）

| decision_status | match_relation | 条数 |
|---|---|---|
| rejected | irrelevant | 34,770 |
| confirmed | （空） | 26,977 |
| rejected | related | 19,298 |
| rejected | （空） | 17,978 |
| rejected | uncertain | 5,656 |
| rejected | probable_exact | 4,016 |
| rejected | bundle | 2,732 |
| confirmed | probable_exact | 863 |
| uncertain | uncertain / 空 / irrelevant | 1,206 |
| pending | uncertain / 空 | 390 |

值得追的：`rejected × probable_exact` 4,016 条、`confirmed × irrelevant` 225 条，这两格看着自相矛盾，
是做判定体检时第一批要查的。

## 10-11 已做

**止血：只增不删的历史档案 `workspace.jpgr_history`。**
VPS 同步程序 `/usr/local/sbin/jpgr-databricks-sync` 每次镜像成功后，把会被裁剪的 10 张表
（`watch_runs`、`watch_run_listing_observations`、`source_health_snapshots`、`events`、`email_deliveries`、
`hermes_deliveries`、`listing_same_groups`、`listing_snapshots`、`source_probe_observations`、
`watch_run_query_attempts`）按主键合并进去：新行插入、旧行更新、从不删除。
生产库的保留期不用改，生产库照样瘦身，历史留在 Databricks。
10-11 12:06（北京时间）首次归档：判定记录 115,079 条、搜索记录 7,696 条，最早到 07-13，一条没丢。
归档失败时整次同步记 `ARCHIVE_FAILED`、退出码 1，但不拦本地导出清理（避免每天多堆 2G）。
改之前的程序：`/usr/local/sbin/jpgr-databricks-sync.bak-20261011`。

**判定质量层：4 张整理表 + 接进 Genie。** 都读历史档案，带中文列说明：

| 表 | 一行是什么 | 用来回答 |
|---|---|---|
| `jpgr_ai.judgment_listings_v1` | 一个档案 × 一件商品（取最近一次判定） | 多少件、误报比例、哪些值得复查 |
| `jpgr_ai.judgment_observations_v1` | 一次搜索里看到的一件商品 | 判定随时间怎么变 |
| `jpgr_ai.digest_items_v1` | 已发出日报里的一件商品（含疑似分区） | 发出去的东西有多少被标了不想看 |
| `jpgr_ai.profile_daily_pipeline_v1` | 一个档案一天 | 抓取 → 判定 → 日报 哪一段断了 |

（同日稍后拆分：这 4 张表移到单独的 Genie 空间「JPGR 判定体检」`your-genie-room-id`，市场情报空间回到只管行情的 20 张表。）
先是在 Genie 空间「JPGR 市场情报 Agent」加了这 4 张表、一段判定口径说明（"误报"只认 `hide` 标注，
没标过的不算对也不算错，高度疑似被拒只能叫"值得复查"），以及 4 个示例问题和对应的标准 SQL。
顺手把被重复粘贴了三遍的旧说明去了重。

**坑：Genie 空间在网页上被改过，服务器上的配置文件是旧的（9 张表，线上 20 张）。**
直接跑 `configure-jpgr-genie` 会把网页上加的 11 张表冲掉。这次已经用线上版本刷新了配置文件。
以后改 Genie，先拉线上版本比对再改。

### 第一批看到的数字（10-11，样本小，只当线索）

- **赛车初音上新**：165 件标过的日报商品里，76 件标了"不想再看到"（46%）。其中 69 件是系统"确认"后发出去的。
  标注只有这一个档案，其他档案的误报率现在不知道。
- **字面高度疑似同款、却被直接拒掉、也没送 AI 复核**：按件算约 180 件，已逐件抽查，见下节。

### 抽查：180 件"高度疑似同款却被拒"（10-11）

| 类别 | 件数 | 结论 |
|---|---|---|
| 已售出（sold_out） | 145 | 拒得对：买不到。不是判定问题。多数确实是同款（如メダリスト展、冴えカノ A3 プリモアート），是成交价证据 |
| 状态未知（unknown，雅虎商城 / Amazon） | 7 | 按买不到处理。メダリスト展 有 2 件（骏河屋 ¥8,521、hobbyyamamori ¥8,110）其实可能在售，但雅虎商城本来就是实验来源 |
| 在售、9 月 5 日前的旧版比对器打分虚高 | 25 | 拒得对：高木さん 的 DVD / 漫画 / 徽章，赛车初音的其他年份色紙，被旧版字面比对标成"高度疑似"。09-05 之后没再出现 |
| **在售、真同款、被挤掉** | **3** | **真漏了**：メダリスト展 公式アートブック m30058906515 ¥5,000、m55639177310 ¥5,700、m85238784837 ¥6,799 |

**漏的原因（`apps/collector/src/index.ts:958`）**：AI 复核名额每轮 16 个，是从**全部候选**里挑的，已售出的也算；
挑中的已售出候选随后在 975 行被"只留在售"过滤掉，名额白占。メダリスト展 这种绝版书，搜出来一大半是已售出的同名商品：
10-10 那轮 23 件高度疑似里 13 件已售出，10 件在售只轮到 9 件，剩下那件按 608 行 `reviewSelected === false` 直接记成拒绝。
m30058906515 在 09-06～09-24 一直是"确认"，09-25 起天天被挤成"拒绝"。

另：608 行把"没轮到复核"当成拒绝，和 `countProductSearchUnreviewedCandidates` 注释里"未解决候选不作拒绝"、
AGENTS.md 第 4 节"证据不足只能降档"相矛盾。按现在的送达门槛（只发确认）改成 uncertain 不会多发邮件，只影响记录是否诚实。

**10-11 已修（`apps/collector/src/index.ts`）**：
1. 挑 AI 复核名额前先滤掉不在售的候选，名额只给买得到的。
2. 没轮到复核的在售候选记 `uncertain`（理由写差异说明 +"本轮 AI 复核名额已满，没轮到"），不再记 `rejected`。
   日报疑似分区要求 `ai_relevance` 非空，所以不会多发邮件；参考图找货的总开关 `exact_reference_image_v1` 目前关着，
   打开后这些待定件会进图片比对（每轮上限 40 件，分数有缓存）。
验证方法：过几天在 Databricks 里看 `judgment_listings_v1` 中 review_flag = '在售、字面高度疑似同款，却没轮到 AI 复核就被拒' 不再新增，
`decision_reason` 含"名额已满"的 uncertain 行出现得很少（名额不再被已售出的占掉之后，应该极少满）。
