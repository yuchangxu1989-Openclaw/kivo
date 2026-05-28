import Database from 'better-sqlite3';
import type { KnowledgeEntry, KnowledgeType } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { InjectionFormat } from './injection-formatter.js';
import { InjectionFormatter, estimateTokens } from './injection-formatter.js';
import { InjectionPolicy } from './injection-policy.js';
import type { ScoredEntry } from './relevance-scorer.js';

export type SubjectRelationGroup =
  | 'prerequisites'
  | 'direct'
  | 'applications'
  | 'confusables'
  | 'frequentMistakes';

export type SubjectSourceRelationType =
  | 'semantic_match'
  | 'prerequisite_of'
  | 'explains'
  | 'illustrates'
  | 'assesses'
  | 'solved_by'
  | 'confusable_with'
  | 'derived_from'
  | 'proves'
  | 'applies_to'
  | 'belongs_to'
  | 'has_part'
  | 'annotated_with'
  | 'common_mistake'
  | 'error_cause'
  | 'requires'
  | 'depends_on'
  | 'supplements'
  | 'fallback_vector'
  | 'fallback_fts';

export interface SubjectSourceRef {
  entryId: string;
  relationType: SubjectSourceRelationType;
  hop: 0 | 1;
  seedEntryId?: string;
}

export interface SubjectAwareInjectedEntry {
  entryId: string;
  type: KnowledgeType;
  entryType?: KnowledgeEntry['entryType'];
  title: string;
  summary: string;
  strength: number;
  group: SubjectRelationGroup;
  sourceRef: SubjectSourceRef;
  source_ref: {
    entry_id: string;
    relation_type: SubjectSourceRelationType;
    hop_count: 0 | 1;
    seed_entry_id?: string;
  };
}

export interface SubjectAwareInjectionRequest {
  userQuery: string;
  tokenBudget: number;
  topK?: number;
  graphWeightThreshold?: number;
  format?: InjectionFormat;
  minScore?: number;
  preferredTypes?: KnowledgeType[];
}

export interface SubjectAwareInjectionResponse {
  injectedContext: string;
  groups: Record<SubjectRelationGroup, SubjectAwareInjectedEntry[]>;
  entries: SubjectAwareInjectedEntry[];
  tokensUsed: number;
  truncated: boolean;
  fallback: 'none' | 'vector_only' | 'fts' | 'zero';
  errors: string[];
}

interface SubjectAwareInjectorOptions {
  repository: KnowledgeRepository;
  dbPath?: string;
  graphStore?: GraphStore;
  defaultTopK?: number;
  defaultGraphWeightThreshold?: number;
}

interface GraphStore {
  expand(entryIds: string[], minWeight: number, limit: number): GraphEdgeHit[];
}

interface GraphEdgeHit {
  sourceId: string;
  targetId: string;
  relationType: SubjectSourceRelationType;
  weight: number;
}

interface Candidate {
  entry: KnowledgeEntry;
  strength: number;
  relationType: SubjectSourceRelationType;
  hop: 0 | 1;
  group: SubjectRelationGroup;
  seedEntryId?: string;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_GRAPH_WEIGHT_THRESHOLD = 0.3;
const GRAPH_EXPANSION_MULTIPLIER = 4;

const RELATION_GROUPS: Record<string, SubjectRelationGroup> = {
  prerequisite_of: 'prerequisites',
  requires: 'prerequisites',
  depends_on: 'prerequisites',
  solved_by: 'applications',
  explains: 'applications',
  illustrates: 'applications',
  assesses: 'applications',
  applies_to: 'applications',
  confusable_with: 'confusables',
  common_mistake: 'frequentMistakes',
  error_cause: 'frequentMistakes',
  derived_from: 'direct',
  proves: 'direct',
  belongs_to: 'direct',
  has_part: 'direct',
  annotated_with: 'direct',
  supplements: 'direct',
  semantic_match: 'direct',
  fallback_vector: 'direct',
  fallback_fts: 'direct',
};

const EMPTY_GROUPS: Record<SubjectRelationGroup, SubjectAwareInjectedEntry[]> = {
  prerequisites: [],
  direct: [],
  applications: [],
  confusables: [],
  frequentMistakes: [],
};

/**
 * Subject-aware injection for FR-P03 AC7.
 * Flow: BGE vector recall → one-hop graph expansion → dedupe/sort → grouped context.
 */
export class SubjectAwareInjector {
  private readonly repository: KnowledgeRepository;
  private readonly graphStore?: GraphStore;
  private readonly defaultTopK: number;
  private readonly defaultGraphWeightThreshold: number;

  constructor(options: SubjectAwareInjectorOptions) {
    this.repository = options.repository;
    this.graphStore = options.graphStore ?? (options.dbPath ? new SqliteGraphStore(options.dbPath) : undefined);
    this.defaultTopK = options.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultGraphWeightThreshold = options.defaultGraphWeightThreshold ?? DEFAULT_GRAPH_WEIGHT_THRESHOLD;
  }

