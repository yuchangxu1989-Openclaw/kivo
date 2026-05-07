# KIVO 意图知识链路 — arc42 架构文档

OpenClaw（sa-02 子Agent）| 2026-05-03

---

## 目录

1. 引言与目标
2. 约束条件
3. 上下文与范围
4. 构建块视图
5. 运行时视图
6. 部署视图
7. 横切关注点

---

## 1. 引言与目标

### 1.1 架构目标

意图知识链路的目标是让 KIVO 引擎从被动的"查了才给"升级为主动的"听到就记、用时就注"。具体而言：

- **自动感知**：对话结束后自动检测用户的纠偏、强调、声明、规则和偏好信号，无需用户手动录入。
- **结构化沉淀**：将意图信号提取为带正例/负例的结构化知识条目（type=intent），走标准知识管线入库。
- **持久化索引**：向量索引从纯内存升级为 SQLite 持久化 + 内存加速，进程重启不丢数据。
- **自动注入**：Agent 构建 prompt 前和派发子任务时，自动匹配并注入相关意图知识，提升 Agent 对用户意图的理解。
- **零手动触发**：整条链路由 hook 事件驱动，安装即运行。

### 1.2 覆盖的功能需求

| FR | 名称 | 链路位置 |
|----|------|----------|
| FR-E03 | 意图信号自动检测 | 感知侧 — 信号检测 |
| FR-E04 | 意图知识提取与结构化存储 | 感知侧 — 提取入库 |
| FR-E05 | 任务派发时意图知识注入 | 消费侧 — 注入 |
| FR-I03 | 意图管线宿主集成 | 集成层 — 插件 |
| FR-B04 AC5/AC6 | 向量索引持久化 | 基础设施 — 存储 |

### 1.3 架构驱动力

- 用户在对话中表达的意图散落在会话记忆里，没有结构化沉淀，Agent 换个会话就忘。
- 现有 VectorIndex 纯内存实现，进程重启即丢失全部向量数据。
- ConversationExtractor、ContextInjector 等组件代码已存在，但没有调用者把它们串成完整链路。
- 需要一个 OpenClaw 插件把对话事件流和 KIVO 引擎连接起来。

---

## 2. 约束条件

### 2.1 技术约束

| 约束 | 说明 |
|------|------|
| OpenClaw hook 系统 | 插件只能通过 Gateway 暴露的 hook 事件接入（`subagent_ended`、`session_ended`、`before_prompt_build`、`before_tool_call`），不能修改 Gateway 核心代码 |
| 零新外部依赖 | KIVO 已依赖 better-sqlite3，持久化必须复用同一 SQLite 实例，禁止引入外部向量数据库 |
| npm 包分发 | 插件代码打包在 KIVO npm 包的 `plugin/` 目录下，通过 `package.json` exports 暴露 `"./plugin"` 入口 |
| LLM 可用性 | 信号检测依赖 LLM 语义识别，LLM 不可用时整条感知侧链路静默降级 |
| 异步非阻塞 | 所有 hook 处理必须异步执行，不阻塞 Gateway 主流程 |

### 2.2 组织约束

| 约束 | 说明 |
|------|------|
| 不修改现有公共 API | ConversationExtractor、VectorIndex、ContextInjector 的公共接口保持不变，新功能通过继承或构造参数注入 |
| 渐进式披露 | L0 零配置可用，L1 可调参数，L2 可扩展信号类型 |
| 单 Agent 兼容 | 宿主环境只有一个 Agent 时，链路仍能完整运行 |

---

## 3. 上下文与范围

### 3.1 系统上下文

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   用户对话    │ ──────▶ │  OpenClaw    │ ──────▶ │    LLM       │
│  (飞书/CLI)  │         │  Gateway     │         │  Provider    │
└──────────────┘         └──────┬───────┘         └──────────────┘
                                │
                    hook 事件    │
                                ▼
                    ┌───────────────────────┐
                    │  kivo-intent 插件      │
                    │  (OpenClaw Extension) │
                    └───────────┬───────────┘
                                │
                        API 调用 │
                                ▼
                    ┌───────────────────────┐
                    │    KIVO Engine         │
                    │  (npm 包核心模块)      │
                    └───────────────────────┘
