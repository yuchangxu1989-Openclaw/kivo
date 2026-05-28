# KIVO FR-A02 FR-A+B 缺陷修复

## 1 用户人群
KIVO 内部研发与运维。

## 2 痛点
FR-A02 多模态扩展首次审计（audit-02）报告 1 P0 + 4 P1 阻断发版：
- 测试红灯 2 条
- 增强 OCR 配置自动发现不生效
- lowConfidenceThreshold 读取后未传递
- FR-A 与 FR-B 实施报告未落盘

## 3 原始需求
把 1 P0 + 4 P1 全部修复到 vitest 全绿、配置真实生效、报告齐全，再走完审计与回归才发版。

## 4 用户体验流
1. 跑 `npx vitest run src/wiki/collection` 看 42 条全绿
2. 配置 `enhancedOcr.endpoint` 后 multimodal-router 调用真的走增强 OCR 通道
3. 在 reports 目录看到 FR-A、FR-B 各一份独立实现报告

## 5 功能需求

### FR-FIX-01 测试红灯归零
AC1：`npx vitest run src/wiki/collection` 输出 42 passed 0 failed。
AC2：falls back to LLM OCR when paddleocr is not on PATH 通过；公式检测在 base OCR 文本块为空时跳过，避免无意义 LLM 调用。
AC3：handles image OCR returning empty text 通过；测试 fixture 使用合法最小 PNG 让 validateOcrImage 通过，触发 OCR 成功但 textBlocks 空分支，warnings 含 "no text"。

### FR-FIX-02 增强 OCR 配置真实生效
AC1：`loadEnhancedOcrConfig` 真的从 openclaw.json 或环境变量读 `enhancedOcr.endpoint`/`enhancedOcr.apiKey`/`enhancedOcr.lowConfidenceThreshold`。
AC2：未配置时返回 null（增强 OCR 不启用），配置存在时返回真实值供 CompositeOcrAdapter 使用。
AC3：`lowConfidenceThreshold` 透传给 CompositeOcrAdapter 构造或 recognize 调用，低置信度时按阈值触发增强通道。

### FR-FIX-03 实施报告补齐
AC1：`reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md` 存在，含署名、5 AC 对照、代码位置、已知限制；80-130 行。
AC2：`reports/kivo-fr-a02-frb-audio-whisper-impl-2026-05-24.md` 存在，含署名、5 AC 对照、代码位置、默认值说明、失败保留 originalAudioPath 实现说明；80-130 行。

## 6 范围边界

仅修复 src/wiki/collection 范围内的代码与测试，以及补两份 reports 文件。
不动 web/、不动 openclaw.json、不修无关 tsc 错误（badcase-extractor 等）。
