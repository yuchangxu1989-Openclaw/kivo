# KIVO — arc42 架构文档
OpenClaw（dev-01 子Agent）| 2026-04-29

---

## 目录
1. 引言与目标（Introduction and Goals）
2. 约束（Architecture Constraints）
3. 上下文与范围（System Scope and Context）
4. 解决方案策略（Solution Strategy）

---

## 1. 引言与目标（Introduction and Goals）

### 1.1 问题陈述
KIVO（Knowledge Iteration & Vibe Orchestration）处理的是 Agent 知识管理问题。
当前知识散落在对话、记忆文件、规则文件、调研报告、网页摘录和临时笔记中。
这些内容有价值，但大多还停留在原始记录层，没有进入结构化、可检索、可迭代、可治理的状态。
由此带来的后果很直接：
- Agent 记住片段，记不住稳定结论。
- 新知识入库后，旧知识可能继续生效。
- 用户纠偏发生过多次，系统仍会重复同类错误。
- 规则、事实、方法、经验混在一起，调用边界不清。
- 用户想看知识全貌时，只能翻文件，无法从系统层获得统一视图。
KIVO 的目标，是把分散知识转成可运营的知识资产，并让 Agent 与用户都能稳定消费这套资产。

### 1.2 系统目标
KIVO 有两个直接消费面：
- 面向 Agent：提供知识提取、结构化存储、语义检索、冲突解决、上下文注入、规则分发和缺口驱动调研。
- 面向用户：提供 Knowledge Workbench，用于导入、查看、审核、探索、调研和治理知识库。
围绕这两个消费面，系统需要达成以下结果：
- 知识条目结构统一，能稳定存取和追溯。
- 知识变更走版本与冲突流程，不发生静默覆盖。
- 检索支持语义、类型、时间、来源、知识域与目标声明约束。
- 系统能主动发现知识缺口，并把缺口转成可执行调研任务。
- 规则分发与知识检索分开建模，治理信息和内容信息分别处理。
- 核心逻辑与宿主环境解耦，不绑死某个运行时或工具链。
- 外部陌生用户能在最小依赖下跑通首次知识旅程。

### 1.3 架构驱动因素
本架构由以下因素主导：
- 知识生命周期长于单次会话，需要跨对话、跨任务、跨 Agent 持续存在。
- 知识同时服务机器消费和人工审阅，结构与可读性都要成立。
- 宿主能力并不恒定，网络访问、Provider、文件权限和工具能力都可能变化。
- 系统初期要能单机运行，后续还要支持更复杂的嵌入式部署。
- 研发资源有限，架构要先保证主干闭环，再开放扩展点。

### 1.4 最重要的质量目标
#### QG-1 一致性（Consistency）
知识写入必须经过分类、冲突检测和状态管理。
新旧结论冲突时，系统要么自动裁决，要么显式进入人工裁决流。
衡量标准：
- 冲突检测覆盖所有写入路径。
- 冲突解决率达到 100%。
- 条目状态流转可审计、可回放。

#### QG-2 检索有效性（Retrieval Effectiveness）
KIVO 的价值主要体现在取用环节。
知识已经入库却在检索时拿不到，整套结构化工作就失去意义。
衡量标准：
- 检索命中率达到 spec 目标。
- 返回结果包含来源、类型、相关度和版本语义。
- 语义检索失败时可降级，不让系统整体失明。

#### QG-3 宿主解耦（Host Decoupling）
KIVO 需要在 OpenClaw 体系内落地，也要保留迁移到其他宿主的能力。
衡量标准：
- 更换宿主适配层时，核心域逻辑不改。
- 更换底层存储或检索引擎时，上层接口行为稳定。
- 宿主能力下降时，系统进入可解释的降级状态。

#### QG-4 可治理性（Governability）
知识系统进入真实使用后，治理成本会持续上升。
系统必须让用户看见待确认条目、待裁决冲突、未补齐盲区和关键状态变化。
衡量标准：
- 关键事件进入活动流。
- 核心指标能聚合到仪表盘。
- 审计链路能追到来源、版本、裁决和分发记录。

#### QG-5 开箱即用（Out-of-Box Readiness）
KIVO 需要支持外部用户安装、启动、录入、检索和持续使用。
衡量标准：
- 最小运行模式成立。
- 首次知识旅程可在 10 分钟内完成。
- 安装与配置错误有清楚提示和恢复路径。

### 1.5 利益相关者
#### Solo Founder / 独立产品操盘者
关注点：Agent 是否能持续记住决策、方法论和经验教训；知识缺口能否被主动发现并补齐；历史积累能否持续复用。

#### Agent 开发者
关注点：是否有统一知识接口供多个 Agent 共用；知识共享时是否有域边界和规则边界；宿主升级或 Provider 变化时接口是否稳定。

#### 系统管理员 / 运营者
关注点：访问控制是否可管；冲突、缺口、分发失败、待确认条目是否可观察；导入导出、升级迁移是否可控。

#### 最终用户 / 知识工作者
关注点：能否通过 Workbench 直接导入和管理知识；搜索、详情、活动流、调研入口是否清楚；空库时是否有引导。

#### OpenClaw 宿主环境
关注点：KIVO 是否遵守插件边界和运行时约束；与 Gateway、工具调用、文件系统、消息通道的集成成本是否可控；核心能力能否复用到其他项目。

#### 研发相关模块（SEVO / AEO / Claw Design）
关注点：SEVO 需要历史规格、方法论、规则和经验；AEO 需要在效果漂移时联动 KIVO 排查知识缺失；Claw Design 只消费知识，不承担知识治理职责。

---

## 2. 约束（Architecture Constraints）

### 2.1 技术约束
#### TC-1 OpenClaw 插件体系约束
KIVO 当前以 OpenClaw 为主宿主。
集成边界需要兼容 Gateway、插件、skills、共享工作区和消息调度模型。
核心知识逻辑可以独立抽象，但运行时要接受宿主的事件方式、文件布局和工具分发方式。

#### TC-2 Node.js 运行时约束
系统主实现以 Node.js 为边界条件。
这会影响并发模型、内存使用、I/O 方式、生态选择和部署形态。
架构需要优先采用适合 Node.js 的异步事件驱动方案，避免依赖重型本地服务才能成立。

#### TC-3 Provider 可变约束
知识提取、冲突精判、Embedding 生成、结构化输出依赖 LLM Provider。
Provider 可能有能力差异、配额限制、网络波动和临时不可用场景。
系统必须支持 Provider 注册、能力声明、降级和切换。

#### TC-4 宿主能力协商约束
KIVO 不能假设每个宿主都具备完整能力。
有的宿主没有浏览器，有的宿主没有 Embedding Provider，有的宿主网络能力受限。
因此需要显式的 Host Adapter 与 capability negotiation 机制。

#### TC-5 最小运行模式约束
spec 明确要求 standalone 最小组合可运行。
架构不能建立在必须有向量数据库、图数据库或外部任务系统的前提上。
默认形态要能落在单机、本地存储、单 Provider 的组合上。

#### TC-6 原始内容治理约束
系统遵守“知识先结构化再存储”。
原始文档、网页正文、对话片段可以作为来源引用和处理中输入，但核心库不以原文堆积作为主存储模型。

#### TC-7 事件化写入约束
知识条目写入、图谱更新、缺口检测、规则分发和活动流刷新存在天然串联关系。
为了满足异步提取和局部失败隔离，系统需要以事件驱动推进阶段，而不是把所有处理压进单个同步请求。

### 2.2 组织约束
#### OC-1 单人开发约束
KIVO 当前处于 solo founder + AI agents 的研发组织里。
架构要能被少量维护者理解、调试和演进，避免把核心闭环拆成过多高耦合微服务。

#### OC-2 开源发布约束
系统目标包含对外可安装、可文档化、可升级。
架构需要为 README、Quick Start、配置参考、故障排查和迁移脚本预留稳定入口。

#### OC-3 多宿主潜力约束
当前优先服务 OpenClaw，但产品定义要求核心逻辑与宿主环境解耦。
架构阶段就要保留宿主适配面，避免未来迁移时整体重写。

#### OC-4 审计与交付约束
关键状态变更需要能被审计、回看和解释。
架构从一开始就要把活动流、指标聚合、版本历史和裁决记录纳入主路径。

### 2.3 惯例约束
#### CC-1 六类知识类型固定起步
系统首批采用 fact、methodology、decision、experience、intent、meta 六种类型。
后续允许扩展，但当前所有提取、存储、检索和展示逻辑都围绕这六类先闭环。

#### CC-2 规则与知识分离
Rule Entry 与 Knowledge Entry 职责不同。
规则描述治理语义，知识描述事实、方法、经验和意图。
这两类对象的生命周期、订阅机制和消费方式不同。

#### CC-3 冲突必须显式处理
系统接受知识会发生冲突，但不接受冲突悄悄留在库里继续生效。
任何写入路径都必须进入统一冲突机制。

#### CC-4 溯源与版本是基础元数据
知识条目、调研结果、裁决结论和系统生成产物都必须有来源引用与版本语义。
没有来源的条目可以临时保存在待确认状态，不能直接成为高置信长期知识。