```

### 3.2 边界定义

| 系统 | 职责 | 与意图链路的关系 |
|------|------|-----------------|
| OpenClaw Gateway | Agent 调度、hook 事件分发、prompt 构建 | 提供 hook 接入点，意图链路的触发源 |
| KIVO Engine | 知识提取、存储、检索、注入 | 意图链路的执行主体，所有业务逻辑在此 |
| kivo-intent 插件 | hook 监听、事件转发、上下文桥接 | 薄胶水层，把 Gateway 事件翻译为 KIVO Engine 调用 |
| LLM Provider | 语义识别、知识提取 | 被 SignalDetector 调用，提供语义理解能力 |
| SQLite (kivo.db) | 知识条目 + 向量索引持久化 | 被 PersistentVectorIndex 和 Repository 共享 |
| memory-governance | memory/*.md 文件生命周期管理 | 其日志是 cron 批量扫描的输入源，两者互补不重叠 |
| SEVO 插件 | 研发流水线编排 | 通过 hook 优先级隔离，互不干扰 |

### 3.3 不在范围内

- 知识工作台 Web UI（FR-W10 意图库管理）：属于工作台层，独立演进。
- 意图消歧（FR-E02）：依赖注入后的知识做推理，不属于管线本身。
- 知识图谱关联（域 G）：意图条目入库后由图谱模块自行处理。

---

## 4. 构建块视图

### 4.1 顶层分解

```
┌─────────────────────────────────────────────────────────────────────┐
│                        kivo-intent 插件                             │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ ConversationCol- │  │ InjectionHook    │  │ SpawnInjection-  │  │
│  │ lector           │  │                  │  │ Hook             │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
└───────────┼─────────────────────┼─────────────────────┼─────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         KIVO Engine                                 │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ SignalDetector    │  │ ContextInjector  │  │ PersistentVector │  │
│  │                  │  │ (现有)           │  │ Index            │  │
│  └────────┬─────────┘  └──────────────────┘  └──────────────────┘  │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │ Conversation-    │  │ Pipeline Engine  │                        │
│  │ Extractor (现有) │  │ (现有)           │                        │
│  └──────────────────┘  └──────────────────┘                        │
│                                                                     │
│                    kivo.db (SQLite)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 构建块职责

#### SignalDetector（新增）

位置：`src/intent-signal/signal-detector.ts`

职责：接收对话消息，通过 LLM 语义识别检测五类意图信号（correction / emphasis / declaration / rule / preference），同一处理步骤中同时输出信号类型和结构化知识。

关键行为：
- 输入：`ConversationMessage[]`（role + content）
- 输出：`IntentSignal[]`（类型、置信度、结构化知识、原始片段引用）
- 置信度低于阈值（默认 0.6）的信号丢弃
- L2 扩展：接受用户注册的自定义信号类型及其检测 prompt 片段，自定义类型需声明对应的 `knowledgeType`

设计决策（解决 P1-2）：FR-E04 AC1 的约束是"信号检测和知识提取在同一处理步骤中完成"，这是行为约束而非实现约束。当前实现选择一次 LLM 调用完成两者以减少延迟，但架构不阻止未来拆分为多步。

#### PersistentVectorIndex（新增）

位置：`src/search/persistent-vector-index.ts`

职责：替代现有纯内存 `VectorIndex`，在保持内存搜索性能的同时增加 SQLite 持久化。

关键行为：
- 启动时从 SQLite `vector_store` 表加载全部向量到内存
- `addVector()` 同时写内存和 SQLite
- `search()` 纯内存余弦相似度，与现有 VectorIndex 行为一致
- `remove()` 同时删内存和 SQLite
- 10k 条目 ≈ 15MB 内存，启动加载 <100ms

