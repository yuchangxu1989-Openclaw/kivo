# KIVO API 参考

## CLI 命令

### kivo init

初始化知识库，生成配置文件和数据库。

```bash
kivo init [--yes|-y] [--interactive|-i]
```

| 参数 | 说明 |
|------|------|
| `--yes`, `-y` | 非交互模式，使用默认值 |
| `--interactive`, `-i` | 交互模式，逐项确认 |

初始化后自动执行工作区知识导入。

### kivo add

添加单条知识。

```bash
kivo add <type> <title> [options]
```

| 参数 | 说明 |
|------|------|
| `type` | 知识类型：fact/concept/rule/procedure/heuristic/reference |
| `title` | 知识标题 |
| `--content` | 知识内容 |
| `--tags` | 标签（逗号分隔） |
| `--source` | 来源标识 |
| `--confidence` | 置信度 0-1（默认 0.8） |
| `--domain` | 所属领域 |
| `--status` | 状态 |
| `--json` | JSON 格式输出 |
| `--no-quality-gate` | 跳过质量门控 |

### kivo query

查询知识库。

```bash
kivo query <text> [options]
```

| 参数 | 说明 |
|------|------|
| `--nature` | 按性质过滤：fact/concept/rule/procedure/heuristic |
| `--function` | 按功能过滤：routing/quality_gate/context_enrichment/decision_support/correction |
| `--domain` | 按领域过滤 |

### kivo list

列出知识条目。

```bash
kivo list [--type <type>] [--limit N] [--offset N] [--status <status>] [--json]
```

### kivo update

更新知识条目。

```bash
kivo update <id> [--title "..."] [--content "..."] [--tags "a,b"] [--confidence 0.8] [--status active] [--json]
```

### kivo delete

删除知识条目。

```bash
kivo delete <id> [--force] [--json]
```

### kivo ingest

批量导入知识。

```bash
kivo ingest [--dir <paths>] [--files <paths>] [--llm] [--json] [--no-quality-gate]
```

| 参数 | 说明 |
|------|------|
| `--dir` | 目录路径（逗号分隔多个） |
| `--files` | 文件路径（逗号分隔多个） |
| `--llm` | 启用 LLM 辅助提取 |
| `--no-quality-gate` | 跳过质量门控 |

### kivo health

系统健康检查。

```bash
kivo health
```

### kivo config-check

校验配置完整性。

```bash
kivo config-check
```

### kivo capabilities

检测可用能力（数据库、LLM、Embedding）。

```bash
kivo capabilities
```

### kivo env

列出所有环境变量及当前值。

```bash
kivo env
```

### kivo migrate

数据库迁移管理。

```bash
kivo migrate status    # 查看迁移状态
kivo migrate up        # 执行迁移
kivo migrate down      # 回滚迁移
```

### kivo governance

知识治理。

```bash
kivo governance run                        # 执行治理周期
kivo governance report [--limit N] [--json] # 查看治理报告
kivo governance config                     # 查看治理配置
kivo governance config --set key=value     # 修改治理参数
```

### kivo consistency-check

知识库一致性检查。

```bash
kivo consistency-check [--threshold 0.8] [--types "fact,rule"] [--domains "eng"] [--strict] [--json]
```

### kivo extract-sessions

从会话历史提取知识（FR-A05）。

```bash
kivo extract-sessions [--since DATE] [--limit N] [--candidates PATH] [--dry-run] [--no-quality-gate]
```

### kivo deduplicate

知识去重。

```bash
kivo deduplicate [scan|merge] [--threshold 0.8] [--domain "..."] [--auto] [--json]
```

### kivo enrich-intents

意图丰富化。

```bash
kivo enrich-intents [--batch-size N] [--dry-run] [--json]
```

### kivo audit-value

知识价值审计（FR-N04）。

```bash
kivo audit-value [--domain "..."] [--limit N] [--apply] [--json]
```

### kivo cron

定时任务（治理+导入+去重）。

```bash
kivo cron [--full] [--json] [--no-quality-gate]
```

---

## Web API 端点

基础路径：`/api/v1`

### 知识管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/knowledge` | 列出知识条目 |
| POST | `/api/v1/knowledge` | 创建知识条目 |
| GET | `/api/v1/knowledge/:id` | 获取单条知识 |
| PUT | `/api/v1/knowledge/:id` | 更新知识条目 |
| DELETE | `/api/v1/knowledge/:id` | 删除知识条目 |
| GET | `/api/v1/knowledge/:id/content` | 获取知识内容 |
| PATCH | `/api/v1/knowledge/:id/status` | 更新状态 |

### 搜索

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/search?q=<query>` | 全文搜索 |

### 意图管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/intents` | 列出意图 |
| POST | `/api/v1/intents` | 创建意图 |
| PUT | `/api/v1/intents` | 更新意图 |
| DELETE | `/api/v1/intents` | 删除意图 |
| POST | `/api/v1/intents/sync` | 触发模型同步 |
| GET | `/api/v1/intents/:id/stats` | 意图命中统计 |

### 分析

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/analytics/coverage` | 知识覆盖率 |
| GET | `/api/v1/analytics/dispatch` | 分发统计 |
| GET | `/api/v1/analytics/utilization` | 利用率分析 |
| GET | `/api/v1/stats` | 总体统计 |

### 仪表盘

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/dashboard/summary` | 仪表盘摘要 |
| GET | `/api/v1/activity` | 活动记录 |
| GET | `/api/v1/activity/stream` | 活动流（SSE） |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/conflicts` | 冲突列表 |
| POST | `/api/v1/conflicts/:id/resolve` | 解决冲突 |
| GET | `/api/v1/gaps` | 知识缺口 |
| GET | `/api/v1/graph` | 知识图谱数据 |
| GET | `/api/v1/dictionary` | 术语词典 |
| GET/POST | `/api/v1/imports` | 导入任务管理 |
| GET | `/api/v1/imports/:id` | 导入任务详情 |
| POST | `/api/v1/research` | 研究任务 |

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| POST | `/api/auth/register` | 注册 |
| GET | `/api/auth/verify` | 验证 Token |
| GET | `/api/auth/roles` | 角色列表 |
