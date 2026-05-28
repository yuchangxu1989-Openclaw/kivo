---
name: kivo-intent-injection
description: "Inject KIVO knowledge into agent context at bootstrap and on each message"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["agent:bootstrap", "message:received"]
---

# KIVO Intent Injection Hook

KIVO 意图知识注入。

- `agent:bootstrap`：注入高价值知识条目作为 bootstrap 文件
- `message:received`：根据用户消息内容 FTS 检索相关知识，写入动态上下文文件供后续消息使用

## DB 路径解析顺序

1. `KIVO_DB_PATH` 环境变量
2. `<workspace>/projects/kivo/kivo.db`
3. `<workspace>/kivo.db`

workspace 路径来自 `OPENCLAW_WORKSPACE` 环境变量或 `~/.openclaw/workspace`。

## 依赖

- `better-sqlite3`：自动从全局、KIVO 包 node_modules、或 `@self-evolving-harness/kivo` 包中加载

## 安装

`kivo init` 会自动将此 hook 安装到 OpenClaw workspace。手动安装：

```bash
cp -r <kivo-package>/hooks/kivo-intent-injection/ ~/.openclaw/workspace/hooks/kivo-intent-injection/
```

安装后重启 Gateway 使其生效。
