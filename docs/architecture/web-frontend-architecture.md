# KIVO Web 前端重构架构

OpenClaw（sa-02 子Agent）| 2026-05-23

---

## 目录

1. 页面路由结构
2. 数据流设计
3. API 端点清单
4. 现有代码处置清单

---

## 1. 页面路由结构

### 1.1 一级导航与路由映射

UX 设计定义 8 个一级页面，侧边栏不分组，直接平铺。路由全部位于 `app/(dashboard)/` 路由组下，共享 `DashboardLayout`。

| 导航项 | 路由路径 | 页面文件 | 说明 |
|--------|----------|----------|------|
| 仪表盘 | `/dashboard` | `app/(dashboard)/dashboard/page.tsx` | 保留现有路由 |
| 意图知识库 | `/intents` | `app/(dashboard)/intents/page.tsx` | 新路由，替代当前 `/knowledge` |
| 领域知识库 | `/domain` | `app/(dashboard)/domain/page.tsx` | 新路由，合并当前 `/wiki` + `/wiki/materials` |
| 知识搜索 | `/search` | `app/(dashboard)/search/page.tsx` | 保留现有路由 |
| 知识图谱 | `/graph` | `app/(dashboard)/graph/page.tsx` | 保留现有路由 |
| 调研队列 | `/research` | `app/(dashboard)/research/page.tsx` | 保留现有路由 |
| 系统 | `/system` | `app/(dashboard)/system/page.tsx` | 新路由，吸收 activity/governance/imports |
| 设置 | `/settings` | `app/(dashboard)/settings/page.tsx` | 保留现有路由，扩展子页面 |

### 1.2 嵌套路由

#### 意图知识库

```
app/(dashboard)/intents/
├── page.tsx                    # 意图知识列表（表格+筛选+语义搜索）
└── [id]/
    └── page.tsx                # 意图知识详情（正文、正例负例、来源、版本历史、关联）
```

#### 领域知识库

```
app/(dashboard)/domain/
├── page.tsx                    # 领域空间列表 + 当前领域的目录树/标签云/条目列表
├── materials/
│   └── page.tsx                # 材料库（紧凑表格，批量操作，处理状态）
├── [spaceId]/
│   ├── page.tsx                # 领域详情（目录树+条目列表+Wiki页面）
│   └── entries/
│       └── [entryId]/
│           └── page.tsx        # 知识条目详情（正文、来源链路、图谱入口、版本）
└── wiki/
    └── [pageId]/
        └── page.tsx            # Wiki 页面展示（编译产物，可追溯原子知识）
```

#### 系统

```
app/(dashboard)/system/
├── page.tsx                    # 默认重定向到操作日志
├── activity/
│   └── page.tsx                # 操作日志（事件列表+筛选+详情展开）
├── status/
│   └── page.tsx                # 运行状态（服务健康、向量化、图谱更新）
├── imports/
│   └── page.tsx                # 导入记录（历史导入批次+状态+产出）
└── governance/
    └── page.tsx                # 治理摘要（合并、清理、冲突处理记录）
```

#### 设置

```
app/(dashboard)/settings/
├── page.tsx                    # 设置首页（子入口列表）
├── account/
│   └── page.tsx                # 账号与密码（修改密码、会话管理）
├── dictionary/
│   └── page.tsx                # 系统词典（术语CRUD、scope筛选）
├── permissions/
│   └── page.tsx                # 权限范围（只读展示知识域和角色）
└── import-export/
    └── page.tsx                # 导入导出（JSON导出、导入干跑预览）
```

#### 知识图谱

```
app/(dashboard)/graph/
├── page.tsx                    # 图谱主视图（全局/领域子图/冲突/来源/时间回放）
└── error.tsx                   # 图谱错误边界（已有）
```

动态路由参数：图谱页面通过 URL searchParams 传递筛选状态（`?schema=probstat&domain=概率论&type=fact`），不使用动态路由段。

### 1.3 动态路由参数汇总

| 路由 | 动态参数 | 类型 | 说明 |
|------|----------|------|------|
| `/intents/[id]` | `id` | string (UUID) | 意图知识条目 ID |
| `/domain/[spaceId]` | `spaceId` | string (UUID) | 领域空间 ID |
| `/domain/[spaceId]/entries/[entryId]` | `spaceId`, `entryId` | string (UUID) | 领域下的知识条目 |
| `/domain/wiki/[pageId]` | `pageId` | string | Wiki 页面 ID（如 `kivo-wiki-probstat-02`） |
| `/system/governance/[id]` | `id` | string | 治理报告 ID |

