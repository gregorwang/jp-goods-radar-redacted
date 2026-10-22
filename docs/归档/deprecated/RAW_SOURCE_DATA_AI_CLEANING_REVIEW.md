# 原始来源数据与 AI 清洗链路对齐

> 审计时间：2026-07-16（Asia/Tokyo）  
> 审计代码：`ef8c4bb`  
> 审计数据库：Supabase 项目 `sera`，schema `radar_analytics`  
> 本文只记录 Git 历史、当前实现与数据库只读样本，不包含业务代码修改。

## 0. 先把目标说清楚

这里要做的不是 Agent，也不需要 Agent 的循环规划、工具调用、长期会话或自主行动。

目标是一条普通的数据处理流水线：

```text
尽可能完整地抓取来源数据
        ↓
原样、不可变地保存到 PG
        ↓
对新数据或发生变化的数据执行一次 AI 清洗任务
        ↓
把 AI 返回原文和清洗后的统一字段一起保存到 PG
        ↓
前端只读取统一字段；需要时可以展开查看来源原文
```

这里的 AI 有两个不同用途，不能混在一起：

1. **商品数据清洗**：面向单条或一批来源数据，适合在新内容入库后自动、幂等地执行。它是 ETL/队列任务，不是 Agent。
2. **行情分析报告**：面向用户选定的数据窗口，继续保持用户手动点击后才调用。

当前仓库的顺序并不是这样。现在大体是：

```text
来源响应
  → 适配器先判断、映射、丢弃字段和商品
  → 标准化结果直接返回前端
  → 前端再挑当前页部分商品调用 Gemini
  → AI 结果临时叠加到商品卡片
```

因此，过去很多兼容条件被放在了错误的位置：抓取端和前端被迫替 AI 做语义判断，同时 AI 又看不到真正的来源原始数据。

## 1. Git 历史里发生过什么

| 提交 | 变化 | 对数据的实际影响 |
|---|---|---|
| `d698d04` | 增加托管来源兜底和 Parse 骏河屋适配 | Parse 返回内容先被 `parseItem()` 映射成 `NormalizedListing`，未被映射的上游字段不会进入后续链路。 |
| `a40f97b` | `contract Parse fallback queries` | 长关键词被 NFKC 处理后按空格切分，只保留前三段并截到 60 字。语义在请求来源前已经改变。 |
| `9310f7f` | `recover rejected long queries` | 同一套关键词收敛从 Parse 兜底扩展到骏河屋主路径：完整词 404 时，自动用收敛词重搜。请求成功了，但结果不再代表原查询。 |
| `561931a` | 加强骏河屋结果校验 | 缺稳定链接或标题的容器被隔离，只保存接受/拒绝数量；被拒绝容器的原 HTML 片段没有进入 PG。 |
| `d99a9a7` | 搜索结果 Gemini 整理 | AI 在前端拿到结果后自动运行，只整理当前页候选；严格 JSON Schema、索引和逐字证据校验会把部分结果置为不可用。 |
| `fcaa956` | 增加 Postgres analytics pipeline | 开始把搜索运行和商品观察写入 PG，但输入已经是适配器标准化后的对象。 |
| `751bc3b` | Cloudflare 来源和持久分析 | 删除骏河屋关键词收敛；增加 `listing_payload`、`source_run_artifacts`、`ai_enrichments`。但 artifact 类型仍然只有 `normalized_source_group`，不是真正 HTTP/API 原响应。 |

### 1.1 最关键的错误：关键词收敛

`a40f97b` 加入过以下逻辑：

```ts
const terms = normalized.split(/\s+/).filter(Boolean);
if (terms.length <= 3 && normalized.length <= 60) return normalized;
return terms.slice(0, 3).join(" ").slice(0, 60).trim();
```

用户输入：

```text
ぬいぐるみ　エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定
```

在旧逻辑中会退化成类似：

```text
ぬいぐるみ エミリア ふわかわロリータぬいぐるみ
```

后续版本还曾改成“第一段 + 最后一段”，本质问题不变：程序为了让来源返回 200，提前改写了用户语义。

### 1.2 PG 中的实际证据

同一个完整关键词在 2026-07-15 12:45 UTC 的旧运行返回了 5 件商品：