存储 schema：
```sql
CREATE TABLE IF NOT EXISTS vector_store (
  entry_id   TEXT PRIMARY KEY,
  vector     BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

与现有 VectorIndex 的关系：PersistentVectorIndex 实现相同的 `addVector / search / remove / size` 接口，可作为 drop-in 替换。原 VectorIndex 保留作为纯内存场景的轻量选项。

#### ConversationCollector（新增，插件层）

位置：`plugin/conversation-collector.ts`

职责：监听 Gateway hook 事件，从中提取对话消息，转发给 SignalDetector。

监听的 hook：
- `subagent_ended`（priority 300）：从 `evt.taskPrompt` + `evt.output` 组装对话对
- `session_ended`：收集主会话对话消息，覆盖单 Agent 场景（FR-E03 AC6）

#### InjectionHook（新增，插件层）

位置：`plugin/injection-hook.ts`

职责：在 prompt 构建前注入相关意图知识。

监听的 hook：
- `before_prompt_build`（priority 100）：从当前消息提取查询文本，调用 ContextInjector 做向量匹配，将结果通过 `ctx.prependSystem()` 注入，内容用 `<!-- KIVO Intent Knowledge -->` 标记包裹

#### SpawnInjectionHook（新增，插件层）

位置：`plugin/spawn-injection-hook.ts`

职责：在派发子任务时追加意图知识到任务 prompt。

监听的 hook：
- `before_tool_call`（priority 900）：仅拦截 `sessions_spawn` 调用，用任务描述做向量匹配，将结果追加到 `evt.args.task`

#### ConversationExtractor（现有，增强）

位置：`src/extraction/conversation-extractor.ts`

变更：通过构造参数 `promptBuilder` 注入 intent 专用提取 prompt，不修改公共 API。SignalDetector 的输出经此提取器转为标准 KnowledgeEntry。

#### ContextInjector（现有，无变更）

位置：`src/injection/context-injector.ts`

被 InjectionHook 和 SpawnInjectionHook 调用，通过 `preferredTypes: ['intent', 'decision', 'methodology']` 参数控制意图知识的优先匹配。

内部策略组件 **InjectionPolicy**（`src/injection/injection-policy.ts`）负责 token 预算分配与截断逻辑：按知识类别分段填充 token 预算（术语 → 意图 → 一般知识），每个类别内部按相关度评分排序，预算不足时从低优先级类别截断。InjectionPolicy 由 ContextInjector 在构造时实例化，不对外暴露独立接口，调用方通过 ContextInjector 的 `inject()` 方法间接使用。

#### Pipeline Engine（现有，无变更）

位置：`src/extraction/pipeline.ts`

意图知识条目以 `type=intent` 走标准管线：冲突检测 → 合并检测 → 入库。

---

## 5. 运行时视图

### 5.1 感知侧：对话 → 信号检测 → 提取 → 持久化

```
[1] subagent_ended / session_ended 事件触发
                │
                ▼
[2] ConversationCollector
    从 evt.taskPrompt + evt.output 组装 ConversationMessage[]
    （session_ended 时从主会话消息列表收集）
                │
                ▼
[3] SignalDetector.detect(messages)
    构建检测 prompt → LLM 语义识别 → 解析 IntentSignal[]
    丢弃 confidence < threshold 的信号
                │
                ▼
[4] ConversationExtractor.extract()
    用 intent 专用 promptBuilder 将 IntentSignal 转为 KnowledgeEntry[]
    每条 entry: type=intent, 含 positives/negatives/sourceFragment
                │
                ▼
[5] Pipeline Engine
    冲突检测 → 合并检测 → 入库 SQLite Repository
                │
                ▼
[6] PersistentVectorIndex.addVector()
    生成 embedding → 写入内存 Map + SQLite vector_store 表
```

时序约束：
- 步骤 [1]→[2] 异步执行，不阻塞 Gateway 主流程（FR-E03 AC4）
- 步骤 [3] 的 LLM 调用通过队列缓冲，避免并发 hook 事件导致 LLM 请求风暴
- 整条链路 fail-open：任何步骤异常只记日志，不影响 Gateway（FR-I03 AC2）

### 5.2 消费侧：任务前注入

```
[1] before_prompt_build 事件触发
                │
                ▼
[2] InjectionHook
    从当前消息/上下文提取查询文本
                │
                ▼
[3] ContextInjector.inject({
      userQuery,
      tokenBudget: config.injectionTokenBudget,
      preferredTypes: ['intent', 'decision', 'methodology'],
      disclosureMode: 'summary'
    })
    向量匹配 → 相关度评分 → token 预算截断
                │
                ▼
[4] 注入优先级排序（见 §7.3）
    术语 > 意图 > 一般知识
                │
                ▼
[5] ctx.prependSystem(injectedContext)
    用 <!-- KIVO Intent Knowledge --> 标记包裹
