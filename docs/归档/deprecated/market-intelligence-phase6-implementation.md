# 行情情报 Phase 6：高级模型就绪度与回测护栏实施契约

更新日期：2026-07-19
实施范围：scarcity / liquidity / seasonality / deal score / resale economics 的证据门槛、全库语料就绪度、影子回测状态和生产输出护栏。

## 1. 阶段结论

Phase 6 当前不能诚实地产出单一稀缺度、流动性、季节性、deal score 或预计转售价。

生产数据截至 2026-07-19 的只读审计结果为：

- `product_variants` 4 个，其中 3 个有当前 `decision='confirmed'` 的长期同款证据；
- 确认同款 listing 共 10 条；
- 商品级系统观察跨度约 7 天；
- `radar_analytics.sale_records` 为 0 条；
- 雪初音样例只有 3 条确认同款、1 个来源、2 个来源已售状态公开标价和 1 条当前报价；
- 艾米莉亚样例虽有 4 条来源已售状态 listing，但仍没有真实交易证明。

因此本阶段交付“高级模型是否具备发布条件”的可复查结论，而不是制造模型分数。只有数据门槛和独立回测均通过的后续模型版本，才允许新增生产标签或分数。

## 2. Current State Map

| 能力 | 当前实现 | 当前可复用事实 | 当前缺口 |
| --- | --- | --- | --- |
| 价格位置 | `variant-intelligence-v1` | 当前报价、同一比较桶公开标价、样本数、置信度 | 没有真实成交结局，不能证明某一价格是好交易 |
| 到手成本 | `landed-cost-v1` | 用户版本化费用假设和保守区间 | 当前生产尚无用户成本档案；不能替用户假设费用 |
| listing 生命周期 | `product-lifecycle-v1` | 不可变 observation、active 右删失、状态/价格变化 | 系统观察期过短；来源已售状态不是售出时间 |
| 重挂候选 | `relist-candidate-v1` | 同来源、同卖家、同图、相近标题的保守候选 | 没有人工确认的重挂标签集 |
| 真实成交 | Supabase `sale_records` | 表结构已明确只接受来源真实交易证明 | 当前 0 行；价格与 liquidity 均无 outcome label |
| 来源健康 | D1 / Supabase source health | 最新健康状态、SLA、异常空窗口 | 商品级来源覆盖仍少，不能推断完整市场供给 |
| 高级模型 | 不存在 | 上述确定性特征可以组成回放输入 | 没有门槛、语料摘要、回测批准版本或生产护栏 |

### 数据流

```text
source response / observation / sale_records
  -> confirmed variant membership
  -> price + lifecycle + landed-cost deterministic facts
  -> advanced readiness gates
  -> shadow/backtest eligibility
  -> [future, separate approval] versioned production model output
```

读取商品情报不得写入回测快照。历史回放应从不可变 observation 和 sale evidence 按截止时间重算，避免 GET 请求改变数据状态，也避免把未来状态泄漏进过去样本。

## 3. Gap Matrix

| Phase 6 项目 | 本阶段状态 | 原因 |
| --- | --- | --- |
| scarcity label | withheld | 出现次数、来源数、日期跨度和覆盖不足，且无批准回测版本 |
| liquidity estimate | withheld | 0 条 verified sale；active -> unavailable 不能替代成交 |
| seasonality | withheld | 未覆盖两个完整年度和足够活跃月份 |
| deal score | withheld | 缺真实 outcome、稳定历史价格和到手成本；价格位置不能冒充综合评分 |
| resale economics | withheld | 缺用户成本档案、退出平台费用假设和 verified resale reference |
| backtest corpus | readiness summary | 可统计语料规模和时间边界，但当前不足以训练或验收模型 |

## 4. Domain Dictionary

| 名称 | 定义 | 禁止替代 |
| --- | --- | --- |
| 高级情报就绪度 | 某项模型所需证据门槛的逐项通过情况 | 稀缺度、流动性或购买评分 |
| 影子就绪 | 单商品特征足够进入离线回放，但还没有通过生产回测批准 | 已上线模型 |
| 生产就绪 | 证据、全库语料、无泄漏回测和批准模型版本均通过 | 仅样本数达到阈值 |
| verified sale | `sale_records` 中带来源交易证明的记录 | `sold_out`、页面消失、离开搜索窗口 |
| observation span | 系统不可变 observation 的最早至最晚时间跨度 | 商品在市场存在的总年限 |
| source-date span | 有效来源发布时间的最早至最晚跨度 | 系统观察时长 |
| deal score | 经回测、版本化且能回到输入特征的综合模型输出 | 当前价相对公开标价中位数 |
| resale economics | 在用户明确的取得成本和退出费用假设下计算的区间 | 保证利润或预计成交价 |

