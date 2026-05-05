# KIVO — arc42 架构文档

OpenClaw（sa-01 子Agent）| 2026-04-19

---

## 目录

1. Introduction and Goals
2. Architecture Constraints
3. System Scope and Context
4. Solution Strategy
5. Building Block View
6. Runtime View
7. Deployment View
8. Cross-cutting Concepts
9. Architecture Decisions
10. Quality Requirements
11. Risks and Technical Debt
12. Glossary

---

## 1. Introduction and Goals

### 1.1 系统目标

KIVO（Knowledge Iteration & Vibe Orchestration）是 Agent 知识平台，Self-Evolving Harness 的认知基础设施。核心使命：让 Agent 从被动接收知识变成主动获取、结构化存储、持续迭代知识。

系统解决三个根本问题：

1. 知识散落——Agent 的知识分布在对话、记忆文件、配置和临时笔记中，没有统一结构。
2. 知识静态——用户投喂什么 Agent 就知道什么，不投喂就是盲区。
3. 知识矛盾——新旧知识共存时没有显式冲突解决机制，导致 Agent 行为不一致。

### 1.2 关键质量需求

| 优先级 | 质量属性 | 目标 |
|--------|----------|------|
| 1 | 一致性 | 知识冲突解决率 100%，不允许矛盾共存 |
| 2 | 检索效能 | 知识检索命中率 ≥ 85%，P95 响应 ≤ 2s |
| 3 | 自主性 | 缺口检测覆盖率 ≥ 70%，调研闭环自动化 |
| 4 | 解耦性 | 核心逻辑与宿主环境解耦，存储/检索引擎可替换 |
| 5 | 可扩展性 | 知识类型、信息源、规则分发机制均可扩展 |

### 1.3 利益相关者

| 角色 | 关注点 |
|------|--------|
| Solo Founder / 独立产品操盘者 | Agent 记住历史决策和经验，自主调研行业动态 |
| Agent 开发者 | 统一知识管理接口，跨 Agent 知识共享不污染 |
| 系统管理员 | 知识库健康状态可观测，访问控制可管理 |
| SEVO（研发流水线） | 消费 KIVO 的知识支撑 Spec 编写和 Review |
| AEO（效果度量） | 效果漂移时触发 KIVO 缺口检测排查知识缺失 |
| 宿主环境 | 提供运行时、工具能力，调用 KIVO 接口 |

---

## 2. Architecture Constraints

### 2.1 技术约束

| 约束 | 原因 |
|------|------|
| 存储格式和检索接口与具体向量数据库解耦 | 宿主环境差异大，不能绑定特定数据库 |
| 知识提取异步执行，不阻塞 Agent 主任务 | NFR-4.2，提取是 IO 密集操作 |
| 规则分发采用拉取优先、推送补充策略 | 降低分发基础设施复杂度，Agent 启动时自行拉取 |
| 调研任务由 KIVO 定义、宿主执行 | KIVO 不直接持有网络访问和工具能力 |
| 知识条目写入必须经过冲突检测，无绕过路径 | NFR-4.5，一致性是第一优先级 |

### 2.2 组织约束

| 约束 | 原因 |
|------|------|
| 知识库规模初期控制在万级条目 | 初期验证阶段，避免过早优化 |
| KIVO 不替代 SEVO 做流程编排 | Self-Evolving Harness 模块职责分离 |
| KIVO 不替代 AEO 做效果度量 | 同上 |
| 核心逻辑不写死对 OpenClaw 的依赖 | 通用知识管理语义，宿主做运行时适配 |

### 2.3 惯例

- 知识先结构化再存储，不存原始文本堆。
- 所有知识条目必须有来源引用，支持溯源。
- 冲突必须显式解决，不允许新旧矛盾共存。
- 六类知识类型：fact、methodology、decision、experience、intent、meta。

---

## 3. System Scope and Context

### 3.1 业务上下文

```
┌─────────────────────────────────────────────────────┐
│                    宿主环境                           │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │  Agent A  │    │  Agent B  │    │  Agent C  │      │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘      │
│       │               │               │             │
│       └───────────────┼───────────────┘             │
│                       │                             │
│              ┌────────▼────────┐                    │
│              │      KIVO       │                    │
│              │   知识平台      │                    │
│              └────────┬────────┘                    │
│                       │                             │
│       ┌───────────────┼───────────────┐             │
│       │               │               │             │
│  ┌────▼─────┐    ┌────▼─────┐    ┌────▼─────┐      │
│  │   SEVO   │    │   AEO    │    │ Claw     │      │
│  │ 研发流水线 │    │ 效果度量  │    │ Design   │      │
│  └──────────┘    └──────────┘    └──────────┘      │
└─────────────────────────────────────────────────────┘

外部信息源：Web Search / 文档 / 论文 / 规则文件
```

业务交互：

- Agent → KIVO：知识检索请求、对话记录（供提取）、规则查询。
- KIVO → Agent：检索结果（含上下文注入）、规则推送、消歧建议。
- KIVO → 宿主：调研任务定义（宿主负责执行并返回结果）。
- SEVO → KIVO：查询历史规格、方法论、经验。
- AEO → KIVO：触发缺口检测（效果漂移时排查知识缺失）。

### 3.2 技术上下文

```
┌─────────────────────────────────────────────────┐
│                   KIVO 系统边界                    │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │           KIVO Core API                 │    │
│  │  (知识提取/存储/检索/冲突/调研/分发)      │    │
│  └──────────────┬──────────────────────────┘    │
│                 │                               │
│  ┌──────────────▼──────────────────────────┐    │
│  │         Storage Abstraction Layer       │    │
│  │  (知识条目 CRUD / 版本 / 关联 / 索引)     │    │
│  └──────────────┬──────────────────────────┘    │
│                 │                               │
│  ┌──────────────▼──────────────────────────┐    │
│  │         Storage Backend (可替换)         │    │
│  │  本地文件 / SQLite / 向量DB / ...        │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘

外部接口：
  ← Agent Runtime API（检索/注入/规则查询）
  ← Extraction Trigger（对话记录/文档/规则文件输入）
  → Research Task Output（调研任务定义，宿主执行）
  → Rule Distribution（规则推送/拉取）
```

### 3.3 Web 层业务上下文

