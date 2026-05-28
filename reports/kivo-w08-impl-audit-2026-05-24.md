# KIVO FR-W08 上传自动编译实装审计

OpenClaw（cc 子Agent）/ 2026-05-24

## 结论

**条件通过 + 阻断 1 项 + P1 改进 3 项**：

- 上传 → dispatcher → 状态查询 → 重试 链路代码完整、闭环、合理复用 FR-A02 队列，**没有重复造轮子**。
- 但与 spec FR-W08 AC1/AC2 存在硬不一致（文件类型范围、文件大小上限、进度字段），属于 **P0 阻断**，需提需求澄清或修代码到对齐 spec 才能宣告 W08 完成。
- src/ 一同改动 886+ 行，按规则应走 SEVO 流水线（codex 是否已走待确认）。

---

## 1. upload route (`web/app/api/v1/wiki/upload/route.ts`)

- 入参：multipart/form-data，`file` + 可选 `spaceId`（默认 `default`）。
- 校验：`file.size > MAX_MATERIAL_FILE_SIZE_BYTES (400MB)` → 400；MIME 不在 `SUPPORTED_MIME_TYPES` 集合 → 400。
- 落盘：`persistUploadedMaterial` 写入 `materials` 表 + 物理文件。
- 触发：`triggerMaterialDispatch(record.id)` 入 task_queue。
- 出参：`{ success, fileId, status: 'processing' }`，HTTP 201。

**链路通顺**。但 `MAX_MATERIAL_FILE_SIZE_BYTES = 400MB` 与 spec AC1「单文件上限 50 MB」不一致。

## 2. status route (`web/app/api/v1/wiki/materials/[id]/status/route.ts`)

- UI 状态枚举声明 6 种：`pending | slicing | extracting | injecting | done | failed`。
- DB 实际枚举（`wiki-materials-store.ts` L8）只有 4 种：`pending | in_progress | done | failed | classified`。
- `normalizePipelineStatus` 映射：
  - `failed` → failed；`done` → done；`in_progress` → extracting；`classified` → injecting；其他 → pending。
- **缺陷**：UI 声称的 `slicing` 状态在该函数中**永远不会返回**——DB 没有 slicing 阶段，映射函数也没引用它。等于命名误导。
- 返回字段含 `knowledgeEntryCount = extractCount`、`wikiPageCount`、`outputPages`、`lastError`、`updatedAt`，**没有 `sliceCount` / `processedSegments / totalSegments`**，AC2 要求的「已处理分段数/总分段数」未暴露。

## 3. reprocess route (`web/app/api/v1/wiki/materials/[id]/reprocess/route.ts`)

- 流程：`store.get(id)` → 不存在 404；`fs.access(storagePath)` → ENOENT 返回「原始文件不存在」404；`markProcessing` + `triggerMaterialDispatch`。
- 幂等：`enqueueClassifyTask`（dispatcher.ts 注释明确「如已有同 materialId 的 waiting/running 任务则跳过」）→ **幂等成立**。
- 错误处理：ENOENT 分支返回明确 404 文案；其他异常 500。**OK**。

## 4. material-dispatch.ts（与 FR-A02 关系）

- `triggerMaterialDispatch` 是 `enqueueMaterialDispatch` 的 fire-and-forget 包装。
- 内部直接调用 `enqueueClassifyTask`（来自 `lib/queue/dispatcher.ts`，FR-A02 的 dispatcher）。
- 失败时回写 `materials.pipeline_status='failed' + error_message`，让 UI/重试看到失败态。
- **没有重复造轮子**——只是 web 上传到 A02 队列的桥梁，符合"上传只负责入队、dispatcher 拥有执行"的注释意图。**OK**。

## 5. W08 spec 逐 AC 对账

| AC | 内容 | 覆盖情况 | 代码位置 / 备注 |
|----|------|----------|------------------|
| AC1 | PDF / Markdown / 纯文本 / EPUB，**单文件 ≤ 50MB** | **未覆盖（与 spec 冲突）** | `wiki-materials.ts` 仅支持 `application/pdf`、`image/jpeg`、`image/png`、`video/mp4`、`audio/mpeg`、`audio/wav`；**Markdown/纯文本/EPUB 全部缺失**；上限 400MB ≠ 50MB。 |
| AC2 | 展示提取进度（已处理分段数/总分段数），大文档自动分段提取 | **部分覆盖** | `materials` 表有 `slice_count` / `extract_count`，但 status route 没返回 `sliceCount` 或 processed/total；UI `PipelineStatusPanel` 只展示状态文案，**没有分段进度条**；`slicing` UI 状态名义存在、实际从不返回。 |
| AC3 | 提取结果按知识类型分类、逐条确认/拒绝/编辑、全选批量确认 | 已覆盖（既有实装） | `knowledge/import/page.tsx` 的 CandidateRow 与批量操作；本次任务未触及，依赖既有功能。 |
| AC4 | 每条提取结果标注来源段落定位，点击查看原文上下文 | 已覆盖（既有实装） | CandidateRow 内 sourceAnchor / sourceContext 展开；本次任务未触及。 |
| AC5 | 提取完成后生成导入摘要 | **部分覆盖** | status route 返回 `knowledgeEntryCount` + `wikiPageCount` + `outputPages`，UI 在 done 态显示 "已生成 N 个知识条目 / M 个 wiki 页面" + 跳转链接；属于简化摘要，无完整 import-summary 文档。 |

