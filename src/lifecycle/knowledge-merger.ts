import { v4 as uuid } from 'uuid';
import type { KnowledgeStore } from '../storage/knowledge-store.js';
import type { KnowledgeEntry } from '../types/index.js';
import type {
  MergeCandidate,
  MergedEntry,
  MergeHistory,
  MergeReversal,
  SourceRef,
} from './knowledge-merge-types.js';

export interface KnowledgeMergerOptions {
  store: KnowledgeStore;
  now?: () => Date;
  idGenerator?: () => string;
  similarityThreshold?: number; // 默认 0.6，FR-C03 AC1 可配置阈值
}

interface MergeSnapshot {
  mergedEntry: MergedEntry;
  originalEntries: KnowledgeEntry[];
}

export class KnowledgeMerger {
  private readonly store: KnowledgeStore;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly mergeHistory: MergedEntry[] = [];
  private readonly reversalHistory: MergeReversal[] = [];
  private readonly snapshots = new Map<string, MergeSnapshot>();

  private readonly similarityThreshold: number;

  constructor(options: KnowledgeMergerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? uuid;
    this.similarityThreshold = options.similarityThreshold ?? 0.6;
  }

  findMergeCandidates(entries: KnowledgeEntry[], options?: { similarityThreshold?: number }): MergeCandidate[] {
    const threshold = options?.similarityThreshold ?? this.similarityThreshold;
    const groups = new Map<string, KnowledgeEntry[]>();

    for (const entry of entries) {
      if (entry.status !== 'active') {
        continue;
      }

      const topic = this.normalizeTopic(entry.title);
      if (!topic) {
        continue;
      }

      const bucket = groups.get(topic) ?? [];
      bucket.push(entry);
      groups.set(topic, bucket);
    }

    const candidates: MergeCandidate[] = [];
    for (const [topic, group] of groups.entries()) {
      if (group.length < 2) {
        continue;
      }

      const compatibleEntries = this.filterComplementaryEntries(group);
      if (compatibleEntries.length < 2) {
        continue;
      }

      const uniqueSourceEntries = compatibleEntries.filter(
        (entry, index, list) => list.findIndex((item) => item.source.reference === entry.source.reference) === index
      );

      if (uniqueSourceEntries.length < 2) {
        continue;
      }

      const similarity = this.computeGroupSimilarity(compatibleEntries);

      // FR-C03 AC1: 只有相似度超过可配置阈值的候选才返回
      if (similarity < threshold) {
        continue;
      }

      // FR-C03 AC2: 按知识类型区分合并策略
      const entryType = compatibleEntries[0].type;
      const requiresManualConfirmation = entryType === 'decision';
      const requiresReview = entryType === 'methodology';

      candidates.push({
        sourceEntryIds: compatibleEntries.map((entry) => entry.id),
        topic,
        similarity,
        requiresManualConfirmation,
        requiresReview,
      });
    }

    return candidates.sort((a, b) => b.similarity - a.similarity);
  }

  async merge(candidate: MergeCandidate): Promise<MergedEntry> {
    const entries = await this.loadCandidateEntries(candidate.sourceEntryIds);
    const topic = this.normalizeTopic(candidate.topic || entries[0]?.title || '');

    if (!topic) {
      throw new Error('Merge candidate topic is empty.');
    }

    if (entries.length < 2) {
      throw new Error('At least two knowledge entries are required to merge.');
    }

    if (!this.areEntriesComplementary(entries)) {
      throw new Error(`Entries for topic "${topic}" are contradictory and cannot be merged.`);
    }

    // FR-C03 AC2: decision 类型禁止自动合并
    const entryType = entries[0].type;
    if (entryType === 'decision' || candidate.requiresManualConfirmation) {
      throw new Error(`Knowledge type "${entryType}" requires manual confirmation and cannot be auto-merged.`);
    }

    const timestamp = this.now();
    const mergedEntry = this.buildMergedEntry(entries, topic, timestamp);

    // FR-C03 AC2: methodology 类型合并后标记需人工审核
    if (entryType === 'methodology' || candidate.requiresReview) {
      mergedEntry.status = 'pending';
    }

    await this.store.save(mergedEntry);

    for (const entry of entries) {
      await this.store.update(entry.id, {
        status: 'superseded',
        updatedAt: timestamp,
      });
    }

    this.mergeHistory.push(mergedEntry);
    this.snapshots.set(mergedEntry.id, {
      mergedEntry,
      originalEntries: entries,
    });

    return mergedEntry;
  }

  async revert(mergedEntryId: string): Promise<MergeReversal> {
    const snapshot = this.snapshots.get(mergedEntryId);
    if (!snapshot) {
      throw new Error(`Merge snapshot not found for entry "${mergedEntryId}".`);
    }

    const reversalTime = this.now();

    for (const entry of snapshot.originalEntries) {
      await this.store.update(entry.id, {
        status: 'active',
        updatedAt: reversalTime,
      });
    }

    await this.store.delete(mergedEntryId);

    const reversal: MergeReversal = {
      mergedEntryId,
      restoredEntryIds: snapshot.originalEntries.map((entry) => entry.id),
      reversedAt: reversalTime,
    };

    this.reversalHistory.push(reversal);
    const historyIndex = this.mergeHistory.findIndex((entry) => entry.id === mergedEntryId);
    if (historyIndex >= 0) {
      this.mergeHistory.splice(historyIndex, 1);
    }
    this.snapshots.delete(mergedEntryId);

    return reversal;
  }

  getMergeHistory(): MergeHistory {
    return {
      merged: this.mergeHistory.map((entry) => this.cloneMergedEntry(entry)),
      reversals: this.reversalHistory.map((reversal) => ({
        ...reversal,
        restoredEntryIds: [...reversal.restoredEntryIds],
        reversedAt: new Date(reversal.reversedAt),
      })),
    };
  }