#### CC-5 Workbench 是独立消费层
Workbench 是用户使用 KIVO 的正式入口之一。
架构上要与引擎层解耦，功能上要覆盖导入、审核、探索、调研和活动流。

---

## 3. 上下文与范围（System Scope and Context）

### 3.1 业务边界
KIVO 负责知识提取、分类、冲突治理、持久化、检索、图谱构建、缺口检测、调研任务定义、规则管理和用户工作台。
KIVO 不负责：
- 研发流水线推进与任务编排，那是 SEVO 的职责。
- Agent 效果度量与漂移分析，那是 AEO 的职责。
- 设计资产生成，那是 Claw Design 的职责。
- 宿主工具的实现细节，KIVO 只通过适配层消费宿主能力。

### 3.2 业务上下文
```text
用户 / 管理员 / Agent 开发者
        │
        │ 浏览 / 检索 / 审核 / 配置 / 调研
        ▼
Knowledge Workbench
        │
        │ HTTP API / Event Stream
        ▼
KIVO Core
  ├─ 知识提取与分析
  ├─ 分类与路由
  ├─ 冲突治理与版本
  ├─ 检索与上下文注入
  ├─ 规则注册与分发
  ├─ 图谱与缺口检测
  └─ 调研任务定义
        │
        ├──────── OpenClaw Gateway / Host Adapter
        ├──────── LLM Providers / Embedding Providers
        ├──────── 文件系统 / 本地存储 / 导入源
        ├──────── Web / 文档 / URL 信息源
        └──────── 飞书等外部协作系统
```

### 3.3 业务交互对象
#### 用户
与 KIVO 的交互：上传文档、录入知识、搜索条目、查看图谱和活动流、裁决 pending 条目与冲突条目、管理系统字典和意图库。
KIVO 交付给用户的价值：可见的知识资产全貌、可操作的审核与调研闭环、清楚的首次知识旅程。

#### Agent
与 KIVO 的交互：发起语义检索请求、请求上下文注入与术语注入、查询订阅规则、提交对话或调研结果进入知识管线。
KIVO 交付给 Agent 的价值：稳定的知识消费接口、具备边界的上下文增强、知识缺失后的补盲动作。

#### OpenClaw Gateway / 宿主环境
与 KIVO 的交互：提供运行时、工具分发、文件工作区、消息通道和外部系统访问能力；通过 Host Adapter 向 KIVO 注册可用能力；接收 KIVO 输出的调研任务定义或高优先级分发事件。
KIVO 对宿主的要求：能声明能力、承载异步事件、提供基础持久化，并允许功能降级。

#### LLM Provider / Embedding Provider
与 KIVO 的交互：负责知识提取、结构化分析、冲突精判、意图增强和向量生成；以能力声明形式暴露文本生成、Embedding、结构化输出等能力。
KIVO 对 Provider 的要求：可注册、可切换、失败可解释、输出可标准化处理。

#### 文件系统与外部信息源
与 KIVO 的交互：提供文档导入、URL 抓取结果、规则文件、报告文件和导出文件；作为 Source Reference 的承载位置之一。
处理原则：先分析，再生成条目，再入库；结构化知识入主库，原始内容保留为来源与辅助上下文。

#### 飞书等外部协作系统
与 KIVO 的交互：承接通知、分享和协作场景，可消费调研完成、冲突待裁决、系统就绪度等外部消息。
定位：协作出口，不承担知识主存储职责。

### 3.4 技术上下文
#### 入口接口
- Knowledge Query API：给 Agent 和 Workbench 提供搜索能力。
- Context Injection API：给 Agent 提供检索后上下文。
- Extraction Input：接收对话、文档、网页、规则文件和手工录入内容。
- Rule Query / Subscription API：给 Agent 查询和订阅规则。
- Research Task API / Event：输出结构化调研任务定义。
- Dashboard / Activity / Detail API：给 Workbench 提供聚合与明细数据。
- Research Task API / Queue Adapter：给调研规划器、Workbench 和宿主执行器提供任务创建、领取、回写和取消接口。

#### 调研任务执行路径
1. D 域的 Gap Detector 或用户手工操作生成 `Research Task draft`，写入 Research Queue。
2. Research Planner 为任务补齐目标、范围、预算、优先级和推荐信息源，并决定进入 active 还是 silent 队列。
3. Queue Adapter 把可执行任务暴露给宿主执行器、外部检索工具或人工领取入口。
4. 执行器完成后，把结构化结果、原始引用和失败原因回写到 Research Task，并触发新的 Extraction Input。
5. K 管线重新接管回流结果，生成 Analysis Artifact 和正式 Knowledge Entry；若执行失败，则保留失败记录与重试建议，不污染主知识库。
6. W 通过 Activity API 和 Task Detail API 展示任务状态、预算消耗、回流结果和下一步操作。

#### 外部协议与接口风格
- 同步查询场景以 HTTP REST 或进程内函数接口承载。
- 异步阶段推进以事件流承载。
- 活动流与实时状态更新采用 SSE 或等价流式机制。
- 外部宿主能力通过 Adapter SPI 或 capability registration 暴露。
- 规则推送可用 Webhook、消息事件或宿主内信号机制承载。

#### 技术边界图
```text
[Browser / Workbench]
        │ HTTP + SSE
        ▼
[Web API Layer]
        │ internal service calls
        ▼
[KIVO Core]
  ├─ Pipeline Orchestrator
  ├─ Knowledge Store
  ├─ Retrieval Engine
  ├─ Conflict Resolver
  ├─ Graph & Insight Engine
  ├─ Rule Distribution Engine
  └─ Host Adapter Layer
        │
        ├─ Provider APIs
        ├─ Storage SPI
        ├─ File System
        └─ Host Events / Notifications
```

### 3.5 上下文中的关键边界决定
- KIVO 不等同于某个向量数据库封装层。
- KIVO 不等同于某个图数据库产品。
- KIVO 不把调研执行器写死在系统内部。
- KIVO 不把 Workbench 和 Core 混成一层。
- KIVO 不把规则订阅逻辑塞进普通知识检索流程。

---

## 4. 解决方案策略（Solution Strategy）

### 4.1 总体策略
KIVO 采用”核心知识平台 + 宿主适配层 + Workbench 消费层”的分层策略。
整体按以下结构组织：
- 一条事件驱动的知识管线，负责从输入走到入库和回流。
- 一套结构化知识存储与检索能力，负责长期保留与取用。
- 一层宿主适配机制，负责承接 Gateway、Provider、文件系统和调度能力。
- 一层 Workbench，负责面向人类用户的浏览、审核、探索和调研操作。
这套策略服务三个目标：让知识主干闭环先成立，让宿主可替换，让用户可直接使用。

### 4.2 关键架构决策
#### D-1 以 Knowledge Entry 为统一核心对象
所有消费面都围绕 Knowledge Entry 工作。
规则、调研任务、分析产物、冲突记录和图谱关系围绕它形成辅助对象。
这样可以避免每个入口各自产生一套近似但不兼容的数据语义。

#### D-2 提取管线拆成“分析产物生成”与“知识条目生成”两步
系统先产出 Analysis Artifact，再决定是否生成正式知识条目。
这样能提升可审计性，也给人工审核、低置信度拦截和调研建议生成留出稳定中间层。

#### D-3 所有写入路径统一进入冲突治理
手工录入、文档导入、网页抓取、对话提取、调研回流和批量导入都不能绕过冲突机制。
这样能把一致性从规则变成基础设施。

#### D-4 检索与规则分发双通道并存
知识检索解决“当前要知道什么”。
规则分发解决“当前必须遵守什么”。
二者消费时机、权限模型和更新频率不同，分开设计更稳。

#### D-5 宿主能力通过 Host Adapter 暴露
KIVO Core 只认抽象能力：文件读写、网络访问、LLM 调用、Embedding 生成、事件投递和通知发送。
OpenClaw 是首个适配目标，但不是唯一合法目标。

#### D-6 Workbench 与 Core 解耦
Workbench 通过 API 消费 Core，而不是直接操纵内部存储结构。
这样做能统一人类用户与 Agent 的业务语义，也有利于集中处理访问控制、审计和活动流。

#### D-7 图谱、缺口检测、调研形成后置增值链路
知识入库是主路径。
图谱、洞察、缺口报告和调研任务围绕主路径生长。
这样能保证最小运行模式成立，同时为高阶能力保留演进空间。

#### D-8 先支持单机闭环，再开放后端替换点
默认形态优先满足本地文件系统、轻量关系存储、可插拔向量能力和单 Node.js 进程运行。
后续如需扩展到外部存储、分布式执行器或更复杂的 Provider 编排，可在 SPI 边界后替换实现。

### 4.3 技术选型理由
#### Node.js 作为主运行时
理由：与 OpenClaw 宿主生态一致；适合 I/O 密集、事件驱动、接口聚合型系统；便于统一 Web API、后台管线和工具集成；对外发布和最小运行模式更友好。

