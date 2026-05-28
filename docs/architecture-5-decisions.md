# KIVO 5 项决策架构设计

OpenClaw(sa-01 子Agent)| 2026-05-25

---

## A1: 领域知识库顶层固定二分结构

### Schema 变更

```sql
-- 新增顶层固定节点(seed data,不可删除)
INSERT INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, status)
VALUES
  ('root-general', NULL, '通用知识', 'subject', 'system', strftime('%s','now'), 0, 'active'),
  ('root-discipline', NULL, '学科知识', 'subject', 'system', strftime('%s','now'), 0, 'active');

ALTER TABLE subject_nodes ADD COLUMN deletable INTEGER NOT NULL DEFAULT 1;
UPDATE subject_nodes SET deletable = 0 WHERE id IN ('root-general', 'root-discipline');
```

### API 变更

- `GET /api/subjects` 响应新增 `isSystemRoot: boolean`
- `DELETE /api/subjects/:id` 拒绝 `deletable=0` 节点(403)
- `POST /api/subjects` 创建时 `parent_id` 必须属于两个 root 之一的子树

### 数据迁移

1. 插入两个 root 节点
2. 现有 level=0 非"通用学习资料"节点 → `parent_id='root-discipline'`, level += 1
3. "通用学习资料"节点 → `parent_id='root-general'`, level = 1
4. 所有子节点 level 递增 1

### 模块边界

- `src/cli/init.ts` — seed 逻辑
- `web/app/api/subjects/route.ts` — CRUD 守卫
- `src/pipeline/classifier.ts` — 分类时选择 root 分支

---

## B1: Subject Node 收编 Wiki Directory + 多对多关系表

### Schema 变更

```sql
CREATE TABLE material_subjects (
  material_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary',  -- 'primary' | 'secondary'
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (material_id, subject_id)
);
CREATE INDEX idx_material_subjects_subject ON material_subjects(subject_id);

CREATE TABLE entry_subjects (
  entry_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary',
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, subject_id)
);
CREATE INDEX idx_entry_subjects_subject ON entry_subjects(subject_id);

CREATE TABLE wiki_page_entries (
  wiki_page_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'contains',  -- 'contains' | 'references'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wiki_page_id, entry_id)
);
CREATE INDEX idx_wiki_page_entries_entry ON wiki_page_entries(entry_id);

-- subject_nodes 收编 wiki directory
ALTER TABLE subject_nodes ADD COLUMN wiki_directory_id TEXT;
```

### API 变更

- `GET /api/subjects/:id` 新增 `materials: [{id, role}]`, `entries: [{id, role}]`
- `POST /api/subjects/:id/materials` — 关联 material(支持 role)
- `DELETE /api/subjects/:id/materials/:materialId` — 解除关联
- `GET /api/v1/wiki/pages/:slug` 新增 `relatedEntries: [{id, title, relation}]`
- `POST /api/v1/wiki/pages/:id/entries` — 关联 entry 到 wiki page

### 数据迁移

```sql
INSERT INTO material_subjects (material_id, subject_id, role)
SELECT id, subject_node_id, 'primary' FROM materials WHERE subject_node_id IS NOT NULL;

INSERT INTO entry_subjects (entry_id, subject_id, role)
SELECT id, subject_id, 'primary' FROM entries WHERE subject_id IS NOT NULL;
```

旧字段保留但标记 deprecated,新代码读写关系表。

### 模块边界

- `src/wiki/db/wiki-repository.ts` — wiki_page_entries 读写
- `src/graph/subject-graph-writer.ts` — 写 entry_subjects
- `src/wiki/compiler/subject-concept-extractor.ts` — 提取后写 entry_subjects
- `web/app/api/subjects/[id]/route.ts` — 返回关联数据
- `src/pipeline/classifier.ts` — 分类后写 material_subjects

---

## C1: 取消截断,分批排队全量处理

### Schema 变更

```sql
ALTER TABLE materials ADD COLUMN total_chunks INTEGER;
ALTER TABLE materials ADD COLUMN processed_chunks INTEGER DEFAULT 0;
ALTER TABLE materials ADD COLUMN batch_cursor INTEGER DEFAULT 0;
-- 复用已有 task_queue 表,type='extract_batch'
```

### API 变更

- `GET /api/v1/wiki/materials/:id/status` 新增:
  ```json
  { "totalChunks": 45, "processedChunks": 30, "progress": 0.67 }
  ```
- `POST /api/internal/dispatcher/tick` — 每 tick 取一批 batch 执行

### 处理逻辑

