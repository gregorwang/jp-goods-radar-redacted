# 数据字典 · Databricks（JPGR）

> 由 Databricks 里的表 / 字段说明自动生成（2026-10-11）。说明的源文件在 VPS `/etc/jpgr-databricks/jpgr_semantic_comments.json`（整理层和表级说明）和 `jpgr_databricks_views.sql`（判定体检 4 张表）。改说明改那两处，再重新生成本文件；不要只改这里。
> 使用手册（含常用 SQL 和示例结果）：[Databricks-使用手册.html](Databricks-使用手册.html)

## 怎么连

| 东西 | 在哪 |
|---|---|
| 工作区 | https://dbc-your-workspace.cloud.databricks.com （免费版，账号 your-subdomain@gmail.com） |
| 跑 SQL 的计算 | Serverless Starter Warehouse（`d9d23032acdd4d4d`），闲置 10 分钟自动关机，同步前会自动开 |
| Genie：行情 | 「JPGR 市场情报 Agent」 /genie/rooms/your-genie-room-id |
| Genie：判定 | 「JPGR 判定体检」 /genie/rooms/your-genie-room-id |
| 本机命令行 | `databricks --profile jpgr-local …`（过期了跑 `databricks auth login --profile jpgr-local`） |
| 同步程序 | VPS `/usr/local/sbin/jpgr-databricks-sync`，每天 04:30（服务器时间，= 日本 05:30），说明 `/etc/jpgr-databricks/README.md` |

Claude 在本地做分析时，用本机 CLI 跑 SQL：

```bash
databricks --profile jpgr-local api post /api/2.0/sql/statements --json '{"warehouse_id":"d9d23032acdd4d4d","wait_timeout":"50s","statement":"SELECT …"}'
```

也可以直接查生产库（数据更新，但没有历史档案和整理层）：`ssh root@203.0.113.10 "sudo -u postgres psql -X -d jpgr"`。

## 三层结构

| 层 | schema | 是什么 | 什么时候用 |
|---|---|---|---|
| 整理层 | `workspace.jpgr_ai` | 给人和 Genie 用的视图，字段全有中文说明 | **先用这层** |
| 历史档案 | `workspace.jpgr_history` | 会被生产库按保留期删掉的 10 张表，只增不删 | 要看 90 天 / 180 天以前的判定、日报 |
| 原始镜像 | `workspace.radar_core` / `radar_analytics` / `jpgr_meta` | 生产库每晚整表覆盖的副本，和生产库一模一样 | 整理层没有的字段 |


## 最容易踩的口径坑

- **时间是 UTC**，日本时间要 `from_utc_timestamp(x, 'Asia/Tokyo')`。带 `_jst` 后缀的列已经转好了。原始表里的时间多数是文本，先 `try_cast(x AS TIMESTAMP)`。
- **拍卖当前出价不是价格**：`price_basis = 'auction_current_bid'` 的价格还会涨，不能当成交价也不能当可买价。算价格时通常要排除。
- **已售出 ≠ 成交**：`availability = 'sold_out'` 只是平台显示状态。只有雅虎拍卖的公开落札（`verified_sale`）接近成交价，也不证明付款。
- **亚马逊没有成交数据**：成交列为 NULL 表示看不到，不是 0。
- **观察次数 ≠ 商品件数**：`listing_observations`、`judgment_observations_v1`、`daily_market_prices` 里同一件商品每被搜到一次算一行。数件数用 `count(DISTINCT source_id, source_item_id)` 或按件的表（`judgment_listings_v1`、`current_listings`）。
- **离开搜索结果 ≠ 卖掉**：`left_count`、`active_visible=false` 只说明这次没在前几页看到。
- **误报只认你标注**：`label_verdict = 'hide'` 才是误报的证据；没标过的不算对也不算错，比例的分母只能用标过的件数。
- **两套商品编号**：`radar_core.listings.id`（运营库）和 `radar_analytics.source_listings.id`（分析库）不是同一套。跨库对商品用 `source_id + source_item_id`。
- **判定档位**：`decision_status` confirmed=确认 / uncertain=待定（证据不足） / rejected=拒绝 / pending=没判完；`ai_relevance` 为空 = 没送 AI，不是 AI 判无关。2026-10-11 起，没轮到 AI 复核的在售候选记 uncertain（之前记 rejected）。

## 整理层 `workspace.jpgr_ai`

### alert_exact_product_reappearances_v1

商品提醒候选①：单品档案盯的那件、或精确同款雷达的严格同款，重新变得能买。已排除关键词相关和进行中的拍卖。

| 字段 | 类型 | 说明 |
|---|---|---|
| `alert_evidence_id` | string | 提醒证据 ID（来源事件或价格事实的编号） |
| `dedupe_key` | string | 去重键：同一个键只算一条提醒 |
| `cooldown_key` | string | 冷却键：同一个键在冷却期内不重复提醒 |
| `signal_kind` | string | 提醒种类：严格同款新增报价 / 关注商品恢复可买 |
| `watch_profile_id` | string | 档案 ID（一个档案 = 你建的一个雷达） |
| `watch_profile_name` | string | 档案名 |
| `dossier_kind` | string | 档案类型：keyword=关键词日报，exact_product=精确同款雷达，item=单品盯价 |
| `acceptance_reason` | string | 为什么算档案的匹配：direct_item=单品档案盯的就是这件，deterministic_exact=标题字面确定同款，semantic_exact=AI 语义确认同款，keyword_relevant=关键词相关，legacy=旧版规则遗留，anchor_known=已知锚点商品 |
| `product_variant_id` | string | 同款商品（具体到版本）的内部编号 |
| `canonical_name` | string | 商品标准名 |
| `variant_name` | string | 版本名 |
| `monitor_listing_id` | string | 运营库里这件商品的编号（radar_core.listings.id），和 listing_id 不是一套编号 |
| `listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `current_price_jpy` | int | 当前价格（日元）。price_basis=auction_current_bid 时是拍卖当前出价，不是成交价 |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `completeness` | string | 事件发生时这条商品信息完整到什么程度（事件原文字段） |
| `previous_availability` | string | 变化前的状态（同 availability 取值） |
| `event_availability` | string | 事件发生时的状态（同 availability 取值） |
| `occurred_at` | timestamp | 事件本身发生的时间（UTC） |
| `signal_at` | timestamp | 系统发现这条信号的时间（UTC） |
| `alert_cooldown_until` | timestamp | 冷却截止时间（UTC），= signal_at + 6 小时 |
| `dedupe_window_minutes` | bigint | 规则设定的去重窗口（分钟） |
| `cooldown_minutes` | bigint | 规则设定的冷却时长（分钟） |
| `notification_eligibility` | string | 送达方式：instant=立即发，digest=进日报，quiet_hours=夜间静默时段先攒着、白天再发，cooldown=冷却中不发 |
| `evidence_boundary` | string | 证据边界：这条结论能证明什么、不能证明什么 |

### alert_public_awarded_sales_v1

商品提醒候选②：被盯的同款在雅虎拍卖出现公开落札（拍卖结束且有出价）。不证明已付款或最终成交。

| 字段 | 类型 | 说明 |
|---|---|---|
| `alert_evidence_id` | string | 提醒证据 ID（来源事件或价格事实的编号） |
| `dedupe_key` | string | 去重键：同一个键只算一条提醒 |
| `cooldown_key` | string | 冷却键：同一个键在冷却期内不重复提醒 |
| `signal_kind` | string | 提醒种类：固定为“新增公开落札证据” |
| `product_variant_id` | string | 同款商品（具体到版本）的内部编号 |
| `watch_profile_ids` | array<string> | 盯着这个同款的档案 ID 列表 |
| `watch_profile_names` | string | 盯着这个同款的档案名（多个用顿号分隔） |
| `canonical_product_id` | string | 商品概念的内部编号，一个商品概念下可以有多个版本 |
| `canonical_name` | string | 商品标准名 |
| `variant_name` | string | 版本名 |
| `model` | string | 型号 |
| `jan` | string | JAN 条码 |
| `source_listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `source_item_id` | string | 平台上的商品编号 |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `public_awarded_price_jpy` | int | 公开落札价（日元）：拍卖结束时的最高出价。不证明已付款或最终成交 |
| `price_basis` | string | 固定为 listing_price |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `bid_count` | bigint | 出价次数 |
| `source_ended_at` | timestamp | 拍卖结束时间（UTC） |
| `knowledge_at` | timestamp | 系统得知这条落札的时间（UTC） |
| `identity_known_at` | timestamp | 系统确认它是这个同款的时间（UTC） |
| `signal_at` | timestamp | 提醒成立时间 = knowledge_at 和 identity_known_at 里较晚的那个（UTC） |
| `alert_cooldown_until` | timestamp | 冷却截止时间（UTC），= signal_at + 6 小时 |
| `evidence_kind` | string | 证据类型：search_observation=搜索时看到，operational_snapshot=运营库的商品快照，verified_sale_record=成交记录 |
| `evidence_id` | string | 证据编号，可回查原始记录 |
| `evidence_url` | string | 证据链接 |
| `evidence_boundary` | string | 证据边界代码，固定为 source_closed_auction_with_positive_bid（拍卖已结束且有正出价） |
| `evidence_boundary_note` | string | 证据边界的中文说明 |

