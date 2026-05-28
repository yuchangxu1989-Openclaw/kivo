# KIVO FR-A02 FR-A + FR-B 多模态扩展实现审计

OpenClaw（audit-02 子Agent）/ 2026-05-24

## 结论
总体判定：需修缺陷。
FR-A 图片 OCR：PARTIAL。
FR-B 音频转写：PASS。
代码真实落盘，核心实现不是空壳。
阻断点：src/wiki/collection 测试未通过。
关键缺口：增强 OCR 配置自动发现不生效，FR-A/FR-B 实现报告缺失。

## 审计范围与方法
Spec 真相源：projects/kivo/projects/kivo-fr-a02-multimodal-extend/specs/product-requirements.md §5。
审计对象：src/wiki/collection 多模态路由、OCR、音频转写、视频抽取、相关类型与测试。
只读审计：未修改代码、未改 openclaw.json、未重启服务、未跑 build。
实测：读取 spec，检查 git diff，运行 collection vitest，运行 tsc，检查报告文件。
vitest 输出：/tmp/audit-fra-frb-vitest.txt。
tsc 输出：/tmp/audit-fra-frb-tsc.txt。

## 落盘文件
multimodal-router.ts：图片、音频、视频处理入口已落盘。
ocr-adapter.ts：本地 OCR、公式 OCR、增强 OCR 组合逻辑已落盘。
enhanced-ocr-adapter.ts：增强 OCR HTTP 适配器已新建。
ocr-config.ts：增强 OCR 配置读取已新建。
audio-transcriber.ts：Whisper CLI 转写适配器已落盘。
video-extractor.ts：关键帧抽取扩展已落盘。
audio-transcriber、ocr-adapter、multimodal-router、video-extractor 测试均存在。

## FR-A 图片 OCR AC 审计
FR-A AC1 本地 OCR 默认通道：PASS。
证据：selectDefaultOcrAdapter 先查 PATH 中 paddleocr，存在时返回 PaddleOcrAdapter。
证据：paddleocr 不存在时回退 LlmOcrAdapter。
证据：PaddleOcrAdapter 调用 paddleocr CLI 并解析 inference_results.txt。
风险：相关测试当前失败，原因是公式检测额外触发一次 llm.complete，不是默认通道缺失。

FR-A AC2 公式识别与 LaTeX 还原：PASS。
证据：FormulaAwareOcrAdapter 并行执行 base.recognize 与 detectFormulas。
证据：detectFormulas 要求返回 formulas，字段含 bbox 与 latex。
证据：公式块写入 textBlocks，type=formula，source=formula-detector。
证据：常规 OCR 块与公式块合并，分别保留 text、bbox、type、confidence。

FR-A AC3 增强通道备选：PARTIAL。
证据：ocr-config.ts 从 openclaw.json 读取 enhanced OCR 配置。
证据：CompositeOcrAdapter 会在主通道空文本、失败、低置信度时调用 enhanced。
证据：VisionEnhancedOcrAdapter 已实现 OpenAI-compatible vision OCR 请求。
缺口：MultimodalRouter 构造函数把未传 enhancedOcrAdapter 的情况置为 null，导致 openclaw.json 自动发现不生效。
缺口：lowConfidenceThreshold 被读取，但没有传给 CompositeOcrAdapter。

FR-A AC4 原图引用与区域坐标：PASS。
证据：handleImage 用 sourceRef 或 fileName 生成 imageId。
证据：ensureTextBlocks / legacyBlocksToTextBlocks 保留 bbox、type、confidence、imageId。
证据：fragments 写出 block.text、sourceMediaPath、coordinates。
证据：metadata 保留 sourceMediaPath、textBlocks、blocks、imageId。

FR-A AC5 失败状态分类：PASS。
证据：OcrFailureReason 定义 image_unreadable、image_empty、ocr_engine_unavailable、ocr_low_confidence。
证据：validateOcrImage 对空 buffer 返回 image_empty，对非图片头返回 image_unreadable。
证据：OCR 调用异常在 handleImage 中标记 ocr_engine_unavailable。
证据：OCR 无文本时按 textBlocks 情况落 image_empty 或 ocr_low_confidence。
注意：旧测试传入 2 字节 PNG 头，当前逻辑判 image_unreadable，测试仍期待 no text。

