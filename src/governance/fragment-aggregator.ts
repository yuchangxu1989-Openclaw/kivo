/**
 * Fragment Aggregator (FR-N09)
 *
 * LLM-driven fragment detection and merging for knowledge governance.
 * Detects highly similar knowledge entries using vector similarity,
 * then uses LLM to merge fragments into cohesive, complete entries.
 *
 * Preserves original entry ID references after merging.
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';
import { BgeEmbedder } from '../extraction/bge-embedder.js';
import { cosineSimilarity } from '../utils/math.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FragmentGroup {
  /** Representative entry ID (the one that will be kept) */
  primaryId: string;
  /** All entry IDs in this fragment group */
  entryIds: string[];
  /** Entries in this group */
  entries: KnowledgeEntry[];
  /** Average pairwise similarity within the group */
  avgSimilarity: number;
}

export interface MergeResult {
  /** The merged entry (to replace the primary) */
  mergedEntry: KnowledgeEntry;
  /** IDs of entries that were absorbed into the merged entry */
  absorbedIds: string[];
  /** LLM rationale for the merge */
  rationale: string;
}

export interface AggregationReport {
  totalEntries: number;
  groupsDetected: number;
  entriesMerged: number;
  entriesRemoved: number;
  groups: FragmentGroup[];
  mergeResults: MergeResult[];
}

export interface FragmentAggregatorOptions {
  /** Similarity threshold for grouping fragments (default: 0.85) */
  similarityThreshold?: number;
  /** Maximum group size to attempt merging (default: 5) */
  maxGroupSize?: number;
  /** Minimum group size to consider (default: 2) */
  minGroupSize?: number;
  /** Dry run — detect but don't merge (default: false) */
  dryRun?: boolean;
}

// ── LLM Prompts ──────────────────────────────────────────────────────────────

function buildMergePrompt(entries: KnowledgeEntry[]): string {
  const combined = entries
    .map(
      (e, i) =>
        `[Fragment ${i + 1}] (id: ${e.id}, type: ${e.type})\n标题: ${e.title}\n内容: ${e.content}`,
    )
    .join('\n\n---\n\n');

  return `你是一个知识整合专家。以下多条知识碎片高度相似，需要合并为一条完整、无冗余的知识条目。

合并要求：
1. 保留所有碎片中的独特信息，不丢失任何有价值的细节
2. 去除重复和冗余表述
3. 合并后的内容应该比任何单条碎片更完整、更有结构
4. 标题应概括合并后的完整知识
5. 摘要应是一句话总结

输出纯 JSON 对象：
{
  "title": "合并后的标题（≤60字符）",
  "content": "合并后的完整内容",
  "summary": "一句话摘要",
  "rationale": "合并理由：说明哪些信息被整合、哪些冗余被去除"
}

不要包含 markdown 代码块标记。

知识碎片：
${combined}`;
}