### 1.4 重定向规则

| 旧路径 | 新路径 | 方式 |
|--------|--------|------|
| `/knowledge` | `/intents` | next.config.js redirects |
| `/knowledge/[id]` | `/intents/[id]` | next.config.js redirects |
| `/wiki` | `/domain` | next.config.js redirects |
| `/wiki/materials` | `/domain/materials` | next.config.js redirects |
| `/activity` | `/system/activity` | next.config.js redirects |
| `/governance` | `/system/governance` | next.config.js redirects |
| `/governance/[id]` | `/system/governance/[id]` | next.config.js redirects |


---

## 2. 数据流设计

### 2.1 总体策略

| 策略 | 选型 | 理由 |
|------|------|------|
| 数据获取 | SWR（已在用） | 客户端获取 + 自动重验证 + 缓存，适合频繁变化的知识数据 |
| 状态管理 | React state + Zustand（已有 workbench-store） | 页面级状态用 useState，跨页面共享用 Zustand |
| 服务端渲染 | 不使用 RSC 数据获取 | 当前架构全部 `'use client'`，保持一致；认证依赖客户端 cookie |
| 实时更新 | SSE（已有 activity/stream） | 操作日志、材料处理进度用 SSE 推送 |
| 表单状态 | React state + 乐观更新 | 编辑知识条目时先更新 UI 再等后端确认 |

### 2.2 各页面数据流

#### 仪表盘 `/dashboard`

```
数据源：
  GET /api/v1/dashboard/summary → 核心指标（总量、命中率、类型分布、健康度）
  GET /api/v1/activity?limit=10 → 最近活动
  GET /api/v1/dashboard/health → 健康度评估（新增）

获取时机：页面挂载时 SWR 并发请求
刷新策略：revalidateOnFocus + 60s 轮询间隔
状态管理：页面级 useState，无需跨页面共享
```

以 probstat 为例：仪表盘显示"活跃条目 137 条""本周命中率 72%""知识类型 6 种"，这些数字来自 `/api/v1/dashboard/summary` 对 entries 表的实时聚合。

#### 意图知识库 `/intents`

```
数据源：
  GET /api/v1/intents?type=&function=&source=&page=&pageSize= → 意图知识列表
  GET /api/v1/intents/[id] → 条目详情
  GET /api/v1/intents/[id]/stats → 注入统计
  POST /api/v1/search → 语义搜索（scope=intent）

获取时机：列表页挂载 + 筛选变化时重新请求
刷新策略：revalidateOnFocus
状态管理：
  - 筛选条件 → URL searchParams（可分享、可后退）
  - 列表数据 → SWR cache
  - 编辑表单 → 页面级 useState
  - 批量选择 → 页面级 useState (Set<string>)
```

#### 领域知识库 `/domain`

```
数据源：
  GET /api/v1/wiki/spaces → 领域空间列表
  GET /api/v1/wiki/spaces/[id]/directories → 目录树
  GET /api/v1/wiki/spaces/[id]/entries?dir=&tag=&page= → 条目列表
  GET /api/v1/knowledge/[id] → 条目详情
  GET /api/v1/knowledge/[id]/content → 条目正文+来源链路
  GET /api/v1/wiki/materials → 材料列表
  GET /api/v1/wiki/materials/[id] → 材料详情+产出链路
  POST /api/v1/wiki/upload → 文件上传
  SSE /api/v1/wiki/materials/[id]/progress → 处理进度（新增）

获取时机：
  - 空间列表：页面挂载
  - 目录树：选中空间后
  - 条目列表：选中目录或标签后
  - 材料进度：上传后自动订阅 SSE

刷新策略：
  - 空间/目录树：revalidateOnFocus
  - 材料列表：处理中时 5s 轮询，完成后停止
  - 条目列表：revalidateOnFocus

状态管理：
  - 当前空间 ID → URL searchParams
  - 当前目录路径 → URL searchParams
  - 浏览模式（目录树/标签云）→ localStorage + Zustand
  - 批量选择 → 页面级 useState
  - 上传队列 → 页面级 useState
```

以 probstat 为例的完整数据流：

