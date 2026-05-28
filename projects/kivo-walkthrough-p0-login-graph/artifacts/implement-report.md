# KIVO 走查 P0 修复 - 实施报告
Claude Code（OpenClaw ACP Agent）/ 2026-05-24

## 结论

走查发现的 2 个 P0 已修复并实测通过：

- 登录后画面会真正落到 `/kivo/dashboard`，已登录用户访问 `/portal`、`/login`、`/login/simple` 自动跳到 `/dashboard`。
- `/kivo/graph` 主导航有显式入口，仪表盘"图谱节点"卡片可点击进入，页面真正渲染节点和边。

`npm run build` 通过；agent-browser 实测登录跳转正确，图谱页加载到 200 节点 / 934 关联，可点击节点展开邻居。

## P0-1 登录假死

### 现象
密码 123 登录，接口 200，cookie 已写，URL 跳到 `/kivo/portal`，画面停在登录页，刷新仍是登录页。

### 根因
两个独立问题叠加：

1. 登录页用 `router.push('/dashboard') + router.refresh()`。Next.js client router 在 basePath = `/kivo` 场景下偶发把 push 解析成 `/kivo/portal`（与当前路径同），导致 URL 变化但组件实例没切换；refresh 又把当前 RSC 树（仍是 portal）重新拉回来，画面就钉在登录页。
2. middleware 对 `/portal` 一律放行，没有"已登录跳走"规则。所以即使刷新拿着合法 cookie，也只会原地停留。

### 修复

`web/app/(auth)/portal/page.tsx` / `login/page.tsx` / `login/simple/page.tsx`：登录成功后改用 `window.location.replace(withBasePath('/dashboard'))` 做硬跳转。硬跳转携带 cookie 走完整的服务端渲染路径，避免 client router 状态错位。

`web/middleware.ts`：所有 auth 类路径在已持有合法 session cookie 时直接 307 重定向到 `/dashboard`：

- `/portal` 已登录 → `/dashboard`
- `/login` 已登录 → `/dashboard`，未登录 → `/portal`
- `/login/simple` 已登录 → `/dashboard`，未登录 → `/portal`

### 实测

```
未登录 GET /kivo/portal      → 200 (停在登录页)
登录后 GET /kivo/portal      → 307 → /kivo/dashboard
登录后 GET /kivo/login       → 307 → /kivo/portal → /kivo/dashboard
登录后 GET /kivo/login/simple → 307 → /kivo/portal → /kivo/dashboard

agent-browser 实操：portal 输入 123 → 自动跳到 /kivo/dashboard，可见学科树和主导航。
```

## P0-2 图谱页空

### 现象
仪表盘显示"图谱节点 418 / 关系边 1782"，进入 `/kivo/graph` 看不到节点和边；wiki/intent 页 `?view=graph` 链接也只回到列表。

### 根因
图谱组件本身没坏：`/api/v1/graph` 返回 200 节点 / 934 边，`KnowledgeGraphView` 用 d3-force + SVG 渲染（已有依赖 `d3-force`、`d3-selection`），`/kivo/graph` 路由也存在。

真正的问题是入口断了：

1. 主导航（top-nav）只有 `原始资料库 / 领域 wiki / 意图知识库 / 知识搜索` 4 个 tab，没有图谱入口。
2. sidebar-tree 上的"通用图谱视图"指向 `/intent?view=graph`，"学科图谱视图"指向 `/wiki?view=graph`，但 `wiki/page.tsx` 和 `intent/page.tsx` 根本不读 `view` 参数，只渲染列表。所以点这俩按钮等于回到自己。
3. 仪表盘"图谱节点"卡片是纯展示组件，不是链接。

陌生用户在主导航里找不到图谱，仪表盘卡片不能点，sidebar 跳转又回到列表，自然得出"图谱页空"的结论。

### 修复

`web/components/layout/top-nav.tsx`：在主导航 `primaryTabs` 中插入 `{ href: '/graph', label: '知识图谱', icon: Network }`，加入对应的 `isTabActive` 分支。

