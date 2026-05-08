# ADR-010：系统词典作为 KnowledgeEntry 的特化视图

状态：已采纳

日期：2026-04-21

## 背景

KIVO 需要系统词典能力（域 H），管理术语定义、Prompt 注入、冲突检测和生命周期。设计时面临一个根本选择：词典模块是引入独立的数据模型和存储，还是复用已有的 KnowledgeEntry 基础设施。

已有基础设施：KnowledgeEntry 已具备类型分类（type）、域隔离（domain）、版本管理（version + supersedes）、状态机（active/superseded/deprecated/archived）、语义检索（SemanticIndex）、冲突检测（ConflictDetector 两阶段判定）、上下文注入（ContextInjector + InjectionPolicy）。

术语条目的核心需求：结构化字段（term/definition/constraints/aliases/examples/scope）、唯一性校验、别名管理、术语专用冲突规则、Prompt 注入优先级、批量导入导出。

## 决策

术语条目（Term Entry）是 KnowledgeEntry 的一种特化视图，通过 `type=fact` + `domain=system-dictionary` + metadata 扩展字段实现。词典模块最大化复用已有基础设施，仅在必要处增加术语专用逻辑。

具体映射：

- `KnowledgeEntry.type` = `"fact"`（术语本质上是事实性知识）
- `KnowledgeEntry.domain` = `"system-dictionary"`（域隔离标识）
- `KnowledgeEntry.title` = 术语名（term）
- `KnowledgeEntry.content` = 术语定义（definition）
- `KnowledgeEntry.tags` = `["term", ...scope]`
- `KnowledgeEntry.metadata` 扩展 TermMetadata 接口，承载 aliases、constraints、examples、scope 等结构化字段

不引入独立的 glossary 表或存储结构。Web 层已有的 GlossaryEntry 实体（§5.3.3）废弃，统一使用 KnowledgeEntry + TermMetadata。

## 替代方案对比

| 方案 | 优势 | 劣势 | 否决理由 |
|------|------|------|----------|
| 独立 GlossaryEntry 模型 + glossary 表 | 数据模型独立，字段定义清晰，不受 KnowledgeEntry 约束 | 重复实现版本管理、状态机、冲突检测、检索能力；存储层需要新增 SPI 方法；Web 层和引擎层维护两套数据模型 | 违反 DRY 原则，增量开发量大，与 spec 明确要求的"复用已有基础设施"矛盾 |
| 新增 KnowledgeType = 'term' | 类型语义更精确，可针对 term 类型定制提取和冲突策略 | 需要修改 ADR-006 的六类固定类型体系，影响已有提取器和冲突检测器的类型分支逻辑 | 术语是 fact 的子集（事实性知识），不构成独立知识类型；通过 domain 区分已足够，不值得扩展类型体系 |

## 后果

正面：
- 术语条目自动获得版本管理、状态机、语义检索、审计日志等已有能力，零额外实现。
- 词典模块的增量代码集中在 `src/dictionary/` 目录，约 5 个文件，职责清晰。
- Web 层 Glossary API 从操作独立表改为调用 DictionaryService，消除数据模型分裂。

负面：
- TermMetadata 扩展字段存放在 KnowledgeMetadata 的可选字段中，类型安全依赖运行时检查（domain=system-dictionary 时才读取 TermMetadata 字段）。
- 术语的唯一性校验（同 scope 内 term 不重复）需要在 DictionaryService 层实现，EntryRepository 不感知这一约束。
- 未来如果术语需求大幅偏离 KnowledgeEntry 的能力范围，可能需要重新评估是否独立。当前 spec 的 5 个 FR 均在复用范围内，风险可控。

## 合规性

- 符合 ADR-006（固定六类知识类型）：术语使用 type=fact，不扩展类型体系。
- 符合 ADR-002（Repository SPI）：术语通过 EntryRepository 存储，不引入新的 SPI 方法。
- 符合 ADR-003（冲突检测前置拦截）：术语注册和修改均经过 TermConflictChecker → ConflictDetector 管线。
- 符合架构约束 §2.1：不引入新外部依赖，纯 TypeScript 实现。