1. 用户打开领域知识库，`GET /api/v1/wiki/spaces` 返回 `[{id: "xxx", name: "概率论与数理统计"}]`
2. 点击该空间，`GET /api/v1/wiki/spaces/xxx/directories` 返回章节目录树
3. 点击"第二章 随机变量"目录，`GET /api/v1/wiki/spaces/xxx/entries?dir=ch02` 返回该章节下的知识条目
4. 点击条目"贝叶斯公式"，跳转 `/domain/xxx/entries/yyy`，`GET /api/v1/knowledge/yyy/content` 返回正文+来源定位（PDF 第 45 页）
5. 条目详情页展示 Wiki 页面链接 `kivo-wiki-probstat-02`，点击跳转 `/domain/wiki/kivo-wiki-probstat-02`

#### 知识搜索 `/search`

```
数据源：
  POST /api/v1/search → 语义搜索（跨意图+领域）
  GET /api/v1/search/history → 搜索历史（新增，存 localStorage 备选）
  GET /api/v1/graph?entryId= → 图谱邻居（搜索结果侧边）

获取时机：用户提交搜索后
刷新策略：不自动刷新，用户主动搜索触发
状态管理：
  - 搜索词 → URL searchParams
  - 筛选条件 → URL searchParams
  - 搜索结果 → SWR cache（key 含搜索词+筛选）
  - 搜索历史 → localStorage
```

#### 知识图谱 `/graph`

```
数据源：
  GET /api/v1/graph → 图谱快照（nodes + edges）
  GET /api/v1/graph/snapshot → 带时间戳的快照（时间回放）
  GET /api/v1/graph?schema=&domain=&type= → 按模式/领域/类型筛选

获取时机：页面挂载 + 筛选变化
刷新策略：不自动刷新（图谱数据量大，手动刷新按钮）
状态管理：
  - 筛选条件（schema/domain/type/时间）→ URL searchParams
  - 选中节点 → 页面级 useState
  - 视图模式（全局/领域/冲突/来源/时间）→ URL searchParams
  - 图谱布局状态 → useRef（D3/force-graph 内部状态）
  - 缩放/平移 → useRef
```

图谱模式扩展支持：API 层通过 `schema` 参数筛选节点和边。默认 `schema=*` 显示全部，`schema=generic` 只看通用关系，`schema=probstat` 只看学科模式节点（Course/Chapter/KnowledgePoint）和关系（prerequisite_of/covers/belongs_to）。前端图谱页面顶部增加模式切换：全部 / 通用 / 学科（动态从 API 获取可用 schema 列表）。

#### 调研队列 `/research`

```
数据源：
  GET /api/v1/research → 调研任务列表
  GET /api/v1/research/queue → 队列状态统计
  POST /api/v1/research/[id]/adopt → 采纳入库（新增）
  POST /api/v1/research/[id]/highlight → 标记重点（新增）
  POST /api/v1/research/[id]/archive → 归档（新增）

获取时机：页面挂载
刷新策略：revalidateOnFocus + 进行中任务 30s 轮询
状态管理：
  - 状态筛选 → URL searchParams
  - 展开的任务详情 → 页面级 useState
```

#### 系统 `/system`

```
数据源：
  GET /api/v1/activity?type=&date= → 操作日志
  SSE /api/v1/activity/stream → 实时日志推送
  GET /api/v1/status/is-fresh → 系统新鲜度
  GET /api/v1/imports → 导入记录
  GET /api/v1/governance/reports → 治理摘要

获取时机：进入对应子页面时
刷新策略：
  - 操作日志：SSE 实时 + 断线后 10s 轮询降级
  - 运行状态：30s 轮询
  - 导入记录/治理摘要：revalidateOnFocus

状态管理：
  - 日志筛选 → URL searchParams
  - SSE 连接状态 → 页面级 useState
```

#### 设置 `/settings`

```
数据源：
  GET /api/v1/dictionary → 系统词典
  GET /api/auth/sessions → 会话列表
  POST /api/auth/change-password → 修改密码
  GET /api/v1/knowledge/export?domain=&type=&from=&to= → 导出（新增）
  POST /api/v1/knowledge/import/dry-run → 导入干跑（新增）
  POST /api/v1/knowledge/import → 确认导入（新增）

获取时机：进入对应子页面时
刷新策略：revalidateOnFocus
状态管理：页面级 useState
```