`web/components/layout/sidebar-tree.tsx`：把两个图谱按钮的 href 都改成 `/graph`，label 统一为"知识图谱"。直接走真实图谱路由，不再用 `?view=graph` 这种没人接的 query。

`web/app/(dashboard)/dashboard/page.tsx`：`MetricCard` 增加可选 `href`，传入 `href` 时整张卡片包成 `<Link>`。给"图谱节点"卡片传 `href="/graph"`，描述文案补"点击查看图谱"。

### 实测

agent-browser 实操：
- 登录后仪表盘主导航看到"知识图谱"tab。
- 点击 → URL 变 `/kivo/graph`，页面渲染 200 节点 + 934 关联。snapshot 抓到 200 个 SVG group 节点，标题栏显示"知识图谱 200 节点 · 934 关联"。
- 截图确认白底，节点是彩色圆点（绿/蓝/紫/橙），边是灰色细线，无深色主题。
- 点节点 → 出"返回全局视图"按钮，节点标题展开（如"非专业高频用户的流程卡死点模式"等）。

## 顺带修复的 build 阻塞

`web/app/api/v1/conflicts/route.ts` 在 Next.js 14 下报错：
```
Type error: "listConflicts" is not a valid Route export field.
```

Next.js App Router 限制 route.ts 只能导出 HTTP 方法（GET/POST/...）和少量配置（runtime、dynamic 等），不能导出业务函数。原文件在 route.ts 里 export 了 `listConflicts`、`findConflict`、`resolveConflict`，子路由 `[id]/resolve/route.ts` 又从 `../../route` import 它们 —— 直接 build 失败，影响所有改动验证。

修复：把这三个函数和数据搬到同目录新文件 `conflicts-store.ts`，`route.ts` 只保留 `GET`，子路由 import 路径改为 `../../conflicts-store`。语义零变化。

## 改动文件清单

```
M web/app/(auth)/portal/page.tsx          登录成功硬跳 /dashboard
M web/app/(auth)/login/page.tsx           同上
M web/app/(auth)/login/simple/page.tsx    同上
M web/middleware.ts                       已登录用户 auth 路径自动跳 /dashboard
M web/components/layout/top-nav.tsx       主导航新增"知识图谱"入口
M web/components/layout/sidebar-tree.tsx  sidebar 图谱按钮指向 /graph
M web/app/(dashboard)/dashboard/page.tsx  "图谱节点"卡片可点击进入 /graph
A web/app/api/v1/conflicts/conflicts-store.ts  conflicts 共享数据/函数
M web/app/api/v1/conflicts/route.ts       仅保留 GET
M web/app/api/v1/conflicts/[id]/resolve/route.ts  import 路径调整
```

## 验证证据

- build：`NODE_OPTIONS="--max-old-space-size=3072" npm run build` → EXIT=0；输出含 `○ /graph 6.93 kB` 静态路由编译成功。
- 服务：`systemctl --user restart kivo-web` → active running。
- HTTP：登录 → 拿 cookie → /portal、/login、/login/simple 都最终走到 /dashboard。
- 浏览器：agent-browser 实操登录 + 主导航点"知识图谱" → 200 节点 / 934 关联可见可点击。

## SEVO Pipeline 状态

- Pipeline ID: fr-kivo-walkthrough-p0-login-graph-20260524-001
- Stage: implement → 已完成
- 下一步：建议派 audit-01 复审改动，再派 ux-01 复跑陌生人走查（带新登录跳转和图谱入口），确认 P0 真闭环。

## 用户硬约束遵守

- 白底黑字：所有改动沿用现有 slate-50 / white 主题，未引入深色背景。
- 无 AI 套话：报告全程直接陈述。
- 无新依赖：图谱用现有 `d3-force` + SVG，完全没动 package.json。
- 不绑定学科：图谱节点颜色按 KnowledgeType（fact/decision/methodology/...）映射，与具体学科无关。
