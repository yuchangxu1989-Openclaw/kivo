export { ConflictDetector, keywordOverlap } from './conflict-detector.js';
export { cosineSimilarity } from '../utils/math.js';
export type { ConflictDetectorOptions } from './conflict-detector.js';
export { ConflictResolver } from './conflict-resolver.js';
export type { ResolutionResult } from './conflict-resolver.js';
export { ConflictResolutionLog } from './conflict-resolution-log.js';
export type { ResolutionLogEntry } from './conflict-resolution-log.js';
export type { ConflictRecord, ConflictVerdict, ResolutionStrategy } from './conflict-record.js';
export type { EmbeddingProvider, LLMJudgeProvider } from './spi.js';