### 2.3 跨页面共享状态（Zustand workbench-store）

保留现有 `useWorkbenchStore` 的职责，扩展以下字段：

```typescript
interface WorkbenchState {
  // 已有
  hasHydrated: boolean;

  // 新增
  currentSpaceId: string | null;       // 当前选中的领域空间
  domainViewMode: 'tree' | 'tags';     // 领域知识库浏览模式
  graphSchema: string;                  // 当前图谱模式筛选
  sidebarCollapsed: boolean;           // 侧边栏折叠状态
}
```


---

## 3. API 端点清单

### 3.1 需要新增的 API

| 路径 | 方法 | 入参 | 出参 | 说明 |
|------|------|------|------|------|
| `/api/v1/dashboard/health` | GET | — | `{ level: 'healthy'|'attention'|'error', issues: Issue[] }` | 健康度评估，聚合失败导入/孤立节点/检索异常 |
| `/api/v1/intents` | GET | `?type=&function=&source=&domain=&page=&pageSize=&q=` | `{ data: IntentEntry[], meta: Pagination }` | 意图知识列表（独立于领域知识） |
| `/api/v1/intents/[id]` | GET | — | `{ data: IntentEntryDetail }` | 意图知识详情（含正例负例、相似句、版本历史） |
| `/api/v1/intents/[id]` | PUT | `{ content, type, function, domain, examples }` | `{ data: IntentEntry }` | 编辑意图知识 |
| `/api/v1/intents/[id]` | DELETE | — | `{ success: true }` | 删除意图知识（二次确认在前端） |
| `/api/v1/wiki/spaces/[id]/entries` | GET | `?dir=&tag=&type=&page=&pageSize=&q=` | `{ data: DomainEntry[], meta: Pagination }` | 领域空间下的知识条目列表 |
| `/api/v1/wiki/materials/[id]/progress` | GET (SSE) | — | SSE events: `{ stage, percent, output }` | 材料处理进度实时推送 |
| `/api/v1/graph/schemas` | GET | — | `{ data: SchemaInfo[] }` | 可用图谱模式列表（generic, probstat, ...） |
| `/api/v1/research/[id]/adopt` | POST | `{ targetSpaceId?, targetDir? }` | `{ data: { entryIds: string[], wikiPageIds: string[] } }` | 采纳调研报告入库 |
| `/api/v1/research/[id]/highlight` | POST | `{ highlighted: boolean }` | `{ success: true }` | 标记/取消重点 |
| `/api/v1/research/[id]/archive` | POST | — | `{ success: true }` | 归档调研任务 |
| `/api/v1/knowledge/export` | GET | `?domain=&type=&from=&to=&format=json` | 文件下载 (application/json) | 知识导出 |
| `/api/v1/knowledge/import/dry-run` | POST | multipart (JSON file) | `{ willCreate: N, conflicts: N, rejected: N, details: [] }` | 导入干跑预览 |
| `/api/v1/knowledge/import/confirm` | POST | `{ dryRunId }` | `{ imported: N, skipped: N }` | 确认导入 |
| `/api/v1/system/status` | GET | — | `{ vectorize: Status, graph: Status, extraction: Status }` | 各子系统运行状态 |

### 3.2 需要修改的现有 API

| 路径 | 修改内容 |
|------|----------|
| `GET /api/v1/graph` | 新增 `schema` 查询参数，支持按图谱模式筛选节点和边；响应中 node 对象增加 `schemaId` 字段 |
| `GET /api/v1/graph/snapshot` | 同上，支持 `schema` 筛选 |
| `GET /api/v1/dashboard/summary` | 增加 `intentCount` / `domainCount` 分类统计；增加 `weeklyDelta` 字段；增加 `healthLevel` |
| `GET /api/v1/activity` | 增加 `type` 筛选参数（knowledge_change / import / research / system）；增加 `date` 范围筛选 |
| `GET /api/v1/research` | 响应增加 `highlighted` / `adoptedAt` / `archivedAt` 字段；增加 `status` 筛选支持 `adopted` / `archived` |
| `GET /api/v1/wiki/materials` | 响应增加 `stage`（waiting/parsing/extracting/done/failed）和 `progress` 百分比字段 |
| `GET /api/v1/wiki/materials/[id]` | 响应增加完整产出链路：`{ parsedPages, segments, candidateEntries, entries, wikiPages, graphNodes, injectionCount }` |
| `GET /api/v1/knowledge/[id]/content` | 响应增加 `sourceLocation`（PDF页码/音频时间戳/文本段落定位）和 `wikiPageId` |
| `GET /api/v1/search` | 增加 `scope` 参数（`all` / `intent` / `domain`）；响应增加 `graphNeighbors` 字段 |
| `GET /api/v1/wiki/spaces` | 响应增加每个空间的 `entryCount` / `materialCount` / `wikiPageCount` 统计 |

