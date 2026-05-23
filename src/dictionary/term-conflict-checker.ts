/**
 * TermConflictChecker — 三类术语冲突检测
 * FR-H03
 *
 * 1. 别名冲突（精确匹配，不依赖 LLM）
 * 2. 范围重叠（scope 交集 + constraints 矛盾，委托 ConflictDetector LLM 精判）
 * 3. 语义矛盾（复用 ConflictDetector 两阶段判定，独立阈值）
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { ConflictDetector } from '../conflict/conflict-detector.js';
import type { TermMetadata, TermConflictResult, DictionaryConfig } from './term-types.js';
import { DEFAULT_DICTIONARY_CONFIG, DICTIONARY_DOMAIN } from './term-types.js';

export interface TermConflictCheckerOptions {
  conflictDetector?: ConflictDetector;
  config?: Partial<DictionaryConfig>;
}

export class TermConflictChecker {
  private readonly conflictDetector?: ConflictDetector;
  private readonly config: DictionaryConfig;

  constructor(options: TermConflictCheckerOptions = {}) {
    this.conflictDetector = options.conflictDetector;
    this.config = { ...DEFAULT_DICTIONARY_CONFIG, ...options.config };
  }

  /** 检测新术语与已有术语集合的冲突 */
  async check(incoming: KnowledgeEntry, existingTerms: KnowledgeEntry[]): Promise<TermConflictResult[]> {
    const results: TermConflictResult[] = [];
    const activeTerms = existingTerms.filter(
      e => e.domain === DICTIONARY_DOMAIN && e.status === 'active' && e.id !== incoming.id,
    );

    if (activeTerms.length === 0) return results;

    const inMeta = incoming.metadata as TermMetadata | undefined;
    if (!inMeta) return results;

    for (const existing of activeTerms) {
      const exMeta = existing.metadata as TermMetadata | undefined;
      if (!exMeta) continue;

      // 1. 别名冲突检测
      const aliasConflict = this.checkAliasConflict(inMeta, exMeta, incoming.id, existing.id);
      if (aliasConflict) {
        results.push(aliasConflict);
        continue; // 别名冲突已确定，跳过后续检测
      }

      // 2. 范围重叠检测
      const scopeConflict = await this.checkScopeOverlap(incoming, existing, inMeta, exMeta);
      if (scopeConflict) {
        results.push(scopeConflict);
        continue;
      }

      // 3. 语义矛盾检测（委托 ConflictDetector）
      const semanticConflict = await this.checkSemanticContradiction(incoming, existing);
      if (semanticConflict) {
        results.push(semanticConflict);
      }
    }

    return results;
  }

  /** 别名精确匹配（大小写不敏感） */
  private checkAliasConflict(
    incoming: TermMetadata,
    existing: TermMetadata,
    incomingId: string,
    existingId: string,
  ): TermConflictResult | null {
    const incomingNames = [incoming.term, ...incoming.aliases].map(n => n.toLowerCase());
    const existingNames = [existing.term, ...existing.aliases].map(n => n.toLowerCase());

    for (const name of incomingNames) {
      if (existingNames.includes(name)) {
        return {
          type: 'alias_conflict',
          incomingId,
          existingId,
          details: `Name/alias "${name}" conflicts with existing term "${existing.term}"`,
          suggestion: 'merge',
        };
      }
    }
    return null;
  }

  /** 范围重叠 + constraints 矛盾 */
  private async checkScopeOverlap(
    incoming: KnowledgeEntry,
    existing: KnowledgeEntry,
    inMeta: TermMetadata,
    exMeta: TermMetadata,
  ): Promise<TermConflictResult | null> {
    const scopeIntersection = inMeta.scope.filter(s => exMeta.scope.includes(s));
    if (scopeIntersection.length === 0) return null;

    // constraints 都为空则无冲突
    if (inMeta.constraints.length === 0 && exMeta.constraints.length === 0) return null;

    // 有 ConflictDetector 时委托 LLM 精判，传递独立阈值
    if (this.conflictDetector) {
      const records = await this.conflictDetector.detect(incoming, [existing], {
        similarityThreshold: this.config.conflict.embeddingSimilarityThreshold,
      });
      if (records.length > 0) {
        return {
          type: 'scope_overlap',
          incomingId: incoming.id,
          existingId: existing.id,
          details: `Scope overlap in [${scopeIntersection.join(', ')}] with conflicting constraints`,
          suggestion: 'modify',
        };
      }
    }

    return null;
  }

  /** 语义矛盾检测 — 复用 ConflictDetector，传递独立阈值 (P1-4) */
  private async checkSemanticContradiction(
    incoming: KnowledgeEntry,
    existing: KnowledgeEntry,
  ): Promise<TermConflictResult | null> {
    if (!this.conflictDetector) return null;

    const records = await this.conflictDetector.detect(incoming, [existing], {
      similarityThreshold: this.config.conflict.embeddingSimilarityThreshold,
    });
    if (records.length > 0) {
      return {
        type: 'semantic_contradiction',
        incomingId: incoming.id,
        existingId: existing.id,
        details: `Semantic contradiction detected between "${incoming.title}" and "${existing.title}"`,
        suggestion: 'deprecate_one',
      };
    }

    return null;
  }
}