  async inject(request: SubjectAwareInjectionRequest): Promise<SubjectAwareInjectionResponse> {
    const topK = request.topK ?? this.defaultTopK;
    const graphWeightThreshold = request.graphWeightThreshold ?? this.defaultGraphWeightThreshold;
    const format = request.format ?? 'markdown';
    const minScore = request.minScore ?? 0.1;

    let vectorResults: Array<{ entry: KnowledgeEntry; score: number }>;
    try {
      vectorResults = await this.repository.search({
        text: request.userQuery,
        topK,
        minScore,
      });
    } catch (err) {
      try {
        const ftsResults = await this.repository.fallbackFullTextSearch(request.userQuery, topK);
        return this.buildResponse(
          ftsResults.map((result) => ({
            entry: result.entry,
            strength: result.score,
            relationType: 'fallback_fts' as const,
            hop: 0 as const,
            group: groupForEntry(result.entry, 'fallback_fts'),
          })),
          request.tokenBudget,
          format,
          minScore,
          request.preferredTypes,
          'fts',
          [`vector:${errorMessage(err)}`],
        );
      } catch (fallbackErr) {
        return this.emptyResponse('zero', [
          `vector:${errorMessage(err)}`,
          `fts:${errorMessage(fallbackErr)}`,
        ]);
      }
    }

    if (vectorResults.length === 0) {
      return this.emptyResponse('zero');
    }

    const vectorCandidates: Candidate[] = vectorResults.map(({ entry, score }) => ({
      entry,
      strength: score,
      relationType: 'semantic_match',
      hop: 0,
      group: groupForEntry(entry, 'semantic_match'),
    }));

    let graphCandidates: Candidate[] = [];
    let fallback: SubjectAwareInjectionResponse['fallback'] = 'none';
    const errors: string[] = [];
    try {
      graphCandidates = await this.expandGraph(vectorResults, graphWeightThreshold, topK * GRAPH_EXPANSION_MULTIPLIER);
    } catch (err) {
      fallback = 'vector_only';
      errors.push(`graph:${errorMessage(err)}`);
    }

    return this.buildResponse(
      [...vectorCandidates, ...graphCandidates],
      request.tokenBudget,
      format,
      minScore,
      request.preferredTypes,
      fallback,
      errors,
    );
  }

  private async expandGraph(
    vectorResults: Array<{ entry: KnowledgeEntry; score: number }>,
    minWeight: number,
    limit: number,
  ): Promise<Candidate[]> {
    if (vectorResults.length === 0) return [];

    const vectorIds = vectorResults.map((result) => result.entry.id);
    const vectorScore = new Map(vectorResults.map((result) => [result.entry.id, result.score]));

    if (!this.graphStore) {
      const graphResults = await this.repository.expandGraphOneHop(vectorIds, {
        limitPerSeed: Math.max(1, Math.ceil(limit / Math.max(1, vectorIds.length))),
      });
      return graphResults
        .filter(result => result.strength >= minWeight)
        .filter(result => !vectorScore.has(result.entry.id))
        .map(result => ({
          entry: result.entry,
          strength: clamp01(result.strength * (vectorScore.get(result.seedEntryId) ?? 1)),
          relationType: normalizeRelationType(result.relationType),
          hop: 1 as const,
          group: groupForEntry(result.entry, normalizeRelationType(result.relationType)),
          seedEntryId: result.seedEntryId,
        }));
    }

    const edges = this.graphStore.expand(vectorIds, minWeight, limit);
    if (edges.length === 0) return [];

    const candidates: Candidate[] = [];
    const fetched = new Map<string, KnowledgeEntry | null>();
    for (const edge of edges) {
      const sourceMatched = vectorScore.has(edge.sourceId);
      const relatedId = sourceMatched ? edge.targetId : edge.sourceId;
      if (vectorScore.has(relatedId)) continue;

      if (!fetched.has(relatedId)) {
        fetched.set(relatedId, await this.repository.findById(relatedId));
      }
      const entry = fetched.get(relatedId);
      if (!entry || entry.status !== 'active') continue;

      const anchorId = sourceMatched ? edge.sourceId : edge.targetId;
      const anchorScore = vectorScore.get(anchorId) ?? 1;
      candidates.push({
        entry,
        strength: clamp01(edge.weight * anchorScore),
        relationType: edge.relationType,
        hop: 1,
        group: groupForEntry(entry, edge.relationType),
        seedEntryId: anchorId,
      });
    }

    return candidates;
  }

  private buildResponse(
    candidates: Candidate[],
    tokenBudget: number,
    format: InjectionFormat,
    minScore: number,
    preferredTypes: KnowledgeType[] | undefined,
    fallback: SubjectAwareInjectionResponse['fallback'],
    errors: string[] = [],
  ): SubjectAwareInjectionResponse {
    const deduped = dedupeByBestStrength(candidates).sort((a, b) => b.strength - a.strength);
    const formatter = new InjectionFormatter(format, 'summary');
    const blocks = formatter.formatEntries(deduped.map(candidate => candidate.entry));
    const scored: ScoredEntry[] = deduped.map(candidate => ({ entry: candidate.entry, score: candidate.strength }));
    const policy = new InjectionPolicy({ maxTokens: tokenBudget, preferredTypes, minScore });
    const selected = policy.apply(scored, blocks);
    const selectedIds = new Set(selected.selected.map(block => block.entryId));
    const entries = deduped.filter(candidate => selectedIds.has(candidate.entry.id)).map(toInjectedEntry);
    const groups = groupInjectedEntries(entries);

    const context = formatSubjectContext(groups);

    return {
      injectedContext: context,
      groups,
      entries,
      tokensUsed: selected.tokensUsed || estimateTokens(context),
      truncated: selected.truncated,
      fallback,
      errors,
    };
  }

