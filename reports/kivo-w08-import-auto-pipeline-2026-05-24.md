# KIVO FR-W08 文档导入自动化收口
Codex（OpenClaw ACP Agent）/ 2026-05-24

## 结论
本次已把 FR-W08 从“上传后只落库”等待后续任务，改成“上传后立即入 dispatcher 队列”。
用户在文档导入页选择文件后，页面会拿到 materialId，并开始轮询编译进度。
导入页现在能显示 pending、slicing、extracting、injecting、done、failed 状态。
状态到 done 后，页面显示已生成的知识条目数和 wiki 页面数，并给出 wiki 页面跳转入口。
状态到 failed 后，页面显示错误信息，并提供重试按钮重新入队。

## 改动文件清单
- web/app/api/v1/wiki/upload/route.ts
- web/app/api/v1/wiki/materials/[id]/reprocess/route.ts
- web/app/api/v1/wiki/materials/[id]/status/route.ts
- web/lib/queue/material-dispatch.ts
- web/lib/wiki-materials-store.ts
- web/hooks/use-material-pipeline-status.ts
- web/app/(dashboard)/knowledge/import/page.tsx
- web/__tests__/api/import-auto-pipeline.test.tsx

## 后端上传链路
上传 API 保留原来的 multipart/form-data 行为。
文件通过 persistUploadedMaterial 写入 materials 表和本地存储后，立刻调用 triggerMaterialDispatch。
triggerMaterialDispatch 是 fire-and-forget，不阻塞上传响应。
实际入队逻辑在 enqueueMaterialDispatch 中完成。
enqueueMaterialDispatch 使用现有 dispatcher 的 enqueueClassifyTask。
入队任务类型仍是 classify_pending，后续由 dispatcher 继续推进分类和 process_pipeline。
入队成功后，materials.pipeline_status 会被设置为 pending。
入队失败时，materials.pipeline_status 会写为 failed。
入队失败时，materials.status 也会写为 failed。
入队失败时，error_message 会保存错误摘要，前端状态 API 会返回 lastError。
上传请求不等待分类、切片、抽取、wiki 生成完成。
上传成功后，不再依赖 cron 扫描才能看到队列任务。

## Dispatcher 配合方式
本次没有新建另一套调度器。
上传后只做一件事：把 materialId 投给已有 dispatcher 队列。
classify_pending 完成后，现有 worker 会在高置信分类成功时 enqueue process_pipeline。
process_pipeline 继续执行 PDF 切片、知识抽取、写 entries、生成 wiki_page。
现有 backfill 仍保留兜底作用。
实时入队和 cron/backfill 不冲突。
重复上传或重复重试时，enqueueClassifyTask 的幂等逻辑会避免 waiting/running 重复任务。

## 重试链路
reprocess API 不再直接 scheduleMaterialProcessing。
reprocess 会先把材料状态重置为 processing/pending。
然后调用 triggerMaterialDispatch 重新入 dispatcher 队列。
这保证用户点“重试”时走同一条 dispatcher 管线。
失败原因通过材料表 error_message 暴露给前端。

## 状态 API
新增 GET /api/v1/wiki/materials/{id}/status。
状态 API 从 WikiMaterialsStore 读取 materials 行。
返回 materialId、fileName、status、pipelineStatus、classificationStatus。
返回 knowledgeEntryCount、wikiPageCount、outputPages、lastError、updatedAt。
status 对前端做了归一化。
pipeline_status failed 或材料 status failed 会显示 failed。
pipeline_status done 或材料 status done 会显示 done。
pipeline_status in_progress 会显示 extracting。
pipeline_status classified 会显示 injecting。
其它状态显示 pending。

## 前端实时反馈
新增 useMaterialPipelineStatus hook。
hook 使用 SWR 轮询状态 API。
轮询频率是 2 秒。
状态到 done 或 failed 后自动停止轮询。
导入页上传文件后，会把文件同步提交到 /api/v1/wiki/upload。
上传返回 fileId 后，导入任务卡片保存 materialId。
任务卡片内新增 PipelineStatusPanel。
Panel 会展示当前编译进度。
处理完成后展示“已生成 N 个知识条目 / N 个 wiki 页面”。
如果后端返回 outputPages，页面会展示可点击的 wiki 页面入口。
如果状态失败，Panel 会显示错误信息和重试按钮。
视觉保持白底黑字、浅色状态块，没有引入暗色主题。

## 测试覆盖
新增 import-auto-pipeline.test.tsx。
测试一：上传 route 写入 material 后，task_queue 出现 classify_pending waiting 任务。
测试一同时断言 payload.materialId 等于上传返回 fileId。
测试一同时断言 materials.pipeline_status 为 pending。
测试二：materials status API 能返回 done 状态、知识条目数和 wiki 页面数。
测试三：导入 UI 上传文件后展示完成摘要和 wiki 页面链接。
测试三 mock 了上传响应和 SWR 状态响应，覆盖 UI 状态机。

## DB 隔离
测试使用 fs.mkdtempSync 创建临时目录。
每个测试设置 process.env.KIVO_DB_PATH 指向临时 kivo.db。
每个测试设置 process.env.KIVO_MATERIALS_DIR 指向临时 uploads 目录。
afterEach 删除临时目录。
测试没有写入生产 projects/kivo/kivo.db。

## 实测结果
已执行 import 相关 vitest。
命令输出已重定向到 /tmp/kivo_w08_vitest_final3.txt。
结果：1 个测试文件通过，3 个测试通过。
通过用例包括上传自动入队、状态 API、导入 UI 状态机。
已执行 web typecheck。
命令输出已重定向到 /tmp/kivo_w08_tsc3.txt。
typecheck 当前仍失败，但失败项来自既有缺失路由：conflicts route、activity route、conflicts resolve route。
本次新增文件的类型错误已清掉。

## 风险说明
本次没有修改 openclaw.json。
本次没有修改 systemctl 服务配置。
本次没有重启任何服务。
本次没有污染生产 DB。
上传 route 仍然只接受原本支持的 PDF、图片、视频、音频类型。
导入页本地候选解析仍保留原逻辑。
新增自动上传只负责把原文件交给 wiki material 管线。
如果后续要让 Markdown、TXT、CSV、EPUB 也进入同一条 wiki material 编译管线，需要扩展 wiki upload 支持类型。
