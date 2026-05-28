# KIVO seed 学科动态化与 Wiki 编译阈值实装报告

Codex（OpenClaw ACP Agent）/ 2026-05-24

## 结论

已完成本轮实装。

KIVO 不再依赖预置学科节点来启动分类流程；分类阶段会根据 LLM 输出的学科名动态创建或复用 subject_nodes；Wiki 编译器会跳过没有原子知识条目的空节点，不再为“暂无相关条目”的空学科生成占位页。

真实数据库已经清理：subject_nodes 从 8 个降到 2 个，只保留有原子知识的「概率论与数理统计」和「高等数学」。Wiki 页面数从 23 降到 17，其中 Wiki 编译器产出的学科页只剩这两个学科。

## 改动清单

- 新增迁移脚本 `scripts/migrate-remove-empty-seed-subjects.ts`，启动时先备份数据库，按 subject_node 逐个统计原子知识条目数量。
- 原子知识条目数为 0 的节点会先删除关联的编译 Wiki 页，再删除节点；有条目的节点保留。
- 备份路径默认使用 `kivo.db.bak.before-seed-cleanup-20260524`；如果文件已存在，会自动追加序号，避免覆盖旧备份。
- 修改 Wiki 编译器，新增 `getEntriesCount(subjectId)`，编译入口先过滤空节点。
- 空节点只记录日志并跳过，不抛异常，不阻断其他节点继续编译。
- Wiki shell 创建只针对有原子知识的节点执行。
- 新增 Wiki 编译器单测，覆盖“空节点 + 有条目节点”的组合。
- 修改分类 worker，分类成功后按 LLM 输出的学科名动态 upsert subject_nodes。
- 当前归并策略是学科名 exact match；同义学科归并保留为后续 LLM 判定能力。
- 分类 worker 不再要求新装环境里预先存在任何具体学科节点。

## 迁移前数据库状态

迁移前 subject_nodes 有 8 个。

迁移前 wiki_page 有 23 个。

迁移前节点与原子知识数量：

- 心理学与脑科学：0
- 数学：0
- 概率论与数理统计：305
- 生物信息学：0
- 生物学：0
- 认知科学：0
- 通用学习资料：0
- 高等数学：18

这里的原子知识统计只计算 `fact`、`methodology`、`decision`、`experience`，不把 `wiki_page` 本身当作有效学科内容。

## 迁移执行结果

迁移脚本在备份库上的完整证明结果：

- 删除空 subject_nodes：6 个
- 删除空节点关联 wiki_page：6 个
- 保留有原子知识节点：2 个
- 清理后 subject_nodes：2 个
- 清理后 wiki_page：17 个

被删除的空节点：心理学与脑科学、数学、生物学、通用学习资料、生物信息学、认知科学。

被保留的节点：概率论与数理统计 305 条原子知识，高等数学 18 条原子知识。

真实 `kivo.db` 已执行迁移，当前再次运行迁移脚本时结果为 0 删除，说明清理已完成且脚本幂等。

当前真实库备份已存在：`kivo.db.bak.before-seed-cleanup-20260524` 与 `kivo.db.bak.before-seed-cleanup-20260524.1`。

## 迁移后数据库状态

迁移后 subject_nodes 只剩 2 个：

- 概率论与数理统计：305 条原子知识
- 高等数学：18 条原子知识

迁移后 wiki_page 数量为 17。

其中 Wiki 编译器产出的学科页只剩 2 个：概率论与数理统计、高等数学。

孤儿检查结果为 0：没有 subject_id 指向已删除 subject_node 的 wiki_page。

仍存在的 9 个 `subject_id` 为空的 wiki_page 是 PDF 导入流水线产出的材料级页面，不是本次要清理的空学科占位页。

## Wiki 编译器验证

迁移后已运行 Wiki 编译器。

执行结果：使用当前 KIVO 数据库，编译范围为全部 subject_nodes，pages created 为 0，links created 为 0，退出码为 0。

这说明迁移后只有有效学科节点参与编译，空学科占位页不会再被新建。

## 测试与构建

已完成以下验证：

- Wiki 编译器单测：1 个文件通过，1 个测试通过
- 分类 worker 测试：1 个文件通过，7 个测试通过
- TypeScript typecheck：通过
- package build：通过

所有构建、测试、迁移、编译命令输出均已重定向到 `/tmp/*.log`。

## AC 覆盖

AC1：移除预置 seed 学科依赖。已覆盖。当前动态分类路径不需要预置学科节点；active grep 未发现 `SEED_SUBJECT_NODES` / `SEED_SUBJECTS` / 历史 seed 域 ID。历史演示 seed 脚本已移入 trash，避免继续留在仓库。

AC2：迁移脚本清理空节点与占位页。已覆盖。脚本完成备份、逐节点统计、删除空节点关联 Wiki 页、删除空节点、输出日志。

AC3：迁移后只保留有 entries 的节点。已覆盖。真实库只剩「概率论与数理统计」和「高等数学」。

AC4：Wiki 编译器跳过空节点。已覆盖。编译入口按原子知识条目数过滤，空节点只打日志并跳过。

AC5：Wiki 编译器单测。已覆盖。单测验证空节点不生成 wiki_page，有条目节点正常编译。

AC6：classification 动态 upsert subject_nodes。已覆盖。worker 按 LLM 学科名 exact match 复用或创建根节点。

AC7：构建通过。已覆盖。typecheck 和 build 均通过。

## 证据日志

关键证据已集中在 `/tmp/kivo-final-validation.log` 与 `/tmp/kivo-seed-evidence-bundle.log`。

分项日志包括 `/tmp/kivo-active-seed-grep.log`、`/tmp/kivo-final-db-verify.log`、`/tmp/kivo-db-before-seed-cleanup.log`、`/tmp/migrate-seed-proof.log`、`/tmp/migrate-seed.log`、`/tmp/kivo-db-after-seed-cleanup.log`、`/tmp/wiki-compile-after-cleanup.log`、`/tmp/kivo-db-verify-after-wiki.log`、`/tmp/kivo-wiki-orphan-check.log`、`/tmp/kivo-wiki-compiler-test.log`、`/tmp/kivo-worker-tests.log`、`/tmp/kivo-typecheck.log`、`/tmp/kivo-build.log`。

## 留存说明

`entries.subject_node_id` 这个列在当前真实库中不存在，实际关联字段是 `entries.subject_id`。本次实现和验证均按真实 schema 使用 `subject_id`，避免按不存在字段写死导致迁移失败。