function parseMergeResponse(raw: string): {
  title: string;
  content: string;
  summary: string;
  rationale: string;
} | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.content === 'string' &&
      typeof parsed.title === 'string'
    ) {
      return {
        title: parsed.title,
        content: parsed.content,
        summary: parsed.summary ?? '',
        rationale: parsed.rationale ?? '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Core Class ───────────────────────────────────────────────────────────────

export class FragmentAggregator {
  private readonly repository: KnowledgeRepository;
  private readonly embedder: BgeEmbedder;

  constructor(repository: KnowledgeRepository) {
    this.repository = repository;
    this.embedder = new BgeEmbedder();
  }

  /**
   * Detect groups of highly similar (fragmented) knowledge entries.
   * Uses BGE vector embeddings and cosine similarity.
   */
  async detectFragments(
    options: FragmentAggregatorOptions = {},
  ): Promise<FragmentGroup[]> {
    const threshold = options.similarityThreshold ?? 0.85;
    const maxGroupSize = options.maxGroupSize ?? 5;
    const minGroupSize = options.minGroupSize ?? 2;

    const entries = await this.repository.findAll();
    if (entries.length < minGroupSize) return [];

    // Get embeddings for all entries
    const embeddings = await this.getEmbeddings(entries);

    // Build similarity graph and find connected components above threshold
    const groups: FragmentGroup[] = [];
    const assigned = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (assigned.has(entries[i].id)) continue;
      const vecI = embeddings.get(entries[i].id);
      if (!vecI) continue;

      const group: KnowledgeEntry[] = [entries[i]];
      const groupIds: string[] = [entries[i].id];

      for (let j = i + 1; j < entries.length; j++) {
        if (assigned.has(entries[j].id)) continue;
        if (group.length >= maxGroupSize) break;

        const vecJ = embeddings.get(entries[j].id);
        if (!vecJ) continue;

        const sim = cosineSimilarity(vecI, vecJ);
        if (sim >= threshold) {
          group.push(entries[j]);
          groupIds.push(entries[j].id);
        }
      }

      if (group.length >= minGroupSize) {
        for (const id of groupIds) assigned.add(id);

        // Compute average pairwise similarity
        let totalSim = 0;
        let pairCount = 0;
        for (let a = 0; a < group.length; a++) {
          for (let b = a + 1; b < group.length; b++) {
            const vecA = embeddings.get(group[a].id);
            const vecB = embeddings.get(group[b].id);
            if (vecA && vecB) {
              totalSim += cosineSimilarity(vecA, vecB);
              pairCount++;
            }
          }
        }

        groups.push({
          primaryId: groupIds[0],
          entryIds: groupIds,
          entries: group,
          avgSimilarity: pairCount > 0 ? totalSim / pairCount : threshold,
        });
      }
    }

    return groups;
  }

  /**
   * Merge a group of fragment entries into a single cohesive entry using LLM.
   * The primary entry is updated with merged content; others are marked with
   * a reference to the merged entry.
   */
  async mergeFragments(group: KnowledgeEntry[]): Promise<MergeResult | null> {
    if (group.length < 2) return null;

    const llmConfig = resolveLlmConfig();
    if ('error' in llmConfig) {
      throw new Error(`Fragment merge failed: ${llmConfig.error}`);
    }

    const llm = new OpenAILLMProvider({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl,
      model: llmConfig.model,
      timeoutMs: 120_000,
    });

    const prompt = buildMergePrompt(group);
    const rawResponse = await llm.complete(prompt);
    const parsed = parseMergeResponse(rawResponse);

    if (!parsed) return null;

    // Use the first entry as the primary (will be updated with merged content)
    const primary = group[0];
    const absorbedIds = group.slice(1).map((e) => e.id);

    const mergedEntry: KnowledgeEntry = {
      ...primary,
      title: parsed.title,
      content: parsed.content,
      summary: parsed.summary,
      updatedAt: new Date(),
      version: primary.version + 1,
      metadata: {
        ...primary.metadata,
        domainData: {
          ...(primary.metadata?.domainData ?? {}),
          mergedFrom: group.map((e) => e.id),
        },
      },
    };

    return {
      mergedEntry,
      absorbedIds,
      rationale: parsed.rationale,
    };
  }

  /**
   * Full governance run: detect fragments → merge → update DB.
   * Merged entries supersede the absorbed ones (preserving reference).
   */
  async run(options: FragmentAggregatorOptions = {}): Promise<AggregationReport> {
    const dryRun = options.dryRun ?? false;
    const groups = await this.detectFragments(options);

    const report: AggregationReport = {
      totalEntries: await this.repository.count(),
      groupsDetected: groups.length,
      entriesMerged: 0,
      entriesRemoved: 0,
      groups,
      mergeResults: [],
    };

    if (dryRun || groups.length === 0) return report;

    for (const group of groups) {
      try {
        const result = await this.mergeFragments(group.entries);
        if (!result) continue;

        // Save the merged entry (updates the primary)
        await this.repository.save(result.mergedEntry);

        // Mark absorbed entries as superseded — they won't appear in normal search
        for (const absorbedId of result.absorbedIds) {
          const absorbed = await this.repository.findById(absorbedId);
          if (absorbed) {
            const updated: KnowledgeEntry = {
              ...absorbed,
              supersedes: undefined,
              status: 'superseded',
              updatedAt: new Date(),
              metadata: {
                ...absorbed.metadata,
                domainData: {
                  ...(absorbed.metadata?.domainData ?? {}),
                  supersededBy: result.mergedEntry.id,
                  mergedInto: result.mergedEntry.id,
                },
              },
            };
            await this.repository.save(updated);
          }
        }

        report.entriesMerged++;
        report.entriesRemoved += result.absorbedIds.length;
        report.mergeResults.push(result);
      } catch {
        // Skip groups that fail to merge — don't break the entire run
        continue;
      }
    }

    return report;
  }

  /**
   * Get BGE embeddings for entries.
   */
  private async getEmbeddings(
    entries: KnowledgeEntry[],
  ): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();

    // Batch embed all entries
    const texts = entries.map((e) => `${e.title}\n${e.content}`);
    if (texts.length === 0) return embeddings;

    try {
      const vectors = await this.embedder.embedBatch(texts);
      for (let i = 0; i < entries.length; i++) {
        if (vectors[i]) {
          embeddings.set(entries[i].id, vectors[i]);
        }
      }
    } catch {
      // If batch embedding fails, try one by one
      for (const entry of entries) {
        try {
          const vec = await this.embedder.embed(`${entry.title}\n${entry.content}`);
          embeddings.set(entry.id, vec);
        } catch {
          // Skip entries that can't be embedded
        }
      }
    }

    return embeddings;
  }
}
