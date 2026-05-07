# KIVO 升级指南

## 升级步骤

```bash
# 1. 备份数据库
cp ./kivo.db ./kivo.db.bak

# 2. 升级包
npm install -g @self-evolving-harness/kivo@latest

# 3. 检查迁移状态
kivo migrate status

# 4. 执行数据库迁移（如有）
kivo migrate up

# 5. 验证
kivo health
kivo config-check
```

## 版本迁移历史

| 版本 | Schema 变更 | 说明 |
|------|-------------|------|
| 0.2.0 | ✅ 新增 domain 字段和域目标表 | 需执行 `kivo migrate up` |
| 0.3.0 | ✅ 新增度量记录表和访问控制表 | 需执行 `kivo migrate up` |
| 0.3.1 | ✅ 新增迁移记录表 | 需执行 `kivo migrate up` |
| 0.5.x → 0.6.x | 无 | 新增 Web 工作台 |
| 0.6.x → 0.7.x | 无 | 暗色模式、标签、双向链接、批量操作 |
| 0.7.x → 0.8.x | 无 | 双链输入、命令面板、种子数据 |
| 0.8.x → 0.9.x | 无 | 图谱增强、高级搜索、知识导出、时间线 |
| 0.9.x → 0.10.x | 无 | Cmd+K 命令面板、键盘快捷键体系 |

## 从 0.2.x 升级到 0.3.x

**Breaking Changes**：新增数据库表

```bash
kivo migrate up
```

迁移内容：
- 新增 `metrics` 表（度量记录）
- 新增 `access_control` 表（访问控制）

回滚方法：
```bash
kivo migrate down
```

## 从 0.5.x 升级到 0.6.x

**无 Schema 变更**，直接升级。

新增功能：Web 工作台（Next.js）

```bash
# 启动 Web 工作台
cd node_modules/@self-evolving-harness/kivo/web
npm install && npm run dev
```

## 从 0.6.x 升级到 0.7.x

**无 Schema 变更**，直接升级。

新增功能：
- 暗色模式（跟随系统）
- 标签系统（多标签分类）
- 双向链接（条目间引用）
- 批量操作（多选编辑/删除）

注意：自定义 CSS 需检查 `dark:` 变体兼容性。

## 从 0.9.x 升级到 0.10.x

**无 Schema 变更**，直接升级。

新增功能：
- Cmd+K 全局命令面板
- 键盘快捷键体系（Cmd+O 快速切换、Cmd+N 新建）

## 迁移故障处理

### 迁移失败

```bash
# 查看当前状态
kivo migrate status

# 回滚最后一步
kivo migrate down

# 重试
kivo migrate up
```

迁移支持自动回滚——单步失败时已执行步骤会撤销。

### 数据库损坏

```bash
# 从备份恢复
cp ./kivo.db.bak ./kivo.db

# 完整性检查
sqlite3 ./kivo.db "PRAGMA integrity_check;"
```

## 配置兼容性

升级后配置文件格式保持向后兼容。新增配置项使用默认值，无需手动修改。

验证配置：
```bash
kivo config-check
kivo env
```
