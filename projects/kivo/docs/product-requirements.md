# KIVO 陌生人走查修复 - Pipeline `fr-kivo-20260525-001`

> 来源：`/root/.openclaw/workspace/reports/kivo-stranger-walkthrough-2026-05-24.md`
> 创建：2026-05-25
> 主 spec（不要绕过）：`/root/.openclaw/workspace/projects/kivo/docs/product-requirements.md`

## 任务边界

修复 KIVO 陌生小白用户开箱即用走查中发现的 3 个 P0 + 4 个 P1 缺口。
**只允许实装主 spec 已有 FR/AC，不允许新发明 FR**；如发现 spec 与现实脱节，先回报，不要自创需求。

## 硬约束（任何下游 agent 不能违反）

1. **视觉**：白底黑字，主体背景 `rgb(255,255,255)`，文字 `rgb(3,7,17)`。禁止深色背景、紫光、酷炫色、霉绿。任何深色组件/紫光视觉 = 直接返工。
2. **UX**：严格按主 spec FR/AC 实装，禁止改动核心交互逻辑。spec 没说的不要做。
3. **通用化**：placeholder、示例、文案、seed、demo 中**严禁**使用具体学科（概率论、高数、生物信息学、认知科学等）举例。要用通用名词（"知识库"、"领域"、"主题"、"示例资料"），不绑学科。
4. **优先级**：文字 → 流程 → 视觉。先改对、再走通、再美化。
5. **语言**：用户可见输出用简体中文；技术标识符保留原文。
6. **BGE + LLM 语义**：意图判断、知识匹配、搜索召回必须走 BGE 向量 + LLM 语义理解，禁止关键词/正则/规则引擎/FTS5。

## P0 - 阻塞陌生用户的关键缺口

### P0-1：公网入口被挡
- **现象**：`http://43.163.80.95/kivo/` 浏览器报 `net::ERR_BLOCKED_BY_CLIENT`，没进入登录页。
- **目标**：公网入口能正常打开 KIVO 登录页，无网络拦截。
- **AC**：
  - 公网 URL 在主流浏览器（Chrome/Edge/Safari）首次访问能正常显示登录页
  - 不依赖任何浏览器扩展开关或 hosts 配置
  - 路径、CSP、CORS、防火墙、Nginx 路由完整可达
  - 提供从公网入口完整跑通登录→仪表盘的截图证据

### P0-2：登录后停留登录页
- **现象**：输入密码 123 后 URL 变 `/kivo/portal`，登录接口返回 200 + 写入 `kivo_session` cookie，但画面仍卡在登录屏。
- **目标**：登录成功后**自动且明确**进入仪表盘。
- **AC**：
  - 登录请求 200 后客户端必须 navigate 到仪表盘（默认路径 `/kivo/dashboard` 或主 spec 指定路径）
  - 不依赖手动刷新 / 手动改 URL
  - 已登录用户访问 `/kivo/login` 自动重定向到仪表盘
  - 提供登录成功 → 仪表盘的端到端截图证据

### P0-3：图谱不渲染节点和边
- **现象**：领域 wiki 与意图知识库的"图谱视图"链接（`?view=graph`）打开后画面仍是 wiki 列表，没有节点和边的画布。仪表盘却展示了"图谱节点 418 / 1782 条关系边"的数字。
- **目标**：图谱视图必须真实渲染节点和边的画布，可交互。
- **AC**：
  - `?view=graph` 切换后，UI 出现图谱画布组件（节点 + 边可见）
  - 节点和边数量可与仪表盘指标对得上（来源同一 graph_nodes/graph_edges 数据源）
  - 节点可悬停查看名称、可点击进入详情
  - 空状态文案明确（"当前学科还没有图谱关系"），不弄成假渲染
  - 视觉白底黑字，节点用通用色板，禁止紫光/霓虹

## P1 - 影响首日体验的次要缺口

