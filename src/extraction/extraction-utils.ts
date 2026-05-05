import type { KnowledgeEntry, KnowledgeSource, KnowledgeType } from '../types/index.js';

export interface ExtractedKnowledgeCandidate {
  type?: string;
  title?: string;
  content?: string;
  summary?: string;
  confidence?: number;
  tags?: string[];
}

const KNOWLEDGE_TYPES: KnowledgeType[] = [
  'fact',
  'methodology',
  'decision',
  'experience',
  'intent',
  'meta',
];

const TITLE_MAX_LENGTH = 50;
const TITLE_FALLBACK_LENGTH = 40;
const TITLE_PUNCTUATION = /[。．.!！?？,，:：;；]/u;

export function isKnowledgeType(value: string | undefined): value is KnowledgeType {
  return typeof value === 'string' && KNOWLEDGE_TYPES.includes(value as KnowledgeType);
}

export function clampConfidence(value: number | undefined, fallback = 0.6): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function generateTitle(content: string): string {
  return shortenKnowledgeTitle(content);
}

export function shortenKnowledgeTitle(title: string | undefined, fallbackContent = ''): string {
  const cleanTitle = (title ?? '').replace(/\s+/g, ' ').trim();
  const cleanFallback = fallbackContent.replace(/\s+/g, ' ').trim();
  const source = cleanTitle || cleanFallback;
  if (!source) return 'Untitled knowledge entry';

  const punctuationIndex = source.search(TITLE_PUNCTUATION);
  if (punctuationIndex > 0) {
    const candidate = source.slice(0, punctuationIndex).trim();
    const trailingLength = source.length - punctuationIndex - 1;
    if (candidate && (source.length > TITLE_MAX_LENGTH || trailingLength >= 8)) {
      return candidate;
    }
  }

  if (source.length <= TITLE_MAX_LENGTH) return source;

  return source.slice(0, TITLE_FALLBACK_LENGTH).trimEnd() + '...';
}

export function generateSummary(content: string): string {
  const clean = content.trim();
  if (!clean) return '';

  const firstSentence = clean.match(/^[^.!?。！？\n]+[.!?。！？]?/);
  if (firstSentence && firstSentence[0].length <= 160) {
    return firstSentence[0].trim();
  }

  return clean.slice(0, 100) + (clean.length > 100 ? '...' : '');
}

export function uniqueTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map(tag => String(tag).trim()).filter(Boolean)));
}

export function normalizeForDedupe(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeKey(type: KnowledgeType, content: string): string {
  return `${type}:${normalizeForDedupe(content)}`;
}

export function extractJsonBlock(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = tryParseJson(trimmed.slice(arrayStart, arrayEnd + 1));
    if (parsed !== undefined) return parsed;
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = tryParseJson(trimmed.slice(objectStart, objectEnd + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new Error('LLM response did not contain valid JSON');
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function normalizeKnowledgeCandidates(raw: unknown): ExtractedKnowledgeCandidate[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }

  if (isRecord(raw)) {
    const entries = raw.entries;
    if (Array.isArray(entries)) {
      return entries.filter(isRecord);
    }
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isDuplicateEntry(candidate: Pick<KnowledgeEntry, 'type' | 'content'>, existing: KnowledgeEntry[]): boolean {
  const key = dedupeKey(candidate.type, candidate.content);
  return existing.some(entry => dedupeKey(entry.type, entry.content) === key);
}

export function buildDerivedSource(baseSource: KnowledgeSource, context: string): KnowledgeSource {
  return {
    ...baseSource,
    context,
  };
}