| source_item_id | 标题 | 结果 |
|---|---|---|
| `602232513` | アーニャ・フォージャー 「SPY×FAMILY」 1/7 塗装済み完成品 F：NEX限定 | 无关 |
| `646162751` | でびあくまポーズぬいぐるみ 「魔王城でおやすみ」 F：NEX限定 | 无关 |
| `646126887` | でびあくま 1/1 ぬいぐるみ 「魔王城でおやすみ」 F：NEX限定 | 无关 |
| `602268355` | [ランクB] アーニャ・フォージャー 「SPY×FAMILY」 1/7 塗装済み完成品 F：NEX限定 | 无关 |
| `646126886` | [美品] でびあくま 1/1 ぬいぐるみ 「魔王城でおやすみ」 F：NEX限定 | 无关 |

共同点只有“ぬいぐるみ”或“F：NEX限定”。这不是来源本身的数据质量问题，是查询被应用程序改写后造成的假相关结果。

`751bc3b` 删除关键词改写并改为 Cloudflare 完整词直连。2026-07-16 00:50 UTC，同一个完整关键词返回：

| source_item_id | 标题 | 价格 | 状态 |
|---|---|---:|---|
| `646170273` | エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定 | ¥38,300 | `sold_out` |
| `646170272` | [美品] エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定 | ¥20,100 | `sold_out` |

这组历史直接证明：**应该保存完整查询和完整来源结果，不能为了“成功”在抓取前猜测关键词。**

## 2. 当前 PG 里所谓“原始数据”到底是什么

当前主要数据层如下：

| 表 | 当前数量 | 保存内容 | 是否真正上游原始响应 |
|---|---:|---|---|
| `source_listings` | 930 | 每个来源商品当前物化状态 | 否，已经标准化 |
| `listing_observations` | 1,467 | 每次运行观察到的标准化商品文档 `listing_payload` | 否，已经标准化 |
| `source_run_artifacts` | 86 | 每个来源运行的整个标准化 group | 否，`artifact_kind` 只有 `normalized_source_group` |
| `operational_listing_snapshots` | 336 | 从 D1 回填的商品状态快照 | 否，已经标准化 |
| `ai_enrichments` | 0 | 设计上用于保存 AI 衍生字段 | 当前没有实际记录 |

数据库迁移对 `source_run_artifacts` 的定义明确限制为：

```sql
artifact_kind text NOT NULL DEFAULT 'normalized_source_group'
  CHECK (artifact_kind IN ('normalized_source_group'))
```

所以当前系统保存的是“进入分析前的标准化证据”，不是以下内容：

- 骏河屋完整 HTML；
- Mercari 内部 API 的完整 JSON；
- 乐天 API 的完整 item 对象；
- Yahoo 网页会话的完整响应；
- Amazon 上游供应商的完整 JSON；
- 解析器拒绝的商品容器原文。

`rawMetadata` 这个名字容易误导。它只是适配器主动挑选出来的少量来源字段，并不等于 raw response。

### 2.1 当前字段覆盖情况

下表来自 PG 当前 930 条 `source_listings`：

| 来源 | 商品数 | 有描述 | 有价格 | 已标准化品相 | 已标准化库存 | `rawCategory` |
|---|---:|---:|---:|---:|---:|---:|
| Amazon JP | 51 | 0 | 51 | 51 | 51 | 0 |
| Animate | 57 | 0 | 57 | 57 | 55 | 0 |
| CharaON | 49 | 0 | 49 | 49 | 49 | 0 |
| COSPA | 9 | 0 | 9 | 9 | 9 | 0 |
| Mercari JP | 159 | 7 | 159 | 152 | 159 | 0 |
| Rakuten Books | 4 | 0 | 4 | 4 | 1 | 0 |
| Rakuten Ichiba | 250 | 187 | 250 | 250 | 250 | 0 |
| Surugaya | 226 | 0 | 214 | 226 | 226 | 0 |
| Yahoo! Shopping | 125 | 0 | 125 | 0 | 0 | 0 |

最明显的结论：

1. `rawCategory` 在全部来源、全部商品上都是 0。前面的 AI 行情报告说“rawCategory 几乎为空”，实际是当前数据链路根本没有写这个字段。
2. Yahoo 的品相和库存 125 条全部是 `unknown`，前端无法仅靠统一字段正确展示。
3. 乐天被标准化为 250/250 都有品相，但下面的真实样本证明这个“完整率”并不代表正确率。
4. Amazon 51/51 都有价格，也不代表价格有效；当前存在 `currentPrice: 0`。
5. 描述文本主要集中在乐天，其他来源的大量语义信息在适配器阶段没有保存下来。

