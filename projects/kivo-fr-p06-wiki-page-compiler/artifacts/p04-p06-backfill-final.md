# KIVO P04 + P06 backfill 执行报告
Codex（OpenClaw ACP Agent） / 2026-05-24

## 结论
本轮已真实执行 `scripts/backfill-p04-p06-extract.ts`，数据库已写入新增知识条目，并触发 wiki 页面重新编译。
全量脚本按要求用 `--skip-pdf-reparse` 启动。
第一份大材料耗时 574 秒，超过“单 material >5min 改单条跑”的约束，所以终止全量长跑，改为单 material 接力。
最终本轮新增 `subject-concept-extractor-v1` 条目 363 条。
`wiki_page_versions` 从 4 增加到 8。
`wiki_page` 仍为 13，因为当前编译器更新已有 subject wiki 页面，不重复创建同一 subject 页面。
`wiki_links` 仍为 0，本轮 `compileAll` 返回 `linksCreated=0`，sqlite 也验证为 0。

## 执行命令
```text
npx tsx scripts/backfill-p04-p06-extract.ts --skip-pdf-reparse > /tmp/p04-p06-backfill.log 2>&1
npx tsx scripts/backfill-p04-p06-extract.ts --skip-pdf-reparse --material affc6f15-d1a3-4c8d-925c-6868aaa3406a > /tmp/p04-p06-backfill-single.log 2>&1
npx tsx scripts/backfill-p04-p06-extract.ts --skip-pdf-reparse --material 25d5ce72-0116-486b-80db-d7bc0c046b41 > /tmp/p04-p06-backfill-single-25d5.log 2>&1
```

## DB before
```text
entries_total: 1183
entries_concept_type: 501
entries_method_type: 104
entries_question_type: 263
entries_mistake_type: 10
entries_annotation_type: 2
wiki_pages: 13
wiki_links: 0
wiki_page_versions: 4
```

## DB after
```text
entries_total: 1546
entries_concept_type: 789
entries_method_type: 104
entries_question_type: 338
entries_mistake_type: 10
entries_annotation_type: 2
wiki_pages: 13
wiki_links: 0
wiki_page_versions: 8
subject_extractor_entries: 878
```

## DB diff
```text
entries_total: 1183 → 1546 (+363)
entries_concept_type: 501 → 789 (+288)
entries_method_type: 104 → 104 (+0)
entries_question_type: 263 → 338 (+75)
entries_mistake_type: 10 → 10 (+0)
entries_annotation_type: 2 → 2 (+0)
wiki_pages: 13 → 13 (+0)
wiki_links: 0 → 0 (+0)
wiki_page_versions: 4 → 8 (+4)
```

## 跑过的 material
1. `bcd8e76d-1ead-479e-bf80-f042064a9272`
标题：概率论与数理统计练习题（高斯课堂）.pdf
日志：`chunks=34 items=219 entries_written=219 errors=0 elapsed=574.213s`
本轮新增 entries：219

2. `7bb30637-4a24-4d33-b24f-f8da0c0f42ef`
标题：概率论与数理统计考研复习笔记与习题详解（第2版）.pdf
日志：`chunks=12 items=69 entries_written=69 errors=0 elapsed=208.479s`
本轮新增 entries：69

3. `1e312900-91ba-43d5-b6b6-1a5c1cbfa6bc`
标题：概率论与数理统计考研真题精选与章节题库（第5版）.pdf
状态：全量脚本在该材料处理中被终止，sqlite 显示已写入 14 条。
本轮新增 entries：14

4. `affc6f15-d1a3-4c8d-925c-6868aaa3406a`
标题：高斯课堂：二重积分练习与极坐标变换.pdf
日志：`chunks=2 items=15 entries_written=15 errors=0 elapsed=47.002s`
编译：`pagesCreated=0 pagesUpdated=2 linksCreated=0 items=2 errors=0 elapsed=118.108s`
本轮新增 entries：15

5. `25d5ce72-0116-486b-80db-d7bc0c046b41`
标题：高斯课堂：二重积分计算（直角坐标与极坐标）.pdf
日志：`chunks=7 items=46 entries_written=46 errors=0 elapsed=126.885s`
编译：`pagesCreated=0 pagesUpdated=2 linksCreated=0 items=2 errors=0 elapsed=98.537s`
本轮新增 entries：46

## sqlite 证据
```text
subject_id                            entries_since_attempt2
651ccdf7-b0b7-4200-a13c-3f041d1e4fb7  302
d80aaaa3-f7fb-495b-948c-791658cee1cd  61
```

```text
entry_type  entries_since_attempt2
concept     288
question    75
```

```text
bcd8e76d-1ead-479e-bf80-f042064a9272  219
7bb30637-4a24-4d33-b24f-f8da0c0f42ef   69
1e312900-91ba-43d5-b6b6-1a5c1cbfa6bc   14
affc6f15-d1a3-4c8d-925c-6868aaa3406a   15
25d5ce72-0116-486b-80db-d7bc0c046b41   46
```

## wiki 编译证据
```text
compile done. pagesCreated=0 pagesUpdated=2 linksCreated=0 items=2 errors=0 elapsed=98.537s
page: 概率论与数理统计 subjectId=651ccdf7-b0b7-4200-a13c-3f041d1e4fb7 entries=1054 materials=6
page: 高等数学 subjectId=d80aaaa3-f7fb-495b-948c-791658cee1cd entries=103 materials=2
```

```text
高等数学          subject=d80aaaa3-f7fb-495b-948c-791658cee1cd content_len=2841
概率论与数理统计  subject=651ccdf7-b0b7-4200-a13c-3f041d1e4fb7 content_len=4346
```

## 失败与未跑列表
`c0420af8-bd28-4a26-b3f2-7024fe520302`：蛋白质结构预测与生物信息学方法.pdf，old_entries=0，`--skip-pdf-reparse` 下不会处理。
`21625322-982f-425d-b070-07065ddb9921`：认知科学与思维方法.pdf，old_entries=0，`--skip-pdf-reparse` 下不会处理。
`db5cec32-3135-44f9-af51-5ac3596d100e`、`9529eaea-1068-4119-959e-a4c938a23e4b`、`7c815e0b-13e2-40f8-93b5-e99bb48d2acd` 本轮未继续跑。
原因：全量脚本单份材料超过 5 分钟后改单条跑，任务约束最多 5 个 material，本轮已覆盖 5 个 material。

## 运行问题
`--skip-pdf-reparse` 只跳过 PDF 重解析，不会缩短 LLM 提取阶段。
概率论大材料会稳定超过 5 分钟。
终止全量脚本后检查过残留进程，并已清理；最终没有 backfill 脚本继续运行。

## SEVO 流水线状态
attempt 2 已完成：真跑脚本、写入数据库、sqlite 验证、两份报告落盘。
本轮完成的是基于已有旧 entries 的增量 backfill 与 wiki 重新编译。
全量 PDF 重提取尚未完成，两个无旧 entries 的 PDF 需要允许 PDF reparse 或单独设计更小粒度任务。

## 产物
项目内报告：`/root/.openclaw/workspace/projects/kivo/projects/kivo-fr-p06-wiki-page-compiler/artifacts/p04-p06-backfill-final.md`
workspace 报告：`/root/.openclaw/workspace/reports/kivo-p04-p06-backfill-final-2026-05-24.md`