```
┌─────────────────────────────────────────────────────────────┐
│                      Web 层                                 │
│                                                             │
│  ┌──────────┐                                               │
│  │  用户     │  浏览器（桌面 1280px+）                        │
│  │ (产品负责人│                                               │
│  │  / 老板)  │                                               │
│  └────┬─────┘                                               │
│       │ HTTP                                                │
│  ┌────▼──────────────────────────────────────────────────┐  │
│  │              KIVO Web Frontend                        │  │
│  │  仪表盘 │ 知识列表 │ 搜索 │ 活动流 │ 调研 │ 字典      │  │
│  └────┬──────────────────────────────────────────────────┘  │
│       │ REST API                                            │
│  ┌────▼──────────────────────────────────────────────────┐  │
│  │              KIVO Web API Layer                       │  │
│  │  聚合查询 │ 用户操作 │ 事件流 │ 字典 CRUD             │  │
│  └────┬──────────────────────────────────────────────────┘  │
│       │ 内部调用                                            │
│  ┌────▼──────────────────────────────────────────────────┐  │
│  │              KIVO Core（引擎层）                       │  │
│  │  知识存储 │ 语义检索 │ 冲突检测 │ 调研 │ 规则分发      │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

业务交互（Web 层新增）：

- 用户 → Web Frontend：浏览知识库、搜索、查看详情、裁决冲突、触发调研、管理字典。
- Web Frontend → Web API Layer：REST 请求（查询、操作、事件订阅）。
- Web API Layer → KIVO Core：复用引擎已有接口（Knowledge Query API、Extraction Input、Research Task 等），不重复实现业务逻辑。
- Web API Layer → 用户：界面内通知（调研完成、冲突待裁决等）。

### 3.4 Web 层技术上下文

```
┌─────────────────────────────────────────────────────────────┐
│                   Web 层系统边界                              │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           KIVO Web Frontend (SPA)                   │    │
│  │  React + Next.js App Router（ADR-009）               │    │
│  │  页面：Dashboard / List / Search / Detail /          │    │
│  │        Activity / Conflicts / Research / Glossary   │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │ HTTP REST (JSON)                      │
│  ┌──────────────────▼──────────────────────────────────┐    │
│  │           KIVO Web API Layer                        │    │
│  │  /api/v1/knowledge/**   (查询/筛选/详情)             │    │
│  │  /api/v1/search/**      (语义搜索)                   │    │
│  │  /api/v1/activity/**    (活动流)                     │    │
│  │  /api/v1/conflicts/**   (冲突裁决)                   │    │
│  │  /api/v1/research/**    (调研任务)                   │    │
│  │  /api/v1/glossary/**    (系统字典)                   │    │
│  │  /api/v1/dashboard/**   (仪表盘聚合)                 │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │ 内部函数调用                           │
│  ┌──────────────────▼──────────────────────────────────┐    │
│  │           KIVO Core API（引擎层，已有）               │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

Web 层技术接口清单：

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| Dashboard API | 入 | HTTP REST | 仪表盘聚合数据（FR-G01） |
| Knowledge List API | 入 | HTTP REST | 知识条目列表/筛选/分页（FR-G02） |
| Search API | 入 | HTTP REST | 语义搜索（FR-G03），代理到引擎 Knowledge Query API |
| Knowledge Detail API | 入 | HTTP REST | 条目详情+关联+版本历史（FR-G04） |
| Activity Feed API | 入 | HTTP REST / SSE | 活动流事件（FR-H01） |
| Conflict Resolution API | 入 | HTTP REST | 冲突裁决操作（FR-H02） |
| Pending Review API | 入 | HTTP REST | 待确认条目审核（FR-H02, FR-J02） |
| Research Queue API | 入 | HTTP REST | 调研队列查看/创建/管理（FR-I01, FR-J01, FR-J03） |
| Gap Report API | 入 | HTTP REST | 缺口报告查看（FR-I02） |
| Knowledge Action API | 入 | HTTP REST | 知识标记/编辑操作（FR-J02） |
| Glossary CRUD API | 入 | HTTP REST | 系统字典增删改查（FR-L01） |

引擎层技术接口清单（已有，保持不变）：

技术接口清单：

| 接口 | 方向 | 协议 | 说明 |
|------|------|------|------|
| Knowledge Query API | 入 | 函数调用 / HTTP | Agent 检索知识 |
| Context Injection API | 入 | 函数调用 | Agent 请求上下文注入 |
| Extraction Input | 入 | 事件 / 函数调用 | 对话记录、文档、规则文件输入 |
| Rule Query API | 入 | 函数调用 / HTTP | Agent 查询/订阅规则 |
| Research Task Output | 出 | 事件 | 调研任务定义输出给宿主 |
| Rule Push | 出 | 事件 / Webhook | 高优先级规则变更通知 |
| Storage Backend SPI | 内 | 接口抽象 | 存储层可替换实现 |

核心接口契约：

```typescript
// Knowledge Query API
interface KnowledgeQueryRequest {
  query: string;                          // 语义查询文本
  filters?: {
    types?: KnowledgeType[];              // 按知识类型过滤
    domain?: string;                      // 按域过滤
    timeRange?: { from?: Date; to?: Date };
    sources?: string[];                   // 按来源过滤
  };
  topK?: number;                          // 返回条数，默认 10
  minScore?: number;                      // 最低相关度阈值，默认 0.6
  callerRole: string;                     // 调用方角色，用于访问控制
}

interface KnowledgeQueryResponse {
  results: Array<{
    entry: KnowledgeEntry;
    score: number;                        // 语义相关度评分 0-1
    summary: string;                      // 内容摘要
    sourceRef: SourceReference;
  }>;
  totalMatches: number;
  degraded: boolean;                      // 是否降级返回（如 Embedding 不可用时回退元数据过滤）
}

// Context Injection API
interface ContextInjectionRequest {
  userQuery: string;                      // 用户原始请求
  tokenBudget: number;                    // 注入内容的 token 上限
  callerRole: string;
  preferredTypes?: KnowledgeType[];       // 优先注入的知识类型
}

interface ContextInjectionResponse {
  injectedContext: string;                // 拼装后的知识摘要文本
  entries: Array<{                        // 注入涉及的条目明细
    entryId: string;
    type: KnowledgeType;
    summary: string;
    sourceRef: SourceReference;
  }>;
  tokensUsed: number;                     // 实际使用的 token 数
  truncated: boolean;                     // 是否因预算裁剪了结果
}

// Extraction Input
interface ExtractionInput {
  source: 'dialog' | 'document' | 'rule_file';
  idempotencyKey: string;                 // 幂等键，相同 key 重复提交跳过提取
  payload: DialogPayload | DocumentPayload | RuleFilePayload;
}

interface DialogPayload {
  sessionId: string;
  messages: Array<{ role: string; content: string; timestamp: Date }>;
}

interface DocumentPayload {
  path: string;                           // 文档路径或 URL
  format: 'markdown' | 'html' | 'text';
  content: string;
}

interface RuleFilePayload {
  path: string;
  content: string;
}

// Extraction Output (内部事件)
interface ExtractionResult {
  idempotencyKey: string;
  entries: KnowledgeEntry[];              // 提取出的知识条目
  skipped: boolean;                       // 幂等键命中时为 true
}
```

---

## 4. Solution Strategy

### 4.1 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 知识管线架构 | 管道-过滤器（Pipeline-Filter） | 提取→冲突检测→合并→入库，每步独立可测试可替换 |
| 存储抽象 | Repository 模式 + SPI | 上层逻辑不感知具体存储引擎，初期用本地文件/SQLite，后续可换向量 DB |
| 冲突检测策略 | 写入前置拦截，零绕过 | 一致性是第一优先级，所有写入路径必须经过冲突检测 |
| 检索策略 | 语义检索 + 元数据过滤 | 语义相似度为主，知识类型/时间/来源为辅助过滤维度 |
| 规则分发 | 拉取优先 + 事件补充 | Agent 启动时拉取全量规则，变更时事件通知增量更新 |
| 调研执行 | 任务定义与执行分离 | KIVO 定义调研任务（目标/范围/策略/预算），宿主环境负责执行 |
| 知识类型体系 | 固定六类 + 扩展机制 | fact/methodology/decision/experience/intent/meta 覆盖核心场景，新类型通过注册扩展 |
| 异步提取 | 事件驱动 + 队列 | 提取不阻塞 Agent 主任务，通过事件触发异步处理 |

### 4.2 技术选型方向

| 层次 | 选型方向 | 说明 |
|------|----------|------|
| 语言 | TypeScript | 静态类型系统保障大规模重构安全性，async/await 原生支持 IO 密集的提取和检索管线，npm 生态覆盖 Embedding、SQLite、JSON Schema 等核心依赖，宿主适配层可选其他语言 |
| 存储 | SQLite（单一真相源）+ JSON 导出视图 | 万级条目规模足够，SQLite 事务保证原子性，JSON 仅作调试/审查用途 |
| 语义检索 | Embedding API（宿主提供）+ 余弦相似度 | 检索引擎通过 SPI 抽象，不绑定特定 Embedding 模型 |
| 事件机制 | EventEmitter / 简单消息队列 | 初期单进程内事件，后续可升级为跨进程消息 |
| 接口协议 | TypeScript 函数调用 | 初期同进程调用，预留 HTTP API 扩展点 |

---

## 5. Building Block View

### 5.1 Level 1：系统分解

```
┌─────────────────────────────────────────────────────────────┐
│                         KIVO Core                           │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Extraction  │  │  Knowledge  │  │     Iteration       │ │
│  │   Engine     │  │   Store     │  │     Engine          │ │
│  │   (域 A)     │  │   (域 B)    │  │     (域 C)          │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                     │            │
│  ┌──────▼──────────────────────────────────────▼──────────┐ │
│  │              Knowledge Pipeline Bus                    │ │
│  │        (事件总线：提取→检测→解决→入库)                    │ │
│  └──────┬──────────────────────────────────────┬──────────┘ │
│         │                                      │            │
│  ┌──────▼──────┐  ┌─────────────┐  ┌──────────▼──────────┐ │
│  │  Research   │  │   Intent    │  │  Rule               │ │
│  │  Planner    │  │  Enhancer   │  │  Distributor        │ │
│  │  (域 D)     │  │  (域 E)     │  │  (域 F)             │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           Storage Abstraction Layer (SPI)               ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 5.2 模块职责

#### Extraction Engine（域 A）

职责：从各类来源提取结构化知识条目。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| DialogExtractor | 从 Agent 对话中提取六类知识 | FR-A01 |
| DocumentExtractor | 从 Markdown/PDF/网页提取知识 | FR-A02 |
| RuleExtractor | 从治理文件提取可分发规则 | FR-A03 |

输入：原始对话记录、文档内容、规则文件。
输出：结构化 Knowledge Entry（含类型、内容、来源、置信度）。
约束：提取异步执行，不阻塞 Agent 主任务。低置信度结果标记 pending。

#### Knowledge Store（域 B）

职责：知识的持久化存储、版本管理、语义检索和关联维护。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| EntryRepository | 知识条目 CRUD、版本追踪、状态管理 | FR-B01 |
| SemanticIndex | 语义向量索引、相似度检索 | FR-B02 |
| RelationGraph | 知识关联关系维护（supplements/supersedes/conflicts/depends_on） | FR-B03（完整实现，初期先支持 conflicts + supersedes） |

输入：经过冲突检测的 Knowledge Entry。
输出：检索结果（含相关度评分）、关联图谱。
约束：所有写入必须经过 Iteration Engine 的冲突检测，EntryRepository 不接受直接写入。

#### Iteration Engine（域 C）

职责：知识更新的一致性守门人——冲突检测、冲突解决、过期清理、知识合并。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| ConflictDetector | 语义冲突和规则冲突检测 | FR-C01 |
| ConflictResolver | 冲突解决策略执行（时间优先/来源优先/人工裁决） | FR-C01 |
| ExpiryScanner | 过时知识识别和清理 | FR-C02 |
| MergeEngine | 同主题互补知识合并 | FR-C03 |

输入：待入库的 Knowledge Entry + 已有知识库。
输出：冲突记录、解决结论、合并结果。
约束：冲突检测覆盖所有写入路径，零绕过。冲突解决过程和结论必须记录。

#### Research Planner（域 D）

职责：发现知识缺口，生成调研任务定义。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| GapDetector | 基于查询未命中和关联缺失识别盲区 | FR-D01 |
| TaskGenerator | 生成结构化调研任务（目标/范围/策略/预算） | FR-D02 |
| PriorityScheduler | 调研优先级排序和执行节奏控制 | FR-D03 |

输入：查询未命中记录、知识关联结构缺失。
输出：Research Task 定义（交给宿主执行）。
约束：调研不抢占用户主动任务资源，有预算上限。

#### Intent Enhancer（域 E）

职责：利用知识库提升 Agent 对用户意图的理解。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| ContextInjector | 按 token 预算注入相关知识 | FR-E01 |
| Disambiguator | 基于历史知识消解意图歧义 | FR-E02 |

输入：Agent 的用户请求 + token 预算。
输出：增强后的上下文（知识摘要 + 来源标注）、消歧建议。
约束：注入不改变用户原始请求，对用户透明。

#### Rule Distributor（域 F）

职责：规则的注册、订阅管理和按需分发。

| 子模块 | 职责 | 对应 FR |
|--------|------|---------|
| RuleRegistry | 规则条目注册、版本管理、优先级管理 | FR-F01 |
| SubscriptionManager | Agent 订阅关系维护 | FR-F02 |
| PushEngine | 规则变更推送和分发确认 | FR-F03 |

输入：规则变更事件、Agent 订阅请求。
输出：规则推送、分发记录。
约束：拉取优先，推送补充。分发失败自动重试。

#### Knowledge Pipeline Bus

职责：连接各域模块的事件总线，驱动知识管线流转。

核心事件链：

- 提取完成事件 → 触发冲突检测。
- 冲突解决完成事件 → 触发入库。
- 查询未命中事件 → 累积供缺口检测分析。

扩展事件链：

- 冲突解决完成事件 → 触发合并检测（MergeEngine）。无冲突的同主题条目由 MergeEngine 判定是否语义互补可合并，合并完成后再触发入库。
- 入库完成事件 → 触发缺口检测（GapDetector）。

#### Storage Abstraction Layer（SPI）

职责：屏蔽底层存储差异，提供统一的知识条目持久化接口。

初期实现：本地 JSON 文件 + SQLite 元数据索引。

一致性策略：SQLite 为单一真相源。知识条目的元数据、状态、索引和内容引用全部先落 SQLite，在同一事务内完成。JSON 文件作为可重建的导出视图，用于调试和人工审查，不作为主存储。写入流程：开启 SQLite 事务 → 写入条目元数据 + 内容 + 冲突记录 → 更新 FTS 索引 → 提交事务 → 异步写出 JSON 导出文件。事务失败时自动回滚，JSON 导出失败不影响数据一致性。
扩展方向：向量数据库（Chroma/Qdrant/Milvus）、PostgreSQL + pgvector。

SPI 接口：

- `save(entry: KnowledgeEntry): Promise<void>`
- `findById(id: string): Promise<KnowledgeEntry | null>`
- `search(query: SemanticQuery): Promise<SearchResult[]>`
- `updateStatus(id: string, status: EntryStatus): Promise<void>`
- `getVersionHistory(id: string): Promise<KnowledgeEntry[]>`

### 5.3 Web 层模块分解

Web 层是 KIVO Core 的用户可见层，不包含业务逻辑，只做聚合查询、用户操作代理和展示。

#### 5.3.1 Web API Layer

职责：为前端提供 HTTP REST 接口，将用户请求转译为 KIVO Core API 调用。

| 端点组 | 方法 | 路径 | 对应 UFR | 说明 |
|--------|------|------|---------|------|
| Dashboard | GET | /api/v1/dashboard/summary | FR-G01 | 知识库总览聚合（类型分布、状态分布、趋势、健康指标） |
| Knowledge | GET | /api/v1/knowledge | FR-G02 | 知识条目列表，支持 ?type=&status=&source=&from=&to=&sort=&page=&pageSize= |
| Knowledge | GET | /api/v1/knowledge/:id | FR-G04 | 条目详情（含关联、版本历史） |
| Knowledge | PATCH | /api/v1/knowledge/:id/status | FR-J02 | 标记过时 / 确认 / 拒绝 |
| Knowledge | PUT | /api/v1/knowledge/:id/content | FR-J02 AC3 | 编辑摘要（生成新版本，新版本必须经过 ConflictDetector 冲突检测，与新增知识走同一条检测管线） |
| Search | GET | /api/v1/search?q=&type=&status= | FR-G03 | 语义搜索，代理到引擎 Knowledge Query API |
| Activity | GET | /api/v1/activity?type=&page= | FR-H01 | 活动流事件列表 |
| Activity | GET | /api/v1/activity/stream | FR-H01 | SSE 实时事件推送 |
| Conflicts | GET | /api/v1/conflicts?status=pending | FR-H02 | 待裁决冲突列表 |
| Conflicts | POST | /api/v1/conflicts/:id/resolve | FR-H02 AC2 | 提交裁决结果 |
| Research | GET | /api/v1/research/tasks | FR-I01 | 调研任务列表 |
| Research | POST | /api/v1/research/tasks | FR-J01 | 手动创建调研任务 |
| Research | PATCH | /api/v1/research/tasks/:id | FR-J03 | 取消/调整优先级 |
| Research | PUT | /api/v1/research/auto | FR-J03 AC3 | 全局自动调研开关 |
| Research | GET | /api/v1/research/gaps | FR-I02 | 缺口报告列表 |
| Glossary | GET | /api/v1/glossary | FR-L01 AC1 | 字典列表，支持 ?q=&scope= |
| Glossary | POST | /api/v1/glossary | FR-L01 AC2 | 新增术语 |
| Glossary | PUT | /api/v1/glossary/:id | FR-L01 AC3 | 编辑术语 |
| Glossary | DELETE | /api/v1/glossary/:id | FR-L01 AC3 | 删除术语 |

API 设计原则：
- 统一响应格式：`{ data, meta: { total, page, pageSize }, error }`
- 分页默认 pageSize=20，最大 100
- 错误码采用 HTTP 标准状态码 + 业务错误码（`error.code`）
- 所有写操作返回更新后的完整对象（乐观更新支撑）

#### 5.3.2 Web Frontend Components

前端为 SPA，按页面拆分组件，每个页面对应一个或多个 UFR。

| 页面/组件 | 对应 UFR | 核心功能 |
|------------|---------|----------|
| DashboardPage | FR-G01 | 知识类型分布图、状态分布、趋势图、健康指标卡片 |
| KnowledgeListPage | FR-G02 | 条目列表 + 筛选栏 + 排序 + 分页 |
| SearchPage | FR-G03 | 搜索框 + 结果列表（高亮片段、相关度分）+ 二次筛选 |
| KnowledgeDetailPage | FR-G04 | 完整内容 + 关联图 + 版本时间线 + 来源引用 |
| ActivityFeedPage | FR-H01 | 时间线事件列表 + 类型筛选 + SSE 实时更新 |
| ConflictResolutionPage | FR-H02 | 冲突双方对比视图 + 裁决按钮 + pending 条目审核 |
| ResearchQueuePage | FR-I01, FR-J01, FR-J03 | 调研任务列表 + 创建表单 + 优先级调整 + 全局开关 |
| GapReportPage | FR-I02 | 缺口报告列表 + 影响面指标 + 填补进度 |
| GlossaryPage | FR-L01 | 术语列表 + 搜索 + 新增/编辑/删除表单 |
| AppShell | 全局 | 导航栏 + 通知中心 + 全局搜索入口 |

前端状态管理：
- 服务端状态（知识条目、调研任务等）通过 API 请求获取，不在前端缓存业务数据。
- UI 状态（筛选条件、分页位置、展开/折叠）用组件局部状态或 URL query params。
- 乐观更新：写操作先更新 UI，后台 API 失败时回滚并提示。

#### 5.3.3 Web 层数据模型

Web 层不维护独立的业务数据存储。所有知识条目、冲突记录、调研任务的数据来自引擎层 Knowledge Store。

Web 层新增的数据实体：

```typescript
// 系统字典条目（FR-L01，Web 层独有）
interface GlossaryEntry {
  id: string;
  term: string;              // 术语名称（必填）
  definition: string;        // 定义说明（必填）
  aliases?: string[];        // 别名/同义词
  scope?: string;            // 适用范围
  createdAt: Date;
  updatedAt: Date;
}

// 仪表盘聚合数据（API 层计算，不持久化）
interface DashboardSummary {
  totalEntries: number;
  byType: Record<KnowledgeType, number>;
  byStatus: Record<EntryStatus, number>;
  trend7d: { date: string; added: number; updated: number; deprecated: number }[];
  health: {
    pendingCount: number;
    unresolvedConflicts: number;
    expiredPending: number;
  };
}
```

与引擎层 Knowledge Store 的关系：
- Web API Layer 通过引擎的 `EntryRepository`、`SemanticIndex`、`ConflictDetector` 等接口读写数据。
- GlossaryEntry 存储在引擎层同一 SQLite 实例中（单独的 glossary 表），通过 Storage Abstraction Layer 访问。
- DashboardSummary 是实时聚合计算结果，不持久化。

#### 5.3.4 Web 层交付边界

核心交付：

| 组件/接口 | 说明 |
|------------|------|
| DashboardPage + GET /dashboard/summary | 知识库总览 |
| KnowledgeListPage + GET /knowledge | 条目列表、筛选、分页 |
| SearchPage + GET /search | 语义搜索 |
| KnowledgeDetailPage + GET /knowledge/:id | 条目详情、关联、版本历史 |
| ConflictResolutionPage + GET/POST /conflicts | 冲突列表与裁决 |
| PATCH /knowledge/:id/status | 标记过时/确认/拒绝 |
| PUT /knowledge/:id/content | 编辑摘要 |
| AppShell（导航 + 全局搜索入口） | 全局布局 |

后续扩展：

| 组件/接口 | 说明 |
|------------|------|
| ActivityFeedPage + GET /activity/stream (SSE) | 实时活动流推送 |
| ResearchQueuePage + 调研任务 CRUD | 调研任务管理 |
| GapReportPage + GET /research/gaps | 缺口报告 |
| GlossaryPage + Glossary CRUD | 系统字典管理 |
| 通知中心 | 站内消息推送 |

划分原则：初期覆盖知识浏览、搜索、冲突裁决这三条核心用户路径，其余功能随引擎层后续迭代同步激活。

### 5.4 Skill 接口定义

KIVO 对外暴露以下独立 Skill，每个 Skill 对应一个用户意图。宿主环境通过 Skill 名称路由用户请求到对应能力。

#### 内置 Skill

| Skill 名称 | 职责 | 触发条件 | 核心模块/入口 |
|------------|------|----------|---------------|
| KnowledgeIngestSkill | 从对话或文档中提取并存储结构化知识 | 用户说"记住这个""把这段话存下来""从这篇文档提取知识""学习这个文件" | `src/extraction/` → `src/pipeline/engine.ts` → `src/conflict/` → `src/repository/` |
| KnowledgeQuerySkill | 检索知识库并返回相关知识条目 | 用户说"你知道关于 X 的什么""查一下之前的决策""有没有相关经验""搜索知识库" | `src/search/semantic-search.ts` → `src/repository/knowledge-repository.ts` |
| ContextInjectSkill | 为当前任务自动注入相关知识上下文 | Agent 处理用户请求时自动触发（非用户直接调用），或用户说"带上相关背景""结合之前的知识回答" | `src/injection/context-injector.ts` → `src/injection/injection-policy.ts` |
| ConflictResolveSkill | 处理知识冲突的人工裁决请求 | 用户说"这两条知识矛盾了，用新的""保留旧的""帮我决定哪个对" | `src/conflict/conflict-resolver.ts` → `src/conflict/conflict-record.ts` |

#### 扩展 Skill

| Skill 名称 | 职责 | 触发条件 | 核心模块/入口 |
|------------|------|----------|---------------|
| ResearchSkill | 基于知识缺口生成并管理调研任务 | 用户说"调研一下 X 领域""补充关于 Y 的知识""知识库缺什么" | Research Planner（域 D）：GapDetector → TaskGenerator → PriorityScheduler |
| RuleDistributeSkill | 管理系统规则的注册、订阅和分发 | 用户说"更新规则""给 Agent A 推送新规则""查看当前订阅的规则" | Rule Distributor（域 F）：RuleRegistry → SubscriptionManager → PushEngine |
| KnowledgeHealthSkill | 报告知识库健康状态（过期、冲突、盲区统计） | 用户说"知识库状态怎么样""有多少过期知识""健康报告" | ExpiryScanner + GapDetector + EntryRepository 聚合查询 |

#### Skill 间依赖关系

```
KnowledgeIngestSkill ──→ ConflictResolveSkill（入库时检测到冲突，触发裁决）
KnowledgeQuerySkill ──→ ContextInjectSkill（检索结果可直接用于上下文注入）
ResearchSkill ──→ KnowledgeIngestSkill（调研结果回流入库）
RuleDistributeSkill ──→ KnowledgeIngestSkill（规则提取复用提取管线）
KnowledgeHealthSkill ──→ ResearchSkill（发现盲区后可触发调研）
```

#### Skill 路由契约

每个 Skill 通过声明式契约注册能力，宿主的 SkillRouter 基于用户意图匹配对应 Skill：

```yaml
# 示例：KnowledgeIngestSkill 契约
name: knowledge-ingest
description: 从对话或文档中提取并存储结构化知识
triggers:
  - "记住|存下来|提取知识|学习这个|保存到知识库"
  - "ingest|extract knowledge|remember this"
input: ExtractionInput（对话记录或文档内容）
output: ExtractionResult（提取的知识条目列表）
```

---

## 6. Runtime View

### 6.1 场景一：对话知识提取与入库

```
Agent          Extraction     Pipeline    Iteration    Knowledge
Runtime        Engine         Bus         Engine       Store
  │                │              │            │            │
  │ 对话记录        │              │            │            │
  ├───────────────►│              │            │            │
  │                │ 提取知识条目   │            │            │
  │                │──────────────►│            │            │
  │                │              │ 冲突检测    │            │
  │                │              │───────────►│            │
  │                │              │            │ 查询已有知识 │
  │                │              │            │───────────►│
  │                │              │            │◄───────────│
  │                │              │            │            │
  │                │              │  ┌─────────┤            │
  │                │              │  │无冲突    │            │
  │                │              │  └─────────┤            │
  │                │              │            │ 写入知识条目 │
  │                │              │            │───────────►│
  │                │              │            │◄───────────│
  │                │              │ 入库完成    │            │
  │                │              │◄───────────│            │
  │                │              │            │            │
  │                │              │  ┌─────────┤            │
  │                │              │  │有冲突    │            │
  │                │              │  └─────────┤            │
  │                │              │            │ 执行解决策略 │
  │                │              │            │──┐         │
  │                │              │            │◄─┘         │
  │                │              │            │ 记录冲突结论 │
  │                │              │            │───────────►│
  │                │              │            │ 更新/替代   │
  │                │              │            │───────────►│
  │                │              │◄───────────│            │
```

关键约束：
- 提取异步执行，不阻塞 Agent 主任务。
- 冲突检测是写入前置拦截，所有路径必须经过。
- 冲突解决结论（Conflict Record）与知识条目一起持久化。

### 6.2 场景二：Agent 知识检索与上下文注入

```
Agent          Intent         Knowledge     Storage
Runtime        Enhancer       Store         Backend
  │                │              │            │
  │ 用户请求        │              │            │
  │ + token 预算    │              │            │
  ├───────────────►│              │            │
  │                │ 语义检索      │            │
  │                │─────────────►│            │
  │                │              │ 向量检索    │
  │                │              │───────────►│
  │                │              │◄───────────│
  │                │              │ 元数据过滤   │
  │                │              │──┐         │
  │                │              │◄─┘         │
  │                │◄─────────────│            │
  │                │ 按 token 预算 │            │
  │                │ 裁剪注入内容   │            │
  │                │──┐           │            │
  │                │◄─┘           │            │
  │ 增强上下文      │              │            │
  │ (知识摘要+来源) │              │            │
  │◄───────────────│              │            │
  │                │              │            │
  │ 继续处理用户请求 │              │            │
  │──┐             │              │            │
  │◄─┘             │              │            │
```

关键约束：
- 检索 P95 响应 ≤ 2s。
- 注入内容不超过调用方指定的 token 预算。
- 注入对用户透明，不改变原始请求。

### 6.3 场景三：知识冲突的人工裁决路径

```
Agent          Iteration      Knowledge     用户/
Runtime        Engine         Store         管理员
  │                │              │            │
  │ (提取触发)      │              │            │
  │───────────────►│              │            │
  │                │ 检测到冲突    │            │
  │                │ 自动策略无法   │            │
  │                │ 决定          │            │
  │                │──┐           │            │
  │                │◄─┘           │            │
  │                │ 标记 pending  │            │
  │                │─────────────►│            │
  │                │ 生成裁决请求   │            │
  │                │─────────────────────────►│
  │                │              │            │ 人工裁决
  │                │              │            │──┐
  │                │              │            │◄─┘
  │                │◄─────────────────────────│
  │                │ 执行裁决结论   │            │
  │                │─────────────►│            │
  │                │ 更新状态      │            │
  │                │─────────────►│            │
```

### 6.4 场景四：规则变更与分发

```
规则文件       Extraction     Rule           Agent
变更           Engine         Distributor    (订阅者)
  │                │              │            │
  │ 规则文件变更    │              │            │
  ├───────────────►│              │            │
  │                │ 提取规则条目   │            │
  │                │─────────────►│            │
  │                │              │ 更新规则版本 │
  │                │              │──┐         │
  │                │              │◄─┘         │
  │                │              │ 匹配订阅关系 │
  │                │              │──┐         │
  │                │              │◄─┘         │
  │                │              │ 推送通知    │
  │                │              │───────────►│
  │                │              │            │ 拉取最新规则
  │                │              │◄───────────│
  │                │              │ 返回规则    │
  │                │              │───────────►│
  │                │              │ 记录分发确认 │
  │                │              │──┐         │
  │                │              │◄─┘         │
```

### 6.5 核心路径总结

系统聚焦四条核心运行时路径：

1. 对话/文档 → 提取 → 冲突检测 → 入库（域 A + C + B）
2. Agent 查询 → 语义检索 → 上下文注入（域 B + E）
3. 冲突发生 → 自动解决或人工裁决 → 更新知识（域 C）
4. 知识条目状态流转：pending → active → superseded/deprecated → archived

交付边界（严格收口）：

- 含：对话提取、文档提取（Markdown + 网页正文）、KnowledgeEntry 存储、基础语义检索、冲突检测、时间优先 + 人工裁决两种解决策略、Context Injection、最小审计日志。
- 不含（后续迭代）：配置热加载（初期只做启动加载 + 手动 reload）、dead-letter 管理面、复杂访问控制（初期只做基础域隔离）、HTTP / Webhook / 推送接口、自动补建 Embedding 调度。

域 D（自主调研）和域 F（规则分发）后续激活。域 E 的意图消歧后续激活，初期只做上下文注入。

### 6.6 场景五：用户通过 Web 搜索知识（FR-G03）

```
用户           Web Frontend    Web API       KIVO Core      Storage
(浏览器)                       Layer         (SemanticIndex) Backend
  │                │              │              │              │
  │ 输入搜索词     │              │              │              │
  ├──────────────►│              │              │              │
  │                │ GET /search  │              │              │
  │                │ ?q=xxx       │              │              │
  │                ├─────────────►│              │              │
  │                │              │ KnowledgeQuery│              │
  │                │              ├─────────────►│              │
  │                │              │              │ 向量检索    │
  │                │              │              ├─────────────►│
  │                │              │              │◄─────────────│
  │                │              │              │ 元数据过滤  │
  │                │              │              │──┐          │
  │                │              │              │◄─┘          │
  │                │              │◄─────────────│              │
  │                │              │ 拼装响应     │              │
  │                │              │ (高亮片段   │              │
  │                │              │  +相关度分)  │              │
  │                │◄─────────────│              │              │
  │                │ 渲染搜索结果 │              │              │
  │◄──────────────│              │              │              │
```

关键约束：
- Web API Layer 不做语义检索逻辑，直接代理到引擎 Knowledge Query API。
- 高亮片段由 API Layer 基于检索结果的 score 和内容生成，不依赖引擎。
- 端到端响应时间 ≤ 2s（复用引擎 NFR-4.1）。

### 6.7 场景六：用户查看知识条目详情（FR-G04）

```
用户           Web Frontend    Web API       KIVO Core        Storage
(浏览器)                       Layer         (EntryRepo +     Backend
  │                │              │           RelationGraph)
  │ 点击条目       │              │              │              │
  ├──────────────►│              │              │              │
  │                │ GET          │              │              │
  │                │ /knowledge/id│              │              │
  │                ├─────────────►│              │              │
  │                │              │ findById     │              │
  │                │              ├─────────────►│              │
  │                │              │              ├─────────────►│
  │                │              │              │◄─────────────│
  │                │              │ getRelations │              │
  │                │              ├─────────────►│              │
  │                │              │              ├─────────────►│
  │                │              │              │◄─────────────│
  │                │              │ getVersions  │              │
  │                │              ├─────────────►│              │
  │                │              │              ├─────────────►│
  │                │              │              │◄─────────────│
  │                │◄─────────────│              │              │
  │                │ 拼装详情页   │              │              │
  │                │ (内容+关联  │              │              │
  │                │  +版本历史) │              │              │
  │◄──────────────│              │              │              │
```

关键约束：
- API Layer 并行调用 findById、getRelations、getVersionHistory 三个引擎接口，聚合后返回。
- 关联知识只返回摘要，不递归展开。

### 6.8 场景七：规则分发状态展示（FR-K03，Future）

```
用户           Web Frontend    Web API       Rule
(浏览器)                       Layer         Distributor
  │                │              │              │
  │ 打开规则页     │              │              │
  ├──────────────►│              │              │
  │                │ GET /rules   │              │
  │                ├─────────────►│              │
  │                │              │ listRules    │
  │                │              ├─────────────►│
  │                │              │              │ 查询规则列表
  │                │              │              │ + 订阅者数
  │                │              │              │ + 分发记录
  │                │              │◄─────────────│
  │                │◄─────────────│              │
  │                │ 渲染规则列表 │              │
  │                │ (生效规则   │              │
  │                │  +分发失败) │              │
  │◄──────────────│              │              │
```

### 6.9 场景八：系统字典变更实时生效（FR-L01）

```
用户           Web Frontend    Web API       KIVO Core        Intent
(浏览器)                       Layer         (GlossaryStore)  Enhancer
  │                │              │              │              │
  │ 新增/编辑术语 │              │              │              │
  ├──────────────►│              │              │              │
  │                │ POST/PUT     │              │              │
  │                │ /glossary    │              │              │
  │                ├─────────────►│              │              │
  │                │              │ upsertEntry  │              │
  │                │              ├─────────────►│              │
  │                │              │              │ 写入 DB     │
  │                │              │              │──┐          │
  │                │              │              │◄─┘          │
  │                │              │              │              │
  │                │              │              │ emit        │
  │                │              │              │ GLOSSARY_   │
  │                │              │              │ CHANGED     │
  │                │              │              ├─────────────►│
  │                │              │              │              │ 刷新本地
  │                │              │              │              │ 字典缓存
  │                │              │              │              │──┐
  │                │              │              │              │◄─┘
  │                │              │◄─────────────│              │
  │                │◄─────────────│              │              │
  │◄──────────────│              │              │              │
```

字典变更实时生效机制：

- GlossaryStore 写入成功后，通过 Pipeline Bus 发布 `GLOSSARY_CHANGED` 事件（携带变更的术语 ID 和操作类型）。
- Intent Enhancer（上下文注入模块）订阅该事件，收到后立即刷新本地字典缓存。
- 已有会话的生效边界：下一次请求时生效。Intent Enhancer 在每次构建 session context 时从缓存读取字典，缓存已刷新则自动拿到新值。
- 新会话初始化时自动加载全量字典到 session context。
- 初期实现：进程内事件总线（同步通知）。后续多节点场景通过 SSE/WebSocket 广播。

---

## 7. Deployment View

### 7.1 部署拓扑（单机）

```
┌─────────────────────────────────────────────────────┐
│                   宿主机器（单节点）                    │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │              宿主运行时进程                      │  │
│  │                                               │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │            KIVO Core（同进程库）           │  │  │
│  │  │                                         │  │  │
│  │  │  Extraction Engine  │  Iteration Engine  │  │  │
│  │  │  Knowledge Store    │  Intent Enhancer   │  │  │
│  │  │  Pipeline Bus       │  Storage Layer     │  │  │
│  │  └─────────┬───────────────────────────────┘  │  │
│  │            │                                   │  │
│  └────────────┼───────────────────────────────────┘  │
│               │                                      │
│  ┌────────────▼───────────────────────────────────┐  │
│  │              本地存储                            │  │
│  │  ./kivo-data/                                  │  │
│  │  ├── entries/        (JSON 知识条目导出视图)    │  │
│  │  ├── conflicts/      (冲突记录导出)              │  │
│  │  ├── kivo.sqlite     (主存储：条目+元数据+FTS索引) │  │
│  │  └── embeddings/     (向量缓存)                 │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌────────────────────────────────────────────────┐  │
│  │  Embedding API（宿主提供或远程调用）              │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

部署特征：

- KIVO 作为 TypeScript 库嵌入宿主运行时进程，零独立进程。
- 存储以 SQLite 为单一真相源：知识条目元数据、内容、冲突记录、全文检索索引均落 SQLite。JSON 文件为可重建的导出视图，用于调试和人工审查。
- Embedding 向量通过宿主提供的 API 生成，缓存到本地 embeddings/ 目录。
- 单机部署，无网络端口暴露，无外部数据库依赖。

#### Web 层部署拓扑

```
┌─────────────────────────────────────────────────────────┐
│                   宿主机器（单节点）                        │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Web Frontend（静态资源）                     │  │
│  │  构建产物：HTML / CSS / JS bundle                   │  │
│  │  托管方式：同进程 HTTP 服务的 /static 路由           │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │ HTTP (localhost)              │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │         Web API Layer（同进程模块）                  │  │
│  │  Express/Fastify 路由层，监听 localhost:PORT        │  │
│  │  职责：请求校验、聚合查询、写操作代理、SSE 推送      │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │ 进程内函数调用                │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │              KIVO Core（同进程库）                    │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │              本地存储（SQLite + embeddings/）        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

Web 层部署关键决策：

- Web API Layer 与 KIVO Core 同进程，通过函数调用通信，无 IPC 开销。
- 前端静态资源由同一 HTTP 服务托管（`/static` 或 `/` 路由），无需独立 CDN 或 Nginx。
- 仅监听 localhost，外部访问通过宿主环境的反向代理或端口转发。
- 后续演进时，Web API Layer 可独立为微服务，前端静态资源可迁移至 CDN。

### 7.2 分布式部署拓扑（后续演进）

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   节点 A      │     │   节点 B      │     │   节点 C      │
│  Agent 集群   │     │  Agent 集群   │     │  管理节点     │
│              │     │              │     │              │
│  KIVO Client │     │  KIVO Client │     │  KIVO Admin  │
│  (SDK)       │     │  (SDK)       │     │  Dashboard   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────┬───────┘────────────────────┘
                    │
           ┌────────▼────────┐
           │  KIVO Server    │
           │  (HTTP API)     │
           └────────┬────────┘
                    │
           ┌────────▼────────┐
           │  Storage Layer  │
           │  PostgreSQL +   │
           │  pgvector       │
           └─────────────────┘
```

后续演进方向：

- KIVO Core 从嵌入库升级为独立服务，暴露 HTTP API。
- 存储后端从本地文件切换为 PostgreSQL + pgvector（通过 SPI 无缝替换）。
- 多节点 Agent 通过 KIVO Client SDK 访问共享知识库。
- 规则分发通过事件推送通道（WebSocket / SSE）实现实时通知。

### 7.3 部署约束

| 约束 | 初期 | 后续演进 |
|------|--------|--------|
| 进程模型 | 同进程库调用 | 独立服务进程 |
| 存储依赖 | 本地文件 + SQLite | PostgreSQL + pgvector |
| 网络要求 | 无（本地调用） | 内网 HTTP |
| Embedding | 宿主 API 代理 | 独立 Embedding 服务 |
| 最低资源 | 256MB RAM, 1GB 磁盘 | 1GB RAM, 10GB 磁盘 |

---

## 8. Cross-cutting Concepts

### 8.1 日志与可观测性

日志分三层：

- 操作日志：知识条目的 CRUD 操作、冲突检测结果、状态流转。每条操作日志包含操作类型、目标条目 ID、时间戳、操作结果。
- 审计日志：知识条目的完整生命周期追溯。从创建到归档的每一步状态变更都记录在案，满足 NFR AC-4.4。
- 诊断日志：提取管线的处理耗时、检索延迟、冲突检测命中率等运行时指标。

日志格式统一为结构化 JSON，支持按时间范围、操作类型、条目 ID 过滤查询。

初期日志落盘到本地文件（`./kivo-data/logs/`），后续可对接外部日志系统。

### 8.2 错误处理

错误分类与处理策略：

| 错误类别 | 示例 | 处理策略 |
|----------|------|----------|
| 提取失败 | LLM 调用超时、格式解析错误 | 重试 1 次，仍失败则记录原始输入到 dead-letter，不阻塞主流程 |
| 冲突解决失败 | 自动策略无法判定 | 标记 pending + 生成人工裁决请求，知识条目不入库 |
| 存储写入失败 | 磁盘满、文件锁冲突 | 抛出异常，上层管线中断并告警 |
| 检索超时 | 向量检索超过 2s | 降级为元数据过滤检索，返回部分结果并标注降级 |
| Embedding 生成失败 | API 不可用 | 跳过语义索引，仅存储条目元数据，后续补建索引 |

核心原则：提取和检索的失败不能污染已有知识库数据。写入路径的失败通过 SQLite 事务保证原子性——事务内完成条目元数据、内容、冲突记录和索引的写入，任一步失败则整体回滚。

### 8.3 安全

访问控制模型（简化版）：

- 知识条目按域（domain）划分访问范围。
- Agent 在检索时携带自身角色标识，Knowledge Store 按角色过滤可见条目。
- 敏感知识条目（如包含凭据、内部决策）标记 `restricted` 标签，仅限指定角色访问。
- 规则分发严格按订阅关系，不超范围推送。

初期访问控制通过配置文件定义角色-域映射，不引入独立的认证/授权服务。

数据安全：

- 知识条目存储不包含原始凭据或密钥，提取时自动脱敏。
- 调研任务不访问用户未授权的信息源（由宿主环境在执行层面保证）。

### 8.4 配置管理

KIVO 的配置分为三层：

| 层次 | 内容 | 加载方式 |
|------|------|----------|
| 默认配置 | 知识类型定义、冲突解决策略优先级、检索默认参数 | 内置于代码 |
| 实例配置 | 存储后端选择、Embedding API 端点、日志级别、清理周期 | 配置文件（`kivo.config.json`） |
| 运行时配置 | token 预算、调研频率、静默模式开关 | API 调用或环境变量 |

配置加载优先级：运行时 > 实例 > 默认。

配置加载策略：启动时一次性加载，运行期间通过 API 调用修改运行时配置即时生效，实例配置变更需要手动 reload。后续引入文件监听热加载，生效边界为等当前管线批次完成后再应用新配置。

### 8.5 测试策略

| 测试层次 | 覆盖范围 | 工具 |
|----------|----------|------|
| 单元测试 | 各域模块的核心逻辑（提取器、冲突检测器、检索排序） | Vitest |
| 集成测试 | 管线端到端流转（提取→冲突检测→入库→检索） | Vitest + 测试夹具 |
| 契约测试 | SPI 接口的存储后端实现一致性 | 接口测试套件 |
| 性能测试 | 检索延迟（P95 ≤ 2s）、千级条目下的写入吞吐 | 基准测试脚本 |

测试数据：使用预构建的知识条目夹具（fixture），覆盖六类知识类型、冲突场景、边界条件。

提取器测试需要 mock LLM 调用，返回预定义的提取结果，避免测试依赖外部 API。

### 8.6 Web 层前后端通信协议

协议选择：HTTP REST + JSON（详见 ADR-008）。

请求规范：
- Content-Type: application/json
- 查询参数通过 URL query string 传递
- 写操作通过 request body 传递
- 分页参数：`page`（从 1 开始）、`pageSize`（默认 20，最大 100）

响应规范：

```typescript
// 成功响应
interface ApiResponse<T> {
  data: T;
  meta?: {
    total: number;
    page: number;
    pageSize: number;
  };
}

// 错误响应
interface ApiError {
  error: {
    code: string;          // 业务错误码，如 CONFLICT_NOT_FOUND
    message: string;       // 人可读描述
    details?: unknown;     // 可选详细信息
  };
}
```

HTTP 状态码约定：
- 200：查询成功
- 201：创建成功
- 400：参数错误
- 404：资源不存在
- 409：冲突（如字典术语重名或版本冲突）
- 500：服务端错误

并发写保护协议：

所有写接口必须携带版本标识，防止后写覆盖前写。

```typescript
// 写请求必须携带
interface WriteRequest {
  // ...业务字段
  expectedVersion: number;  // 客户端读取时获得的版本号
  requestId: string;        // 幂等键，客户端生成的 UUID
}

// 成功响应携带新版本号
interface WriteResponse<T> {
  data: T;
  meta: {
    version: number;      // 写入后的新版本号
    requestId: string;    // 回显请求 ID
  };
}

// 版本冲突响应
interface VersionConflictError {
  error: {
    code: 'VERSION_CONFLICT';
    message: string;
    details: {
      currentVersion: number;   // 服务端当前版本
      expectedVersion: number;  // 客户端提交的版本
      requestId: string;
    };
  };
}
```

规则：
- 服务端收到写请求时，比对 `expectedVersion` 与当前存储版本。不匹配则返回 `409 VERSION_CONFLICT`。
- `requestId` 用于幂等性保证：相同 requestId 的重复请求不会产生副作用。
- 前端收到 409 后展示冲突提示，引导用户重新加载最新数据后重试。
- 适用端点：PATCH /knowledge/:id/status、PUT /knowledge/:id/content、POST/PUT/DELETE /glossary、POST/PATCH /research/tasks、POST /conflicts/:id/resolve。

实时事件推送：
- 活动流通过 SSE（Server-Sent Events）推送，端点 `/api/v1/activity/stream`。
- 事件格式：`{ type: string, data: object, timestamp: string }`。
- 客户端断线后自动重连，通过 `Last-Event-ID` 恢复。

### 8.7 Web 层认证与权限

认证策略（单用户场景）：
- Web 层与 KIVO Core 同进程部署，仅监听 localhost。
- 认证通过宿主环境的身份传递（如 HTTP Header `X-KIVO-User`）。
- 无独立登录流程，依赖宿主的认证网关。

权限模型：
- 初期只有一种角色：owner（产品负责人），拥有所有操作权限。
- 后续可扩展角色：viewer（只读）、editor（可编辑知识和字典）、admin（全部权限）。
- 权限检查在 API Layer 的中间件中统一执行，不散落在各端点处理函数中。

### 8.8 Web 层错误处理策略

错误分层处理：

| 层 | 错误类型 | 处理策略 |
|------|----------|----------|
| Frontend | 网络请求失败 | 显示重试按钮，不丢失用户输入 |
| Frontend | API 返回 4xx | 解析 error.message 展示给用户 |
| Frontend | API 返回 5xx | 显示通用错误提示，建议稍后重试 |
| Frontend | 乐观更新回滚 | 回滚 UI 状态 + toast 提示操作失败 |
| API Layer | 引擎接口调用失败 | 记录错误日志，返回结构化错误响应 |
| API Layer | 检索超时 | 返回部分结果 + degraded: true 标记 |
| API Layer | 参数校验失败 | 返回 400 + 具体字段错误信息 |

核心原则：
- 前端永远不展示原始技术错误信息（如堆栈、SQL 错误），只展示业务可理解的描述。
- 写操作失败不能导致数据不一致（乐观更新回滚 + 引擎层事务保证）。
- NFR-G4：所有用户操作 1 秒内给出界面反馈。

---

## 9. Architecture Decisions

完整 ADR 文档见 [decisions/](decisions/) 目录：

- [ADR-001：管道-过滤器作为知识管线架构](decisions/ADR-001-pipeline-filter-architecture.md)
- [ADR-002：Repository 模式 + SPI 实现存储抽象](decisions/ADR-002-repository-spi-storage.md)
- [ADR-003：冲突检测作为写入前置拦截](decisions/ADR-003-conflict-detection-pre-write.md)
- [ADR-004：拉取优先的规则分发策略](decisions/ADR-004-pull-first-rule-distribution.md)
- [ADR-005：调研任务定义与执行分离](decisions/ADR-005-research-definition-execution-separation.md)
- [ADR-006：固定六类知识类型 + 扩展注册](decisions/ADR-006-fixed-six-knowledge-types.md)
- [ADR-007：同进程嵌入式部署](decisions/ADR-007-wave1-embedded-deployment.md)
- [ADR-008：Web 层 API 风格选择（REST）](decisions/ADR-008-web-api-style-rest.md)
- [ADR-009：前端框架选择](decisions/ADR-009-frontend-framework-selection.md)
- [ADR-010：系统词典作为 KnowledgeEntry 的特化视图](decisions/ADR-010-dictionary-as-knowledge-entry-specialization.md)

以下为各决策摘要。

### ADR-001：管道-过滤器作为知识管线架构

状态：已采纳

背景：KIVO 的核心数据流是「信息输入 → 结构化提取 → 质量把关 → 持久化」。需要选择一种架构风格来组织这条管线。

决策：采用管道-过滤器（Pipeline-Filter）架构。提取、冲突检测、合并检测、入库作为独立过滤器，通过 Pipeline Bus 事件串联。每个过滤器可独立测试、独立替换。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 事件溯源（Event Sourcing） | 完整审计追溯、时间旅行回放 | 实现复杂度高，需要事件存储基础设施，重放逻辑维护成本大 | 万级条目规模不需要事件溯源的强审计能力，审计日志已满足 NFR AC-4.4 |
| 直接写入（无管线） | 实现简单，调用链短 | 无法在写入前拦截冲突，一致性无法保证 | 违反一致性第一优先级（NFR-4.5），冲突检测必须前置 |

### ADR-002：Repository 模式 + SPI 实现存储抽象

状态：已采纳

背景：KIVO 需要在不同宿主环境下运行，底层存储可能是本地文件、SQLite、PostgreSQL 或向量数据库。上层业务逻辑不应感知存储差异。

决策：采用 Repository 模式封装数据访问，通过 SPI（Storage Provider Interface）定义存储后端契约。初期实现 SQLite 后端，后续按需实现其他后端。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 直接依赖 SQLite API | 无抽象层开销，代码直接 | 更换存储需要修改所有数据访问代码 | 违反解耦约束（§2.1），宿主环境差异大，绑定特定数据库不可接受 |
| ORM 框架（如 Prisma/TypeORM） | 多数据库支持开箱即用 | 引入重量级依赖，ORM 的查询抽象不覆盖语义检索场景 | 语义检索（Embedding + 余弦相似度）超出 ORM 能力范围，仍需自定义 SPI |

### ADR-003：冲突检测作为写入前置拦截

状态：已采纳

背景：一致性是 KIVO 的第一优先级质量属性。新知识入库时可能与已有知识语义矛盾，需要决定在什么时机执行冲突检测。

决策：冲突检测作为写入前置拦截，所有知识写入路径必须经过 ConflictDetector，零绕过。检测不通过的条目不入库，标记 pending 或触发解决流程。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 写入后异步检测 | 写入延迟低，不阻塞入库 | 矛盾知识短暂共存，Agent 可能在检测完成前读到矛盾结果 | 违反「冲突解决率 100%，无矛盾共存」的质量目标（QS-01） |
| 定期批量扫描 | 实现简单，对写入路径零侵入 | 扫描间隔内矛盾持续存在，扫描频率与数据量成正比 | 无法满足实时一致性要求，规模增长后扫描成本不可控 |

冲突检测技术方案：采用两阶段判定。第一阶段：Embedding 余弦相似度粗筛，对新条目与同类型已有条目计算向量距离，相似度 > 0.85 的候选对进入第二阶段。第二阶段：LLM 语义对比精判，将候选对提交给 LLM，prompt 要求判定「两条知识是否对同一主题给出互斥结论」，返回 conflict / compatible / unrelated 三分类结果。阈值 0.85 作为初始值，通过冲突评估集（≥ 50 组标注样本）校准，持续根据误判/漏判反馈调优。Embedding 不可用时降级为元数据匹配（同类型 + 关键词重叠度 > 60%）+ LLM 精判。

### ADR-004：拉取优先的规则分发策略

状态：已采纳

背景：规则分发需要保证订阅者获取最新规则。需要选择推送、拉取或混合策略。

决策：拉取优先 + 事件补充。Agent 启动时拉取全量规则，运行期间通过事件通知增量更新。高优先级规则变更主动推送通知，Agent 收到通知后拉取最新版本。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 纯推送 | 实时性高，变更即达 | 需要维护长连接或 WebSocket，基础设施复杂度高，离线 Agent 需要补偿机制 | 初期单进程部署无网络端口，推送基础设施过重 |
| 纯拉取（轮询） | 实现简单，无状态 | 轮询间隔决定延迟上限，频繁轮询浪费资源 | 无法满足 NFR-4.3（≤ 30s 延迟）除非轮询间隔极短 |

### ADR-005：调研任务定义与执行分离

状态：已采纳

背景：KIVO 需要自主调研能力来填补知识缺口，但调研涉及网络访问、文档读取等工具能力。

决策：KIVO 只负责定义调研任务（目标、范围、搜索策略、预算），宿主环境负责执行并返回结果。调研结果重新进入提取管线。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| KIVO 直接持有工具能力 | 端到端闭环，无需宿主协调 | 违反解耦约束，KIVO 需要管理网络访问、API 密钥、沙箱安全 | 增加安全攻击面，与「通用知识管理语义」定位矛盾 |
| 宿主全权决定调研策略 | KIVO 零调研逻辑 | 宿主不了解知识缺口的优先级和填补策略 | 缺口检测的价值在于精准定义「缺什么、怎么补」，交给宿主等于放弃核心能力 |

### ADR-006：固定六类知识类型 + 扩展注册

状态：已采纳

背景：知识条目需要分类以支撑针对性的提取、检索和冲突检测策略。需要决定类型体系的开放程度。

决策：固定六类核心类型（fact / methodology / decision / experience / intent / meta），新类型通过注册机制扩展。注册时需提供类型定义、提取 prompt 模板和冲突检测规则。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 自由标签（无固定类型） | 灵活度最高，用户自定义 | 缺乏结构约束，提取和冲突检测无法针对类型优化，标签膨胀后检索质量下降 | 冲突检测依赖类型语义（fact 的冲突判定与 decision 不同），自由标签无法支撑 |
| 固定类型不可扩展 | 实现简单，类型语义确定 | 无法适应未预见的知识分类需求 | 可扩展性是关键质量属性（QS-05），完全封闭不可接受 |

### ADR-007：同进程嵌入式部署

状态：已采纳

背景：KIVO 的部署形态影响集成复杂度、运维成本和性能特征。需要决定首版的部署模型。

决策：将 KIVO 作为 TypeScript 库嵌入宿主运行时进程，通过函数调用交互，零独立进程、零网络端口。

替代方案对比：

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 独立微服务 | 独立扩缩容、独立部署、技术栈自由 | 引入网络通信、服务发现、健康检查等基础设施开销 | 万级条目规模不需要独立扩缩容，过早引入网络复杂度增加首版交付风险 |
| Sidecar 进程 | 进程隔离，崩溃不影响宿主 | 需要 IPC 通信，部署和调试复杂度增加 | 同进程库调用延迟更低，稳定性风险可控 |

---

## 10. Quality Requirements

### 10.1 质量树

```
                        KIVO 质量目标
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
      一致性              检索效能             解耦性
    (最高优先)           (高优先)            (高优先)
         │                   │                   │
    ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
    │         │         │         │         │         │
  冲突零    状态机     命中率    响应      存储可    宿主
  容忍     完整性     ≥85%    ≤2s(P95)   替换     无关
         │                   │                   │
         │              自主性              可扩展性
         │             (中优先)             (中优先)
         │                   │                   │
         │            缺口检测            类型/源/
         │            ≥70%              分发可扩展
```

### 10.2 质量场景

| ID | 质量属性 | 场景 | 刺激 | 响应 | 度量 | 验证方法 |
|----|----------|------|------|------|------|---------|
| QS-01 | 一致性 | 新知识与已有知识语义矛盾 | 提取管线产出冲突条目 | 冲突检测拦截，执行解决策略或标记人工裁决 | 冲突解决率 100%，无矛盾共存 | 构造冲突测试集（视为同主题矛盾、同场景矛盾规则各 10 组），执行提取入库流程，验证所有冲突被拦截并解决，无矛盾条目共存于 active 状态 |
| QS-02 | 检索效能 | Agent 执行任务时查询相关知识 | 语义检索请求 | 返回按相关度排序的知识条目 | 命中率 ≥ 85%，P95 ≤ 2s | 人工标注测试集（≥ 100 条查询 + 期望结果），执行检索并计算 Recall@5；延迟通过基准测试脚本统计 P95 |
| QS-03 | 解耦性 | 更换底层存储引擎 | 从 SQLite 切换到 PostgreSQL | 上层接口行为不变，仅替换 SPI 实现 | 零上层代码修改 | SPI 契约测试套件：对每个 Storage Backend 实现跑同一套接口测试（CRUD + 检索 + 版本历史），全部通过即证明可替换 |
| QS-04 | 自主性 | Agent 查询频繁未命中某领域 | 累积未命中记录触发缺口检测 | 生成调研任务建议 | 缺口检测覆盖率 ≥ 70% | 构造包含已知盲区的知识库 + 查询日志，运行缺口检测，验证输出的调研任务覆盖已知盲区的比例；后续激活 |
| QS-05 | 可扩展性 | 新增知识类型（如 "pattern"） | 通过注册机制添加类型定义 | 提取、存储、检索自动适配新类型 | 不修改已有模块代码 | 注册新类型后，执行提取→入库→检索全链路，验证新类型条目正常处理；检查已有模块无代码变更 |
| QS-06 | 可靠性 | 提取过程中 LLM 调用失败 | API 超时或返回异常 | 重试后仍失败则记录 dead-letter，不阻塞主流程 | 已有知识库数据零损坏 | 注入 LLM 调用失败（mock 超时/异常），验证提取失败不影响已有条目，dead-letter 正确记录原始输入 |
| QS-07 | 安全性 | Agent 检索超出自身域的知识 | 携带角色标识的检索请求 | 按角色-域映射过滤，仅返回可见条目 | 敏感知识零跨域泄露 | 创建多域知识条目（含 restricted 标记），用不同角色检索，验证跨域条目不出现在结果中 |
| QS-08 | 性能 | 知识库规模达到万级条目 | 持续写入和检索 | 检索延迟不退化 | P95 ≤ 2s（1 万条目） | 基准测试脚本：预填充 1 万条知识条目，并发 10 个检索请求，统计 P95 延迟；硬件基线：单核 2GHz + 1GB RAM |
| QS-09 | 性能 | 规则变更后订阅者可查询延迟（NFR-4.3） | 规则条目更新并触发分发流程 | 订阅者在下次拉取或推送通知后获取最新规则 | 从规则变更到订阅者可查询 ≤ 30s | 测试方法：更新规则条目后计时，模拟订阅者拉取请求，验证返回新版本的延迟 ≤ 30s；后续激活 |

---

## 11. Risks and Technical Debt

### 11.1 已知风险

| ID | 风险 | 影响 | 概率 | 缓解策略 |
|----|------|------|------|----------|
| R-01 | LLM 提取质量不稳定 | 低质量知识条目污染知识库 | 高 | 置信度阈值过滤 + pending 状态缓冲 + 用户纠偏回路 |
| R-02 | 语义冲突检测的误判和漏判 | 误判导致有效知识被拒，漏判导致矛盾共存 | 中 | 冲突检测结果可复盘，人工裁决兜底，持续优化检测 prompt |
| R-03 | 向量检索在万级规模下的精度衰减 | 检索命中率下降 | 低 | 初期规模可控；后续引入专业向量数据库前做基准测试 |
| R-04 | 宿主 Embedding API 不可用 | 新条目无法建立语义索引 | 中 | 降级为元数据检索，后续补建索引；本地 Embedding 模型作为备选 |
| R-05 | 知识条目膨胀导致存储和检索性能下降 | 系统响应变慢 | 低 | 过期清理机制+ 归档策略 + 存储后端升级路径 |
| R-06 | 调研任务消耗过多宿主资源 | 影响用户主动任务 | 中 | 调研不抢占用户任务资源（FR-D03 AC2）+ 预算上限 + 静默模式 |

### 11.2 技术债务

| ID | 债务 | 产生原因 | 偿还计划 |
|----|------|----------|----------|
| TD-01 | 初期关联关系仅支持 conflicts 和 supersedes | 简化首版实现 | 后续实现完整 FR-B03（supplements/depends_on） |
| TD-02 | 初期无过期清理和知识合并 | 聚焦核心闭环 | 后续实现 FR-C02 和 FR-C03 |
| TD-03 | 初期访问控制基于配置文件静态映射 | 避免引入认证服务 | 后续按需升级为动态权限管理 |
| TD-04 | JSON 导出文件与 SQLite 主存储的同步延迟 | JSON 作为可重建视图，异步写出可能短暂滞后 | 影响可忽略，JSON 仅用于调试；迁移到数据库后自然消除 |
| TD-05 | 提取器依赖 LLM prompt 质量，无自动化质量评估 | 初期人工验证 | 建立提取质量评估基准集，自动化回归测试 |

---

## 12. Glossary

| 术语 | 定义 |
|------|------|
| Knowledge Entry | 知识条目，KIVO 管理的最小知识单元。包含类型、内容、来源、版本、状态和关联关系 |
| Knowledge Type | 知识类型枚举：fact（事实）、methodology（方法论）、decision（决策）、experience（经验）、intent（意图）、meta（元认知） |
| Source Reference | 来源引用，记录知识的出处（对话 ID、文档路径、URL 等） |
| Conflict Record | 冲突记录，记录两条知识之间的冲突详情、解决策略和结论 |
| Research Task | 调研任务，由缺口检测生成，包含目标、范围、搜索策略、预算和状态 |
| Gap Report | 缺口报告，记录知识库的盲区分析结果和对应的调研建议 |
| Rule Entry | 规则条目，可分发的系统规则，包含内容、适用范围、优先级和订阅关系 |
| Subscription | 订阅关系，记录 Agent 与规则集之间的绑定 |
| Distribution Record | 分发记录，记录规则推送的目标、时间和确认状态 |
| Pipeline Bus | 知识管线事件总线，连接各域模块，驱动提取→检测→入库的流转 |
| SPI（Storage Provider Interface） | 存储提供者接口，屏蔽底层存储差异的抽象层 |
| Dead-letter | 死信队列，存放提取失败的原始输入，供后续重试或人工处理 |
| Pending | 待确认状态，低置信度提取结果或等待人工裁决的知识条目 |
| Token Budget | Token 预算，调用方在检索请求中指定的上下文注入内容量上限 |
| Self-Evolving Harness | 自进化治理框架，KIVO 所属的上层系统，包含 SEVO（研发流水线）和 AEO（效果度量） |
| 宿主环境 | 运行 KIVO 的外部系统（如 OpenClaw），提供 Agent 运行时、工具能力和执行沙箱 |
| Term Entry | 术语条目，KnowledgeEntry 的特化视图（type=fact, domain=system-dictionary），通过 metadata 扩展承载术语结构化字段 |
| TermMetadata | 术语元数据扩展，包含 term、aliases、definition、constraints、positiveExamples、negativeExamples、scope |
| System Dictionary | 系统词典（域 H），管理术语定义、Prompt 注入、冲突检测和生命周期 |

---

## 13. 域 H：系统词典模块架构补充

### 13.1 架构定位

系统词典（Domain H）是 KIVO 已有基础设施的特化层，不是独立域。核心设计原则：术语条目是 KnowledgeEntry 的一种视图，最大化复用存储、检索、冲突检测和生命周期基础设施，仅在必要处增加术语专用逻辑。

复用关系：

| 能力 | 复用的已有模块 | 词典模块增量 |
|------|---------------|-------------|
| 存储 | EntryRepository（域 B） | 无，直接使用 |
| 语义检索 | SemanticIndex（域 B） | 增加精确匹配前置路径 |
| 冲突检测 | ConflictDetector（域 C） | 增加别名精确匹配 + 独立阈值配置 |
| 生命周期 | EntryRepository 版本机制 + ExpiryScanner | 增加版本触发规则（仅 definition/constraints 触发） |
| 上下文注入 | ContextInjector + InjectionPolicy（域 E） | 增加术语格式化模板 + 优先级提升 + deprecated 提示注入 |
| 批量导入 | DocumentExtractor（域 A） | 增加 JSON/YAML/CSV 解析策略 |

### 13.2 Building Block View — 词典模块分解

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dictionary Module (域 H)                     │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │  DictionaryService│  │ TermConflict     │  │ TermImporter  │ │
│  │  (FR-H01, H04)   │  │ Checker          │  │ (FR-H05)      │ │
│  │                  │  │ (FR-H03)         │  │               │ │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘ │
│           │                     │                     │         │
│  ┌────────▼─────────┐  ┌────────▼─────────┐           │         │
│  │ TermInjection    │  │ TermSearch       │           │         │
│  │ Strategy         │  │ (精确匹配前置)    │           │         │
│  │ (FR-H02)         │  │                  │           │         │
│  └──────────────────┘  └──────────────────┘           │         │
│           │                     │                     │         │
└───────────┼─────────────────────┼─────────────────────┼─────────┘
            │                     │                     │
   ┌────────▼─────────────────────▼─────────────────────▼─────────┐
   │              KIVO Core 已有基础设施                            │
   │  EntryRepository │ SemanticIndex │ ConflictDetector │         │
   │  InjectionPolicy │ ContextInjector │ Pipeline Bus             │
   └──────────────────────────────────────────────────────────────┘
```

### 13.3 子模块职责

#### DictionaryService（FR-H01, FR-H04）

职责：术语的 CRUD 和生命周期管理。对外提供术语注册、修改、废弃、合并接口，内部将术语操作转译为 KnowledgeEntry 操作。

核心逻辑：

- 注册术语时，构造 KnowledgeEntry（type=fact, domain=system-dictionary），将 TermMetadata 写入 metadata 扩展字段，title 映射 term，content 映射 definition。
- 修改术语时，判断版本触发规则：definition 或 constraints 变更 → 创建新版本（旧版本 superseded）；aliases、examples、scope 变更 → metadata 原地更新，不递增版本。
- 废弃术语时，标记 status=deprecated，保留清理周期后归档，复用 ExpiryScanner 流程。
- 合并术语时，选定主条目，被合并条目 status=superseded 并设置 supersedes 指向主条目 ID。合并操作记录在审计日志中，支持回退（恢复被合并条目状态）。
- 唯一性校验：同一 scope 内 term 不重复，aliases 不与任何已有 term 或 alias 冲突。

接口契约：

```typescript
interface DictionaryService {
  register(input: TermRegistrationInput): Promise<KnowledgeEntry>;
  update(id: string, patch: TermUpdatePatch, expectedVersion: number): Promise<KnowledgeEntry>;
  deprecate(id: string, reason: string): Promise<void>;
  merge(sourceIds: string[], targetId: string): Promise<KnowledgeEntry>;
  getByTerm(term: string, scope?: string): Promise<KnowledgeEntry | null>;
  listByScope(scope: string, page?: number, pageSize?: number): Promise<KnowledgeEntry[]>;
}

interface TermRegistrationInput {
  term: string;
  definition: string;
  constraints?: string[];
  aliases?: string[];
  positiveExamples?: string[];
  negativeExamples?: string[];
  scope: string[];
  source: KnowledgeSource;
}

interface TermUpdatePatch {
  definition?: string;
  constraints?: string[];
  aliases?: string[];
  positiveExamples?: string[];
  negativeExamples?: string[];
  scope?: string[];
}
```

#### TermConflictChecker（FR-H03）

职责：术语专用冲突检测，在通用 ConflictDetector 基础上增加三类术语冲突规则。

检测流程：

1. 别名冲突检测（本地精确匹配，不依赖 LLM）：新术语的 term 和 aliases 与已有术语的 term 和 aliases 做精确匹配（大小写不敏感）。命中即冲突，返回 alias_conflict 类型。
2. 范围重叠检测：两条术语的 scope 集合交集非空时，比对交集范围内的 constraints。constraints 矛盾判定委托给 ConflictDetector 的 LLM 精判（复用 Phase 2）。
3. 语义矛盾检测：复用 ConflictDetector 两阶段判定，但使用独立的相似度阈值（`dictionary.conflict.embeddingSimilarityThreshold`），与全局阈值解耦。

```typescript
interface TermConflictChecker {
  check(incoming: KnowledgeEntry, existingTerms: KnowledgeEntry[]): Promise<TermConflictResult[]>;
}

interface TermConflictResult {
  type: 'alias_conflict' | 'scope_overlap' | 'semantic_contradiction';
  incomingId: string;
  existingId: string;
  details: string;
  suggestion: 'merge' | 'modify' | 'deprecate_one';
}
```

实现策略：TermConflictChecker 组合使用 ConflictDetector（注入独立阈值）和本地别名匹配逻辑。不继承 ConflictDetector，而是持有其引用并在术语场景下编排调用顺序。

#### TermInjectionStrategy（FR-H02）

职责：术语专用的 Prompt 注入策略，扩展 InjectionFormatter 增加术语模板，与 InjectionPolicy 集成实现优先级提升。

注入逻辑：

1. 筛选：以任务描述为 query，在 domain=system-dictionary 范围内调用 SemanticIndex 检索相关术语。同时对 query 做精确匹配——query 中出现的术语名或别名直接命中。
2. 优先级：术语注入优先级高于一般知识。实现方式：在 InjectionPolicy 的排序阶段，domain=system-dictionary 的条目排序权重提升（等效于 preferredTypes 机制，但按 domain 维度）。
3. 格式化：扩展 InjectionFormatter，注册术语专用模板：

```typescript
// 术语注入 markdown 模板
function formatTermMarkdown(entry: KnowledgeEntry): string {
  const meta = entry.metadata as TermMetadata;
  const lines: string[] = [
    `**📖 ${meta.term}**`,
    `> ${meta.definition}`,
  ];
  if (meta.constraints?.length) {
    lines.push('', '约束:');
    meta.constraints.forEach(c => lines.push(`- ${c}`));
  }
  if (meta.positiveExamples?.length) {
    lines.push('', '✅ 正例:');
    meta.positiveExamples.forEach(e => lines.push(`- ${e}`));
  }
  if (meta.negativeExamples?.length) {
    lines.push('', '❌ 负例:');
    meta.negativeExamples.forEach(e => lines.push(`- ${e}`));
  }
  return lines.join('\n');
}
```

4. Deprecated 处理：deprecated 状态的术语不参与常规注入。当 query 中精确匹配到已废弃术语名时，注入废弃提示（含废弃原因和替代术语指引）。
5. Token 预算：术语注入纳入 InjectionPolicy 的总 token 预算管理。当预算不足时，术语优先保障，剩余预算分配给其他知识。

#### TermSearch（精确匹配前置）

职责：在语义检索之前增加精确匹配路径，当查询文本与术语名或别名完全匹配时直接返回。

```typescript
interface TermSearch {
  exactMatch(query: string, scope?: string): Promise<KnowledgeEntry | null>;
  searchByDomain(query: string, topK?: number): Promise<ScoredEntry[]>;
}
```

实现：exactMatch 查询 domain=system-dictionary 的条目，对 title（即 term）和 metadata.aliases 做大小写不敏感的精确匹配。命中时直接返回，不走 SemanticIndex。未命中时 fallback 到 searchByDomain（复用 SemanticIndex，filters.domain=system-dictionary）。

#### TermImporter（FR-H05）

职责：批量导入术语，支持 JSON/YAML/CSV 三种格式。

处理流程：

1. 解析输入文件，按格式分派解析器。
2. 逐条构造 TermRegistrationInput。
3. 逐条调用 TermConflictChecker 执行冲突检测。
4. 无冲突的条目通过 DictionaryService.register 入库。
5. 生成导入报告（成功/冲突/跳过/失败计数 + 逐条明细）。

```typescript
interface TermImporter {
  importFromFile(path: string, format: 'json' | 'yaml' | 'csv'): Promise<ImportReport>;
  exportToFile(path: string, format: 'json' | 'yaml' | 'csv', scope?: string): Promise<void>;
}

interface ImportReport {
  total: number;
  succeeded: number;
  conflicted: number;
  skipped: number;
  failed: number;
  details: ImportDetail[];
}

interface ImportDetail {
  term: string;
  status: 'succeeded' | 'conflicted' | 'skipped' | 'failed';
  reason?: string;
  conflictWith?: string;
}
```

CSV 格式约定：核心字段为列（term, definition, scope），复杂字段（constraints, positiveExamples, negativeExamples, aliases）用 JSON 字符串编码。JSON/YAML 格式直接映射 TermRegistrationInput 结构。

### 13.4 数据模型

术语条目不引入新的数据表或存储结构。术语是 KnowledgeEntry 的一种视图，通过以下字段约定区分：

```typescript
// KnowledgeEntry 字段映射
{
  id: string;                    // UUID
  type: 'fact',                  // 固定
  title: term,                   // 术语名
  content: definition,           // 完整定义
  summary: '...',                // 定义一句话摘要
  domain: 'system-dictionary',   // 固定
  tags: ['term', ...scope],      // 'term' 标签 + scope 列表
  metadata: TermMetadata,        // 扩展字段
  version: number,               // 版本号
  status: EntryStatus,           // active/superseded/deprecated/archived
  supersedes?: string,           // 被替代条目 ID
}

// TermMetadata 扩展（存放在 KnowledgeEntry.metadata 中）
interface TermMetadata extends KnowledgeMetadata {
  term: string;
  aliases: string[];
  definition: string;
  constraints: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  scope: string[];
}
```

对 KnowledgeMetadata 的扩展方式：TermMetadata 是 KnowledgeMetadata 的超集。现有 KnowledgeMetadata 接口已有 `referenceCount`、`externalValid`、`deprecatedAt`、`archivedAt` 等可选字段，TermMetadata 在此基础上增加术语专用字段。由于 TypeScript 接口的开放性（KnowledgeMetadata 的字段都是可选的），术语条目的 metadata 可以同时包含通用字段和术语字段，无需修改 KnowledgeMetadata 接口定义。

### 13.5 配置扩展

在 KivoConfig 中增加词典模块配置项：

```typescript
interface KivoConfig {
  // ...已有字段
  dictionary?: {
    conflict: {
      embeddingSimilarityThreshold: number; // 0-1，术语域独立阈值
    };
    injection: {
      priorityBoost: number;  // 术语在注入排序中的权重提升因子，默认 2.0
    };
  };
}
```

### 13.6 Runtime View — 术语注册与冲突检测

```
调用方         Dictionary    TermConflict   ConflictDetector  EntryRepository
               Service       Checker        (已有)            (已有)
  │                │              │              │                │
  │ register(term) │              │              │                │
  ├───────────────►│              │              │                │
  │                │ 构造         │              │                │
  │                │ KnowledgeEntry│              │                │
  │                │──┐           │              │                │
  │                │◄─┘           │              │                │
  │                │ check(entry) │              │                │
  │                ├─────────────►│              │                │
  │                │              │ 别名精确匹配 │                │
  │                │              │──┐           │                │
  │                │              │◄─┘           │                │
  │                │              │ scope 交集   │                │
  │                │              │ + constraints│                │
  │                │              │ 矛盾判定     │                │
  │                │              ├─────────────►│                │
  │                │              │◄─────────────│                │
  │                │◄─────────────│              │                │
  │                │              │              │                │
  │                │  ┌───────────┤              │                │
  │                │  │无冲突     │              │                │
  │                │  └───────────┤              │                │
  │                │ save(entry)  │              │                │
  │                ├──────────────────────────────────────────────►│
  │                │◄──────────────────────────────────────────────│
  │                │ emit         │              │                │
  │                │ TERM_CHANGED │              │                │
  │◄───────────────│              │              │                │
```

### 13.7 Runtime View — 术语 Prompt 注入

```
Agent          ContextInjector  TermInjection  TermSearch    InjectionPolicy
Runtime        (已有)           Strategy                     (已有)
  │                │                │              │              │
  │ inject(query,  │                │              │              │
  │  tokenBudget)  │                │              │              │
  ├───────────────►│                │              │              │
  │                │ 检索术语       │              │              │
  │                ├───────────────►│              │              │
  │                │                │ exactMatch   │              │
  │                │                ├─────────────►│              │
  │                │                │◄─────────────│              │
  │                │                │ searchByDomain│             │
  │                │                ├─────────────►│              │
  │                │                │◄─────────────│              │
  │                │◄───────────────│              │              │
  │                │ 检索一般知识   │              │              │
  │                │──┐             │              │              │
  │                │◄─┘             │              │              │
  │                │ 合并候选集     │              │              │
  │                │ (术语优先)     │              │              │
  │                ├──────────────────────────────────────────────►│
  │                │◄──────────────────────────────────────────────│
  │                │ 格式化注入     │              │              │
  │                │ (术语用专用模板)│              │              │
  │◄───────────────│                │              │              │
```

### 13.8 Runtime View — 批量导入

```
调用方         TermImporter   Parser        DictionaryService  TermConflict
                              (JSON/YAML/CSV)                   Checker
  │                │              │              │                │
  │ importFromFile │              │              │                │
  ├───────────────►│              │              │                │
  │                │ parse(file)  │              │                │
  │                ├─────────────►│              │                │
  │                │◄─────────────│              │                │
  │                │              │              │                │
  │                │ ── 逐条循环 ──│              │                │
  │                │ register(term)│              │                │
  │                ├──────────────────────────────►│                │
  │                │              │              │ check + save   │
  │                │              │              ├───────────────►│
  │                │              │              │◄───────────────│
  │                │◄──────────────────────────────│                │
  │                │ ── 循环结束 ──│              │                │
  │                │              │              │                │
  │ ImportReport   │              │              │                │
  │◄───────────────│              │              │                │
```

### 13.9 文件结构

词典模块的源码组织在 `src/dictionary/` 目录下：

```
src/dictionary/
├── index.ts                    // 模块导出
├── dictionary-service.ts       // DictionaryService 实现
├── term-conflict-checker.ts    // TermConflictChecker 实现
├── term-injection-strategy.ts  // TermInjectionStrategy 实现
├── term-search.ts              // TermSearch（精确匹配 + domain 检索）
├── term-importer.ts            // TermImporter（批量导入导出）
├── term-types.ts               // TermMetadata、TermRegistrationInput 等类型定义
└── __tests__/
    ├── dictionary-service.test.ts
    ├── term-conflict-checker.test.ts
    ├── term-injection-strategy.test.ts
    └── term-importer.test.ts
```

### 13.10 与 Web 层的集成

Web 层已有 Glossary CRUD API（`/api/v1/glossary/**`）和 GlossaryPage 组件（§5.3）。词典模块上线后，Web API Layer 的 Glossary 端点从直接操作 GlossaryEntry 表改为调用 DictionaryService 接口。

变更点：

- GlossaryEntry（§5.3.3 定义的 Web 层独有实体）废弃，统一使用 KnowledgeEntry + TermMetadata。
- Glossary API 的 POST/PUT/DELETE 端点改为调用 DictionaryService.register/update/deprecate。
- Glossary API 的 GET 端点改为调用 TermSearch.searchByDomain + DictionaryService.listByScope。
- GlossaryPage 前端组件的数据结构从 GlossaryEntry 适配为 KnowledgeEntry + TermMetadata 视图。

### 13.11 交付边界

随知识闭环一起交付：

| 子模块 | 对应 FR | 说明 |
|--------|---------|------|
| DictionaryService | FR-H01, FR-H04 | 术语 CRUD + 生命周期 |
| TermConflictChecker | FR-H03 | 三类冲突检测 |
| TermInjectionStrategy | FR-H02 | 术语 Prompt 注入 |
| TermSearch | FR-H01 AC5 | 精确匹配前置 |
| TermImporter | FR-H05 | 批量导入导出 + 种子数据 |

理由：术语一致性是知识质量的基础约束，应在最早阶段建立。所有子模块复用已有基础设施，增量开发量可控。