### alert_target_purchase_opportunities_v1

商品提醒候选③：现在能买的固定价商品达到你设的目标挂牌价或目标到手成本。已排除进行中的拍卖。

| 字段 | 类型 | 说明 |
|---|---|---|
| `alert_evidence_id` | string | 提醒证据 ID（来源事件或价格事实的编号） |
| `dedupe_key` | string | 去重键：同一个键只算一条提醒 |
| `cooldown_key` | string | 冷却键：同一个键在冷却期内不重复提醒 |
| `signal_kind` | string | 提醒种类：目标挂牌价（挂牌价低于目标）/ 保守目标到手成本（含代购费和运费的到手成本低于目标） |
| `watch_profile_id` | string | 档案 ID（一个档案 = 你建的一个雷达） |
| `watch_profile_name` | string | 档案名 |
| `product_variant_id` | string | 同款商品（具体到版本）的内部编号 |
| `canonical_name` | string | 商品标准名 |
| `variant_name` | string | 版本名 |
| `monitor_listing_id` | string | 运营库里这件商品的编号（radar_core.listings.id），和 listing_id 不是一套编号 |
| `listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `current_price_jpy` | int | 当前价格（日元）。price_basis=auction_current_bid 时是拍卖当前出价，不是成交价 |
| `target_listing_price_jpy` | bigint | 你设定的目标挂牌价（日元） |
| `conservative_landed_cost_max_jpy` | bigint | 保守估算的到手成本上限（日元，含代购手续费、国内外运费，按偏贵的一头算） |
| `target_landed_cost_jpy` | bigint | 你设定的目标到手成本（日元） |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `completeness` | string | 事件发生时这条商品信息完整到什么程度（事件原文字段） |
| `availability` | string | 状态：available=在售，sold_out=已售出 / 已结束，preorder=预约中，backorder=缺货可订，unknown=不明 |
| `occurred_at` | timestamp | 事件本身发生的时间（UTC） |
| `signal_at` | timestamp | 系统发现这条信号的时间（UTC） |
| `alert_cooldown_until` | timestamp | 冷却截止时间（UTC），= signal_at + 3 小时 |
| `dedupe_window_minutes` | bigint | 规则设定的去重窗口（分钟） |
| `cooldown_minutes` | bigint | 规则设定的冷却时长（分钟） |
| `notification_eligibility` | string | 送达方式：instant=立即发，digest=进日报，quiet_hours=夜间静默时段先攒着、白天再发，cooldown=冷却中不发 |
| `evidence_boundary` | string | 证据边界：这条结论能证明什么、不能证明什么 |

### amazon_market_signal_facts_v1

亚马逊每个商品（ASIN）一行。亚马逊不公开成交，成交列恒为 NULL；只能用报价、库存和“过去一个月购买”标记间接看需求。

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `asin` | string | 亚马逊商品编号 ASIN |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `first_seen_at` | timestamp | 系统第一次看到它的时间（UTC） |
| `last_seen_at` | timestamp | 系统最近一次看到它的时间（UTC） |
| `transaction_observability` | string | 成交量能不能观察到：not_observable=平台不公开成交，public_awarded_signal=只有公开落札信号 |
| `observed_transaction_count` | bigint | 成交件数。亚马逊不公开，恒为 NULL：表示看不到，不是 0 |
| `observed_transaction_price_jpy` | int | 成交价。亚马逊不公开，恒为 NULL：表示看不到，不是 0 |
| `demand_signal_semantics` | string | 需求信号的含义：current_offer_and_stock_proxy=只能用当前报价和库存间接反映需求 |
| `demand_proxy_availability` | string | 当前状态（同 availability 取值），用作需求代理 |
| `demand_proxy_stock_signal` | string | 库存信号：offer_visible=有报价可买，preorder_visible=可预约，currently_unavailable=暂时买不到，unknown=不明 |
| `demand_proxy_offer_price_jpy` | int | 当前报价（日元） |
| `demand_proxy_reference_price_jpy` | int | 亚马逊显示的参考价（日元） |
| `demand_proxy_past_month_purchase_badge` | string | 亚马逊页面上“过去一个月 X 件以上购买”的原文 |
| `demand_proxy_past_month_purchase_lower_bound` | bigint | 上面那句话里的 X：过去一个月购买量的下限，不是精确销量 |
| `demand_proxy_observation_count` | bigint | 这件商品被系统搜到的次数 |
| `first_observed_at` | timestamp | 第一次被搜到的时间（UTC） |
| `last_observed_at` | timestamp | 最近一次被搜到的时间（UTC） |

### amazon_market_signal_summary_v1

亚马逊汇总一行。成交相关列为 NULL 表示看不到，绝不是 0。

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_id` | string | 固定为 amazon_jp |
| `unique_catalog_listing_count` | bigint | 系统见过的亚马逊商品总数（按 ASIN 去重） |
| `current_offer_visible_count` | bigint | 现在有报价可买的件数 |
| `currently_unavailable_count` | bigint | 现在买不到的件数 |
| `unknown_offer_state_count` | bigint | 状态不明的件数 |
| `demand_proxy_observation_count` | bigint | 所有亚马逊商品被搜到的总次数 |
| `past_month_purchase_badge_listing_count` | bigint | 带“过去一个月 X 件以上购买”标记的商品数 |
| `past_month_purchase_public_lower_bound_sum` | bigint | 这些标记里 X 的合计，只是下限之和，不是销量 |
| `transaction_observability` | string | 成交量能不能观察到：not_observable=平台不公开成交，public_awarded_signal=只有公开落札信号 |
| `observed_transaction_count` | bigint | 成交件数，恒为 NULL：看不到，不是 0 |
| `observed_transaction_value_jpy` | decimal(38,2) | 成交金额，恒为 NULL：看不到，不是 0 |

### current_listings

所有平台的商品，每件一行，带当前价格和状态。问“现在能买的有多少”用 is_currently_buyable。

