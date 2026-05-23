# KIVO 领域知识库 Web 体验增强 — 产品需求规格

OpenClaw（pm-02 子Agent）| 2026-05-22

## 背景

Wiki 模块后端（wiki-repository 703行）能力完整，但 Web 端交互停留在只读浏览。space-manager（42行）和 directory-manager（35行）仅暴露基础方法，前端无 CRUD 入口。本次补齐空间管理、目录管理、条目浏览搜索的完整交互。

## FR-FIX-01：领域空间 CRUD

| AC | 验收标准 |
|----|----------|
| AC-01.1 | Wiki 首页以空间卡片列表为主入口，展示名称、描述、图标 |
| AC-01.2 | 点击「新建空间」弹出表单，填写名称（必填）、描述、图标后创建成功 |
| AC-01.3 | 空间卡片右键/更多菜单支持重命名、修改描述、更换图标 |
| AC-01.4 | 删除空间需二次确认，删除后从列表移除（软删除） |
| AC-01.5 | 新增 POST /api/wiki/spaces、PATCH /api/wiki/spaces/:id、DELETE /api/wiki/spaces/:id |

## FR-FIX-02：目录结构管理

| AC | 验收标准 |
|----|----------|
| AC-02.1 | 空间内目录树支持右键/按钮创建子目录，最多嵌套 3 层 |
| AC-02.2 | 目录节点支持内联重命名（双击或菜单触发） |
| AC-02.3 | 目录节点支持删除（二次确认，含子节点级联软删除） |
| AC-02.4 | 目录和条目支持拖拽排序及跨目录移动，拖拽时显示放置指示器 |
| AC-02.5 | 拖拽结果调用 PATCH /api/wiki/spaces/:id/directories/:nodeId/move 持久化 |
| AC-02.6 | 嵌套超过 3 层时禁止放置并给出提示 |

## FR-FIX-03：条目浏览与搜索

| AC | 验收标准 |
|----|----------|
| AC-03.1 | 空间内条目列表支持分页，每页 20 条，底部分页控件 |
| AC-03.2 | 搜索框输入后调用已有 /api/wiki/search，结果按相关度排列 |
| AC-03.3 | 搜索结果中匹配文本高亮显示（标题和摘要） |
| AC-03.4 | 点击搜索结果或列表条目进入已有详情页 |
| AC-03.5 | 搜索支持限定当前空间范围（传 spaceId 参数） |

## 技术约束

- 复用已有 wiki-repository 方法，不新建数据表
- 搜索复用 wiki-repository.search()，前端做高亮标记
- 拖拽使用 HTML5 Drag and Drop 或 dnd-kit，不引入重量级库
- API 遵循现有 ApiResponse<T> 格式，错误走 badRequest/serverError
