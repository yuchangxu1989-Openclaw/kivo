/**
 * DictionaryService — 术语 CRUD + 生命周期 + 版本触发
 * FR-H01, FR-H04
 *
 * 术语是 KnowledgeEntry 的特化视图（type=fact, domain=system-dictionary）。
 * definition/constraints 变更触发新版本，其他字段原地更新。
 */

import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import type { StorageAdapter, KnowledgeFilter } from '../storage/storage-types.js';
import type {
  TermMetadata,
  TermRegistrationInput,
  TermUpdatePatch,
  DictionaryConfig,
  TermChangeEvent,
  TermChangeHandler,
  TermChangeEventType,
} from './term-types.js';
import { DEFAULT_DICTIONARY_CONFIG, DICTIONARY_DOMAIN, DICTIONARY_TAG } from './term-types.js';
import type { TermConflictChecker } from './term-conflict-checker.js';
import { v4 as uuid } from 'uuid';

export interface DictionaryServiceOptions {
  store: StorageAdapter;
  conflictChecker?: TermConflictChecker;
  config?: Partial<DictionaryConfig>;
}

export class DictionaryService {
  private readonly store: StorageAdapter;
  private readonly conflictChecker?: TermConflictChecker;
  readonly config: DictionaryConfig;
  private readonly changeHandlers: TermChangeHandler[] = [];
  private registerMutex: Promise<void> = Promise.resolve();

  constructor(options: DictionaryServiceOptions) {
    this.store = options.store;
    this.conflictChecker = options.conflictChecker;
    this.config = { ...DEFAULT_DICTIONARY_CONFIG, ...options.config };
  }

  /** 注册术语变更事件监听器 (P0-1: FR-H04-AC5) */
  onTermChange(handler: TermChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  /** 移除术语变更事件监听器 */
  offTermChange(handler: TermChangeHandler): void {
    const idx = this.changeHandlers.indexOf(handler);
    if (idx >= 0) this.changeHandlers.splice(idx, 1);
  }

  private async emitChange(type: TermChangeEventType, entryId: string, term: string, payload: Record<string, unknown> = {}): Promise<void> {
    const event: TermChangeEvent = { type, entryId, term, timestamp: new Date(), payload };
    for (const handler of this.changeHandlers) {
      try { await handler(event); } catch { /* listener errors don't break operations */ }
    }
  }

  /** 注册新术语 (P0-2: mutex 防 TOCTOU 竞态) */
  async register(input: TermRegistrationInput): Promise<KnowledgeEntry> {
    // 串行化 register 调用，消除唯一性检查与写入之间的竞态窗口
    let resolve!: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    const prev = this.registerMutex;
    this.registerMutex = next;

    await prev;
    try {
      // 唯一性校验
      await this.ensureUnique(input.term, input.aliases ?? [], input.scope);

      // 冲突检测
      const entry = this.buildEntry(input);
      if (this.conflictChecker) {
        const existingTerms = await this.queryAllActiveTerms();
        const conflicts = await this.conflictChecker.check(entry, existingTerms);
        if (conflicts.length > 0) {
          const detail = conflicts.map(c => `${c.type}: ${c.details}`).join('; ');
          throw new Error(`Term conflict detected: ${detail}`);
        }
      }

      const saved = await this.store.save(entry);
      await this.emitChange('registered', saved.id, input.term);
      return saved;
    } finally {
      resolve();
    }
  }

  /** 更新术语 — definition/constraints 变更触发新版本 */
  async update(id: string, patch: TermUpdatePatch, expectedVersion: number): Promise<KnowledgeEntry> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`Term not found: ${id}`);
    if (existing.version !== expectedVersion) {
      throw new Error(`Version conflict: expected ${expectedVersion}, got ${existing.version}`);
    }

    const meta = existing.metadata as TermMetadata;
    const isVersionTrigger = patch.definition !== undefined || patch.constraints !== undefined;

    // 别名唯一性校验
    if (patch.aliases) {
      await this.ensureAliasesUnique(patch.aliases, existing.id, patch.scope ?? meta.scope);
    }
    if (patch.scope) {
      await this.ensureTermUniqueInScope(meta.term, patch.scope, existing.id);
    }

