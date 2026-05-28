# ADR-011：split 时按 entries 多数票重分配 Material 归属

OpenClaw（dev-01 子Agent）· 2026-05-24

## 状态

已采纳

## 背景

学科域 split 会把一个 source subject 拆成多个新 subject，并按 CEO 指定的 entry 分组迁移 `entries.subject_id`。旧实现只迁移 entries，不迁移 `materials.subject_node_id`，会让「原始资料库」仍显示在已 split 的 source 下，而「领域 wiki」里的 entries 已经进入新 subject，两个视图的学科归属不一致。

KIVO 的归属真相源按对象类型分写：Material 看 `materials.subject_node_id`，Knowledge Entry 看 `entries.subject_id`。split 必须同时维护这两个真相源。

## 决策

split 操作在同一数据库事务内同步四张表：`subject_nodes / subject_aliases / materials.subject_node_id / entries.subject_id`。

Material 的 split 后归属按它产生的 entries 推导：

1. 先按请求里的 split 分组创建新 subject，并把每个 entry 迁移到对应的新 subject。
2. 对 source 下每份 Material，读取它产生的 entries。
3. 按这些 entries 当前的 `subject_id` 做多数票。
4. 得票最多的新 subject 成为该 Material 的新 `subject_node_id`。
5. 没产生 entries 的 Material 留在 source，不强行迁移。
6. 如果票数相同，按 split 目标在请求中的顺序选更靠前的新 subject，让同一请求结果稳定可复现。

entries 与 Material 的来源关系优先从 `entries.metadata_json.domainData.materialIds` / `entries.metadata_json.materialIds` / `entries.metadata_json.materialId` 读取；兼容历史数据时，也读取 `entries.source_json.materialIds` / `entries.source_json.materialId` / `entries.source_json.reference` 中的 `material:<id>` 或 `upload://material/<id>` 形态。

## 后果

正面：

- split 后「原始资料库」与「领域 wiki」的学科树归属保持一致。
- 已经完成 B 类提取的 Material 自动跟随它贡献最多的 entries 进入新 subject。
- 只完成 A1/A2、尚未产生 entries 的 Material 留在 source，不凭空猜测归属。
- 迁移与 source 软删除在同一事务内完成，中途失败会整体回滚。

约束：

- 多数票依赖 entries 写入时保留可解析的 material 来源信息。缺少来源信息的 entries 不参与该 Material 的票数。
- 一份 Material 产生的 entries 如果均分到多个新 subject，结果按请求顺序稳定决胜，不再引入新的人工确认队列。

## 合规性

- 符合 FR-B03 AC4：split 操作即时同步 Material 和 Knowledge Entry。
- 符合 FR-B03 AC7：`materials.subject_node_id` 与 `entries.subject_id` 分别作为对象级归属真相源，并在事务内级联同步。
- 不引入新表，不改变现有 API 请求结构。
