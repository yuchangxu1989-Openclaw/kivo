# KIVO Seed 学科节点动态化 + Wiki 编译触发阈值

OpenClaw（主会话）/ 2026-05-24

## 用户人群
KIVO 通用知识平台的所有用户，不限学科领域。

## 痛点
当前 KIVO 系统预置了 8 个 seed subject_nodes（概率论、高数、线代、数据结构、算法、操作系统、计算机网络、编译原理），用户无论投什么材料，这 8 个节点都会出现在领域知识库里。Wiki 编译器对没有任何 entries 关联的空节点也照常编译，产出 100-200 字节的「暂无相关条目」占位页，污染领域知识库。

实证 badcase（2026-05-24 19:25）：用户投入 21 个 PDF 全部集中在概率论 + 高数，323 个 entries 自然落在这两个学科节点上，但 wiki_page 编译器还为剩下 6 个空节点生成了占位页。

KIVO 用户军规明确禁止具体学科举例（通用知识平台），预置具体学科白名单与此军规直接冲突。

## 原始需求
seed 学科节点应该按用户实际投入的材料动态生成，系统不预置任何具体学科。Wiki 编译器对没有关联 entries 的空节点不应编译，避免污染。

## 用户体验流
1. 用户首次安装 KIVO，领域知识库为空，没有任何 seed subject_nodes。
2. 用户导入材料（PDF / 笔记 / 视频）后，管线在分类阶段动态创建 subject_nodes（基于材料内容 LLM 推断学科归属）。
3. 用户在领域知识库页面只看到自己投入材料覆盖的学科节点，看不到无关学科占位。
4. Wiki 编译器只为关联 entries 数大于 0 的节点编译 wiki_page。
5. 现有用户库迁移：清理所有零关联 seed nodes，已编译占位 wiki_page 删除。

## 功能需求

### FR-1 移除预置 seed 学科节点
init 流程不再预置任何具体学科节点。新装系统 subject_nodes 表为空。

### AC
- AC1 移除代码中所有 SEED_SUBJECT_NODES 硬编码常量 / 数组
- AC2 init 脚本不再插入预置 subject_nodes
- AC3 现有 DB 迁移：扫描 subject_nodes 表，删除关联 entries 数为 0 的节点
- AC4 删除空节点时连带删除其已编译的 wiki_page entries

### FR-2 Wiki 编译触发阈值
Wiki 编译器只为关联 entries 数大于 0 的 subject_node 编译 wiki_page。

### AC
- AC1 wiki-page-compiler.ts 编译入口加 `getEntriesCount(subjectNodeId)` 检查
- AC2 entries 数为 0 → 跳过该节点编译，记日志「skipped: no entries」
- AC3 进一步可选阈值（默认 1 即可，未来可配置）
- AC4 已存在的占位 wiki_page entries 在迁移脚本中清理

### FR-3 动态学科节点生成
管线分类阶段（FR-A04 学科分类）按 LLM 推断结果创建 subject_nodes，不依赖预置列表。

### AC
- AC1 classification 阶段 LLM 输出学科名称
- AC2 subject_nodes 表按学科名称 upsert（不存在则插入新节点）
- AC3 节点元数据由 LLM 推断填充（描述 / 别名）
- AC4 同义学科归并由 LLM 判定（例如「概率统计」「概率论」归一）

## Follow-up（本期不实装）
本期管线分类只实装骨架：学科判定 + subject_nodes upsert。LLM 语义补充与同义归并留到下阶段。判据“2026-05-24 用户拍板：本期管线分类先做骨架，LLM 判定 + 同义归并下阶段做”。

- AC3 节点元数据由 LLM 推断填充（描述 / 别名）——deferred
- AC4 同义学科归并由 LLM 判定（例如「概率统计」「概率论」归一）——deferred

本期 AC1、AC2 必须交付；AC3、AC4 在下阶段专项需求中重新拆解。

## 测试用例
1. 全新安装 → subject_nodes 表为空
2. 导入概率论 PDF → 自动创建「概率论与数理统计」节点
3. 导入高数 PDF → 自动创建「高等数学」节点
4. 不导入线代材料 → 「线性代数」节点不存在
5. 现有用户库迁移 → 6 个空 seed 节点删除，对应占位 wiki_page 删除
6. wiki 编译器对空节点 → 跳过 + 日志记录
7. 编译器对有 entries 的节点 → 正常编译 wiki_page
