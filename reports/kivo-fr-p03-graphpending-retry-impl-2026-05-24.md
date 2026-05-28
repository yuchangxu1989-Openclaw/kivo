# KIVO FR-P03 graphPending 重试 cron + graphAbandoned 状态机实装报告

free-code（OpenClaw ACP Agent）/ 2026-05-24

## 任务结论

实装完成。FR-P03 兜底从「代码没真落」推进到「cron 在跑、状态机有数据、edges 真写库」。

- 新增 cron 脚本：`projects/kivo/scripts/cron-retry-graph-pending.ts`（209 行）
- 单测：`projects/kivo/scripts/__tests__/cron-retry-graph-pending.test.ts`（12 用例全过）
- crontab：`*/30 * * * * cd /root/.openclaw/workspace/projects/kivo && npx tsx scripts/cron-retry-graph-pending.ts >> logs/cron-graph-pending.log 2>&1` 已写入 `scripts/crontab.txt` 并 `crontab -l` 落地
- 实测：seed 一条 `graphPending` entry，跑一次 cron → LLM 写 5 条关系到 `graph_edges`，metadata 翻成 `graphState=resolved`，retryCount 清零

## 满足验收

| 验收项 | 满足情况 | 证据 |
|---|---|---|
| 1. cron 脚本 + crontab 配置 | ✅ | `scripts/cron-retry-graph-pending.ts` + `crontab -l \| grep cron-retry-graph-pending` 命中 |
| 2. metadata schema 字段兼容（无 ALTER TABLE） | ✅ | 仅 `json_set` 维护 `metadata_json.domainData.{graphRetryCount,graphState}`，旧 entries 通过 `COALESCE(...,0)` 默认 0 |
| 3. unit tests 5+ 全过 | ✅ | 12/12 passed（覆盖默认值、retryCount 累加、abandoned 转换、异常隔离、LIMIT 守门、空表、abandoned 不复扫等） |
| 4. 实测跑通：DB 状态有变化 | ✅ | seed `graphRetryCount=2 + graphPending=true` → run cron → DB 出现 1 条 `graphState=resolved`，graphPending 计数从 1 → 0，graph_edges 新增 5 条 |
| 5. build 通过 | ⚠️ 部分 | 我的脚本独立 typecheck（`tsc --noEmit scripts/cron-retry-graph-pending.ts`）EXIT=0；`npm run build` 失败但失败点都在我之前已存在的旧文件（`subject-aware-injector.ts` / `entry-validator.ts` / `wiki-page-compiler-seed-threshold.test.ts`），与本次改动无关，详见下文 |
| 6. 报告 80-150 行 | ✅ | 本文 |

## 实装清单逐条对照

### 1. metadata schema 兼容
- 不改表结构，全部走 `metadata_json.domainData`：
  - `graphPending: true`（沿用 `subject-graph-writer.ts` 既有写入路径）
  - `graphPendingReason / graphPendingUpdatedAt`（沿用既有字段）
  - `graphRetryCount: number`（新增，缺省 0）
  - `graphState: 'pending' | 'resolved' | 'abandoned'`（新增，缺省 pending）
- 读取时 `COALESCE(json_extract(metadata_json, '$.domainData.graphRetryCount'), 0)`，旧 entries 自动按 0 起算
- 候选筛选时 `COALESCE(json_extract(metadata_json, '$.domainData.graphState'), 'pending') <> 'abandoned'`，没字段视为 pending、`abandoned` 直接排除

### 2. cron 脚本核心逻辑
- 复用 `src/graph/subject-graph-writer.ts` 的 `queueSubjectGraphWriteForEntryIds`：单条入队、内置 try/catch、成功则 `setGraphPending(false)` + 写 edges
- 状态机包在外层：
  - `processFn` 返回 `failed=0` → `graphState='resolved'` + 清 `graphPending`/`graphPendingReason`/`graphPendingUpdatedAt` + 删 `graphRetryCount`
  - `failed>0` 且 `next < maxRetry(默认 3)` → `graphRetryCount++`、`graphState='pending'`
  - `failed>0` 且 `next >= maxRetry` → `graphRetryCount=next`、`graphState='abandoned'`
  - 抛异常 → 记 `errors++`，retryCount 不变（避免误升）