    if (isVersionTrigger) {
      // 创建新版本，旧版本 superseded
      await this.store.update(id, { status: 'superseded' });

      const newMeta: TermMetadata = {
        ...meta,
        definition: patch.definition ?? meta.definition,
        constraints: patch.constraints ?? meta.constraints,
        aliases: patch.aliases ?? meta.aliases,
        positiveExamples: patch.positiveExamples ?? meta.positiveExamples,
        negativeExamples: patch.negativeExamples ?? meta.negativeExamples,
        scope: patch.scope ?? meta.scope,
      };

      const newEntry: KnowledgeEntry = {
        id: uuid(),
        type: 'fact',
        title: meta.term,
        content: newMeta.definition,
        summary: newMeta.definition.slice(0, 120),
        source: existing.source,
        confidence: existing.confidence,
        status: 'active',
        tags: [DICTIONARY_TAG, ...newMeta.scope],
        domain: DICTIONARY_DOMAIN,
        metadata: newMeta,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: existing.version + 1,
        supersedes: id,
      };

      const saved = await this.store.save(newEntry);
      await this.emitChange('updated', saved.id, meta.term, { versionTrigger: true, previousVersion: existing.version });
      return saved;
    }

    // 非版本触发：原地更新 metadata
    const updatedMeta: TermMetadata = {
      ...meta,
      aliases: patch.aliases ?? meta.aliases,
      positiveExamples: patch.positiveExamples ?? meta.positiveExamples,
      negativeExamples: patch.negativeExamples ?? meta.negativeExamples,
      scope: patch.scope ?? meta.scope,
    };

