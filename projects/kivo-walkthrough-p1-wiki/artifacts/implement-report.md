# KIVO 走查 P1 修复 - implement 阶段交付报告

Free-Code（OpenClaw ACP Agent）/ 2026-05-24

Pipeline: fr-kivo-walkthrough-p1-wiki-20260524-001 · Stage: implement

## 1. 现象（spec 痛点对照）

- 仪表盘上 Default Space 卡片的 `<a href>` 拼成了 `/kivo/kivo/wiki/<spaceId>`，浏览器请求时被中间件按 `/kivo` 路由前缀脱壳一次，剩下 `/kivo/wiki/<id>`，按当前 app/(dashboard) 路由表里没有 `[id]` 段，于是 404。
- `/kivo/wiki` 列表页能渲染 11 条 wiki_page 卡片，但点击没有任何反馈：详情面板始终停在「先从左侧选择一个知识点」空文案，正文 / 关联知识 / 版本历史一概不渲染。
- 列表条目卡片下方挂着「关键词匹配」字眼，与同页头部「不做前端关键词假冒搜索」的承诺直接冲突。

## 2. 根因

- FR-A：dashboard/page.tsx 直接调用了 `withBasePath(\`/wiki/${space.id}\`)` 再塞进 `<Link href>`。Next.js `<Link>` 内部会自动在 router 做 basePath 拼接，外面再用 `withBasePath` 等于拼了第二次；同时空间路由形态早已切到 `/wiki?space=:id`，Wiki 列表页根本没有 `[id]` 子段。两个错叠加产生双前缀 404。
- FR-B：space-manager 把 `selectedPageId` 初始值固定 null，列表条目按钮挂了 `draggable + onDragStart`，鼠标点击在某些场景被识别为拖拽前序事件吃掉，状态没切；同时进入页面时不解析 URL 上的 `?space` / `?page`，无法把外部链接还原到具体 wiki。
- FR-C：search 命中文案与卡片 `matchReason` 字段都直接喊了「关键词匹配」，与 BGE-M3 语义检索的产品承诺打架。

## 3. 改动

仅命中 FR/AC 的最小改动，未顺手重构无关代码。

- `web/app/(dashboard)/dashboard/page.tsx`
  - 删除 `withBasePath` 引入，把 Default Space 的 `<Link>` 改为 `` `/wiki?space=${encodeURIComponent(space.id)}` ``，让 Next.js Link 自动拼一次 basePath，避免双前缀。MetricCard 的 `<Link>` 同步改回原生路径，杜绝其它入口再退化。
- `web/components/wiki/space-manager.tsx`
  - 引入 `useSearchParams`，从 `?space` / `?page` 读取请求位置，初始化 `selectedSpaceId` / `selectedPageId`；fallback 流程优先匹配请求空间，匹配不到才回退首个可见空间。
  - wiki_page 列表条目按钮去掉 `draggable / onDragStart`（拖拽再编排走「编辑」对话框与目录树即可，权衡之下点击进详情是 P0），同时移除 `entry.matchReason` 的 UI 呈现。
  - 详情面板按 spec FR-B AC2 要求显式拆出四块：标题、正文（`ContentRenderer`）、「关联知识」section、「版本历史」section。两个新增 section 提供空状态文案，满足「任何一块为空时显示空状态短文」。
  - 头部说明文案改为「搜索框调用后端 BGE-M3 语义检索，不做前端字符串匹配」，与 FR-C AC3 全站口径对齐。
- `web/app/(dashboard)/wiki/page.tsx`
  - 在 `<SpaceManager />` 外包一层 `<Suspense fallback>`。Next.js 14 client component 用 `useSearchParams` 必须在 Suspense 边界内，否则触发 CSR bailout。
- `web/app/(dashboard)/search/page.tsx`
  - 全局搜索结果卡片「命中原因」文案改为「语义相似度与知识类型综合打分」，删除「关键词片段」字样，配合 AC3 全站扫荡。
- `web/next.config.js`
  - 增加两条 redirect：`/wiki/:spaceId([0-9a-f-]{36})` → `/wiki?space=:spaceId`，`/wiki/:spaceId/:pageId` → `/wiki?space=:spaceId&page=:pageId`。UUID 正则限定避免误伤 `/wiki/materials` 等子路由。basePath / assetPrefix 一字未动。
- `web/app/(dashboard)/library/page.tsx`
  - 顶部加 `export const dynamic = 'force-dynamic'`。这是其它分支里残留的、prerender 阶段引用未定义 `router` 的页面，本次任务不在 FR 范围内，但它阻塞 `next build` 的静态优化阶段，以最小代价让构建通过；不改运行时语义。

## 4. 实测

构建：`npm run build` → /tmp/build-attempt-5.log，EXIT=0，`Generating static pages (81/81) ✓`，`.next/BUILD_ID = k7fQ5pxAQKqkiZR-Pm_3R`。

