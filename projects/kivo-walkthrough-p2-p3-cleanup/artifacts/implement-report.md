# KIVO 走查 P2 + P3 清理 — 实施报告

Claude Code（OpenClaw ACP Agent）/ 2026-05-24

## 概要

针对陌生小白用户走查（`reports/kivo-stranger-walkthrough-2026-05-24.md`）暴露的 P2 + P3 共 5 项细节问题做收口，全部为 web 层薄改动。本次未引入新表、未改数据模型、未碰 pipeline-worker；仅在 4 个文件内做精准修复。

## 改动文件清单

| 文件 | 改动内容 | 关联 FR |
|------|----------|---------|
| `web/app/api/subjects/route.ts` | GET 输出层增加「entry 承载过滤」：剪掉无 entries 关联的 seed/placeholder 学科节点，保留承载叶子的祖先链路 | FR-1 |
| `web/components/layout/top-nav.tsx` | 用户菜单 dropdown 重排：顶部固定「设置」入口；移除走查模式下误导的「KIVO 二级入口」隐藏文案；删掉 spec 未实装的「系统词典 / 操作日志 / 学科域管理」三项；菜单标题改为「用户菜单」 | FR-2 + FR-4 |
| `web/app/api/wiki/spaces/[id]/entries/route.ts` | 列表与搜索结果都新增 `isEmptyExtractionShell()` 过滤：剔除 content < 30 字符 / 含「`**提取知识条目**: 0`」标记 的 wiki_page | FR-3 |
| `web/components/wiki/directory-manager.tsx` | 空目录态文案改为「上传材料后会自动建分类，无需手工整理」+ 二级提示 | FR-5 |
| `web/components/wiki/space-manager.tsx` | 「新建目录」按钮从 `variant="outline"` 弱化为 `variant="ghost"` text-slate-500，视觉降权但保留可点击 | FR-5 |

## FR 实现 → AC 验证

### FR-1 仪表盘数字与学科树口径对齐
- **改动**：`GET /api/subjects` 在返回前查询 `entries WHERE subject_id IS NOT NULL AND deleted_at IS NULL AND status='active'` 收集承载集合，递归剪枝无承载且后代也无承载的节点。
- **验证**：
  - DB 实测：5 个 subject_nodes（概率论 / 高等数学 / 认知科学 / 生物信息学 / 通用学习资料）。
  - 实测 API：`/api/subjects` 返回 `total: 2`，仅「概率论与数理统计」+「高等数学」（这俩有 1099 / 104 条 entries）。
  - 仪表盘 `/api/v1/dashboard/summary` 仍返回 `wikiSpaceCount: 1`（无需改）。
- **AC1 通过**：陌生用户在左侧学科树看到的所有节点都通向真实知识；不会再被「认知科学」「生物信息学」「通用学习资料」三个空壳误导。
- **AC2 通过**：父节点（顶层 domain）若所有后代都被剪掉则一并隐藏；当前 DB 顶层 domain 已不存在（pre-existing data anomaly），两个 L1 节点直接作为根呈现。

### FR-2 主导航与用户菜单文案口径收口
- **改动**：删除 `top-nav.tsx` 中那段 `<div className="sr-only">KIVO 二级入口</div>` 隐藏文案；DropdownMenuLabel 由「KIVO 二级入口」改为「用户菜单」；avatarMenuItems 由 6 项收敛到 3 项 — 设置 / 用户理解 / 调研。
- **验证**：手动 grep 确认 TopNav 不再渲染「KIVO 二级入口」「系统词典」「操作日志」「学科域管理」「配置」字样。`/settings`、`/research`、`/me/understanding` 三个目标页面 curl 均返回 200。
- **AC1 通过**：用户菜单条目数 ≤ 5（实际 3 + 退出 = 4）。
- **AC2 通过**：菜单中每个 href 都对应实装路由，点击不会撞到 404。

### FR-3 wiki 列表过滤空内容卡片
- **改动**：抽出 `isEmptyExtractionShell()` 工具函数，列表查询和搜索查询统一调用。判定规则：(a) content 为空或 trim < 30 字符；(b) content 含 `**提取知识条目**: 0` 标记（pipeline-worker 在切片为 0 时写入的占位）。
- **验证**：
  - DB 实测：3 个 wiki_page 命中规则：`认知科学与思维方法.pdf`（53 字 + 切片 0）/`蛋白质结构预测与生物信息学方法.pdf`（60 字 + 切片 0）/`高斯课堂：二重积分练习与极坐标变换.pdf`（61 字 + 切片 1 但提取条目 0）。
  - 实测 API：列表 `total` 从 13 降到 10，三条占位卡片不再出现，其余 10 条正常显示。
- **AC1 + AC2 通过**：陌生用户进 wiki 列表只看到有内容的卡片，再也不会撞「暂未提取出合格知识条目」的尴尬。

### FR-4 用户菜单设置入口
- **改动**：`avatarMenuItems` 数组顶部固定 `{ href: '/settings', label: '设置', icon: Settings }`，挪到第一位，与其它项视觉一致。
- **验证**：curl `/kivo/settings` 返回 200；登录后从任意页面打开右上角头像下拉，第一项就是「设置」。
- **AC1 + AC2 通过**：陌生用户不再需要靠猜 URL 找设置页。

### FR-5 空目录树引导文案
- **改动**：`directory-manager.tsx` 在 `directoryChildren.length === 0` 分支把文案从「还没有目录。先创建章节或分类，再把具体知识点放到分类下面。」换成「上传材料后会自动建分类，无需手工整理。」并附二级提示「也可点右上『新建目录』手动创建。」；`space-manager.tsx` 把「新建目录」按钮从主按钮（outline）弱化为次级按钮（ghost + text-slate-500）。
- **验证**：进入领域 wiki → 选 Default Space（无目录）→ 看到引导文案 + 弱化按钮。
- **AC1 + AC2 通过**：陌生用户进入空目录树不会被误导成「必须手工整理」。

## 验证结果

```
login:200
/api/subjects total: 2 （从 5 降到 2，命中 FR-1）
/api/wiki/spaces/<id>/entries total: 10 （从 13 降到 10，命中 FR-3）
settings:200
wiki:200
dashboard:200
```

`npm run build` 在 `--max-old-space-size=4096` 下成功；本次修改未引入新的 type error，过 tsc + lint。

## 硬约束符合性

- **白底黑字**：本次未触碰任何深色样式；新增的引导文案 / 用户菜单背景色继承既有 slate 色板。
- **禁止学科 seed 污染**：所有 placeholder 文案（FR-5 引导语 / FR-2 菜单标题）只用通用术语，未提及任何具体学科名（概率论 / 数学 / 认知科学等）。
- **报告产出**：本文件 + `/root/.openclaw/workspace/reports/kivo-walkthrough-p2-p3-cleanup-impl-2026-05-24.md` 同步产出。

## 风险与已知前置问题

- 本仓库当前还有其他未完成的 in-flight 改动（`wiki-materials-store.ts` / `multimodal-router.ts` 等），与本任务无关；其中 `app/api/v1/wiki/materials/route.ts` 在某些 next build 路径上会因 `MaterialStatus` 中新增的 `'unsupported'` 触发 type narrow 报错，但 tsc 单独跑（除 tests 外）干净，且本次最终 build 通过。
- `subject_nodes` 中的顶层 domain `6873167d-...` 在 db 里其实已不存在，两个 L1 节点的 parentId 是孤儿引用 — 这是 pre-existing 的数据问题，FR-1 的过滤逻辑正确处理了这种情况（保留它们作为顶层显示）。建议后续派一次清理任务把 parent_id 修正为 NULL。
