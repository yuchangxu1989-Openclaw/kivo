import type { KnowledgeSource, KnowledgeType } from '../types/index.js';

export interface InjectionRequest {
  query: string;
  tokenBudget: number;
  preferredTypes?: KnowledgeType[];
  limit?: number;
  minRelevance?: number;
}

export interface InjectedContextSource {
  type: KnowledgeSource['type'];
  reference: string;
  timestamp: Date;
  agent?: string;
  label: string;
}

export interface InjectedContextEntry {
  entryId: string;
  title: string;
  type: KnowledgeType;
  summary: string;
  confidence: number;
  relevance: number;
  estimatedTokens: number;
  source: InjectedContextSource;
}

export interface InjectionResult {
  entries: InjectedContextEntry[];
  totalTokens: number;
  truncated: boolean;
}