| 字段 | 类型 | 说明 |
|---|---|---|
| `listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `source_item_id` | string | 平台上的商品编号 |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `image_url` | string | 商品主图链接 |
| `seller_name` | string | 卖家名 |
| `shop_name` | string | 店铺名（店铺型平台才有） |
| `current_price_jpy` | int | 当前价格（日元）。price_basis=auction_current_bid 时是拍卖当前出价，不是成交价 |
| `original_price_jpy` | int | 平台显示的原价 / 划线价（日元），没有则为空 |
| `currency` | string | 币种，目前全部是 JPY |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `price_status` | string | 价格是否可用：valid=有效，missing=没抓到价格，invalid=价格异常。只有 valid 能参与价格计算 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `availability` | string | 状态：available=在售，sold_out=已售出 / 已结束，preorder=预约中，backorder=缺货可订，unknown=不明 |
| `product_key` | string | 系统归并同款用的身份键（JAN / 型号，或标准化后的标题） |
| `product_match_method` | string | 身份键的来历：identifier=JAN / 型号等硬标识，exact_title=标准化后标题完全一致，listing_identity=只代表这一件商品本身 |
| `first_seen_at` | timestamp | 系统第一次看到它的时间（UTC） |
| `last_seen_at` | timestamp | 系统最近一次看到它的时间（UTC） |
| `last_changed_at` | timestamp | 价格或状态最近一次变化的时间（UTC） |
| `last_seen_date_jst` | date | 最近一次看到它的日期（日本时间） |
| `is_currently_buyable` | boolean | 现在能不能买：在售 + 价格有效 + 有价格。问“当前可买”只看这一列 |

### daily_market_prices

每个平台每天一行的价格分布（日本时间分日）。按观察次数算，不是按商品件数。

| 字段 | 类型 | 说明 |
|---|---|---|
| `observation_date_jst` | date | 日期（日本时间） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `observation_count` | bigint | 当天的价格观察次数。同一件商品一天被搜到几次就算几次，不是商品件数 |
| `available_observation_count` | bigint | 其中在售状态的观察次数 |
| `min_price_jpy` | int | 当天最低价（日元，只算有效价格，含拍卖当前出价） |
| `median_price_jpy` | bigint | 当天价格中位数（日元，近似值） |
| `average_price_jpy` | decimal(18,2) | 当天平均价（日元） |
| `max_price_jpy` | int | 当天最高价（日元） |

### data_freshness

几个主要数据集的行数和最新时间，用来看数据新不新。

| 字段 | 类型 | 说明 |
|---|---|---|
| `dataset_name` | string | 数据集名：source_listings=商品，listing_observations=价格观察，search_runs=搜索批次，source_health_snapshots=平台健康，ai_enrichments=AI 补充信息 |
| `record_count` | bigint | 行数 |
| `newest_record_at` | timestamp | 最新一条记录的时间（UTC） |

### digest_items_v1

已发出的日报里的每件商品一行。看"发出去的东西有多少被标了不想看"用这张。只含 status=sent 的日报。

| 字段 | 类型 | 说明 |
|---|---|---|
| `event_id` | string | 这封日报的事件 ID |
| `digest_kind` | string | 日报种类：keyword_scan_summary=关键词日报，exact_product_new_listing=精确同款新上架，weekly_exact_report=精确同款周报，keyword_new_listing=旧版关键词即时通知 |
| `digest_day` | date | 日报对应的日期（日本时间） |
| `sent_at` | timestamp | 发出时间（UTC） |
| `profile_id` | string | 档案 ID |
| `profile_name` | string | 档案名 |
| `section` | string | 分区：new=新上架，recovered=恢复，baseline=基线，suspect=疑似待判断 |
| `source_id` | string | 平台 ID |
| `source_item_id` | string | 平台商品号（旧日报和疑似分区没记，靠链接反查，查不到为空） |
| `title` | string | 日报里显示的标题 |
| `url` | string | 商品链接 |
| `price_jpy` | bigint | 日报里显示的价格（日元） |
| `suspect_reason` | string | 疑似分区里写给用户的差异说明 |
| `label_verdict` | string | 你标注：hide / keep / 空 |

### executive_summary

一行总览：商品数、能买的件数、平台健康、最近一次同步。

| 字段 | 类型 | 说明 |
|---|---|---|
| `generated_at` | timestamp | 这一行是查询时现算的，这是计算时刻 |
| `listing_count` | bigint | 系统见过的商品总数 |
| `available_listing_count` | bigint | 现在能买的商品数 |
| `source_count` | bigint | 有数据的平台数 |
| `healthy_source_count` | bigint | 最近一次状态为 healthy 的平台数 |
| `unhealthy_source_count` | bigint | 最近一次状态不健康、请求失败或解析失败的平台数 |
| `latest_observation_at` | timestamp | 最新一次价格观察时间（UTC） |
| `latest_sync_at` | timestamp | 最近一次成功同步到 Databricks 的时间（UTC） |

### judgment_listings_v1

判定按件汇总：每个档案 × 每件商品一行，结论取最近一次。数"多少件""误报率""漏报"用这张。

| 字段 | 类型 | 说明 |
|---|---|---|
| `profile_id` | string | 档案 ID |
| `profile_name` | string | 档案名 |
| `dossier_kind` | string | 档案类型：keyword / exact_product / item |
| `source_id` | string | 平台 ID |
| `source_item_id` | string | 平台上的商品号 |
| `title` | string | 最近一次看到时的标题 |
| `url` | string | 商品链接 |
| `price_jpy` | bigint | 最近一次看到时的价格（日元） |
| `first_seen_at` | timestamp | 第一次被搜到（UTC） |
| `last_seen_at` | timestamp | 最近一次被搜到（UTC） |
| `times_seen` | bigint | 被搜到的次数 |
| `decision_status` | string | 最近一次的系统结论：confirmed / uncertain / rejected / pending |
| `match_relation` | string | 最近一次的字面关系（精确同款雷达） |
| `ai_relevance` | string | 最近一次的 AI 表态，空=没送 AI |
| `decision_reason` | string | 最近一次的判定理由 |
| `review_flag` | string | 最近一次的矛盾标记，空=没有 |
| `ever_confirmed` | boolean | 是否曾经被确认过（结论可能前后变） |
| `decision_changed` | boolean | 多次判定里结论是否变过 |
| `sent_in_digest` | boolean | 是否出现在已发出的日报里 |
| `first_digest_day` | date | 第一次出现在日报的日期 |
| `digest_section` | string | 日报里的分区：new=新上架，recovered=恢复，baseline=基线，suspect=疑似待判断 |
| `label_verdict` | string | 你标注：hide=不想再看到，keep=还想看，空=没标过 |

### judgment_observations_v1

判定明细：每次搜索看到的每件候选商品一行（同一件商品会被多次看到）。数件数请用 judgment_listings_v1。数据从 2026-08-22 起，只增不删。

| 字段 | 类型 | 说明 |
|---|---|---|
| `observed_at` | timestamp | 这次看到这件商品的时间（UTC） |
| `observed_date_jst` | date | 看到的日期，日本时间 |
| `watch_run_id` | string | 哪一次搜索 |
| `profile_id` | string | 档案 ID |
| `profile_name` | string | 档案名（用户给这个雷达起的名字） |
| `dossier_kind` | string | 档案类型：keyword=关键词日报，exact_product=精确同款雷达，item=单品盯价 |
| `profile_enabled` | boolean | 档案当前是否启用 |
| `suspect_notice_policy` | string | 送达门槛：confirmed_only=只发确认同款 |
| `search_query` | string | 这次搜索用的词 |
| `source_id` | string | 平台 ID，如 mercari_jp、yahoo_auctions_jp |
| `source_item_id` | string | 平台上的商品号 |
| `title` | string | 商品标题 |
| `url` | string | 商品链接 |
| `price_jpy` | bigint | 当时价格（日元） |
| `availability` | string | 当时是否在售 |
| `decision_status` | string | 系统结论：confirmed=确认，uncertain=待定（证据不足），rejected=拒绝，pending=还没判完 |
| `match_relation` | string | 字面比对关系（只有精确同款雷达有）：probable_exact=高度疑似同款，related=相关但不是，variant=变体，bundle=套装，uncertain=说不清，irrelevant=无关；关键词档案为空 |
| `ai_relevance` | string | AI 表态：relevant=相关，irrelevant=无关，uncertain=没把握；空=没送 AI |
| `ai_confidence` | string | AI 自评把握 |
| `ai_consulted` | boolean | 这条有没有送过 AI 复核 |
| `decision_reason` | string | 系统写的判定理由（含 AI 的话） |
| `review_flag` | string | 值得人工复查的矛盾；空=没有矛盾。已售出 / 状态未知的商品被拒是因为买不到，不算矛盾 |
| `label_verdict` | string | 你在日报标注页的结论：hide=不想再看到，keep=还想看；空=没标过 |
| `still_in_production` | boolean | false=生产库已按保留期删掉这条，只剩 Databricks 历史 |

### latest_source_health

每个平台最近一次健康检查的结果，每平台一行。问“现在哪个平台坏了”用这张，别用历史记录。

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `state` | string | 平台当前状态：healthy=正常，empty=请求成功但没有结果，其他值表示异常 |
| `observed_at` | timestamp | 这次健康检查的时间（UTC），每个平台只保留最新一次 |
| `request_succeeded` | boolean | 请求是否成功 |
| `parse_succeeded` | boolean | 页面 / 接口是否解析成功 |
| `coverage` | string | 覆盖口径：rolling_window=按最新排序只看前几页（滚动窗口，不是全量），best_effort=尽力而为（受平台限制可能不全），complete=全量，unknown=不明 |
| `raw_result_count` | int | 平台返回的原始结果数 |
| `normalized_result_count` | int | 整理后可用的结果数 |
| `page_depth` | int | 翻了几页 |
| `http_status` | int | HTTP 状态码 |
| `captcha_detected` | boolean | 是否遇到验证码 |
| `login_required` | boolean | 是否要求登录 |
| `blocked_detected` | boolean | 是否判定被拦截 |
| `abnormal_empty` | boolean | 结果为空且判定为异常（比如被拦但伪装成没结果） |
| `freshness_sla_minutes` | int | 这个平台多久没新数据算过期（分钟） |
| `error_code` | string | 错误代码，正常时为空 |
| `error_message` | string | 错误说明，正常时为空 |

### market_source_transaction_semantics_v1

各平台能不能看到成交：防止把需求代理说成销量。

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `transaction_observability` | string | 成交量能不能观察到：not_observable=平台不公开成交，public_awarded_signal=只有公开落札信号 |
| `primary_demand_signal` | string | 这个平台主要能看到的需求信号 |
| `supports_public_awarded_signal` | boolean | 是否有公开落札信号（只有雅虎拍卖有） |
| `sold_status_is_transaction` | boolean | “已售出”状态能不能算成交：都是 false |
| `semantic_note` | string | 中文说明 |

### p1_price_fact_readiness_by_role

价格研究用：价格事实按价格角色分组的数量、身份覆盖和偷看未来的风险。

| 字段 | 类型 | 说明 |
|---|---|---|
| `fact_semantics_version` | string | 价格事实口径版本 |
| `price_role` | string | 价格角色（含义见 strategy_price_facts.price_role） |
| `fact_count` | bigint | 价格事实条数 |
| `source_count` | bigint | 涉及平台数 |
| `identity_linked_fact_count` | bigint | 已关联到同款商品的条数 |
| `linked_variant_count` | bigint | 关联到的同款商品数 |
| `point_in_time_identity_fact_count` | bigint | 同款身份在价格发生之前就已知的条数（回测可用，没有事后诸葛亮） |
| `hindsight_identity_risk_fact_count` | bigint | 同款身份是事后才确认的条数（回测有偷看未来的风险） |
| `first_occurred_at` | timestamp | 最早一条的发生时间（UTC） |
| `latest_occurred_at` | timestamp | 最晚一条的发生时间（UTC） |
| `latest_knowledge_at` | timestamp | 最晚一条的得知时间（UTC） |

### p1_price_fact_readiness_summary

价格研究用：价格事实是否够用的一行体检。平台显示已售不算确认成交。

| 字段 | 类型 | 说明 |
|---|---|---|
| `generated_at` | timestamp | 这一行是查询时现算的，这是计算时刻 |
| `fact_semantics_version` | string | 价格事实口径版本 |
| `total_fact_count` | bigint | 价格事实总条数 |
| `source_count` | bigint | 涉及平台数 |
| `linked_variant_count` | bigint | 关联到的同款商品数 |
| `point_in_time_identity_fact_count` | bigint | 同款身份事前已知的条数（回测可用） |
| `point_in_time_linked_variant_count` | bigint | 有事前已知身份的同款商品数 |
| `first_occurred_at` | timestamp | 最早发生时间（UTC） |
| `latest_occurred_at` | timestamp | 最晚发生时间（UTC） |
| `observed_calendar_days` | int | 发生时间跨了多少天 |
| `first_knowledge_at` | timestamp | 最早得知时间（UTC） |
| `latest_knowledge_at` | timestamp | 最晚得知时间（UTC） |
| `knowledge_calendar_days` | int | 得知时间跨了多少天 |
| `acquisition_ask_count` | bigint | 二手收货挂牌价条数 |
| `new_retail_ask_count` | bigint | 新品零售挂牌价条数 |
| `official_list_count` | bigint | 官方定价条数 |
| `point_in_time_official_list_count` | bigint | 官方定价中身份事前已知的条数 |
| `source_compare_at_count` | bigint | 平台划线参考价条数 |
| `sold_status_signal_count` | bigint | 平台显示已售时的价格条数（只是状态信号，不是确认成交） |
| `verified_sale_count` | bigint | 有证据的成交条数 |
| `point_in_time_verified_sale_count` | bigint | 有证据的成交中身份事前已知的条数 |
| `reference_price_fact_count` | bigint | 参考价（官方定价 + 划线价）条数 |
| `event_after_knowledge_count` | bigint | 发生时间晚于得知时间的异常条数，应为 0 |
| `hindsight_identity_risk_fact_count` | bigint | 身份事后才确认的条数 |
| `invalid_amount_count` | bigint | 金额缺失或不大于 0 的异常条数，应为 0 |
| `non_jpy_fact_count` | bigint | 币种不是日元的条数，应为 0 |
| `missing_evidence_id_count` | bigint | 缺证据编号的条数，应为 0 |
| `duplicate_price_fact_id_count` | bigint | 价格事实 ID 重复的条数，应为 0 |

### price_changes

商品价格变化记录：每次看到价格和上次不同就一行。

| 字段 | 类型 | 说明 |
|---|---|---|
| `listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `observed_at` | timestamp | 看到新价格的时间（UTC） |
| `availability` | string | 看到新价格时的状态（同 availability 取值） |
| `previous_price_jpy` | int | 上一次看到的价格（日元） |
| `new_price_jpy` | int | 这次看到的价格（日元） |
| `price_change_jpy` | int | 涨跌额（日元），负数=降价 |
| `price_change_percent` | decimal(12,2) | 涨跌幅（%），负数=降价。拍卖当前出价的上涨也会算进来 |

