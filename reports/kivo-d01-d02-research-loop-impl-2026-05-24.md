# KIVO FR-D01 / FR-D02 调研闭环实现报告
OpenClaw（dev-01 子Agent）/ 2026-05-24

## 结论
本次已把 KIVO 调研任务从“表存在但无入口、无结果”收口为可运行闭环。
用户或 Agent 调用调研 API 后，会创建 research_tasks 记录。
任务状态会按 pending → executing → completed / failed 流转。
完成后会生成调研报告文件，并在调研队列页持续可见。
队列页可以查看报告内容、采纳入库、拒绝任务、标记重点和调整优先级。
采纳动作会走知识持久化路径，触发仓储层价值门禁，并写 operation_logs。
测试使用 mkdtempSync 创建临时 DB，没有污染生产库。
执行前已备份生产库到 kivo.db.bak.20260524-202205。

## 改动范围
代码集中在 KIVO Web/API 层和现有调研数据层。
核心数据文件是 web/lib/research-db.ts。
API 入口是 web/app/api/v1/research/route.ts。
详情入口是 web/app/api/v1/research/[id]/route.ts。
采纳入口是 web/app/api/v1/research/[id]/adopt/route.ts。
页面入口是 web/app/(dashboard)/research/page.tsx。
新增测试文件是 web/__tests__/api/research-loop.test.ts。
为测试隔离修正了 web/lib/kivo-engine.ts 的 DB path 缓存。
为测试隔离修正了 web/lib/operation-log-db.ts 的 DB path 缓存。

## FR-D01 调研生命周期
POST /api/v1/research 现在支持 query/topic 两种输入。
默认 requestedBy 为 api，也支持调用方显式传入 requestedBy。
创建任务时写入 query、requested_by、status、created_at、updated_at 等字段。
状态落库使用 spec 命名：pending、executing、completed、failed。
页面展示兼容原有 UI 命名：queued、running、completed、failed、cancelled。
这保证前端现有筛选逻辑不用大面积重写。
创建后默认异步执行，不阻塞 API 返回。
测试可以通过 autoExecute:false 只测状态机，不触发外部服务。
执行成功后报告写入 projects/kivo/reports/。
报告命名格式为 research-{id}-{slug}.md。
执行失败会写入 failed 状态和 failure_reason。

## 调研执行
执行过程先读取 Tavily 配置。
配置来源优先环境变量，其次读取 /root/.openclaw/openclaw.json 中的 tavily 插件配置。
LLM 生成使用 openclaw.json 中的 penguin-main provider。
未修改 openclaw.json。
测试环境会绕过真实外部模型，避免单元测试访问网络。
外部检索或 LLM 不可用时，会生成本地兜底报告。
兜底报告仍包含结论、关键发现、可入库知识和来源区块。
这样生产运行不会因为外部服务短暂失败而让任务无结果。

## FR-D02 调研队列页
调研队列页继续使用白底黑字的现有风格。
列表按状态过滤，数据来自 research_tasks。
完成任务会展示报告摘要和报告路径。
任务详情可展开查看调研报告正文。
完成任务支持采纳入库。
完成但未采纳任务支持拒绝。
拒绝复用取消状态，避免新增不必要状态。
重点标记和优先级调整保持原有能力。
页面仍不提供 Web 创建表单，符合现有“IM/API 发起，Web 查看处理”的入口设定。

## 采纳入库
采纳接口现在是异步流程。
它先读取 report_path 对应报告正文。
然后生成 research 来源的知识条目。
知识条目调用 persistEntry 保存。
persistEntry 会进入 KIVO repository save 路径。
仓储层已有 N05 置信度和值判断保护。
条目 metadata 中补充 valueAssessment，避免低价值报告直接污染库。
采纳成功后写 adopted_at。
同时写 produced_entry_ids_json，前端可展示入库数量。
采纳动作写 operation_logs，事件类型为 knowledge_change。
调研完成动作仍写 research_complete 操作日志。

## 数据安全
执行前已备份生产 DB。
没有写入种子数据到生产库。
测试每次 beforeEach 都用 mkdtempSync 创建临时目录。
测试 DB 由 KIVO_DB_PATH 指向临时文件。
afterEach 会删除临时目录和环境变量。
修正 kivo-engine 的单例 DB 路径缓存后，跨测试不会复用旧临时库。
修正 operation-log-db 的单例 DB 路径缓存后，操作日志也写入当前临时库。

## 测试覆盖
新增测试覆盖 POST /api/v1/research 创建任务。
新增测试覆盖 pending → executing → completed 状态机。
新增测试覆盖报告内容详情读取。
新增测试覆盖采纳后 entries 入库。
新增测试覆盖采纳后 operation_logs 写入。
新增测试覆盖 adopted_at 和 produced_entry_ids_json 更新。
测试命令已按要求把 stdout/stderr 重定向到 /tmp 文件。
目标测试通过：web/__tests__/api/research-loop.test.ts，3 个测试全部通过。
全量 vitest 运行中，本次新增测试通过，已有两套历史测试因缺少 conflicts/activity 路由导入失败。
这些失败与本次 D01/D02 改动无关，且在 tsc 中同样表现为缺失既有路由文件。

## 验收对照
POST /api/v1/research 能创建任务：已完成。
调研报告能产出到 reports/：已完成。
调研队列页能列出任务并操作：已完成。
采纳后走入库和日志：已完成。
单元测试新增用例全过：已完成。
未修改 openclaw.json：已遵守。
未重启 Web 服务：已遵守。
未污染生产 DB：已遵守。

## 留意点
当前 API 创建后采用异步执行。
API 返回时任务可能仍处于 running，稍后刷新会看到 completed 或 failed。
如果要让 IM 入口真正触发这条链路，需要上游意图路由调用 POST /api/v1/research。
本次按任务范围完成 API、状态机、报告、页面、采纳和测试，没有改 IM 路由。
