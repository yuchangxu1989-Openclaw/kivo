# KIVO FR-A02 FR-B 音频转写实施报告

OpenClaw（dev-02 子Agent）/ 2026-05-24

## 实现摘要

本次实现把音频素材接入 KIVO 多模态采集链路。
音频默认走本地 Whisper CLI，不依赖远端 API。
默认语言是 zh，默认模型是 tiny，符合本机资源约束。
转写结果会进入统一文本片段结构，供后续 draft 生成和知识抽取使用。
Whisper JSON 中的 segments 会被标准化为 start、end、text。
空文本片段会被过滤，时间戳不合法会转成失败状态。
音频大小和单段时长有默认上限，避免超大文件拖垮采集流程。
转写失败时保留 originalAudioPath，用户可以下载原始音频人工核对或换通道重试。
失败不会生成 draft，也不会把空内容伪装成成功。
本轮修复补齐独立实施报告，并确认音频路径在 collection 测试中通过。

## 默认值说明

默认 Whisper 语言：zh。
默认 Whisper 模型：tiny。
默认开启 segments 输出，用于保留时间戳片段。
默认最大文件大小：50MB。
默认单段最长时长：30 分钟。
调用方可以通过 TranscribeOptions 覆盖 language、model、includeSegments、sourceMediaPath。

## AC 逐条对照

### AC1 本地 Whisper tiny + zh

状态：PASS。
代码位置：src/wiki/collection/audio-transcriber.ts:12-88；src/wiki/collection/multimodal-router.ts:392-404。
DEFAULT_WHISPER_LANGUAGE 为 zh，DEFAULT_WHISPER_MODEL 为 tiny，handleAudio 调用时传入默认值。

### AC2 时间戳片段

状态：PASS。
代码位置：src/wiki/collection/audio-transcriber.ts:150-184；src/wiki/collection/multimodal-router.ts:433-440。
normalizeSegments 输出 start/end/text，audioFragments 转成统一 MultimodalTextFragment。

### AC3 大小与时长上限失败

状态：PASS。
代码位置：src/wiki/collection/audio-transcriber.ts:14-21；src/wiki/collection/audio-transcriber.ts:90-119；src/wiki/collection/audio-transcriber.ts:164-172。
超大文件抛 audio_oversized，片段时长超限抛 audio_too_long。

### AC4 统一文本片段进抽取

状态：PASS。
代码位置：src/wiki/collection/multimodal-router.ts:416-464。
handleAudio 用 transcription.text 生成 draft，并把 segments 转成 fragments。

### AC5 失败保留原始音频

状态：PASS。
代码位置：src/wiki/collection/audio-transcriber.ts:23-35；src/wiki/collection/multimodal-router.ts:466-491。
AudioTranscriptionError 持有 originalAudioPath，handleAudio 失败 metadata 写 originalAudioDownloadPath。

## 失败保留 originalAudioPath 实现说明

WhisperTranscriber 或测试桩抛出 AudioTranscriptionError 时会携带 originalAudioPath。
MultimodalRouter.handleAudio 捕获异常后调用 normalizeAudioTranscriptionFailure。
返回 metadata.failureCode 用于标记 whisper_unavailable、audio_oversized、audio_too_long 等失败码。
返回 metadata.originalAudioDownloadPath 用于保存原始音频下载位置。
warnings 使用人话提示“原始音频已保留，可下载后人工核对或换通道重试”。
失败分支 extractedText 为空，draft 为 undefined，避免产生误导性知识条目。

## 落盘文件列表

- src/wiki/collection/audio-transcriber.ts
- src/wiki/collection/multimodal-router.ts
- src/wiki/collection/video-extractor.ts
- src/wiki/collection/__tests__/audio-transcriber.test.ts
- src/wiki/collection/__tests__/multimodal-router.test.ts
- reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md

## 验证覆盖

audio-transcriber 测试覆盖默认参数、segments 标准化、超大文件和超长片段失败。
multimodal-router 测试覆盖音频转写进入统一 fragments。
multimodal-router 测试覆盖 Whisper 失败时保留原始音频路径。
collection 子目录 vitest 覆盖音频、视频、图片、PDF 和 MIME 路由。

## 已知限制

本地 Whisper CLI 必须存在于运行环境 PATH 中。
本机资源限制下默认只使用 tiny 模型，不自动切到 small、turbo 或 large。
转写质量取决于音频清晰度、说话人重叠程度和 Whisper tiny 的识别能力。
音频降噪、说话人分离、标点精修不在本轮 FR-B 范围。
长音频自动切片只按当前上限校验，复杂断点续跑需后续独立需求。
失败时系统只保留原始音频路径，不自动上传到第三方转写服务。
视频中的音频转写经 video-extractor 调用，FR-B 本身只定义音频入口。
