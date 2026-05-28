# FR-P03 graphPending 重试 cron + graphAbandoned 状态机

OpenClaw（主会话）/ 2026-05-24

## 用户人群
KIVO 所有用户。

## 痛点
FR-P03 12 关系入图谱实装时，graphPending 失败兜底缺两个关键件：30min 重试 cron + 3 次重试转 graphAbandoned 状态机。LLM 临时失败 → 关系直接丢失，不会重试。这是 arc42 第 14 章决策 4「graphPending 兜底」的运行态承诺，但代码没真落。

实证（audit-01 P0-1 + P0-2）：审计 240 行报告核实 cron 不存在、状态机未实装。

## 原始需求
graphPending entries 必须有 30min cron 自动重试 LLM 关系判定，3 次失败后转 graphAbandoned 状态。

## 用户体验流
1. PDF 入库时 LLM 判定 12 关系失败 → entry 状态 graphPending
2. cron 每 30min 扫一次 graphPending entries，重新调 LLM 推断关系
3. 推断成功 → 写 graph_edges + 状态转 graphResolved
4. 推断失败 → retryCount++（最多 3 次），3 次后转 graphAbandoned
5. 用户在管理面板可看到 graphAbandoned 列表，可手动触发重试

## 功能需求

### FR-1 graphPending 重试 cron
30min cron 扫描 graphPending 状态的 entries，重跑 LLM 关系判定。

### AC
- AC1 新增 scripts/cron-retry-graph-pending.ts
- AC2 crontab 配置 `*/30 * * * *` 触发
- AC3 单次扫描批量处理 N 条（默认 50）
- AC4 LLM 调用失败不阻塞下一条
- AC5 cron 输出日志到 logs/cron-graph-pending.log

### FR-2 graphAbandoned 状态机
3 次重试失败后转 graphAbandoned 状态。

### AC
- AC1 entries.metadata_json 加 graphRetryCount + graphState 字段
- AC2 重试时 retryCount 从 metadata 读，每次 +1
- AC3 retryCount >= 3 → 转 graphAbandoned
- AC4 schema 兼容已有 entries（默认值处理）

### FR-3 管理界面（可选 follow-up）
graphAbandoned 列表 + 手动重试按钮（先不做，仅 spec 标注）

## 测试用例
1. graphPending entry → cron 重试成功 → graphResolved
2. graphPending entry → 3 次失败 → graphAbandoned
3. cron 批量处理 50 条 → 单条失败不影响其他
4. metadata 兼容性：旧 entries 无 retryCount → 默认 0
5. cron 跑空表 → 不报错
