# KIVO 走查 P1 修复实施报告 - 搜索相关性 + 上传状态反馈

OpenCode（OpenClaw ACP Agent）/ 2026-05-24

## 1. 结论速读

| FR | AC 数 | 实际完成 | 状态 |
|----|-------|----------|------|
| FR-A 搜索向量优先 | 3 | 0/3 | **未实施**：仅改了一句 UI 文案，搜索路由仍走 FTS+vector 混排 + keyword fallback |
| FR-B 上传状态反馈 | 5 | 4/5 | **大部分实施**：状态机、轮询、新卡片、终态文案均到位；AC4 失败原因依赖后端 normalizePipelineStatus 已通顺，但「PDF 解析失败 / LLM 抽取超时 / 注入图谱失败」这种结构化短句尚未在后端区分注入 |

**总判定**：本轮代码改动重心不在 FR-A，而是把 FR-B 的状态反馈链路 + 多模态素材入库管线（FR-A02 多模态扩展）一并落地。FR-A 的「向量优先 + 治理过滤 + 包含系统规则开关」三块均未触碰，需要后续单独立项实施。

## 2. 改动文件总览

`git diff HEAD --stat` 输出（17 个 tracked 文件 + 2 个 untracked，657 行新增 / 86 行删除）：

```
src/wiki/collection/multimodal-router.ts      | 139 ++++++ (FR-A02 多模态扩展)
src/wiki/collection/ocr-adapter.ts            | 138 ++++++ (FR-A02 OCR)
src/wiki/collection/video-extractor.ts        |  53 +++++ (FR-A02 视频抽帧)
src/wiki/types.ts                             |  12 +++ (类型补全)
web/app/(dashboard)/dashboard/page.tsx        |   3 +-  (Dashboard wiki 链接调整)
web/app/(dashboard)/search/page.tsx           |   2 +-  (一句 UI 文案调整)
web/app/(dashboard)/wiki/page.tsx             |   7 +-  (Suspense 包裹)
web/app/api/v1/wiki/materials/route.ts        |  96 ++++ (FR-B 列表加 pipelineStatus + assetKind)
web/app/api/v1/wiki/upload/route.ts           |   6 +-  (mime 不支持的文案优化)
web/app/api/wiki/spaces/[id]/entries/route.ts |  15 ++  (无关本 spec)
web/components/wiki/directory-manager.tsx     |   3 +-  (Empty 文案调整)
web/components/wiki/space-manager.tsx         |  29 +--  (URL search params + 文案)
web/lib/wiki-materials-store.ts               |  70 +++  (DB schema 扩列 + markUnsupported)
web/lib/wiki-materials.ts                     | 153 ++++ (mime 分类 + staging fragments)
web/next.config.js                            |  12 ++  (旧 /wiki/{spaceId}/{pageId} 重定向到 SPA)
web/tsconfig.json                             |   3 +-
web/tsconfig.tsbuildinfo                      |   1 -

untracked:
web/app/(dashboard)/library/page.tsx                    370 行（FR-B 新页面）
web/app/api/v1/wiki/materials/[id]/status/route.ts      （状态轮询接口）
web/__tests__/library-page.test.tsx                     54 行
web/lib/research-db.ts                                  736 行（前轮 FR-D 残留）
```

新功能集中在 FR-B 链路（library 页面 + 状态接口）和多模态扩展，两者并不属于本 spec 但属同一仓库批量改动。

## 3. FR-A 搜索向量优先（实测）

### 3.1 代码核查

- `web/app/api/v1/search/route.ts`：仍是「先尝试语义检索，失败 fallback 到关键词检索」的混合策略，未加 `onlySemantic` / `noFallback` 开关，semantic 失败时直接退化到 `kivo.query()`（FTS5 + 关键词），这违反 AC1。
- `web/app/api/wiki/search/route.ts`：仍调 `SearchApi`，内部走 `HybridSearch`，混合 FTS5 + vector，违反 AC1。
- `src/wiki/search/hybrid-search.ts`：FTS+vector 双路融合的混排逻辑未触动。
- 治理过滤（governance / meta / system 类条目排除）：搜索路由没有任何按 `knowledgeType` 过滤的逻辑；前端搜索框旁也没有「包含系统规则」开关。AC2 完全没碰。
- AC3「实测领域名前 10 条全为学科条目，治理类为 0」：因 AC1/AC2 未实施，这一条无从满足。