## 3. PG 中实际保存的商品 JSON 样本

以下 JSON 来自 `listing_observations.listing_payload`；没有进行语义改写，只做了缩进排版。它们是当前系统能提供给 AI 的最完整商品文档，但仍然是标准化后的数据，不是上游原响应。

### 3.1 骏河屋：目标商品 `646170273`

```json
{
  "sourceId": "surugaya",
  "sourceItemId": "646170273",
  "canonicalUrl": "https://www.suruga-ya.jp/product/detail/646170273",
  "title": "エミリア ふわかわロリータぬいぐるみ 「Re：ゼロから始める異世界生活」 F：NEX限定",
  "currency": "JPY",
  "currentPrice": 38300,
  "priceBasis": "listing_price",
  "condition": "used",
  "availability": "sold_out",
  "facts": {
    "displayFacts": [
      {
        "key": "list_price",
        "kind": "text",
        "group": "commerce",
        "label": "官方定价",
        "value": "￥11,000"
      }
    ],
    "sourceAvailabilityLabel": "品切れ"
  },
  "rawMetadata": {
    "pageBytes": 112557,
    "parserVersion": "surugaya-html-v2",
    "priceEvidence": "json_ld_offer",
    "containerCount": 2,
    "marketplacePrice": null,
    "offerAvailability": "https://schema.org/OutOfStock",
    "priceHydratedFrom": "detail",
    "referenceListPrice": 11000,
    "sourceConditionLabel": "中古"
  }
}
```

同一商品的 `source_listings.raw_metadata` 当前还有：

```json
{
  "category": "ぬいぐるみ"
}
```

但是这个 `category` 不在当次不可变 `listing_payload.rawMetadata` 中。这说明当前物化商品行与当次观察文档之间也可能存在字段差异；前端如果只读其中一层，会得到不同答案。

### 3.2 Rakuten Ichiba：标题与品相冲突

```json
{
  "sourceId": "rakuten_ichiba",
  "sourceItemId": "fukufuku-rando:10195811",
  "title": "【中古】DVD▼氷菓 レンタル落ち ケース無",
  "shopName": "フクフクらんど",
  "currentPrice": 349,
  "condition": "new",
  "availability": "available",
  "facts": {
    "sourceConditionLabel": "新品"
  },
  "rawMetadata": {
    "pointRate": 1,
    "identifiers": {},
    "sourceConditionLabel": "新品"
  },
  "descriptionExcerpt": "&nbsp;出　演&nbsp;山崎賢人(折木奉太郎)／広瀬アリス(千反田える)…ジャンル&nbsp;邦画／サスペンス／青春／学園…"
}
```

问题不是“字段缺失”，而是来源 API/适配器给出的 `condition=new` 与标题中的 `【中古】`、`レンタル落ち`、`ケース無` 明显冲突。传统代码很难写完所有日文语义规则，这正是 AI 清洗层应该处理的内容。

AI 清洗后可以保留：

```json
{
  "normalizedCondition": "used",
  "conditionDetails": ["出租店退役盘", "无盒"],
  "sourceConditionConflict": true,
  "evidence": ["【中古】", "レンタル落ち", "ケース無"]
}
```

原始 `condition=new` 仍然保留，不覆盖。

### 3.3 Amazon JP：零元价格被当成有效价格

```json
{
  "sourceId": "amazon_jp",
  "sourceItemId": "B0F5WCVHBN",
  "title": "Re：ゼロから始める異世界生活 ふわぷち デフォルメフィギュア エミリア",
  "currentPrice": 0,
  "originalPrice": 0,
  "condition": "new",
  "availability": "available",
  "facts": {
    "identifiers": {
      "asin": "B0F5WCVHBN"
    }
  },
  "rawMetadata": {
    "prime": false,
    "ratings": 0,
    "starRating": null,
    "apiProvider": "openwebninja",
    "parserVersion": "amazon-openwebninja-v1"
  }
}
```

这里的 `0` 很可能代表上游无有效报价，而不是免费商品。当前统计会把它算成“有价格”，从而污染最低价和平均价。正确做法不是删除原值，而是由清洗层产生：

