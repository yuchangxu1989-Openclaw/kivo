/**
 * Graph Alignment Checker (FR-G04)
 *
 * Detects inconsistencies between the knowledge graph and the knowledge repository:
 *   - Orphan nodes: graph nodes referencing entries that no longer exist in the repository
 *   - Missing associations: semantically related entries that lack graph edges
 *
 * Uses LLM for semantic relatedness judgment (no keyword matching).
 * Provides both detection (check) and automated repair (fix).
 */

import type { LLMProvider } from '../adapter/llm-provider.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { KnowledgeEntry } from '../types/index.js';
import type { Association, AssociationType } from './association-types.js';
import { AssociationStore } from './association-store.js';
import type { KnowledgeGraphSnapshot, KnowledgeGraphEdge } from './knowledge-graph.js';
import { extractJsonBlock } from '../extraction/extraction-utils.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface OrphanNode {
  /** Node ID in the graph that has no corresponding repository entry */
  nodeId: string;
  /** Title of the orphan node (from graph snapshot) */
  title: string;
  /** Edges that reference this orphan node */
  affectedEdges: string[];
  /** Suggested action */
  suggestion: 'remove_node';
}

export interface MissingAssociation {
  /** Source entry ID */
  sourceId: string;
  sourceTitle: string;
  /** Target entry ID */
  targetId: string;
  targetTitle: string;
  /** Suggested association type */
  suggestedType: AssociationType;
  /** LLM-generated reason for the suggested association */
  reason: string;
  /** Confidence of the suggestion (0-1) */
  confidence: number;
}

export interface AlignmentReport {
  /** Timestamp of the alignment check */
  checkedAt: Date;
  /** Nodes in graph that reference deleted/missing repository entries */
  orphanNodes: OrphanNode[];
  /** Entry pairs that are semantically related but lack graph edges */
  missingAssociations: MissingAssociation[];
  /** Summary statistics */
  stats: {
    totalGraphNodes: number;
    totalRepositoryEntries: number;
    orphanCount: number;
    missingAssociationCount: number;
  };
}

export interface GraphAlignmentOptions {
  /** Max entry pairs to evaluate for missing associations per batch (default: 20) */
  maxPairsPerBatch?: number;
  /** Minimum confidence for a missing association suggestion (default: 0.7) */
  minAssociationConfidence?: number;
  /** Pre-built graph snapshot (if not provided, will be built from store) */
  snapshot?: KnowledgeGraphSnapshot;
}

// ── Implementation ───────────────────────────────────────────────────────────

export class GraphAlignmentChecker {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly store: AssociationStore,
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Run a full alignment check between the graph and the repository.
   * Returns orphan nodes and missing associations.
   */
  async check(options: GraphAlignmentOptions = {}): Promise<AlignmentReport> {
    const minConfidence = options.minAssociationConfidence ?? 0.7;
    const maxPairs = options.maxPairsPerBatch ?? 20;

    // Get current state
    const entries = await this.repository.findAll();
    const entryIds = new Set(entries.map(e => e.id));
    const associations = this.store.listAll();

    // Detect orphan nodes: associations referencing non-existent entries
    const orphanNodes = this.detectOrphanNodes(associations, entryIds);

    // Detect missing associations using LLM semantic judgment
    const missingAssociations = await this.detectMissingAssociations(
      entries,
      associations,
      maxPairs,
      minConfidence,
    );

    // Build snapshot stats
    const allNodeIds = new Set<string>();
    for (const assoc of associations) {
      allNodeIds.add(assoc.sourceId);
      allNodeIds.add(assoc.targetId);
    }

    return {
      checkedAt: new Date(),
      orphanNodes,
      missingAssociations,
      stats: {
        totalGraphNodes: allNodeIds.size,
        totalRepositoryEntries: entries.length,
        orphanCount: orphanNodes.length,
        missingAssociationCount: missingAssociations.length,
      },
    };
  }