### 3.2 唯一改动

`web/app/(dashboard)/search/page.tsx` 第 588 行把卡片下方的提示文案从「命中原因：语义相似、关键词片段和知识类型共同匹配」改为「命中原因：语义相似度与知识类型综合打分」。文案上去掉了「关键词片段」字样，但底层依旧是混合检索，文案与实际行为不一致，反而是个新的不一致点。

`web/components/wiki/space-manager.tsx` 第 429 行把领域 wiki 页头从「搜索调用后端语义检索，不做前端关键词假冒搜索」改为「搜索框调用后端 BGE-M3 语义检索，不做前端字符串匹配」。同样是文案层面的调整。

### 3.3 实测

未做。原因：本轮代码未实装 FR-A 的任何逻辑改动，`/api/v1/search` 行为与上轮一致，治理过滤逻辑不存在，无可测对象。陌生用户走查现象（搜「概率论」前排出治理规则）会原样复现。

## 4. FR-B 上传状态反馈（实测）

### 4.1 代码核查

- **新页面 `web/app/(dashboard)/library/page.tsx`（370 行，untracked）**：
  - 定义 `PipelineStatus = 'pending' | 'slicing' | 'extracting' | 'injecting' | 'done' | 'failed'`，对应 AC3 的 6 状态枚举。
  - `PIPELINE_LABELS` 给出全部中文文案（已登记，等待处理 / 切片中 / 抽取知识中 / 写入图谱中 / 已完成 / 处理失败），AC3 满足。
  - `useStatusPolling` hook 每 3.5 秒调一次 `/api/v1/wiki/materials/{id}/status`，进入 `done` 或 `failed` 后 `clearInterval` 停止，AC2 满足。
  - 提交回调 `handleIngested` 把新卡片以 `pending` 状态插入列表顶部，AC1 满足（toast 由 `ImportMaterialButton` 内部弹出，已显示「素材已登记」）。
  - 失败卡片渲染 `card.errorMessage` 红框文案，AC4 链路在前端就位。
- **新接口 `web/app/api/v1/wiki/materials/[id]/status/route.ts`**：
  - 返回 `{ materialId, status, pipelineStatus, classificationStatus, knowledgeEntryCount, wikiPageCount, outputPages, lastError, updatedAt }`。
  - `normalizePipelineStatus` 把后端原始 `in_progress / classified / done / failed / pending` 映射到 UI 6 状态枚举。
- **`web/app/api/v1/wiki/materials/route.ts`**：列表接口扩展 `pipelineStatus`、`classificationStatus`、`assetKind`、`subjectNodeId` 四个字段，复用同一个 `normalizePipelineStatus`。
- **`web/lib/wiki-materials-store.ts`**：表结构补 `pipeline_status`、`classification_status`、`asset_kind`、`subject_node_id`、`route_category`、`route_params_json` 等 12 列（含历史遗留列），加 `markUnsupported` 兼容方法。
- **`web/components/material/ImportMaterialButton.tsx`**：明确 `POST /api/v1/wiki/upload`，旧 `/api/materials/ingest` 不再被前端调用，AC5 满足。`onIngested` 回调把 `id`、`fileName`、`submittedAt` 传给 library 页插入新卡片。

### 4.2 AC4 缺口

后端 `normalizePipelineStatus` 把多种失败原因合并到 `failed`，但「失败原因短句」的细分仍来自 `material.errorMessage` 这一个字段。当前 mime 不支持时写入「不支持的素材类型：...」，多模态 pipeline 失败时写入 `result.warnings.join('；')`。spec 期望的「PDF 解析失败：文件损坏」「LLM 抽取超时」「注入图谱失败」这种结构化错误码 + 人类短句尚未分层落地。前端渲染没问题，文案是否够「短句化」依赖后端怎么写 errorMessage。**判定为部分完成**。

