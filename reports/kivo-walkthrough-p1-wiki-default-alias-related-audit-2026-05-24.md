# KIVO Walkthrough P1 — Wiki `default` 别名 + 关联知识真查 修复审计

> OpenClaw（audit-01 子Agent） / 2026-05-24

## 总体判定

**可发版（接受附带数据层缺口说明）**。

cc 两处 PARTIAL 修复在代码层均已正确闭合，5 个目标文件全部 PASS、tsc 0 错误、边界守护通过。运行态闭环受 wiki_links=0 + graph_nodes 不含 wiki_page 双重数据缺口阻断 —— 这是 FR-P06（wiki page compiler 未跑）与 graph-build 收录范围问题，不是本次修复漏洞。前端已正确处理空数据（"暂无关联知识..."），交互不报错。

## P1-A：`default` 别名解析

| 检查项 | 结果 | 证据 |
|---|---|---|
| `entries/route.ts` GET 入口走 `resolveSpaceIdOrNull` | PASS | L99-103 `const id = resolveSpaceIdOrNull(rawId); if (!id) return notFound(...)` |
| `entries/route.ts` POST 入口走 `resolveSpaceIdOrNull` | PASS | L172-176 同模式 |
| `spaces/[id]/route.ts` PATCH 覆盖 | PASS | L29-31 |
| `spaces/[id]/route.ts` DELETE 覆盖 | PASS | L75-77 |
| `directories/route.ts` GET 覆盖 | PASS | L60-62 |
| `directories/route.ts` POST 覆盖 | PASS | L82-84 |
| 复用 `ensureMaterialSpaceExists` 保持别名语义统一 | PASS | 三个 route 中 `resolveSpaceIdOrNull` 实现一致，均委托 `ensureMaterialSpaceExists` |
| `default` 不存在时真创建 | PASS | `wiki-materials.resolveSpaceId` L89-99：`rawSpaceId === 'default'` → `pipeline.ensureDefaultSpace().id`，pipeline 内部新建 |
| 既有 UUID 直传不被破坏 | PASS | `resolveSpaceId` L99-103：非 default 走 `repo.findById`，找不到则 throw → catch 转 null → notFound，UUID 命中 wiki_space 时原样返回 |

P1-A 5 个 endpoint × 6 个 HTTP 方法（GET/POST/PATCH/DELETE）全部覆盖，逻辑一致，无遗漏。

## P1-B：关联知识真查

| 检查项 | 结果 | 证据 |
|---|---|---|
| `links/route.ts` 新增并接入 wiki_links 出向 | PASS | L74-86 `listOutgoingLinks` 查 `source_page_id = ?` |
| wiki_links 入向（反向链接） | PASS | L88-100 `listIncomingLinks` 查 `target_page_id = ?` |
| graph_edges 复用 `lib/graph-db.ts` | PASS | L19-23 import + L194-196 `graphTablesExist()` 守护、`getGraphEdges()`/`getGraphNodes()` 调用 |
| edges 双向匹配（source_id 或 target_id = pageId） | PASS | L196-198 `edge.source_id === id \|\| edge.target_id === id` |
| 中文标签映射 | PASS | L113-141 `relationLabel` 12 种关系类型映射，未命中 fallback 原值 |
| 按 association_type 分组 | PASS | L153-160 `ensureGroup` + Map 聚合 |
| 去重（同 peer + direction + origin） | PASS | L237-243 `seen.add(\`${item.id}\|${item.direction}\|${item.origin}\`)` |
| 排序（outgoing 优先 + 标题中文排序） | PASS | L244-249 |
| placeholder 处理（target_page_id 为 null 的悬挂链接） | PASS | L168-181 `placeholder: { reason: link.status \|\| 'missing' }` |
| 只读 sqlite handle 安全分离 | PASS | L57-65 `new Database(dbPath, { readonly: true })`，独立连接不与 WikiRepository 互锁 |
| `space-manager.tsx` 使用 `useApi` 拉取 | PASS | L305 `useApi<{ data: WikiRelatedResponse }>(selectedPageId ? \`/api/wiki/pages/${selectedPageId}/links\` : null)` |
| `WikiRelatedResponse` 类型定义齐全 | PASS | L67-90，含 item/group/response 三层 |
| loading 态分支 | PASS | L673 `relatedLoading` |
| error 态分支 | PASS | L675 `relatedError.message` |
| empty 态分支 | PASS | L676-678 `total === 0` → "暂无关联知识..."，文案明确说明数据来源 |
| data 态分组卡片渲染 | PASS | L679-690 `groups.map` |
| 列表项点击切换关联条目 | PASS | L702 `setSelectedPageId(item.id)` —— 复用现有 `selectedPageId` state，自动触发详情切换 |
| 方向标识（→ / ←） | PASS | L693 `directionLabel` |
| 来源标识（链接/图谱） | PASS | L694 `originLabel` |
| 占位项不可点击且有 hover 提示 | PASS | L697-699 `title=\`未解析：${item.placeholder?.reason ?? 'missing'}\`` |

