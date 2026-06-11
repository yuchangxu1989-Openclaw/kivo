export interface IntentRecord {
  id: string;
  name: string;
  description: string;
  why?: string;
  similarSentences?: string[];
  positives: string[];
  negatives: string[];
  status: 'active' | 'archived';
  hitCount: number;
  lastHitAt?: Date;
  confidence: number;
  sourceSessionId?: string;
  sourceMessageId?: string;
  embedding?: Buffer | string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntentInput {
  id?: string;
  name: string;
  description: string;
  why?: string;
  similarSentences?: string[];
  positives?: string[];
  negatives?: string[];
  status?: 'active' | 'archived';
  confidence?: number;
  sourceSessionId?: string;
  sourceMessageId?: string;
  embedding?: number[] | Buffer | string | null;
}

export interface IntentSearchResult {
  intent: IntentRecord;
  score: number;
}

export interface IntentSearchOptions {
  limit?: number;
  minScore?: number;
  status?: 'active' | 'archived';
}
