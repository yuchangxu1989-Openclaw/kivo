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

生成 `kivo.config.json`，默认配置：
- 数据库：`./kivo.db`（SQLite）
- 模式：`standalone`
- 冲突阈值：`0.85`

## 添加知识

```bash
kivo add fact "TypeScript 类型系统" --content "TypeScript 通过静态类型检查提升代码质量" --tags "typescript,类型"
```

支持的知识类型：`fact` / `concept` / `rule` / `procedure` / `heuristic` / `reference`

## 查询知识

```bash
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

`--llm` 启用 LLM 辅助提取（需配置 OPENAI_API_KEY）。

## 健康检查

```bash
kivo health          # 系统状态
kivo config-check    # 配置校验
kivo capabilities    # 能力检测
```

## 启动 Web 工作台

```bash
cd node_modules/@self-evolving-harness/kivo/web
npm install && npm run dev
```

访问 `http://localhost:3000`，可视化管理知识库。

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
