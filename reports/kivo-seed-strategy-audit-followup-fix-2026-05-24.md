# KIVO Seed 节点动态化 + Wiki 阈值审计后续修复

Hermes（OpenClaw ACP Agent）/ 2026-05-24

## 修复结论

audit-01 复审给出 6 通过 / 0 P0 / 2 P1 / 2 P2 / 1 P3 后，本轮接力把 4 项「改进建议级」差距全部补完。所有修复已落盘，DB 实库实测，单测 6/6 通过。

| 项 | 优先级 | 范围 | 状态 |
|---|---|---|---|
| 1 | P1 | 迁移脚本补全局空 wiki_page shell 清理 | done，实库 6 → 0 |
| 2 | P1 | spec 显式标 FR-3 AC3/AC4 deferred | done |
| 3 | P2 | 补 wiki-compiler + 迁移脚本 unit test | done，6/6 pass |
| 4 | P3 | FR-P02 spec 加 PDF auto-pipeline 类型 AC | done |

## 修复 1（P1）：迁移脚本补全局空 wiki_page shell 清理

**根因**：审计前的脚本只清「待删 subject_node 下的 wiki_page」，对「保留节点（如概率论与数理统计）下挂载的空 shell」与「孤儿 subject_id 的空 shell」无能为力。spec FR-2 AC4 写「已存在的占位 wiki_page 在迁移脚本中清理」未限定挂载范围，必须按全局清理处理。

**实库证据**：

```
-- before
sqlite3 kivo.db "SELECT id, subject_id FROM entries
 WHERE type='wiki_page' AND length(content)=0
   AND (metadata_json='{}' OR metadata_json IS NULL);"
ef098186-... | 651ccdf7-... (概率论)
1c2a4154-... | 651ccdf7-...
ef74142c-... | 651ccdf7-...
71edc906-... | 651ccdf7-...
3977fc50-... | 651ccdf7-...
f56d7088-... | 651ccdf7-...
-- 6 rows
```

**改动**：`scripts/migrate-remove-empty-seed-subjects.ts`

- 新增 `purgeGlobalEmptyShellPages(db)`：扫描全表 `entries.type='wiki_page' AND length(content)=0 AND (metadata_json='{}' OR metadata_json IS NULL)`，连同 `wiki_links` / `wiki_page_versions` 一并删除。
- 把原 `main()` 拆为可复用的 `runSeedCleanup(dbPath, backupPath)` 导出，在 subject_node 循环结束后追加全局空壳清理；CLI 入口保留为 `main()`，仅在 `process.argv[1]` 指向本文件时触发。
- 日志新增 `purged global empty wiki_page shells: N` 一行，便于审计。

**实库执行**：

```
$ cp kivo.db kivo.db.bak.20260524-201500
$ npx tsx scripts/migrate-remove-empty-seed-subjects.ts \
    --db kivo.db --backup kivo.db.bak.before-followup-20260524-201500
[seed-cleanup] keep: 概率论与数理统计 entries=305
[seed-cleanup] keep: 高等数学 entries=18
[seed-cleanup] deleted subject_nodes: 0
[seed-cleanup] deleted wiki_page entries (per-subject): 0
[seed-cleanup] purged global empty wiki_page shells: 6
$ sqlite3 kivo.db "SELECT COUNT(*) FROM entries WHERE type='wiki_page'
   AND length(content)=0 AND (metadata_json='{}' OR metadata_json IS NULL);"
0
```

`wiki_page` 总数 17 → 11，剩下 11 条全部有正文（最小 61 bytes，最大 20103 bytes）。

## 修复 2（P1）：spec 标记 FR-3 AC3/AC4 deferred

**根因**：worker.ts 注释和口头沟通都明确「LLM 同义判定 + 学科描述/别名补充留作后续」，但 spec 没有显式 deferred 段，下一阶段拿到 spec 的人无法分辨「未实现 = 漏做」还是「未实现 = 故意延后」。

**改动**：`projects/kivo-seed-strategy-wiki-threshold-20260524-001/specs/product-requirements.md`

在 FR-3 末尾追加 `## Follow-up（本期不实装）` 段：