    const result = await this.store.update(id, {
      tags: [DICTIONARY_TAG, ...updatedMeta.scope],
      metadata: updatedMeta,
    });
    if (!result) throw new Error(`Failed to update term: ${id}`);
    await this.emitChange('updated', result.id, meta.term, { versionTrigger: false });
    return result;
  }

  /** 废弃术语 */
  async deprecate(id: string, reason: string, replacementTermId?: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`Term not found: ${id}`);
    const meta = existing.metadata as TermMetadata;

    await this.store.update(id, {
      status: 'deprecated',
      metadata: {
        ...existing.metadata,
        deprecatedAt: new Date(),
        deprecationReason: reason,
        deprecationReplacementTermId: replacementTermId,
      } as TermMetadata & { deprecationReason: string },
    });

    await this.emitChange('deprecated', id, meta?.term ?? existing.title, { reason, replacementTermId });
  }

  /** 合并术语 (P1-5: supersedes 指向 + 回退能力) */
  async merge(sourceIds: string[], targetId: string): Promise<KnowledgeEntry> {
    const target = await this.store.get(targetId);
    if (!target) throw new Error(`Target term not found: ${targetId}`);
    const targetMeta = target.metadata as TermMetadata;

    for (const sourceId of sourceIds) {
      const source = await this.store.get(sourceId);
      if (!source) throw new Error(`Source term not found: ${sourceId}`);
      // 设置 supersedes 指向 targetId，保留合并前状态以支持回退
      await this.store.update(sourceId, {
        status: 'superseded',
        supersedes: targetId,
        metadata: {
          ...source.metadata,
          mergedInto: targetId,
          premergeStatus: source.status,
          deprecationReplacementTermId: targetId,
        } as TermMetadata & { mergedInto: string; premergeStatus: string },
      });
    }

    await this.emitChange('merged', targetId, targetMeta?.term ?? target.title, { sourceIds });
    return target;
  }

  /** 回退合并操作：恢复被合并条目的原始状态 */
  async rollbackMerge(sourceIds: string[]): Promise<void> {
    for (const sourceId of sourceIds) {
      const source = await this.store.get(sourceId);
      if (!source) throw new Error(`Source term not found: ${sourceId}`);
      const meta = source.metadata as Record<string, unknown> | undefined;
      const premergeStatus = (meta?.premergeStatus as string) ?? 'active';
      await this.store.update(sourceId, {
        status: premergeStatus as 'active' | 'deprecated' | 'superseded',
        supersedes: undefined,
        metadata: {
          ...meta,
          mergedInto: undefined,
          premergeStatus: undefined,
        } as unknown as TermMetadata,
      });
    }
  }

  /** 按术语名查找 */
  async getByTerm(term: string, scope?: string): Promise<KnowledgeEntry | null> {
    const result = await this.store.query(this.dictionaryFilter());
    const normalized = term.toLowerCase();
    for (const entry of result.items) {
      if (entry.status !== 'active') continue;
      const meta = entry.metadata as TermMetadata;
      if (!meta) continue;
      if (meta.term.toLowerCase() === normalized) {
        if (!scope || meta.scope.includes(scope)) return entry;
      }
    }
    return null;
  }

  /** 按 scope 列出术语 */
  async listByScope(scope: string, page = 0, pageSize = 50): Promise<KnowledgeEntry[]> {
    const result = await this.store.query(
      { ...this.dictionaryFilter(), tags: [scope] },
      { offset: page * pageSize, limit: pageSize },
    );
    return result.items.filter(e => e.status === 'active');
  }

  /** 获取所有活跃术语 */
  async queryAllActiveTerms(): Promise<KnowledgeEntry[]> {
    const result = await this.store.query({
      ...this.dictionaryFilter(),
      status: 'active',
    });
    return result.items;
  }

  // ── private helpers ──

  private buildEntry(input: TermRegistrationInput): KnowledgeEntry {
    const meta: TermMetadata = {
      term: input.term,
      aliases: input.aliases ?? [],
      definition: input.definition,
      constraints: input.constraints ?? [],
      positiveExamples: input.positiveExamples ?? [],
      negativeExamples: input.negativeExamples ?? [],
      scope: input.scope,
      governanceSource: input.governanceSource,
    };

    return {
      id: uuid(),
      type: 'fact',
      title: input.term,
      content: input.definition,
      summary: input.definition.slice(0, 120),
      source: input.source,
      confidence: 1.0,
      status: 'active',
      tags: [DICTIONARY_TAG, ...input.scope],
      domain: DICTIONARY_DOMAIN,
      metadata: meta,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
  }

  private dictionaryFilter(): KnowledgeFilter {
    return { domain: DICTIONARY_DOMAIN, type: 'fact' };
  }

  private async ensureUnique(term: string, aliases: string[], scope: string[]): Promise<void> {
    await this.ensureTermUniqueInScope(term, scope);
    await this.ensureAliasesUnique(aliases, undefined, scope);
  }

  private async ensureTermUniqueInScope(term: string, scope: string[], excludeId?: string): Promise<void> {
    const all = await this.queryAllActiveTerms();
    const normalized = term.toLowerCase();
    for (const entry of all) {
      if (excludeId && entry.id === excludeId) continue;
      const meta = entry.metadata as TermMetadata;
      if (!meta) continue;
      const hasOverlap = meta.scope.some(s => scope.includes(s));
      if (!hasOverlap) continue;
      if (meta.term.toLowerCase() === normalized) {
        throw new Error(`Term "${term}" already exists in overlapping scope`);
      }
      if (meta.aliases.some(a => a.toLowerCase() === normalized)) {
        throw new Error(`Term "${term}" conflicts with alias of "${meta.term}"`);
      }
    }
  }

  private async ensureAliasesUnique(aliases: string[], excludeId?: string, scope?: string[]): Promise<void> {
    if (aliases.length === 0) return;
    const all = await this.queryAllActiveTerms();
    for (const alias of aliases) {
      const normalized = alias.toLowerCase();
      for (const entry of all) {
        if (excludeId && entry.id === excludeId) continue;
        const meta = entry.metadata as TermMetadata;
        if (!meta) continue;
        if (scope && !meta.scope.some(s => scope.includes(s))) continue;
        if (meta.term.toLowerCase() === normalized) {
          throw new Error(`Alias "${alias}" conflicts with term "${meta.term}"`);
        }
        if (meta.aliases.some(a => a.toLowerCase() === normalized)) {
          throw new Error(`Alias "${alias}" conflicts with alias of "${meta.term}"`);
        }
      }
    }
  }
}
