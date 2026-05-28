# KIVO P0 OCR fallback 修复审计
OpenClaw（audit-02 子Agent）/ 2026-05-24

## 结论
总体判定：需运行态闭环。
OCR fallback 源码层审计通过，5 个 AC 全部 PASS。
未发现必须返工的 OCR 代码缺陷。
当前生产运行态仍可能跑旧 bundle，发布前必须重建并重启 KIVO Web 后复验图片上传。
本次审计只读执行，未修改任何源码文件。

## AC1：paddleocr 不在 PATH 时自动回退 LLM OCR
状态：PASS。
handleImage 使用 `this.ocrAdapter ?? selectDefaultOcrAdapter(context)`。
selectDefaultOcrAdapter 先调用 isExecutableOnPath('paddleocr')。
PATH 无可执行 paddleocr 时返回 LlmOcrAdapter。
isExecutableOnPath 检查 process.env.PATH，逐目录拼接命令名。
isExecutableOnPath 用 existsSync、statSync 和 X_OK 位判断可执行文件。
新增测试把 process.env.PATH 置为空。
测试结果返回 `LLM OCR text`。
测试结果确认 warnings 不包含 `PaddleOCR command not found`。
LlmOcrAdapter 依赖 CollectorContext.llm 和 model。
CollectorContext 类型强制要求 llm 和 model。
LlmOcrAdapter 捕获 llm.complete 异常，返回空文本与 warning，不会继续抛出导致上传崩溃。
小缺口：LLM OCR 失败时 handleImage 的空文本分支会丢掉 LlmOcrAdapter 原始 warning。
这个小缺口不影响 AC1 的“不 command not found、不崩溃、可回退”目标。

## AC2：paddleocr 在 PATH 时仍使用 PaddleOcrAdapter
状态：PASS。
selectDefaultOcrAdapter 在 isExecutableOnPath('paddleocr') 为 true 时返回 new PaddleOcrAdapter()。
PaddleOcrAdapter 仍调用本地 `paddleocr` 命令。
本机当前 command -v paddleocr 无输出，无法做真实 PaddleOCR 运行态验证。
基于源码分支，向后兼容路径存在。
建议补 fake PATH 可执行文件测试，锁死“PATH 存在时走 Paddle”的分支。

## AC3：用户显式传 ocrAdapter 可覆盖默认
状态：PASS。
构造函数保留 `ocrAdapter?: OcrAdapter`。
构造函数写入 `this.ocrAdapter = config?.ocrAdapter ?? null`。
handleImage 优先使用 `this.ocrAdapter`，只有为空才走 selectDefaultOcrAdapter。
既有测试 `routes image content through OCR adapter` 使用 mockOcr。
该测试确认 mockOcr.recognize 被调用一次。
显式覆盖没有被默认选择逻辑破坏。

## AC4：既有 multimodal-router 测试不被破坏
状态：PASS。
已执行：npx vitest run src/wiki/collection/__tests__/multimodal-router.test.ts。
执行结果：1 个测试文件通过。
执行结果：14 个测试全部通过。
vitest 退出码：0。
测试耗时约 4.87 秒。
现有 categorize、text、image、video、audio、unknown、empty OCR 等路径未被破坏。

## AC5：新增 PATH 不存在场景测试
状态：PASS。
测试文件存在用例：`falls back to LLM OCR when paddleocr is not on PATH`。
用例设置 process.env.PATH = ''。
用例断言 extractedText 等于 LLM OCR text。
用例断言不出现 PaddleOCR command not found。
用例断言 context.llm.complete 调用 2 次，覆盖 OCR 和 draft 构建。
测试文件用 afterEach 恢复 PATH，避免污染后续测试。

## 类型检查
已执行：npx tsc --noEmit。
执行结果：失败，退出码 2。
错误集中在 badcase-extractor、subject-propagation、subject-aware-injector、repository 类型定义不一致。
未发现错误来自 multimodal-router.ts。
未发现错误来自 ocr-adapter.ts。
未发现错误来自 multimodal-router.test.ts。
结论：当前 tsc 失败不是这次 OCR fallback 引入。

## 边界守护
git diff -- src/wiki/collection 显示 4 个文件有改动。
符合 OCR 审计范围的文件：multimodal-router.ts。
符合 OCR 审计范围的文件：ocr-adapter.ts。
符合 OCR 审计范围的文件：__tests__/multimodal-router.test.ts。
额外出现的文件：video-extractor.ts。
video-extractor.ts 是视频抽帧能力，不属于本次 OCR fallback 修复。
当前工作树还存在大量 web 和其他项目改动，不在本次 OCR 源码审计归因范围内。
发布时要拆清 OCR fallback 与 video/web 其他未审计改动。

## 运行态闭环
源码通过不等于用户上传图片已恢复。
本次任务明确禁止 build、restart、pkill，所以未做运行态替换。
发布前必须重建 KIVO Web。
发布前必须重启 KIVO Web。
发布后必须用真实图片上传走一遍，确认不再返回 command not found。
发布后还要确认图片文本能进入素材/词条流转，而不是只返回空成功。

## 最终判断
OCR fallback 修复满足 5 个 AC。
无需因为 OCR fallback 源码本身返工。
阻断项是运行态尚未闭环。
附带风险是当前工作树混有 video-extractor 和大量 web 改动，合并发布时要拆清楚。
建议下一步：由发布/运维任务执行重建、重启、真实图片上传复验。
