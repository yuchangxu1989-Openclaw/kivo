import type { KnowledgeRepository, SearchResult as RepositorySearchResult } from '../repository/index.js';
import { estimateTokens } from '../injection/injection-formatter.js';
import {
  type InjectedContextEntry,
  type InjectedContextSource,
  type InjectionRequest,
  type InjectionResult,
} from './context-injection-types.js';

const DEFAULT_LIMIT = 12;
const DEFAULT_MIN_RELEVANCE = 0.15;

export interface ContextInjectorOptions {
  repository: KnowledgeRepository;
  defaultLimit?: number;
  defaultMinRelevance?: number;
}

export class ContextInjector {
  private readonly repository: KnowledgeRepository;
  private readonly defaultLimit: number;
  private readonly defaultMinRelevance: number;

  constructor(options: ContextInjectorOptions) {
    this.repository = options.repository;
    this.defaultLimit = normalizePositiveInteger(options.defaultLimit, DEFAULT_LIMIT);
    this.defaultMinRelevance = normalizeThreshold(
      options.defaultMinRelevance,
      DEFAULT_MIN_RELEVANCE
    );
  }

  async inject(request: InjectionRequest): Promise<InjectionResult> {
    const query = request.query.trim();
    const tokenBudget = normalizeTokenBudget(request.tokenBudget);

    if (!query || tokenBudget === 0) {
      return { entries: [], totalTokens: 0, truncated: false };
    }

    const limit = normalizePositiveInteger(request.limit, this.defaultLimit);
    const minRelevance = normalizeThreshold(request.minRelevance, this.defaultMinRelevance);
    const results = await this.repository.search({
      text: query,
      filters: request.preferredTypes ? { types: request.preferredTypes } : undefined,
      topK: Math.max(limit * 3, limit),
      minScore: minRelevance,
    });

    const ranked = results
      .filter((result) => result.score >= minRelevance)
      .sort((a, b) => compareResults(a, b))
      .slice(0, Math.max(limit * 3, limit));

    // FR-E01-AC4: Terminology entries (domain=system-dictionary) get priority.
    // When budget is tight, terminology is injected first.
    const terminology = ranked.filter((r) => r.entry.domain === 'system-dictionary');
    const general = ranked.filter((r) => r.entry.domain !== 'system-dictionary');
    const prioritized = [...terminology, ...general];

    return fitWithinBudget(prioritized, tokenBudget, limit);
  }
}

function fitWithinBudget(
  ranked: RepositorySearchResult[],
  tokenBudget: number,
  limit: number
): InjectionResult {
  const entries: InjectedContextEntry[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const result of ranked) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }

    const entry = toInjectedContextEntry(result);

    if (entry.estimatedTokens > tokenBudget) {
      truncated = true;
      continue;
    }

    if (totalTokens + entry.estimatedTokens > tokenBudget) {
      truncated = true;
      continue;
    }

    entries.push(entry);
    totalTokens += entry.estimatedTokens;
  }

  if (!truncated && entries.length < ranked.length) {
    truncated = true;
  }

  return {
    entries,
    totalTokens,
    truncated,
  };
}

function toInjectedContextEntry(result: RepositorySearchResult): InjectedContextEntry {
  const summary = pickSummary(result.entry.summary, result.entry.content);
  return {
    entryId: result.entry.id,
    title: result.entry.title,
    type: result.entry.type,
    summary,
    confidence: clamp(result.entry.confidence),
    relevance: clamp(result.score),
    estimatedTokens: estimateTokens(`${result.entry.title}\n${summary}\n${formatSourceLabel(result.entry.source)}`),
    source: toSourceDescriptor(result.entry.source),
  };
}

function toSourceDescriptor(source: RepositorySearchResult['entry']['source']): InjectedContextSource {
  return {
    type: source.type,
    reference: source.reference,
    timestamp: new Date(source.timestamp),
    agent: source.agent,
    label: formatSourceLabel(source),
  };
}

function formatSourceLabel(source: RepositorySearchResult['entry']['source']): string {
  const parts = [source.type, source.reference];
  if (source.agent) {
    parts.push(`agent:${source.agent}`);
  }
  return parts.join(' | ');
}

function pickSummary(summary: string, content: string): string {
  const normalized = summary.trim() || content.trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function compareResults(a: RepositorySearchResult, b: RepositorySearchResult): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime();
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return clamp(value);
}

function normalizeTokenBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
