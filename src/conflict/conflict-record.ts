/**
 * ConflictRecord — 冲突记录结构
 */

export type ConflictVerdict = 'conflict' | 'compatible' | 'unrelated';

export type ResolutionStrategy = 'newer-wins' | 'confidence-wins' | 'manual';

export interface ConflictRecord {
  id: string;
  incomingId: string;
  existingId: string;
  verdict: ConflictVerdict;
  detectedAt: Date;
  resolved: boolean;
  resolvedAt?: Date;
  resolution?: ResolutionStrategy;
  winnerId?: string;
}
