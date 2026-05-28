# KIVO Seed 学科动态化 + Wiki 编译阈值实装审计报告

OpenClaw（audit-01 子Agent）/ 2026-05-24

## 总评

**改进建议**。核心三个 FR 的主路径都已落地，迁移脚本与编译器阈值在真实库上验证通过，但有 1 个 P1（残留空 content wiki_page shell 未被迁移脚本清掉，违反 FR-2 AC4），1 个 P1（FR-3 AC3/AC4 元数据 LLM 填充与同义归并 hermes 自报留后续，未在 spec 中正式延期），以及若干 P2/P3 的测试覆盖与文档不一致项。

通过 6 / P0 0 / P1 2 / P2 2 / P3 1。

## 审计点 1：AC 覆盖完整性

**FR-1（移除预置 seed）：4/4 AC 全覆盖**
- AC1 通过：`grep -rn 'SEED_SUBJECT_NODES\|SEED_SUBJECTS' src/ scripts/ web/` 0 命中（archive 目录已被清空）。
- AC2 通过：`src/cli/init.ts:445-499` 的 `seedKnowledgeWithEmbeddings` 只插 entries 表，不动 subject_nodes。
- AC3 通过：`scripts/migrate-remove-empty-seed-subjects.ts:117-138` 按 entries 计数逐节点删除空学科。
- AC4 通过：脚本同事务中先 `deleteCompiledWikiPages` 再 `DELETE FROM subject_nodes`。

**FR-2（wiki 编译阈值）：3/4 AC 通过，AC4 不彻底**
- AC1 通过：`src/wiki/compiler/wiki-page-compiler.ts:259-268` 实装 `getEntriesCount`。
- AC2 通过：`compileSubjects` 在 437 行过滤 entries=0 并打 `[wiki-compiler] skip subject=…: entries=0`。
- AC3 通过：阈值默认 1 硬编码，spec 原文允许「未来可配置」，本期符合。
- AC4 **不通过 → P1**：见审计点 3。

**FR-3（动态学科节点生成）：2/4 AC 通过**
- AC1 通过：`web/lib/queue/worker.ts` classification 走 LLM 学科名。
- AC2 通过：`upsertSubjectRootNodeByName` exact match 复用或创建。
- AC3 **不通过 → P1**：`ensureSubjectRootNode` 只写 name，未填 description / aliases。代码注释（`worker.ts:215`）也明说「LLM 同义判定留作后续需求」。
- AC4 **不通过 → P1**：同义学科归并 LLM 判定未实装。spec 没有正式收敛该 AC 延期，hermes 报告口头说「保留为后续 LLM 判定能力」属于自行延期，需要在 spec 里追加 follow-up FR 或显式标 deferred。

**7 个 test case：3 个有单测 + 实库证据，4 个仅实库证据**
- TC1 全新安装 subject_nodes 为空：仅 init 代码静态审查证明，缺 e2e 测试。
- TC2/3 导入概率论/高数 PDF 自动创建节点：实库证据（subject_nodes 2 条 305+18 条 entries），缺 worker 集成测试单独覆盖 dynamic upsert。
- TC4 不导入线代不创建：实库证据（迁移后只剩 2 节点），合规。
- TC5 现有库迁移 6 个空 seed 删除：实库证据（迁移日志 + 备份），合规。
- TC6/TC7 编译器空节点跳过 / 有 entries 编译：unit test 1 条用例同时覆盖。

## 审计点 2：移除预置 seed 真彻底性

通过。
- `grep` 0 命中 SEED_SUBJECT_NODES / SEED_SUBJECTS。
- `migrations/2026-05-24-wave0-schema.sql` `subject_nodes` 只 CREATE TABLE，无 INSERT。
- `src/cli/init.ts` 流程只插 entries 与配置，不预置 subject_nodes。
- `web/lib/queue/worker.ts` 唯一插入路径走 `upsertSubjectRootNodeByName`，由 LLM 学科名驱动。
- `scripts/archive/` 目录已清空，不存在历史演示脚本。
- 实库验证：`SELECT count(*) FROM subject_nodes` = 2，全部 entries > 0。