### product_market_overview

每个被确认的同款商品一行：有多少件、现在能买的价格区间、在哪些平台。

| 字段 | 类型 | 说明 |
|---|---|---|
| `canonical_product_id` | string | 商品概念的内部编号，一个商品概念下可以有多个版本 |
| `canonical_name` | string | 商品标准名 |
| `work_title` | string | 作品名 |
| `product_type` | string | 品类 |
| `manufacturer` | string | 厂商 |
| `product_variant_id` | string | 同款商品（具体到版本）的内部编号 |
| `variant_name` | string | 版本名 |
| `model` | string | 型号 |
| `jan` | string | JAN 条码 |
| `matched_listing_count` | bigint | 确认是这个同款、且价格有效的商品数（含已售出） |
| `available_listing_count` | bigint | 其中现在能买的件数 |
| `min_available_price_jpy` | int | 现在能买的最低价（日元） |
| `median_available_price_jpy` | bigint | 现在能买的价格中位数（日元，近似值） |
| `max_available_price_jpy` | int | 现在能买的最高价（日元） |
| `source_ids` | string | 有这个同款的平台（逗号分隔，取值见 source_id） |
| `latest_listing_seen_at` | timestamp | 最近一次看到其中任一件的时间（UTC） |

### profile_daily_pipeline_v1

每个档案每天一行的流水线：搜索 → 判定 → 日报。抓取断了、判定全拒、日报空发都在这里一眼看出。

| 字段 | 类型 | 说明 |
|---|---|---|
| `day_jst` | date | 日期（日本时间） |
| `profile_id` | string | 档案 ID |
| `profile_name` | string | 档案名 |
| `dossier_kind` | string | 档案类型 |
| `profile_enabled` | boolean | 档案当前是否启用 |
| `runs_total` | bigint | 当天搜索次数 |
| `runs_success` | bigint | 成功的搜索次数 |
| `runs_failed` | bigint | 失败 / 被拦 / 限流的搜索次数 |
| `candidates` | bigint | 当天搜到的不同商品件数 |
| `confirmed` | bigint | 其中被确认的件数 |
| `uncertain` | bigint | 其中待定的件数 |
| `rejected` | bigint | 其中被拒的件数 |
| `ai_consulted` | bigint | 其中送过 AI 的件数 |
| `digests_sent` | bigint | 当天发出的日报封数 |
| `digest_items` | bigint | 日报里的商品件数（含疑似分区） |
| `digest_hide_labels` | bigint | 这些商品里被你标了不想看的件数 |

### search_performance

每次搜索 × 每个平台一行：结果数、新增、耗时、走的线路。

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | 搜索批次 ID |
| `query` | string | 搜索词 |
| `origin` | string | 这次搜索从哪来：watch_keyword=关键词档案定时搜，watch_item=单品 / 同款档案定时搜，manual_search=后台手动搜 |
| `run_status` | string | 这次搜索整体结果：success=成功，empty=没结果，partial=部分平台成功，failed=失败 |
| `searched_at` | timestamp | 搜索时间（UTC） |
| `subscription_name` | string | 这次搜索所属的订阅 / 档案名 |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `source_status` | string | 这个平台这次的结果：success=成功，empty=没结果，failed=失败，cooldown=平台冷却中没搜 |
| `coverage` | string | 覆盖口径：rolling_window=按最新排序只看前几页（滚动窗口，不是全量），best_effort=尽力而为（受平台限制可能不全），complete=全量，unknown=不明 |
| `result_count` | int | 这个平台返回的结果数 |
| `new_count` | int | 本次新出现的商品数 |
| `left_count` | int | 上次在、这次不在结果窗口里的商品数。不等于卖掉了 |
| `available_count` | int | 结果里在售的件数 |
| `min_price_jpy` | int | 结果里最低价（日元） |
| `max_price_jpy` | int | 结果里最高价（日元） |
| `average_price_jpy` | decimal(12,2) | 结果里平均价（日元） |
| `duration_ms` | int | 耗时（毫秒） |
| `request_route` | string | 请求走的线路：direct=直连，mercari_service=东京适配服务 / VPS 主路，vercel_service=Vercel 服务，managed_api=付费托管接口，browser_run=无头浏览器，source_runner=VPS 备路救回，空=未记录 |
| `parser_version` | string | 解析器版本 |

### strategy_price_facts

价格研究用的价格事实，每条价格一行。不同 price_role 不能混算；回测只能用 knowledge_at 之前的数据。