```json
{
  "normalizedPrice": null,
  "priceStatus": "missing_or_invalid",
  "rawPrice": 0
}
```

### 3.4 Yahoo! Shopping：来源有商业字段，但统一状态全是 unknown

```json
{
  "sourceId": "yahoo_shopping",
  "sourceItemId": "dss_zmxz-18965",
  "title": "Re：ゼロから始める異世界生活 4th season 5【Blu-ray】 (初回仕様) [Blu-ray]",
  "shopName": "ぐるぐる王国DS ヤフー店",
  "currentPrice": 7797,
  "originalPrice": 9900,
  "condition": "unknown",
  "availability": "unknown",
  "rawMetadata": {
    "provider": "yahoo-shopping-web",
    "sellerId": "dss",
    "basePrice": 8494,
    "categoryId": "882",
    "discountRate": 14,
    "payablePrice": 7797,
    "shippingCode": 2,
    "sellerReview": {
      "count": 24986,
      "average": 4.49
    }
  }
}
```

来源数据并非完全没用，只是统一字段没有被清洗出来。AI 可以结合标题、店铺类型和来源字段判断“新品零售 Blu-ray”，同时把库存保持为“无法确认”，而不是让前端自己针对 Yahoo 写特殊分支。

### 3.5 Mercari JP：来源字段相对完整

```json
{
  "sourceId": "mercari_jp",
  "sourceItemId": "m31065732477",
  "title": "いまさら翼といわれても 米澤穂信 角川文庫",
  "currentPrice": 400,
  "condition": "used",
  "availability": "available",
  "sourceListedAt": "2026-07-15T11:14:25.000Z",
  "facts": {
    "sourceConditionLabel": "目立った傷や汚れなし",
    "sourceAvailabilityLabel": "ITEM_STATUS_ON_SALE"
  },
  "rawMetadata": {
    "itemType": "ITEM_TYPE_MERCARI",
    "saleMode": "fixed_price",
    "priceType": "fixed",
    "sourceStatus": "ITEM_STATUS_ON_SALE",
    "sourceConditionId": "3",
    "sourceConditionLabel": "目立った傷や汚れなし"
  }
}
```

Mercari 这类数据更适合让 AI 做翻译、品相摘要、作品/角色/商品类型识别，而不是重复推断已经可靠存在的价格与状态。

### 3.6 Animate / CharaON：分类字段存在，但位置不统一

Animate 样本把分类放在两个位置：

```json
{
  "facts": {
    "categoryPath": ["グッズ"]
  },
  "rawMetadata": {
    "category": "グッズ"
  }
}
```

CharaON 同类商品只有：

```json
{
  "facts": {
    "brand": "CharaON",
    "sourceConditionLabel": "新品",
    "sourceAvailabilityLabel": "在庫 ○"
  },
  "rawMetadata": {
    "parserVersion": "charaon-html-v1"
  }
}
```

所以“统一分类”不应该要求每个适配器都完美写入同一个字段后才能展示。AI 应该同时读取标题、来源字段、描述和分类路径，把结果写入统一衍生列。

## 4. 现有 AI 整理为什么没有形成真正的数据层

现有代码已经有一个 Gemini 商品整理功能，但执行位置和范围不符合目标。

### 4.1 它发生在前端拿到结果以后

`apps/web/src/components/search-studio.tsx` 中，前端先得到 `groups → listings → filteredListings → pagedListings`，然后 `useEffect` 自动调用 `/api/ai/listing-enrichment`。

也就是说：前端已经必须兼容来源差异，AI 只是之后叠加一小块说明，并没有成为前端的统一数据来源。

### 4.2 它只处理当前页最多 12 件

```ts
const RESULT_PAGE_SIZE = 12;

const aiCandidates =
  (resultView === "all" ? pagedListings : filteredListings.slice(0, RESULT_PAGE_SIZE))
    .filter(shouldEnrich);
```

这不是“把入库数据清洗后供全站使用”，而是“用户看到哪一页就临时处理哪一页”。

### 4.3 大量商品被提前排除

```ts
export function shouldEnrich(item: NormalizedListing): boolean {
  if (item.condition === "new") return false;
  return Boolean(item.descriptionExcerpt || sourceConditionOriginal(item) || listingCategory(item));
}
```

因此：

