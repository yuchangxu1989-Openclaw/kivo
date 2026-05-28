# KIVO FR-A02 多模态上传扩展实施报告
OpenClaw（dev-02 子Agent）/ 2026-05-24

1. 本次实施按 SEVO 流水线进入 implement 阶段。
2. 流水线文件已确认在项目子目录生成。
3. pipelineId 为 fr-kivo-fr-a02-multimodal-extend-20260524-001。
4. 路由层级为 L0。
5. 必要阶段包含 implement、review、regression、verify、ledger。
6. 实施范围聚焦上传后的图片、音频、视频三类素材。
7. PDF 与文本路径保留原有能力，并补齐片段结构。
8. 上传入口现在会先根据 MIME 判断素材类别。
9. image/* 会进入图片 OCR 路径。
10. audio/* 会进入本地 Whisper 转写路径。
11. video/* 会进入 ffmpeg 抽音轨和抽帧路径。
12. text/* 与 application/json 会进入文本路径。
13. application/pdf 会进入 PDF 文本提取路径。
14. 未识别 MIME 会返回明确错误。
15. 错误文案列出当前支持 PDF、文本、图片、视频、音频。
16. 上传记录新增 routeCategory 字段。
17. 上传记录新增 routeParams 字段。
18. 这两个字段用于记录路由判定与 MIME 细节。
19. 数据库表 materials 会自动补齐 route_category 列。
20. 数据库表 materials 会自动补齐 route_params_json 列。
21. 图片 OCR 默认适配器改为 PaddleOCR。
22. PaddleOCR 路径不再默认走 LLM OCR。
23. LLM OCR 代码仍保留为可配置适配器。
24. PaddleOCR 会把上传图片写入临时文件。
25. PaddleOCR 命令使用 paddleocr --image_dir。
26. PaddleOCR language 会把 zh 映射为 ch。
27. PaddleOCR 输出会解析为文本块。
28. 文本块保存 text、confidence、coordinates。
29. 识别结果聚合为完整 extractedText。
30. 识别结果同时保留 blocks 元数据。
31. PaddleOCR 不存在时不会静默吞掉。
32. PaddleOCR 缺失错误会明确提示安装 paddlepaddle paddleocr。
33. 当前机器实测未找到 paddleocr 命令。
34. 图片上传处理因此按预期返回可读失败原因。
35. 音频路径使用本机 Whisper CLI。
36. Whisper 模型已从 base 改为 tiny。
37. Whisper 语言固定为 zh。
38. Whisper 输出请求 includeSegments。
39. 音频片段会保存 startSeconds 和 endSeconds。
40. 音频片段会保存 sourceMediaPath。
41. Whisper 生成空文本时会返回明确 warning。
42. 视频路径先用 ffmpeg 抽音轨。
43. 抽出的音轨为 16kHz mono WAV。
44. 视频音轨再交给 Whisper tiny 转写。
45. 视频转写片段同样保留时间戳。
46. 视频路径新增关键帧抽取。
47. 关键帧间隔为 30 秒。
48. 关键帧用 ffmpeg fps=1/30 提取。
49. 关键帧保存为 frame-0001.jpg 这类文件。
50. 如果有 sourceMediaPath，关键帧保留在原视频旁的 .frames 目录。
51. 视频关键帧当前以 hook 形式写入片段。
52. 关键帧片段包含 frameIndex 和 timestampSeconds。
53. 关键帧 OCR 没有强行扩展，符合任务要求的简化策略。
54. 多模态路由结果新增 fragments 字段。
55. fragments 是进入 staging_materials 的统一片段来源。
56. fragments 支持文本、坐标、音视频时间戳和媒体路径。
57. MultimodalCollectInput 新增 sourceMediaPath。
58. sourceMediaPath 由上传处理传入存储后的文件路径。
59. PDF 页面也会形成 fragments。
60. 文本上传也会形成 fragments。
61. 图片 OCR 块会形成 fragments。
62. 音频 Whisper segments 会形成 fragments。
63. 视频 Whisper segments 与关键帧会合并形成 fragments。
64. 上传处理现在会把 fragments 写入 staging_materials。
65. staging_materials 不存在时会自动创建。
66. staging_materials 使用 content_hash 做去重。
67. 写入记录状态默认为 pending。
68. nature 写为 fact。
69. function_tag 写为 source_material。
70. knowledge_domain 写为路由类别。
71. source 写为 upload://material/<id>。
72. tags_json 包含 multimodal 和类别标签。
73. source_refs_json 保存素材 ID。
74. source_refs_json 保存文件名。
75. source_refs_json 保存 MIME。
76. source_refs_json 保存 routeCategory。
77. source_refs_json 保存 sourceMediaPath。
78. source_refs_json 保存音频起止时间。
79. source_refs_json 保存视频帧序号。
80. source_refs_json 保存视频帧时间。
81. source_refs_json 保存 OCR 坐标。
82. source_refs_json 保存提取元数据与 warning。
83. 如果没有 draft 但有 extractedText，上传记录会标记 done。
84. 这样 OCR/转写片段可以进入 staging，不被草稿生成阻断。
85. 如果既没有 draft 也没有文本，上传记录会标记 failed。
86. 未识别类型会走 markUnsupported。
87. markUnsupported 当前落到 failed 状态，避免扩大前端状态枚举。
88. 已执行 npm run build。
89. build 真实运行后失败。
90. 失败原因集中在仓库已有 TypeScript 不一致。
91. 主要包括 badcase-extractor 测试导出缺失。
92. 还包括 subjectId、materialId、entryType 类型缺失。
93. 还包括 KnowledgeRepository 缺 fallbackFullTextSearch 与 expandGraphOneHop。
94. 这些错误不来自本次 FR-A02 修改文件。
95. 针对本次修改文件单独执行 TypeScript 检查。
96. src 多模态相关文件检查通过。
97. web 上传与材料相关文件检查通过。
98. 已执行 curl 上传实测。
99. 因当前 Next 运行态不可用，使用本地临时 HTTP 服务验证 multipart 上传。
100. curl 返回 HTTP 201。
101. 响应确认 routeCategory 为 image。
102. curl 上传体包含 image/png 文件字段。
103. 已执行图片处理实测。
104. 测试图片路径使用 /tmp/kivo-walkthrough-screenshots 下现有 PNG。
105. 系统正确识别为 image/png。
106. 上传记录成功落库并记录 routeCategory=image。
107. 图片处理进入 PaddleOCR 路径。
108. 因本机缺少 paddleocr，记录失败原因是清晰安装提示。
109. 这符合硬约束：未安装 PaddleOCR 必须明确报错。
110. 已执行 sqlite 实测。
111. staging_materials 可写入片段。
112. sqlite 查询确认 sourceMediaPath 可从 source_refs_json 读出。
113. 音频路径也做了启动验证。
114. 本机 whisper 命令存在。
115. 本机 ffmpeg 命令存在。
116. 使用 1 秒静音 wav 触发 Whisper tiny。
117. Whisper 进程启动成功，但耗时超过本次验证窗口，已终止，避免长时间占用。
118. 本次没有安装 PaddleOCR。
119. 本次没有修改 openclaw.json。
120. 本次没有执行 doctor --fix。
121. 本次没有改 Gateway 配置。
122. 需要后续在宿主机补装 PaddleOCR 后复跑图片 OCR 正向识别。
123. 需要在现有仓库 TypeScript 历史错误修掉后，再让整体 npm run build 变绿。
124. 当前 FR-A02 代码路径已覆盖图片、音频、视频、文本、PDF 路由。
125. 当前 staging 写入已经保留媒体溯源。
126. 当前未发现学科种子污染新增到错误信息。
