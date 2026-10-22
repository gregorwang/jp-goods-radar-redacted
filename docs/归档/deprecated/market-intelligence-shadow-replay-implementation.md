# 行情情报：PostgreSQL 影子回放实施契约

更新日期：2026-07-19
状态：实现中（Phase 6 之后的运行能力，不是新的产品评分阶段）

## 1. 目标与边界

影子回放用于回答：“如果只使用某个历史截止时间之前已进入系统的证据，当前版本的高级情报门槛会得到什么结果？”

- 原始 `listing_observations`、`source_response_captures`、membership 和 `sale_records` 继续作为权威证据。
- 回放只在 PostgreSQL 保存紧凑特征、门槛结果、版本和哈希，不复制 listing 标题、描述或来源 payload。
- `sold_out`、页面消失与离开可见窗口仍不等于 verified sale。
- 所有 capability 的 `production_output_allowed` 由数据库约束固定为 `false`；回放不能解锁生产评分。
- 用户成本档案仍属于 D1 中的版本化偏好。没有独立版本化的回测假设集时，deal score 和 resale economics 的成本门槛保持未满足。

## 2. 数据模型

| 表 | 粒度 | 内容 |
| --- | --- | --- |
| `advanced_shadow_replay_runs` | 截止时间 / policy / metric | 语料摘要、运行版本、哈希和结果计数 |
| `advanced_shadow_replay_variants` | run × product variant | 结构化、紧凑的确定性特征 |
| `advanced_shadow_replay_capabilities` | variant result × capability | `insufficient_evidence` / `shadow_ready`、失败原因与 gates |

三个表均为追加写入，开启 RLS；应用角色只有读取权限，写入只能通过受限的 `record_advanced_shadow_replay(jsonb)` 函数完成。

## 3. 无未来泄漏读取

每次运行固定 `asOf`，并执行以下边界：

- membership：`valid_from <= asOf < valid_to`；
- comparison profile：只选截止时间已创建且当时有效的版本；
- listing 状态与价格：只使用 `observed_at <= asOf` 的 observation / operational snapshot；
- listing 字段：优先使用截止时间前不可变 `listing_payload`；
- verified sale：同时要求 `sold_at <= asOf` 且 `recorded_at <= asOf`，避免后来补录的 outcome 泄漏；
- corpus 范围与 observation span：同样按截止时间重算；
- variant 枚举无样本数上限，不抽样。

## 4. 运行策略

- D1 flag：`advanced_shadow_replay_v1`；关闭后停止新增运行，不删除 PostgreSQL 历史。
- 自动运行：每日日本时间 03:07（UTC 18:07）。
- 手工/回填入口：受管理员会话和同源校验保护的 `GET/POST /api/analytics/shadow-replay`。
- 幂等键：runner version + metric version + policy version + 东京自然日。同一天重复请求读取既有结果。
- 当前数据不足时仍记录真实的 `insufficient_evidence`，不生成伪分数。

## 5. 旧行情报告清理

生产审计发现两份旧 `market-analysis:v4/v5` 报告在 evidence 中各自嵌入 678 条 listing 明细，单份 JSON 约 1.09MB。它们属于可再生成派生数据，已按精确 ID 删除。

原始 observation、capture、AI cleaning derivative 均未删除。当前 `market-analysis:v8` 只接收完整、未抽样的日度来源清洗汇总，不携带 listing 标题、描述或原始 payload。

## 6. 回滚

1. 关闭 D1 `advanced_shadow_replay_v1`，停止新增运行；
2. 回滚 Collector 代码，不影响既有商品情报读取；
3. 保留已写入的 PostgreSQL 回放记录用于审计；
4. 不删除或改写任何原始证据。