  private emptyResponse(
    fallback: SubjectAwareInjectionResponse['fallback'] = 'zero',
    errors: string[] = [],
  ): SubjectAwareInjectionResponse {
    return {
      injectedContext: '',
      groups: {
        prerequisites: [],
        direct: [],
        applications: [],
        confusables: [],
        frequentMistakes: [],
      },
      entries: [],
      tokensUsed: 0,
      truncated: false,
      fallback,
      errors,
    };
  }
}

class SqliteGraphStore implements GraphStore {
  constructor(private readonly dbPath: string) {}

  expand(entryIds: string[], minWeight: number, limit: number): GraphEdgeHit[] {
    if (entryIds.length === 0) return [];
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const placeholders = entryIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT source_id, target_id, association_type, weight
        FROM graph_edges
        WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
          AND weight >= ?
        ORDER BY weight DESC
        LIMIT ?
      `).all(...entryIds, ...entryIds, minWeight, limit) as Array<{
        source_id: string;
        target_id: string;
        association_type: string;
        weight: number;
      }>;

      return rows.map(row => ({
        sourceId: row.source_id,
        targetId: row.target_id,
        relationType: normalizeRelationType(row.association_type),
        weight: clamp01(Number(row.weight)),
      }));
    } finally {
      db.close();
    }
  }
}

function normalizeRelationType(value: string): SubjectSourceRelationType {
  if (value === 'semantic_match' || value === 'fallback_vector' || value === 'fallback_fts') return value;
  if (value in RELATION_GROUPS) return value as SubjectSourceRelationType;
  return 'explains';
}

function groupForEntry(entry: KnowledgeEntry, relationType: SubjectSourceRelationType): SubjectRelationGroup {
  if (entry.entryType === 'mistake') return 'frequentMistakes';
  return RELATION_GROUPS[relationType] ?? 'direct';
}

function dedupeByBestStrength(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.entry.id);
    if (!current || candidate.strength > current.strength) {
      best.set(candidate.entry.id, candidate);
    }
  }
  return Array.from(best.values());
}

function toInjectedEntry(candidate: Candidate): SubjectAwareInjectedEntry {
  const sourceRef: SubjectSourceRef = {
    entryId: candidate.entry.id,
    relationType: candidate.relationType,
    hop: candidate.hop,
    seedEntryId: candidate.hop === 1 ? candidate.seedEntryId : undefined,
  };
  return {
    entryId: candidate.entry.id,
    type: candidate.entry.type,
    entryType: candidate.entry.entryType,
    title: candidate.entry.title,
    summary: candidate.entry.summary || candidate.entry.content.slice(0, 180),
    strength: candidate.strength,
    group: candidate.group,
    sourceRef,
    source_ref: {
      entry_id: sourceRef.entryId,
      relation_type: sourceRef.relationType,
      hop_count: sourceRef.hop,
      seed_entry_id: sourceRef.seedEntryId,
    },
  };
}

function groupInjectedEntries(entries: SubjectAwareInjectedEntry[]): Record<SubjectRelationGroup, SubjectAwareInjectedEntry[]> {
  const groups: Record<SubjectRelationGroup, SubjectAwareInjectedEntry[]> = {
    prerequisites: [],
    direct: [],
    applications: [],
    confusables: [],
    frequentMistakes: [],
  };
  for (const entry of entries) {
    groups[entry.group].push(entry);
  }
  for (const group of Object.values(groups)) {
    group.sort((a, b) => b.strength - a.strength);
  }
  return groups;
}

function formatSubjectContext(groups: Record<SubjectRelationGroup, SubjectAwareInjectedEntry[]>): string {
  const labels: Array<[SubjectRelationGroup, string]> = [
    ['prerequisites', '前置'],
    ['direct', '直接相关'],
    ['applications', '应用场景'],
    ['confusables', '易混点'],
    ['frequentMistakes', '高频错因'],
  ];
  const lines = ['<!-- KIVO Subject Knowledge -->'];
  let count = 0;
  for (const [group, label] of labels) {
    const entries = groups[group];
    if (entries.length === 0) continue;
    lines.push(`## ${label}`);
    for (const entry of entries) {
      lines.push(`- ${entry.title}（strength=${entry.strength.toFixed(3)}, source_ref=${entry.sourceRef.entryId}/${entry.sourceRef.relationType}/${entry.sourceRef.hop}hop）：${entry.summary}`);
      count++;
    }
  }
  lines.push('<!-- /KIVO Subject Knowledge -->');
  return count === 0 ? '' : lines.join('\n');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const __subjectAwareInjectionTestUtils = {
  EMPTY_GROUPS,
};
