# ADR-009：前端框架选择

状态：已采纳

## 背景

KIVO Web Frontend 是一个 SPA，需要选择前端框架。核心需求：
- 桌面浏览器（1280px+），MVP 不需要移动端。
- 页面数量有限（约 10 个页面/视图）。
- 数据展示为主，交互复杂度中等（筛选、分页、表单、对比视图）。
- 需要图表组件（仪表盘趋势图、分布图）。
- SSE 实时事件接收。

## 候选方案

| 框架 | 优势 | 劣势 | 适用性 |
|------|------|------|--------|
| React + Next.js | 生态最大，组件库丰富；App Router 提供文件系统路由和 Server Components；与 SEVO 统一技术栈，组件/工具链可复用 | 需要 Node 运行时托管（初期可用 `next export` 静态导出规避） | 高 |
| React + Vite (纯 SPA) | 构建快，部署简单（纯静态文件） | 无 SSR/ISR 能力，路由需额外配置，与 SEVO 技术栈分裂 | 中 |
| Vue 3 + Nuxt | 模板语法直观，官方全家桶开箱即用 | 与 SEVO 技术栈不统一，组件无法复用 | 低 |
| Svelte/SvelteKit | 编译时优化，包体积最小 | 生态较小，企业级组件库选择少，与 SEVO 完全不兼容 | 低 |

## 决策

选择 React + Next.js（App Router）+ shadcn/ui + Recharts。

## 理由

1. 与 SEVO 统一技术栈：SEVO 已确定 React + Next.js App Router（ADR-006-Web），KIVO 跟随可实现：
   - 前端组件库共享（表格、筛选器、状态卡片、SSE 客户端）
   - 构建工具链统一（Next.js + Tailwind + TypeScript）
   - 版本冲突处理中间件复用（409 VERSION_CONFLICT UI 组件）
   - 开发者在两个项目间切换零学习成本

2. Next.js App Router 的实际收益：
   - 文件系统路由，10 个页面无需手写路由配置
   - Server Components 可在 后续 用于 Dashboard 聚合查询的服务端预渲染
   - 初期可通过 `output: 'export'` 生成纯静态文件，部署方式与纯 SPA 一致

3. shadcn/ui 提供高质量、可定制的 UI 组件，不引入重量级 UI 框架。Recharts 覆盖仪表盘所需的图表类型。React 生态的 SSE 集成方案成熟。

## 部署策略

- 初期：`next export` 静态导出，产物为 HTML/CSS/JS，由同进程 HTTP 服务的 `/static` 路由托管，无需独立 Node 服务。
- 后续：切换为 `next start` 模式，启用 Server Components 和 API Routes，作为独立 BFF 服务部署。

## 后果

- KIVO 和 SEVO 前端代码可抽取共享组件包（`@kivo-sevo/ui`）。
- API 契约仍是前后端的唯一耦合点，框架选择不影响后端。
- 开发者需要熟悉 Next.js App Router 约定（文件路由、layout、loading 等）。