#### OpenClaw 插件 / 适配器边界作为首发集成点
理由：当前业务就在 OpenClaw 体系内真实发生；宿主已有 Gateway、工具路由、工作区文件系统和外部协作能力；可把架构重点放在知识语义而不是重复造运行时。

#### HTTP REST + 事件流的双制式接口
理由：检索、详情、仪表盘适合同步请求；提取、图谱更新、活动流、调研任务生成适合异步流转；双制式接口能兼顾 Workbench、Agent 和宿主三类消费者。

#### 存储抽象层（Storage SPI）
理由：允许最小模式先跑在轻量本地存储上；为后续替换向量引擎、关系存储和图关系存储保留空间；避免上层逻辑被底层供应商特性反向塑形。

#### Provider Router / Capability Registry
理由：不同 Provider 的能力差异很大；KIVO 的核心能力依赖模型，但依赖方式不同；用 capability registry 管理模型能力，能把切换、降级和容错做成显式机制。

#### SSE 驱动 Workbench 活动流与实时状态
理由：活动流、调研状态、待确认项和冲突提醒有实时更新需求；SSE 比轮询更轻，部署成本也低，足够覆盖当前场景。

### 4.4 与 15 个功能域的映射关系
- 域 A 知识提取：落在输入适配层与分析管线入口，负责对话、文档、URL、规则文件和手工录入的进入方式。
- 域 B 知识存储与检索：落在 Knowledge Store 与 Retrieval Engine，负责条目持久化、版本管理、关系维护、Embedding 缓存和语义查询。
- 域 C 知识迭代：落在 Conflict Resolver 与 Lifecycle Manager，负责冲突检测、裁决策略、过期清理和合并回退。
- 域 D 自主调研：落在 Gap Detector、Research Planner 与 Host Adapter 协同边界，负责把知识缺口变成可执行调研任务并接收回流结果。
- 域 E 意图理解增强：落在 Retrieval Engine、Context Injector 与术语注入链路，负责给 Agent 提供贴近当前请求的上下文和消歧能力。
- 域 F 规则订阅与分发：落在 Rule Engine、Subscription Registry 与 Distribution Channel，负责规则注册、订阅匹配、推送确认和范围控制。
- 域 G 知识图谱与洞察：落在 Graph Engine 与 Insight Analyzer，负责关系图构建、结构洞察、图谱可视化支撑数据和缺口信号生成。
- 域 H 系统词典：落在 Terminology Registry 与 Prompt Injection Support，负责术语统一、冲突识别、生命周期管理和注入支持。
- 域 I 宿主适配层：落在 Host Adapter、Capability Registry 与 Provider Connector，负责宿主能力协商、Provider 管理与降级控制。
- 域 K 知识管线编排：落在 Pipeline Orchestrator，负责阶段顺序、阶段跳过、失败隔离、事件推进和扩展阶段注册。
- 域 L 分析中间产物：落在 Analysis Artifact Store 与 Review Queue，负责保存语义中间层，支撑审计、人工审核和后续消费。
- 域 M 知识域目标声明：落在 Domain Purpose Registry 与 Ranking / Research Constraints，负责给提取、检索、缺口检测和调研生成提供目标边界。
- 域 W 知识工作台：落在 Workbench Frontend 与 Web API Layer，负责人类使用面的仪表盘、列表、详情、活动流、调研、导入、字典和意图库。
- 域 X 访问控制与可观测性：横切整个系统，负责域访问控制、操作审计、指标采集、导入导出和聚合观察视图。
- 域 Z 开箱即用与商用就绪：横切安装、配置、Bootstrap、最小运行模式、文档交付和升级迁移，决定系统能否被外部用户直接使用。

### 4.5 策略收束
KIVO 用统一知识对象、事件驱动管线、宿主适配抽象和独立 Workbench，把分散的 Agent 知识转成可持续运营的知识系统。

---

## 5. 构建块视图（Building Block View）

### 5.1 Level 1：顶层模块分解

KIVO 的顶层构建块按 15 个功能域展开，但实现上按四层组织：输入与消费层、核心知识层、横切治理层、外部适配层。

```text
KIVO
├─ 输入与消费层
│  ├─ A 知识提取
│  ├─ W 知识工作台
│  └─ E 意图理解增强
├─ 核心知识层
│  ├─ B 知识存储与检索
│  ├─ C 知识迭代
│  ├─ D 自主调研
│  ├─ F 规则订阅与分发
│  ├─ G 知识图谱与洞察
│  ├─ H 系统词典
│  ├─ K 知识管线编排
│  ├─ L 分析中间产物
│  └─ M 知识域目标声明
├─ 横切治理层
│  ├─ X 访问控制与可观测性
│  └─ Z 开箱即用与商用就绪
└─ 外部适配层
   └─ I 宿主适配层
```

#### A. 知识提取（Knowledge Extraction）
- 职责：接收对话、文档、URL、规则文件和手工录入内容，归一化为 Extraction Input，并产出可追溯的 Source Reference。
- 接口：`submitConversation()`、`submitDocument()`、`submitUrl()`、`submitManualEntry()`。
- 依赖：K 管线编排、L 分析中间产物、I 宿主适配层、X 审计日志。

#### B. 知识存储与检索（Knowledge Store & Retrieval）
- 职责：管理 Knowledge Entry、版本、状态、向量、关联与查询计划，是所有知识消费路径的主存储中心。
- 接口：`saveEntry()`、`updateEntry()`、`queryKnowledge()`、`getEntryHistory()`、`findRelatedEntries()`。
- 依赖：C 知识迭代、G 图谱、H 系统词典、I Provider 管理、X 访问控制。

#### C. 知识迭代（Knowledge Iteration）
- 职责：检测冲突、处理合并、执行过期清理、管理 superseded 与 deprecated 状态。
- 接口：`detectConflicts()`、`resolveConflict()`、`mergeEntries()`、`deprecateEntry()`、`archiveEntry()`。
- 依赖：B 存储与检索、L 分析中间产物、I Provider 管理、X 审计与指标。

#### D. 自主调研（Autonomous Research）
- 职责：根据缺口报告生成调研任务、控制预算、接收回流结果，并把结果送回知识管线。
- 接口：`createResearchTask()`、`reprioritizeTask()`、`cancelTask()`、`ingestResearchResult()`。
- 依赖：G 图谱洞察、M 域目标声明、I 宿主适配层、W 调研管理界面。

#### E. 意图理解增强（Intent Enhancement）
- 职责：对 Agent 查询做语义解释、上下文筛选、术语注入与歧义提示，形成面向执行时的增强上下文。
- 接口：`prepareContext()`、`rankContextEntries()`、`injectTerminology()`、`suggestClarification()`。
- 依赖：B 检索、H 术语、M 域目标声明、X 权限裁剪。

#### F. 规则订阅与分发（Rule Subscription & Distribution）
- 职责：管理 Rule Entry、订阅关系、分发记录和确认状态，保证治理信息以独立通道传播。
- 接口：`registerRule()`、`subscribeRules()`、`pullRules()`、`pushRuleChange()`、`ackDistribution()`。
- 依赖：I 宿主事件能力、X 权限模型、W 规则相关配置页。

#### G. 知识图谱与洞察（Knowledge Graph & Insights）
- 职责：根据条目与关系维护图谱，识别孤立节点、桥接节点、稀疏社区和跨主题异常连接。
- 接口：`updateGraph()`、`listGraphNeighbors()`、`generateInsights()`、`exportGraphView()`。
- 依赖：B 关联关系、C 生命周期状态、D 调研任务生成、W 图谱可视化。

#### H. 系统词典（System Dictionary）
- 职责：统一术语名、定义、约束、正负例和别名，给意图增强和内容生成提供术语语义底座。
- 接口：`upsertTerm()`、`searchTerm()`、`injectTerms()`、`mergeTerms()`。
- 依赖：B 存储、C 冲突检测、E 上下文注入、W 系统字典管理。

#### I. 宿主适配层（Host Adapter）
- 职责：把 OpenClaw 或其他宿主暴露的文件、网络、Provider、事件、通知能力转成稳定 SPI。
- 接口：`registerHostCapabilities()`、`callProvider()`、`emitHostEvent()`、`readSource()`、`writeExport()`。
- 依赖：宿主环境本身；被 A、D、F、K、Z 多个域调用。

#### K. 知识管线编排（Knowledge Pipeline Orchestration）
- 职责：编排提取、分析、分类、冲突检测、合并、入库、图谱更新和缺口检测阶段。
- 接口：`startPipeline()`、`resumeStage()`、`registerStage()`、`recordStageFailure()`。
- 依赖：A、L、C、B、G、D、X。

#### L. 分析中间产物（Analysis Artifacts）
- 职责：保存提取过程中的断言候选、实体候选、冲突候选、缺口候选与审核候选，作为审计与人工介入入口。
- 接口：`saveArtifact()`、`loadArtifact()`、`approveCandidate()`、`rejectCandidate()`。
- 依赖：A 输入、K 管线、W 审核界面、X 审计日志。