```

子任务注入流（`before_tool_call` 拦截 `sessions_spawn`）：

```
[1] before_tool_call 事件（toolName === 'sessions_spawn'）
                │
                ▼
[2] SpawnInjectionHook
    从 evt.args.task 提取查询文本
                │
                ▼
[3] ContextInjector.inject({
      userQuery: taskPrompt,
      tokenBudget: config.spawnInjectionBudget,
      preferredTypes: ['intent', 'decision']
    })
                │
                ▼
[4] evt.args.task += '\n---\n[KIVO 意图知识参考]\n' + injectedContext
```

### 5.3 批量补漏（cron 驱动）

```
每日 03:00 — scan-daily-memory
    扫描宿主提供的历史对话记录（OpenClaw 场景为 memory/YYYY-MM-DD.md）
    对未处理的对话片段走 [3]→[6] 的标准感知链路

每日 04:00 — reindex
    全量重建向量索引，修复可能的索引漂移
```

扫描源由宿主适配器声明，KIVO 引擎不硬编码具体路径。

---

## 6. 部署视图

### 6.1 npm 包内目录结构

```
@self-evolving-harness/kivo/
├── src/
│   ├── intent-signal/              ← 新增
│   │   ├── signal-detector.ts
│   │   ├── signal-types.ts
│   │   └── detection-prompt.ts
│   ├── search/
│   │   ├── vector-index.ts         ← 现有，保留
│   │   └── persistent-vector-index.ts  ← 新增
│   ├── extraction/
│   │   └── conversation-extractor.ts   ← 现有，增加 intent promptBuilder
│   ├── injection/
│   │   └── context-injector.ts     ← 现有，无变更
│   └── ...
├── plugin/                         ← 新增：OpenClaw 插件
│   ├── openclaw.plugin.json
│   ├── index.ts                    ← 插件入口，注册 hook
│   ├── conversation-collector.ts
│   ├── injection-hook.ts
│   └── spawn-injection-hook.ts
├── dist/
│   └── plugin/                     ← tsc 编译产物
└── package.json                    ← exports 增加 "./plugin"
```

### 6.2 package.json exports

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./plugin": { "import": "./dist/plugin/index.js" }
  }
}
```

### 6.3 安装与注册

```bash
npm install @self-evolving-harness/kivo
kivo init                    # 初始化 SQLite + 种子知识 + vector_store 表
kivo plugin install          # 注册到 openclaw.json extensions.entries
# Gateway 重启后生效
```

`kivo plugin install` 执行步骤：
1. 检测 `openclaw.json` 路径
2. 在 `extensions.entries` 中注册 `kivo-intent`，指向 `node_modules/@self-evolving-harness/kivo/dist/plugin`
3. 写入默认配置（信号阈值 0.6、token 预算 2000、全部信号类型启用）
4. 提示用户重启 Gateway

### 6.4 hook 优先级分配

| Hook | kivo-intent 优先级 | SEVO 优先级 | 说明 |
|------|-------------------|-------------|------|
| `subagent_ended` | 300 | 200 | SEVO 先处理流水线推进，KIVO 后收集对话 |
| `before_prompt_build` | 100 | 850 | KIVO 先注入知识，后续插件可见注入内容 |
| `before_tool_call` | 900 | 800 | KIVO 在 spawn 时追加知识 |

---

## 7. 横切关注点

### 7.1 Fail-Open 设计

所有 hook 处理函数包裹 try-catch，异常只记录日志，不向 Gateway 抛出。

降级场景：
- LLM 不可用 → 感知侧整条链路静默跳过，已有知识仍可注入
- SQLite 不可读 → 注入环节静默跳过，不阻塞 Agent 主任务，错误记录日志
- 向量索引损坏 → 注入降级为空结果，cron reindex 任务自动修复
- 插件加载失败 → Gateway 正常启动，意图链路不可用但不影响其他功能

### 7.2 Token 预算控制

注入环节受两层 token 预算约束：

- `injectionTokenBudget`（默认 2000）：`before_prompt_build` 注入的总 token 上限
- `spawnInjectionBudget`（默认 1500）：`before_tool_call` spawn 注入的总 token 上限

预算不足时按相关度评分排序截断，高相关度条目优先保留。

### 7.3 注入优先级排序

解决 P1-1：术语 vs 意图 vs 一般知识的优先级关系。

