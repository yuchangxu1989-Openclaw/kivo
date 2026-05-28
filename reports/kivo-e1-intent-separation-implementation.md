# KIVO E1 意图知识与领域 Wiki 分离实施报告

Codex（OpenClaw ACP Agent）  
2026-05-25

## 结论

已完成 E1 主体实现：意图知识从 `entries` 迁出到独立 `intents` 表，新增独立意图 API，领域知识检索默认排除意图，注入 hook 改为先查意图库再查领域库，前端 `/intent` 改为独立意图知识页面和卡片。

## 已落地内容

- 新增独立意图仓储与类型：`src/repository/intent-types.ts`、`src/repository/intent-repository.ts`。
- `SQLiteProvider` 初始化时创建 `intents` 表，并迁移 `entries.type='intent'` 数据。
- 迁移后原 `entries` 意图记录标记为 `migrated_to_intents`，领域检索路径同时排除 `type='intent'`。
- 新增 SQLite-backed web 意图 store：`web/lib/intent-store.ts`。
- 新增/对齐意图 API：
  - `GET /api/v1/intent`
  - `POST /api/v1/intent`
  - `PUT /api/v1/intent`
  - `DELETE /api/v1/intent?id=...`
  - `GET /api/v1/intent/list`
  - `POST /api/v1/intent/create`
  - `POST /api/v1/intent/search`
  - `GET/PUT/DELETE /api/v1/intent/:id`
  - `GET /api/v1/intent/:id/stats`
- 保留 `/api/v1/intents` 兼容入口，内部转到新 store。
- `web/lib/semantic-search.ts`：领域搜索查 `entries` 且排除 intent；意图搜索查 `intents`。
- `web/lib/paginated-queries.ts`：知识列表、统计、按 ID 查询默认排除 intent。
- `src/hook-api/index.ts`：bootstrap 和领域向量检索排除 intent，并导出 hook 可复用 query embedding。
- `hooks/kivo-intent-injection/handler.js`：message 注入先查 `intents` 表，再查领域知识，输出分成独立 intent/domain 区块。
- `/intent` 页面不再重定向，改为独立意图卡片、新建、筛选、删除。
- 领域知识新建/筛选入口移除 intent 类型，避免继续把意图写回领域知识。

## 验证结果

已按要求用 stdout/stderr 重定向执行检查。

- `npm run typecheck`：未通过，但剩余错误来自项目既有测试/类型债，与本次 E1 改动无关。E1 相关的 `sqlite-provider`、intent 导出冲突已修掉。
- `web npm run typecheck`：未通过，但剩余错误来自既有 `web/__tests__` 和 `lib/wiki-pages.ts` 导出问题，与本次 E1 改动无关。
- 针对本次新增/修改的 intent 路由、store、页面做了独立 TypeScript 项目检查：通过，无输出。

检查日志：

- `/tmp/kivo_e1_typecheck_root_2.txt`
- `/tmp/kivo_e1_typecheck_web_2.txt`
- `/tmp/kivo_e1_targeted_project_tsc_4.txt`

## 未改内容

- 未修改 `product-requirements.md`。
- 未修改 `/root/.openclaw/openclaw.json`。
- 未执行 `openclaw doctor --fix` 或任何 doctor fix 命令。

## 注意事项

当前仓库本身已有大量未提交变更和未跟踪文件，本次只在 E1 范围内落地分离能力，没有清理历史工作区状态。
