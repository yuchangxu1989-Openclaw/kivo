import type { KnowledgeEntry } from '../types/index.js';

export interface KeywordMatchResult {
  entry: KnowledgeEntry;
  score: number;
  matchedTerms: string[];
}

interface PreparedEntry {
  entry: KnowledgeEntry;
  searchableText: string;
  fieldWeights: {
    title: number;
    content: number;
    tags: number;
    summary: number;
  };
}

const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2.5;
const SUMMARY_WEIGHT = 1.75;
const CONTENT_WEIGHT = 1;

export function keywordSearch(query: string, entries: KnowledgeEntry[]): KeywordMatchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0 || entries.length === 0) {
    return [];
  }

  const prepared = entries.map(prepareEntry);
  const documentFrequency = buildDocumentFrequency(terms, prepared);
  const totalDocs = prepared.length;

  const results = prepared
    .map((item) => scoreEntry(terms, documentFrequency, totalDocs, item))
    .filter((result): result is KeywordMatchResult => result !== null)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime());

  return results;
}

function scoreEntry(
  terms: string[],
  documentFrequency: Map<string, number>,
  totalDocs: number,
  item: PreparedEntry
): KeywordMatchResult | null {
  let score = 0;
  const matchedTerms = new Set<string>();

  for (const term of terms) {
    const titleMatches = countOccurrences(item.entry.title, term);
    const tagMatches = item.entry.tags.reduce((sum, tag) => sum + countOccurrences(tag, term), 0);
    const summaryMatches = countOccurrences(item.entry.summary, term);
    const contentMatches = countOccurrences(item.entry.content, term);

    const weightedTf =
      titleMatches * TITLE_WEIGHT +
      tagMatches * TAG_WEIGHT +
      summaryMatches * SUMMARY_WEIGHT +
      contentMatches * CONTENT_WEIGHT;

    if (weightedTf === 0) {
      continue;
    }

    matchedTerms.add(term);
    const df = documentFrequency.get(term) ?? 1;
    const idf = Math.log(1 + totalDocs / df);
    score += weightedTf * idf;
  }

  if (score === 0) {
    return null;
  }

  const normalization = 1 + Math.log(1 + item.searchableText.length / 120);
  const normalizedScore = Math.min(1, score / normalization / 10);

  return {
    entry: item.entry,
    score: normalizedScore,
    matchedTerms: Array.from(matchedTerms),
  };
}

function prepareEntry(entry: KnowledgeEntry): PreparedEntry {
  return {
    entry,
    searchableText: [entry.title, entry.summary, entry.content, entry.tags.join(' ')].join(' '),
    fieldWeights: {
      title: TITLE_WEIGHT,
      content: CONTENT_WEIGHT,
      tags: TAG_WEIGHT,
      summary: SUMMARY_WEIGHT,
    },
  };
}

function buildDocumentFrequency(terms: string[], entries: PreparedEntry[]): Map<string, number> {
  const frequency = new Map<string, number>();

  for (const term of terms) {
    let count = 0;
    for (const entry of entries) {
      if (containsTerm(entry.searchableText, term)) {
        count += 1;
      }
    }
    frequency.set(term, Math.max(1, count));
  }

  return frequency;
}

function containsTerm(text: string, term: string): boolean {
  return countOccurrences(text, term) > 0;
}

function countOccurrences(text: string, term: string): number {
  const normalizedText = normalize(text);
  if (!normalizedText) {
    return 0;
  }

  if (isCjkToken(term)) {
    let count = 0;
    let index = normalizedText.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = normalizedText.indexOf(term, index + term.length);
    }
    return count;
  }

  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  return tokens.reduce((sum, token) => sum + (token === term ? 1 : 0), 0);
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  if (!normalized) {
    return [];
  }

  const rawTokens = normalized
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const expanded = new Set<string>();
  for (const token of rawTokens) {
    if (isCjkToken(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) {
        expanded.add(token.slice(i, i + 2));
      }
      expanded.add(token);
      continue;
    }

    if (token.length > 1 || isCjkToken(token)) {
      expanded.add(token);
    }
  }

  return Array.from(expanded);
}

function isCjkToken(token: string): boolean {
  return /[\u4e00-\u9fff]/.test(token);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, ' ').trim();
}