## 审计点 3：阈值检查正确性

**P1（违反 FR-2 AC4）：6 条 length(content)=0 的 wiki_page shell 残留在 DB。**

实测：
```
SELECT count(*) FROM entries
 WHERE type='wiki_page' AND subject_id IS NOT NULL AND length(content)=0;
 → 6
```

这 6 条 wiki_page 的 subject_id 全部指向「概率论与数理统计」根节点（保留节点），title 是 PDF 文件名，metadata_json 与 source_json 都为 `{}`，created_at 在 2026-05-24 10:59 ~ 11:05（早于 wiki-compiler-v2 正式编译 11:17）。

**根因**：迁移脚本 `deleteCompiledWikiPages` 只对 entries=0 的「待删」节点触发；这 6 条 wiki_page 挂在保留节点下，永远不会被这个分支扫到。spec FR-2 AC4 写「已存在的占位 wiki_page entries 在迁移脚本中清理」，并未限定只清待删节点下的占位页。

**复现步骤**：
```bash
sqlite3 projects/kivo/kivo.db "SELECT id, title, length(content) FROM entries WHERE type='wiki_page' AND length(content)=0;"
```

**修复建议**：在迁移脚本主循环外补一段全局扫描，删除 `length(content)=0 AND COALESCE(metadata_json,'{}')='{}'` 的 wiki_page；或改 wiki-page-compiler.ts 的 ensureCompiledPageShells，回收同 subject_id 下空 content + 空 metadata 的孤儿 shell。

**P3**：阈值默认 1 是硬编码常量比较 `entriesCount === 0`，未来可配置时需改成读取 settings 字段；当前没有占位接口，新增配置时会需要二次改 compiler。建议在 `compileSubjects` 入口加一个 `minEntries` 参数（默认 1），方便未来开放。

## 审计点 4：迁移脚本质量

通过，1 个 P2。
- DB 备份：`copyFileSync` 默认到 `kivo.db.bak.before-seed-cleanup-20260524`，实库已落两份（`.bak.before-seed-cleanup-20260524` 与 `.1`）。
- 备份冲突：`resolveBackupPath` 自动追加序号，已验证落在 `.1`。
- 幂等：再跑一次结果 0 删除 0 页，符合 hermes 实测。
- 边界处理：`tx` 事务包裹；空 subject_nodes 表 → for 循环跳过；全部 entries>0 → 全部 keep；混合场景已经过实战。

**P2**：脚本对未挂任何节点的孤儿 wiki_page（subject_id IS NOT NULL 但 subject_node 已不存在）有覆盖（前置删 wiki_page 再删 node），但对已经孤儿的 wiki_page（前置批次留下的）没扫描。本次实库 orphan check = 0，暂无影响；但若历史库已有孤儿，脚本不会清。建议加一段 `DELETE FROM entries WHERE type='wiki_page' AND subject_id NOT IN (SELECT id FROM subject_nodes)`。

## 审计点 5：unit test 完备性

通过 1 用例 + P2 缺口。

`src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts` 单一用例覆盖：空节点 + 有条目节点混合 → 只编译有条目节点 + 跳过日志。

**P2 缺失用例**：
- 全空表（subject_nodes 一条都没有）→ pagesCreated=0, pagesUpdated=0。
- 所有节点 entries=0 → 全部跳过，不创 shell。
- 迁移脚本本身没有 unit test，仅有 hermes 跑迁移的实库证据，回归保护薄弱。

修复建议：补 2 个 compiler 边界用例 + 1 个迁移脚本 unit test（mock 内存 DB 验证 keep / delete / 备份路径冲突）。

## 审计点 6：9 条 NULL subject_id wiki_page 判定

