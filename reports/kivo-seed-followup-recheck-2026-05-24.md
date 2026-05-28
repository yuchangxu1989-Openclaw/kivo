# KIVO Seed Followup 复审

OpenClaw（audit-01 子Agent）/ 2026-05-24

## 复审结论

7 项审计点全部走完。Hermes 4 项修复全部 OK，**0 阻断、0 新差距**，前一轮 audit「6 / 0 P0 / 2 P1 / 2 P2 / 1 P3」全闭环。
仅 1 处「测试隔离方式」的可选改进意见，不影响验收通过。

| 复审点 | 优先级映射 | 结论 |
|---|---|---|
| 1. 6 条空 shell wiki_page 真删了 | P1-1 | OK，DB 实测 0 残留，wiki_page 17 → 11 |
| 2. seed spec FR-3 follow-up 段写入 | P1-2 | OK，AC3/AC4 deferred 显式标注 |
| 3. unit test 真跑通 | P2 | OK，wiki-compiler 3 + migrate 3 = 6/6 pass |
| 4. FR-P02 spec AC-FU01 写入 | P3 | OK，4 验收点齐备 |
| 5. 备份机制 | — | OK，2 份备份均存在且非空 |
| 6. 报告洁净度 + 署名 | — | OK，144 行、署名规范、无 V2/修订后/AI 套话 |
| 7. 与第一次 audit 对照 | — | 全闭环，无遗漏 |

## 1. 空 shell wiki_page 清理（P1-1）：OK

实库 `kivo.db` 实测：

```
=== 空 shell（content='' 且 metadata={} 或 NULL）=== 0
=== 总 wiki_page === 11
=== 有正文 wiki_page === 11
=== 空内容 wiki_page（任意 metadata）=== 0
```

11 条 wiki_page 全部有正文，最小 61 bytes（高斯课堂 PDF auto-pipeline 产物，metadata 含完整 tags/source/extra，正文是 H2 概要而非空壳，**不属于「空 shell」**），最大 20103 bytes。
原报告「17 → 11」与实测一致。

## 2. seed spec FR-3 Follow-up 段（P1-2）：OK

`projects/kivo-seed-strategy-wiki-threshold-20260524-001/specs/product-requirements.md`：

- 第 54 行 `## Follow-up（本期不实装）` 段落已落盘
- 第 57-58 行明确 `AC3 ... ——deferred` / `AC4 ... ——deferred`
- 引用「2026-05-24 用户拍板：本期管线分类先做骨架，LLM 判定 + 同义归并下阶段做」，原话克制、无夸大
- 全文 69 行，无 V2/修订后/砍掉/新增等过程痕迹
- 文末「本期 AC1、AC2 必须交付；AC3、AC4 在下阶段专项需求中重新拆解」给后续承接人留了清晰指引

## 3. unit test（P2）：OK

`scripts/__tests__/migrate-remove-empty-seed-subjects.test.ts`：

```
✓ creates a backup file before mutating the DB
✓ purges global empty wiki_page shells regardless of subject node retention
✓ is idempotent: running twice yields the same final state
Test Files  1 passed (1)
     Tests  3 passed (3)
Duration  1.38s
```

`src/wiki/compiler/__tests__/wiki-page-compiler-seed-threshold.test.ts`：

```
✓ skips subjects with zero atomic entries and only compiles subjects with entries
✓ uses default threshold (>=1 entry) without any ProjectConfig argument
✓ compiles no pages when all subjects have zero entries (boundary)
Test Files  1 passed (1)
     Tests  3 passed (3)
Duration  874ms
```

合计 6/6 pass，与 hermes 报告一致。

边界覆盖：
- 默认阈值（不传 ProjectConfig）→ 已覆盖
- 全空 subjects → 已覆盖
- 备份创建 / 全局 shell purge / 幂等 → 已覆盖

