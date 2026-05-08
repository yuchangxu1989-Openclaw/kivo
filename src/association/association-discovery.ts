import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { Association, AssociationType } from './association-types.js';
import { AssociationStore } from './association-store.js';

const DEPENDS_ON_STOP_WORDS = new Set([
  'api', 'sdk', 'cli', 'url', 'faq', 'todo', 'test', 'tests',
  '配置', '测试', '概述', '简介', '总结', '说明', '备注', '其他',
  'config', 'setup', 'intro', 'notes', 'guide', 'overview', 'summary',
]);

export interface DiscoveryCandidate {
  sourceId: string;
  targetId: string;
  type: AssociationType;
  strength: number;
  reason: string;
}

export interface DiscoveryOptions {
  similarityThreshold?: number;
  maxCandidates?: number;
  maxScanEntries?: number;
  autoCommit?: boolean;
}

export class AssociationDiscovery {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly store: AssociationStore
  ) {}

  async discoverForEntry(
    entry: KnowledgeEntry,
    options: DiscoveryOptions = {}
  ): Promise<DiscoveryCandidate[]> {
    const threshold = options.similarityThreshold ?? 0.3;
    const maxCandidates = options.maxCandidates ?? 20;
    const maxScan = options.maxScanEntries ?? 200;
    const existing = await this.repository.findAll();
    const others = existing.filter((e) => e.id !== entry.id);

    const scanSet = others.length <= maxScan
      ? others
      : prioritizeCandidates(others, entry, maxScan);

    const candidates: DiscoveryCandidate[] = [];

    for (const other of scanSet) {
      const detected = this.detectAssociations(entry, other);
      for (const candidate of detected) {
        if (candidate.strength >= threshold) {
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const trimmed = candidates.slice(0, maxCandidates);

    if (options.autoCommit) {
      for (const candidate of trimmed) {
        this.store.add({
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          type: candidate.type,
          strength: candidate.strength,
          metadata: { reason: candidate.reason, autoDiscovered: true },
        });
      }
    }

    return trimmed;
  }
  private detectAssociations(
    entry: KnowledgeEntry,
    other: KnowledgeEntry
  ): DiscoveryCandidate[] {
    const results: DiscoveryCandidate[] = [];

    const supersedes = this.detectSupersedes(entry, other);
    if (supersedes) results.push(supersedes);

    const conflicts = this.detectConflicts(entry, other);
    if (conflicts) results.push(conflicts);

    const dependsOn = this.detectDependsOn(entry, other);
    if (dependsOn) results.push(dependsOn);

    const supplements = this.detectSupplements(entry, other);
    if (supplements) results.push(supplements);

    return results;
  }

  private detectSupersedes(
    entry: KnowledgeEntry,
    other: KnowledgeEntry
  ): DiscoveryCandidate | null {
    if (entry.supersedes === other.id) {
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'supersedes',
        strength: 0.95,
        reason: 'explicit supersedes reference',
      };
    }

    const sameDomain = entry.domain && other.domain && entry.domain === other.domain;
    const highOverlap = this.lexicalOverlap(entry, other) > 0.6;
    const newer = entry.createdAt > other.createdAt;
    if (sameDomain && highOverlap && newer) {
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'supersedes',
        strength: 0.75,
        reason: 'high overlap with deprecated entry in same domain',
      };
    }

    return null;
  }

  private detectConflicts(
    entry: KnowledgeEntry,
    other: KnowledgeEntry
  ): DiscoveryCandidate | null {
    const sameDomain = entry.domain && other.domain && entry.domain === other.domain;
    const sameType = entry.type === other.type;
    const overlap = this.lexicalOverlap(entry, other);

    if (sameDomain && sameType && overlap > 0.5) {
      const titleSim = this.titleSimilarity(entry.title, other.title);
      if (titleSim > 0.6) {
        const strength = clamp(0.4 + overlap * 0.3 + titleSim * 0.2);
        return {
          sourceId: entry.id,
          targetId: other.id,
          type: 'conflicts',
          strength,
          reason: 'same domain/type with high title and content overlap',
        };
      }
    }

    return null;
  }

  private detectDependsOn(
    entry: KnowledgeEntry,
    other: KnowledgeEntry
  ): DiscoveryCandidate | null {
    const contentLower = entry.content.toLowerCase();
    const titleLower = other.title.toLowerCase();

    if (titleLower.length < 5 || DEPENDS_ON_STOP_WORDS.has(titleLower)) {
      return null;
    }

    if (contentLower.includes(titleLower)) {
      const strength = clamp(0.5 + (entry.confidence + other.confidence) * 0.15);
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'depends_on',
        strength,
        reason: 'entry content references other entry title',
      };
    }

    return null;
  }

  private detectSupplements(
    entry: KnowledgeEntry,
    other: KnowledgeEntry
  ): DiscoveryCandidate | null {
    const sameDomain = entry.domain && other.domain && entry.domain === other.domain;
    const overlap = this.lexicalOverlap(entry, other);
    const sharedTags = this.sharedTagRatio(entry.tags, other.tags);

    if (sameDomain && overlap > 0.25 && overlap <= 0.5 && sharedTags > 0.3) {
      const strength = clamp(0.35 + overlap * 0.3 + sharedTags * 0.25);
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'supplements',
        strength,
        reason: 'same domain with moderate overlap and shared tags',
      };
    }

    if (sameSource(entry, other) && entry.id !== other.id) {
      const strength = clamp(0.4 + overlap * 0.2);
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'supplements',
        strength,
        reason: 'entries from same source',
      };
    }

    return null;
  }

  private lexicalOverlap(a: KnowledgeEntry, b: KnowledgeEntry): number {
    const left = tokenize(`${a.title} ${a.summary} ${a.content}`);
    const right = tokenize(`${b.title} ${b.summary} ${b.content}`);
    if (left.size === 0 || right.size === 0) return 0;
    let count = 0;
    for (const t of left) {
      if (right.has(t)) count++;
    }
    return count / Math.max(left.size, right.size);
  }

  private titleSimilarity(a: string, b: string): number {
    const left = tokenize(a);
    const right = tokenize(b);
    if (left.size === 0 || right.size === 0) return 0;
    let count = 0;
    for (const t of left) {
      if (right.has(t)) count++;
    }
    return count / Math.max(left.size, right.size);
  }

  private sharedTagRatio(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const setB = new Set(b.map((t) => t.toLowerCase()));
    let shared = 0;
    for (const tag of a) {
      if (setB.has(tag.toLowerCase())) shared++;
    }
    return shared / Math.max(a.length, b.length);
  }
}

function sameSource(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
  return a.source.type === b.source.type && a.source.reference === b.source.reference;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
  );
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function prioritizeCandidates(
  others: KnowledgeEntry[],
  entry: KnowledgeEntry,
  limit: number
): KnowledgeEntry[] {
  const sameDomain: KnowledgeEntry[] = [];
  const rest: KnowledgeEntry[] = [];
  for (const o of others) {
    if (entry.domain && o.domain === entry.domain) {
      sameDomain.push(o);
    } else {
      rest.push(o);
    }
  }
  sameDomain.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  rest.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return [...sameDomain, ...rest].slice(0, limit);
}
