/**
 * ConflictDetector — 两阶段冲突判定
 * Phase 1: Embedding 余弦相似度粗筛（阈值 0.80）
 * Phase 2: LLM 精判（通过 SPI 调用，不绑定特定模型）
 *
 * 规则冲突补充：当知识类型为 intent 时，先走本地规则冲突检测路径，
 * 覆盖 FR-C01 AC1 要求的“同一场景的矛盾规则”。未命中规则冲突时，再走通用 LLM 精判。
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { EmbeddingProvider, LLMJudgeProvider } from './spi.js';
import type { ConflictRecord, ConflictVerdict } from './conflict-record.js';
import { v4 as uuid } from 'uuid';
import { cosineSimilarity } from '../utils/math.js';

export interface ConflictDetectorOptions {
  similarityThreshold?: number; // 默认 0.80
  embeddingProvider?: EmbeddingProvider;
  llmJudgeProvider: LLMJudgeProvider;
}

export class ConflictDetector {
  private readonly threshold: number;
  private readonly embedding?: EmbeddingProvider;
  private readonly llm: LLMJudgeProvider;

  constructor(options: ConflictDetectorOptions) {
    this.threshold = options.similarityThreshold ?? 0.80;
    this.embedding = options.embeddingProvider;
    this.llm = options.llmJudgeProvider;
  }

  /**
   * 检测新条目与已有条目集合的冲突
   * 返回冲突记录列表（可能为空 = 无冲突）
   */
  async detect(
    incoming: KnowledgeEntry,
    existingEntries: KnowledgeEntry[],
    options?: { similarityThreshold?: number },
  ): Promise<ConflictRecord[]> {
    if (existingEntries.length === 0) return [];

    const threshold = options?.similarityThreshold ?? this.threshold;

    // Phase 1: 粗筛候选对
    const candidates = await this.phase1Screen(incoming, existingEntries, threshold);

    if (candidates.length === 0) return [];

    // Phase 2: LLM 精判
    const conflicts: ConflictRecord[] = [];
    for (const candidate of candidates) {
      const verdict = await this.phase2Judge(incoming, candidate);
      if (verdict === 'conflict') {
        conflicts.push({
          id: uuid(),
          incomingId: incoming.id,
          existingId: candidate.id,
          verdict,
          detectedAt: new Date(),
          resolved: false,
        });
      }
    }

    return conflicts;
  }

  /**
   * Phase 1: Embedding 余弦相似度粗筛
   * 降级：无 Embedding 时用元数据匹配（同类型 + 标题关键词重叠 > 60%）
   * intent 类型额外比较规则场景文本，避免标题不同但规则对象相同的冲突漏检。
   */
  private async phase1Screen(
    incoming: KnowledgeEntry,
    existing: KnowledgeEntry[],
    threshold?: number,
  ): Promise<KnowledgeEntry[]> {
    const effectiveThreshold = threshold ?? this.threshold;
    // 只比较同类型条目
    const sameType = existing.filter(e => e.type === incoming.type && e.status === 'active');

    if (this.embedding) {
      const incomingVec = await this.embedding.embed(incoming.content);
      const candidates: KnowledgeEntry[] = [];

      for (const entry of sameType) {
        const existingVec = await this.embedding.embed(entry.content);
        const similarity = cosineSimilarity(incomingVec, existingVec);
        if (similarity >= effectiveThreshold) {
          candidates.push(entry);
        }
      }
      return candidates;
    }

    // 降级：元数据匹配
    return sameType.filter(entry => {
      const titleOverlap = keywordOverlap(incoming.title, entry.title);
      const contentOverlap = keywordOverlap(incoming.content, entry.content);
      if (incoming.type !== 'intent') {
        return titleOverlap > 0.6 || contentOverlap > 0.6;
      }

      const scenarioOverlap = keywordOverlap(
        this.ruleScenarioText(incoming),
        this.ruleScenarioText(entry)
      );

      return titleOverlap > 0.6 || contentOverlap > 0.6 || scenarioOverlap > 0.45;
    });
  }

  /**
   * Phase 2: LLM 语义对比精判
   */
  private async phase2Judge(
    incoming: KnowledgeEntry,
    existing: KnowledgeEntry
  ): Promise<ConflictVerdict> {
    if (this.isRuleConflict(incoming, existing)) {
      return 'conflict';
    }

    return this.llm.judgeConflict(incoming, existing);
  }

  /**
   * 规则冲突：同一场景给出相反约束。
   * 当前用 intent 类型承载规则条目，因此在 detector 内补一条专门路径。
   */
  private isRuleConflict(incoming: KnowledgeEntry, existing: KnowledgeEntry): boolean {
    if (incoming.type !== 'intent' || existing.type !== 'intent') {
      return false;
    }

    const scenarioOverlap = Math.max(
      keywordOverlap(incoming.title, existing.title),
      keywordOverlap(this.ruleScenarioText(incoming), this.ruleScenarioText(existing))
    );

    if (scenarioOverlap <= 0.45) {
      return false;
    }

    const incomingPolarity = this.rulePolarity(incoming.content);
    const existingPolarity = this.rulePolarity(existing.content);

    return incomingPolarity !== 'neutral'
      && existingPolarity !== 'neutral'
      && incomingPolarity !== existingPolarity;
  }

  private ruleScenarioText(entry: KnowledgeEntry): string {
    return `${entry.title} ${entry.content}`
      .toLowerCase()
      .replace(/\b(must not|should not|cannot|can't|never|forbid|forbidden|deny|denied|must|should|always|required|allow|allowed|permit|permitted)\b/g, ' ')
      .replace(/禁止|不得|不允许|不可|不能|必须|应当|需要|允许|可以/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private rulePolarity(text: string): 'allow' | 'deny' | 'neutral' {
    const normalized = text.toLowerCase();

    if (/(must not|should not|cannot|can't|never|forbid|forbidden|deny|denied|禁止|不得|不允许|不可|不能)/u.test(normalized)) {
      return 'deny';
    }

    if (/(must|should|always|required|allow|allowed|permit|permitted|必须|应当|需要|允许|可以)/u.test(normalized)) {
      return 'allow';
    }

    return 'neutral';
  }
}

/** 关键词重叠度（降级用） */
export function keywordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

export { cosineSimilarity } from '../utils/math.js';