```diff
+ ## Follow-up（本期不实装）
+ 本期管线分类只实装骨架：学科判定 + subject_nodes upsert。
+ LLM 语义补充与同义归并留到下阶段。
+ 据「2026-05-24 用户拍板：本期管线分类先做骨架，LLM 判定 + 同义归并下阶段做」。
+
+ - AC3 节点元数据由 LLM 推断填充（描述 / 别名）——deferred
+ - AC4 同义学科归并由 LLM 判定（例如「概率统计」「概率论」归一）——deferred
+
+ 本期 AC1、AC2 必须交付；AC3、AC4 在下阶段专项需求中重新拆解。
```

不写「修订后」「V2」「砍掉」等过程痕迹；段落自然嵌入 FR-3 之后。

## 修复 3（P2）：补 unit test

**改动 A**：`src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts` 新增 2 个测试

- `uses default threshold (>=1 entry) without any ProjectConfig argument`：构造 `WikiPageCompiler` 不传 `ProjectConfig`，验证默认阈值 1 直接生效（empty-subject 跳过、active-subject 编译）。
- `compiles no pages when all subjects have zero entries (boundary)`：所有 subject 都 entries=0，断言 `result.items===[]` 且 DB 中 `wiki_page` 表零行。

**改动 B**：新建 `scripts/__tests__/migrate-remove-empty-seed-subjects.test.ts`

- 备份机制单测：调用前 backupPath 不存在，调用后存在且 size>0。
- 全局空壳清理：在保留节点下塞 2 条空壳 + 1 条孤儿空壳，断言 `globalShellPages===3` 且最终库内零空壳。
- 幂等性：跑两次 `runSeedCleanup`，第二次 `deletedSubjects===0 && globalShellPages===0`，subject/wiki 快照与第一次后完全一致。

**测试结果**：

```
$ npx vitest run src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts \
                scripts/__tests__/migrate-remove-empty-seed-subjects.test.ts
✓ src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts (3 tests)
✓ scripts/__tests__/migrate-remove-empty-seed-subjects.test.ts (3 tests)
Test Files  2 passed (2)
     Tests  6 passed (6)
```

## 修复 4（P3）：FR-P02 spec 补 PDF auto-pipeline 类型 AC

**根因**：实库残留 9 条 `subject_id IS NULL` 的 `wiki_page` 全部来自 PDF auto-pipeline，是合法的中间态产物，但 type 与 subject_id 关联在 5 类条目类型化阶段未规整。

**改动**：`projects/kivo-fr-p02-5-entry-types/docs/product-requirements.md`

写入 Follow-up 段，新增 AC-FU01「PDF auto-pipeline 直产 wiki_page 类型规范化」，明确 4 个验收点：

- type 字段必须为 `'wiki_page'` 字面量，禁止 null/空。
- subject_id 必须关联到合法 `subject_nodes.id`，禁止 NULL。
- 迁移脚本扫描存量 NULL subject_id 的 wiki_page，回填或软删除。
- 5 类完成后 `entries.type` 全集白名单 = `concept/method/question/mistake/annotation/wiki_page`。

只是补 follow-up AC，不动 FR-P02 主 spec 的大纲与已有 AC1-AC4。

## 改动文件清单

```
projects/kivo/scripts/migrate-remove-empty-seed-subjects.ts                                                +95 -38
projects/kivo/scripts/__tests__/migrate-remove-empty-seed-subjects.test.ts                                 +178 (new)
projects/kivo/src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts                        +52
projects/kivo/projects/kivo-seed-strategy-wiki-threshold-20260524-001/specs/product-requirements.md        +9
projects/kivo/projects/kivo-fr-p02-5-entry-types/docs/product-requirements.md                              +24 -1
```

## 备份

- 修复前实库快照：`kivo.db.bak.20260524-201500`（20MB，cp 同步）
- 迁移脚本 backup-before-run：`kivo.db.bak.before-followup-20260524-201500`

## 验收对照

| 验收点 | 证据 |
|---|---|
| 6 条空 shell wiki_page 删干净 | sqlite3 验证 6 → 0；wiki_page 总数 17 → 11 |
| spec follow-up 段写入 | seed 项目 product-requirements.md FR-3 后已有 Follow-up 段 |
| 新增 unit test 跑通 | vitest 6/6 pass |
| FR-P02 spec 加 follow-up AC | kivo-fr-p02-5-entry-types/docs/product-requirements.md 已写入 AC-FU01 |
| 报告 80-150 行 | 本文件 ~140 行 |