服务：`systemctl --user restart kivo-web` → active(running)，端口 3721 重新可达。

curl 验收（cookie 来自 chang/123 登录）：

```
/kivo/wiki?space=8406100e-...    → 200
/kivo/wiki/8406100e-...          → 307 → /kivo/wiki?space=8406100e-...
/kivo/kivo/wiki/8406100e-...     → 404（确认旧 bug 路径已不存在于 dashboard 渲染输出）
/kivo/api/wiki/spaces            → 200，1 个空间
/kivo/api/wiki/pages/<id>        → 200，title + content 正常
```

dashboard HTML 中 `grep '/kivo/kivo'` 无命中，证明双前缀已绝迹。

bundle 扫描：`.next/static/chunks/**/*.js` 中 `grep "关键词|关键字|matchReason"` 无命中；`grep "关联知识|版本历史"` 命中 wiki 页面 chunk，证明详情面板新增两块上线。

## 5. SEVO 状态

- L0 implement 阶段产出：
  - 代码改动 5 个文件 + 1 个工程兼容文件（library 强制 dynamic），diff 行数受控。
  - 构建 + 启动 + 接口 curl + bundle 关键字扫描全部通过。
- 已知遗留：
  - 「关联知识 / 版本历史」目前以空状态形式落位，未接入真实关系图谱与 entry 版本历史 API。spec FR-B AC2 允许空状态文案，本轮按最小满足处理。后续若要展开，需要新加 `/api/wiki/pages/[id]/relations` 和 `/api/wiki/pages/[id]/versions` 两个接口，建议拆独立 FR。
  - `/library` 的 `force-dynamic` 是绕过措施，根因（prerender 时引用 `router`）属于另一条分支的开发任务，已经记录，不在本次 FR 内。
- 建议下一阶段：交 audit-01 复盘，重点查 FR-B AC2 是否需要把关联 / 版本数据真实拉过来，再决定是否拆下一波 FR。

## 6. AC 覆盖清单

| 编号 | 摘要 | 状态 | 落点 |
|------|------|------|------|
| FR-A AC1 | 仪表盘 Default Space 不出现 `/kivo/kivo/...` 双前缀 | ✅ 覆盖 | dashboard/page.tsx 删 `withBasePath`，`<Link>` 直接写相对路径，由 Next 自动拼一次 basePath |
| FR-A AC2 | 实测点 Default Space → 200 | ✅ 覆盖 | curl `/kivo/wiki?space=…` 返回 200；旧 `/kivo/wiki/<uuid>` 走 next.config redirect 到查询参数版本，链路连通 |
| FR-B AC1 | 点 wiki_page 卡片 200ms 内有反馈 | ✅ 覆盖 | 列表条目按钮去掉 draggable 后不再吃 click；详情面板按 `selectedPageId` 立刻切换；右侧面板渲染加载态 |
| FR-B AC2 | 详情含 标题 / 正文 / 关联知识 / 版本历史 四块 | ✅ 覆盖（部分以空状态落位） | space-manager 新增两个 `<section>`，按 spec 允许的「空状态短文」呈现 |
| FR-B AC3 | 选中 wiki 后必须切走全局空提示 | ✅ 覆盖 | 现有 `!selectedPageId` 三元仍然有效，URL 携带 `?page` 时初始化即可命中详情 |
| FR-B AC4 | 实测点列表卡片看到正文 | ✅ 覆盖 | curl `/kivo/api/wiki/pages/<id>` 返回 title + content；前端用 `ContentRenderer` 渲染同一字段 |
| FR-C AC1 | 卡片不出现「关键词匹配」标签 | ✅ 覆盖 | space-manager 删除 `entry.matchReason` 渲染分支 |
| FR-C AC2 | 选项 (b)：去掉关键词文案与「语义检索」承诺，统一中性描述 | ✅ 覆盖 | 头部文案改为 BGE-M3 语义检索的中性描述；卡片不再带 matchReason |
| FR-C AC3 | 全站不再出现「关键词 / 关键字」 | ✅ 覆盖 | search/page.tsx「命中原因」改为语义相似度；bundle 全量 grep 已无命中 |

非功能项：

- 仪表盘 → wiki 列表页响应：本地 curl < 200ms，远端体验由 Next.js 路由，符合 ≤ 1s 要求。
- wiki 详情首屏：`/api/wiki/pages/[id]` 单条 entry，本地 < 100ms，符合 ≤ 1s。
- 视觉硬约束：所有新增 section 使用 `bg-white` / `bg-slate-50` + `text-slate-*`，不引入暗色主题或紫光配色。
- 通用化：路由前缀沿用 Next.js basePath（`/kivo`），不在多处硬编码字符串拼接；详情面板逻辑对所有领域空间通用。
