# ADR-008：Web 层 API 风格选择（REST）

状态：已采纳

## 背景

KIVO Web 层需要为前端 SPA 提供数据接口。需要选择 API 风格：REST、GraphQL 或 tRPC。

Web 层的 API 特征：
- 数据模型相对固定（知识条目、冲突记录、调研任务、字典条目）。
- 查询模式可预测（列表+筛选+分页、详情+关联、聚合统计）。
- 写操作简单（状态变更、裁决提交、字典 CRUD）。
- 实时需求有限（活动流用 SSE 即可）。

## 决策

采用 HTTP REST + JSON 作为 Web 层 API 风格。

## 替代方案对比

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| GraphQL | 前端按需取字段，减少 over-fetching；单端点统一查询 | 引入 schema 定义和解析层，服务端复杂度增加；缓存策略比 REST 复杂（无法直接用 HTTP 缓存）；初期数据模型稳定，over-fetching 问题不突出 | 收益不足以覆盖复杂度成本，初期查询模式可预测，REST 端点足够覆盖 |
| tRPC | TypeScript 端到端类型安全，零 schema 维护 | 绑定 TypeScript 生态，前端框架选择受限；不适合未来可能的非 TS 客户端（移动端、第三方集成） | 违反通用优先原则，API 不应绑死特定语言生态 |

## 后果

- REST 端点按资源组织，路径语义清晰，前端可用任意 HTTP 客户端调用。
- 分页、筛选、排序通过 URL query params 标准化。
- 实时事件通过 SSE 补充，不需要 WebSocket 基础设施。
- 未来如需 GraphQL，可在 REST 之上加一层 GraphQL gateway，不影响已有端点。
