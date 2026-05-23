# KIVO 配置参考

这份文档说明 KIVO 当前公开的配置项、环境变量映射、优先级规则和起步示例。内容基于：

- `src/config/types.ts`
- `src/config/env-loader.ts`
- `src/config/config-validator.ts`
- `src/cli/init.ts`

## 配置优先级

KIVO 推荐按下面的顺序解析配置：

1. 环境变量
2. 配置文件
3. 默认值

也就是：环境变量 > 配置文件 > 默认值。

在代码里可以这样合并：

```ts
import { readFileSync } from 'node:fs';
import { mergeWithEnv } from '@self-evolving-harness/kivo';

const fileConfig = JSON.parse(readFileSync('./kivo.config.json', 'utf-8'));
const config = mergeWithEnv(fileConfig);
```

说明：

- `mergeWithEnv(fileConfig)` 会把环境变量覆盖到配置文件之上
- 默认值由 `DEFAULT_CONFIG` 提供
- 当前 CLI 的 `health`、`capabilities`、`config-check` 命令主要基于默认值 + 环境变量运行

## 默认值

KIVO 当前内置默认值如下：

```json
{
  "dbPath": "./kivo.db",
  "mode": "standalone",
  "conflictThreshold": 0.85
}
```

## 配置项总览

### `dbPath`

- 类型：`string`
- 必填：是
- 默认值：`./kivo.db`
- 作用：指定 SQLite 数据库文件路径
- 特殊值：`":memory:"` 表示使用内存数据库

使用建议：

- 本地开发可直接用 `./kivo.db`
- 临时测试可用 `:memory:`
- 生产环境建议放到持久化目录，并确保目录可写

校验规则：

- 必须是非空字符串
- 缺失时配置校验失败

### `mode`

- 类型：`'standalone' | 'hosted'`
- 必填：否
- 默认值：`standalone`
- 作用：声明 KIVO 的运行模式

取值说明：

- `standalone`：单机或独立运行
- `hosted`：嵌入宿主应用运行

校验规则：

- 只能是 `standalone` 或 `hosted`

### `conflictThreshold`

- 类型：`number`
- 必填：否
- 默认值：`0.85`
- 作用：冲突检测阈值

校验规则：

- 必须是 0 到 1 之间的数字

使用建议：

- 较高值：更保守，减少误报
- 较低值：更敏感，更容易触发冲突检查

### `embedding`

- 类型：`EmbeddingConfig | undefined`
- 必填：否
- 默认值：未配置
- 作用：启用语义搜索能力

如果不配置：

- 系统仍可运行
- 搜索模式会退化为 `keyword`

#### `embedding.provider`

- 类型：`'openai' | 'local'`
- 必填：是（当 `embedding` 存在时）
- 作用：选择 embedding provider

取值说明：

- `openai`：通过 OpenAI Embedding API 生成向量
- `local`：使用本地 embedding 实现

校验规则：

- 只能是 `openai` 或 `local`

#### `embedding.options`

- 类型：对象
- 必填：否
- 作用：provider 级参数

支持字段：

##### `embedding.options.apiKey`

- 类型：`string`
- 必填：当 `embedding.provider = 'openai'` 时必填
- 作用：OpenAI API Key

##### `embedding.options.model`

- 类型：`string`
- 必填：否
- 作用：指定 embedding 模型名称
- 常见示例：`text-embedding-3-small`

##### `embedding.options.dimensions`

- 类型：`number`
- 必填：否
- 作用：向量维度
- 常见用途：本地 embedding 或限制输出维度时显式指定

##### `embedding.options.cacheSize`

- 类型：`number`
- 必填：否
- 作用：embedding 缓存大小
- 使用场景：频繁重复检索时减少重复向量化

### `embeddingProvider`

- 类型：`EmbeddingProvider`
- 必填：否
- 作用：通过代码直接注入 embedding SPI 实现

说明：

- 这是程序化接入入口，不是环境变量配置项
- 适合宿主系统传入自定义 provider 实现

### `llmProvider`

- 类型：`LLMJudgeProvider`
- 必填：否
- 作用：通过代码直接注入冲突判定 LLM

说明：

- 当前 `env-loader` 没有为 `llmProvider` 提供环境变量映射
- 如果不传，KIVO 会走默认 LLM provider 工厂或降级逻辑
- `kivo capabilities` 是否显示 `llm` 可用，取决于传入配置对象里是否存在 `llmProvider`

### `pipelineOptions`

- 类型：对象
- 必填：否
- 作用：给抽取流水线传参

当前公开字段：

#### `pipelineOptions.extractor`

- 类型：`ExtractorOptions`
- 作用：控制文本抽取器行为

可用字段：

##### `pipelineOptions.extractor.minContentLength`

- 类型：`number`
- 作用：最小可抽取段落长度

##### `pipelineOptions.extractor.classifier`

- 类型：`Classifier`
- 作用：自定义分类器实例

##### `pipelineOptions.extractor.minConfidence`

- 类型：`number`
- 作用：低于该阈值的知识条目会被标记为 `pending`，否则为 `active`

## 环境变量列表

