# KIVO

**自主沉淀、自主注入的意图增强知识体系。**

🌐 [官网](https://agentos.site/kivo.html)

---

## 你的 Agent 是不是也这样？

每次新对话，Agent 都像失忆了一样。上周讨论过的决策、踩过的坑、定好的规则——全忘了。你反复投喂同样的信息，Agent 反复犯同样的错。

知识散落在聊天记录、配置文件和临时笔记里，没人整理，没人维护，更没人主动去补盲区。

KIVO 改变这一切。

---

## 核心机制

### 行为变化测试：只存能改变 Agent 行为的知识

KIVO 跟 Obsidian、Notion、Mem 这些知识工具的根本区别：每条知识入库前必须通过行为变化测试。判断标准只有一个——「如果这条知识不存在，Agent 会做出不同的（错误的）决策吗？」回答为「是」才允许入库。

通用常识、LLM 本来就会的东西、不影响决策的信息——全部拦在门外。留下来的每一条都是能让 Agent 表现更好的硬货。知识库永远不会膨胀。

### 五步知识管线：对话自动变成可用知识

从对话中提取知识，走五步管线：

1. **原子分解 + 去上下文化**——把对话拆成独立知识片段，解析代词、补全实体，让每条知识脱离原始对话也能看懂
2. **行为变化测试**——准入门禁，只有能改变 Agent 行为的知识才放行
3. **向量去重**——0.92 cosine 相似度阈值，语义重复的不重复入库
4. **素材暂存**——通过门禁的知识先进 staging 区，等待聚合
5. **抽象聚合入库**——相关素材合并为更高层次的知识条目，写入正式库

每条对话消息到达时自动触发提取，边聊边沉淀，零人工干预。

### 意图注入：知识自己找上门

这是「自主注入」的核心。

Agent 处理用户消息时，KIVO 自动用当前消息内容做向量语义检索（BGE embedding cosine similarity），从知识库中找到最相关的条目。然后通过知识图谱扩展——沿着已建立的语义关联，把强关联的知识也拉进来。匹配结果直接注入 Agent 的 prompt 上下文。

整个过程对用户透明，Agent 不需要主动查询，知识自己找上门。注入量受 token 预算控制，按相关度排序，术语优先级最高。还有价值判定——通用常识即使语义匹配度高也不注入，只注入 LLM 自身覆盖不了的高价值知识。

### 自主调研：知识库自己补盲区

KIVO 不等你手动投喂。系统持续监测知识库的盲区：

- **查询未命中追踪**——Agent 查了但没查到的高频问题，说明这块知识缺失
- **图谱结构分析**——孤立节点、稀疏社区、桥接缺失，从知识网络结构发现逻辑缺口
- **覆盖度审计**——对照知识域目标声明，检查哪些主题还没覆盖

发现盲区后，系统自动生成调研任务（含目标、范围、搜索策略、资源预算），交给 OpenClaw 宿主环境执行。调研结果经过知识提取管线后入库，形成闭环。调研优先级基于影响面和紧迫度自动排序，不抢占用户主动发起的任务资源。

---

## 运行环境

KIVO 运行在 OpenClaw 上。`kivo init` 一条命令搞定一切：

- 创建数据库 + 写入种子知识
- 检测并连接 embedding provider（Ollama + bge-m3）
- 安装 workspace hook（意图注入自动生效）
- 注册 crontab 定时任务（知识提取、去重、审计、过时清理全自动）

装完之后不需要手动配置任何东西。知识沉淀通过 hook 自动触发——每条消息到达时提取，每 2 小时批量扫描历史会话补漏。知识注入在每次对话时自动执行。治理任务（去重、审计、重写、过时归档）按 cron 自动运行。

你要做的就是正常用 OpenClaw，KIVO 在后台默默工作。

---

## 其他能力

**Web 工作台：浏览器里管理知识**

不用敲命令行也能用。内置完整的 Web 工作台，浏览器打开就能操作：

- 仪表盘总览——知识条目数、盲区数量、待解决冲突、健康趋势
- 知识浏览器——按类型、领域、标签筛选，支持内联编辑和批量操作
- 语义搜索——输入自然语言，向量检索按相关度排序
- 交互式知识图谱——拖拽缩放探索知识结构，点击节点查看关联路径
- 冲突裁决工作台——新旧知识矛盾时自动发现并高亮，支持逐条裁决
- 分析中间产物——调研过程中的推理、证据链、分析草稿，可追溯
- 意图治理面板——高频主题柱状图、治理报告历史、批量归档/重评

Web 工作台支持密码认证，设置 `AUTH_PASSWORD` 环境变量即可启用访问控制。

**知识图谱与洞察发现**

知识条目之间自动建立语义关联，形成可探索的知识网络。图谱引擎自动分析节点聚类、发现知识盲区、生成结构化洞察——告诉你哪些领域知识密集，哪些领域还是空白。

**系统词典：全系统术语统一**

统一注册核心术语定义，Agent 执行任务时自动注入术语约束，确保全系统语义一致。支持术语别名、关联术语、使用上下文。

**冲突检测与智能合并**

新旧知识矛盾时自动发现，支持时间优先、来源优先、人工裁决三种策略。语义相似的条目自动检测合并候选，冲突记录全程留痕。

**规则订阅与分发**

不同 Agent 按角色、领域订阅自己需要的知识规则，新规则入库后自动分发到订阅者。多 Agent 系统中知识共享而不互相污染。

**从错误中自动学习**

用户纠正了 Agent 的回答、审计发现了知识缺陷——KIVO 自动从每次纠偏中提取意图知识，把踩过的坑变成 Agent 下次不会再犯的规则。

**知识质量自动体检**

用 LLM 从准确性、完整性、可操作性三个维度给每条知识打分，低质量条目自动标记并批量重写。过时知识自动归档，不删除但不再参与检索。

**多维知识标签**

KIVO 用 nature（本质）、function（用途）、domain（领域）三个维度给知识打标签，搜索时按任意维度过滤。

---

## 30 秒快速体验

```bash
# 安装
npm install @self-evolving-harness/kivo

# 语义搜索依赖 Ollama + bge-m3（必须安装，KIVO 的核心能力依赖向量检索）
curl -fsSL https://ollama.com/install.sh | sh && ollama pull bge-m3

# 初始化（自动创建数据库 + 种子知识 + 检测 Ollama + 注册定时任务 + 安装 hook）
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
```

### 知识治理

```bash
# 一键串联去重 + 审计 + 重写
npx kivo auto-govern

# 从纠偏记录中提取意图知识
npx kivo governance badcase --since 2026-01-01

# 质量体检
npx kivo governance audit
```

---

## CLI 命令速查

```bash
npx kivo init [--yes]                                        # 初始化
npx kivo add <type> <title> [--content "..." --tags "..."]   # 添加知识
npx kivo list [--type <type> --status <status>]              # 列出知识
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

Embedding provider 是必须的。未配置时命令会报错并输出配置引导，推荐 Ollama + bge-m3（本地免费）。`kivo init` 会自动检测并引导你完成配置。

---

## 运行要求

- Node.js >= 20
- SQLite（通过 better-sqlite3，安装时自动编译）
- Ollama + bge-m3（或其他兼容的 embedding provider）
- OpenClaw 宿主环境

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