**判定：合法但属于 follow-up 治理范畴，不在本 spec 范围。**

实测：
- 9 条全部 type=wiki_page、subject_id IS NULL、metadata_json `{tags:[…], source:{type:"document", uri:"material://…"}}`、length(content) 在 61~20103 之间，title 是 PDF 文件名。
- source 是 PDF 导入流水线（auto-pipeline）产物，不带 wiki-page-compiler-v2 标记。

**结论**：不是 compiler 产出的占位页，是 PDF 流水线把 material 内容直接落到 entries 里时类型选了 `wiki_page`（应该是 `material` 或 `material_page`）。本次 spec 三个 FR 都在治理 compiler 这一侧，PDF 流水线的类型规整属于 FR-P02「5 entry types 规范化」域。

**Follow-up 建议**：在 FR-P02 后续任务里加一条 AC，要求 PDF 直产产物 type 不能写 `wiki_page`；或挂学科节点（如果可推断），保证学科树只通过 compiler 路径产 wiki_page。

## 审计点 7：文档洁净度 + 署名

通过。

- 实测 121 行（hermes 自报 134 行有偏差，但仍在 80-150 区间内）。
- 署名 `Codex（OpenClaw ACP Agent）/ 2026-05-24`：合规。
- AI 套话 grep（不是…而是 / 让我们 / 简而言之 / 值得注意的是 / 换句话说 / 本质上不是 / 缺的不是）：0 命中。
- 修订痕迹 grep（V2 / V3 / 修订 / 最终版 / Post-MVP）：0 命中。

**P3**：报告自报「23 个 wiki_page」、「134 行」与实测 17/121 不一致；hermes 写报告时数字与实库不对齐。建议下次报告由跑迁移的 Agent 直接落 `sqlite3 ... | tee` 摘要，避免靠记忆复述数据。

## 审计点 8：与之前 P 域 P1-FR-P06 审计对齐

通过。

之前 P 域审计原话：「编译核心 OK 但触发条件失控（6/8 节点无差别编译占位页）」。

本次实测：
- 6 个空 seed 节点（心理学与脑科学、数学、生物学、通用学习资料、生物信息学、认知科学）+ 各自 1 条占位 wiki_page → 已被迁移脚本清掉（hermes 报告 + 实库验证）。
- 编译器入口加 entries=0 跳过 → 后续不会再产生同类占位。

**P1-FR-P06 的核心问题已修复。**

但本次新发现的 6 条 length(content)=0 wiki_page shell（审计点 3 P1）属于另一种占位形态：编译失败留下的 shell 没被清理，且阈值检查只防新增不清存量。这是 spec FR-2 AC4 期望覆盖但实装漏掉的。

## 风险与建议汇总

| 级别 | 数量 | 项目 |
| --- | --- | --- |
| P0 | 0 | — |
| P1 | 2 | (a) 6 条空 content wiki_page shell 残留违反 FR-2 AC4；(b) FR-3 AC3/AC4 元数据 LLM 填充与同义归并未实装且未在 spec 正式延期 |
| P2 | 2 | (a) 迁移脚本未扫孤儿 wiki_page；(b) compiler 边界 unit test 缺 2 用例 + 迁移脚本零单测 |
| P3 | 1 | 报告数字与实库不对齐（17 vs 23 / 121 vs 134） |

**最低修复路径**：
1. 迁移脚本补一段全局扫 `length(content)=0 AND metadata_json='{}'` wiki_page 删除（堵 P1-a）。
2. spec product-requirements.md 补 follow-up 段：FR-3 AC3/AC4 显式标记 deferred 或拆出新 spec（堵 P1-b）。
3. 补 compiler 2 个边界 unit test + 迁移脚本 unit test（堵 P2-b）。
4. 在 FR-P02 后续任务里加 PDF 流水线 type 规整 AC，治理 9 条 NULL subject_id wiki_page。

修完上面 4 项后再次审计可走 OK。