### P1-4：搜索结果不对题
- **现象**：搜"概率论"/"贝叶斯"/"全概率公式"，前排都是"能力复用优先铁律""知识准入的三重测试"等系统规则，不是用户搜的内容。每次都"找到 60 条结果"看起来像 hard-coded。
- **目标**：搜索按用户问题返回相关知识，系统内部规则/Meta 条目不应排前。
- **AC**：
  - 搜索走 BGE 向量召回 + LLM 重排（禁关键词/正则）
  - 系统内部规则、Meta 条目、运营文案默认排除或后置
  - 同样 query 多次搜结果数应反映真实命中，不应 hard-coded "60 条"
  - 领域 wiki 内部搜索若调用相同检索通道，前端不要再标"关键词匹配"——文案与实现要一致

### P1-5：上传材料 30 秒无反馈
- **现象**：上传 639 字节 PDF 后弹窗关闭，30 秒刷新原始资料库列表无变化，没有 pending/slicing/extracting/done/failed 任何状态。
- **目标**：上传后 30 秒内必须有可见状态反馈（已登记/解析中/编译中/失败原因）。
- **AC**：
  - 上传成功后立刻在素材列表插入新卡片（`pipeline_status=pending` 至少可见）
  - 卡片随后实时反映 slicing/extracting/injecting/done/failed
  - failed 时显示失败原因 + 重试入口
  - 列表数字（"共 N 条"）跟随同步更新
  - 30 秒内必有至少一次状态变化（即使后端慢，也要展示"处理中"）

### P1-6：仪表盘 Default Space 跳 404
- **现象**：仪表盘点击 Default Space 跳到 `/kivo/kivo/wiki/...` 报 404。
- **目标**：所有从仪表盘出发的链接必须能跳到正确的目标页面。
- **AC**：
  - Default Space 链接落到正确的 wiki 路径（去掉重复 `/kivo/kivo/`）
  - 仪表盘所有出链全量过一遍，确保无 404
  - 路由规则在 Next.js basePath/rewrites 下正确推导

### P1-7：wiki_page 无详情
- **现象**：领域 wiki 列表里点 wiki_page 卡片不打开详情，右侧仍提示"先从左侧选择一个知识点"。
- **目标**：点击 wiki_page 必须打开对应详情。
- **AC**：
  - 点击卡片后导航到 wiki_page 详情页（路由稳定、可复制 URL）
  - 详情页展示 spec 定义的字段（标题、正文、关联条目、版本、来源材料等）
  - 左侧选择"知识点"和点击列表卡片是两条独立但都能用的入口
  - 空 wiki_page（"暂未提取出合格知识条目"）单独空状态展示，不冒充内容

## 与之前 pipeline 的关系

之前已有以下相关 pipeline（部分仍 `created` 未推进），本 pipeline 收口、不重做已交付项；**禁止与下列 pipeline 同步操作同一文件而不沟通**：

- `kivo-walkthrough-p0-login-graph` — P0-2/P0-3 早期立项（未完成）
- `kivo-walkthrough-p1-search-upload` — P1-4/P1-5 早期立项
- `kivo-walkthrough-p1-wiki` — P1-6/P1-7 早期立项

下游 implement agent 进入前先 read 上述目录是否已有产出，避免重复劳动。

## 必修通过线（Walkthrough Re-run）

实装完成后必须再跑一次"陌生小白用户开箱即用走查"（即 `reports/kivo-stranger-walkthrough-2026-05-24.md` 的相同流程），验收报告写到 `reports/kivo-stranger-walkthrough-fix-2026-05-25.md`，覆盖：
- 公网入口能开（截图）
- 登录跳转仪表盘（截图）
- 图谱真实渲染（截图）
- 搜索回归相关性（3 个查询 + 前 5 结果截图）
- 上传 30 秒内有可见状态（视频或时序截图）
- Default Space 不再 404
- wiki_page 详情可打开

P0 任意一项未通过 = 本 pipeline 整体 FAIL，不准声明完成。

## 主 spec 锚点

下游 agent 实装前必须 read `/root/.openclaw/workspace/projects/kivo/docs/product-requirements.md` 找到对应 FR/AC（搜索关键字：登录跳转、图谱视图、上传状态、wiki_page 详情、Default Space）。如对应 FR 不存在，**先回报**，不要私自补 FR。