## 6. UI 闭环

- 主入口（本次范围）：`web/app/(dashboard)/knowledge/import/page.tsx` L536 直接 `fetch('/kivo/api/v1/wiki/upload', { method: 'POST', body: form })`，拿到 `materialId` 后通过 `useMaterialPipelineStatus(materialId)` 每 2s SWR 轮询 `/api/v1/wiki/materials/{id}/status`，完成或失败时停止轮询。失败可调 `/reprocess`。**闭环 OK**。
- **隐患**：`web/components/material/ImportMaterialButton.tsx` 仍调用旧路径 `POST /api/materials/ingest`（L156、L171），**不是**本次的 `/api/v1/wiki/upload`。系统内同时存在两个素材上传入口，调度路径不一致——容易让上传走旧链路，绕过本次新 dispatch 闭环。
- 进度展示：仅状态标签 + lastError + done 摘要；**没有显式分段进度条**（AC2 要求）。

## 7. 测试

- `web/__tests__/api/import-auto-pipeline.test.tsx`（3 个 it）：
  1. upload route 入库 + 任务 enqueue；
  2. status API 返回进度计数 + lastError；
  3. import 页 UI 触发 upload + 显示 done 摘要。
- 测试覆盖了主链路最小路径，**未覆盖**：reprocess 重试、ENOENT 404、超大文件 / 不支持类型 400、AC2 分段进度断言。
- 子 Agent 只读手段无法实测 vitest 跑通，建议主会话/审计后端跑一次 `npm run test -- import-auto-pipeline`。

## 8. SEVO 流水线

`git diff HEAD --stat` 显示本轮改动**同时触及 `src/`（28 files / 886+ / 65-）和 `web/`（84 files / 963+ / 1932-）**。按宿主规则，src/ 改动 = 必须走 SEVO 流水线。

- 若 codex 任务 prompt 已走 `sevo:create kivo-w08-...`，状态机有记录则 OK；
- 若 codex 直接编码、未触发 SEVO，则属于规则违规需要补走流水线。
- **建议**：主会话查 SEVO 插件状态确认。本审计无法直接看到流水线状态。

---

## 改进建议（按优先级）

**P0（阻断，必须修）**

1. **AC1 文件类型/大小完全错位**：实装支持 `PDF + 图片 + 音视频`、上限 400MB；spec 要求 `PDF + Markdown + 纯文本 + EPUB`、上限 50MB。两边硬冲突。处理路径二选一：
   - 路径 A：改代码对齐 spec（`SUPPORTED_MIME_TYPES` 加 markdown/plain/epub，去掉图片/音视频，`MAX_MATERIAL_FILE_SIZE_BYTES` 改 50MB）。
   - 路径 B：提需求变更，PM 改 spec 把范围扩到「PDF/图片/音视频 + 400MB」并解释多模态导入意图。
   - **不允许保持现状不调整 spec**。

**P1（强烈建议）**

2. **`slicing` 状态名义存在、实际从不返回**：要么在 dispatcher/pipeline-worker 里写入真正的 slicing 中间态；要么从 UI 枚举里删掉，避免误导。
3. **AC2 分段进度未暴露**：status route 增加 `sliceCount` / `extractCount` 字段，UI `PipelineStatusPanel` 加 `已处理 X / 共 Y 段` 进度条。DB 字段已经存在，改动量小。
4. **双上传入口隐患**：`ImportMaterialButton` 用 `/api/materials/ingest`，`knowledge/import` 页用 `/api/v1/wiki/upload`，两个入口走不同链路。建议统一到 `/api/v1/wiki/upload`，或在 spec 里明确各自定位。

**P2（可选）**

5. 测试用例补 ENOENT 重试、超大文件 400、不支持类型 400 三个负向断言。
6. `web/.env.example` 等 84 个 web 文件改动建议派 audit 单独扫一遍是否有副作用。

---

## 总判定

代码层链路完整、解耦合理、复用 FR-A02 dispatcher 干净。**但与 spec AC1/AC2 在「文件类型范围、大小上限、分段进度可见性」上有实质性偏差，不能直接判 W08 完成。** 必须先收敛 spec 与代码（P0 路径 A 或 B），再补 P1 三项，才能宣告 W08 闭环。
