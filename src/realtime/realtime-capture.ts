import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../adapter/llm-provider.js';
import type {
  KnowledgeEntry,
  KnowledgeSource,
  KnowledgeScope,
  TemporalStatus,
} from '../types/index.js';
import { KnowledgeRepository } from '../repository/knowledge-repository.js';
import { SQLiteProvider } from '../repository/sqlite-provider.js';
import {
  clampConfidence,
  extractJsonBlock,
  generateTitle,
  isKnowledgeType,
} from '../extraction/extraction-utils.js';

const KNOWLEDGE_SCOPES: readonly KnowledgeScope[] = ['global', 'product', 'project', 'session', 'agent'];
const TEMPORAL_STATUSES: readonly TemporalStatus[] = ['permanent', 'has_expiry', 'needs_review'];

function asScope(value: unknown): KnowledgeScope | undefined {
  return typeof value === 'string' && (KNOWLEDGE_SCOPES as readonly string[]).includes(value)
    ? (value as KnowledgeScope)
    : undefined;
}

function asTemporalStatus(value: unknown): TemporalStatus | undefined {
  return typeof value === 'string' && (TEMPORAL_STATUSES as readonly string[]).includes(value)
    ? (value as TemporalStatus)
    : undefined;
}

export interface RealtimeCaptureOptions {
  dbPath: string;
  llmProvider: LLMProvider;
  minConfidence?: number;
  dedupSimilarityThreshold?: number;
  /**
   * When true, semantic dedup failures are treated as non-fatal and the entry is
   * written without an embedding. Realtime hooks use this to avoid losing
   * high-value corrections when the vector service is temporarily unavailable.
   */
  allowWriteOnDedupError?: boolean;
  configDir?: string;
  timeoutMs?: number;
  messageId?: string;
  sourceTimestamp?: string | Date;
}

export interface CaptureResult {
  captured: number;
  entries: KnowledgeEntry[];
  skipped: number;
}

const EXTRACTION_PROMPT = `从以下单轮用户消息中收集可用于知识萃取的素材。

## 核心原则
你在做实时知识提取。先用 LLM 语义判断这条消息是否包含长期有效、跨场景可复用、抽象后能改变 agent 行为的知识；如果没有，返回 []。禁止用关键词匹配、正则、FTS5 或规则引擎承担语义理解职责。

## 准入门禁（三重测试）
每条候选知识必须全部通过：
1. 时效性测试：三个月后仍然有效。临时状态、一次性安排、排查中间步骤、当前配置、待办事项不通过。
2. 跨场景测试：换项目/团队/场景仍有指导价值。绑定特定项目、特定 agent、特定时间窗口的不通过。
3. 抽象性测试：去掉具体人名、项目名、时间后仍有指导价值。原始事件记录、具体操作指令、系统铁律原文搬运不通过。

## 采集方向
- 只采集有机会沉淀成长期机制的知识。
- 每条知识必须能回答：它让 agent 在什么场景下避免什么错误。
- 行为约束/铁律/系统 prompt 注入内容不是知识素材；要抽象成理解模型后才可收集。
- 任务派发指令、一次性调度安排、排查步骤记录、具体文件路径、命令行、配置片段，全部禁止采集。
- 术语定义可作为 fact 收集；通用常识不收集。

## 正例
{"type":"methodology","title":"修复问题先堵根因","content":"修复问题时先定位并堵住根因，再处理表面症状；否则症状会反复出现。","summary":"问题修复应先堵根因","confidence":0.9,"tags":["根因","修复"]}
{"type":"methodology","title":"语义理解禁用规则引擎","content":"涉及语义判断的环节必须用 LLM 或向量检索，关键词匹配和正则表达式不能承担语义理解职责。","summary":"语义判断不能用规则冒充","confidence":0.9,"tags":["语义理解","LLM"]}

## 负例
✖ "今天先派 cc 修 KIVO，codex 做 AEO" ← 一次性调度决策
✖ "禁止主会话执行超过30秒的命令" ← 行为约束原文搬运
✖ "执行 systemctl --user restart kivo-web" ← 命令行操作
✖ "当前用 penguin provider，agent 池有 12 个" ← 当前配置
✖ "需要加个监控脚本" ← 待办事项

## 输出格式
只返回 JSON 数组，不要解释。字段：
- type: fact / methodology / decision / experience / intent / meta
- title: ≤20字完整短标题，不能照抄原文
- content: 自包含描述，说明场景、原则、原因
- summary: 一句话摘要
- confidence: 0-1
- tags: 字符串数组

没有通过三重测试的内容返回 []。

用户消息：
`;

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Realtime capture step timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function remainingMs(deadline?: number): number | undefined {
  if (!deadline) return undefined;
  return Math.max(0, deadline - Date.now());
}

