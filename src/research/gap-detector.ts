import { randomUUID } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeType } from '../types/index.js';
import type {
  FrequencyBlindSpot,
  GapDetectionResult,
  GraphGap,
  GraphGapSignal,
  KnowledgeGap,
  QueryMissRecord,
  ResearchSuggestion,
  StructuralGap,
  CoverageAnalysis,
} from './gap-detection-types.js';

const FREQUENCY_PRIORITY_THRESHOLDS = {
  high: 5,
  medium: 3,
  low: 2,
} as const;

const PRIORITY_WEIGHT = {
  high: 3,
  medium: 2,
  low: 1,
} as const;

const KNOWLEDGE_TYPE_ORDER: KnowledgeType[] = [
  'fact',
  'methodology',
  'decision',
  'experience',
  'intent',
  'meta',
];

const STRUCTURAL_KNOWLEDGE_CHAIN: KnowledgeType[] = ['fact', 'methodology', 'experience'];

const GAP_RELEVANT_STATUSES = new Set<KnowledgeEntry['status']>(['active', 'pending', 'draft']);

/** Association link between two knowledge entries (for graph-based gap detection) */
export interface KnowledgeLink {
  sourceId: string;
  targetId: string;
  weight?: number;
}

export interface GapDetectorOptions {
  now?: () => Date;
  idGenerator?: () => string;
  coverageBaseline?: number; // default 0.8 (80%)
}

export class GapDetector {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly coverageBaseline: number;
  private readonly queryMissHistory: QueryMissRecord[] = [];
  private queryHitCount = 0;

  constructor(options: GapDetectorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.coverageBaseline = options.coverageBaseline ?? 0.8;
  }

  recordQueryMiss(query: string, context?: string): void {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return;
    }

