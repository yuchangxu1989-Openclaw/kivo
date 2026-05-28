# KIVO 系统词典自动闭环 — 实现规格

OpenClaw（pm-01 子Agent）| 2026-05-19

---

## 问题陈述

KIVO 系统词典（domain='system-dictionary'）当前有 4 条产品名词条目已写入 DB，但存在两个断裂：

1. **注入断裂**：4 条词典条目的 embedding 字段全部为空（length=0），而 hook 的向量检索要求 `length(embedding) = 4096`（BGE-M3 float32），导致词典条目对注入系统完全不可见。
2. **沉淀断裂**：对话中出现新术语/专有名词时，没有自动识别和写入 system-dictionary 的路径。当前只有手动 `kivo dict seed` 和手动 SQL。

目标：建立「自动沉淀 → 自动注入」的完整闭环，无需人工干预。

---

## 现状分析

### 注入侧（kivo-intent-injection hook）

- `handleBootstrap`：调用 `hookApi.getBootstrapEntries()`，按 type IN ('intent','decision','methodology','experience') 过滤，**不包含 type='fact' 的词典条目**。
- `handleMessageReceived`：调用 `hookApi.searchRelevantKnowledge()`，对所有 active 且有 embedding 的条目做向量搜索。词典条目因无 embedding 被跳过。
- FR-H02 spec 要求：术语注入优先级高于一般知识注入；支持精确匹配模式（术语名/别名完全匹配时直接返回）。当前均未实现。

### 沉淀侧（知识提取）

- **Cron 批量提取**（`kivo-session-extract-cron.sh` → `extract-sessions` CLI）：每 2 小时运行，通过 Python 预处理 + LLM 提取知识。提取 prompt 不包含术语识别指令，domain 由 LLM 自由判断，不会主动写 'system-dictionary'。
- **实时提取**（`extract-queue-worker.mjs`）：hook 收到消息后排队，积累 ≥3 条后 spawn worker。worker 的 LLM prompt 也不包含术语识别指令。
- 两条路径都缺少「识别专有名词/术语定义 → 写入 system-dictionary domain」的专项逻辑。

### DB 现状

```
entries 表中 domain='system-dictionary' 的 4 条记录：
- term-kivo-cn: KIVO 意图增强知识库（embedding=NULL）
- term-sevo-cn: SEVO 自动研发流水线（embedding=NULL）
- term-aco-cn: ACO 可控调度中枢（embedding=NULL）
- term-aeo-cn: AEO 效果运营平台（embedding=NULL）
```

---

## 功能需求

### FR-1：词典条目 Embedding 补全

**目标**：确保所有 system-dictionary 条目拥有有效的 BGE-M3 embedding，使其对向量检索可见。

- AC1：提供 CLI 命令或脚本，对 `domain='system-dictionary'` 且 embedding 为空的条目批量生成 embedding（调用 Ollama bge-m3）。
- AC2：新写入的词典条目在写入时自动生成 embedding（复用现有 backfill 逻辑或在写入路径中内联调用）。
- AC3：执行后验证：4 条现有条目的 `length(embedding)` 均为 4096。

### FR-2：注入 Hook 增加词典优先注入

**目标**：在 bootstrap 和 message 阶段，词典条目以高优先级注入 agent 上下文。

- AC1：`handleBootstrap` 阶段，除现有的高价值知识注入外，额外查询 `domain='system-dictionary'` 且 `status='active'` 的条目，全量注入（词典条目数量有限，不需要语义筛选）。词典注入在一般知识注入之前，占用独立 token 预算（默认 500 token）。
- AC2：`handleMessageReceived` 阶段，在向量搜索结果中，对 `domain='system-dictionary'` 的命中条目提升排序权重（乘以 1.5 boost factor），确保词典条目优先展示。
- AC3：增加精确匹配路径：从用户消息中提取可能的术语名（基于 DB 中已有词典条目的 title 和 content 中的术语名/别名），精确匹配命中时直接注入，不依赖向量相似度阈值。
- AC4：注入格式区分词典条目，使用 `### [术语]「词典」<title>` 标签，与一般知识的 `[type]「语义匹配」` 区分。
- AC5：已有的 4 条产品名词典条目（KIVO/SEVO/ACO/AEO）能被注入 hook 检索到并注入 agent session（端到端验证）。

### FR-3：对话中术语自动沉淀

**目标**：对话中出现新术语/专有名词定义时，系统自动识别并写入 system-dictionary domain。

