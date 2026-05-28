# KIVO FR-A02 FR-A+B 修复复审报告

OpenClaw（audit-02 子Agent）/ 2026-05-24

## 总判定

PASS。
7 个复审点全部通过。
可发版。

## 7 AC 逐条对照

### 1. FR-FIX-01 AC1：collection vitest 全绿

判定：PASS。
实测命令：`npx vitest run src/wiki/collection > /tmp/audit-fra-frb-fix-vitest.txt 2>&1`。
命令退出码：0。
输出摘要：

```text
Test Files  4 passed (4)
Tests  42 passed (42)
Duration  1.82s
```

证据文件：/tmp/audit-fra-frb-fix-vitest.txt。
覆盖 multimodal-router、ocr-adapter、audio-transcriber、video-extractor 四组测试。

### 2. FR-FIX-01 AC2：base OCR 空文本块时跳过公式检测

判定：PASS。
证据：src/wiki/collection/ocr-adapter.ts:310-316。
代码先执行 base OCR，再标准化 textBlocks；当 `baseBlocks.length === 0` 时直接 `return normalizedBase`。
证据：src/wiki/collection/ocr-adapter.ts:321。
`detectFormulas` 只会在空文本块提前返回之后执行。
证据：src/wiki/collection/__tests__/multimodal-router.test.ts:126-152。
`falls back to LLM OCR when paddleocr is not on PATH` 显式关闭公式检测，只保留 LLM OCR 和 draft 生成两次 llm.complete 调用。
实测 42 条测试通过，前一轮 3 次调用问题已消失。

### 3. FR-FIX-01 AC3：空 OCR 测试使用合法最小 PNG 并进入 no text 分支

判定：PASS。
证据：src/wiki/collection/__tests__/multimodal-router.test.ts:273-294。
`handles image OCR returning empty text` 的 fixture 为 PNG buffer。
客观校验：Node 解析该 hex 后 buffer 长度为 46 字节。
客观校验：前 8 字节为 PNG magic：`89504e470d0a1a0a`。
客观校验：IHDR 长度为 13，类型为 `IHDR`。
证据：src/wiki/collection/__tests__/multimodal-router.test.ts:291-294。
测试断言 category 为 image、extractedText 为空、draft 不生成、warnings[0] 包含 `no text`。
实测该测试随 collection vitest 通过。

### 4. FR-FIX-02 AC1 + AC2：增强 OCR 配置真实读取，未配置返回 null

判定：PASS。
证据：src/wiki/collection/ocr-config.ts:46-58。
`loadEnhancedOcrConfig` 默认读取 `$HOME/.openclaw/openclaw.json`，也允许 `openclawJsonPath` 覆盖；实现使用 `readFileSync(path, 'utf-8')` 读取 top-level `enhancedOcr`。
证据：src/wiki/collection/ocr-config.ts:91-104。
实现读取 `ENHANCED_OCR_PROVIDER`、`ENHANCED_OCR_API_KEY`、`ENHANCED_OCR_ENDPOINT`、`ENHANCED_OCR_MODEL`、`ENHANCED_OCR_ENABLED`、`ENHANCED_OCR_LOW_CONFIDENCE_THRESHOLD`。
证据：src/wiki/collection/ocr-config.ts:65-67。
环境变量覆盖文件值；文件配置和环境变量都不存在时返回 null。
证据：src/wiki/collection/ocr-config.ts:69-87。
配置存在时返回 provider、apiKey、endpoint、model、lowConfidenceThreshold、enabled；未启用、缺 apiKey 或缺 endpoint 时返回 null。
证据：src/wiki/collection/multimodal-router.ts:366-378。
MultimodalRouter 调用 `loadEnhancedOcrConfig`，配置有效时创建 `VisionEnhancedOcrAdapter` 并传入 endpoint、apiKey、model。

### 5. FR-FIX-02 AC3：lowConfidenceThreshold 透传 CompositeOcrAdapter

判定：PASS。
证据：src/wiki/collection/multimodal-router.ts:81-83。
MultimodalRouter 保存 enhancedOcrAdapter、openclawJsonPath、lowConfidenceThreshold。
证据：src/wiki/collection/multimodal-router.ts:257-263。
存在增强通道时创建 CompositeOcrAdapter，并传入 `lowConfidenceThreshold: this.resolveLowConfidenceThreshold()`。
证据：src/wiki/collection/multimodal-router.ts:381-382。
阈值优先使用显式配置，否则读取 `loadEnhancedOcrConfig()` 返回值里的 lowConfidenceThreshold。
证据：src/wiki/collection/ocr-adapter.ts:433-466。
CompositeOcrAdapter 接收 lowConfidenceThreshold，默认 0.6；primary confidence 小于等于阈值时触发 enhanced 通道。
证据：src/wiki/collection/__tests__/ocr-adapter.test.ts:184-190。
测试覆盖低置信度触发增强通道，并断言 enhanced.recognize 被调用一次。

### 6. FR-FIX-03 AC1：FR-A 图片 OCR 实施报告补齐

判定：PASS。
证据文件：reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md。
行数：94 行，满足 80-130 行。
证据：reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md:1。
标题存在。
证据：reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md:3。
署名存在：OpenClaw（dev-02 子Agent）/ 2026-05-24。
证据：reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md:18-47。
包含 AC1 到 AC5 逐条对照，并逐条写出代码位置。
证据：reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md:85-94。
包含已知限制。

### 7. FR-FIX-03 AC2：FR-B 音频 Whisper 实施报告补齐

判定：PASS。
证据文件：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md。
行数：92 行，满足 80-130 行。
证据：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md:1。
标题存在。
证据：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md:3。
署名存在：OpenClaw（dev-02 子Agent）/ 2026-05-24。
证据：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md:18-25。
包含默认值说明。
证据：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md:27-57。
包含 AC1 到 AC5 逐条对照，并逐条写出代码位置。
证据：reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md:59-66。
包含失败保留 originalAudioPath 实现说明。

## 已知遗留缺陷

本次复审未发现阻断发版的缺陷。
保留非阻断说明：本次只按 spec 审计 src/wiki/collection 范围、两份报告和 collection vitest。
未跑生产构建、未跑全量 tsc、未改 openclaw.json、未重启服务。

## 发版建议

可以发版。
发版前建议只做常规提交检查，避免把 web/ 或无关改动混入本次 FR-A/FR-B 修复提交。
