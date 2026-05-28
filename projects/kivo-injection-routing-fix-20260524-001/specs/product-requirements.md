# KIVO 学科注入路由挂载修复

OpenClaw（主会话）/ 2026-05-24

## 用户人群
KIVO 所有用户。

## 痛点
dev-02 实装的 FR-P03 AC7 学科注入（subject-aware-injector.ts 14KB，BGE 召回 + 一跳扩展 + 5 类关系分组 + 三层降级，单元测试 9 用例通过）挂载错配：挂在 KIVO npm 包内的 `before_prompt_build` 钩子，OpenClaw 实际跑的是 `hooks/kivo-intent-injection/handler.js` 走 `message:received` 事件。两条链路完全不通，生产环境一次都不会被调用。代码存在 ≠ 功能在跑。

实证（audit-01 P0-3）：dev-02 没写报告 + 自报「已接入主路由」与运行态事实矛盾，是典型「代码存在 ≠ 功能在跑」badcase。

## 原始需求
让 subject-aware-injector 真正在用户对话时被调用。挂到 OpenClaw 真正跑的事件链路上：`hooks/kivo-intent-injection/handler.js` 的 `message:received`。

## 用户体验流
1. 用户在 OpenClaw 任意 agent 对话框发消息
2. OpenClaw 触发 message:received 事件
3. hooks/kivo-intent-injection/handler.js 接收事件
4. handler 调用 KIVO subject-aware-injector 做 BGE 召回 + 一跳扩展 + 5 类分组
5. 注入结果合并入 prompt 上下文
6. agent 收到带学科知识的 prompt 后回答

## 功能需求

### FR-1 修复挂载点
subject-aware-injector 挂到 hooks/kivo-intent-injection/handler.js 的 message:received 链路。

### AC
- AC1 hooks/kivo-intent-injection/handler.js 在向量检索 + 图谱扩展之后调用 subject-aware-injector
- AC2 删除 KIVO npm 包内 before_prompt_build 钩子的挂载（或保留为内部 API，但不作为主路由）
- AC3 注入失败不阻塞 message:received（三层降级生效）
- AC4 注入结果格式与现有 hook 输出兼容（合并到 system prompt）

### FR-2 端到端验证
真实对话场景验证学科注入生效。

### AC
- AC1 在 OpenClaw 主会话发一条「概率论的大数定律是什么」类问题
- AC2 检查 logs 看 subject-aware-injector 是否被调用
- AC3 验证返回的 prompt 含相关 entries（题目 / 概念 / 方法）
- AC4 验证三层降级生效：mock LLM 失败 → fts → 空注入

## 测试用例
1. message:received 触发 → injector 被调用
2. 用户问与材料相关问题 → 注入相关 entries
3. 用户问无关问题 → 注入空（不报错）
4. LLM 失败 → fts 降级
5. fts 失败 → 空注入（不抛异常）
6. before_prompt_build 路径已移除或文档化为非主路由