**测试隔离**：两份测试都用 `mkdtempSync(join(tmpdir(), 'kivo-...-'))` 在 beforeEach 创建独立临时目录，afterEach `rmSync` 清理。dbPath 通过函数参数 / 构造器显式传入，**不走 `process.env.KIVO_DB_PATH`**。这种方式比 env var 更直接（避免并行 vitest 跨用例污染 env），属于有效隔离。
建议（**可选，非阻断**）：未来如需 CLI/集成测试覆盖 env-var 路径，可补一个 `process.env.KIVO_DB_PATH` 走通的用例；本期不在 spec 范围内，不必返工。

## 4. FR-P02 AC-FU01（P3）：OK

`projects/kivo-fr-p02-5-entry-types/docs/product-requirements.md`：

- 文档 19 行，第 8-19 行是新增的 `## Follow-up（补充 AC）` 段
- AC-FU01 4 个验收点齐备：type 字面量化、subject_id 非空、迁移脚本回填或软删、白名单全集
- 引用证据「2026-05-24 KIVO seed 节点动态化审计发现库内 9 条 subject_id IS NULL 的 wiki_page」与实库 `SELECT COUNT(*) ... subject_id IS NULL` = **9** 一致
- 文档无 V2/修订后过程痕迹

**与 spec 边界一致的事实**：实库当前仍有 9 条 `subject_id IS NULL` 的 wiki_page，这是预期的——本轮仅做 spec 层补全，runtime 治理留到 FR-P02 落地阶段，不在本期审计范围内。

## 5. 备份机制：OK

`projects/kivo/kivo.db.bak.*` 中：

```
-rw-r--r-- 20353024  May 24 20:17  kivo.db.bak.20260524-201500
-rw-r--r-- 20353024  May 24 20:17  kivo.db.bak.before-followup-20260524-201500
```

两份备份都是 20MB（与 `kivo.db` 等大），文件存在且非空。
hermes 在执行修复前 `cp` 一份「修复前快照」，迁移脚本内部又 `copyFileSync` 一份「脚本执行前快照」，双层备份冗余度合理。

## 6. 报告洁净度 + 署名：OK

- 行数：144 ✓（要求 144）
- 署名：`Hermes（OpenClaw ACP Agent）/ 2026-05-24` ✓ 规范
- 全文 grep 「V2 / 修订后 / 砍掉 / 不是...而是 / 让我们 / 值得注意的是 / 换句话说」零命中（仅第 80 行作为「自我约束」提及「不写...过程痕迹」，属合理引用）
- 结构清晰：结论表 → 4 项修复 → 文件清单 → 备份 → 验收对照
- 实库 sqlite3 输出、vitest 输出原样贴出，可追溯

## 7. 与第一次 audit 对照：全闭环

我前一轮给的差距清单逐条对照：

| 项 | 前一轮判定 | 本轮状态 |
|---|---|---|
| P1-1 迁移脚本只清待删节点下的 wiki_page，全局空壳未清 | 待修 | DB 0 残留，已修复 |
| P1-2 spec 没有 deferred 段 | 待修 | Follow-up 段 + AC3/AC4 deferred 已写 |
| P2-1 wiki-compiler 默认阈值 / 全空 subjects 边界缺测 | 待修 | 2 个边界 case 已补 |
| P2-2 migrate 脚本无单测 | 待修 | 3 个单测覆盖备份 / shell purge / 幂等 |
| P3 FR-P02 spec 没显式说 PDF auto-pipeline wiki_page 怎么治 | 待修 | AC-FU01 4 验收点已写 |

**无新发现的遗漏**。

## 综合结论

✅ **通过**。Hermes 修复完整、可追溯、无新差距，建议结清本轮 followup。

可选后续（不阻断本轮）：
- 测试 env-var 路径（`KIVO_DB_PATH`）覆盖留给 FR-P02 集成测试期补
- FR-P02 落地阶段执行 AC-FU01 验收点 3：迁移脚本扫描 9 条 NULL subject_id 历史 wiki_page 做回填或软删
