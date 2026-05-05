# KIVO

**让 AI Agent 拥有不会遗忘、持续进化的知识系统。**

---

## 你的 Agent 是不是也这样？

每次新对话，Agent 都像失忆了一样。上周讨论过的决策、踩过的坑、定好的规则——全忘了。你反复投喂同样的信息，Agent 反复犯同样的错。

知识散落在聊天记录、配置文件和临时笔记里，没人整理，没人维护，更没人主动去补盲区。

KIVO 改变这一切。

---

## 核心优势

**15 个功能域，覆盖知识完整生命周期**

从多源提取、结构化存储、语义检索、冲突解决、自主调研到图谱洞察——一条管线走完，不需要拼凑多个工具。

**Web 工作台：浏览器里管理知识的全部操作**

不用敲命令行也能用。KIVO 内置完整的 Web 工作台，浏览器打开就能操作：

- 仪表盘总览——知识条目数、盲区数量、待解决冲突、健康趋势，一眼掌握知识库全貌
- 知识浏览器——按类型、领域、标签筛选浏览，支持内联编辑和批量操作
- 语义搜索——输入自然语言，向量检索按相关度排序，多维标签过滤精准命中
- 交互式知识图谱——919 个节点、4216 条关联边、627 条自动生成的洞察，拖拽缩放探索知识结构，点击节点查看详情和关联路径
- 冲突裁决工作台——新旧知识矛盾时自动发现并高亮，支持逐条裁决或批量处理，裁决记录全程留痕
- 分析中间产物——调研过程中的中间推理、证据链、分析草稿，不丢弃，可追溯，支持从中间产物继续深挖

Web 工作台支持密码认证，设置 `AUTH_PASSWORD` 环境变量即可启用访问控制。

**精准补盲，只注入 LLM 做不到的知识**

KIVO 的知识注入有价值判定门禁：入库和注入时自动评估每条知识是否填补 LLM 能力与用户预期之间的差距。用户私有术语、反复出现的 badcase、专业领域定制意图——这些 LLM 训练数据覆盖不到的知识才会被注入。通用常识不浪费 token，被反复纠偏的通用规则自动识别为系统性问题并路由到架构层修复，而不是往知识库里堆条目。价值判定阈值支持按场景配置，入库严格过滤、注入宽松放行，或者反过来——你说了算。

**对话即沉淀：Session 自动提取知识**

Agent 跑了几百轮对话，里面全是决策、踩坑、经验——但散落在日志里没人看。KIVO 自动扫描会话历史，聚类提取高价值知识，直接写入知识库。不用手动整理，跑一次命令就行。在 OpenClaw 环境下，每条对话消息到达时还会自动触发知识提取，边聊边沉淀，零人工干预。

**知识图谱与洞察发现**

知识条目之间自动建立语义关联，形成可探索的知识网络。图谱引擎自动分析节点聚类、发现知识盲区、生成结构化洞察——不只是存知识，还能告诉你「哪些领域知识密集，哪些领域还是空白」。Web 工作台中可交互式探索图谱，拖拽、缩放、点击节点查看关联路径。

**系统词典：全系统术语统一**

团队里每个人对同一个术语的理解不一样？Agent 执行任务时用错了概念？系统词典统一注册核心术语定义，Agent 执行任务时自动注入术语约束，确保全系统语义一致。支持术语别名、关联术语、使用上下文，装完即内置 25 条核心术语作为种子。

**冲突检测与智能合并**

新旧知识矛盾时自动发现，支持时间优先、来源优先、人工裁决三种策略。语义相似的条目自动检测合并候选，保留最完整的版本，冲突记录全程留痕。在 Web 工作台中可视化裁决，不用翻数据库。

**规则订阅与分发**

不同 Agent 需要不同的知识子集？规则订阅机制让每个 Agent 按角色、领域订阅自己需要的知识规则，新规则入库后自动分发到订阅者，不需要手动同步。多 Agent 系统中知识共享而不互相污染。

**知识域目标声明**

给每个知识领域设定目标：这个领域应该覆盖哪些主题？当前覆盖率多少？哪些是盲区？目标声明驱动知识治理——不是被动等知识进来，而是主动发现缺什么、补什么。

**多维知识标签**

