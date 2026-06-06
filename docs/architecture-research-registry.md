# KIVO 调研登记簿技术架构

OpenClaw（sa-01 子Agent）/ 2026-06-06

## 1. 范围

本设计覆盖 KIVO 调研管理域的三条需求：

- FR-D01：登记调研主题、Agent 调研任务、状态和报告产出。
- FR-D02：用户把整篇报告标记为【可参考】后，提取关键结论并写入 Wiki 条目。
- FR-D03：Web 页面按主题展示任务、报告、状态、可参考标签和 Wiki 追溯入口。

KIVO 在这里只承担登记、追溯、确认和入库职责。调研执行仍由 Agent 系统完成，KIVO 不提供调研发起面板、调度器入口、盲区卡片或缺口分析面板。

## 2. 现有架构事实

### 2.1 数据库与仓储风格

KIVO Web 使用 `better-sqlite3` 直接访问同一个 `kivo.db`。数据库入口集中在 `web/lib/db.ts`：

- `resolveKivoDbPath()` 从 `KIVO_DB_PATH`、项目目录和固定路径解析数据库。
- `openWebDb(readonly)` 打开 SQLite 并启用 `PRAGMA foreign_keys = ON`。

知识条目主表是 `entries`，由核心包的 `SQLiteProvider` 初始化。关键字段包括：

- `id`, `type`, `title`, `content`, `summary`
- `source_json`, `confidence`, `status`, `tags_json`, `domain`
- `metadata_json`, `embedding`, `subject_id`, `entry_type`

写入知识条目推荐继续走 `web/lib/kivo-engine.ts` 的 `persistEntry()`，因为它复用核心仓储的质量门禁、去重和 embedding 配置。Embedding 配置已经固定为本机 `http://localhost:9876`。

现有 `web/lib/research-db.ts` 已经有一张轻量 `research_tasks` 表和 `adoptResearchTask()`，但它的模型仍是“单任务即主题”，缺少独立主题表、报告表、确认批次表和报告级去重。新实现应保留可迁移字段，升级为主题 → 任务 → 报告 → 入库批次的结构。

### 2.2 API 风格

现有 API 使用 Next.js App Router，返回 `NextResponse.json()`，错误通过 `badRequest`、`notFound`、`serverError` 包装。

现有调研 API：

- `GET /api/v1/research`
- `POST /api/v1/research`
- `PATCH /api/v1/research`
- `DELETE /api/v1/research?id=...`
- `GET /api/v1/research/[id]`
- `PATCH /api/v1/research/[id]`
- `POST /api/v1/research/[id]/adopt`

现有 `POST /api/v1/research` 会创建调研任务并存在调研发起语义；FR-D03 明确 Web 页面不得提供调研发起入口。后续应把“登记入口”调整为 Agent/Hook/API 调用，Web 只展示和追溯。

### 2.3 Web 路由风格

Web 使用 `app/(dashboard)` 页面组织，调研页面已经在 `web/app/(dashboard)/research/page.tsx`。页面目前从 `/api/v1/research` 拉取数据，使用 `useApi`、`apiFetch`、`Card`、`Badge`、`Button` 等组件。

视觉约束：白底黑字，状态用清晰文字表达，颜色只做辅助，不能依赖深色主题。

### 2.4 鉴权风格

`web/middleware.ts` 对非公开 API 做 cookie 校验。`/api/v1/research` 不在公开白名单内，因此默认需要 `kivo_session` cookie。

给 Agent/Hook 使用的内部写入端点不应绕开鉴权。建议复用现有内部端点模式：内部 API 使用 `KIVO_INTERNAL_TOKEN`，由路由自己校验；Web 用户访问仍走 cookie。

## 3. 数据模型

### 3.1 设计原则

- 主题和任务分表，避免同一主题下多任务被覆盖。
- 报告独立成表，保证一条任务可关联多份报告，也能保存外部飞书文档或本地报告路径。
- 【可参考】是报告级状态，不是任务级状态。
- 入库批次独立记录，解决重复确认、报告变化后重新确认、提取失败可追溯。
- Wiki 条目与报告通过映射表关联，页面可以从主题追溯到报告，再追溯到 Wiki 条目。
- 字段里不硬编码学科名，主题名、scope、domain 都来自用户或报告上下文。

### 3.2 新表

