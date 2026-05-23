# KIVO 故障排查

## 错误码速查

| 错误码 | 分类 | 简述 |
|--------|------|------|
| KIVO-CFG-001 | 配置 | 配置文件缺失或无法读取 |
| KIVO-CFG-002 | 配置 | 配置校验失败 |
| KIVO-CFG-003 | Provider | LLM Provider 连接失败 |
| KIVO-STG-001 | 存储 | 数据库初始化失败 |
| KIVO-STG-002 | 存储 | 数据库读写失败 |
| KIVO-EMB-001 | Embedding | Embedding Provider 未配置 |
| KIVO-EMB-002 | Embedding | Embedding 生成失败 |
| KIVO-EXT-001 | 提取 | LLM 提取超时或返回格式错误 |
| KIVO-MIG-001 | 迁移 | 数据库迁移失败 |
| KIVO-GOV-001 | 治理 | 治理周期执行异常 |

## 常见问题

### 数据库初始化失败 (KIVO-STG-001)

**症状**：`kivo init` 报错 `Failed to initialize database`

**原因**：
- `better-sqlite3` 未正确安装（需要编译原生模块）
- 目标目录无写权限

**解决**：
```bash
# 重新安装原生依赖
npm rebuild better-sqlite3

# 检查目录权限
ls -la $(dirname ./kivo.db)

# 使用内存模式测试
KIVO_DB_PATH=":memory:" kivo health
```

### FTS5 不可用

**症状**：查询返回空结果，日志提示 `FTS5 extension not available`

**原因**：系统 SQLite 编译时未启用 FTS5

**解决**：
```bash
# 检查 FTS5 支持
node -e "const db = require('better-sqlite3')(':memory:'); db.exec('CREATE VIRTUAL TABLE t USING fts5(c)'); console.log('FTS5 OK')"

# 如果失败，重新安装 better-sqlite3（自带完整 SQLite）
npm install better-sqlite3 --build-from-source
```

### BGE Embedding 连接失败 (KIVO-EMB-002)

**症状**：`kivo capabilities` 显示 embedding 不可用

**原因**：Ollama 未运行或 bge-m3 模型未拉取

**解决**：
```bash
# 启动 Ollama
ollama serve

# 拉取模型
ollama pull bge-m3

# 验证
curl http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}'
```

### LLM 提取失败 (KIVO-EXT-001)

**症状**：`kivo ingest --llm` 报错 `OPENAI_API_KEY is not set`

**解决**：
```bash
export OPENAI_API_KEY=sk-your-key
# 或使用本地兼容 API
export OPENAI_BASE_URL=http://localhost:8000/v1
export OPENAI_API_KEY=dummy
```

### 数据库迁移失败 (KIVO-MIG-001)

**症状**：升级后 `kivo health` 报 schema 不匹配

**解决**：
```bash
# 查看迁移状态
kivo migrate status

# 执行迁移
kivo migrate up

# 如果迁移卡住，回滚后重试
kivo migrate down
kivo migrate up
```

迁移支持自动回滚——单步失败时已执行步骤会撤销。

### 配置校验失败 (KIVO-CFG-002)

**症状**：`kivo config-check` 报错

**解决**：
```bash
# 查看具体哪项不合法
kivo config-check

# 重新生成默认配置
kivo init --yes

# 检查环境变量
kivo env
```

### 质量门控拒绝写入

**症状**：`kivo add` 返回 `Entry rejected by quality gate`

**原因**：内容过短、重复度高、或置信度低于阈值

**解决**：
```bash
# 跳过质量门控
kivo add fact "标题" --content "详细内容..." --no-quality-gate

# 或提高内容质量：标题明确、内容 >50 字、设置合理 confidence
kivo add fact "标题" --content "充分描述..." --confidence 0.9
```

### Web 工作台启动失败

**症状**：`npm run dev` 报端口占用或依赖缺失

**解决**：
```bash
cd web
npm install
# 指定端口
PORT=3001 npm run dev
```

## 诊断命令

```bash
kivo health              # 综合健康检查
kivo config-check        # 配置校验
kivo capabilities        # 能力检测（DB/LLM/Embedding）
kivo env                 # 环境变量状态
kivo consistency-check   # 知识库一致性检查
```

## 获取帮助

如果以上方案未解决问题：
1. 运行 `kivo health` 并保存输出
2. 检查 Node.js 版本 >= 20
3. 确认 `better-sqlite3` 安装成功