| 字段 | 类型 | 说明 |
|---|---|---|
| `fact_semantics_version` | string | 价格事实口径版本 |
| `price_fact_id` | string | 价格事实 ID |
| `price_role` | string | 价格角色，不同角色不能混在一起算：acquisition_ask=二手挂牌价，new_retail_ask=新品零售挂牌价，auction_current_bid=拍卖当前出价，source_sold_status_price=平台显示已售时的价格（只是状态信号，不是确认成交），verified_sale=有证据的成交（如雅虎拍卖公开落札），source_compare_at=平台划线参考价，official_list=官方定价，unclassified_ask=口径不明的挂牌价 |
| `product_variant_id` | string | 同款商品（具体到版本）的内部编号 |
| `identity_known_at` | timestamp | 系统确认这件是该同款的时间（UTC）；晚于 knowledge_at 说明身份是事后才知道的 |
| `source_listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `source_id` | string | 平台 ID：mercari_jp=煤炉，yahoo_auctions_jp=雅虎拍卖，yahoo_fleamarket_jp=雅虎闲置（PayPayフリマ），surugaya=骏河屋，amazon_jp=日本亚马逊，rakuten_ichiba=乐天市场，rakuten_books=乐天图书，yahoo_shopping=雅虎商城，amiami=AmiAmi，animate=Animate，cospa=COSPA，charaon=CharaON，ebay=eBay |
| `source_item_id` | string | 平台上的商品编号 |
| `product_key` | string | 系统归并同款用的身份键（JAN / 型号，或标准化后的标题） |
| `product_match_method` | string | 身份键的来历：identifier=JAN / 型号等硬标识，exact_title=标准化后标题完全一致，listing_identity=只代表这一件商品本身 |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |
| `amount_jpy` | int | 金额（日元） |
| `currency` | string | 币种，目前全部是 JPY |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `availability` | string | 状态：available=在售，sold_out=已售出 / 已结束，preorder=预约中，backorder=缺货可订，unknown=不明 |
| `tax_status` | string | 是否含税：included=含税，excluded=不含税，unknown=不明 |
| `shipping_status` | string | 运费：included=含运费，separate=另付，free=包邮，unknown=不明 |
| `occurred_at` | timestamp | 价格发生 / 被观察到的时间（UTC） |
| `knowledge_at` | timestamp | 系统得知这条价格的时间（UTC）。回测时只能用这个时间之前的信息 |
| `evidence_kind` | string | 证据类型：search_observation=搜索时看到，operational_snapshot=运营库的商品快照，verified_sale_record=成交记录 |
| `evidence_id` | string | 证据编号，可回查原始记录 |
| `evidence_url` | string | 证据链接 |
| `evidence` | string | 证据原文（JSON） |

### sync_runs

生产库同步到 Databricks 的每次运行记录。成功的筛 status='SUCCEEDED'。

| 字段 | 类型 | 说明 |
|---|---|---|
| `snapshot_id` | string | 同步批次 ID（导出时刻，UTC） |
| `source_exported_at` | timestamp | 从生产库导出的时间（UTC） |
| `completed_at` | timestamp | 同步结束时间（UTC） |
| `status` | string | 结果：SUCCEEDED=成功，FAILED=失败，ARCHIVE_FAILED=镜像成功但历史归档失败，DRY_RUN=演练 |
| `source_table_count` | int | 导出的表数 |
| `source_row_count` | bigint | 导出的总行数 |
| `changed_table_count` | int | 有变化、重新上传的表数 |
| `uploaded_bytes` | bigint | 上传字节数 |
| `duration_seconds` | double | 耗时（秒） |
| `validation_failure_count` | int | 行数核对不一致的表数，应为 0 |
| `notes` | string | 失败原因或备注 |

### yahoo_auction_analysis_facts_v1

雅虎拍卖每场拍卖一行：疑似重挂、确认同款、公开落札分别打标，互不替代。

| 字段 | 类型 | 说明 |
|---|---|---|
| `source_listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `auction_id` | string | 雅虎拍卖的拍卖编号 |
| `canonical_url` | string | 商品链接 |
| `title` | string | 商品标题（平台原文） |
| `normalized_title` | string | 去掉标点空格、转小写后的标题，用来找重挂 |
| `seller_name` | string | 卖家名 |
| `image_url` | string | 商品主图链接 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `availability` | string | 状态：available=在售，sold_out=已售出 / 已结束，preorder=预约中，backorder=缺货可订，unknown=不明 |
| `current_price_jpy` | int | 当前价格（日元）。price_basis=auction_current_bid 时是拍卖当前出价，不是成交价 |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `first_seen_at` | timestamp | 系统第一次看到它的时间（UTC） |
| `last_seen_at` | timestamp | 系统最近一次看到它的时间（UTC） |
| `raw_observation_count` | bigint | 这场拍卖被搜到的次数 |
| `is_unique_listing` | boolean | 恒为 true：一行就是一场拍卖 |
| `is_suspected_relist` | boolean | 是否疑似重挂（同一卖家、同一标题、180 天内多次上架）。只打标，不删除 |
| `suspected_relist_group_id` | string | 疑似重挂组 ID，同组的是同一件东西反复上架 |
| `suspected_relist_listing_count` | bigint | 同组里有几场拍卖 |
| `suspected_relist_evidence` | string | 重挂判定依据 |
| `confirmed_product_variant_id` | string | 确认的同款编号，没确认为空 |
| `confirmed_canonical_product_id` | string | 确认的商品概念编号 |
| `confirmed_product_name` | string | 确认的商品标准名 |
| `is_confirmed_same_product` | boolean | 是否已确认是某个被盯的同款 |
| `public_awarded_signal_count` | bigint | 公开落札信号条数 |
| `has_public_awarded_signal` | boolean | 是否有公开落札信号 |
| `latest_public_awarded_price_jpy` | int | 最近一次公开落札价（日元）。不证明已付款 |
| `latest_public_awarded_at` | timestamp | 最近一次落札时间（UTC） |
| `public_awarded_evidence_boundary` | string | 落札证据边界：closed_auction_with_positive_bid=拍卖已结束且有正出价 |

### yahoo_auction_batch_dedup_v1

雅虎拍卖每次搜索一行的入库核对：同批重复应为 0。

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | 搜索批次 ID |
| `query` | string | 搜索词 |
| `query_key` | string | 搜索词的标准化键，同一个词的不同写法归成一个 |
| `origin` | string | 这次搜索从哪来：watch_keyword=关键词档案定时搜，watch_item=单品 / 同款档案定时搜，manual_search=后台手动搜 |
| `run_status` | string | 这次搜索整体结果（同 search_performance.run_status） |
| `searched_at` | timestamp | 搜索时间（UTC） |
| `source_status` | string | 雅虎拍卖这次的结果 |
| `source_reported_result_count` | int | 雅虎拍卖说返回了多少条 |
| `persisted_event_count` | bigint | 实际入库的观察条数 |
| `persisted_unique_listing_count` | bigint | 实际入库的不同拍卖数 |
| `persisted_strict_duplicate_count` | bigint | 同一批里同一场拍卖被重复入库的条数，应为 0 |
| `source_reported_to_persisted_delta` | bigint | 平台报的数量减去入库数量。只用于诊断，不代表重复 |

### yahoo_auction_event_facts_v1

雅虎拍卖每次搜索看到的每场拍卖一行（同一场会在多次搜索中重复出现）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | 搜索批次 ID |
| `source_listing_id` | bigint | 分析库里这件商品的内部编号（radar_analytics.source_listings.id） |
| `auction_id` | string | 雅虎拍卖的拍卖编号 |
| `batch_event_key` | string | 批次 + 拍卖编号，唯一标识一条观察 |
| `query` | string | 搜索词 |
| `query_key` | string | 搜索词的标准化键，同一个词的不同写法归成一个 |
| `origin` | string | 这次搜索从哪来：watch_keyword=关键词档案定时搜，watch_item=单品 / 同款档案定时搜，manual_search=后台手动搜 |
| `searched_at` | timestamp | 搜索时间（UTC） |
| `ingested_at` | timestamp | 入库时间（UTC） |
| `position` | int | 在搜索结果里排第几 |
| `price_jpy` | int | 这次观察到的价格（日元） |
| `price_basis` | string | 价格口径：listing_price=挂牌价（能按这个价买），auction_current_bid=拍卖进行中的当前出价（还会涨，不能当成交价也不能当可买价），catalog_price=商城目录标价，unknown=不明 |
| `availability` | string | 状态：available=在售，sold_out=已售出 / 已结束，preorder=预约中，backorder=缺货可订，unknown=不明 |
| `item_condition` | string | 成色：new=新品，used=二手，unknown=不明 |
| `is_new_for_query` | boolean | 对这个搜索词来说是否第一次出现 |
| `observed_at` | timestamp | 观察到的时间（UTC） |
| `payload_hash` | string | 原始数据的哈希，用来判断内容有没有变 |
| `title` | string | 商品标题（平台原文） |
| `canonical_url` | string | 商品链接 |

### yahoo_auction_market_layers_v1