## FR-B 音频转写 AC 审计
FR-B AC1 本地 Whisper tiny + zh：PASS。
证据：DEFAULT_WHISPER_LANGUAGE = zh。
证据：DEFAULT_WHISPER_MODEL = tiny。
证据：WhisperTranscriber 调用 whisper CLI，传入 --language 与 --model。
证据：TranscribeOptions 允许 language、model、includeSegments、sourceMediaPath、大小与时长上限配置。

FR-B AC2 时间戳片段：PASS。
证据：Whisper JSON segments 被 normalizeSegments 转成 { start, end, text }。
证据：空文本段被过滤，end 小于 start 会失败。
证据：TranscribeResult 暴露 segments。

FR-B AC3 大小与时长上限失败：PASS。
证据：DEFAULT_AUDIO_LIMITS 定义 50MB 与 30 分钟片段上限。
证据：文件超限抛 audio_oversized。
证据：片段超时抛 audio_too_long。
证据：测试覆盖 oversized 与 overlong segment。

FR-B AC4 统一文本片段进抽取：PASS。
证据：handleAudio 成功后调用 audioFragments。
证据：segments 转成 MultimodalTextFragment，含 text、startSeconds、endSeconds、sourceMediaPath。
证据：handleAudio 用 transcription.text 调 buildDraft，继续走统一 Wiki draft 逻辑。
证据：multimodal-router.test 覆盖 audio fragments 与 draft。

FR-B AC5 失败保留原始音频：PASS。
证据：AudioTranscriptionError 持有 originalAudioPath。
证据：handleAudio 失败 metadata 写 originalAudioDownloadPath。
证据：normalizeAudioTranscriptionFailure 明确提示原始音频保留，可下载核对或重试。
证据：测试覆盖 whisper_unavailable 时保留 uploads/original.wav。

## 测试结果
collection 测试未通过。
结果：4 个测试文件，3 个通过，1 个失败。
总数：42 条测试，40 条通过，2 条失败。
失败 1：falls back to LLM OCR when paddleocr is not on PATH。
原因：期待 llm.complete 2 次，实际 3 次，多出来的是公式检测调用。
失败 2：handles image OCR returning empty text。
原因：输入只有 2 字节，被 validateOcrImage 判 image_unreadable，测试仍期待 no text。
判断：测试红灯是发版阻断。

## 类型检查
tsc --noEmit 未通过。
本次新增 collection 范围没有直接类型报错。
当前 tsc 报错集中在 badcase-extractor、subject propagation、subject-aware-injector、entry-validator 等其他文件。
判断：类型检查仍是红灯，但本任务范围未发现新增 collection 类型错误。

## 边界检查
src/wiki/collection 范围内 6 个已跟踪文件改动。
新增 3 个未跟踪文件：enhanced-ocr-adapter.ts、ocr-config.ts、ocr-adapter.test.ts。
src/wiki/index.ts 与 src/wiki/types.ts 也被改动，用于导出路由与扩展类型。
web/ 下存在大量改动，不应归入本次 FR-A/FR-B 审计结论，后续提交要防混入。
openclaw.json 未见本任务修改痕迹。
selectDefaultOcrAdapter 已保留并扩展。

## 报告缺口
FR-B 主报告 kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md：未找到。
FR-A 主报告 kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md：未找到。
本审计报告已写入 projects/kivo/reports/kivo-fr-a02-fra-frb-impl-audit-2026-05-24.md。

## 缺陷清单
P0：collection 测试失败，不能发版。
P1：增强 OCR 自动配置发现不生效。
P1：增强 OCR lowConfidenceThreshold 读取后未使用。
P1：FR-A 与 FR-B 实现报告均未落盘。
P2：默认公式检测让普通图片多一次 LLM 调用，成本与延迟上升。
P2：测试夹具与 validateOcrImage 的最小合法图片口径不一致。

## 修复建议
先修测试红灯与增强 OCR 配置缺口，不要直接发版。
修正 enhancedOcrAdapter 的 undefined/null 语义，让未显式禁用时能读取 openclaw.json 配置。
把 lowConfidenceThreshold 传给 CompositeOcrAdapter。
修正两条失败测试，避免用固定 LLM 调用次数误判。
空 OCR 测试改用合法图片头，或预期 image_unreadable。
补 FR-A 与 FR-B 实现报告。
修复后复跑 src/wiki/collection vitest。