#### M. 知识域目标声明（Domain Purpose）
- 职责：定义每个知识域的目标、关键问题、非目标和研究边界，约束提取、检索和调研方向。
- 接口：`getDomainPurpose()`、`rankAgainstPurpose()`、`validateResearchBoundary()`。
- 依赖：E 意图增强、D 调研、A 提取路由、W 意图库与域配置界面。

#### W. 知识工作台（Knowledge Workbench）
- 职责：向用户提供仪表盘、列表、详情、活动流、冲突裁决、调研管理、文档导入、系统字典与意图库。
- 接口：HTTP API、SSE 事件流、文件上传入口、管理操作入口。
- 依赖：B、C、D、G、H、L、X、Z。

#### X. 访问控制与可观测性（Access Control & Observability）
- 职责：统一处理 callerRole、域级权限、操作审计、指标采集、导入导出和故障可观测性。
- 接口：`authorizeDomainAccess()`、`recordMetric()`、`appendAuditLog()`、`exportKnowledgeSet()`。
- 依赖：横切所有域；底层依赖 I 提供的持久化和事件能力。

#### Z. 开箱即用与商用就绪（Out-of-Box & Commercial Readiness）
- 职责：管理安装校验、初始化引导、最小运行模式、配置检查、升级迁移和首次知识旅程。
- 接口：`runBootstrap()`、`runHealthCheck()`、`loadSeedData()`、`runMigration()`。
- 依赖：I 宿主适配、W 界面、X 审计、B 数据导入导出。

### 5.2 Level 2：核心模块内部结构

#### 5.2.1 Knowledge Entry Management

```text
Knowledge Entry Management
├─ Entry Factory
├─ Schema Validator
├─ Version Manager
├─ Lifecycle Manager
└─ Link Maintainer
```

##### Entry Factory
- 职责：把 Analysis Artifact、手工录入或调研结果转换为统一的 Knowledge Entry 草稿。
- 接口：`buildDraftFromArtifact()`、`buildDraftFromManualInput()`。
- 依赖：L 分析中间产物、M 域目标声明。

##### Schema Validator
- 职责：校验类型、状态、来源引用、metadata 扩展和领域约束，阻止脏数据进入主库。
- 接口：`validateEntry()`、`validateMetadataExtension()`。
- 依赖：B 存储模型、H 术语约束、X 访问控制规则。

##### Version Manager
- 职责：维护版本号、变更摘要、supersedes 关系和乐观锁字段 `expectedVersion`。
- 接口：`createNextVersion()`、`diffVersions()`、`checkOptimisticLock()`。
- 依赖：B 持久化、C 冲突治理。

##### Lifecycle Manager
- 职责：驱动 pending、active、superseded、deprecated、archived 的状态流转。
- 接口：`activateEntry()`、`supersedeEntry()`、`deprecateEntry()`、`archiveEntry()`。
- 依赖：C 过期清理、W 条目操作、X 审计日志。

##### Link Maintainer
- 职责：维护 supplements、supersedes、conflicts、depends_on 等关系，并把关系同步给图谱。
- 接口：`linkEntries()`、`unlinkEntries()`、`syncGraphEdges()`。
- 依赖：G 图谱、C 合并策略、B 检索索引。

#### 5.2.2 Intent Routing & Context Injection

这里的“意图路由”指用户请求进入 KIVO 后，系统决定该请求落入哪个知识域、调用哪种检索策略、是否触发澄清。

```text
Intent Routing & Context Injection
├─ Query Analyzer
├─ Domain Selector
├─ Retrieval Planner
├─ Context Packager
└─ Clarification Advisor
```

##### Query Analyzer
- 职责：解析查询文本、识别任务类型、抽取时间/来源/知识类型过滤条件。
- 接口：`analyzeQuery()`。
- 依赖：H 术语注册表、M 域目标声明。

##### Domain Selector
- 职责：根据 query、callerRole 与 domain purpose 选择优先知识域，并执行域外裁剪。
- 接口：`selectDomains()`、`pruneOutOfScopeEntries()`。
- 依赖：M 域目标声明、X 访问控制。

##### Retrieval Planner
- 职责：决定走语义检索、元数据检索还是混合检索；在 Provider 不可用时切到降级路径。
- 接口：`buildQueryPlan()`、`fallbackToKeywordMode()`。
- 依赖：B 检索引擎、I Provider Registry。

##### Context Packager
- 职责：把返回条目压缩成 token 预算内的上下文包，优先保留术语、近期决策和高置信事实。
- 接口：`packageContext()`、`rankByBudget()`。
- 依赖：B 检索结果、H 术语注入、C 生命周期状态。

##### Clarification Advisor
- 职责：在高歧义查询下返回澄清建议，避免系统强行猜测。
- 接口：`suggestClarification()`、`explainWhyAmbiguous()`。
- 依赖：E 历史偏好、B 检索结果、M 关键问题集。

#### 5.2.3 Rule Subscription & Distribution

```text
Rule Subscription & Distribution
├─ Rule Registry
├─ Subscription Matcher
├─ Delivery Coordinator
└─ Distribution Ledger
```

##### Rule Registry
- 职责：保存 Rule Entry 正文、适用范围、优先级、生效条件和失效条件。
- 接口：`createRule()`、`updateRule()`、`listRulesByScope()`。
- 依赖：B 持久化、C 规则冲突检测。

##### Subscription Matcher
- 职责：根据 agent、角色、域和场景，计算某次规则变更影响的订阅者集合。
- 接口：`matchSubscribers()`、`refreshSubscriptions()`。
- 依赖：X 权限模型、I 宿主 Agent 元数据。

##### Delivery Coordinator
- 职责：执行拉取优先、推送补充的分发策略；对高优先级规则触发主动通知。
- 接口：`pushRuleChange()`、`prepareRulePullSnapshot()`。
- 依赖：I 宿主事件能力、W 管理界面。

##### Distribution Ledger
- 职责：记录送达目标、目标版本、确认状态、失败原因和重试次数。
- 接口：`recordDelivery()`、`recordAck()`、`listUndeliveredRules()`。
- 依赖：X 审计和指标、F 重试策略。

#### 5.2.4 Pipeline Orchestrator

```text
Pipeline Orchestrator
├─ Stage Registry
├─ Event Router
├─ Failure Isolator
└─ Progress Tracker
```

##### Stage Registry
- 职责：注册提取、审核、冲突检测、入库、图谱更新、缺口检测、调研回流等阶段，并声明前后置依赖与可跳过条件。
- 接口：`registerStage()`、`resolveStagePlan()`、`listEnabledStages()`。
- 依赖：Z 最小运行模式配置、I 宿主能力、X 审计日志。

##### Event Router
- 职责：在阶段之间传递 `pipelineId`、事件载荷和上下文状态，保证同一条知识管线按确定顺序推进。
- 接口：`dispatchStageEvent()`、`resumeFromCheckpoint()`、`fanOutPostCommitEvents()`。
- 依赖：A 输入层、L 分析中间产物、B 主存储、G 图谱、D 调研。

##### Failure Isolator
- 职责：把局部失败限制在当前阶段或当前条目，防止一条低质量输入拖垮整批导入或其他并发任务。
- 接口：`quarantineFailedStage()`、`markRetryableFailure()`、`openManualReviewPath()`。
- 依赖：X 指标与告警、W 审核界面、I 宿主任务能力。

##### Progress Tracker
- 职责：记录阶段开始、结束、耗时、重试次数和当前状态，为活动流、审计和恢复执行提供统一真相源。
- 接口：`startStage()`、`completeStage()`、`snapshotPipeline()`。
- 依赖：X 审计日志、W 活动流、Z 首次知识旅程引导。

#### 5.2.5 Conflict Resolver

```text
Conflict Resolver
├─ Candidate Screener
├─ Semantic Judge
├─ Strategy Selector
└─ Rollback Guard
```

##### Candidate Screener
- 职责：对新条目做 embedding 粗筛、主题聚类和元数据预过滤，缩小需要精判的候选冲突集合。
- 接口：`screenCandidates()`、`scoreTopicOverlap()`、`dropIrrelevantPairs()`。
- 依赖：B 检索索引、H 术语约束、I Embedding Provider。

##### Semantic Judge
- 职责：对候选冲突对执行语义精判，区分互斥、补充、改写、时间先后和表述差异。
- 接口：`judgeConflict()`、`classifyContradictionType()`、`explainDecision()`。
- 依赖：I LLM Provider、L Analysis Artifact、B 历史版本。

##### Strategy Selector
- 职责：根据冲突类型、来源权重、时间新鲜度和 callerRole 选择自动合并、保留并存、人工裁决或延迟处理策略。
- 接口：`selectResolutionStrategy()`、`rankSourceAuthority()`、`decideAutoMerge()`。
- 依赖：M 域目标声明、X 权限与审计、W 冲突裁决界面。

##### Rollback Guard
- 职责：在自动裁决或合并后保留可恢复快照，发现误判时能回退到上一个稳定版本。
- 接口：`createResolutionCheckpoint()`、`rollbackResolution()`、`replayConflictFlow()`。
- 依赖：B Version Manager、X 审计日志、G 图谱关系同步。

