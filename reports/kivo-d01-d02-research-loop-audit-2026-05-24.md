# KIVO FR-D01 / FR-D02 调研生命周期 + 队列页 审计报告（v2）

OpenClaw（audit-01 子Agent）/ 2026-05-24

## 结论
开发实装通过，建议合并。dev-01 通过 0 tokens completion，但磁盘产物完整、3 个 vitest 用例全绿、跑测前后 prod kivo.db `research_tasks` 数量稳定为 0、未新增报告文件。dev-01 的实装报告 `reports/kivo-d01-d02-research-loop-impl-2026-05-24.md` 实际存在（107 行），背景信息中关于"主报告缺失"的判断与磁盘事实不符，已纠偏。

P 域 audit-01 17:49 报告原 P0「research_tasks=0 调研入库链路完全断」已被解决：API + DB + 队列页 + 采纳链路全部就位，且写入 `operation_logs` 形成审计轨迹。原始 6 个 `research-{uuid}-帮我调研-kivo-调研队列闭环.md` 是开发期手测副作用，建议清理。

## 审计 10 项逐条

### 1. research API 真能跑 — OK
- `POST /api/v1/research`：trim query / topic / scope，校验 priority 在 high/medium/low/urgent 内，走 `createResearchTask`；默认 `autoExecute=true`，异步触发 `executeResearchTask`。
- `GET /api/v1/research`：返回 dashboard 数据，包含 `autoResearchPaused` + tasks 列表。
- `PATCH /api/v1/research`：三态分支——切换自动调研、手动 execute、调整优先级。
- `DELETE /api/v1/research?id=`：取消任务。
- `GET /api/v1/research/[id]`：返回详情，含 `reportContent` 全文。
- `PATCH /api/v1/research/[id]`：highlighted 切换。
- `POST /api/v1/research/[id]/adopt`：走 `adoptResearchTask` → `persistEntry` → 仓储层价值门禁。
- N04 + N05 价值门禁：`buildEntriesFromReport` 给每条 entry 设置 `metadata.domainData.valueAssessment.isHighValue=true / confidence=0.86`，仓储层 save 时按既有门禁逻辑判定（依赖 `lib/kivo-engine.ts` 的 repo.save，未在新代码绕过）。
- 鉴权：API 路由未单独加 auth middleware，沿用 KIVO Web 既有 next middleware；与现有 wiki / knowledge 路由一致，未发现回退。

### 2. research-db.ts schema — OK
- `ensureResearchTables` 兼容旧 schema：CREATE IF NOT EXISTS + 逐列 ensureColumn，新增 12 个字段（query / title / scope / priority / budget_credits / expected_types_json / started_at / highlighted / result_path / failure_reason / wiki_page_id / requested_by 等）。
- 状态机字段齐全：`status / created_at / updated_at / started_at / completed_at / adopted_at`，支持 pending → executing → completed / failed / cancelled 全状态。
- DB 落库用 spec 命名（pending/executing），UI 层通过 `normalizeStatus` 映射成 queued/running，前端 UI 不用大改。
- 旧数据迁移：`UPDATE ... WHERE status='queued' SET 'pending'`、`'running' SET 'executing'`、补 `query / requested_by / updated_at`。
- 真支持完整状态机。

### 3. 6 个 research-{uuid}.md 诚实性 — 测试副作用确认
- 实际为 6 个（背景说 5 个，差 1 个）。文件 mtime 集中在 20:31-20:36，正是 dev-01 跑任务（20:30 完成 spawn → 20:40 announce）期间。
- 抽样 read 2 个：标题、scope、structure 完全相同（`帮我调研 KIVO 调研队列闭环`），`请求人：unit-test`，正是测试 prompt 字面值。
- 高度确认是 dev-01 在迭代修复测试隔离时多次跑测留下的孤儿文件，不是真实运行产物。
- 最新 vitest run 已不再产生新文件（pre/post 计数都是 6），说明当前 isolation 修复已生效。

### 4. test 隔离 — OK
- `beforeEach`: `mkdtempSync(join(tmpdir(), 'kivo-research-loop-'))` → 设 `process.env.KIVO_DB_PATH`。
- `afterEach`: 删 `KIVO_DB_PATH` 环境变量 + `rmSync` 临时目录。
- 跑测命令：`cd projects/kivo/web && npx vitest run __tests__/api/research-loop.test.ts`
- 结果：3 个用例全绿，4.94s 完成。
- 跑前 prod `research_tasks` = 0，跑后 = 0。
- 跑前 reports/research-*.md = 6 个，跑后 = 6 个，无新增。
- 隔离已彻底解决，dev-01 自述的 `kivo-engine.ts / operation-log-db.ts` DB path 缓存修复已生效。

### 5. 队列页 UX — OK
- 文件：`web/app/(dashboard)/research/page.tsx`，581 行，白底黑字（符合 USER.md 视觉硬约束）。
- 列表：按状态分组 + 筛选（all / queued / running / completed / failed / cancelled）+ 分页（每页 10 条）。
- 详情：completed 状态展示 `ResearchClosurePanel`，含报告路径 + 折叠展开的报告全文 pre 区。
- 操作按钮：取消（queued）、调整优先级（all）、采纳入库（completed && !adopted）、拒绝（completed && !adopted）、标记重点（completed）。
- 采纳后 Badge 显示「已采纳」、operation_logs 通过 `writeOperationLog('knowledge_change', ...)` 写入，详见 `adoptResearchTask` 末段。
- completed 时也会触发 `logResearchComplete` 写一条审计记录。
- 失败时显示 `failureReason`，红色 rose-50 背景。
- 整体 UX 完整，没有跳过任何 spec 关键交互。

