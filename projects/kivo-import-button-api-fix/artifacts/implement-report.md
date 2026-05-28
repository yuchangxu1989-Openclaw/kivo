# KIVO ImportMaterialButton API 修复实施报告
OpenClaw（dev-01 子Agent）/ 2026-05-24

## 结论
已把导入按钮上传目标切到 `/api/v1/wiki/upload`。
请求体已改为新接口接受的 `multipart/form-data`。
上传字段为 `file` 和 `spaceId=default`。
响应处理已改为读取 `fileId` 与 `status`。
成功 toast、弹窗关闭、父级回调都保留。
旧接口路由目录已删除。

## 改动内容
更新了 `ImportMaterialButton` 的上传目标。
删除了旧接口 `metadata` 提交逻辑。
删除了旧返回体 `materialId` 依赖。
删除了旧返回体 `classificationStatus` 依赖。
保留 400MB 文件大小校验。
保留提交中的 loading 状态。
保留接口失败时的弹窗错误提示。
保留成功后的 toast 反馈。
保留提交成功后的父级 `onIngested` 回调。
上传格式提示收敛到新接口实际支持的 PDF、JPG、PNG、MP3、WAV、MP4。

## 新请求格式
前端现在提交到 `/api/v1/wiki/upload`。
请求方法是 POST。
请求体是 FormData。
`file` 字段放用户选择的文件。
`spaceId` 字段固定为 `default`。
不再提交旧接口使用的 `metadata` 字段。

## 新响应处理
接口成功返回 `success=true`。
接口返回的新素材 ID 是 `fileId`。
接口返回的初始状态是 `processing`。
前端用 `fileId` 作为父级临时卡片 ID。
前端用用户填写标题或文件名作为展示名。

## 验证结果
已执行旧路径搜索。
`web/` 下不再命中 `/api/materials/ingest`。
已执行目标接口 curl 上传测试。
测试文件是一个 1x1 PNG。
返回 HTTP 201。
返回体为 `success=true`。
返回体包含 `fileId`。
返回体状态为 `processing`。

## 构建结果
已按要求执行 `npm run build` 并写入 `/tmp/build-import-fix.log`。
整体构建没有通过。
失败点不是本次导入按钮改动。
根目录构建卡在既有 TypeScript 错误。
Web 构建也存在既有 `MaterialPipelineStatus` 导出缺失问题。
本次没有扩大范围修这些既有问题。

## 补充校验
已对 `ImportMaterialButton.tsx` 做单文件 TypeScript 校验。
单文件校验通过。
这说明本组件改动本身没有语法或基础类型错误。

## 风险
“粘贴链接”模式无法继续走新上传接口。
原因是 `/api/v1/wiki/upload` 只接受本地文件上传。
当前处理为选择链接模式提交时直接提示暂不支持。
如需恢复链接导入，需要后端提供新的链接登记接口。

## AC 覆盖
AC-1：旧接口路径引用已清理。
AC-2：构建已执行，但仓库既有错误导致未通过。
AC-3：新上传接口 curl 实测通过。