- AC1：在 `extract-queue-worker.mjs` 的 LLM 提取 prompt 中，增加术语识别指令：当对话中出现「X 是/叫/指/代表/全称是/缩写是...」等定义模式时，提取为 `domain: "system-dictionary"` 条目。
- AC2：在 `session-knowledge-llm.ts` 的 cron 批量提取 prompt 中，同样增加术语识别指令，确保两条提取路径都能沉淀术语。
- AC3：术语条目写入时，type 设为 'fact'，domain 设为 'system-dictionary'，confidence ≥ 0.7。
- AC4：写入前执行去重检查：title 或 content 中的术语名与已有词典条目的 title 做相似度比对（cosine ≥ 0.85 视为重复），重复时跳过写入。
- AC5：自动沉淀的术语条目在写入时自动生成 embedding（同 FR-1 AC2）。

---

## 非功能需求

- NFR-1：词典注入的额外延迟 ≤ 50ms（精确匹配为 SQLite 查询，不涉及 embedding 计算）。
- NFR-2：词典条目数量预期 < 200 条，bootstrap 全量注入的 token 开销可控。
- NFR-3：自动沉淀的误识别率可接受（LLM 判断 confidence ≥ 0.7 才写入），后续可通过 Web 工作台人工审核。

---

## 实现边界

### 需要改动的文件

1. **`workspace/hooks/kivo-intent-injection/handler.js`**
   - `handleBootstrap`：增加词典全量注入逻辑
   - `handleMessageReceived`：增加精确匹配 + boost 逻辑
   - `formatLabeledInjectionContext`：增加词典标签格式

2. **`workspace/hooks/kivo-intent-injection/scripts/extract-queue-worker.mjs`**
   - `EXTRACTION_SYSTEM_PROMPT`：增加术语识别指令
   - 写入逻辑：术语条目自动生成 embedding

3. **`projects/kivo/src/cli/session-knowledge-llm.ts`**
   - `buildSessionExtractionPrompt`：增加术语识别指令（或在 Stage 2 聚合时识别）

4. **Embedding 补全脚本**（新建或复用 `backfill-embeddings.mjs`）
   - 对 system-dictionary 条目补全 embedding

### 不改动的部分

- `hook-api/index.ts`（searchRelevantKnowledge 和 getBootstrapEntries 的核心逻辑不变，词典注入在 hook 层实现）
- DB schema（不需要新增表或字段）
- 产品需求规格（FR-H01~H05 已覆盖，本 spec 是实现层面的补全）

---

## 验收标准（端到端）

1. 运行 embedding 补全后，`SELECT COUNT(*) FROM entries WHERE domain='system-dictionary' AND length(embedding)=4096` 返回 ≥ 4。
2. 启动一个新 agent session，bootstrap 注入的 KIVO_CONTEXT.md 中包含词典条目（至少包含 KIVO/SEVO/ACO/AEO 的定义）。
3. 在对话中发送包含 "KIVO" 的消息，message 阶段注入的上下文中包含 KIVO 词典条目。
4. 在对话中发送 "焰崽是我对 AI 助手的称呼"，等待提取 worker 运行后，DB 中出现新的 `domain='system-dictionary'` 条目。
5. 新沉淀的条目 `length(embedding) = 4096`，后续对话中可被检索到。

---

## 依赖与风险

- **Ollama bge-m3 可用性**：embedding 生成依赖本机 Ollama 服务运行 bge-m3 模型。若 Ollama 不可用，embedding 补全和自动沉淀的 embedding 生成会失败（graceful degradation：条目仍写入，embedding 留空待后续补全）。
- **LLM 术语识别准确率**：自动沉淀依赖 LLM 判断，可能存在误识别。通过 confidence 阈值（≥ 0.7）和去重检查控制质量。
- **Token 预算**：bootstrap 阶段词典全量注入占用额外 ~500 token，需确保不超出总预算（当前 BOOTSTRAP_TOKEN_BUDGET=3000）。

---

## 与现有 Spec 的映射

| 本 spec FR | 产品需求 FR | 说明 |
|---|---|---|
| FR-1 | FR-H01 AC2 | 术语以 KnowledgeEntry 存储，需有 embedding |
| FR-2 | FR-H02 AC1~AC3 | 术语注入格式、语义筛选、优先级 |
| FR-3 | FR-H05 AC2 | "从治理文件中解析术语定义"的泛化——从对话中自动提取 |