- 所有被适配器标成 `new` 的商品不会交给 AI；
- 没有描述、来源品相或分类的商品不会交给 AI；
- 恰恰是字段最差、最需要 AI 的记录，最容易被跳过；
- 乐天标题明明写着 `【中古】`，但因适配器标成 `new`，会直接跳过 AI。

### 4.4 AI 看不到完整 PG 证据

发送给模型的主要是：

```json
{
  "title": "...",
  "description": "...",
  "sourceCondition": "...",
  "category": "..."
}
```

`rawMetadata`、`facts` 的其他字段、历史观察、查询上下文和真正来源响应没有完整发送。

### 4.5 严格校验会把结果丢掉

当前返回需要满足：

- 完整 JSON Schema；
- 数量必须与输入数量一致；
- index 必须一一对应；
- evidence quote 必须逐字存在于指定输入字段；
- 有任何抽取事实时必须至少有一条 evidence。

失败条目会成为 `null`。这类规则适合做“高置信度引用”，不适合做基础数据清洗的唯一入口。

更合适的方式是：

1. 永远保存模型原始返回；
2. 尽力解析统一字段；
3. 缺失字段写 `null`，冲突字段记录冲突；
4. 单个字段失败不拒绝整条商品；
5. 只有传输失败、无法对应 source listing 等基础完整性错误才标记任务失败。

当前 PG 中 `ai_enrichments = 0`，说明这套前端 AI 整理至少还没有形成可复用的持久数据层。

## 5. 正确的非 Agent 数据架构

### 5.1 第一层：来源原始捕获

每次来源请求先写入一份不可变捕获记录。至少保留：

```text
capture_id
run_id
source_id
request_query（完整原词）
request_url（敏感参数脱敏）
request_filters
response_status
content_type
captured_at
content_hash
raw_payload（JSON 或 HTML 原文）
parser_version
```

这一层允许做的事情只有传输安全和身份边界：

- 固定来源域名；
- 超时和响应体大小上限；
- 密钥、Cookie 等敏感字段脱敏；
- 内容哈希和幂等；
- 明确来源、时间和请求上下文。

这一层不应该：

- 缩短或改写关键词；
- 因为标题“不相关”而拒绝保存；
- 因为缺标题、价格、分类而丢弃原容器；
- 把 `0` 自动解释成有效价格；
- 把来源 API 的 `new` 当成最终品相真相。

### 5.2 第二层：最低限度确定性拆分

普通代码只负责把原始响应拆成可寻址的 item，不做复杂语义判断：

```text
raw_item_id
capture_id
source_id
source_item_id（能确定则写，不能确定则为空）
canonical_url（能确定则写）
raw_item_payload
raw_item_hash
```

即使某个 item 缺少稳定 URL，也应该作为 `parse_status = unresolved` 保存，而不是完全消失。这样 AI 或后续新版解析器仍然可以重新处理历史数据。

### 5.3 第三层：AI 清洗任务

对每个新的 `raw_item_hash` 创建一次普通队列任务：

```text
input_hash = hash(raw_item_payload + cleaner_prompt_version + model)
```

同一个输入、同一个模型和 prompt 只处理一次。任务由无状态 Worker/Queue consumer 执行：

```text
读 PG 原始 item
  → 直接调用选定模型 HTTPS API
  → 保存完整模型原文
  → 尽力投影统一字段
  → complete / partial / failed
```

没有 Agent，没有工具循环，没有会话记忆，也不需要长时间进程。

### 5.4 AI 清洗后的统一字段

建议至少覆盖：

```text
source_listing_id
input_hash
provider
model
prompt_version
status                    complete / partial / failed

original_title
cleaned_title_zh
work_title
series
characters[]
product_type              figure / plush / acrylic / apparel / book / disc / ...
edition_or_model
official_or_fanmade

normalized_condition
condition_details[]
missing_parts[]
defects[]
included_items[]

normalized_availability
price_value
price_status              valid / missing / placeholder / suspicious
reference_list_price

source_category
normalized_category
keywords[]

query_relevance           relevant / ambiguous / irrelevant
query_relevance_reason
confidence

cleaned_fields            jsonb
model_raw_output          jsonb/text
evidence                  jsonb
created_at
```

AI 字段是衍生数据，不能覆盖来源字段。更换模型或 prompt 后新增一个版本即可。

### 5.5 前端只读统一视图