- LIMIT 50 + `ORDER BY updated_at ASC`，旧条目优先重试，剩余条目走下一轮 cron
- 日志写到 `logs/cron-graph-pending-YYYYMMDD.log`，每行带 ISO 时间戳

### 3. crontab 配置
- 新增 `scripts/crontab.txt` 作为唯一真相源（含 `awk '!seen[$0]++'` 去重指引）
- 已应用到 `crontab -l`：
  ```
  */30 * * * * cd /root/.openclaw/workspace/projects/kivo && npx tsx scripts/cron-retry-graph-pending.ts >> logs/cron-graph-pending.log 2>&1
  ```

### 4. 单测覆盖（12 条）
1. 旧 entries 无 `graphRetryCount` → 默认 0
2. 已 `abandoned` 的 entry 不再被扫描（避免死循环）
3. 缺 `subject_id` / 非 `active` 不进候选
4. LLM 成功 → `graphState=resolved` + 清 graphPending + 重置 retryCount
5. LLM 失败 → retryCount++ + `graphState=pending`
6. retryCount 累加到 3 → `graphState=abandoned`
7. 自定义 `maxRetry=5` 时 retryCount=3 仍 pending（参数化生效）
8. 单条抛异常不阻塞后续 entry
9. 全异常路径 → errors 计数正确，retryCount 不被错误累加
10. LIMIT 50 守门：60 条挂起只处理 50，剩 10 留下次
11. 空表跑 cron 不报错
12. `updateGraphRetryState` 直接调用 patch 不破坏其他 domainData 字段

### 5. 实测结果

测试库：`/tmp/kivo-test.db`（生产 db copy），seed 一条 `5630bbae-...` entry：

```
seed: {graphPending:true, graphPendingReason:'seed_for_test', graphRetryCount:2}
跑   : npx tsx scripts/cron-retry-graph-pending.ts
log  : scanned=1 resolved=1 retried=0 abandoned=0 errors=0 edgesWritten=5
DB   : graphState=resolved；graphPending 字段移除；graphRetryCount 删除
edges: graph_edges 新增 5 条 source_id=5630bbae-...
空表 : 第二次跑 → scanned=0，无报错
```

## build 状态说明

`npm run build`（`tsc + tsc -p tsconfig.cjs.json`）失败，但失败点均与本次改动无关：

```
src/injection/subject-aware-injector.ts(387,13): TS2339 entryType
src/injection/subject-aware-injector.ts(412,32): TS2339 entryType
src/repository/__tests__/subject-id-persistence.test.ts: 4 处 TS2339/TS2353
src/repository/entry-validator.ts(1,10): TS2305 ENTRY_TYPES
src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts(83,51): TS2345 LlmConfig.model
```

`git stash` 后跑 build 同样失败（baseline 已坏），因此非本次回归。我的新文件位于 `scripts/`，不在 `tsconfig.json` 的 `include: ["src/**/*"]` 里，独立 `tsc --noEmit` 干净通过（EXIT=0）。

## 文件改动

新增：
- `projects/kivo/scripts/cron-retry-graph-pending.ts`
- `projects/kivo/scripts/__tests__/cron-retry-graph-pending.test.ts`
- `projects/kivo/scripts/crontab.txt`
- `projects/kivo/logs/cron-graph-pending-20260524.log`（cron 输出）

未改：`src/graph/subject-graph-writer.ts`、`src/cli/cron.ts`（直接复用既有 API）、`kivo.db` 表结构

## 后续建议（spec 已标 follow-up，本回合不做）

- `graphAbandoned` 列表 + 手动重试按钮（FR-3）：管理界面入口、CLI `kivo graph retry-abandoned <id>`
- 监控告警：`abandoned > N` 触发飞书通知
- 在 ingest 主流程把 `graphState='pending'` 显式写入（当前依赖兜底默认值）
