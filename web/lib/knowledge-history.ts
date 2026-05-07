import type { KnowledgeEntry } from '@self-evolving-harness/kivo';

export interface KnowledgeVersionSnapshot {
  version: number;
  content: string;
  summary?: string;
  updatedAt: string;
  diffNote?: string;
}

const histories = new Map<string, KnowledgeVersionSnapshot[]>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureSyntheticHistory(entry: KnowledgeEntry) {
  if (histories.has(entry.id)) {
    return;
  }

  const snapshots: KnowledgeVersionSnapshot[] = [];

  if (entry.version > 1) {
    snapshots.push({
      version: entry.version - 1,
      content: entry.content.length > 180 ? `${entry.content.slice(0, 180)}\n\n（旧版本摘要较短，部分内容已被后续版本补充。）` : entry.content,
      summary: entry.summary,
      updatedAt: new Date(new Date(entry.updatedAt).getTime() - 6 * 60 * 60 * 1000).toISOString(),
      diffNote: '旧版本保留较短摘要，后续版本补充了更多上下文。',
    });
  }

  snapshots.push({
    version: entry.version,
    content: entry.content,
    summary: entry.summary,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  });

  histories.set(entry.id, snapshots);
}

export function ensureKnowledgeHistory(entry: KnowledgeEntry) {
  ensureSyntheticHistory(entry);
}

export function appendKnowledgeSnapshot(entry: KnowledgeEntry, diffNote?: string) {
  ensureSyntheticHistory(entry);
  const snapshots = histories.get(entry.id) ?? [];
  const existingIndex = snapshots.findIndex((item) => item.version === entry.version);
  const snapshot: KnowledgeVersionSnapshot = {
    version: entry.version,
    content: entry.content,
    summary: entry.summary,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    diffNote,
  };

  if (existingIndex >= 0) {
    snapshots[existingIndex] = snapshot;
  } else {
    snapshots.push(snapshot);
    snapshots.sort((a, b) => b.version - a.version);
  }

  histories.set(entry.id, snapshots);
}

export function getKnowledgeHistory(entry: KnowledgeEntry): KnowledgeVersionSnapshot[] {
  ensureSyntheticHistory(entry);
  return clone((histories.get(entry.id) ?? []).sort((a, b) => b.version - a.version));
}