雅虎拍卖五种口径的数量，供仪表盘用。五层口径不同，不能相加，也不是漏斗。

| 字段 | 类型 | 说明 |
|---|---|---|
| `layer_order` | int | 显示顺序 |
| `layer_key` | string | 口径代码 |
| `layer_label` | string | 口径中文名 |
| `entity_kind` | string | 这一层数的是什么东西 |
| `entity_count` | bigint | 数量。五层口径不同，不能相加，也不是漏斗 |

## 历史档案 `workspace.jpgr_history`

每张表的字段 = 同名 `radar_core` 表的字段 + `_archived_first_at`（第一次存进档案）+ `_archived_last_seen_at`（最近一次在生产库还看得到；早于最近一次同步 = 生产库已删）。

| 表 | 说明 |
|---|---|
| `email_deliveries` | 只增不删的历史档案：radar_core.email_deliveries 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `notice_deliveries` | 只增不删的历史档案：radar_core.notice_deliveries 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `events` | 只增不删的历史档案：radar_core.events 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `hermes_deliveries` | 只增不删的历史档案：radar_core.hermes_deliveries 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `listing_same_groups` | 只增不删的历史档案：radar_core.listing_same_groups 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `listing_snapshots` | 只增不删的历史档案：radar_core.listing_snapshots 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `source_health_snapshots` | 只增不删的历史档案：radar_core.source_health_snapshots 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `source_probe_observations` | 只增不删的历史档案：radar_core.source_probe_observations 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `watch_run_listing_observations` | 只增不删的历史档案：radar_core.watch_run_listing_observations 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `watch_run_query_attempts` | 只增不删的历史档案：radar_core.watch_run_query_attempts 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |
| `watch_runs` | 只增不删的历史档案：radar_core.watch_runs 的全部历史（生产库按保留期删掉的也在）。_archived_last_seen_at 早于最近一次同步 = 生产库已删 |

## 原始镜像 `workspace.radar_core`（运营库）

原始表的字段没有逐个写说明（整理层用到的字段，含义见上面的整理层）。下面是每张表的用途和字段清单。