### 5.3 构建块之间的主依赖关系

- A 只负责把来源送进 K，不直接写主库。
- K 是主干调度器，驱动 A → L → C → B → G → D 的事件链。
- B 是知识资产中心，E、G、H、W 都通过 B 消费知识，而不是直接读原始来源。
- C 管状态和冲突，所有写入路径都要经过它。
- F 与 E 分离：F 管必须遵守的规则，E 管当前需要知道的知识。
- I 提供能力边界，避免 Core 直接粘在 OpenClaw 运行时细节上。
- X 和 Z 横切所有层，分别管治理质量与可交付性。

---

## 6. 运行时视图（Runtime View）

### 6.1 场景一：知识条目的完整生命周期

#### 触发
用户上传文档、标记对话片段、提交 URL，或调研任务回流结果。

#### 运行时交互
1. 输入先进入 A 域，生成统一的 Source Reference。
2. K 启动新的 pipeline instance，写入 `pipelineId` 和阶段状态。
3. L 生成 Analysis Artifact，提取断言、实体、概念、候选关联、候选冲突和候选缺口。
4. 若分析置信度过低，artifact 进入审核队列，条目暂不生成。
5. Entry Factory 从 artifact 生成 Knowledge Entry draft。
6. Schema Validator 校验类型、来源、domain、metadata 扩展。
7. C 的 Conflict Resolver 做粗筛：按 embedding 相似度或元数据主题找候选冲突对。
8. 若 Provider 可用，进入语义精判；若不可用，保留候选冲突并标记待补判。
9. 无冲突时，B 保存新条目并生成版本号；有冲突时，按时间优先、来源优先或人工裁决流继续。
10. Link Maintainer 建立 supplements、supersedes、depends_on、conflicts 等关系。
11. G 基于新条目和关系更新图谱局部子图。
12. D 读取新增条目后的图谱与查询未命中信号，判断是否形成新缺口。
13. X 记录整条链路的审计日志、指标和耗时。
14. W 的活动流收到事件，用户可在界面里看到“导入完成”“待确认”“冲突待裁决”等状态。
15. 后续若条目长时间未被引用或被外部验证为过时，C 把它从 active 转为 deprecated，再在清理周期后归档。

#### 结果
- 正常路径：条目进入 active，可检索、可关联、可注入。
- 低置信路径：条目进入 pending，等待人工确认。
- 冲突路径：生成 Conflict Record，并暂停到裁决完成。
- 过时路径：条目退出主检索结果，但历史版本仍可追踪。

### 6.2 场景二：意图路由的请求处理流程

#### 触发
Agent 在处理用户请求前调用 `prepareContext()` 或直接发起 `queryKnowledge()`。

#### 运行时交互
1. E 的 Query Analyzer 解析查询文本，提取关键词、语义主题、时间限定、知识类型限定和 domain 候选。
2. X 根据 callerRole 裁剪可访问知识域。
3. Domain Selector 结合 M 的域目标声明，选出优先查询域与排除域。
4. Retrieval Planner 判断当前 Provider 能力：
   - 有 embedding 能力：走混合检索。
   - 无 embedding 能力：走关键词 + 元数据过滤降级路径。
5. B 执行检索，返回候选条目、相关度评分、来源、版本状态和图谱邻居摘要。
6. H 查询与当前主题高度相关的术语条目，按 scope 和 token 预算裁剪。
7. Context Packager 组装上下文包：术语 → 最新决策 → 高置信事实 → 相关经验 → 补充方法。
8. 如果结果分散且置信度低，Clarification Advisor 返回澄清建议，例如“你要的是安装路径，还是迁移策略”。
9. E 把最终上下文包返回给 Agent，Agent 再进入自己的任务执行流程。
10. 若本次查询未命中或结果质量低，X 记录 miss 信号，D 后续可把它纳入缺口检测。

#### 结果
- 命中路径：Agent 获得按预算压缩后的高相关上下文。
- 降级路径：返回结果带有 `degraded=true` 标记，便于上层知道当前依赖关键词检索。
- 歧义路径：系统优先返回澄清建议，不直接给出高风险结论。

### 6.3 场景三：规则订阅的触发与分发

#### 触发
治理文件变更、手工新增 Rule Entry，或已有规则的优先级与适用范围变化。

#### 运行时交互
1. A 的规则提取入口接收到 AGENTS.md、SOUL.md 或规则配置变更。
2. L 产出规则类分析结果，提取规则正文、作用域、优先级、前置条件和覆盖关系候选。
3. F 的 Rule Registry 创建新版本 Rule Entry。
4. C 检查规则冲突：同一场景下是否出现相互矛盾的约束。
5. Subscription Matcher 计算受影响的订阅者集合，依据包括 agentId、角色、域、场景标签。
6. Delivery Coordinator 判断分发方式：
   - 普通规则：下一次拉取时获取。
   - 高优先级规则：立即推送通知。
7. I 通过宿主事件能力把变更送到目标 Agent 或共享快照存储。
8. Distribution Ledger 记录本次分发的目标版本、成功数、失败数、未确认数。
9. 目标 Agent 启动时或收到事件后执行 `pullRules()`，并回写确认状态。
10. 若超过重试阈值仍未确认，X 触发告警并在 Workbench 活动流中显示异常。

#### 结果
- 规则可追溯地送达到订阅者。
- 失败分发不会污染普通知识检索路径。
- 用户能在 Workbench 里看到哪些 Agent 还未拿到新规则版本。

### 6.4 场景四：知识质量审计流程

#### 触发
定时审计、用户主动发起审计、升级前自检，或某个域连续出现检索未命中与冲突堆积。

#### 运行时交互
1. W 发起“运行知识审计”操作，或系统按计划触发 Audit Job。
2. X 聚合近一段时间的核心信号：检索命中率、pending 数量、冲突积压、分发失败、图谱孤立节点占比。
3. 审计器按域扫描 B 中的条目状态，检查是否存在：
   - 无来源引用的 active 条目。
   - 长期 pending 未处理条目。
   - superseded 关系断裂。
   - deprecated 但仍频繁被注入的条目。
4. G 输出结构洞察，识别近期新增但未形成关联的知识簇。
5. D 根据审计缺口生成候选调研任务，但默认先进入建议态，不直接抢占资源执行。
6. 审计结果汇总成 Audit Report，按问题类型分级：P0 数据一致性、P1 检索有效性、P2 可观测性、P3 体验问题。
7. W 展示可操作清单，用户可直接进入冲突裁决、条目清理、调研创建或规则修复。
8. X 把审计结论写入审计日志，用于后续趋势分析。

#### 结果
- 系统知道知识库“有没有东西”，也知道“这些东西好不好用”。
- 审计输出直接联动修复动作，不停留在静态报告。

### 6.5 场景五：首次知识旅程

#### 触发
外部陌生用户首次打开空库环境，系统已经完成安装与基础配置校验。

#### 运行时交互
1. Z 的 `runBootstrap()` 检查 workspace 可写、存储 schema 就绪、文本 LLM 可用、Workbench basePath 正常。
2. W 渲染空库首页，展示“上传文档”“导入示例数据”“手动新建知识”三个入口和系统就绪度清单。
3. 用户选择任一入口后，A 把输入转换成统一的 Extraction Input，并为这次首次旅程打上 `journey=first-run` 标记。
4. K 创建新的 pipeline instance，Progress Tracker 把当前进度同步到 Activity Stream。
5. L 生成首批 Analysis Artifact，若结果置信度过低，则把候选项送入 Pending Queue，并在界面提示用户先确认一条示例知识。
6. C 执行最小冲突检查，避免示例数据或首次导入内容和已存在种子数据重复冲突。
7. B 保存首批 active 条目，并在必要时为缺失 embedding 的条目标记待补建索引。
8. G 为首批条目建立基础关系，生成可浏览的最小知识子图。
9. W 自动跳转到知识列表或刚导入条目的详情页，给出一次预填的搜索建议。
10. 用户执行第一次检索，E 调用 Query Analyzer、Domain Selector 和 Retrieval Planner 生成查询计划。
11. B 返回命中结果后，W 在结果页展示来源、类型、状态和关联摘要；若未命中，则 Z 提供下一步动作建议，而不是空白页。
12. X 记录首次知识旅程耗时、卡点阶段和成功率，供后续引导优化使用。

#### 结果
- 成功路径：用户在 10 分钟内完成首次导入、看到结果并完成第一次检索命中。
- 待确认路径：系统仍能给出明确下一步动作，用户不会卡在空库状态。
- 降级路径：当 embedding 或实时能力缺失时，系统显式提示当前运行在最小模式，但核心旅程仍可完成。

---

## 7. 部署视图（Deployment View）

### 7.1 OpenClaw 插件部署拓扑

