/**
 * DomainGoalConstraints — 域目标驱动的行为约束
 *
 * FR-M02:
 * - AC1: 提取时判断内容是否在域范围内
 * - AC2: 检索排序考虑与 keyQuestions 的相关度
 * - AC3: 缺口检测参考 keyQuestions 生成调研建议
 * - AC4: 调研任务注入 researchBoundary 约束
 */

import type { DomainGoal } from './domain-goal-types.js';
import type { KnowledgeEntry } from '../types/index.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { cosineSimilarity } from '../utils/math.js';

export interface BoundaryCheckResult {
  inScope: boolean;
  reason: string;
  matchedSignals: string[];
}

export interface RelevanceBoost {
  entryId: string;
  baseScore: number;
  boostedScore: number;
  matchedQuestions: string[];
}

export interface GapSuggestion {
  question: string;
  covered: boolean;
  suggestion: string;
}

export interface ResearchConstraint {
  domainId: string;
  boundary: string;
  focusQuestions: string[];
  excludeTopics: string[];
}

export interface ConstraintEnforcementResult {
  allowed: boolean;
  reason?: string;
}

/** 共享 embedder 实例（模块级单例，避免每次调用重建） */
let _embedder: EmbeddingProvider | undefined;
function getEmbedder(): EmbeddingProvider {
  if (!_embedder) {
    _embedder = createEmbeddingProvider();
  }
  return _embedder;
}

/**
 * FR-M02: 入库前强制执行域目标约束。
 *
 * 对条目所属 domain/knowledgeDomain 匹配的域目标执行边界检查；违反 nonGoals 或研究边界时阻断入库。
 * 未匹配到域目标时放行，避免把"未配置"误判成"违规"。
 */
export async function enforceConstraints(
  entry: KnowledgeEntry,
  domainGoals: DomainGoal[],
): Promise<ConstraintEnforcementResult> {
  const entryDomain = entry.domain ?? entry.knowledgeDomain;
  const matchedGoals = domainGoals.filter((goal) => !entryDomain || goal.domainId === entryDomain);

  if (matchedGoals.length === 0) {
    return { allowed: true, reason: '未配置匹配的域目标约束，默认放行' };
  }

  const entryText = `${entry.title}\n${entry.summary}\n${entry.content}`;
  const failures: string[] = [];

  for (const goal of matchedGoals) {
    const result = await checkExtractionBoundary(entryText, goal);
    if (result.inScope) {
      return { allowed: true, reason: result.reason };
    }
    failures.push(`${goal.domainId}: ${result.reason}`);
  }

  return {
    allowed: false,
    reason: failures.join('; ') || '条目违反域目标约束',
  };
}

/**
 * AC1: 判断提取内容是否在域目标范围内
 *
 * 使用 BGE 向量余弦相似度判断域目标相关度。
 * 将 content 和 domain goal 的 purpose/boundary 文本分别 embedding，计算相似度。
 * 同时检查 nonGoals 的相似度，正向高于负向则判定为域内。
 */