P1-B 后端响应契约完整、前端 4 态分支齐全、UX 细节（方向/来源/占位/点击切换）全部到位。

## 边界守护

| 检查项 | 结果 | 证据 |
|---|---|---|
| 仅碰目标 5 文件 + 新增 links route | PARTIAL | `git diff HEAD -- web/` 显示 14 个文件改动 + 1 个新建。本次 P1 任务强相关 5 文件 + 新建 links 文件 mtime 全部落在 22:46-22:51 cc 工作窗口；其余 9 个改动（wiki-materials.ts 22:16、next.config.js 21:58、wiki/page.tsx 等）属此前 wave1/multimodal/材料管线工作的累计未提交改动，与 P1 任务无关 |
| 不动 src/ | PARTIAL | src/ 有 9 文件改动（multimodal-router/audio-transcriber/ocr-adapter/video-extractor 等），全部属 FR-A02 多模态扩展任务，非本次 P1 改动；本次 cc 自身没碰 src/ |
| 不改 openclaw.json | PASS | 工作目录无 openclaw.json 改动 |
| 不改 processMaterial / OCR | PASS | wiki-materials.ts 改动属 22:16 之前的他线工作（添加 text/plain、markdown 类型 + governance-store 引用），processMaterial 主体未受 P1 影响；ocr-adapter.ts 改动属 src/ 多模态线 |
| 不改 wiki-materials.ts 文件存储流程 | PASS | resolveSpaceId / ensureMaterialSpaceExists 是 cc 复用而非新改 |

判定：cc 本次 P1 改动严格在 5 文件 + 1 新建范围内，工作树残留的预存改动属其他并行任务的工作，对 P1 评审不构成边界破坏。建议合入前用 `git add` 精确暂存 6 个 P1 文件、其他改动留给对应任务自行提交。

## 类型检查

```
EXITCODE=2  (npx tsc --noEmit)
__tests__/api/errors.test.ts:15,79  TS2554 (Expected 3-4 args, got 5)
__tests__/api/errors.test.ts:41,57  TS2554 (Expected 1-2 args, got 3)
__tests__/api/errors.test.ts:55,39  TS2554 (Expected 1, got 2)
__tests__/api/research-loop.test.ts:119,41  TS2339 (route.GET 不存在)
```

cc 自报 4 行错误属实，全部在 `__tests__/api/` 下，与本次 P1 改动文件 0 重叠 = 预存测试维护债。本次新增的 `links/route.ts`、修改的 4 个 spaces 路由、`space-manager.tsx` **0 类型错误**。

## 数据层缺口确认

```sql
wiki_pages_total          15
wiki_links_total          0
graph_edges_total         1782
pages_in_graph_node       0   -- wiki_page 不在 graph_nodes 里
```

- wiki_links=0：FR-P06 wiki page compiler 没跑（`src/wiki/compiler/wiki-page-compiler.ts` 才会写 wiki_links），不是 cc 漏修
- graph_nodes 全是 fact/methodology/decision/experience/intent/material/wiki_space，没有 wiki_page → graph_edges 即使 1782 条也匹配不到当前 wiki_page 的 id
- 双重缺口叠加 → 当前任意 wiki_page 走 `/links` 必然返回 `total: 0`

前端 empty 文案"本条目在 wiki_links / 知识图谱里还没有与其他节点建立关系"准确反映了运行态实情，UX 不会误导用户。

## 运行态闭环建议（不阻断本次发版）

1. P1 任务范围内：可发版，前端在数据缺口下 graceful 降级正确
2. 紧跟项（独立任务，不计入本次审计）：
   - 跑一次 `scripts/run-wiki-compiler.ts` 让 wiki_links 真有数据
   - 让 graph-build 把 wiki_page 也写入 graph_nodes（或 wiki_page 复用其底层 entry 的 graph_node）
3. 之后回归：手动打开任一 wiki 详情页 → 关联知识区出现真实分组 → 点击跳转 → 切换到关联条目

## 审计结论

- P1-A：PASS（6 个 HTTP 方法全覆盖、UUID 不退化、default 真创建）
- P1-B：PASS（双源融合、4 态分支、点击切换、占位处理）
- 边界守护：PARTIAL（cc 改动本身合规，但工作树带其他任务残留，需 git add 精准暂存）
- 类型检查：PASS（cc 5 个文件 0 错误，4 个预存错误是测试维护债）
- 数据层缺口：确认非 cc 漏修，属 FR-P06 + graph-build 范围，前端 empty 态正确处理