/**
 * Capture knowledge from a real-time message.
 * Calls the extraction engine, filters by confidence, and persists to DB.
 */
export async function captureFromMessage(
  message: string,
  sessionId: string,
  options: RealtimeCaptureOptions,
): Promise<CaptureResult> {
  const { llmProvider, dbPath, minConfidence = 0.7 } = options;
  const deadline = options.timeoutMs && options.timeoutMs > 0 ? Date.now() + options.timeoutMs : undefined;

  if (!message.trim()) {
    return { captured: 0, entries: [], skipped: 0 };
  }

  // 1. Call LLM to extract knowledge candidates
  const prompt = EXTRACTION_PROMPT + message;
  const raw = await withTimeout(llmProvider.complete(prompt), remainingMs(deadline));
  const extracted = extractJsonBlock(raw);

  let candidates: Array<{
    type?: string;
    title?: string;
    content?: string;
    summary?: string;
    confidence?: number;
    tags?: string[];
    scope?: string;
    temporal_status?: string;
    source_anchor?: string;
  }>;

  try {
    const parsed = typeof extracted === 'string' ? JSON.parse(extracted) : extracted;
    candidates = Array.isArray(parsed) ? parsed : [];
  } catch {
    // LLM returned non-JSON; no knowledge extracted
    return { captured: 0, entries: [], skipped: 0 };
  }

  // 2. Filter by confidence threshold
  const now = options.sourceTimestamp ? new Date(options.sourceTimestamp) : new Date();
  const source: KnowledgeSource = {
    type: 'conversation',
    reference: options.messageId ? `session:${sessionId}:message:${options.messageId}` : `session:${sessionId}`,
    timestamp: now,
    context: message.slice(0, 200),
  };

  const entries: KnowledgeEntry[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const confidence = clampConfidence(candidate.confidence);
    if (confidence < minConfidence) {
      skipped++;
      continue;
    }

    const type = isKnowledgeType(candidate.type) ? candidate.type : 'fact';
    const content = candidate.content ?? message;
    const title = candidate.title ?? generateTitle(content);

    const scope = asScope(candidate.scope);
    const temporalStatus = asTemporalStatus(candidate.temporal_status);
    const sourceAnchor =
      typeof candidate.source_anchor === 'string' ? candidate.source_anchor.trim() : '';

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      type,
      title,
      content,
      summary: candidate.summary ?? title,
      source,
      confidence,
      status: 'active',
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      metadata: {
        ...(scope ? { scope } : {}),
        ...(temporalStatus ? { temporal_status: temporalStatus } : {}),
        source_anchor: sourceAnchor,
        domainData: {
          realtimeCapture: {
            sessionId,
            messageId: options.messageId ?? null,
            capturedAt: now.toISOString(),
          },
        },
      },
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    entries.push(entry);
  }

  // 3. Persist to database through the shared repository path.
  // Realtime capture runs the shared LLM value gate, then saves through
  // SQLiteProvider with the existing hard confidence gate and BGE semantic
  // dedup threshold pinned to 0.92. If the BGE/dedup step is unavailable, the
  // provider retries with embedding skipped so valuable realtime knowledge is
  // not dropped.
  const writtenEntries: KnowledgeEntry[] = [];
  if (entries.length > 0) {
    const provider = new SQLiteProvider({ dbPath, configDir: options.configDir });
    const repo = new KnowledgeRepository(provider);
    try {
      for (const entry of entries) {
        const timeoutMs = remainingMs(deadline);
        if (timeoutMs !== undefined && timeoutMs <= 0) {
          throw new Error(`Realtime capture timed out after ${options.timeoutMs}ms`);
        }

        if (await repo.save(entry, {
          skipDedup: true,
          conflictThreshold: options.dedupSimilarityThreshold ?? 0.92,
          allowWriteOnDedupError: options.allowWriteOnDedupError,
          qualityGateTimeoutMs: timeoutMs,
        })) {
          writtenEntries.push(entry);
        }
      }
    } finally {
      await repo.close();
    }
  }

  return { captured: writtenEntries.length, entries: writtenEntries, skipped };
}