  /**
   * Execute fixes based on an alignment report.
   * - Removes orphan nodes (deletes their edges from the store)
   * - Adds missing associations to the store
   */
  async fix(report: AlignmentReport): Promise<void> {
    // Remove edges referencing orphan nodes
    for (const orphan of report.orphanNodes) {
      const sourceEdges = this.store.getBySource(orphan.nodeId);
      for (const edge of sourceEdges) {
        this.store.remove(edge.sourceId, edge.targetId);
      }
      const targetEdges = this.store.getByTarget(orphan.nodeId);
      for (const edge of targetEdges) {
        this.store.remove(edge.sourceId, edge.targetId);
      }
    }

    // Add missing associations
    for (const missing of report.missingAssociations) {
      this.store.add({
        sourceId: missing.sourceId,
        targetId: missing.targetId,
        type: missing.suggestedType,
        strength: missing.confidence,
        metadata: {
          reason: missing.reason,
          autoAligned: true,
          alignedAt: new Date().toISOString(),
        },
      });
    }
  }

  /**
   * Detect orphan nodes — graph references to entries that no longer exist.
   */
  private detectOrphanNodes(
    associations: Association[],
    validEntryIds: Set<string>,
  ): OrphanNode[] {
    // Collect all node IDs referenced in associations
    const nodeRefs = new Map<string, string[]>(); // nodeId → edge descriptions

    for (const assoc of associations) {
      if (!validEntryIds.has(assoc.sourceId)) {
        const edges = nodeRefs.get(assoc.sourceId) ?? [];
        edges.push(`${assoc.sourceId}->${assoc.targetId}:${assoc.type}`);
        nodeRefs.set(assoc.sourceId, edges);
      }
      if (!validEntryIds.has(assoc.targetId)) {
        const edges = nodeRefs.get(assoc.targetId) ?? [];
        edges.push(`${assoc.sourceId}->${assoc.targetId}:${assoc.type}`);
        nodeRefs.set(assoc.targetId, edges);
      }
    }

    return Array.from(nodeRefs.entries()).map(([nodeId, edges]) => ({
      nodeId,
      title: `[deleted entry: ${nodeId}]`,
      affectedEdges: edges,
      suggestion: 'remove_node' as const,
    }));
  }

  /**
   * Detect missing associations using LLM semantic judgment.
   * Samples entry pairs that share a domain but have no existing edge,
   * then asks the LLM whether they should be associated.
   */
  private async detectMissingAssociations(
    entries: KnowledgeEntry[],
    existingAssociations: Association[],
    maxPairs: number,
    minConfidence: number,
  ): Promise<MissingAssociation[]> {
    if (entries.length < 2) return [];

    // Build set of existing edges for quick lookup
    const existingEdgeKeys = new Set(
      existingAssociations.map(a => `${a.sourceId}::${a.targetId}`),
    );

    // Find candidate pairs: same domain, no existing edge
    const candidatePairs = this.findCandidatePairs(entries, existingEdgeKeys, maxPairs);
    if (candidatePairs.length === 0) return [];

    // Ask LLM to evaluate semantic relatedness
    const prompt = this.buildAssociationDiscoveryPrompt(candidatePairs);
    let rawResponse: string;
    try {
      rawResponse = await this.llm.complete(prompt);
    } catch {
      // LLM unavailable — return empty (non-blocking)
      return [];
    }

    const parsed = extractJsonBlock(rawResponse);
    if (!Array.isArray(parsed)) return [];

    // Validate and filter results
    const results: MissingAssociation[] = [];
    for (const item of parsed) {
      const validated = this.validateMissingAssociation(item, candidatePairs);
      if (validated && validated.confidence >= minConfidence) {
        results.push(validated);
      }
    }

    return results;
  }