export async function checkExtractionBoundary(
  content: string,
  goal: DomainGoal,
): Promise<BoundaryCheckResult> {
  const embedder = getEmbedder();

  const contentEmbedding = await embedder.embed(content);

  // 正向文本：purpose + researchBoundary + prioritySignals
  const positiveText = [
    goal.purpose,
    goal.researchBoundary,
    ...goal.prioritySignals,
  ].filter(Boolean).join(' ');

  const positiveEmbedding = await embedder.embed(positiveText);
  const positiveScore = cosineSimilarity(contentEmbedding, positiveEmbedding);

  // 负向文本：nonGoals
  let negativeScore = 0;
  if (goal.nonGoals.length > 0) {
    const negativeText = goal.nonGoals.join(' ');
    const negativeEmbedding = await embedder.embed(negativeText);
    negativeScore = cosineSimilarity(contentEmbedding, negativeEmbedding);
  }

  // 匹配的 prioritySignals（用向量相似度判断）
  const matchedSignals: string[] = [];
  for (const signal of goal.prioritySignals) {
    const signalEmbedding = await embedder.embed(signal);
    const sim = cosineSimilarity(contentEmbedding, signalEmbedding);
    if (sim > 0.6) {
      matchedSignals.push(signal);
    }
  }

  // 正向相似度高于负向 → 域内
  if (positiveScore > negativeScore && positiveScore > 0.3) {
    return {
      inScope: true,
      reason: `内容与域目标语义匹配（正向相似度 ${positiveScore.toFixed(3)} > 负向 ${negativeScore.toFixed(3)}）`,
      matchedSignals,
    };
  }

  // 正向和负向都很低 → 不确定，默认域内（宽松策略）
  if (positiveScore <= 0.3 && negativeScore <= 0.3) {
    return {
      inScope: true,
      reason: '内容与域目标语义相关度较低，但也未匹配非目标，默认保留',
      matchedSignals: [],
    };
  }

  // 负向相似度占优 → 域外
  return {
    inScope: false,
    reason: `内容与非目标语义匹配度更高（负向 ${negativeScore.toFixed(3)} vs 正向 ${positiveScore.toFixed(3)}）`,
    matchedSignals,
  };
}

/**
 * AC2: 检索排序权重提升
 *
 * 与 keyQuestions 相关的条目排序权重更高（使用向量相似度）。
 */
export async function boostByDomainGoal(
  entries: Array<{ entry: KnowledgeEntry; score: number }>,
  goal: DomainGoal,
): Promise<RelevanceBoost[]> {
  const embedder = getEmbedder();

  const results: RelevanceBoost[] = [];

  for (const { entry, score } of entries) {
    const entryText = `${entry.title} ${entry.content}`;
    const entryEmbedding = await embedder.embed(entryText);
    const matchedQuestions: string[] = [];

    for (const q of goal.keyQuestions) {
      const qEmbedding = await embedder.embed(q);
      const sim = cosineSimilarity(entryEmbedding, qEmbedding);
      if (sim > 0.5) {
        matchedQuestions.push(q);
      }
    }

    // Boost: 每匹配一个 keyQuestion，权重 +0.1，上限 +0.5
    const boost = Math.min(matchedQuestions.length * 0.1, 0.5);
    const boostedScore = Math.min(score + boost, 1.0);

    results.push({
      entryId: entry.id,
      baseScore: score,
      boostedScore,
      matchedQuestions,
    });
  }

  return results;
}

/**
 * AC3: 缺口检测 — 评估哪些 keyQuestions 尚未被知识库覆盖（使用向量相似度）
 */
export async function detectGaps(
  entries: KnowledgeEntry[],
  goal: DomainGoal,
): Promise<GapSuggestion[]> {
  const embedder = getEmbedder();
  const results: GapSuggestion[] = [];

  for (const question of goal.keyQuestions) {
    const qEmbedding = await embedder.embed(question);
    let covered = false;

    for (const entry of entries) {
      const text = `${entry.title} ${entry.content}`;
      const entryEmbedding = await embedder.embed(text);
      const sim = cosineSimilarity(qEmbedding, entryEmbedding);
      if (sim > 0.6) {
        covered = true;
        break;
      }
    }

    results.push({
      question,
      covered,
      suggestion: covered
        ? `"${question}" 已有知识覆盖`
        : `"${question}" 尚未被知识库覆盖，建议发起针对性调研`,
    });
  }

  return results;
}

/**
 * AC4: 生成调研任务的范围约束
 */
export function buildResearchConstraint(goal: DomainGoal): ResearchConstraint {
  return {
    domainId: goal.domainId,
    boundary: goal.researchBoundary,
    focusQuestions: [...goal.keyQuestions],
    excludeTopics: [...goal.nonGoals],
  };
}