| 表 | 用途 | 字段 |
|---|---|---|
| `analytics_outbox` | 运营库写往分析库的待办队列 | id, kind, reference_id, payload_json, status, attempts, queued_at, processed_at, last_error, created_at, updated_at |
| `completion_notifications` | 任务完成通知邮件的发送记录 | idempotency_key, status, attempts, resend_email_id, last_error, created_at, updated_at, sent_at |
| `cost_profiles` | 到手成本估算参数：汇率、代购费、国内外运费 | id, profile_key, version, name, exchange_rate_cny_per_100_jpy_milli, exchange_rate_buffer_bps, proxy_fixed_fee_jpy, proxy_percent_bps, domestic_shipping_min_jpy, domestic_shipping_max_jpy, international_route_label, first_weight_grams, first_weight_min_jpy, first_weight_max_jpy, continued_weight_grams, continued_weight_min_jpy, continued_weight_max_jpy, unknown_weight_min_grams, unknown_weight_max_grams, consolidation_share_bps, tax_enabled, tax_bps, cost_buffer_bps, valid_from, valid_to, created_at, created_by |
| `cron_heartbeats` | 定时调度的心跳：每次调度派了多少任务，只留 30 天 | id, scheduled_at, observed_at, due_bindings, enqueued_jobs, due_bindings_total, due_tracked_total, dispatch_ms |
| `d1_migrations` | JPGR PostgreSQL D1 兼容迁移记录的只读镜像，仅用于结构版本追踪。 | id, name, applied_at |
| `daily_counters` | 每天的调用计数：排队任务、搜索次数、详情请求、邮件发送 | day_utc, queued_jobs, search_calls, detail_calls, emails_sent, emails_failed, created_at, updated_at |
| `digest_item_labels` | 你在日报标注页给已发出商品的结论：hide=不想再看到，keep=还想看 | watch_profile_id, source_id, source_item_id, verdict, title, url, image_url, price, digest_event_id, labeled_at, reviewed_at |
| `email_deliveries` | 邮件发送记录：每个事件发了几次、成功与否 | id, event_id, idempotency_key, resend_email_id, status, attempts, last_error, created_at, sent_at |
| `notice_deliveries` | 通知发送记录（10-14 起取代 email_deliveries / push_deliveries / hermes_deliveries）：一份通知在每个渠道一行，channel=email/feishu/hermes；status 是发送进度，outcome 是到没到，fallback_reason 是飞书没送到补邮件的原因 | id, event_id, channel, status, attempts, next_attempt_at, remote_id, last_http_status, last_error, outcome, outcome_at, outcome_error, fallback_reason, created_at, updated_at, sent_at |
| `events` | 通知事件：新上架、降价、日报、平台故障等，每条一行，含是否已发。生产库留 180 天，完整历史在 jpgr_history | id, event_key, event_type, watch_profile_id, watch_binding_id, listing_id, payload_json, status, created_at, sent_at, delivery_not_before, email_suppressed_at, semantic_event_type |
| `experimental_source_runtime` | 实验平台的请求节奏和熔断状态 | source_id, next_request_at, failure_window_started_at, failure_count, circuit_until, updated_at |
| `gemini_job_payload_chunks` | AI 任务的分片载荷（太大时拆开存） | job_id, chunk_index, payload_chunk |
| `gemini_jobs` | AI（Gemini）判定任务：每批送 AI 的候选一行，含状态和结果 | id, kind, status, dedupe_key, model, prompt_version, payload_json, result_json, total_items, completed_items, failed_items, binding_id, watch_run_id, trigger_type, scan_started_at, attempt_count, lease_expires_at, next_attempt_at, upstream_status, last_error, created_at, updated_at, completed_at |
| `gemini_provider_cooldowns` | AI 服务商被限流后的冷却状态 | provider, cooldown_until, upstream_status, last_error, updated_at |
| `gemini_request_reservations` | AI 请求额度的预占记录（防止超限） | id, job_id, reserved_at |
| `gemini_token_reservations` | AI token 额度的预占记录（防止超限） | id, job_id, estimated_input_tokens, reserved_at |
| `health_check_findings` | 每日体检发现的问题：每个问题一段，记首次和最近出现时间、何时解决 | check_key, subject_key, severity, source_id, title, detail, first_seen_at, last_seen_at, resolved_at |
| `health_check_runs` | 每日体检：一天一行，看体检本身有没有跑 | day, started_at, finished_at, finding_count, failed_checks |
| `hermes_deliveries` | 推送到 Hermes（即时通知通道）的发送记录 | id, event_id, idempotency_key, status, attempts, remote_delivery_id, last_http_status, last_error, next_attempt_at, created_at, updated_at, sent_at |
| `host_disk_usage` | VPS 磁盘用量，定时写入 | host, mount, observed_at, size_bytes, used_bytes |
| `keyword_ai_reviews` | 关键词档案的人工复核记录：你把 AI 的相关性判定改过来的地方 | watch_binding_id, source_id, source_item_id, verdict, ai_relevance, match_created, created_at |
| `listing_group_jobs` | 日报图片分组任务的排队状态 | event_id, status, call_id, attempts, error, stats_json, started_at, finished_at, updated_at |
| `listing_same_groups` | 按图片判出的同款分组：一封日报里哪些商品是同一件东西 | event_id, item_url, group_key, method, created_at |
| `listing_snapshots` | 商品状态快照：价格或状态变化时记一行。生产库留 180 天，完整历史在 jpgr_history | id, listing_id, watch_binding_id, price, original_price, currency, availability, item_condition, state_hash, observed_at, content_hash, product_facts_json, price_basis |
| `listings` | 运营库的商品表：每个平台的每件商品一行，带当前价格、状态和原始字段 | id, source_id, source_item_id, identity_scope, canonical_url, title, description_excerpt, image_url, seller_name, shop_name, currency, current_price, original_price, price_basis, item_condition, availability, source_updated_at, first_seen_at, last_seen_at, last_changed_at, state_hash, raw_metadata_json, source_listed_at, jan, isbn, model_number, source_catalog_id, brand, manufacturer, release_date, preorder_deadline, image_urls_json, product_facts_json, content_hash, detail_hydrated_at |
| `managed_api_billing_usage` | 付费托管接口的计费周期用量 | provider, period_started_at, period_ends_at, runtime_budget, runtime_calls, emergency_reserve, updated_at, daily_day_jst, daily_budget, daily_runtime_calls |
| `managed_api_cache` | 付费托管接口的响应缓存 | provider, cache_key, response_json, expires_at, created_at, updated_at |
| `managed_api_monthly_usage` | 付费托管接口的月度用量 | provider, month_utc, runtime_budget, runtime_calls, emergency_reserve, updated_at |
| `market_listing_cleaning_claims` | 关键词商品送 AI 清洗时的占位锁，防止重复处理 | claim_key, subscription_key, source_id, source_item_id, model, prompt_version, job_id, status, created_at, updated_at |
| `market_scope_versions` | 关键词市场范围的版本定义 | id, subscription_key, watch_profile_id, version, scope_hash, scope_json, created_at |
| `monitor_events` | 按提醒规则产生的事件（新增报价、降价、恢复可买等），含能不能送达 | id, event_key, event_type, monitor_rule_id, rule_key, rule_version, watch_profile_id, watch_binding_id, subject_type, subject_id, listing_id, product_variant_id, payload_json, evidence_hash, notification_eligibility, suppression_reason, legacy_event_id, occurred_at, detected_at, created_at |
| `monitor_rule_landed_cost_targets` | 提醒规则的目标到手成本设置 | monitor_rule_id, cost_profile_id, target_landed_cost_jpy, threshold_policy, created_at |
| `monitor_rules` | 提醒规则：每个档案要提醒哪些事件、目标价、静默时段、冷却时长 | id, rule_key, version, watch_profile_id, scope_type, scope_id, scope_identity_status, event_types_json, source_allow_json, source_deny_json, conditions_json, completeness_json, target_listing_price, target_landed_cost, delivery_mode, quiet_hours_start, quiet_hours_end, timezone, dedupe_window_minutes, cooldown_minutes, stale_source_policy, enabled, supersedes_rule_id, valid_from, valid_to, created_at, created_by |
| `notification_channels` | 启用了哪些通知通道 | channel, enabled_at, created_at, updated_at |
| `p0_qualification_runs` | P0 资格验证的运行记录 | id, status, triggered_by, started_at, finished_at, results_json, error_message, created_at, updated_at |
| `product_identity_projection_versions` | 同款身份判定结果每次投影到分析库的版本记录 | id, projection_hash, workflow_task_id, search_history_id, canonical_product_id, product_variant_id, comparison_profile_id, identity_version, membership_version, projection_json, membership_count, confirmed_count, rejected_count, uncertain_count, analytics_outbox_id, projected_at |
| `product_search_workflow_results` | 精确同款搜索任务在每个平台的结果 | task_id, source_id, group_json, completed_at |
| `product_search_workflow_tasks` | 精确同款搜索任务：一次“找这件商品”的完整流程 | id, status, input_json, plan_json, history_id, session_id, journal_ready_at, result_summary_json, attempt_count, last_error, created_at, started_at, updated_at, completed_at, ai_job_id, ai_manifest_json, ai_error, ai_prepared_at |
| `queue_dead_letters` | 处理失败进入死信队列的消息 | queue_name, dead_letter_queue_name, idempotency_key, message_id, message_type, body_json, deliveries, last_delivery_attempt, first_dead_lettered_at, last_dead_lettered_at, last_error |
| `queue_message_receipts` | 队列消息的处理回执（防重复处理） | queue_name, idempotency_key, message_id, message_type, status, deliveries, last_delivery_attempt, first_received_at, last_received_at, completed_at, last_error |
| `runtime_feature_flags` | 运行时功能开关（例如参考图找货） | flag_key, enabled, config_json, updated_at |
| `search_candidate_hits` | 手动搜索时每个候选是被哪个搜索词、哪条线路找到的 | search_history_id, source_id, source_item_id, variant_id, lane, upstream_rank, weight, live_verified |
| `search_history` | 后台手动搜索的记录（只留最近 50 次） | id, query, sources_json, filters_json, status, result_count, source_summary_json, searched_at, search_mode, target_json, plan_json, deep_search, session_id, parent_history_id, page_sequence, session_updated_at |
| `search_listing_index` | 跨次搜索积累的商品索引，供精确搜索回查 | source_id, source_item_id, title_normalized, search_text, listing_json, first_seen_at, last_seen_at, last_live_verified_at |
| `search_product_relations` | 手动搜索时每个候选和目标的字面关系判定 | search_history_id, source_id, source_item_id, relation, score, matcher_version, evidence_json, created_at |
| `search_query_variants` | 手动搜索时生成的各个搜索词变体 | search_history_id, variant_id, query, query_kind, lane, weight, ordinal |
| `search_result_snapshots` | 手动搜索的结果快照 | search_history_id, source_id, group_json, captured_at |
| `source_health_snapshots` | 每次搜索时平台的健康状态。随 watch_runs 只留 90 天，完整历史在 jpgr_history | id, source_id, watch_binding_id, watch_run_id, observed_at, state, request_succeeded, parse_succeeded, coverage, raw_result_count, normalized_result_count, page_depth, cursor_termination_reason, response_content_hash, response_bytes, template_version, http_status, field_total, field_complete, captcha_detected, login_required, blocked_detected, abnormal_empty, freshness_sla_minutes, error_code, error_message |
| `source_history_anchors` | 已验证存在的历史商品锚点，供精确搜索回查 | source_id, source_item_id, title_hint, pinned, first_verified_at, last_verified_at |
| `source_probe_observations` | 实验平台试运行的每次请求结果。生产库留 90 天，完整历史在 jpgr_history | id, source_id, window_started_at, observed_at, status, coverage, result_count, field_total, field_complete, http_status, parser_version, error_code, error_message, captcha_detected, cpu_limit_detected, login_required |
| `source_probe_window_history` | 实验平台已结束的试运行窗口 | id, source_id, status, request_route, started_at, planned_end_at, finished_at, total_runs, successful_runs, field_total, field_complete, captcha_runs, cpu_limit_runs, login_required_runs, decision_reason, original_updated_at, archived_at, archive_reason, next_request_route |
| `source_probe_windows` | 实验平台的试运行窗口：当前这一轮的成功率统计 | source_id, status, started_at, planned_end_at, finished_at, total_runs, successful_runs, field_total, field_complete, captcha_runs, cpu_limit_runs, login_required_runs, decision_reason, updated_at, request_route |
| `source_registry` | 平台清单：每个平台一行，含是否启用、主用线路、冷却状态 | id, display_name, transport, identity_scope, official_api, enabled, credential_status, health_status, capabilities_json, parser_version, last_success_at, last_failure_at, consecutive_failures, cooldown_until, last_http_status, last_error_code, last_error_message, last_signature_success_at, schema_version, last_403_at, last_429_at, last_container_count, last_page_bytes, captcha_detected, created_at, updated_at, request_route, cooldown_route |
| `source_response_captures` | 平台原始响应的摘要证据，只留几天 | id, run_id, source_id, ordinal, request_url, response_url, request_method, response_status, content_type, payload_kind, raw_payload, payload_bytes, content_hash, captured_at, duration_ms, truncated, error_message |
| `verification_checks` | 上线验证清单的检查结果 | scope, check_key, label, status, evidence_json, verified_at, updated_at |
| `watch_bindings` | 档案在每个平台上的搜索绑定：一个档案 × 一个平台一行，含搜索词、频率、下次运行时间 | id, watch_profile_id, source_id, kind, query, search_url, target_url, source_config_json, interval_minutes, next_run_at, last_run_at, last_success_at, baseline_completed, notify_initial, notify_price_drop, notify_restock, notify_sold_out, target_price, min_drop_amount, enabled, consecutive_failures, cooldown_until, last_error_code, last_error_message, created_at, updated_at, monitoring_purpose, schedule_interval_minutes, source_item_id, notify_new_listing, new_listing_watermark, new_listing_anchored_at, new_listing_anchor_attempts, notify_price_rise |
| `watch_bindings_backup_20260908` | 2026-09-08 改搜索绑定前的备份，只读留档 | id, source_id, enabled, interval_minutes, source_config_json, backed_up_at |
| `watch_dismissed_candidates` | 你在网页上标掉的候选（不是同款 / 太贵了），之后不再作为新发现提醒 | watch_binding_id, source_id, source_item_id, reason, created_at |
| `watch_listing_matches` | 档案和商品的匹配关系：被算作档案命中的商品，以及为什么算（acceptance_reason） | watch_binding_id, listing_id, first_seen_at, last_seen_at, new_listing_notified_at, acceptance_reason, matcher_version, semantic_prompt_version, accepted_at, tracking_status, tracking_interval_minutes, tracking_next_run_at, tracking_last_run_at, tracking_last_success_at, tracking_baseline_completed, tracking_consecutive_failures, tracking_cooldown_until, tracking_last_error_code, tracking_last_error_message, tracking_missing_observations, tracking_last_price, tracking_last_availability, tracking_last_state_hash, tracking_started_at, tracking_ended_at, tracking_terminal_reason |
| `watch_profile_muted_products` | 档案的屏蔽单品规则：标题命中这些词组的商品不再进日报 | id, watch_profile_id, term_groups_json, sample_title, sample_url, sample_image_url, created_at |
| `watch_profile_reference_images` | 精确同款雷达的参考图（参考图找货用） | watch_profile_id, ordinal, content_type, image_base64, width, height, created_at |
| `watch_profiles` | 档案：你建的每个雷达一行（关键词日报 / 精确同款雷达 / 单品盯价），含送达门槛和日报设置 | id, name, description, default_max_price, include_terms_json, exclude_terms_json, enabled, created_at, updated_at, dossier_kind, product_variant_id, product_identity_search_history_id, offer_tracking_policy, suspect_notice_policy, min_listing_price, digest_price_reference, digest_show_sales |
| `watch_run_listing_observations` | 每次搜索看到的每件候选一行，带系统判定（确认 / 待定 / 拒绝）、字面关系和 AI 表态。生产库随 watch_runs 只留 90 天，完整历史在 jpgr_history | watch_run_id, watch_binding_id, source_id, source_item_id, canonical_url, title, image_url, current_price, original_price, currency, availability, item_condition, source_listed_at, ordinal, observed_at, decision_status, decision_reason, match_relation, is_purchasable, created_at, updated_at, price_basis, ai_relevance, ai_confidence, image_sim, image_inliers, image_verdict, image_reference_key |
| `watch_run_query_attempts` | 每次搜索实际发出的每个搜索词一行（主词和补搜词），留一年 | watch_run_id, ordinal, watch_binding_id, source_id, role, variant_kind, query, outcome, upstream_count, candidate_count, new_candidate_count, source_item_ids_json, error_message, duration_ms, created_at |
| `watch_runs` | 每次定时搜索一行（一个绑定跑一次）。生产库只留 90 天，完整历史在 jpgr_history.watch_runs | id, watch_binding_id, trigger_type, status, started_at, finished_at, duration_ms, http_status, result_count, new_count, changed_count, coverage, parser_version, error_code, error_message, field_total, field_complete, captcha_detected, cpu_limit_detected, login_required |
| `web_search_cache` | 网页搜索结果缓存 | query_key, query, response_json, response_status, created_at, expires_at |

