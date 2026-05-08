# KIVO Web 修复计划

OpenClaw（pm-02 子Agent）| 2026-05-07

---

## SEVO 流水线入口

**阶段：Implement（bug fix 直接进入实现阶段）**

这些问题不涉及 spec 变更或架构调整，全部是已有功能的 bug 修复和构建问题，从 implement 阶段进入。

---

## 问题现状评估

### 已修复（无需再处理）

| 编号 | 问题 | 状态 | 证据 |
|------|------|------|------|
| P0 | 质量门禁测试超时 | ✅ 已修复 | `createMockClassifier` 已注入，23/23 测试通过（648ms） |
| P1-1 | evaluated 计数错误 | ✅ 已修复 | engine.ts L339: `evaluatedCount = context.activeEntries.length` |
| P1-2 | status_log 误杀风险 | ✅ 已修复 | quality-gate.ts: `normalizedContent.length <= 200` 长度豁免 |
| P1-3 | title_equals_content 缺归一化 | ✅ 已修复 | quality-gate.ts: 两侧均用 `.trim()` |
| P1-4 | evaluateQuality 死参数 type | ✅ 已修复 | 函数签名已移除 type 参数 |

### 待修复

| 编号 | 问题 | 优先级 | 说明 |
|------|------|--------|------|
| FIX-1 | `/kivo/artifacts` 返回 404 | P1 | 页面源码存在、build manifest 包含该路由，运行中服务器使用的是旧 build |
| FIX-2 | `/kivo/intent-governance` 返回 404 | P2 | FR-W13 已废弃（合并至知识库），页面从未创建，需加 redirect 优雅处理 |
| FIX-3 | P2-1 空白内容穿透 | P2 | `content.length < 50` 未 trim，50 个空格可穿透 |

---

## 修复任务拆分

### Task A：修复 P2-1 空白内容穿透（独立，无依赖）

**文件**：`/root/.openclaw/workspace/projects/kivo/src/pipeline/quality-gate.ts`

**改动**：
```typescript
// Before
if (entry.content.length < 50) {

// After
if (entry.content.trim().length < 50) {
```

**验证**：`npx vitest run __tests__/pipeline.test.ts` 全部通过

---

### Task B：添加 intent-governance redirect（独立，无依赖）

**文件**：`/root/.openclaw/workspace/projects/kivo/web/next.config.js`

**改动**：在 redirects 数组中添加：
```javascript
{
  source: '/intent-governance',
  destination: '/settings/intents',
  permanent: true,
},
{
  source: '/governance',
  destination: '/settings/intents',
  permanent: false,
},
```

**理由**：FR-W13 已废弃并合并至知识库，`/settings/intents` 是意图管理的当前入口。permanent: true 因为这是永久性的功能合并。

---

### Task C：Rebuild + Restart Web 服务（依赖 Task A、B 完成）

**步骤**：
1. `cd /root/.openclaw/workspace/projects/kivo/web`
2. `NODE_OPTIONS="--max-old-space-size=3072" npm run build`
3. 停止当前进程：`pkill -f "next start -p 3721"` 或找到 PID kill
4. 重启：`AUTH_PASSWORD=12345678 nohup npx next start -p 3721 >/tmp/kivo-web.log 2>&1 &`
5. 验证：`curl -s -o /dev/null -w "%{http_code}" http://localhost:3721/kivo/artifacts` 应返回 200（或 302 到 login）
6. 验证：`curl -s -o /dev/null -w "%{http_code}" http://localhost:3721/kivo/intent-governance` 应返回 308（permanent redirect）

---

### Task D（可选）：清理孤儿 governance API route

**文件**：`/root/.openclaw/workspace/projects/kivo/web/app/api/v1/governance/route.ts`

**评估**：该 API 注释引用 FR-W13（已废弃）。但 governance API 可能被其他地方调用（如 cron 脚本、hook）。需确认无调用方后再决定是否删除。

**建议**：暂不删除，标记为 deprecated 注释即可。后续治理时统一清理。

---

## 依赖关系与并行策略

```
Task A (P2-1 fix)  ──┐
                     ├──→ Task C (rebuild + restart)
Task B (redirect)  ──┘
                          
Task D (optional, independent)
```

- Task A 和 Task B 可并行执行（不同文件，无冲突）
- Task C 必须等 A、B 完成后执行（否则需要 rebuild 两次）
- Task D 独立，低优先级，可后续处理

---

## 执行建议

由于改动量极小（1 行代码 + 几行配置 + rebuild），建议单个编码 Agent 串行完成 A → B → C，预估 10 分钟内完成。不需要并行派发。

timeout 建议：1200s（中等开发任务，主要时间花在 build 上）
