# KIVO FR-A02 FR-D 上传路由器实施报告

OpenClaw（dev-02 子Agent）/ 2026-05-24

## 结论

FR-D 上传路由器已经完成源码层实施。

飞书、Web、URL 三个入口已收敛到同一个上传路由器；路由结果会形成素材元数据，并可写入 materials 表的 route_category、route_params_json、source_channel、pipeline_status 等字段。

专项单测已覆盖 image、audio、video、unsupported、conflict，以及二次上传稳定性。

类型检查按要求执行并写入 `/tmp/fr-d-tsc.txt`。当前全仓 `npm run typecheck` 未通过，失败点来自仓库既有 subject / badcase / repository 类型漂移，不是本次 FR-D 新增代码触发。FR-D 专项单测通过。

## 实施范围

本次只改源码层和测试层，没有修改 `web/`，没有修改 `openclaw.json`，没有修改 spec。

涉及文件：

- `src/wiki/collection/upload-router.ts`
- `src/wiki/collection/multimodal-router.ts`
- `src/wiki/types.ts`
- `src/wiki/index.ts`
- `__tests__/fr-a02-upload-router.test.ts`

## AC 覆盖清单

### AC1：多入口共享同一路由器，结果作为素材元数据持久化

状态：完成。

实现位置：

- `src/wiki/collection/upload-router.ts:24` 定义 `UploadRouter`
- `src/wiki/collection/upload-router.ts:36` 飞书入口 `routeFromFeishu`
- `src/wiki/collection/upload-router.ts:40` Web 入口 `routeFromWeb`
- `src/wiki/collection/upload-router.ts:44` URL 入口 `routeFromUrl`
- `src/wiki/collection/upload-router.ts:49` `persistMaterial` 写入素材元数据

验证位置：

- `__tests__/fr-a02-upload-router.test.ts:44` 验证三个入口共用同一路由器
- `__tests__/fr-a02-upload-router.test.ts:58` 验证路由字段已持久化

### AC2：mime 主、后缀辅，冲突以 mime 为准并记录冲突日志

状态：完成。

实现位置：

- `src/wiki/collection/multimodal-router.ts:72` `decideRoute` 统一路由决策
- `src/wiki/collection/multimodal-router.ts:75` MIME 路由判断
- `src/wiki/collection/multimodal-router.ts:76` 后缀路由判断
- `src/wiki/collection/multimodal-router.ts:77` MIME 优先，后缀兜底
- `src/wiki/collection/multimodal-router.ts:79` 冲突日志生成

验证位置：

- `__tests__/fr-a02-upload-router.test.ts:97` 验证 `renamed.mp4 + image/png` 路由到 image
- `__tests__/fr-a02-upload-router.test.ts:102` 验证 conflict 为 true
- `__tests__/fr-a02-upload-router.test.ts:103` 验证冲突日志存在

### AC3：不支持类型直接标 unsupported，不进入 processing

状态：完成。

实现位置：

- `src/wiki/collection/multimodal-router.ts:83` unsupported 决策状态
- `src/wiki/collection/multimodal-router.ts:91` 可读中文提示
- `src/wiki/collection/multimodal-router.ts:123` unsupported 提前返回，不进入解析处理
- `src/wiki/collection/upload-router.ts:94` unsupported 写入 `pipeline_status = unsupported`

验证位置：

- `__tests__/fr-a02-upload-router.test.ts:82` unsupported 用例
- `__tests__/fr-a02-upload-router.test.ts:87` 验证 route channel 是 unsupported
- `__tests__/fr-a02-upload-router.test.ts:92` 验证 materials.status 是 unsupported
- `__tests__/fr-a02-upload-router.test.ts:93` 验证 pipeline_status 是 unsupported

### AC4：路由结果含通道名和解析参数，下游只读

状态：完成。

实现位置：

- `src/wiki/types.ts:281` 定义 `UploadRouteChannel`
- `src/wiki/types.ts:284` 定义 `UploadRouteDecision`
- `src/wiki/collection/multimodal-router.ts:90` 返回 `parseParams`
- `src/wiki/collection/multimodal-router.ts:497` `attachRoute` 把 route 和 parseParams 挂到结果元数据
- `src/wiki/collection/multimodal-router.ts:545` image/audio/video/document/unsupported 解析参数集中定义

验证位置：

- `__tests__/fr-a02-upload-router.test.ts:68` 验证 audio 参数
- `__tests__/fr-a02-upload-router.test.ts:77` 验证 video 通道
- `__tests__/fr-a02-upload-router.test.ts:78` 验证 video 参数
- `__tests__/fr-a02-upload-router.test.ts:104` 验证 conflict 场景仍输出 image 参数

### AC5：二次上传路由稳定不漂移

状态：完成。

实现位置：

- `src/wiki/collection/multimodal-router.ts:103` material 元数据生成
- `src/wiki/collection/multimodal-router.ts:557` sourceRef 优先生成稳定 materialId
- `src/wiki/collection/multimodal-router.ts:562` storagePath 基于稳定 materialId 生成
- `src/wiki/collection/upload-router.ts:65` `ON CONFLICT(id) DO UPDATE` 保持重复写入稳定

验证位置：

- `__tests__/fr-a02-upload-router.test.ts:107` 二次上传稳定性用例
- `__tests__/fr-a02-upload-router.test.ts:112` 验证 route 完全一致
- `__tests__/fr-a02-upload-router.test.ts:113` 验证 materialId 一致
- `__tests__/fr-a02-upload-router.test.ts:114` 验证 storagePath 一致

## 测试结果

专项单测命令：`npx vitest run __tests__/fr-a02-upload-router.test.ts > /tmp/fr-d-vitest.txt 2>&1`

结果：通过。1 个测试文件、6 个测试全部通过。

类型检查命令：`npm run typecheck > /tmp/fr-d-tsc.txt 2>&1`

结果：未通过。失败集中在既有 subject / badcase / repository 类型漂移：badcase extractor 导出缺失、KnowledgeEntry / KnowledgeSource 字段不一致、repository 类型出口缺失。

## 已知问题与跟进

1. 全仓 typecheck 当前被既有类型漂移挡住；FR-D 专项测试已通过。
2. 本次新增的是源码层上传路由器和持久化能力；任务明确禁止改 `web/`，所以没有接 UI 层。
3. `persistMaterial` 会自动补齐缺失的 route 相关列，用于兼容旧 materials 表；当前实际库已具备这些列。
4. unsupported 状态不会进入多模态解析分支；未来队列消费端应继续以 `pipeline_status = unsupported` 跳过。
5. 文档类通道路由统一叫 `document`，内部解析仍复用已有 PDF / text 处理逻辑，避免改动下游解析器接口。
