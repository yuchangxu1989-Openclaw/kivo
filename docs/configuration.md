# KIVO 配置参考

## 配置优先级

环境变量 > kivo.config.json > 默认值

## 配置文件

`kivo init --yes` 生成 `kivo.config.json`：

```json
{
  "dbPath": "./kivo.db",
  "mode": "standalone",
  "conflictThreshold": 0.85
}
```

## 核心配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `dbPath` | string | `./kivo.db` | SQLite 数据库路径，`:memory:` 为内存模式 |
| `mode` | `standalone` \| `hosted` | `standalone` | 运行模式 |
| `conflictThreshold` | number (0-1) | `0.85` | 冲突检测相似度阈值 |

## 环境变量

| 环境变量 | 对应配置 | 说明 |
|----------|----------|------|
| `KIVO_DB_PATH` | `dbPath` | 数据库文件路径 |
| `KIVO_MODE` | `mode` | 运行模式 |
| `KIVO_CONFLICT_THRESHOLD` | `conflictThreshold` | 冲突阈值 |
| `OPENAI_API_KEY` | — | LLM 提取所需 API Key |
| `OPENAI_BASE_URL` | — | OpenAI 兼容 API 地址（默认 `https://api.openai.com/v1`） |
| `OPENAI_MODEL` | — | LLM 模型名（默认 `gpt-4o-mini`） |
| `KIVO_EMBEDDING_PROVIDER` | `embedding.provider` | Embedding 提供者（`bge` / `openai`） |
| `KIVO_EMBEDDING_MODEL` | `embedding.model` | Embedding 模型名 |
| `KIVO_EMBEDDING_ENDPOINT` | `embedding.endpoint` | Embedding 服务地址 |

## Embedding 配置

### BGE（本地 Ollama）

```json
{
  "embedding": {
    "provider": "bge",
    "model": "bge-m3",
    "endpoint": "http://localhost:11434"
  }
}
```

### OpenAI

```json
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "sk-..."
  }
}
```

未配置 embedding 时，KIVO 使用 FTS5 全文检索作为降级方案。

## LLM Provider 配置

LLM 用于知识提取（`kivo ingest --llm`）和会话分析：

```bash
export OPENAI_API_KEY=sk-your-key
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-4o-mini
```

支持任何 OpenAI 兼容 API（如 DeepSeek、本地 vLLM）。

## 治理配置

通过 CLI 管理：

```bash
kivo governance config                          # 查看当前配置
kivo governance config --set interval=daily     # 设置治理周期
kivo governance config --set autoMerge=true     # 自动合并重复
```

## 质量门控

`kivo add` 默认启用质量门控，跳过低质量条目。禁用：

```bash
kivo add fact "标题" --content "内容" --no-quality-gate
kivo ingest --dir ./docs --no-quality-gate
```

## 配置校验

```bash
kivo config-check    # 校验配置完整性
kivo env             # 列出所有环境变量及当前值
kivo capabilities    # 检测可用能力（LLM/Embedding/DB）
```

## 最小配置示例

只需一个环境变量即可运行：

```bash
export KIVO_DB_PATH=./my-knowledge.db
kivo init --yes
kivo health
```