```text
┌────────────────────────────────────────────┐
│ Browser / Workbench Client                │
│  - Dashboard / Search / Graph / Review    │
└────────────────────┬──────────────────────┘
                     │ HTTP + SSE
┌────────────────────▼──────────────────────┐
│ OpenClaw Gateway                           │
│  - Plugin host                             │
│  - API routing                             │
│  - Session / tool mediation                │
└────────────────────┬──────────────────────┘
                     │ in-process calls / plugin events
┌────────────────────▼──────────────────────┐
│ KIVO Plugin Runtime                        │
│  - Web API layer                           │
│  - Pipeline orchestrator                   │
│  - Knowledge store                         │
│  - Retrieval / Rule / Graph / Research     │
└───────────────┬───────────────┬────────────┘
                │               │
      file I/O  │               │ provider calls
                │               │
┌───────────────▼───────┐   ┌───▼────────────────┐
│ Workspace Storage      │   │ LLM / Embedding    │
│ - knowledge data       │   │ Providers          │
│ - artifacts            │   │ - text generation  │
│ - audit logs           │   │ - structured output│
│ - exports / imports    │   │ - embeddings       │
└───────────────┬───────┘   └────────────────────┘
                │
        optional host events / notifications
                │
        Feishu / Webhook / task executor
```

### 7.2 运行时节点说明

#### 节点 1：Workbench Client
- 形态：浏览器中的单页或多页 Web 应用。
- 职责：展示仪表盘、搜索、图谱、审核、调研、系统字典和活动流。
- 约束：只通过 HTTP API 和 SSE 与后端通信，不直接触碰底层知识文件。

#### 节点 2：OpenClaw Gateway
- 形态：宿主守护进程或服务进程。
- 职责：承载插件生命周期、路由 API、暴露宿主能力、连接消息与工具体系。
- 约束：KIVO 必须遵守插件边界，不能把宿主内部状态结构硬编码进 Core。

#### 节点 3：KIVO Plugin Runtime
- 形态：Node.js 进程内插件模块，首发以单进程部署。
- 职责：承载 Web API、核心知识服务、事件管线、规则分发、调研任务定义与图谱更新。
- 约束：需要在单机资源下跑通最小闭环，避免强依赖外部重型服务。

#### 节点 4：Workspace Storage
- 形态：本地文件系统 + 轻量结构化存储。
- 职责：保存知识条目、分析产物、导入导出包、图谱缓存、审计日志、迁移状态。
- 约束：路径布局要稳定，便于备份、迁移和离线恢复。

#### 节点 5：LLM / Embedding Providers
- 形态：外部 API 或宿主接入的 Provider。
- 职责：承担结构化提取、冲突精判、意图消歧、embedding 生成。
- 约束：能力可能缺失或波动，KIVO 需要 capability registry 和降级逻辑。

#### 节点 6：外部协作与执行节点
- 形态：Feishu、Webhook 接收端、宿主任务执行器、外部检索工具。
- 职责：承接通知、执行调研任务、消费导出结果。
- 约束：这些节点不保存主知识库真相，只消费或反馈事件。

### 7.3 部署变体

#### 最小运行模式（standalone）
- 一个 OpenClaw Gateway。
- 一个 KIVO Plugin Runtime。
- 一个本地存储目录。
- 一个文本 LLM Provider。
- Embedding Provider 可选；缺失时降级为关键词检索。

#### 宿主嵌入模式（embedded）
- KIVO 作为宿主插件存在。
- 调研执行、消息通知、权限身份由宿主提供。
- KIVO Core 通过 Host Adapter 消费这些能力。

#### 扩展模式（full-stack）
- Workbench 可独立部署在前端静态托管或 Node Web 服务中。
- KIVO API 与 Core 仍以单逻辑边界存在。
- 存储、检索、图谱引擎可在 SPI 后替换，但上层 API 语义不变。

### 7.4 运行时依赖

#### Node.js
- 作为主运行时，承担 HTTP API、事件编排、文件 I/O 和 Provider 调用。
- 需要稳定的异步模型和足够的内存容纳检索缓存、图谱局部更新和活动流连接。

#### 文件系统
- 承载导入源、知识数据、artifact、导出包、迁移脚本状态和审计日志。
- 需要可写路径、备份策略和权限隔离。

#### LLM Provider
- 负责结构化提取、冲突精判、歧义判断和调研结果规整。
- 需要支持超时、重试、失败分类与替补策略。

#### Embedding Provider
- 负责语义向量生成与缓存。
- 缺失时系统仍可用，但检索质量下降，且需要在 UI 与 API 中显式暴露降级状态。

#### OpenClaw 宿主能力
- 提供插件生命周期、任务环境、工具转发、消息通道和共享 workspace。
- 在嵌入模式下，调研执行与规则通知高度依赖这一层。

---

## 8. 横切概念（Crosscutting Concepts）

### 8.1 知识条目的统一数据模型

KIVO 的核心数据对象是 Knowledge Entry。所有上层功能都围绕它，而不是围绕原始文档或会话片段。

#### Knowledge Entry 核心字段
- `id`：全局唯一标识。
- `type`：fact、methodology、decision、experience、intent、meta。
- `domain`：知识域归属，用于权限与目标约束。
- `title`：面向人类阅读的简短标题。
- `content`：结构化正文或摘要正文。
- `status`：pending、active、superseded、deprecated、archived。
- `version`：整型或语义版本号，配合 `expectedVersion` 支持乐观锁。
- `sources[]`：来源引用数组，可指向对话、文件、URL、规则文件、调研产物。
- `relations[]`：与其他条目的结构化关系。
- `embedding`：条目的语义向量引用或内联缓存。最小模式下可直接挂在条目记录中；扩展模式下也可只保存 `embeddingRef`、向量维度、模型版本和最后更新时间，把大向量内容交给独立索引区管理。
- `metadata`：领域扩展字段，承载术语、规则、审计标签、图谱权重等专属信息。
- `createdAt / updatedAt`：时间戳。
- `confidence`：提取或判定置信度。

#### 同族对象与差异
- Rule Entry：治理对象，生命周期与订阅范围优先于正文内容长度。
- Analysis Artifact：中间对象，强调可追溯和可审计，不直接参与主检索。
- Conflict Record：关系对象，连接两个或多个条目，记录冲突类型、裁决过程与结论。
- Research Task：执行对象，记录目标、预算、状态、回流结果。
- Domain Purpose：约束对象，影响提取、排序和调研范围。

#### 数据模型原则
- 一个条目表达一个可独立判断的知识断言。
- 原文放在来源引用中，知识库存结构化结果。
- 版本变更保留历史，不做静默覆盖。
- 领域差异走 `metadata` 扩展，不拆出彼此隔离的主表语义。

### 8.2 错误处理策略

#### 错误分类
- 输入错误：文件格式错误、缺字段、非法状态流转、权限不足。
- 管线错误：某阶段执行失败、阶段超时、上下游依赖未准备好。
- Provider 错误：超时、限流、结构化输出不合法、能力缺失。
- 存储错误：写入失败、版本冲突、索引补建失败、迁移失败。
- 分发错误：规则送达失败、确认超时、事件通知失败。

#### 处理原则
- 能局部失败的地方不拖垮整条系统主路径。
- Analysis Artifact 优先落盘，保证失败后还能复盘。
- 写入前校验，写入后审计，避免坏数据长期留存。
- 降级状态必须显式暴露，不能在检索质量下降时伪装成正常结果。
- 对用户可操作的错误返回恢复动作；对系统内部错误返回诊断上下文。

#### 常见恢复路径
- Embedding 失败：条目先入库，标记待补建索引。
- 冲突精判失败：保留候选冲突并进入待裁决或待补判队列。
- 调研执行失败：Research Task 标记失败，不回滚已有知识库。
- 规则推送失败：保留拉取快照路径，并持续记录未确认状态。
- 迁移失败：停止升级并允许回滚到迁移前快照。

### 8.3 日志与可观测性

#### 审计日志
- 记录条目创建、更新、状态变更、冲突裁决、规则分发、调研任务流转和管理员操作。
- 关键字段包含 actor、target、before、after、timestamp、requestId、pipelineId。

#### 指标
- 检索命中率、检索响应时间、降级查询占比。
- pending 条目数量、冲突积压量、冲突解决时长。
- 规则分发成功率、未确认规则数量。
- 图谱孤立节点比例、桥接节点数量变化。
- 调研任务创建数、成功率、预算超支率。

#### 追踪
- 单次导入或调研回流都带 `pipelineId`。
- 用户界面操作与后端事件共享 `requestId`。
- Provider 调用保留 `providerId` 与能力标签，便于排查某家模型的结构化输出问题。

#### 活动流
- 活动流是面向用户的观测视图，不是底层日志的简单原样转发。
- 同一批导入会按业务事件聚合，例如“导入完成 18 条，3 条待确认，1 条待裁决”。

### 8.4 安全与隐私

#### 访问控制
- 所有查询都带 callerRole 或等价身份信息。
- 域级权限优先于检索相关度，先裁剪可见范围，再做排序。
- 规则分发遵循订阅范围，不能越域推送。

#### 数据最小化
- 原始文档不默认长期保存；知识提取完成后按策略清理。
- 上下文注入只返回当前任务需要的最小知识集合。
- 导出遵守筛选范围与权限边界。

