import type { LocalKnowledgeEntry, LocalKnowledgeRelation } from '@/data/sample-knowledge';

export interface KnowledgeListLikeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  domain?: string;
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  source?: { reference?: string };
}

export interface SearchLikeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  score: number;
  highlights?: string[];
}

export interface GraphLikeSnapshot {
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    domain?: string;
    summary: string;
    sourceRef: string;
    createdAt: string;
    updatedAt: string;
  }>;
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    strength: number;
    signal: string;
  }>;
  insights?: {
    isolatedNodeIds: string[];
    bridgeNodeIds: string[];
  };
  updatedAt: string;
}

export interface DetailLikeEntry {
  id: string;
  type: string;
  status: string;
  content: string;
  domain?: string;
  confidence?: number;
  source?: string;
  relations?: { type: string; targetId: string; targetContent?: string }[];
  versions?: { version: number; content: string; updatedAt: string; summary?: string }[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function toKnowledgeListEntries(entries: LocalKnowledgeEntry[]): KnowledgeListLikeEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    status: entry.status,
    content: entry.content,
    domain: entry.domain,
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    source: { reference: entry.source.reference },
  }));
}

export function toSearchEntries(entries: LocalKnowledgeEntry[], query: string): SearchLikeEntry[] {
  const keywords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

  const results: SearchLikeEntry[] = [];

  for (const entry of entries) {
    const haystack = `${entry.title} ${entry.content} ${entry.summary} ${entry.domain}`.toLowerCase();
    const matchedCount = keywords.filter((keyword) => haystack.includes(keyword)).length;
    if (keywords.length > 0 && matchedCount === 0) continue;

    const score = keywords.length === 0 ? 1 : Math.min(0.99, matchedCount / keywords.length);
    results.push({
      id: entry.id,
      type: entry.type,
      status: entry.status,
      content: entry.content,
      score,
      highlights: [highlightMatch(entry.content, keywords)],
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function highlightMatch(content: string, keywords: string[]) {
  if (keywords.length === 0) return content.slice(0, 180);
  const sentence = content
    .split(/[.。!！?？\n]+/)
    .find((part) => keywords.some((keyword) => part.toLowerCase().includes(keyword)))
    ?? content;

  return keywords.reduce((acc, keyword) => {
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return acc.replace(new RegExp(`(${safeKeyword})`, 'ig'), '<mark>$1</mark>');
  }, sentence.slice(0, 200));
}

export function toGraphSnapshot(entries: LocalKnowledgeEntry[], relations: LocalKnowledgeRelation[]): GraphLikeSnapshot {
  const nodes = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    type: entry.type,
    domain: entry.domain,
    summary: entry.summary,
    sourceRef: entry.source.reference,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));

  const edges = relations.map((relation) => ({
    id: relation.id,
    sourceId: relation.sourceId,
    targetId: relation.targetId,
    type: relation.type,
    strength: relation.strength,
    signal: relation.signal,
  }));

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
  }

  const updatedAt = entries[0]?.updatedAt ?? new Date().toISOString();

  return {
    nodes,
    edges,
    insights: {
      isolatedNodeIds: nodes.filter((node) => (degree.get(node.id) ?? 0) === 0).map((node) => node.id),
      bridgeNodeIds: nodes.filter((node) => (degree.get(node.id) ?? 0) >= 2).map((node) => node.id),
    },
    updatedAt,
  };
}

export function toDetailEntry(
  entry: LocalKnowledgeEntry,
  entries: LocalKnowledgeEntry[],
  relations: LocalKnowledgeRelation[]
): DetailLikeEntry {
  const related = relations
    .filter((relation) => relation.sourceId === entry.id || relation.targetId === entry.id)
    .map((relation) => {
      const targetId = relation.sourceId === entry.id ? relation.targetId : relation.sourceId;
      const targetEntry = entries.find((item) => item.id === targetId);
      return {
        type: relation.type,
        targetId,
        targetContent: targetEntry?.title ?? targetEntry?.content,
      };
    });

  return {
    id: entry.id,
    type: entry.type,
    status: entry.status,
    content: entry.content,
    domain: entry.domain,
    confidence: entry.confidence,
    source: entry.source.reference,
    relations: related,
    versions: [
      {
        version: entry.version,
        content: entry.content,
        updatedAt: entry.updatedAt,
        summary: entry.summary,
      },
    ],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    version: entry.version,
  };
}