完整优先级链：**术语 > 意图 > 一般知识**

理由：
- 术语是命名约定，错了会导致沟通障碍，影响面最广，必须最先保障（FR-E01 AC4、FR-H02 AC3）
- 意图是用户的主观意愿和约束，直接影响 Agent 行为方向，优先级次之（FR-E05 AC3）
- 一般知识（fact / methodology / experience）是背景信息，缺失时 Agent 仍能工作，只是质量下降

实现方式：ContextInjector 的 `preferredTypes` 参数控制类型优先级。InjectionPolicy 在 token 预算截断时，先填充术语条目，再填充意图条目，最后填充一般知识条目。每个类别内部按相关度评分排序。

```
token 预算分配示意：
┌─────────────────────────────────────────────┐
│ 术语（最高优先）│ 意图知识 │ 一般知识（剩余） │
└─────────────────────────────────────────────┘
← 预算不足时从右侧截断
```

### 7.4 配置 Schema

```json
{
  "kivo-intent": {
    "enabled": true,
    "dbPath": "kivo.db",
    "signalThreshold": 0.6,
    "injectionTokenBudget": 2000,
    "spawnInjectionBudget": 1500,
    "enabledSignalTypes": ["correction", "emphasis", "declaration", "rule", "preference"],
    "maxSignalsPerConversation": 5,
    "minInjectionScore": 0.2,
    "singleAgentMode": "auto",
    "embedding": {
      "provider": "default",
      "dimensions": 256
    },
    "cron": {
      "dailyScan": "0 3 * * *",
      "reindex": "0 4 * * *"
    },
    "hotReloadable": ["signalThreshold", "injectionTokenBudget", "spawnInjectionBudget",
                       "enabledSignalTypes", "maxSignalsPerConversation", "minInjectionScore"],
    "requireRestart": ["enabled", "dbPath", "singleAgentMode", "embedding"]
  }
}
```

配置项说明：
- `dbPath`：SQLite 数据库文件路径，PersistentVectorIndex 和 Repository 共享此实例。默认 `"kivo.db"`，相对于宿主工作目录。
- `embedding.provider`：向量生成使用的 embedding provider，`"default"` 表示复用宿主 LLM 配置。
- `embedding.dimensions`：向量维度，需与 provider 输出一致。
- `cron.dailyScan`：每日对话扫描的 cron 表达式（§5.3 批量补漏）。
- `cron.reindex`：全量向量索引重建的 cron 表达式。

`hotReloadable` 列出的参数修改后下次 hook 触发时自动读取新值（FR-I03 AC4）。`requireRestart` 列出的结构性配置变更需要重启 Gateway。

### 7.5 渐进式披露

| 级别 | 用户操作 | 系统行为 |
|------|---------|---------|
| L0 | `kivo init && kivo plugin install` | 默认启用全部信号类型，阈值 0.6，token 预算 2000，零配置 |
| L1 | 修改 `kivo-intent` 配置项 | 调整检测灵敏度、启用/禁用信号类型、控制 token 预算 |
| L2 | 在 `kivo.config.js` 注册自定义信号类型 | 自定义类型需声明 `knowledgeType`，提供检测 prompt 片段，走同一条提取管线 |

### 7.6 单 Agent 兼容

当 `singleAgentMode` 为 `"auto"` 时，插件检测 `openclaw.json` 中 agent 数量：
- 多 Agent：`subagent_ended` 收集子 Agent 对话
- 单 Agent：`session_ended` 收集主会话对话

两条路径汇入同一个 SignalDetector，后续链路完全一致。

### 7.7 与现有系统的隔离

- **与 memory-governance**：memory-governance 管理 `memory/*.md` 文本文件生命周期。KIVO 管理结构化知识条目。memory 日志是 KIVO cron 扫描的输入源之一，但 KIVO 提取的知识不写回 memory 文件，避免循环依赖。
- **与 SEVO 插件**：通过 hook 优先级隔离（见 §6.4）。SEVO 管流水线，KIVO 管知识流，两者在 hook 层面互不干扰。
- **与 AGENTS.md / SOUL.md**：静态规则覆盖"永远适用"的约束，KIVO 注入覆盖"与当前任务相关"的动态知识。KIVO 注入内容用 `<!-- KIVO -->` 标记包裹，与其他注入内容隔离。