以下环境变量由 `src/config/env-loader.ts` 直接支持。

### `KIVO_DB_PATH`

- 映射到：`dbPath`
- 示例：

```bash
export KIVO_DB_PATH=./kivo.db
```

### `KIVO_CONFLICT_THRESHOLD`

- 映射到：`conflictThreshold`
- 类型转换：字符串会转成数字
- 示例：

```bash
export KIVO_CONFLICT_THRESHOLD=0.9
```

### `KIVO_MODE`

- 映射到：`mode`
- 示例：

```bash
export KIVO_MODE=standalone
```

### `KIVO_EMBEDDING_PROVIDER`

- 映射到：`embedding.provider`
- 可选值：`openai`、`local`
- 示例：

```bash
export KIVO_EMBEDDING_PROVIDER=openai
```

### `KIVO_EMBEDDING_API_KEY`

- 映射到：`embedding.options.apiKey`
- 示例：

```bash
export KIVO_EMBEDDING_API_KEY=your_api_key
```

### `KIVO_EMBEDDING_MODEL`

- 映射到：`embedding.options.model`
- 示例：

```bash
export KIVO_EMBEDDING_MODEL=text-embedding-3-small
```

### `KIVO_EMBEDDING_DIMENSIONS`

- 映射到：`embedding.options.dimensions`
- 类型转换：字符串会转成数字
- 示例：

```bash
export KIVO_EMBEDDING_DIMENSIONS=1536
```

### `KIVO_EMBEDDING_CACHE_SIZE`

- 映射到：`embedding.options.cacheSize`
- 类型转换：字符串会转成数字
- 示例：

```bash
export KIVO_EMBEDDING_CACHE_SIZE=1000
```

### `AUTH_PASSWORD`

- 映射到：Web 工作台登录密码
- 不映射到 `kivo.config.json`，仅用于 Web 端认证
- 示例：

```bash
export AUTH_PASSWORD='your-password'
```

说明：

- 仅在启动 Web 工作台时需要
- 不设置时 Web 端无法登录
- CLI 和 API 调用不需要此变量

## 示例配置文件

### 最小配置

```json
{
  "dbPath": "./kivo.db",
  "mode": "standalone",
  "conflictThreshold": 0.85,
  "embedding": null
}
```

这份结构和 `kivo init --yes` 生成结果一致，适合先跑通本地数据库和关键词搜索。

### 开启 OpenAI Embedding 的配置

```json
{
  "$schema": "https://kivo.dev/config-schema.json",
  "dbPath": "./kivo.db",
  "mode": "standalone",
  "conflictThreshold": 0.85,
  "embedding": {
    "provider": "openai",
    "options": {
      "apiKey": "${KIVO_EMBEDDING_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "cacheSize": 1000
    }
  }
}
```

### 代码中注入完整配置

```ts
import { Kivo } from '@self-evolving-harness/kivo';

const kivo = new Kivo({
  dbPath: './kivo.db',
  mode: 'hosted',
  conflictThreshold: 0.9,
  embedding: {
    provider: 'local',
    options: {
      dimensions: 1536,
      cacheSize: 2000,
    },
  },
  llmProvider: {
    async judgeConflict(incoming, existing) {
      return 'compatible';
    },
  },
  pipelineOptions: {
    extractor: {
      minContentLength: 30,
      minConfidence: 0.4,
    },
  },
});
```

## 配置校验规则

KIVO 当前会检查下面这些问题：

- `dbPath` 缺失或不是字符串
- `conflictThreshold` 不是 0 到 1 之间的数字
- `mode` 不是 `standalone` 或 `hosted`
- `embedding.provider` 不是 `openai` 或 `local`
- `embedding.provider = 'openai'` 但没有 `apiKey`

你可以用下面的命令快速检查：

```bash
npx kivo config-check
```

## 常见配置策略

### 只做关键词搜索

适合先验证最小闭环：

```bash
export KIVO_DB_PATH=./kivo.db
export KIVO_MODE=standalone
```

特点：

- 不依赖 embedding
- `kivo capabilities` 里会显示 `Search mode: keyword`

### 开启语义搜索

```bash
export KIVO_DB_PATH=./kivo.db
export KIVO_MODE=standalone
export KIVO_EMBEDDING_PROVIDER=openai
export KIVO_EMBEDDING_API_KEY=your_api_key
export KIVO_EMBEDDING_MODEL=text-embedding-3-small
```

特点：

- 可用 `semanticSearch()`
- `kivo capabilities` 会显示 `Search mode: semantic`

### 宿主系统注入 LLM 冲突判定

如果你的宿主已有统一 LLM 调度层，建议在代码里直接传 `llmProvider`，这样不需要为 KIVO 再单独设计一套环境变量。

## 配置排查建议

出问题时，建议按这个顺序检查：

1. `npx kivo env` 看环境变量是否真的生效
2. `npx kivo config-check` 看字段是否合法
3. `npx kivo health` 看依赖和 embedding 状态
4. 核对数据库路径是否可写
5. 如果你用了配置文件，确认程序里是否真的调用了 `mergeWithEnv()`
