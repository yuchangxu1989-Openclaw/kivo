/**
 * MergeDetector — 重复/合并候选检测
 * FR-K01 AC1（merge_detection 阶段）
 *
 * 检测新提取的条目之间以及与已有条目之间的重复/合并候选。
 * 使用关键词重叠度作为降级检测策略（无 embedding 依赖）。
 */

import type { KnowledgeEntry } from '../types/index.js';

export interface MergeCandidate {
  entryA: string; // id
  entryB: string; // id
  similarity: number;
  reason: string;
}

export interface MergeDetectorOptions {
  /** 相似度阈值，高于此值视为合并候选。默认 0.7 */
  similarityThreshold?: number;
  /** 外部条目查询函数（查询已入库的条目） */
  queryExisting?: (entry: KnowledgeEntry) => Promise<KnowledgeEntry[]>;
}

export class MergeDetector {
  private readonly threshold: number;
  private readonly queryExisting?: (entry: KnowledgeEntry) => Promise<KnowledgeEntry[]>;

  constructor(options: MergeDetectorOptions = {}) {
    this.threshold = options.similarityThreshold ?? 0.7;
    this.queryExisting = options.queryExisting;
  }

  /**
   * 检测条目列表中的合并候选
   * 同时检测新条目之间和新条目与已有条目之间的重复
   */
  async detect(entries: KnowledgeEntry[]): Promise<MergeCandidate[]> {
    const candidates: MergeCandidate[] = [];

    // 新条目之间的重复检测
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const sim = this.computeSimilarity(entries[i], entries[j]);
        if (sim >= this.threshold) {
          candidates.push({
            entryA: entries[i].id,
            entryB: entries[j].id,
            similarity: sim,
            reason: `Content similarity ${(sim * 100).toFixed(1)}% between "${entries[i].title}" and "${entries[j].title}"`,
          });
        }
      }
    }

    // 新条目与已有条目的重复检测
    if (this.queryExisting) {
      for (const entry of entries) {
        const existing = await this.queryExisting(entry);
        for (const ex of existing) {
          if (ex.id === entry.id) continue;
          const sim = this.computeSimilarity(entry, ex);
          if (sim >= this.threshold) {
            candidates.push({
              entryA: entry.id,
              entryB: ex.id,
              similarity: sim,
              reason: `Content similarity ${(sim * 100).toFixed(1)}% with existing entry "${ex.title}"`,
            });
          }
        }
      }
    }

    return candidates;
  }

  /**
   * 计算两个条目的相似度
   * 综合标题关键词重叠 + 内容关键词重叠 + 类型匹配
   */
  private computeSimilarity(a: KnowledgeEntry, b: KnowledgeEntry): number {
    const titleSim = keywordOverlap(a.title, b.title);
    const contentSim = keywordOverlap(a.content, b.content);
    const typeMatch = a.type === b.type ? 1 : 0;
    const domainMatch = a.domain && b.domain && a.domain === b.domain ? 1 : 0;

    // 加权平均：内容权重最高
    return titleSim * 0.25 + contentSim * 0.5 + typeMatch * 0.15 + domainMatch * 0.1;
  }
}

/** 关键词重叠度 */
function keywordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}