## 5. Page Responsibility and Action Ownership

| Route | 主实体 | 用户问题 | 本阶段允许 | 本阶段禁止 |
| --- | --- | --- | --- | --- |
| `/intelligence/products/[variantId]` | 稳定商品 variant | 哪些高级结论目前有足够证据，缺什么 | 查看模型就绪度、门槛和全库语料边界 | 编辑模型权重、显示未回测分数、把 sold_out 当 outcome |
| `/watches/[id]` | 监控规则 | 什么事件值得通知 | 继续使用确定性事件 | 用未批准 deal score 触发通知 |
| `/analytics` | 关键词市场 | 市场 scope 的确定性变化 | 保持市场事实与 AI 解释 | 把具体 SKU 高级评分塞回泛关键词趋势 |

本阶段没有新的状态修改表单。高级情报页只读；成本配置仍由到手成本档案拥有，监控事件仍由 watch detail 拥有。

## 6. Readiness Policy v1

所有门槛都必须连同 observed / required / unit 返回。满足单商品门槛只表示 `shadow_ready`；没有批准回测版本时，`productionOutputAllowed` 仍为 `false`。

### 6.1 Scarcity

- 独立供给保守下界 >= 12；
- 有效来源日期 >= 12；
- 来源日期覆盖 >= 80%；
- source-date span >= 365 天；
- 独立来源 >= 2；
- 全库有确认样本 variant >= 50；
- 仍需独立回测批准。

### 6.2 Liquidity

- 本 variant verified sale >= 5；
- verified sale 中有价格 >= 5；
- 完成的系统 active interval >= 5；
- observation span >= 90 天；
- 全库 verified sale >= 100；
- 仍需处理右删失并通过独立回测。

系统 active -> unavailable 只能作为 observation interval，不能补足 verified sale 门槛。

### 6.3 Seasonality

- 有效来源日期 >= 24；
- source-date span >= 730 天；
- 至少 18 个不同东京月份有样本；
- 全库有确认样本 variant >= 50；
- 仍需滚动时间切分回测，禁止随机打散造成未来泄漏。

### 6.4 Deal Score

- 当前有有效报价；
- 同一比较桶历史样本 >= 6；
- 当前报价有到手成本区间；
- verified sale price >= 5；
- scarcity 与 liquidity 已有批准的生产模型；
- deal-score 自身通过校准与回测。

价格溢价百分比可以继续独立显示，但不能被改名为 deal score。

### 6.5 Resale Economics

- 当前报价有到手成本区间；
- 用户已明确退出平台费、卖方运费和其他退出成本；
- verified resale price reference >= 5；
- 输出必须是区间并明确用户假设；不生成“预计一定能卖”的文案。

本阶段尚不新增退出费用表单；缺少假设时诚实返回 withheld，避免再增加一组未经用户确认的默认费用。

## 7. API / Type Diff

`GET /api/intelligence/products/:variantId` 追加兼容字段：

```ts
type AdvancedIntelligenceReadiness = {
  metricVersion: "advanced-intelligence-readiness-v1";
  policyVersion: "advanced-model-gates-v1";
  asOf: string;
  productionPolicy: "withhold_until_versioned_backtest_approval";
  corpus: {
    confirmedVariantCount: number;
    confirmedListingCount: number;
    verifiedSaleCount: number;
    observationSpanDays: number;
  };
  evidence: {
    independentAppearanceMin: number;
    independentAppearanceMax: number;
    sourceCount: number;
    sourceDatedListingCount: number;
    sourceDateCoveragePercent: number;
    sourceDateSpanDays: number;
    sourceMonthCount: number;
    observationSpanDays: number;
    completedActiveDurationCount: number;
    rightCensoredActiveCount: number;
    verifiedSaleCount: number;
    verifiedSalePriceCount: number;
    comparablePriceSampleCount: number;
    landedCostOfferCount: number;
  };
  capabilities: Record<
    "scarcity" | "liquidity" | "seasonality" | "dealScore" | "resaleEconomics",
    {
      status: "insufficient_evidence" | "shadow_ready";
      productionOutputAllowed: false;
      reasons: string[];
      gates: Array<{ key: string; observed: number | boolean; required: number | boolean; unit: string; passed: boolean }>;
    }
  >;
};
```

