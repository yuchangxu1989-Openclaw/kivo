import type { KnowledgeType } from '../types/index.js';
import type { InjectedContextEntry } from './context-injection-types.js';

export type DisambiguationMode = 'llm' | 'fallback';

export interface DisambiguationRequest {
  input: string;
  preferredTypes?: KnowledgeType[];
  confidenceThreshold?: number;
  limit?: number;
}

export interface Interpretation {
  meaning: string;
  confidence: number;
  evidence: InjectedContextEntry[];
}

export interface ClarificationSuggestion {
  question: string;
  options: string[];
  reason: string;
  evidence: InjectedContextEntry[];
}

export interface DisambiguationResult {
  interpretations: Interpretation[];
  selected?: Interpretation;
  clarification?: ClarificationSuggestion;
  resolutionMode: DisambiguationMode;
  fallbackReason?: string;
}