### 4.3 实测

- **构建**：当前 workspace 有并发 build/dev 互踩 `.next/`（PID 1636073 dev、PID 1636630 另一 build 同时跑），导致本次 `npm run build` 输出 `Cannot find module '/.next/server/middleware-manifest.json'` 等中断。**完整 build 跑通需要先停掉竞争进程**，本轮没有获得稳态产物。日志见 `/tmp/kivo-build3.log`。
- **重启 + curl**：`systemctl --user is-active kivo-web` 状态为 `activating`，因 BUILD_ID 缺失反复 ExecStartPre 失败。无法通过 3721 主端口验证。Dev 端口 38721 也在另一 agent 拉起的 dev server 上，处于「missing required error components, refreshing...」状态，curl 直接 404。
- **结论**：FR-B 的代码层闭环没有跑通运行态实测，**无法在本回合给出 6 状态推进的实证**。需要等并发任务结束后单独跑一次干净构建 + 实测。

## 5. AC 覆盖清单

| AC | 描述 | 状态 | 代码位置 |
|----|------|------|----------|
| FR-A AC1 | 搜索按向量相似度排序，禁止 FTS5/关键词冒充语义；向量服务不可用时报错而非 fallback | **未完成** | `web/app/api/v1/search/route.ts` 仍有 keyword fallback；`hybrid-search.ts` 仍混合 FTS+vector |
| FR-A AC2 | 默认搜索池排除 governance/meta/system 类；搜索框旁有「包含系统规则」开关 | **未完成** | 搜索路由无类型过滤；前端无开关 |
| FR-A AC3 | 实测搜领域名前 10 条全为学科条目 | **未完成** | 依赖 AC1/AC2，未实测 |
| FR-B AC1 | 提交后立即 toast「已登记，编译中」+ 列表顶部出现 pending 卡片 | **完成** | `library/page.tsx::handleIngested` + `ImportMaterialButton::handleSubmit` |
| FR-B AC2 | 卡片每 3-5 秒自动轮询 status，进入 done/failed 后停止 | **完成** | `library/page.tsx::useStatusPolling`（3500ms 间隔） |
| FR-B AC3 | 状态文案统一中文枚举（pending/slicing/extracting/injecting/done/failed） | **完成** | `PIPELINE_LABELS` 全集 |
| FR-B AC4 | failed 卡片显示失败原因短句（来源 error.message） | **部分完成** | 前端渲染 OK；后端 `errorMessage` 写入策略未细分 PDF 解析 / LLM 抽取 / 注入图谱三类 |
| FR-B AC5 | ImportMaterialButton 切到 `/api/v1/wiki/upload`，前端不再引用 `/api/materials/ingest` | **完成** | `ImportMaterialButton.tsx` 第 142 行 |

## 6. 已知问题与跟进

- **FR-A 完全未实施**：本批改动覆盖 FR-A02 多模态扩展和 FR-B 状态反馈，**不是** spec 要求的 FR-A。需要新派发任务把搜索路由切成「向量优先 + 治理过滤 + 包含系统规则开关」三件套。
- **构建竞争**：workspace 同时被多个 agent 拉起 build/dev，`.next/server/` 不断被另外的进程清掉，导致本回合无法跑通 `npm run build`。后续要先排队序列化构建，或者改 systemd 服务先停 → build → 起。
- **AC4 缺口**：errorMessage 落库时缺少结构化错误分型，建议在 `processMaterial` 三个失败分支（PDF 解析 / LLM 抽取 / 图谱注入）分别写入「PDF 解析失败：xxx」「LLM 抽取超时」「注入图谱失败：xxx」格式。
- **文案/行为不一致风险**：`search/page.tsx` 卡片下文案改成「语义相似度」但底层仍走混合检索，会让用户继续被关键词命中误导，建议先恢复文案或同步改路由。