### 3.3 现有 API 保持不变

以下 API 无需修改，直接复用：

- `POST /api/auth/login` / `POST /api/auth/logout` / `POST /api/auth/register`
- `POST /api/auth/change-password`
- `GET /api/auth/sessions` / `DELETE /api/auth/sessions/[id]`
- `GET /api/v1/dictionary` / `POST /api/v1/dictionary`
- `GET /api/v1/conflicts` / `POST /api/v1/conflicts/[id]/resolve`
- `POST /api/v1/wiki/upload`
- `POST /api/v1/wiki/materials/[id]/reprocess`
- `DELETE /api/v1/wiki/materials/[id]`
- `GET /api/v1/governance` / `GET /api/v1/governance/reports`
- `POST /api/v1/governance/[id]/rollback`
- `GET /api/v1/imports` / `GET /api/v1/imports/[id]`
- `SSE /api/v1/activity/stream`

### 3.4 后端 SDK 调用映射

API route handlers 调用 KIVO 核心 SDK（`@kivo/core`）的映射关系：

| API 路径 | SDK 调用 |
|----------|----------|
| `/api/v1/intents` | `kivo.entries.list({ nature: 'intent', ...filters })` |
| `/api/v1/intents/[id]` | `kivo.entries.get(id)` + `kivo.entries.getHistory(id)` |
| `/api/v1/wiki/spaces/[id]/entries` | `kivo.entries.list({ spaceId, ...filters })` |
| `/api/v1/dashboard/health` | `kivo.analytics.healthCheck()` |
| `/api/v1/graph?schema=` | `kivo.graph.getSnapshot({ schemaId })` |
| `/api/v1/graph/schemas` | `kivo.graph.listSchemas()` |
| `/api/v1/research/[id]/adopt` | `kivo.research.adopt(id, options)` |
| `/api/v1/knowledge/export` | `kivo.entries.export(filters)` |
| `/api/v1/knowledge/import/dry-run` | `kivo.entries.importDryRun(file)` |
| `/api/v1/knowledge/import/confirm` | `kivo.entries.importConfirm(dryRunId)` |
| `/api/v1/system/status` | `kivo.system.getStatus()` |
| `/api/v1/wiki/materials/[id]/progress` | `kivo.materials.streamProgress(id)` |


---

## 4. 现有代码处置清单

### 4.1 保留并改造的页面/组件

| 文件 | 改造内容 |
|------|----------|
| `app/(dashboard)/dashboard/page.tsx` | 增加健康度卡片、最近活动区、下一步建议区；指标可点击下钻；增加本周新增对比 |
| `app/(dashboard)/search/page.tsx` | 增加 `scope` 切换（全部/意图/领域）；结果侧边增加图谱邻居；增加搜索历史 |
| `app/(dashboard)/graph/page.tsx` | 顶部增加模式切换（全部/通用/学科）；左侧筛选增加 schema 维度；节点详情增加"查看来源材料"入口 |
| `app/(dashboard)/research/page.tsx` | 去掉新建调研表单；增加采纳/重点/归档操作；增加采纳后产出链路展示 |
| `app/(dashboard)/settings/page.tsx` | 改为设置首页（子入口卡片列表），不再直接展示内容 |
| `app/(dashboard)/settings/dictionary/page.tsx` | 保留，增加 scope 筛选和别名管理 |
| `app/(dashboard)/settings/security/page.tsx` | 保留，重命名为"账号与密码" |
| `app/(dashboard)/layout.tsx` | 保留，无需改动 |
| `components/app-shell.tsx` | 重写导航结构：去掉分组，改为 8 个平铺一级入口 + 系统/设置可展开子项 |
| `components/knowledge-graph/KnowledgeGraphView.tsx` | 增加 schema 感知：不同 schema 的节点用不同形状/颜色渲染 |
| `components/knowledge-graph/TimelineSlider.tsx` | 保留，无需改动 |
| `components/wiki/space-manager.tsx` | 改造为领域知识库主组件：增加目录树模式/标签云模式切换；增加材料库入口 |
| `components/wiki/file-uploader.tsx` | 保留，增加批量拖拽和格式分布预览 |
| `components/ui/page-states.tsx` | 保留，空状态文案按 UX 设计更新为中文人话 |
| `hooks/use-api.ts` | 保留，无需改动 |
| `lib/client-api.ts` | 保留，无需改动 |
| `lib/workbench-store.ts` | 扩展：增加 currentSpaceId / domainViewMode / graphSchema 字段 |
| `lib/i18n-labels.ts` | 扩展：增加意图功能标签、材料阶段标签、健康度标签的中文映射 |
| `contexts/cognitive-mode-context.tsx` | 保留，无需改动 |

