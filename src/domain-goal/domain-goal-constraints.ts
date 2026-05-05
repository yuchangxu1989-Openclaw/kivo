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

/**
 * AC1: 判断提取内容是否在域目标范围内
 *
 * 基于 purpose、researchBoundary、prioritySignals 做关键词匹配。
 * 超出范围的内容标记为"域外"不自动入库。
 */
export function checkExtractionBoundary(
  content: string,
  goal: DomainGoal,
): BoundaryCheckResult {
  const lower = content.toLowerCase();
  const matchedSignals: string[] = [];

  // 检查 prioritySignals 匹配
  for (const signal of goal.prioritySignals) {
    if (lower.includes(signal.toLowerCase())) {
      matchedSignals.push(signal);
    }
  }

  // 检查 purpose 关键词匹配
  const purposeWords = extractKeywords(goal.purpose);
  const purposeHits = purposeWords.filter(w => lower.includes(w));

  // 检查 researchBoundary 关键词
  const boundaryWords = extractKeywords(goal.researchBoundary);
  const boundaryHits = boundaryWords.filter(w => lower.includes(w));

  // 检查 nonGoals — 如果内容主要匹配 nonGoals，标记为域外
  const nonGoalWords = goal.nonGoals.flatMap(ng => extractKeywords(ng));
  const nonGoalHits = nonGoalWords.filter(w => lower.includes(w));

  const positiveScore = matchedSignals.length + purposeHits.length + boundaryHits.length;
  const negativeScore = nonGoalHits.length;

  // 有正向匹配且正向大于负向 → 域内
  if (positiveScore > 0 && positiveScore >= negativeScore) {
    return {
      inScope: true,
      reason: `内容与域目标匹配（${positiveScore} 个正向信号）`,
      matchedSignals,
    };
  }

  // 无正向匹配但也无负向匹配 → 不确定，默认域内（宽松策略）
  if (positiveScore === 0 && negativeScore === 0) {
    return {
      inScope: true,
      reason: '内容未明确匹配域目标，但也未匹配非目标，默认保留',
      matchedSignals: [],
    };
  }

  // 负向匹配占优 → 域外
  return {
    inScope: false,
    reason: `内容与非目标匹配度更高（${negativeScore} 个非目标信号 vs ${positiveScore} 个正向信号）`,
    matchedSignals,
  };
}

/**
 * AC2: 检索排序权重提升
 *
 * 与 keyQuestions 相关的条目排序权重更高。
 */
export function boostByDomainGoal(
  entries: Array<{ entry: KnowledgeEntry; score: number }>,
  goal: DomainGoal,
): RelevanceBoost[] {
  const questionKeywords = goal.keyQuestions.flatMap(q => extractKeywords(q));

  return entries.map(({ entry, score }) => {
    const entryText = `${entry.title} ${entry.content}`.toLowerCase();
    const matchedQuestions: string[] = [];

    for (const q of goal.keyQuestions) {
      const qWords = extractKeywords(q);
      const hits = qWords.filter(w => entryText.includes(w));
      if (hits.length > 0) {
        matchedQuestions.push(q);
      }
    }

    // Boost: 每匹配一个 keyQuestion，权重 +0.1，上限 +0.5
    const boost = Math.min(matchedQuestions.length * 0.1, 0.5);
    const boostedScore = Math.min(score + boost, 1.0);

    return {
      entryId: entry.id,
      baseScore: score,
      boostedScore,
      matchedQuestions,
    };
  });
}

/**
 * AC3: 缺口检测 — 评估哪些 keyQuestions 尚未被知识库覆盖
 */
export function detectGaps(
  entries: KnowledgeEntry[],
  goal: DomainGoal,
): GapSuggestion[] {
  return goal.keyQuestions.map(question => {
    const qWords = extractKeywords(question);
    const covered = entries.some(entry => {
      const text = `${entry.title} ${entry.content}`.toLowerCase();
      const hits = qWords.filter(w => text.includes(w));
      return hits.length >= Math.ceil(qWords.length * 0.5);
    });

    return {
      question,
      covered,
      suggestion: covered
        ? `"${question}" 已有知识覆盖`
        : `"${question}" 尚未被知识库覆盖，建议发起针对性调研`,
    };
  });
}

/**
 * AC4: 生成调研任务的范围约束
 */
export function buildResearchConstraint(goal: DomainGoal): ResearchConstraint {
  // 从 keyQuestions 中筛选未覆盖的作为 focusQuestions
  return {
    domainId: goal.domainId,
    boundary: goal.researchBoundary,
    focusQuestions: [...goal.keyQuestions],
    excludeTopics: [...goal.nonGoals],
  };
}

/** 从文本中提取关键词（简单分词，去停用词） */
function extractKeywords(text: string): string[] {
  if (!text) return [];
  const stopWords = new Set([
    '的', '了', '在', '是', '和', '与', '或', '对', '从', '到', '为', '被',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to',
    'for', 'of', 'and', 'or', 'but', 'not', 'with', 'by', 'as', 'this', 'that',
  ]);
  return text
    .toLowerCase()
    .split(/[\s,;.!?，。；！？、]+/)
    .filter(w => w.length > 1 && !stopWords.has(w));
}