一条知识到底是「事实」还是「规则」？用来「路由决策」还是「质量把关」？属于哪个业务领域？KIVO 用 nature（本质）、function（用途）、domain（领域）三个维度给知识打标签，搜索时按任意维度过滤，精准命中你要的那条。

**意图治理引擎**

从对话中自动提取用户偏好和规则，高频意图聚类提权，低频意图衰减清理，知识库自我进化。

**知识自动去重 + 低价值归档**

知识库越用越大，重复条目越来越多？自动检测语义相似的知识条目，合并重复内容，保留最完整的版本。低价值、过时的条目自动归档，不删除但不再参与检索，知识库保持精简高效。

**从错误中自动学习**

用户纠正了 Agent 的回答、审计发现了知识缺陷、验证跑失败了——这些「坏案例」以前只是被修完就忘。KIVO 自动从每次纠偏中提取意图知识，把踩过的坑变成 Agent 下次不会再犯的规则。

**知识质量自动体检**

知识库里有多少条目是过时的、模糊的、缺乏上下文的？用 LLM 从准确性、完整性、可操作性三个维度给每条知识打分，低质量条目自动标记并批量重写，知识库越用越干净。

**消息级知识自动注入**

`kivo init` 在 OpenClaw 环境下自动安装 workspace hook。之后每条用户消息到达时，hook 自动检索知识库，把最相关的知识条目注入 agent 上下文——agent 不需要主动查询，知识自己找上门。检索走 BGE 向量语义匹配（bge-small-zh-v1.5），命中率和相关性远超关键词搜索。hook 自带多路径加载、日志记录、优雅降级，装完零配置即生效。

**知识治理自动触发**

手动跑去重、审计、重写？太累了。`kivo auto-govern` 一条命令串联 MECE 去重 + 质量审计 + 低分条目自动重写，挂到 cron 每天凌晨跑一次，知识库自己保持健康。`kivo watch-badcases` 监听指定目录，新 badcase 文件落盘即自动提取意图知识。`kivo init` 在 OpenClaw 环境下自动注册 crontab + 安装意图注入 hook，装完即自治，零人工干预。

**访问控制与可观测性**

Web 工作台支持密码认证保护。操作日志完整记录每次知识变更的来源、时间、操作者，支持审计追溯。健康仪表盘实时展示知识库状态——条目总数、各类型分布、冲突数量、治理执行记录，系统管理员一眼掌握全局。

**版本迁移 + 自动备份**

数据库 schema 变更自动迁移，升级前自动校验数据完整性，失败可回滚。

**初始化即有种子知识**

`kivo init` 自动写入种子知识条目和系统词典，装完就能搜、就能用，不是空壳。

---

## 30 秒快速体验

```bash
# 安装
npm install @self-evolving-harness/kivo

# 初始化（自动创建数据库 + 写入种子知识 + 注册定时任务）
npx kivo init --yes

# 写入一条知识
npx kivo add fact "TypeScript 5.0 支持装饰器" --content "TC39 Stage 3 装饰器提案在 TypeScript 5.0 中正式支持" --tags "typescript,decorator"

# 语义检索
npx kivo query "装饰器怎么用"

# 查看知识列表
npx kivo list --type fact

# 启动 Web 工作台
npx kivo web
```

### 从会话历史萃取知识

```bash
# 扫描最近的会话日志，自动提取知识
npx kivo extract-sessions

# 只处理某个日期之后的会话
npx kivo extract-sessions --since 2026-01-01

# 先预览，不写入数据库
npx kivo extract-sessions --dry-run
```

### 多维标签搜索

```bash
# 按知识本质过滤：只看事实类
npx kivo query "部署流程" --nature fact

# 按用途过滤：只看用于路由决策的知识
npx kivo query "Agent 调度" --function routing

# 按领域过滤
npx kivo query "冲突解决" --domain agent-scheduling

# 给已有知识补打三维标签（LLM 自动分析）
npx kivo retag

# 预览标签变更，不实际修改
npx kivo retag --dry-run
```

### 知识治理自动化