#### 来源可信度
- 高置信 active 条目应具有可追溯来源。
- 无来源或低置信内容保持 pending，不直接进入长期稳定知识。

#### 宿主隔离
- KIVO Core 不直接读取宿主私有状态文件格式，统一经 Host Adapter。
- 对外 Provider 密钥与宿主身份信息不进入知识条目正文。

### 8.5 版本与迁移

- 文档、规则、术语、知识条目都采用可追溯版本语义。
- 数据结构变更附带迁移脚本和格式版本号。
- 导入导出包必须包含 schema version，防止跨版本静默损坏。

---

## 9. 架构决策记录（Architecture Decisions）

### ADR-001：以 Knowledge Entry 作为统一核心对象

#### Context
KIVO 同时处理事实、方法、经验、意图、规则、调研结果和术语。若每类对象各自形成主存储模型，检索、权限、版本和活动流都会出现重复实现。

#### Decision
以 Knowledge Entry 作为统一知识对象；Rule Entry、术语条目等特殊对象在统一模型上扩展字段；Conflict Record、Analysis Artifact、Research Task 作为配套对象围绕它建立关系。

#### Consequences
- 检索、版本、状态机、权限裁剪可以复用一套主路径。
- 数据模型更稳定，便于导入导出和迁移。
- `metadata` 扩展设计会承受较高复杂度，需要严格 schema 校验。

### ADR-002：采用“分析产物先行”的两段式提取

#### Context
直接从原始输入生成正式知识条目，容易把误提取、低置信候选和未解释的冲突一起写进主库，后续难以复盘。

#### Decision
提取过程拆成两步：先生成 Analysis Artifact，再从 artifact 生成 Knowledge Entry。高置信路径自动继续，低置信路径进入人工审核。

#### Consequences
- 审计能力增强，提取错误可定位到分析阶段。
- 用户可以看到候选项，而不是只能接受最终结果。
- 存储与界面复杂度上升，需要额外维护 artifact 生命周期。

### ADR-003：通过 Host Adapter + Capability Registry 解耦宿主能力

#### Context
KIVO 首发部署在 OpenClaw 内，但产品边界要求未来可以迁移到其他宿主。宿主之间的文件、消息、工具和 Provider 接口差异很大。

#### Decision
KIVO Core 只依赖抽象能力：文件读写、网络访问、Provider 调用、事件投递、通知发送。具体宿主通过 Host Adapter 注册能力，Capability Registry 记录可用性与版本约束。

#### Consequences
- Core 可以在不同宿主间迁移，复用率高。
- 宿主能力变化时可做显式降级。
- 适配层需要长期维护稳定契约，早期设计必须克制，避免抽象过度。

### ADR-004：检索与规则分发分成双通道

#### Context
知识检索服务“当前要知道什么”，规则分发服务“当前必须遵守什么”。二者在时效性、权限边界、失败恢复和用户预期上差异明显。

#### Decision
把 Rule Entry、订阅关系和分发记录从普通知识检索路径中拆出，形成独立规则通道；普通知识查询不承担规则送达责任。

#### Consequences
- 治理信息与内容信息边界更清楚。
- 规则送达失败不会影响知识检索可用性。
- 系统多了一套分发台账与确认机制，实现成本上升。

### ADR-005：首发采用单进程事件驱动架构，SPI 后保留替换点

#### Context
当前研发组织是 solo founder + AI agents，运维成本要低，最小运行模式要能单机启动。过早拆成多服务会把复杂度提前释放。

#### Decision
首发使用单个 Node.js 插件运行时承载 Web API、管线编排、检索、图谱和规则分发；存储、检索和图谱引擎通过 SPI 预留替换点。

#### Consequences
- 安装与调试成本低，符合开箱即用目标。
- 在万级条目以上可能面临单进程内存和并发压力。
- 后续扩展仍有出路，但需要谨慎管理模块边界，防止单进程内部耦合失控。

### ADR-006：图谱计算本地优先，外部图数据库作为后续替换点

#### Context
KIVO 需要知识图谱来支撑关系浏览、结构洞察和缺口检测，但首发阶段的数据规模、部署门槛和运维复杂度都不适合强绑外部图数据库。

#### Decision
首发把图谱关系、局部邻居查询和洞察计算放在本地存储与内存索引中完成；仅在规模、并发或算法复杂度超过单机边界后，再通过 Graph SPI 接入外部图数据库。

#### Consequences
- 最小运行模式更轻，外部用户安装门槛低。
- 早期图谱语义和对象模型可以先稳定下来，不被具体产品特性绑架。
- 高阶遍历、复杂子图分析和跨项目图谱联邦会受限，需要为后续升级预留兼容层。

### ADR-007：活动流与实时状态更新使用 SSE

#### Context
Workbench 需要把导入进度、冲突待裁决、调研状态和系统活动流实时推给用户。轮询会增加无效请求，WebSocket 在当前场景里又偏重。

#### Decision
Workbench 实时通道默认采用 SSE。服务端按用户会话或工作台视图维度输出单向事件流，客户端在断线后自动重连，并通过最近事件游标补齐缺失事件。

#### Consequences
- 部署简单，和 HTTP 路由体系一致，适合单进程首发架构。
- 活动流、任务进度和待处理提醒可以共享同一事件模型。
- 长连接数量会上升，需要连接上限、心跳和回放窗口治理。

### ADR-008：SQLite 作为最小模式默认存储

#### Context
KIVO 需要一个外部用户开箱即用的默认存储方案，既要支持结构化查询、事务、版本追踪和迁移，又不能要求用户先部署独立数据库。

#### Decision
最小模式默认使用 SQLite 承载 Knowledge Entry、Research Task、Rule Entry、审计日志和迁移状态；文件系统继续承载原始导入内容、导出包和大体积 artifact。后续如需升级，可通过 Storage SPI 切换到更强的关系存储。

#### Consequences
- 安装成本低，备份和迁移简单，符合 standalone 路径。
- 单机事务和 schema migration 能力足够覆盖首发需求。
- 高并发写入、超大数据集和多实例共享访问会受到限制，需要在扩展模式下替换实现。

### ADR-009：术语条目复用 Knowledge Entry

#### Context
术语域需要定义术语、别名、正例、负例和适用域。如果单独设计一套完全不同的主模型，检索、版本、权限和活动流又会重复一遍。

#### Decision
术语条目沿用 Knowledge Entry 作为主对象，类型仍归入统一模型，通过 `domain=H` 与 `metadata.terminology` 扩展保存别名、禁用表述、正负例和注入范围。

#### Consequences
- 术语可以直接复用版本管理、冲突治理、权限裁剪和审计链路。
- 意图增强、检索和 Prompt 注入都能共享同一条读取路径。
- `metadata` 子 schema 需要更严格校验，避免把术语专属字段污染到其他知识域。

### ADR-010：Workbench 前端采用 React + Vite + Zustand

#### Context
Workbench 需要同时承载列表检索、活动流、图谱浏览、审核队列和调研管理，交互密度高，页面状态跨度大，还要兼顾 standalone 与嵌入模式的快速交付。

#### Decision
Workbench 前端采用 React 作为 UI 框架，Vite 作为构建工具，Zustand 作为客户端状态管理层。路由、数据获取和可视化库保持可替换，但默认围绕这三项搭建首发工程骨架。

#### Consequences
- React 生态成熟，适合快速搭建高交互工作台和组件化审核界面。
- Vite 冷启动快、构建简单，适合插件内开发和外部用户本地启动。
- Zustand 适合活动流、筛选条件、当前条目、图谱视图这类局部共享状态，复杂度低于重型全局状态框架。
- 若后续出现更强的离线协同或复杂缓存一致性需求，需要在数据层增加更稳的查询缓存与同步机制。

---

## 10. 质量要求（Quality Requirements）

### 10.1 质量树

#### 一致性（最高优先级）
- 所有写入路径进入统一冲突治理。
- 版本关系可追溯。
- 条目状态流转可审计。

#### 检索有效性
- 检索命中率稳定。
- 检索结果可解释，含来源、类型、相关度和版本语义。
- Provider 降级时仍能返回可用结果。

#### 宿主解耦
- 核心逻辑不依赖私有宿主 API。
- 存储与检索引擎可替换。
- 宿主能力变化后系统进入可解释降级。

#### 可治理性
- 活动流、审计日志、指标和导出能力完整。
- 用户能直接处理 pending、冲突、缺口和失败分发。

#### 开箱即用
- 安装、初始化、首次导入与首次检索可在短时间内跑通。
- 最小运行模式成立。
- 错误提示给出恢复动作。

#### 安全与权限
- 域级访问控制可靠。
- 敏感知识不会越域泄露。
- 调研任务遵守授权范围。

### 10.2 质量场景

#### QS-01：知识检索性能（对应 NFR-5.1）
- 刺激：Agent 在 1000 条知识规模下发起语义检索。
- 环境：正常 Provider 可用，标准单机环境。
- 期望响应：P95 响应时间不超过 2 秒。
- 验证点：包含检索耗时、排序阶段耗时和上下文打包耗时。