1. Material 上传后切片计算 `total_chunks`
2. 按 `BATCH_SIZE=10` 拆分,每批写入 `task_queue`(type=`extract_batch`)
3. Dispatcher tick 取 `status='waiting'` 的 batch 执行
4. 每批完成后 `processed_chunks += batch_size`
5. `processed_chunks >= total_chunks` 时标 `pipeline_status='done'`
6. 移除 `loadMaterialChunks` 中的 `LIMIT 200`

### 数据迁移

- 已 `done` 的 13 条 materials 无需重处理
- `pipeline_status IS NULL` 的 12 条:计算 `total_chunks` 后重新入队

### 模块边界

- `src/wiki/compiler/subject-concept-extractor.ts` — 移除 LIMIT,接受 batch 参数
- `src/pipeline/pipeline-orchestrator.ts` — batch 调度
- `web/app/api/internal/dispatcher/tick/route.ts` — 处理 extract_batch
- `web/app/api/v1/wiki/materials/[id]/status/route.ts` — 返回进度

---

## D1: 不同意动作 + 材料级副领域

### Schema 变更

```sql
CREATE TABLE classification_disputes (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  original_subject_id TEXT,
  suggested_subject_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'overridden'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_disputes_material ON classification_disputes(material_id);
CREATE INDEX idx_disputes_status ON classification_disputes(status);
```

副领域通过 B1 的 `material_subjects` 表实现(`role='secondary'`)。

### API 变更

- `POST /api/materials/:id/dispute` — 提交不同意
  - Body: `{ suggestedSubjectId?, reason? }`
  - 效果: 创建 dispute,material 标 `classification_status='disputed'`
- `POST /api/materials/:id/subjects` — 添加副领域
  - Body: `{ subjectId, role: 'secondary' }`

### 前端变更

- `/library` 材料卡片新增"不同意"按钮 → modal(选正确领域 + 原因)
- 材料详情显示主领域 + 副领域标签

### 模块边界

- `web/app/api/materials/[id]/dispute/route.ts` — 新增
- `web/app/api/materials/[id]/subjects/route.ts` — 新增
- `web/app/(dashboard)/library/page.tsx` — UI
- `src/pipeline/classifier.ts` — dispute 后重分类

---

## E1: 意图知识 vs 领域 Wiki 完全分离

### Schema 变更

```sql
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  positives_json TEXT NOT NULL DEFAULT '[]',
  negatives_json TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  status TEXT NOT NULL DEFAULT 'active',
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_intents_status ON intents(status);
CREATE INDEX idx_intents_name ON intents(name);
```

### API 变更(独立路由 `/api/v1/intent`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/intent` | GET | 列表(分页、搜索) |
| `/api/v1/intent` | POST | 创建 |
| `/api/v1/intent/:id` | GET/PUT/DELETE | CRUD |
| `/api/v1/intent/search` | POST | 独立语义检索(向量) |
| `/api/v1/intent/:id/stats` | GET | 命中统计 |

检索分离:
- 意图检索 → `intents` 表 embedding cosine similarity
- 领域检索 → `entries` 表(排除 type='intent')
- Hook 注入时按 query 意图分类决定检索路径

### 数据迁移

```sql
INSERT INTO intents (id, name, description, positives_json, negatives_json, embedding, status, created_at, updated_at)
SELECT id, title, content,
  COALESCE(json_extract(metadata_json, '$.positives'), '[]'),
  COALESCE(json_extract(metadata_json, '$.negatives'), '[]'),
  embedding, status, created_at, updated_at
FROM entries WHERE type = 'intent';

UPDATE entries SET status = 'migrated_to_intents' WHERE type = 'intent';
```

### 前端变更

- `/(dashboard)/intent/page.tsx` 改为读写 `intents` 表
- 卡片结构: name + description + positives/negatives + 命中次数

### 模块边界

- `web/app/api/v1/intent/route.ts` — 新增
- `web/app/api/v1/intent/[id]/route.ts` — 新增
- `web/app/api/v1/intent/search/route.ts` — 新增
- `web/lib/domain-stores.ts` — intent 部分改读 `intents` 表
- `hooks/kivo-intent-injection/handler.js` — 检索路由分流
- `src/cli/enrich-intents.ts` — 改操作 `intents` 表
- `src/repository/sqlite-provider.ts` — 搜索排除已迁移 intent

---

## 跨决策依赖与实施顺序

```
A1 (顶层二分) ← B1 (subject 收编,需顶层结构)
B1 (多对多表) ← D1 (副领域依赖 material_subjects)
C1 (分批处理) — 独立
E1 (intent 分离) — 独立
```

建议: A1 → B1 → D1(串行) | C1 + E1(并行)