  private async loadCandidateEntries(entryIds: string[]): Promise<KnowledgeEntry[]> {
    const uniqueIds = Array.from(new Set(entryIds));
    const entries: KnowledgeEntry[] = [];

    for (const id of uniqueIds) {
      const entry = await this.store.get(id);
      if (!entry) {
        throw new Error(`Knowledge entry "${id}" not found.`);
      }
      entries.push(entry);
    }

    return entries;
  }

  private buildMergedEntry(entries: KnowledgeEntry[], topic: string, mergedAt: Date): MergedEntry {
    const sourceRefs = entries.map((entry) => this.toSourceRef(entry));
    const tags = Array.from(new Set(entries.flatMap((entry) => entry.tags)));
    const latestUpdatedAt = entries.reduce(
      (latest, entry) => (entry.updatedAt.getTime() > latest.getTime() ? entry.updatedAt : latest),
      entries[0].updatedAt
    );
    const averageConfidence = entries.reduce((sum, entry) => sum + entry.confidence, 0) / entries.length;

    return {
      id: this.idGenerator(),
      type: entries[0].type,
      title: entries[0].title,
      topic,
      content: sourceRefs.map((ref) => ref.extractedContent).join('\n\n'),
      summary: entries.map((entry) => entry.summary).join(' / '),
      source: {
        type: 'system',
        reference: `merge:${topic}`,
        timestamp: mergedAt,
        context: `Merged from ${entries.length} entries`,
      },
      sourceRefs,
      confidence: Number(averageConfidence.toFixed(3)),
      status: 'active',
      tags,
      domain: entries.find((entry) => entry.domain)?.domain,
      metadata: {
        referenceCount: entries.reduce((sum, entry) => sum + (entry.metadata?.referenceCount ?? 0), 0),
      },
      createdAt: mergedAt,
      updatedAt: latestUpdatedAt > mergedAt ? latestUpdatedAt : mergedAt,
      version: 1,
      mergedAt,
      reversible: true,
    };
  }

  private toSourceRef(entry: KnowledgeEntry): SourceRef {
    return {
      entryId: entry.id,
      source: {
        ...entry.source,
        timestamp: new Date(entry.source.timestamp),
      },
      extractedContent: entry.content,
    };
  }

  private filterComplementaryEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
    return entries.filter((entry) =>
      entries.every((other) => entry.id === other.id || !this.isContradictory(entry, other))
    );
  }

  private areEntriesComplementary(entries: KnowledgeEntry[]): boolean {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (this.isContradictory(entries[i], entries[j])) {
          return false;
        }
      }
    }

    return true;
  }

  private computeGroupSimilarity(entries: KnowledgeEntry[]): number {
    if (entries.length < 2) {
      return 0;
    }

    const pairScores: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        pairScores.push(this.computeSimilarity(entries[i], entries[j]));
      }
    }

    if (pairScores.length === 0) {
      return 0;
    }

    const average = pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
    return Number(average.toFixed(3));
  }

  private computeSimilarity(a: KnowledgeEntry, b: KnowledgeEntry): number {
    const titleScore = this.tokenOverlap(this.normalizeTopic(a.title), this.normalizeTopic(b.title));
    const summaryScore = this.tokenOverlap(this.normalizeText(a.summary), this.normalizeText(b.summary));
    return Number(((titleScore * 0.7) + (summaryScore * 0.3)).toFixed(3));
  }

  private isContradictory(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
    const sameTopic = this.normalizeTopic(a.title) === this.normalizeTopic(b.title);
    if (!sameTopic) {
      return false;
    }

    const aPolarity = this.detectPolarity(a.content);
    const bPolarity = this.detectPolarity(b.content);
    return aPolarity !== 'neutral' && bPolarity !== 'neutral' && aPolarity !== bPolarity;
  }

  private detectPolarity(text: string): 'positive' | 'negative' | 'neutral' {
    const normalized = text.toLowerCase();
    const negativePattern = /(not|no|never|cannot|can't|deny|forbid|forbidden|must not|should not|禁止|不得|不能|不允许|不可)/u;
    const positivePattern = /(must|should|can|allow|allowed|supports|enable|enabled|允许|可以|支持|能够|会)/u;

    if (negativePattern.test(normalized)) {
      return 'negative';
    }
    if (positivePattern.test(normalized)) {
      return 'positive';
    }
    return 'neutral';
  }

  private normalizeTopic(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenOverlap(a: string, b: string): number {
    const tokensA = new Set(a.split(' ').filter(Boolean));
    const tokensB = new Set(b.split(' ').filter(Boolean));

    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0;
    }

    let matches = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) {
        matches += 1;
      }
    }

    return matches / Math.max(tokensA.size, tokensB.size);
  }

  private cloneMergedEntry(entry: MergedEntry): MergedEntry {
    return {
      ...entry,
      source: {
        ...entry.source,
        timestamp: new Date(entry.source.timestamp),
      },
      sourceRefs: entry.sourceRefs.map((ref) => ({
        ...ref,
        source: {
          ...ref.source,
          timestamp: new Date(ref.source.timestamp),
        },
      })),
      tags: [...entry.tags],
      createdAt: new Date(entry.createdAt),
      updatedAt: new Date(entry.updatedAt),
      mergedAt: new Date(entry.mergedAt),
      metadata: entry.metadata
        ? {
            ...entry.metadata,
            deprecatedAt: entry.metadata.deprecatedAt ? new Date(entry.metadata.deprecatedAt) : undefined,
            archivedAt: entry.metadata.archivedAt ? new Date(entry.metadata.archivedAt) : undefined,
          }
        : undefined,
    };
  }
}