    this.queryMissHistory.push({
      query: normalizedQuery,
      timestamp: new Date(this.now()),
      context: normalizeOptionalText(context),
    });
  }

  /** Record a successful query hit for coverage analysis (FR-D01 AC6) */
  recordQueryHit(): void {
    this.queryHitCount++;
  }

  detectFrequencyGaps(): KnowledgeGap[] {
    const groupedMisses = new Map<string, { displayPattern: string; misses: QueryMissRecord[] }>();

    for (const miss of this.queryMissHistory) {
      const patternKey = normalizeQueryPatternKey(miss.query);
      const displayPattern = normalizeQueryDisplay(miss.query);
      const bucket = groupedMisses.get(patternKey) ?? {
        displayPattern,
        misses: [],
      };
      bucket.misses.push(cloneQueryMissRecord(miss));
      groupedMisses.set(patternKey, bucket);
    }

    return Array.from(groupedMisses.values())
      .map(({ displayPattern, misses }) => this.toFrequencyGap(displayPattern, misses))
      .filter((gap): gap is KnowledgeGap => gap !== null)
      .sort(compareGaps);
  }

  detectStructuralGaps(entries: KnowledgeEntry[]): KnowledgeGap[] {
    const entriesByDomain = new Map<string, KnowledgeEntry[]>();

    for (const entry of entries) {
      if (!entry.domain || !GAP_RELEVANT_STATUSES.has(entry.status)) {
        continue;
      }

      const domain = entry.domain.trim();
      if (!domain) {
        continue;
      }

      const bucket = entriesByDomain.get(domain) ?? [];
      bucket.push(entry);
      entriesByDomain.set(domain, bucket);
    }

    return Array.from(entriesByDomain.entries())
      .map(([domain, domainEntries]) => this.toStructuralGap(domain, domainEntries))
      .filter((gap): gap is KnowledgeGap => gap !== null)
      .sort(compareGaps);
  }

  detect(entries: KnowledgeEntry[], links?: KnowledgeLink[]): GapDetectionResult {
    const gaps = [
      ...this.detectFrequencyGaps(),
      ...this.detectStructuralGaps(entries),
      ...this.detectGraphGaps(entries, links ?? []),
    ].sort(compareGaps);
    const suggestions = gaps.map((gap) => this.toResearchSuggestion(gap));

    return {
      gaps,
      suggestions,
      detectedAt: new Date(this.now()),
    };
  }

  getQueryMissHistory(): QueryMissRecord[] {
    return this.queryMissHistory.map(cloneQueryMissRecord);
  }

  /**
   * FR-D01 AC3: Graph-based gap detection
   * Detects isolated nodes, sparse communities, and missing bridge nodes.
   */
  detectGraphGaps(entries: KnowledgeEntry[], links: KnowledgeLink[]): KnowledgeGap[] {
    const relevantEntries = entries.filter((e) => GAP_RELEVANT_STATUSES.has(e.status));
    if (relevantEntries.length === 0) return [];

    const entryIds = new Set(relevantEntries.map((e) => e.id));
    const adjacency = new Map<string, Set<string>>();

    for (const id of entryIds) {
      adjacency.set(id, new Set());
    }

    for (const link of links) {
      if (entryIds.has(link.sourceId) && entryIds.has(link.targetId)) {
        adjacency.get(link.sourceId)!.add(link.targetId);
        adjacency.get(link.targetId)!.add(link.sourceId);
      }
    }

    const gaps: KnowledgeGap[] = [];

    // Isolated nodes: entries with zero connections
    const isolatedIds = relevantEntries
      .filter((e) => (adjacency.get(e.id)?.size ?? 0) === 0)
      .map((e) => e.id);

    if (isolatedIds.length > 0) {
      gaps.push({
        id: this.idGenerator(),
        type: 'graph_gap',
        description: `${isolatedIds.length} 个知识条目处于孤立状态，未与其他条目建立任何关联。`,
        priority: isolatedIds.length >= 5 ? 'high' : isolatedIds.length >= 2 ? 'medium' : 'low',
        evidence: {
          signal: 'isolated_node' as GraphGapSignal,
          affectedIds: isolatedIds,
          description: `孤立节点：${isolatedIds.slice(0, 5).join(', ')}${isolatedIds.length > 5 ? ` 等 ${isolatedIds.length} 个` : ''}`,
        },
      });
    }

    // Sparse communities: domains with entries but weak internal connections
    const domainEntries = new Map<string, KnowledgeEntry[]>();
    for (const entry of relevantEntries) {
      if (!entry.domain) continue;
      const bucket = domainEntries.get(entry.domain) ?? [];
      bucket.push(entry);
      domainEntries.set(entry.domain, bucket);
    }

    for (const [domain, domEntries] of domainEntries) {
      if (domEntries.length < 3) continue;

      const domIds = new Set(domEntries.map((e) => e.id));
      let internalLinks = 0;
      for (const link of links) {
        if (domIds.has(link.sourceId) && domIds.has(link.targetId)) {
          internalLinks++;
        }
      }

      const maxPossibleLinks = (domEntries.length * (domEntries.length - 1)) / 2;
      const density = maxPossibleLinks > 0 ? internalLinks / maxPossibleLinks : 0;

      if (density < 0.2) {
        gaps.push({
          id: this.idGenerator(),
          type: 'graph_gap',
          description: `领域"${domain}"包含 ${domEntries.length} 个条目，但内部关联密度仅 ${(density * 100).toFixed(0)}%，知识间支撑关系薄弱。`,
          priority: density < 0.05 ? 'high' : 'medium',
          evidence: {
            signal: 'sparse_community' as GraphGapSignal,
            affectedIds: domEntries.map((e) => e.id),
            description: `稀疏社区：${domain}（密度 ${(density * 100).toFixed(1)}%）`,
          },
        });
      }
    }

    // Missing bridge nodes: detect disconnected domain clusters
    const domainKeys = Array.from(domainEntries.keys());
    for (let i = 0; i < domainKeys.length; i++) {
      for (let j = i + 1; j < domainKeys.length; j++) {
        const domA = new Set(domainEntries.get(domainKeys[i])!.map((e) => e.id));
        const domB = new Set(domainEntries.get(domainKeys[j])!.map((e) => e.id));

        let crossLinks = 0;
        for (const link of links) {
          if (
            (domA.has(link.sourceId) && domB.has(link.targetId)) ||
            (domB.has(link.sourceId) && domA.has(link.targetId))
          ) {
            crossLinks++;
          }
        }

        if (crossLinks === 0 && domA.size >= 2 && domB.size >= 2) {
          gaps.push({
            id: this.idGenerator(),
            type: 'graph_gap',
            description: `领域"${domainKeys[i]}"和"${domainKeys[j]}"之间缺少桥接知识，两个主题群完全断开。`,
            priority: 'medium',
            evidence: {
              signal: 'missing_bridge' as GraphGapSignal,
              affectedIds: [...Array.from(domA), ...Array.from(domB)],
              description: `桥接缺失：${domainKeys[i]} ↔ ${domainKeys[j]}`,
            },
          });
        }
      }
    }

    return gaps.sort(compareGaps);
  }

  /**
   * FR-D01 AC6: Coverage analysis with target baseline
   */
  analyzeCoverage(entries: KnowledgeEntry[], options?: { baseline?: number }): CoverageAnalysis {
    const baseline = options?.baseline ?? this.coverageBaseline;
    const totalQueries = this.queryHitCount + this.queryMissHistory.length;
    const hitRate = totalQueries > 0 ? this.queryHitCount / totalQueries : 1;

    const domainCoverage = new Map<string, { total: number; covered: number; rate: number }>();
    const domainEntries = new Map<string, KnowledgeEntry[]>();

    for (const entry of entries) {
      if (!entry.domain || !GAP_RELEVANT_STATUSES.has(entry.status)) continue;
      const bucket = domainEntries.get(entry.domain) ?? [];
      bucket.push(entry);
      domainEntries.set(entry.domain, bucket);
    }

    for (const [domain, domEntries] of domainEntries) {
      const presentTypes = new Set(domEntries.map((e) => e.type));
      const coveredCount = STRUCTURAL_KNOWLEDGE_CHAIN.filter((t) => presentTypes.has(t)).length;
      const rate = STRUCTURAL_KNOWLEDGE_CHAIN.length > 0 ? coveredCount / STRUCTURAL_KNOWLEDGE_CHAIN.length : 1;
      domainCoverage.set(domain, {
        total: STRUCTURAL_KNOWLEDGE_CHAIN.length,
        covered: coveredCount,
        rate,
      });
    }

    return {
      totalQueries,
      hitCount: this.queryHitCount,
      missCount: this.queryMissHistory.length,
      hitRate: Number(hitRate.toFixed(4)),
      baseline,
      meetsBaseline: hitRate >= baseline,
      domainCoverage,
    };
  }

  /**
   * FR-D01 AC5: Create research task directly from a suggestion
   */
  createTaskFromSuggestion(
    suggestion: ResearchSuggestion,
    gaps: KnowledgeGap[],
    generator: { generateFromGap(gap: KnowledgeGap): import('./research-task-types.js').ResearchTask },
  ): import('./research-task-types.js').ResearchTask {
    const gap = gaps.find((g) => g.id === suggestion.gapId);
    if (!gap) {
      throw new Error(`Gap "${suggestion.gapId}" not found for suggestion.`);
    }
    return generator.generateFromGap(gap);
  }

  private toFrequencyGap(pattern: string, misses: QueryMissRecord[]): KnowledgeGap | null {
    if (misses.length < FREQUENCY_PRIORITY_THRESHOLDS.low) {
      return null;
    }

    const sortedMisses = misses
      .slice()
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const lastMiss = sortedMisses[sortedMisses.length - 1];
    const evidence: FrequencyBlindSpot = {
      pattern,
      hitCount: 0,
      missCount: sortedMisses.length,
      lastMissAt: new Date(lastMiss.timestamp),
    };

    return {
      id: this.idGenerator(),
      type: 'frequency_blind_spot',
      description: `查询模式“${pattern}”连续未命中 ${sortedMisses.length} 次，说明知识库在这个主题上存在明显盲区。`,
      priority: inferFrequencyPriority(sortedMisses.length),
      evidence,
    };
  }

  private toStructuralGap(domain: string, entries: KnowledgeEntry[]): KnowledgeGap | null {
    const presentTypeSet = new Set(entries.map((entry) => entry.type));
    const presentStructuralTypes = STRUCTURAL_KNOWLEDGE_CHAIN.filter((type) => presentTypeSet.has(type));

    if (presentStructuralTypes.length === 0) {
      return null;
    }

    const missingTypes = STRUCTURAL_KNOWLEDGE_CHAIN.filter((type) => !presentTypeSet.has(type));
    if (missingTypes.length === 0) {
      return null;
    }

    const presentTypes = sortKnowledgeTypes(Array.from(presentTypeSet));
    const evidence: StructuralGap = {
      domain,
      presentTypes,
      missingTypes,
    };

    return {
      id: this.idGenerator(),
      type: 'structural_gap',
      description: `领域“${domain}”的知识链路不完整，当前已有 ${joinKnowledgeTypes(presentTypes)}，但缺少 ${joinKnowledgeTypes(missingTypes)}。`,
      priority: inferStructuralPriority(missingTypes.length),
      evidence,
    };
  }

  private toResearchSuggestion(gap: KnowledgeGap): ResearchSuggestion {
    if (gap.type === 'frequency_blind_spot') {
      const evidence = gap.evidence as FrequencyBlindSpot;
      return {
        gapId: gap.id,
        title: `补齐高频未命中主题：${evidence.pattern}`,
        description: `围绕“${evidence.pattern}”开展定向调研，优先补充可被 Agent 直接检索命中的核心知识条目。`,
        expectedOutcome: `形成至少 1 组可检索的 fact / methodology / experience 条目，覆盖最近 ${evidence.missCount} 次未命中的查询需求。`,
        priority: gap.priority,
      };
    }

    if (gap.type === 'graph_gap') {
      const evidence = gap.evidence as GraphGap;
      return {
        gapId: gap.id,
        title: `补齐图谱缺口：${evidence.description}`,
        description: `针对知识图谱中的${signalLabel(evidence.signal)}问题开展调研，增强知识间的关联和支撑关系。`,
        expectedOutcome: `消除${signalLabel(evidence.signal)}问题，建立缺失的知识关联。`,
        priority: gap.priority,
      };
    }

    const evidence = gap.evidence as StructuralGap;
    return {
      gapId: gap.id,
      title: `补齐 ${evidence.domain} 领域知识链路`,
      description: `针对 ${evidence.domain} 领域缺失的 ${joinKnowledgeTypes(evidence.missingTypes)} 开展专题调研，补全从概念到实践的知识闭环。`,
      expectedOutcome: `为 ${evidence.domain} 领域新增 ${joinKnowledgeTypes(evidence.missingTypes)} 类型条目，并建立与现有 ${joinKnowledgeTypes(evidence.presentTypes)} 条目的关联。`,
      priority: gap.priority,
    };
  }
}

