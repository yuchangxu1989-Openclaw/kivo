# KIVO 快速上手

30 秒从安装到第一次查询。

## 安装

```bash
npm install -g @self-evolving-harness/kivo
```

或作为项目依赖：

```bash
npm install @self-evolving-harness/kivo
```

## 初始化

```bash
kivo init --yes
```

生成 `kivo.config.json` 和本地 SQLite 数据库。`kivo add` 需要 LLM provider；`kivo query` 需要 embedding provider 并先运行 `kivo embed-backfill`。

KIVO 共享 OpenClaw 的 `openclaw.json` provider 配置；非 OpenClaw 环境可用 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`KIVO_LLM_MODEL` 临时提供 LLM 配置。

## 添加知识

```bash
kivo add fact "TypeScript 类型系统" --content "TypeScript 通过静态类型检查提升代码质量" --tags "typescript,类型"
```

支持的知识类型：`fact` / `methodology` / `decision` / `experience` / `intent` / `meta`

## 查询知识

```bash
kivo embed-backfill
kivo query "TypeScript 类型"
```

支持过滤：

```bash
kivo query "路由规则" --nature rule --domain "agent-scheduling"
```

## 批量导入

从目录导入 Markdown/文本文件：

```bash
kivo ingest --dir ./docs --llm
```

`--llm` 启用 LLM 辅助提取，使用 OpenClaw `openclaw.json` 中的 provider 配置，或临时读取 `OPENAI_API_KEY`。

## 健康检查

```bash
kivo health          # 系统状态
kivo config-check    # 配置校验
kivo capabilities    # 能力检测
```

## Web 工作台

发布到 npm 的 CLI 包不包含本地 `kivo web` 命令，也不包含 `node_modules/@self-evolving-harness/kivo/web` 源码目录。需要 Web 工作台时，请从 KIVO 源码仓库启动 `web/` 应用，或使用已部署的 KIVO Web 入口。

## 编程接口

```js
import { Kivo } from '@self-evolving-harness/kivo';

const kivo = new Kivo({ dbPath: './kivo.db', mode: 'standalone' });
await kivo.init();

// 写入
await kivo.ingest('Node.js 使用事件驱动模型', 'manual');

// 查询
const results = await kivo.query('事件驱动');
console.log(results.map(r => r.entry.title));

await kivo.shutdown();
```

## 下一步

- [配置参考](./configuration.md) — 全部配置项说明
- [故障排查](./troubleshooting.md) — 常见错误及解决
- [API 参考](./api-reference.md) — CLI 和 Web API 完整文档
- [升级指南](./upgrade-guide.md) — 版本迁移步骤
