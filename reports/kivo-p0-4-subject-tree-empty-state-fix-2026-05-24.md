# KIVO 学科树空状态修复报告

Codex（OpenClaw ACP Agent）2026-05-24

## 结论

已修复。KIVO 首屏左侧学科树现在会显示真实领域「概率论与数理统计 70」，不再在 wiki 有 70 条知识点时显示「还没有学科域」。

## 根因

学科树接口只读取 `subject_nodes`，当前表里是 0 条。领域 wiki 使用的是 `entries`，当前真实数据在 `entries.domain`：

- `subject_nodes`：0 条
- `entries.subject_id`：0 个非空值
- `entries.domain = 概率论与数理统计`：70 条 `wiki_page`，10 条 `wiki_directory`

因此这次没有继续按已失效的 `subject_id` 聚合，而是按 wiki 实际归属字段 `entries.domain` 做只读兜底。只在 `subject_nodes` 为空时启用，已有正式学科树数据时仍优先使用 `subject_nodes`。

## 修改文件

- `web/lib/subjects/repository.ts`
  - `listTree()` 保持优先读取 `subject_nodes`
  - 当 `subject_nodes` 为空时，从 active wiki entries 的 `domain` 聚合根级学科域
  - 计数按 active `wiki_page` 数量返回，当前显示为 70

## git diff --stat

```text
/dev/null => web/lib/subjects/repository.ts | 1036 +++++++++++++++++++++++++++
1 file changed, 1036 insertions(+)
```

说明：当前仓库里这个文件本来就是未跟踪文件，本次在该文件内补了学科树兜底逻辑；仓库同时已有大量其他未提交变更，本次没有修改那些文件。

## 验证

### 构建

构建已通过，输出已按要求重定向到 `/tmp/kivo-p04-build.txt 2>&1`。

尾部结果显示 Next.js build 完成，进程退出码为 0。

### 服务

已执行 `systemctl --user restart kivo-web`，服务状态为 active。

### API

登录后访问 `/kivo/api/subjects` 返回：

```text
meta.total = 1
概率论与数理统计 | 70 | entries-domain
```

### 浏览器走查

agent-browser 登录并访问真实 Web 页面，左侧学科树可见「概率论与数理统计 70」，wiki 页面同时显示「概率论与数理统计 70 条知识点」。页面可见文本里没有「还没有学科域」。

截图：

- `reports/screenshots/kivo-p04-01-dashboard-subject-tree.png`
- `reports/screenshots/kivo-p04-02-wiki-subject-tree.png`
- `reports/screenshots/kivo-p04-03-selected-subject-tree.png`

## 走查结论

通过。首屏学科树和领域 wiki 的数据口径已对齐，陌生用户不会再看到「学科树为空但 wiki 有数据」的矛盾状态。