function normalizeQueryPatternKey(query: string): string {
  return normalizeQueryDisplay(query).toLowerCase();
}

function normalizeQueryDisplay(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function inferFrequencyPriority(missCount: number): KnowledgeGap['priority'] {
  if (missCount >= FREQUENCY_PRIORITY_THRESHOLDS.high) {
    return 'high';
  }
  if (missCount >= FREQUENCY_PRIORITY_THRESHOLDS.medium) {
    return 'medium';
  }
  return 'low';
}

function inferStructuralPriority(missingTypeCount: number): KnowledgeGap['priority'] {
  if (missingTypeCount >= 2) {
    return 'high';
  }
  return 'medium';
}

function compareGaps(a: KnowledgeGap, b: KnowledgeGap): number {
  const priorityDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  if (a.type !== b.type) {
    return a.type.localeCompare(b.type);
  }

  return a.description.localeCompare(b.description);
}

function sortKnowledgeTypes(types: KnowledgeType[]): KnowledgeType[] {
  return types.slice().sort((a, b) => KNOWLEDGE_TYPE_ORDER.indexOf(a) - KNOWLEDGE_TYPE_ORDER.indexOf(b));
}

function joinKnowledgeTypes(types: KnowledgeType[]): string {
  return types.join('、');
}

function cloneQueryMissRecord(record: QueryMissRecord): QueryMissRecord {
  return {
    query: record.query,
    timestamp: new Date(record.timestamp),
    context: record.context,
  };
}

function signalLabel(signal: GraphGapSignal): string {
  switch (signal) {
    case 'isolated_node': return '孤立节点';
    case 'sparse_community': return '稀疏社区';
    case 'missing_bridge': return '桥接缺失';
  }
}
