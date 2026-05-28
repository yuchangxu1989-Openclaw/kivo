# KIVO FR-A02 FR-A 图片 OCR 实施报告

OpenClaw（dev-02 子Agent）/ 2026-05-24

## 实现摘要

本次实现把图片素材接入 KIVO 采集链路，入口在多模态路由。
图片先做轻量格式校验，空文件和明显不是图片的字节会被直接分类为失败。
默认 OCR 通道优先使用本地 PaddleOCR，PATH 中没有 paddleocr 时自动回退到 LLM 视觉 OCR。
公式识别作为独立包裹层运行，只有基础 OCR 识别出文本块后才触发公式检测。
增强 OCR 作为可选后备通道，主通道失败、空文本或低置信度时才调用。
所有 OCR 结果都会归一成 textBlocks，保留坐标、类型、置信度和来源。
图片解析成功后会继续进入统一 draft 生成流程，失败时不会生成 draft。
失败状态会写入 metadata.failureReason，前端和运维可以直接判断原因。
原图路径通过 sourceMediaPath 保留，文本片段也会携带坐标，方便回看原图区域。
本轮修复重点补齐了公式检测短路、增强 OCR 配置读取、阈值透传和回归测试。

## AC 逐条对照

### AC1 本地 OCR 默认通道

状态：PASS。
代码位置：src/wiki/collection/multimodal-router.ts:242-260；src/wiki/collection/ocr-adapter.ts:214-268。
selectDefaultOcrAdapter 优先检查 PATH 中 paddleocr，存在时使用 PaddleOcrAdapter，不存在时返回 LlmOcrAdapter。

### AC2 公式识别与 LaTeX 还原

状态：PASS。
代码位置：src/wiki/collection/ocr-adapter.ts:285-393。
FormulaAwareOcrAdapter 合并基础文本块和 formula-detector 输出，公式块 type=formula，text 写 LaTeX。

### AC3 增强通道备选

状态：PASS。
代码位置：src/wiki/collection/ocr-config.ts:50-108；src/wiki/collection/multimodal-router.ts:254-262；src/wiki/collection/enhanced-ocr-adapter.ts:45-177。
loadEnhancedOcrConfig 读取 enhancedOcr 和 ENHANCED_OCR_*，CompositeOcrAdapter 在低置信度等场景调用增强通道。

### AC4 原图引用与区域坐标

状态：PASS。
代码位置：src/wiki/collection/multimodal-router.ts:289-330；src/wiki/collection/ocr-adapter.ts:118-159。
imageId、sourceMediaPath、bbox、textBlocks 和 fragments 都被保留。

### AC5 失败状态分类

状态：PASS。
代码位置：src/wiki/collection/ocr-adapter.ts:82-102；src/wiki/collection/multimodal-router.ts:225-240；src/wiki/collection/multimodal-router.ts:274-288。
空图片、不可读图片、引擎不可用、低置信度分别落到明确 failureReason。

## 本轮修复点

1. FormulaAwareOcrAdapter 不再并行无条件调用公式检测。
2. base.recognize 返回后，如果 textBlocks 为空，直接返回基础 OCR 结果。
3. 空文本图片不会再额外消耗一次 LLM 公式检测调用。
4. 空 OCR 测试 fixture 改为合法最小 PNG。
5. validateOcrImage 能放行 fixture，测试进入“识别成功但无文本”的真实分支。
6. loadEnhancedOcrConfig 改为真实读取 ~/.openclaw/openclaw.json。
7. 配置缺失、文件缺失、JSON 解析失败时返回 null，不启用增强 OCR。
8. 环境变量 ENHANCED_OCR_ENDPOINT、ENHANCED_OCR_API_KEY、ENHANCED_OCR_MODEL、ENHANCED_OCR_LOW_CONFIDENCE_THRESHOLD 可覆盖文件配置。
9. MultimodalRouter 创建 CompositeOcrAdapter 时透传 lowConfidenceThreshold。
10. CompositeOcrAdapter 继续按阈值判断是否触发增强 OCR。

## 落盘文件列表

- src/wiki/collection/ocr-adapter.ts
- src/wiki/collection/ocr-config.ts
- src/wiki/collection/enhanced-ocr-adapter.ts
- src/wiki/collection/multimodal-router.ts
- src/wiki/collection/__tests__/ocr-adapter.test.ts
- src/wiki/collection/__tests__/multimodal-router.test.ts
- reports/kivo-fr-a02-fra-image-ocr-impl-2026-05-24.md

## 验证覆盖

validateOcrImage 覆盖空 buffer、非图片头和常见图片头。
FormulaAwareOcrAdapter 覆盖文本块与公式块合并。
FormulaAwareOcrAdapter 覆盖基础 OCR 空文本块时跳过公式检测。
CompositeOcrAdapter 覆盖主通道高置信度不调用增强通道。
CompositeOcrAdapter 覆盖低置信度触发增强通道。
CompositeOcrAdapter 覆盖主通道失败后增强通道接管。
MultimodalRouter 覆盖 PaddleOCR 不存在时回退 LLM OCR。
MultimodalRouter 覆盖图片 OCR 返回空文本时给出 no text 警告。
collection 子目录 vitest 回归覆盖图片、音频、视频、PDF 和路由。

## 已知限制

本地 PaddleOCR 是否可用取决于运行机器 PATH 和 Python 环境。
增强 OCR 只有配置 endpoint 与 apiKey 后才启用，当前未配置时会返回 null。
公式检测依赖视觉 LLM 的结构化 JSON 返回，异常时降级为基础 OCR 结果。
坐标精度取决于 OCR 引擎返回质量，系统只负责保留与传递。
当前实现不裁剪局部区域重试，增强 OCR 以整图作为输入。
图片方向纠正、复杂表格结构还原不在本轮 FR-A 范围。
多页图片格式按单张图片处理，逐页切分需后续独立需求。
增强 OCR 的 provider 字段当前只作为配置语义保留，默认适配 OpenAI-compatible vision endpoint。
