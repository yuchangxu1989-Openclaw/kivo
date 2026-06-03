# KIVO — Agent Runtime Context Engineering Layer

🌐 [官网](https://agentos.site/kivo.html)

> 把正确知识，以正确预算，注入到正确任务。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@self-evolving-harness/kivo.svg)](https://www.npmjs.com/package/@self-evolving-harness/kivo)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/host-OpenClaw-black.svg)](https://github.com/yuchangxu1989-Openclaw)

KIVO 面向 Agent 运行时。
它把聊天、文档、纠错、决策沉淀成可检索、可关联、可注入的上下文资产。
重点不在“存了多少知识”。重点在任务开始前，系统该带什么进去，带多少，先展开到什么粒度。

## 先说问题

Agent 真正难的地方，通常是上下文质量失控。
更常见的是：

- 上下文窗口很贵，塞多了会淹没有用信息
- 聊天记录很长，历史经验散在各处
- 普通检索会把相似内容全丢进来，噪声比信号多
- 已知知识能找到，未知盲区没人提醒
- 团队换模型、换 provider、换部署环境时，记忆层容易一起锁死

KIVO 解决的是这几件事。

## KIVO 在做什么

KIVO 把知识处理成 Agent 可消费的运行时上下文层：

1. 先从 repository search 拉候选
2. 再做 relevance scoring
3. 再过 injection value gate，过滤掉不值得占上下文的内容
4. 再按 formatter 组织输出
5. 最后走 token policy，把内容压进预算内

这条链路落在 `src/injection/context-injector.ts`。
README 应该围绕这条链来读，别再把它理解成“知识库”三个字。

## 核心能力

### 1. Token-budgeted injection

KIVO 会在注入前管预算。
它既看相关性，也看值不值得占 token。

- `ContextInjector.inject()` 负责检索、评分、value gate、格式化、预算控制
- `InjectionPolicy` 会按 `maxTokens`、分数阈值、类型偏好、去重结果做选择
- 预算不够时会截断，避免一股脑塞满上下文

相关实现：

- `src/injection/context-injector.ts`
- `src/injection/injection-policy.ts`
- `__tests__/injection.test.ts`

### 2. Progressive disclosure

有些任务只需要一行摘要。
有些任务要看全文。
KIVO 支持两种 disclosure mode：`summary` 和 `full`。

- `summary` 先给轻量描述，省 token
- `full` 在需要深挖时再展开
- `injectById()` 支持按条目 ID 单独取回完整内容

这意味着 Agent 可以先少拿，再按需展开。
上下文不会一开始就被大段资料塞爆。

相关实现：

- `src/injection/context-injector.ts`
- `src/injection/injection-formatter.ts`

### 3. Graph-backed context，不只看向量相似度

KIVO 会把知识条目组织成图。
图里的关系不只一种。

- 显式关联：已有 association
- 共同来源：`co_occurs`
- 语义近邻：`semantic_neighbor`

这些结构定义在 `src/association/knowledge-graph.ts`。
它让检索结果从“几个孤零零的片段”变成“带关系的上下文网络”。

### 4. 图谱盲区发现

KIVO 会看图里哪里缺东西。

`GraphInsightAnalyzer` 会识别：

- isolated nodes
- bridge nodes
- sparse communities
- unexpected associations

这些洞察也能直接驱动后续动作。
它们是下一步知识工作的入口。

相关实现：

- `src/association/graph-insights.ts`
- `__tests__/graph-gap-coverage.test.ts`

### 5. 从洞察直接变成调研任务

KIVO 不只回忆已知内容。
它也会提醒你哪里还没懂透。

`GraphInsightAnalyzer.toResearchTasks()` 会把图谱洞察转成研究建议。
例如：

- 某些知识条目长期孤立，说明上下游关系还没补齐
- 某个主题群内部过稀，说明研究深度不够
- 某条跨域关联很反常，说明值得验证

这一步很关键。
系统开始从“记住东西”往“推动知识演化”走。

### 6. 供应商中立，可本地降级

KIVO 的 embedding provider 支持多种后端：

- Ollama
- OpenAI-compatible endpoint
- `local` fallback

无外部 embedding 服务时，可以退到本地 provider。
个人环境能跑，团队环境也能接现有基础设施。

相关实现：

- `src/embedding/create-provider.ts`

## 一张图看懂 KIVO

```text
Sessions / Docs / Corrections
            |
            v
   Extraction + Normalization
            |
            v
   Repository Search
            |
            v
    Relevance Scoring
            |
            v
  Injection Value Gate
            |
            v
 Formatter + Token Policy
            |
            v
 Agent Runtime Context
            |
            +--> summary/full progressive disclosure
            +--> injectById on demand
            +--> graph insight and research tasks
```

## 这套能力带来什么

- 少塞废话，保住上下文预算
- 把散落经验变成下一次任务可直接利用的输入
- 让检索结果带关系、带优先级、带展开路径
- 让知识盲区浮出水面，推动补盲，减少原地重复
- 让部署保持灵活，本地和团队环境都能落地

## Quick Start

### 1. 安装

```bash
npm install @self-evolving-harness/kivo
```

### 2. 初始化本地知识层

```bash
npx kivo init --yes
```

### 3. 添加知识并查询

```bash
npx kivo add fact "TypeScript decorators in 5.0" \
  --content "TypeScript 5.0 adds support for the Stage 3 decorators proposal." \
  --tags "typescript,decorators"

npx kivo query "How do decorators work in TypeScript?"
```

初始化后，KIVO 会创建本地知识存储，安装工作区所需 hook，并启用 Agent 会话可调用的检索链路。

## 适合什么场景

- 你已经有 Agent，在意执行时上下文质量
- 你发现历史经验总在聊天里蒸发
- 你需要把文档、纠错、决策沉淀成可复用资产
- 你想让系统主动暴露知识盲区，同时给出下一步补盲方向
- 你希望保持 provider-neutral，同时给本地部署留后路

## 项目状态

KIVO 当前是 early-stage open source runtime layer。
代码里已经有注入链、图谱关系、盲区分析、调研任务建议和本地降级路径。
如果你在找一层能真正管住 Agent 上下文质量的基础设施，KIVO 值得看源码。

## Contributing

欢迎贡献。

1. Fork 仓库
2. 开分支
3. 提交改动和对应验证
4. 在 PR 里写清楚问题、改动和证据

本地开发：

```bash
npm install
npm run build
npm run test
```

## License

MIT. See `LICENSE` for details.