  /**
   * Find entry pairs that share a domain but lack an association edge.
   */
  private findCandidatePairs(
    entries: KnowledgeEntry[],
    existingEdgeKeys: Set<string>,
    maxPairs: number,
  ): Array<{ source: KnowledgeEntry; target: KnowledgeEntry }> {
    const pairs: Array<{ source: KnowledgeEntry; target: KnowledgeEntry }> = [];

    // Group entries by domain
    const byDomain = new Map<string, KnowledgeEntry[]>();
    for (const entry of entries) {
      const domain = entry.domain ?? '_uncategorized';
      const bucket = byDomain.get(domain) ?? [];
      bucket.push(entry);
      byDomain.set(domain, bucket);
    }

    // For each domain, find pairs without edges
    for (const bucket of byDomain.values()) {
      for (let i = 0; i < bucket.length && pairs.length < maxPairs; i++) {
        for (let j = i + 1; j < bucket.length && pairs.length < maxPairs; j++) {
          const a = bucket[i];
          const b = bucket[j];
          const keyAB = `${a.id}::${b.id}`;
          const keyBA = `${b.id}::${a.id}`;
          if (!existingEdgeKeys.has(keyAB) && !existingEdgeKeys.has(keyBA)) {
            pairs.push({ source: a, target: b });
          }
        }
      }
    }

    return pairs;
  }

  /**
   * Build LLM prompt for evaluating potential associations between entry pairs.
   */
  private buildAssociationDiscoveryPrompt(
    pairs: Array<{ source: KnowledgeEntry; target: KnowledgeEntry }>,
  ): string {
    const pairDescriptions = pairs
      .map((p, i) => {
        return `[Pair ${i}]
Source (${p.source.id}): "${p.source.title}" — ${p.source.summary}
Target (${p.target.id}): "${p.target.title}" — ${p.target.summary}`;
      })
      .join('\n\n');

    return `你是一个知识图谱对齐专家。判断以下知识条目对之间是否存在语义关联。

关联类型：
- supplements: B 补充了 A 的信息（同一主题的不同方面）
- depends_on: A 依赖 B 才能完整理解或执行
- conflicts: A 和 B 存在矛盾或冲突
- supersedes: A 是 B 的更新版本，应替代 B

判断要求：
1. 基于语义理解，不做关键词匹配
2. 只输出确实存在关联的对，不确定的不要输出
3. confidence 反映关联的确定程度

输出纯 JSON 数组：
[{
  "pair_index": 0,
  "source_id": "<source entry id>",
  "target_id": "<target entry id>",
  "type": "supplements|depends_on|conflicts|supersedes",
  "reason": "关联原因说明",
  "confidence": 0.0-1.0
}]

没有关联则返回 []。

待评估的条目对：
${pairDescriptions}`;
  }

  /**
   * Validate a raw LLM response item into a MissingAssociation.
   */
  private validateMissingAssociation(
    raw: unknown,
    candidatePairs: Array<{ source: KnowledgeEntry; target: KnowledgeEntry }>,
  ): MissingAssociation | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const pairIndex = typeof obj.pair_index === 'number' ? obj.pair_index : -1;
    const sourceId = typeof obj.source_id === 'string' ? obj.source_id : '';
    const targetId = typeof obj.target_id === 'string' ? obj.target_id : '';
    const type = obj.type as string;
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    const confidence = typeof obj.confidence === 'number'
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0;

    const validTypes: AssociationType[] = ['supplements', 'depends_on', 'conflicts', 'supersedes'];
    if (!validTypes.includes(type as AssociationType)) return null;

    // Resolve the pair — prefer pair_index, fallback to IDs
    let pair: { source: KnowledgeEntry; target: KnowledgeEntry } | undefined;
    if (pairIndex >= 0 && pairIndex < candidatePairs.length) {
      pair = candidatePairs[pairIndex];
    } else if (sourceId && targetId) {
      pair = candidatePairs.find(p => p.source.id === sourceId && p.target.id === targetId);
    }

    if (!pair) return null;

    return {
      sourceId: pair.source.id,
      sourceTitle: pair.source.title,
      targetId: pair.target.id,
      targetTitle: pair.target.title,
      suggestedType: type as AssociationType,
      reason,
      confidence,
    };
  }
}