现有字段不重命名、不删除。`verifiedSaleCount` 读取既有 `sale_records` 汇总，但当前仍为 0。

## 8. Migration and Storage Plan

- D1 追加 `0034_advanced_intelligence_readiness.sql`；只注册 `advanced_intelligence_readiness_v1` feature flag 和 policy 元数据。
- 不新增 Supabase 事实表。现有 observation、membership、source listing、source health 和 `sale_records` 已能组成可回放语料。
- 不在 GET 请求中持久化 feature snapshot。
- 不回填伪 outcome，不把历史 sold_out 写入 `sale_records`。
- 关闭 feature flag 后，API 保留兼容 envelope 但不计算/展示 readiness；价格、成本、生命周期和原始采集继续工作。
- 真正的模型输出、模型注册表和回测结果持久化必须作为后续独立追加迁移，不能通过修改 flag JSON 偷渡上线。

## 9. UI Component Plan

在商品情报页生命周期之后增加只读 `ADVANCED MODEL READINESS` 区块：

1. 首行说明“当前不发布稀缺度、流动性或 deal score”；
2. 显示全库 confirmed variant、verified sale 和 observation span；
3. 五个 capability 逐项显示 `证据不足` 或 `可进入影子回放`；
4. 每项只展示与当前缺口直接相关的 2–4 个门槛；
5. 不渲染仪表盘、星级、百分制、红绿购买信号或伪趋势图；
6. feature flag 关闭时整个区块不出现，避免半开启状态；
7. 0 / 1 / 足够 / 长历史都使用同一有界门槛列表，不产生无界 DOM。

## 10. Test Plan

- 雪初音：所有高级 capability 均 withheld；不得出现 scarcity label 或 deal score 数字。
- 艾米莉亚：4 条 sold_out 不能满足 liquidity 的 verified sale gate。
- 只有来源日期很多但系统仅观察数日：seasonality / liquidity 仍 withheld。
- 右删失 active listing 不计为 completed sale interval。
- verified sale 汇总只读取 `sale_records`，不从 availability 推断。
- 单商品门槛全通过但没有批准回测：只能 `shadow_ready`，`productionOutputAllowed=false`。
- Supabase corpus query 有明确 confirmed membership 边界且只返回聚合值。
- feature flag 关闭时不影响既有产品情报响应。
- API、TypeScript、React UI、Collector 集成和生产真实页面均验证无回归。

## 11. Rollout and Rollback

1. 默认开启 readiness 只读区块，因为它只减少过度推断，不触发事件或外部调用。
2. 不触发 AI，不新增定时任务，不改变采集频率。
3. 先在测试中固定 Snow Miku / Emilia 的 withheld 输出。
4. 部署后核验生产页没有任何“稀缺度高”“流动性低”“值得买分数”。
5. 如需回滚，只关闭 `advanced_intelligence_readiness_v1`；不删除证据和迁移。

## 12. Decision Log

| 决策 | 采用 | 放弃 | 原因 |
| --- | --- | --- | --- |
| 当前产品输出 | 就绪度与 withheld 原因 | 立即显示高级评分 | 当前 0 verified sale、约 7 天系统观察 |
| 数据来源 | 复用不可变 observation 与 `sale_records` | 把 sold_out 回填成 sale | 保持交易术语和证据边界 |
| 存储 | 无新 Supabase 事实表 | GET 时写 feature snapshot | 可从原始证据重算，避免副作用和重复数据 |
| 发布门槛 | 单商品 gates + 全库 corpus + 独立回测批准 | 只看样本数量 | 防止小样本过拟合与未来信息泄漏 |
| UI | 明确缺口的只读证据区 | 仪表盘/星级/百分制 | 页面必须回答“为何不能判断” |
| resale | 等待用户退出费用假设 | 写死平台费和物流费 | 不替用户创造经营参数 |