### 4.2 需要删除的页面/组件

| 文件 | 删除原因 |
|------|----------|
| `app/(dashboard)/activity/page.tsx` | 活动流移入 `/system/activity`，不再作为一级页面 |
| `app/(dashboard)/timeline/page.tsx` | 功能合并到图谱的时间回放视图 |
| `app/(dashboard)/gaps/page.tsx` | 知识缺口展示合并到仪表盘健康度卡片 + 图谱洞察标记 |
| `app/(dashboard)/artifacts/page.tsx` | 产物展示合并到领域知识库的材料详情产出链路 |
| `app/(dashboard)/review/page.tsx` | 审核功能合并到意图知识库的编辑流程 |
| `app/(dashboard)/rules/page.tsx` | 规则展示合并到意图知识库（type=规则） |
| `app/(dashboard)/analytics/` (整个目录) | 分析指标合并到仪表盘 |
| `app/(dashboard)/governance/` (整个目录) | 治理功能移入 `/system/governance` |
| `app/(dashboard)/knowledge/` (整个目录) | 意图知识迁移到 `/intents`，路由重定向 |
| `app/(dashboard)/wiki/` (整个目录) | 领域知识迁移到 `/domain`，路由重定向 |
| `app/api/v1/artifacts/` | 前端不再有独立产物页面 |
| `app/api/v1/gaps/` | 前端不再有独立缺口页面 |
| `app/api/v1/rules/alerts/` | 合并到意图知识 API |
| `app/api/rules/alerts/` | 旧版 API，已有 v1 版本 |
| `app/api/wiki/` (非 v1 版本) | 旧版 wiki API，统一走 `/api/v1/wiki/` |
| `app/api/intent/` | 旧版 intent API，统一走 `/api/v1/intents/` |
| `app/api/knowledge/` (非 v1 版本) | 旧版 API，统一走 `/api/v1/knowledge/` |
| `components/onboarding-guide-card.tsx` | 引导卡片重新设计，融入仪表盘空状态 |
| `components/onboarding-journey.tsx` | 同上 |
| `components/timeline-playback.tsx` | 功能移入图谱组件内部 |
| `components/cognitive-mode-switcher.tsx` | 认知模式切换不在 UX 设计范围内，移除 |
| `components/cognitive-panel.tsx` | 同上 |
| `contexts/cognitive-mode-context.tsx` | 同上（前面标记保留有误，此处以删除为准） |

注：`cognitive-mode` 相关组件是否保留取决于产品决策。UX 设计文档未提及认知模式，如果产品确认保留则不删除，但从导航中移除入口。

### 4.3 需要新建的页面/组件