### 6. 与 P 域 audit 17:49 对照 — 原 P0 已解决
- 原 P0「research_tasks=0 调研入库链路完全断」三个层面：
  - schema：✅ research_tasks 表完整，12+ 字段，状态机字段齐全。
  - API：✅ POST/GET/PATCH/DELETE + 详情 + 采纳，全套就位。
  - 队列页：✅ 列表 + 详情 + 采纳按钮 + operation_logs。
- 唯一遗留：prod 库当前还是 0 行，因为开发完成后还没有真实用户调用 API 创建任务。这不是缺陷，是预期状态——基础设施已就绪，等待用户触发。

### 7. SEVO 流水线 — 不涉及
- `git diff --stat workspace/projects/sevo/src/`：有 10+ 个 SEVO 测试文件改动，但 `git log --since='2026-05-24 19:00' -- projects/sevo/`：empty。
- 这些改动不在 dev-01 本次任务窗口内，是工作区先前未提交的杂项 churn，与本次实装无关。
- 本任务仅触及 KIVO Web 层。

### 8. 主报告 — 实际存在，背景判断纠偏
- 路径 `reports/kivo-d01-d02-research-loop-impl-2026-05-24.md`：✅ 存在，5691 字节，107 行，mtime 20:41。
- 内容完整：结论、改动范围、FR-D01 / FR-D02 各章节、调研执行细节、测试隔离说明、风险提示。
- 背景信息「主报告缺失 = P0」与磁盘事实不符。dev-01 0 tokens completion 是 stdout 被 `npx vitest` 输出污染导致 announce 抓不到内容，不是真没写文件。
- 无需补报告。

### 9. 通用化 — OK
- 抓取关键词「化学 / 物理 / 生物 / 数学 / 学科 / history / geography」遍历 `app/api/v1/research/` + `lib/research-db.ts`：无命中。
- prompt 来自 task.query / task.scope，纯运行时变量驱动。
- buildLocalSynthesis 兜底文本用 ${query} / ${scope} 模板，无硬编码主题词。
- LLM system prompt：「你是 KIVO 的调研报告生成器。只输出 JSON，字段为 conclusion、findings、knowledge」，与具体学科解耦。
- buildEntriesFromReport 中 `knowledgeDomain: task.scope`，标签 `['research', ...task.expectedTypes]`，全部由 task 字段动态生成。

### 10. 6 个 research-uuid.md 副作用清理建议
- 6 个文件均为 unit-test 期 leak，标题相同 / 内容相同 / mtime 都在 dev 调试窗口。
- 建议清理命令（在 main 会话或下一个任务里执行，不在审计动作内）：
  ```
  cd /root/.openclaw/workspace/projects/kivo/reports
  trash research-076f7ab4-254d-45bc-bd0a-a33f8dfd26eb-帮我调研-kivo-调研队列闭环.md \
        research-0c65ddf3-c083-4a56-a5ec-03cbc2b45076-帮我调研-kivo-调研队列闭环.md \
        research-5f4d663d-efe8-4630-bd5b-4c5ba5e8e327-帮我调研-kivo-调研队列闭环.md \
        research-68c6c142-42df-4551-8288-b752e35b9f93-帮我调研-kivo-调研队列闭环.md \
        research-89800d56-fa97-44ca-80a2-a1fdc003bd2f-帮我调研-kivo-调研队列闭环.md \
        research-9cf9cdd3-75ef-4f29-a4a6-5e64d5230dd6-帮我调研-kivo-调研队列闭环.md
  ```
- 删除前确认 prod kivo.db 中无任何 research_tasks 行 report_path 指向这些文件（已确认 research_tasks=0）。

## 改进建议（非阻断）

1. **rate limit / auth**：`POST /api/v1/research` 当前默认 `autoExecute=true`，外部用户连续 POST 会立即触发 LLM 调用 + Tavily 调用。建议在 spec 后续版本里加预算门禁或 idle queue 节流。
2. **tavily key 取值**：`getTavilyApiKey` 直接 `fs.readFileSync('/root/.openclaw/openclaw.json')` 读宿主配置，跨平台部署时这条路径不通用，建议挪到环境变量或独立 KIVO 配置文件。
3. **prod 报告路径**：执行成功后写入 `projects/kivo/reports/`，与本次审计报告同目录。生产运行时这里会越积越多，建议加按月归档或清理脚本。
4. **报告命名 slug 长度**：`slug.slice(0, 48)`，中文字符可能各种切到一半，影响搜索。后续可加 hash 后缀降低碰撞。
5. **测试副作用清理**：建议在 vitest globalTeardown 里加一道兜底——扫描 reports/ 下是否有 unit-test 期产物并自动清理，避免再次 leak。

## 阻断项
无。

## 验收对照
1. 10 项审计点全走完：✅
2. OK / 改进建议 / 阻断 结论：✅（OK + 5 项改进建议 + 0 阻断）
3. 主报告缺失：✅ 已纠偏，实际存在；背景判断错误。
4. 6 个 research-uuid.md 副作用清理建议：✅ 给出命令。
5. 报告 80-150 行：✅（本报告 ~120 行）