前端不再写：

```ts
if (source === "yahoo_shopping") ...
if (title.includes("中古")) ...
if (rawMetadata.category) ...
```

前端读取一个统一 projection：

```text
cleaned_title
normalized_category
normalized_condition
normalized_availability
display_price
work_title
characters
cleaning_status
```

AI 尚未完成时，可以显示确定性基础字段并标注“等待整理”；完成后刷新为统一字段。商品详情页保留“查看来源原文”，方便核对。

## 6. 哪些限制应该删除，哪些必须保留

| 规则 | 处理意见 | 原因 |
|---|---|---|
| 长关键词截前三段/首尾段 | 删除 | 改变用户查询语义，已经产生实证错误。 |
| 入 PG 前按关键词相关性过滤 | 移到 AI 衍生字段 | 原始结果应先保存；相关与否是可重新计算的解释。 |
| 解析失败 item 完全丢弃 | 改为保存 unresolved raw item | 新解析器或 AI 可以重新处理历史数据。 |
| 适配器 condition/availability 直接作为前端真相 | 改为 raw + cleaned 并存 | 乐天、Yahoo、Amazon 已出现错误或不完整。 |
| 当前页最多 12 件才做 AI | 删除页面绑定 | 清洗对象应该是 PG 中所有新/变化记录。 |
| `condition === new` 跳过 AI | 删除 | 来源品相本身可能错误。 |
| AI 单字段不合格则整条丢弃 | 改为部分成功 | 保存原始模型输出，结构化字段允许 null。 |
| 前端按来源写兼容分支 | 逐步删除 | 来源差异应由统一数据层吸收。 |
| 来源域名 allowlist | 保留 | 防止错误 URL 和 SSRF。 |
| 超时、响应体大小限制 | 保留 | 属于传输安全，不是语义过滤。 |
| 原始内容哈希、幂等键 | 保留 | 避免重复保存和重复调用 AI。 |
| source ID、时间、请求上下文 | 保留 | 保证数据可追溯。 |
| raw 与 AI 衍生数据不可互相覆盖 | 保留 | 支持重新清洗、换模型和审计。 |

## 7. 与当前仓库规则的冲突

当前 `AGENTS.md` 写着：

```text
Scheduled collection and database ingestion must never invoke AI.
Market/analytics inference may run only after an explicit user action.
```

这条规则适用于“行情分析”，但会阻止“新商品入库后的自动 AI 清洗”。

如果本文方向确认，后续需要把规则拆成：

1. 定时采集永远先保存原始证据，不得等待 AI 才算采集成功；
2. 商品清洗可以由入库后的独立幂等队列自动触发；
3. 清洗失败不能影响原始数据入库，也不能删除旧清洗版本；
4. 行情分析报告仍然只能由用户手动触发；
5. 两类任务都直接调用模型 HTTPS API，不引入 Agent 或 AI Gateway。

本文没有修改 `AGENTS.md`，只记录这一冲突。

## 8. 后续实施顺序（本次不执行）

1. **补真正 raw capture**：先让新请求的完整响应进入 PG，停止继续丢失数据。
2. **对现有 930 条数据回填一次 AI 清洗**：虽然不是真正 raw response，但足够验证统一字段设计。
3. **建立版本化 cleaned projection**：原始字段、模型原文、统一字段分层保存。
4. **让搜索、商品库和关注详情统一读取 cleaned projection**：前端不再逐来源兼容。
5. **把相关性判断移出抓取入口**：来源返回什么先保存什么，再由 AI 标 `relevant / ambiguous / irrelevant`。
6. **最后删除旧的前端后置 Gemini 整理逻辑和重复适配条件**。

## 9. 需要先确认的产品边界

本文按以下理解整理，实施前需要以此为准：

- 商品数据清洗：入库后自动运行，失败可重试，非 Agent；
- 行情报告：继续手动点击运行；
- 原始来源结果：无论相关、无关、字段缺失，都先保留；
- AI 清洗结果：可重跑、可换模型、可产生多个版本；
- 前端默认展示最新成功清洗版本，同时允许查看原始字段；
- AI 不覆盖原始事实，程序也不因 AI 输出不完整而删除商品。

如果这些边界一致，下一步应该先设计 `raw capture + cleaned projection` 两层表，而不是继续在现有搜索组件里增加条件。