| 文件 | 职责 |
|------|------|
| `app/(dashboard)/intents/page.tsx` | 意图知识列表页（表格+筛选+语义搜索） |
| `app/(dashboard)/intents/[id]/page.tsx` | 意图知识详情页（正文、正例负例、来源、版本、关联） |
| `app/(dashboard)/domain/page.tsx` | 领域知识库主页（空间列表+目录树/标签云+条目列表） |
| `app/(dashboard)/domain/materials/page.tsx` | 材料库页面（紧凑表格+批量操作+处理状态） |
| `app/(dashboard)/domain/[spaceId]/page.tsx` | 领域详情页（目录树+条目列表+Wiki入口） |
| `app/(dashboard)/domain/[spaceId]/entries/[entryId]/page.tsx` | 领域知识条目详情（正文+来源链路+图谱入口） |
| `app/(dashboard)/domain/wiki/[pageId]/page.tsx` | Wiki 页面展示（编译产物+原子知识追溯） |
| `app/(dashboard)/system/page.tsx` | 系统首页（重定向到操作日志） |
| `app/(dashboard)/system/activity/page.tsx` | 操作日志（从现有 activity 页面迁移改造） |
| `app/(dashboard)/system/status/page.tsx` | 运行状态（向量化/图谱/提取各子系统状态） |
| `app/(dashboard)/system/imports/page.tsx` | 导入记录（从现有 imports API 数据展示） |
| `app/(dashboard)/system/governance/page.tsx` | 治理摘要（从现有 governance 页面迁移） |
| `app/(dashboard)/settings/account/page.tsx` | 账号与密码（从 security 页面迁移改造） |
| `app/(dashboard)/settings/permissions/page.tsx` | 权限范围（只读展示） |
| `app/(dashboard)/settings/import-export/page.tsx` | 导入导出（干跑预览+确认导入+范围导出） |
| `components/domain/space-list.tsx` | 领域空间列表组件 |
| `components/domain/directory-tree.tsx` | 目录树组件（支持拖拽排序、右键菜单） |
| `components/domain/tag-cloud-view.tsx` | 标签云浏览组件（频次排序+多标签组合筛选） |
| `components/domain/material-table.tsx` | 材料紧凑表格组件（状态、进度、批量操作） |
| `components/domain/source-chain.tsx` | 来源链路可视化组件（文件→解析→分段→知识→Wiki→图谱） |
| `components/domain/wiki-page-view.tsx` | Wiki 页面渲染组件（结构化展示+原子知识追溯） |
| `components/intents/intent-detail.tsx` | 意图知识详情组件（正例负例、相似句、版本历史） |
| `components/intents/intent-editor.tsx` | 意图知识编辑组件（内联编辑+冲突检查反馈） |
| `components/dashboard/health-card.tsx` | 健康度卡片组件（三级状态+问题列表+下钻入口） |
| `components/dashboard/recent-activity.tsx` | 最近活动组件（事件列表+类型筛选） |
| `components/dashboard/next-action.tsx` | 下一步建议组件（基于真实状态推荐动作） |
| `components/research/adopt-dialog.tsx` | 采纳入库对话框（选择目标空间+确认） |
| `components/research/closure-chain.tsx` | 采纳后产出链路展示（报告→拆解→条目→Wiki→图谱） |
| `components/system/event-log.tsx` | 操作日志组件（SSE实时+断线降级+日期分组） |
| `components/system/system-status.tsx` | 系统状态组件（各子系统健康指示器） |
| `app/api/v1/dashboard/health/route.ts` | 健康度评估 API |
| `app/api/v1/intents/route.ts` | 意图知识列表 API |
| `app/api/v1/intents/[id]/route.ts` | 意图知识详情/编辑/删除 API |
| `app/api/v1/graph/schemas/route.ts` | 图谱模式列表 API |
| `app/api/v1/research/[id]/adopt/route.ts` | 采纳入库 API |
| `app/api/v1/research/[id]/highlight/route.ts` | 标记重点 API |
| `app/api/v1/research/[id]/archive/route.ts` | 归档 API |
| `app/api/v1/knowledge/export/route.ts` | 知识导出 API |
| `app/api/v1/knowledge/import/dry-run/route.ts` | 导入干跑 API |
| `app/api/v1/knowledge/import/confirm/route.ts` | 确认导入 API |
| `app/api/v1/system/status/route.ts` | 系统状态 API |
| `app/api/v1/wiki/materials/[id]/progress/route.ts` | 材料处理进度 SSE API |
| `app/api/v1/wiki/spaces/[id]/entries/route.ts` | 领域空间条目列表 API |

### 4.4 迁移策略

执行顺序建议：

1. 先建新路由骨架（空页面 + 基础布局），确保路由可访问
2. 改造 `app-shell.tsx` 导航结构，切换到新 8 项平铺导航
3. 配置 `next.config.js` 重定向规则，旧路径自动跳转新路径
4. 逐页面迁移：从现有页面提取逻辑到新路由，复用已有组件
5. 新增 API route handlers
6. 最后删除旧页面文件

每一步都保持可构建、可运行，不做大爆炸式重构。