```sql
CREATE TABLE IF NOT EXISTS research_topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_research_topics_updated_at
  ON research_topics(updated_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS research_tasks (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  query TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  source_type TEXT NOT NULL DEFAULT 'agent',
  source_ref TEXT,
  actor_id TEXT,
  executor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  failure_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_tasks_topic_status
  ON research_tasks(topic_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_tasks_updated_at
  ON research_tasks(updated_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  report_uri TEXT NOT NULL,
  report_kind TEXT NOT NULL DEFAULT 'markdown',
  content_hash TEXT,
  is_reference INTEGER NOT NULL DEFAULT 0,
  reference_marked_at INTEGER,
  reference_marked_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_reports_uri
  ON research_reports(report_uri);

CREATE INDEX IF NOT EXISTS idx_research_reports_topic_created
  ON research_reports(topic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_reports_reference
  ON research_reports(is_reference, reference_marked_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS research_reference_batches (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('extracting', 'completed', 'failed')),
  confirmed_by TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  extracted_at INTEGER,
  error_message TEXT,
  llm_provider_id TEXT,
  llm_model TEXT,
  extraction_prompt_version TEXT NOT NULL,
  extracted_summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_reference_batches_dedup
  ON research_reference_batches(report_id, content_hash)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_research_reference_batches_report
  ON research_reference_batches(report_id, confirmed_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS research_report_entries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES research_reference_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_report_entries_unique
  ON research_report_entries(report_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_research_report_entries_topic
  ON research_report_entries(topic_id, created_at DESC);
```

### 3.3 与 `entries` 的关系

报告被确认后，LLM 提取关键结论，写入 `entries`。每条 entry 的来源字段保持可追溯：

```json
{
  "type": "research",
  "reference": "<report_uri>",
  "timestamp": "<extracted_at ISO>",
  "context": "<topic_id>/<report_id>/<batch_id>",
  "agent": "<confirmed_by>"
}
```

建议写入 entry 时字段映射如下：

- `type`：由 LLM 输出限定在 `fact`、`decision`、`methodology`、`experience`、`reference` 中；不确定时用 `reference`。
- `title`：结论标题，长度控制在 80 字以内。
- `summary`：一句话摘要。
- `content`：结论正文 + 必要上下文 + 报告定位线索。
- `source_json`：来源报告 URI、主题、批次、确认人。
- `confidence`：LLM 置信度，低于质量门禁时不直接入库，批次标记失败或进入待复核。
- `tags_json`：`['research', 'reference-report', <topic normalized name>]`。
- `domain` / `knowledge_domain`：使用主题名或报告中提取的通用领域描述，不写死学科名。
- `metadata_json`：保存 `researchTopicId`、`researchReportId`、`researchBatchId`、`sourceReportUri`。

写入成功后，用 `research_report_entries` 建立报告到 entry 的映射。

## 4. 后端 API 设计

### 4.1 API 总览

面向 Web 用户的读取和确认接口继续走 cookie 鉴权。面向 Agent/Hook 的登记接口使用内部 token，不放进公开白名单。

