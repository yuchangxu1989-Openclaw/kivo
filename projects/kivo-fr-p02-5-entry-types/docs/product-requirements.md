# FR-P02 5 类学科条目类型化

Hermes（OpenClaw ACP Agent）/ 2026-05-24

## 范围
本项目落地 FR-P02 主 spec 中「领域知识条目 5 类类型化」的细节实现：concept / method / question / mistake / annotation 类型字段 + 提取 prompt 改造。主 spec 大纲与 AC 见 `kivo/product-requirements.md` 的 FR-P02 章节，本文档只承载本期项目级补充与 follow-up。

## Follow-up（补充 AC）

### AC-FU01 PDF auto-pipeline 直产 wiki_page 类型规范化
PDF 自动化管线（auto-pipeline）当前会直接产出 `entries.type='wiki_page'` 的条目，作为合法的中间态。但这些 wiki_page 部分缺失结构化字段，导致与 5 类学科条目并存时类型边界模糊。

- 验收点 1：PDF auto-pipeline 写入的每一条 `wiki_page` 必须设置正确的 `type='wiki_page'`，禁止使用空字符串、`null` 或其他类型字面量。
- 验收点 2：PDF auto-pipeline 写入的每一条 `wiki_page` 必须有可解析的 `subject_id` 关联（关联到合法 `subject_nodes.id`），不允许 `subject_id IS NULL`。
- 验收点 3：迁移脚本扫描历史库，对存量 `wiki_page` 中 `subject_id IS NULL` 的条目进行回填或软删除，不残留孤儿。
- 验收点 4：5 类学科条目类型化完成后，`type IN ('concept','method','question','mistake','annotation','wiki_page')` 是 entries 表 type 字段的全集白名单；非白名单值视为脏数据。

### 引用证据
2026-05-24 KIVO seed 节点动态化审计发现库内 9 条 `subject_id IS NULL` 的 `wiki_page`，均为 PDF auto-pipeline 产物，合法但未规整 type 与 subject 关联，需在 FR-P02 落地阶段统一收口。