## 原始镜像 `workspace.radar_analytics`（分析库）

原始表的字段没有逐个写说明（整理层用到的字段，含义见上面的整理层）。下面是每张表的用途和字段清单。

| 表 | 用途 | 字段 |
|---|---|---|
| `ai_enrichments` | AI 给商品补充的信息（品类、角色等），按版本追加，不覆盖原始数据 | id, source_listing_id, catalog_product_id, purpose, model, prompt_version, output, evidence, created_at, provider, input_hash, input, confidence, metadata, batch_id |
| `ai_processing_batches` | 每次调用 AI 的原始请求和返回，作为证据留存 | batch_id, purpose, provider, model, prompt_version, input_hash, input, raw_response, status, parsed_count, metadata, created_at |
| `canonical_products` | 商品概念：由精确同款目标得出的官方商品，一个概念一行 | id, identity_hash, identity_version, canonical_name, work_title, character_names, product_type, manufacturer, series, target_fingerprint, created_at, updated_at |
| `catalog_products` | 按 JAN / 标准化标题归并出的目录商品 | id, canonical_title, identifiers, created_at, updated_at, product_key, identity_method |
| `comparison_profiles` | 比价样本的筛选规则（按版本） | id, product_variant_id, profile_version, rule_version, name, condition_policy, allowed_conditions, allowed_completeness, allowed_price_bases, allowed_official_statuses, active, created_at, superseded_at |
| `keyword_listings` | 每个关键词见过的每件商品：首次 / 最近出现、出现次数、是否还在结果窗口里 | query_key, source_listing_id, first_seen_at, first_seen_run_id, last_seen_at, last_seen_run_id, latest_evaluated_at, last_left_run_id, appearances, active_visible |
| `listing_observations` | 每次搜索看到的每件商品的价格和状态，一行一次观察 | run_id, source_listing_id, source_id, position, price_jpy, original_price_jpy, availability, item_condition, is_new_for_query, observed_at, price_basis, listing_payload, payload_hash, price_status |
| `market_ai_reports` | One-shot PostgreSQL analysis mirror. Snapshot 20260729T144558Z; source radar_analytics.market_ai_reports. | id, subscription_key, source_id, period_days, evidence_hash, evidence_started_at, evidence_ended_at, evidence, provider, model, prompt_version, output, generated_at, created_at |
| `market_scope_versions` | 关键词市场范围的版本定义（分析库口径） | id, subscription_key, subscription_name, query, version, scope_hash, definition, created_at |
| `operational_listing_snapshots` | 从运营库回填的商品快照，作为价格证据留存 | external_snapshot_id, source_listing_id, watch_binding_id, observed_at, content_hash, payload, created_at |
| `product_listing_links` | 商品和目录商品的关联（按 JAN / 标题归并） | catalog_product_id, source_listing_id, match_method, confidence, evidence, created_at |
| `product_listing_memberships` | 商品属于哪个同款的判定记录（按版本追加）：confirmed=确认，uncertain=待定，rejected=拒绝。已售状态不等于成交 | id, product_variant_id, source_listing_id, search_run_id, workflow_task_id, decision, decision_source, relation, confidence, membership_version, evidence, valid_from, valid_to, is_current, supersedes_membership_id, created_at |
| `product_variants` | 同款商品的具体版本，拿不准的版本分开存不合并 | id, canonical_product_id, identity_hash, identity_version, variant_name, model, jan, size, attributes, target_fingerprint, created_at, updated_at |
| `sale_records` | 有证据的成交记录（目前主要是雅虎拍卖公开落札） | id, source_listing_id, source_sale_id, sold_price_jpy, sold_at, evidence_url, evidence, recorded_at |
| `search_product_relations` | 每次搜索时每件商品和目标的字面关系判定（按版本） | search_run_id, source_listing_id, target, relation, score, matcher_version, evidence, observed_at |
| `search_run_sources` | 每次搜索 × 每个平台一行：结果数、新增、耗时、线路 | run_id, source_id, status, coverage, result_count, new_count, left_count, available_count, min_price_jpy, max_price_jpy, average_price_jpy, parser_version, request_route, duration_ms |
| `search_runs` | 每次搜索一行（分析库口径） | id, origin, query, query_key, filters, status, result_count, searched_at, ingested_at, subscription_key, subscription_name, binding_id, scope_version_id |
| `source_health_snapshots` | 每次搜索时平台的健康状态（分析库口径，不裁剪） | run_id, scope_version_id, subscription_key, source_id, observed_at, state, request_succeeded, parse_succeeded, coverage, raw_result_count, normalized_result_count, page_depth, cursor_termination_reason, response_content_hash, response_bytes, template_version, http_status, field_total, field_complete, captcha_detected, login_required, blocked_detected, abnormal_empty, freshness_sla_minutes, error_code, error_message |
| `source_listings` | 分析库的商品表：每个平台的每件商品一行，价格统一为日元。current_listings 视图就是它 | id, source_id, source_item_id, identity_scope, canonical_url, title, description_excerpt, image_url, seller_name, shop_name, currency, current_price_jpy, original_price_jpy, price_basis, item_condition, availability, facts, raw_metadata, first_seen_at, last_seen_at, last_changed_at, product_key, product_match_method, source_listed_at, source_updated_at, price_status |
| `source_response_captures` | 平台原始响应的摘要证据（分析库口径） | capture_id, run_id, source_id, ordinal, request_url, response_url, request_method, response_status, content_type, payload_kind, raw_payload, payload_bytes, content_hash, captured_at, duration_ms, truncated, error_message, created_at |
| `source_run_artifacts` | 每次搜索每个平台的整理后结果包，作为证据留存 | run_id, source_id, artifact_kind, captured_at, content_hash, payload_bytes, payload, created_at |
| `strategy_price_facts_v1` | 价格研究用的价格事实（strategy_price_facts 视图的来源） | fact_semantics_version, price_fact_id, price_role, product_variant_id, identity_known_at, source_listing_id, source_id, source_item_id, product_key, product_match_method, title, canonical_url, amount_jpy, currency, price_basis, item_condition, availability, tax_status, shipping_status, occurred_at, knowledge_at, evidence_kind, evidence_id, evidence_url, evidence |

## 原始镜像 `workspace.jpgr_meta`

原始表的字段没有逐个写说明（整理层用到的字段，含义见上面的整理层）。下面是每张表的用途和字段清单。

| 表 | 用途 | 字段 |
|---|---|---|
| `import_snapshots` | 早期把数据导入 PostgreSQL 的批次记录（迁移遗留） | source, source_id, snapshot_sha256, exported_at, imported_at, table_count, row_count, status, notes |
| `schema_migrations` | 生产库已执行的迁移清单 | version, checksum_sha256, applied_at |
| `watch_bindings_target_backup_20260906` | 2026-09-06 改搜索绑定前的备份，只读留档 | id, source_config_json, taken_at |