| Method | Path | 用途 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/research` | 获取按主题分组的登记簿数据 | cookie |
| GET | `/api/v1/research/topics/:topicId` | 获取单主题详情 | cookie |
| GET | `/api/v1/research/reports/:reportId` | 获取报告详情、可参考状态、关联 Wiki 条目 | cookie |
| POST | `/api/internal/research/register-task` | Agent 调研任务启动时登记主题和任务 | internal token |
| PATCH | `/api/internal/research/tasks/:taskId/status` | Agent 更新任务状态、失败原因 | internal token |
| POST | `/api/internal/research/tasks/:taskId/reports` | Agent 写入报告链接或报告路径 | internal token |
| POST | `/api/v1/research/reports/:reportId/reference` | 用户确认整篇报告为【可参考】并触发提取入库 | cookie |
| GET | `/api/v1/research/reports/:reportId/entries` | 获取报告关联 Wiki 条目 | cookie |

### 4.2 `GET /api/v1/research`

用途：给 Web 调研登记簿页面提供完整列表。

查询参数：

- `status`：可选，过滤任务状态。
- `reference`：可选，`true` 时只返回含可参考报告的主题。
- `limit`：默认 50 个主题。

响应：

```json
{
  "data": {
    "topics": [
      {
        "id": "topic_...",
        "name": "Agent 可控性调研",
        "createdAt": 1710000000000,
        "updatedAt": 1710000300000,
        "taskCount": 2,
        "reportCount": 2,
        "referenceReportCount": 1,
        "wikiEntryCount": 5,
        "tasks": [
          {
            "id": "task_...",
            "title": "调研可控性方案",
            "status": "completed",
            "executorId": "feynman",
            "createdAt": 1710000000000,
            "updatedAt": 1710000200000,
            "failureReason": null,
            "reports": [
              {
                "id": "report_...",
                "title": "可控性方案调研报告",
                "reportUri": "feishu://docx/...",
                "isReference": true,
                "wikiEntryCount": 5
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### 4.3 `POST /api/internal/research/register-task`

用途：当用户在对话中发起调研并命名主题，调度层或 Hook 调用该接口登记主题和任务。

请求：

```json
{
  "topicName": "Agent 可控性调研",
  "taskTitle": "调研 Agent 可控性方案",
  "query": "围绕 Agent 可控性机制做竞品和技术方案调研",
  "sourceType": "conversation",
  "sourceRef": "session:main:.../message:...",
  "actorId": "ou_ba47...",
  "executorId": "feynman",
  "metadata": {
    "channel": "feishu"
  }
}
```

行为：

1. 用 `normalized_name` 查找主题。
2. 未命中则创建主题；命中则复用。
3. 创建任务，初始状态为 `running`。
4. 更新主题的 `task_count` 与 `updated_at`。

响应：

```json
{
  "data": {
    "topicId": "topic_...",
    "taskId": "task_...",
    "createdTopic": true
  }
}
```

### 4.4 `PATCH /api/internal/research/tasks/:taskId/status`

用途：Agent 调研状态变化时更新任务。

请求：

```json
{
  "status": "completed",
  "failureReason": null
}
```

规则：

- `running` 可转为 `completed`、`failed`、`cancelled`。
- `completed`、`failed`、`cancelled` 是终态，除修复脚本外不允许回到 `running`。
- 失败和取消必须保留原因。

### 4.5 `POST /api/internal/research/tasks/:taskId/reports`

用途：Agent 产出报告后登记报告。

请求：

```json
{
  "title": "Agent 可控性方案调研报告",
  "reportUri": "feishu://docx/xxx",
  "reportKind": "feishu_doc",
  "contentHash": "sha256:...",
  "metadata": {
    "localBackupPath": "reports/agent-control.md"
  }
}
```

行为：

- 同一 `reportUri` 已存在时更新标题、hash、metadata，不创建重复报告。
- 同一任务允许多份报告。
- 写入报告后更新任务为 `completed`，并更新主题 `report_count`。

### 4.6 `POST /api/v1/research/reports/:reportId/reference`

用途：用户明确把整篇报告标记为【可参考】。

请求：

```json
{
  "confirmedBy": "ou_ba47...",
  "forceReextract": false
}
```

行为：

1. 找到报告并读取整篇内容。
2. 设置 `research_reports.is_reference = 1`，写入确认人和确认时间。
3. 如果同一 `report_id + content_hash` 已有成功批次，直接返回现有入库结果，不重复入库。
4. 如果 `forceReextract = true` 或内容 hash 变化，创建新批次。
5. 调用 LLM 提取关键结论。
6. 用 `persistEntry()` 写入 `entries`。
7. 写入 `research_report_entries` 映射。
8. 批次状态更新为 `completed` 或 `failed`。

响应：

```json
{
  "data": {
    "reportId": "report_...",
    "isReference": true,
    "batchId": "batch_...",
    "status": "completed",
    "entryIds": ["research-...-1", "research-...-2"]
  }
}
```

异常处理：

- 报告不可访问：批次 `failed`，`error_message` 写明不可访问。
- LLM 提取失败：批次 `failed`，保留报告【可参考】标签，但页面显示“入库失败”。
- 质量门禁未通过：批次 `failed` 或 `completed_with_rejections`。为了保持枚举简洁，建议仍用 `failed`，错误里写清被拒条目数。

## 5. 事件与 Hook 集成

### 5.1 调研发起登记

触发源有两类：

- 主会话或调度层在派发调研 Agent 时，已经知道主题名、任务标题、executor。
- Hook 从对话中识别“用户发起调研并命名主题”的事件。

推荐优先让调度层调用内部登记 API。原因：调度层能拿到真实 task id、agent id、来源消息，误判少。Hook 只作为补偿，负责发现未登记的调研语义并写入待确认日志，不直接创建任务。

事件流：

```text
用户发起调研并命名主题
  → 主会话/调度层派 Agent
  → 调用 POST /api/internal/research/register-task
  → Agent 完成报告
  → 调用 POST /api/internal/research/tasks/:taskId/reports
  → Web 页面 3 秒内看到状态和报告
```

### 5.2 状态刷新

FR-D03 要求 3 秒内更新。实现有两种可选方案：

- V1：页面用 SWR/`useApi` 每 3 秒 revalidate。简单可靠，满足验收。
- V2：增加 SSE `/api/v1/research/events`，在状态变化时推送。适合后续减少轮询。

本阶段建议用 V1。页面只读 `/api/v1/research`，每 3 秒刷新一次；用户切换标签页回来时立即刷新。

### 5.3 可参考确认与入库

确认入口来自两类场景：

- 用户在对话里指定“这份报告可参考”。主会话或 Hook 解析到明确 report id / report uri 后调用确认 API。
- Web 页面上的报告详情按钮“标记为【可参考】”。按钮只对已有报告生效，不创建调研任务。

事件流：

```text
用户明确指定报告为【可参考】
  → POST /api/v1/research/reports/:reportId/reference
  → research_reports 标记 is_reference
  → 创建 research_reference_batches
  → LLM 提取关键结论
  → persistEntry 写 entries
  → research_report_entries 建映射
  → Web 显示【可参考】和 Wiki 条目数量
```

## 6. 前端页面结构

### 6.1 路由

复用现有路由：

- `/research`：调研登记簿总览。
- `/research?topic=<topicId>`：可选，定位到指定主题。
- 报告详情可先用展开卡片实现，不强制新路由。

### 6.2 组件层次

```text
ResearchPage
  ResearchHeader
    Title
    RefreshIndicator
  ResearchEmptyState
  ResearchTopicList
    ResearchTopicCard
      TopicSummary
      ResearchTaskList
        ResearchTaskRow
          StatusBadge
          ReportLinkList
            ResearchReportItem
              ReferenceBadge
              WikiEntryCountLink
      TopicTimeline
  ResearchReportDrawer
    ReportMetadata
    ReferenceAction
    ExtractionBatchStatus
    LinkedWikiEntries
```

### 6.3 页面行为

- 默认按主题分组，主题按 `updated_at` 倒序。
- 每个主题展示：主题名、任务数量、报告数量、可参考报告数量、Wiki 条目数量。
- 每个任务展示：任务标题、状态、创建时间、更新时间、执行者标识、失败原因。
- 每份报告展示：标题、报告链接、是否【可参考】、关联 Wiki 条目数量。
- 状态文字固定为：进行中、已完成、失败、已取消。
- 空状态显示“还没有登记的调研报告”，不提供调研发起按钮。
- 页面不展示调研发起面板、调度器入口、自动触发入口、盲区卡片、缺口分析面板。

### 6.4 数据流

```text
ResearchPage
  → useApi('/api/v1/research', { refreshInterval: 3000 })
  → topics[]
  → ResearchTopicCard 渲染
  → 用户点报告
  → GET /api/v1/research/reports/:reportId
  → 用户点【标记为可参考】
  → POST /api/v1/research/reports/:reportId/reference
  → mutate('/api/v1/research')
```

## 7. LLM 提取方案

### 7.1 调用方式

LLM 调用读取 `openclaw.json` 中已配置 provider，优先使用 KIVO 已有的 LLM provider 解析逻辑。不得在代码里写死单一 provider key。Embedding 仍通过 `persistEntry()` 触发本机 `localhost:9876`。

### 7.2 输入

输入必须是整篇报告，不按段落让用户确认。Prompt 里给出结构化约束：

```text
你是 KIVO 的调研报告入库助手。
任务：从一篇用户已确认【可参考】的完整调研报告中提取可沉淀的关键结论。

要求：
- 只基于报告内容提取，不补充报告外事实。
- 每条结论必须能回溯到报告中的具体段落或标题。
- 输出 JSON，不输出解释文本。
- 条目类型只能从 fact、decision、methodology、experience、reference 中选择。
- 不确定、证据不足、纯观点未给依据的内容不要入库。
- 每条结论包含 title、summary、content、type、confidence、evidence、tags。
- confidence 低于 0.7 的条目不要输出。

上下文：
主题：<topicName>
报告标题：<reportTitle>
报告链接：<reportUri>
确认人：<confirmedBy>
报告全文：
<reportContent>
```

输出 JSON：

```json
{
  "reportSummary": "...",
  "entries": [
    {
      "title": "...",
      "summary": "...",
      "content": "...",
      "type": "fact",
      "confidence": 0.86,
      "evidence": "报告中的标题或原文摘录",
      "tags": ["research", "reference-report"]
    }
  ]
}
```

### 7.3 入库映射

每个 LLM entry 转成 `KnowledgeEntry`：

- `id`：`research-${reportId}-${batchId}-${index}`。
- `source.type`：`research`。
- `source.reference`：报告 URI。
- `source.context`：`${topicId}/${reportId}/${batchId}`。
- `confidence`：LLM 输出值。
- `metadata.domainData.valueAssessment`：标记为用户确认报告来源，说明确认粒度是整篇报告。
- `metadata.research`：保存 topic/report/batch/evidence。

写入失败必须记录在 batch 的 `error_message`，页面显示“入库失败：原因”。不得只在服务端日志里报错。

### 7.4 重复确认策略

- 同一 report + 同一 content_hash 已有成功 batch：直接返回已有 batch 和 entry 映射。
- 同一 report 但 content_hash 改变：提示“报告内容已变化，需要重新确认”，用户确认后创建新 batch。
- `forceReextract = true`：创建新 batch，新 entry 可通过 `supersedes` 或 metadata 关联旧 entry。

## 8. 任务拆分建议

依赖关系：

```text
A. 数据模型与迁移
  ├─ B. 后端仓储与内部登记 API
  │    ├─ C. Agent/Hook 调用接入
  │    └─ D. Web 读取 API
  ├─ E. 可参考确认与 LLM 入库
  │    └─ F. Wiki 追溯映射 API
  └─ G. 前端调研登记簿页面
       └─ H. 3 秒刷新与状态验收

I. 测试与审计 依赖 B/D/E/G/H
```

### A. 数据模型与迁移

产出：迁移脚本或初始化函数，创建 `research_topics`、升级 `research_tasks`、新增 `research_reports`、`research_reference_batches`、`research_report_entries`。

验收：SQLite schema 可查；旧 `research_tasks` 数据可迁移到默认主题或按 title 生成主题；外键开启后插入/删除符合预期。

### B. 后端仓储与内部登记 API

产出：`research-db` 仓储函数和内部 API。

验收：新主题创建、同名主题复用、任务登记、状态流转、失败原因记录全部可通过接口读取。

### C. Agent/Hook 调用接入

产出：调度层在派发调研任务时调用登记 API；任务完成后调用报告登记 API。

验收：一次真实 Agent 调研能在 Web 页面出现进行中 → 已完成 → 报告链接。

### D. Web 读取 API

产出：`GET /api/v1/research` 返回按主题分组的数据结构。

验收：多主题、多任务、多报告、空状态都能返回稳定 JSON。

### E. 可参考确认与 LLM 入库

产出：报告确认 API、LLM 提取、`persistEntry()` 入库、批次去重。

验收：两份报告只确认一份时，只有被确认报告显示【可参考】并生成 Wiki 条目；重复确认不重复膨胀。

### F. Wiki 追溯映射 API

产出：报告 → Wiki entry 列表接口。

验收：页面能从主题进入报告，再看到对应 Wiki 条目入口。

### G. 前端调研登记簿页面

产出：替换现有调研发起式页面，改成只读登记簿。

验收：页面没有调研发起面板、调度器入口、盲区卡片、缺口分析面板；按主题分组展示任务、报告、标签和入口。

### H. 3 秒刷新

产出：页面定时 revalidate 或 SSE。

验收：模拟任务状态变化，页面 3 秒内展示最新状态。

### I. 测试与审计

产出：仓储单测、API 测试、页面验收测试、一次真实链路 smoke test。

验收：FR-D01/D02/D03 的 AC 全部可用测试或手工步骤验证。

## 9. 实施注意点

- `web/app/api/v1/research/route.ts` 当前从 `domain-stores` 导入，部分能力是内存态；后续应统一改成 SQLite 仓储，避免页面读取不到真实 `kivo.db` 状态。
- `web/app/(dashboard)/research/page.tsx` 当前包含新增任务、暂停、优先级等调度语义；FR-D03 要求登记簿只展示和追溯，需删除这些入口。
- `adoptResearchTask()` 现有实现会基于整篇报告生成固定两条 entry；新实现应改为 LLM 结构化提取，并增加批次去重与失败可见。
- 内部登记 API 不应加入公开白名单；用内部 token 校验。
- 页面状态标签要用文字做主表达，颜色只做辅助，保证白底黑字。
- 所有报告入库失败都要落库，页面可见，不得只写日志。