#### QS-02：异步提取不阻塞主任务（对应 NFR-5.2）
- 刺激：用户上传一份长文档，同时 Agent 继续处理对话任务。
- 环境：文档需要分段提取。
- 期望响应：提取在后台异步执行，前台任务不中断。
- 验证点：上传请求快速返回任务状态，活动流持续更新进度。

#### QS-03：规则分发时效（对应 NFR-5.3）
- 刺激：管理员更新一条高优先级规则。
- 环境：目标 Agent 已订阅相关 scope。
- 期望响应：30 秒内目标 Agent 可通过主动拉取或被动推送获取新版本。
- 验证点：Distribution Ledger 可看到送达与确认时间。

#### QS-04：图谱增量更新（对应 NFR-5.4）
- 刺激：一条新知识入库并建立两条关联。
- 环境：图谱已有 1000 节点规模。
- 期望响应：5 秒内图谱查询可见新节点和新边。
- 验证点：Workbench 图谱与 Insight API 一致。

#### QS-05：冲突检测无绕过（对应 NFR-5.7）
- 刺激：分别从手工录入、文档导入、调研回流三条路径写入相互矛盾内容。
- 环境：存在同一主题的 active 条目。
- 期望响应：三条路径都生成候选冲突对，且不会直接静默覆盖旧条目。
- 验证点：Conflict Record 与审计日志完整。

#### QS-06：Provider 不可用时的降级（对应 NFR-5.19、FR-B04 AC4）
- 刺激：Embedding Provider 故障。
- 环境：文本 LLM 仍可用，或文本 LLM 也短暂不可用。
- 期望响应：系统继续支持元数据过滤或关键词检索，并明确返回降级状态。
- 验证点：API 响应带降级标记，Workbench 显示恢复提示。

#### QS-07：域级权限保护（对应 NFR-5.14）
- 刺激：低权限调用方请求一个高敏感知识域中的条目。
- 环境：查询文本与敏感条目高度相关。
- 期望响应：结果中不返回该域条目，也不在摘要、术语和活动流里泄露相关内容。
- 验证点：权限裁剪发生在排序前，日志中只记录拒绝原因，不暴露正文。

#### QS-08：首次知识旅程（对应 FR-Z06、NFR-5.21/5.22）
- 刺激：外部陌生用户首次打开空库环境。
- 环境：最小运行模式已安装完成。
- 期望响应：用户能在 10 分钟内完成“导入一条知识 → 在列表里看到 → 再次检索命中”。
- 验证点：引导入口清晰，空状态页有下一步动作，内部链接无 basePath 错误。

#### QS-09：审计可追溯性（对应 AC-5.4）
- 刺激：用户查看某条 active 条目的来龙去脉。
- 环境：条目经历过提取、冲突裁决和一次 supersede。
- 期望响应：系统能展示来源、artifact、版本、冲突记录、裁决结论和活动流事件。
- 验证点：从详情页可以跳转到完整链路。

#### QS-10：图谱可视化交互（对应 NFR-5.23、AC-5.5）
- 刺激：用户在 1000 节点、3000 边规模下缩放、拖拽和聚焦图谱。
- 环境：标准桌面浏览器。
- 期望响应：交互帧率不低于 30fps，洞察标记可见，点击节点后详情卡片可在可接受延迟内出现。
- 验证点：前端性能采样与用户感知一致。

#### QS-11：Workbench 首屏加载性能（对应 NFR-5.5）
- 刺激：用户首次或日常打开 Workbench 首页。
- 环境：标准网络环境、冷启动浏览器缓存缺失、最小模式单机部署。
- 期望响应：P95 首屏加载时间不超过 3 秒，首屏骨架与关键导航在可交互前稳定呈现。
- 验证点：同时记录 HTML 首包时间、关键静态资源加载、首个可交互时间和首屏 API 聚合耗时。

---

## 11. 风险与技术债务（Risks and Technical Debt）

### 11.1 已知风险

#### 风险 1：LLM 语义判断漂移
冲突精判、意图消歧和结构化提取高度依赖模型输出稳定性。模型升级或 Provider 切换后，知识质量可能出现隐性漂移。

#### 风险 2：单进程运行时的容量上限
首发采用单进程 Node.js 运行时，适合最小闭环，但在高并发检索、长时间活动流连接和大规模图谱计算下会逼近内存与事件循环瓶颈。

#### 风险 3：来源质量参差不齐
网页抓取、用户手工录入、对话提取和外部调研回流的可信度差异明显。若来源权重策略不够严格，active 区会积累低价值内容。

#### 风险 4：权限规则与域边界复杂化
随着知识域增多、角色变多、团队协作场景出现，域级权限映射会变得更复杂，静态配置方式可能难以持续维护。

#### 风险 5：图谱洞察误报
孤立节点、桥接节点和意外关联的算法结果具备启发价值，但不天然等于业务价值。误报会把调研资源带偏。

#### 风险 6：SSE 长连接数量逼近单进程上限
Workbench 的活动流、导入进度和调研状态都依赖 SSE。用户数增加后，长连接、重连风暴和事件回放窗口可能挤占单进程内存与事件循环预算。

### 11.2 技术债务

#### 债务 1：最小模式下的本地存储扩展性有限
本地文件系统与轻量存储足够支持早期，但在版本历史、artifact 和图谱缓存不断增长后，需要引入更清楚的冷热分层和索引治理。

#### 债务 2：关键词降级路径质量偏弱
没有 embedding 时，系统仍可运行，但复杂查询、跨术语同义表达和隐含关系识别能力会明显下降，需要后续强化混合检索策略。

#### 债务 3：规则确认机制依赖宿主能力
当前规则分发确认高度依赖宿主事件通道。若宿主缺少稳定 ACK 机制，Distribution Ledger 的准确性会受到影响。

#### 债务 4：Analysis Artifact 审核体验仍需打磨
两段式提取提升了质量，但也给用户增加了审核负担。若 Workbench 中的候选项聚合和批量确认体验不够顺手，用户会倾向跳过审核。

#### 债务 5：认证生命周期目前偏轻量
Web 侧身份模型先支持轻量登录与操作审计，后续团队协作、会话管理、角色分配和多租户边界还需要补齐更扎实的实现。

### 11.3 风险应对方向

- 对提取、冲突判定和检索质量建立回归样本集，持续比较不同 Provider 的输出偏差。
- 给单进程运行时预留分层缓存、后台作业隔离和存储 SPI 替换路径。
- 强化来源权重策略，把“可追溯来源”作为 active 的硬门槛之一。
- 在域级权限之上逐步引入更细粒度的角色配置与审计视图。
- 对图谱洞察结果增加人工确认与采纳反馈闭环，减少误报对调研资源的影响。

---

## 12. 术语表（Glossary）

### Knowledge Entry
KIVO 管理的最小知识单元，一条条目表达一个可独立判断的知识断言。

### Knowledge Type
知识类型枚举：fact、methodology、decision、experience、intent、meta。

### Source Reference
来源引用，指向对话、文件、URL、规则文件或调研结果中的原始出处。

### Analysis Artifact
分析中间产物，保存提取阶段产生的断言候选、实体候选、冲突候选和缺口候选。

### Conflict Record
冲突记录，描述两个或多个知识条目之间的语义矛盾、裁决过程和结论。

### Research Task
调研任务，由缺口检测或人工触发产生，包含目标、范围、预算和状态。

### Research Queue
调研队列，承载待执行、执行中、待回写和失败待重试的调研任务，可区分 active 与 silent 两种运行模式。

### Knowledge Graph
知识图谱，基于 Knowledge Entry 之间的关系形成的网络结构，用于关联浏览、洞察计算、缺口检测和 Workbench 可视化探索。

### Gap Report
缺口报告，记录知识库盲区和补齐建议。

### Rule Entry
规则条目，描述 Agent 在特定范围内必须遵守的约束。

### Subscription
订阅关系，定义哪个 Agent、角色或场景需要接收哪组规则。

### Distribution Record
分发记录，记录规则被发送给谁、发送到哪个版本、是否确认成功。

### Domain Purpose
知识域目标声明，定义某个知识域的目标、关键问题、非目标和研究边界。

### Intent Routing
意图路由，指查询进入 KIVO 后，系统决定查询域、检索策略和澄清策略的过程。

### Context Injection
上下文注入，指把与当前任务相关的知识条目和术语压缩成可直接放入 Agent prompt 的上下文包。

### Terminology Registry
术语注册表，保存术语定义、约束、正例、负例、别名与适用域。

### Capability Registry
能力注册表，记录宿主或 Provider 当前可提供的能力及其版本约束。

### Host Adapter
宿主适配层，把 OpenClaw 或其他宿主的底层能力转成 KIVO Core 可消费的稳定接口。

### Pending Queue
待确认队列，承载低置信条目、低置信 artifact 或待补判冲突。

### Superseded
被新版本替代的状态。旧条目仍可追踪，但不再是默认返回结果。

### Deprecated
已废弃状态，表示条目不再建议使用，但在清理周期内仍保留历史记录。

### Archived
归档状态，表示条目退出主检索范围，只保留追溯价值。