```bash
# 一键执行全套治理：去重 + 质量审计 + 低分重写
npx kivo auto-govern

# 只对某个领域执行
npx kivo auto-govern --domain agent-scheduling

# 监听 badcase 目录，新文件落盘即自动提取知识
npx kivo watch-badcases --dir ./logs

# 单次扫描模式（适合 cron）
npx kivo watch-badcases --dir ./logs --once

# init 时自动注册 cron 定时任务（OpenClaw 环境自动检测）
npx kivo init --yes
```

验证环境：

```bash
npx kivo health
```

---

## 使用场景

### 独立产品操盘者

用 Agent 推进产品研发和运营。需要 Agent 记住历史决策和经验教训，不在同一个坑上反复踩。KIVO 让 Agent 的知识持续积累，调研能力自动补盲。

### Agent 开发者

构建多 Agent 系统。需要统一的知识管理接口，让不同 Agent 共享知识而不互相污染。KIVO 提供域级访问控制和规则订阅分发，每个 Agent 只拿到自己需要的知识子集。

### 个人知识工作者

文档、论文、笔记散落各处。KIVO 从多种来源自动提取结构化知识，建立关联，发现盲区，辅助深度研究。Web 工作台中的知识图谱让你用可视化方式探索自己的知识网络。

### 系统管理员

管理 Agent 集群的知识健康。KIVO 提供仪表盘总览——盲区数量、过时条目、待解决冲突，一目了然。操作日志完整记录每次变更，审计追溯有据可查。

---

## 三种运行模式

**standalone** — 最短路径，本地 SQLite，单机即跑，适合个人使用和快速验证。

**host-embedded** — 嵌入已有 Agent 系统，通过 API 消费知识，适合开发者集成。

**full-stack** — Core + Web 工作台，浏览器中探索知识图谱、管理调研、裁决冲突，适合团队协作。

---

## 常用命令

```bash
npx kivo health          # 环境健康检查
npx kivo init --yes      # 初始化（非交互模式）
npx kivo web             # 启动 Web 工作台
npx kivo add <type> <title> [--content "..." --tags "a,b"]  # 新增知识
npx kivo list [--type fact --limit 20]                       # 列出知识
npx kivo update <id> [--content "..." --status deprecated]   # 更新知识
npx kivo delete <id> [--force]                               # 删除知识
npx kivo query <text>    # 语义检索
npx kivo config-check    # 配置校验
npx kivo capabilities    # 查看系统能力
npx kivo migrate status  # 数据库迁移状态
npx kivo extract-sessions [--since DATE --dry-run]    # 从会话历史萃取知识
npx kivo retag [--dry-run --limit N]                  # 给已有知识补打三维标签
npx kivo query <text> [--nature X --function Y --domain Z]  # 多维过滤搜索
npx kivo governance mece [--threshold 0.85 --auto-merge]     # 知识去重 + 覆盖审计
npx kivo governance badcase [--since DATE]                   # 从纠偏记录中提取知识
npx kivo governance audit [--rewrite --min-score 0.6]        # 质量体检 + 低分重写
npx kivo auto-govern [--domain X --threshold 0.85]            # 一键串联去重+审计+重写，适合 cron 定时跑
npx kivo watch-badcases --dir <path> [--once --interval 15000] # 监听目录，新 badcase 自动提取意图知识
```

---

## 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `KIVO_DB_PATH` | 数据库路径 | `./kivo.db` |
| `KIVO_MODE` | 运行模式（standalone/hosted） | `standalone` |
| `KIVO_CONFLICT_THRESHOLD` | 冲突检测阈值 | `0.85` |
| `KIVO_EMBEDDING_PROVIDER` | 向量化提供商 | — |
| `KIVO_EMBEDDING_API_KEY` | 向量化 API Key | — |
| `AUTH_PASSWORD` | Web 工作台登录密码 | — |

不配置 embedding 也能运行，语义检索退化为关键词检索。

---

## 运行要求

- Node.js >= 20
- SQLite（通过 better-sqlite3，安装时自动编译）

---

## 文档

- [快速开始](./docs/quick-start.md)
- [配置参考](./docs/configuration-reference.md)
- [故障排查](./docs/troubleshooting.md)
- [升级指南](./docs/upgrade-guide.md)
- [产品规格](./docs/product-requirements.md)
- [架构文档](./docs/architecture/arc42-architecture.md)

---

## 许可证

MIT License。详见 [LICENSE](./LICENSE)。
