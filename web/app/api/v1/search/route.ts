/**
 * GET /api/v1/search
 * Semantic search across knowledge entries, intent knowledge, and materials (FR-W02).
 */

import Database from 'better-sqlite3';
import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { EmbeddingUnavailableError, describeEmbeddingConfig, embeddingUnavailableErrorPayload } from '@/lib/embedding-client';
import { findEntriesByIds } from '@/lib/paginated-queries';
import { resolveKivoDbPath } from '@/lib/db';
import { ensureIntentTables } from '@/lib/intent-store';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import { embedQuery, semanticSearchDb } from '@/lib/semantic-search';
import type { ApiResponse } from '@/types';

const SEARCH_LIMIT_MULTIPLIER = 3;
const KEYWORD_SCORE = 0.55;
const MATERIAL_SCORE = 0.5;
const SUGGESTION_LIMIT = 8;

interface SearchResultItem {
  id: string;
  type: string;
  title: string;
  summary: string;
  content: string;
  status: string;
  score: number;
  highlights: string[];
  source?: { reference?: string; type?: string };
  metadata?: { tags?: string[]; knowledgeDomain?: string };
  createdAt?: string;
}

interface SuggestionItem {
  id: string;
  title: string;
  type: string;
}

interface IntentSearchRow {
  id: string;
  name: string;
  description: string;
  similar_sentences_json: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
}

interface MaterialSearchRow {
  id: string;
  file_name: string;
  mime_type: string;
  status: string;
  classification_status: string | null;
  created_at: string;
  content_override: string | null;
  source_ref: string | null;
  subject_node_id: string | null;
  subject_name: string | null;
}

interface EntrySuggestionRow {
  id: string;
  title: string;
  type: string;
}

interface IntentSuggestionRow {
  id: string;
  name: string;
}

interface MaterialSuggestionRow {
  id: string;
  file_name: string;
}

type SearchResponseMeta = NonNullable<ApiResponse<SearchResultItem[]>['meta']> & {
  embeddingMode: 'semantic';
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    const type = searchParams.get('type') || undefined;
    const status = searchParams.get('status') || undefined;
    const knowledgeDomain = searchParams.get('knowledgeDomain') || undefined;
    const suggest = searchParams.get('suggest') === '1';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)));

    if (!q || q.trim().length === 0) {
      return badRequest('q (search query) is required');
    }

    const normalizedQuery = q.trim();
    if (suggest) {
      const suggestions = findSearchSuggestions(normalizedQuery, SUGGESTION_LIMIT);
      const response: ApiResponse<SuggestionItem[]> = {
        data: suggestions,
        meta: { total: suggestions.length, page: 1, pageSize: SUGGESTION_LIMIT, totalPages: 1 },
      };
      return NextResponse.json(response);
    }

    let results: SearchResultItem[] = [];

    try {
      // DB-level vector search hydrates persisted embeddings instead of the
      // process-local VectorIndex, which is empty after Web server startup.
      const queryVec = await embedQuery(normalizedQuery);
      const semanticResults = await semanticSearchDb(queryVec, pageSize * page * SEARCH_LIMIT_MULTIPLIER);
      const ids = semanticResults.map(r => r.id);
      const scoreMap = new Map(semanticResults.map(r => [r.id, r.score]));
      const entries = findEntriesByIds(ids);
      const entryMap = new Map(entries.map(e => [e.id, e]));
      for (const r of semanticResults) {
        const entry = entryMap.get(r.id);
        if (!entry) continue;
        results.push({
          id: entry.id,
          type: entry.type,
          title: entry.title,
          summary: entry.summary,
          content: entry.content,
          status: entry.status,
          score: scoreMap.get(r.id) ?? r.score,
          highlights: [generateHighlight(entry.content, normalizedQuery)],
          source: entry.source ? { reference: entry.source.reference, type: entry.source.type } : undefined,
          metadata: { tags: entry.tags, knowledgeDomain: entry.knowledgeDomain },
          createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : undefined,
        });
      }
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        logEmbeddingErrorIntervention(err);
        const config = describeEmbeddingConfig();
        const error = embeddingUnavailableErrorPayload(err);
        error.how = `${error.how}\n  ④ 手动覆盖：设置 KIVO_EMBEDDING_BASE_URL 指向可用 embedding endpoint；离线初始化可运行 kivo init --offline。`;
        return NextResponse.json({
          error,
          meta: {
            embeddingMode: 'unavailable',
            recoveryActionId: 'recheck_embedding_provider',
            primaryEndpoint: config.primaryEndpoint,
          },
        }, { status: 503 });
      }

      console.error('[search] semantic search failed, falling back to keyword:', err instanceof Error ? err.message : err);
      const { getKivo } = await import('@/lib/kivo-engine');
      const kivo = await getKivo();
      const keywordResults = await kivo.query(normalizedQuery);
      results = keywordResults
        .filter((r) => r.entry.status === 'active')
        .map(r => ({
          id: r.entry.id,
          type: r.entry.type,
          title: r.entry.title,
          summary: r.entry.summary,
          content: r.entry.content,
          status: r.entry.status,
          score: r.score,
          highlights: [generateHighlight(r.entry.content, normalizedQuery)],
          source: r.entry.source ? { reference: r.entry.source.reference, type: r.entry.source.type } : undefined,
          metadata: { tags: r.entry.tags, knowledgeDomain: r.entry.knowledgeDomain },
          createdAt: r.entry.createdAt ? new Date(r.entry.createdAt).toISOString() : undefined,
        }));
    }

    results.push(
      ...safeFindIntentResults(normalizedQuery),
      ...safeFindMaterialResults(normalizedQuery),
    );

    if (type) {
      results = results.filter(r => r.type === type);
    } else {
      // Exclude internal system rules and meta entries from default search.
      results = results.filter(r => r.type !== 'meta');
    }
    if (status) {
      results = results.filter(r => r.status === status);
    }
    if (knowledgeDomain) {
      results = results.filter(r => r.metadata?.knowledgeDomain === knowledgeDomain);
    }

    const deduped = dedupeResults(results).sort((a, b) => b.score - a.score);
    const total = deduped.length;
    const offset = (page - 1) * pageSize;
    const items = deduped.slice(offset, offset + pageSize);

    const response: ApiResponse<SearchResultItem[]> & { meta: SearchResponseMeta } = {
      data: items,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), embeddingMode: 'semantic' },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function openWritableDb(): Database.Database {
  return new Database(resolveKivoDbPath());
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function likeQuery(query: string): string {
  return `%${query.toLowerCase()}%`;
}

function prefixQuery(query: string): string {
  return `${query.toLowerCase()}%`;
}

function safeFindIntentResults(query: string): SearchResultItem[] {
  try {
    return findIntentResults(query);
  } catch (err) {
    console.warn('[search] intent search skipped:', err instanceof Error ? err.message : err);
    return [];
  }
}

function safeFindMaterialResults(query: string): SearchResultItem[] {
  try {
    return findMaterialResults(query);
  } catch (err) {
    console.warn('[search] material search skipped:', err instanceof Error ? err.message : err);
    return [];
  }
}

function logEmbeddingErrorIntervention(err: EmbeddingUnavailableError): void {
  let db: Database.Database | null = null;
  try {
    db = openWritableDb();
    if (typeof (db as { exec?: unknown }).exec === 'function') {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quality_gate_log (
          id TEXT PRIMARY KEY,
          gate TEXT NOT NULL,
          phase TEXT NOT NULL,
          decision TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL
        )
      `);
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO quality_gate_log (id, gate, phase, decision, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `search-embedding-${Date.now()}`,
      'search',
      'embedding',
      'embedding_unavailable',
      JSON.stringify({ probedProviders: err.probedProviders, lastError: err.lastError }),
      now,
    );
  } catch (logErr) {
    console.warn('[search] failed to log embedding intervention:', logErr instanceof Error ? logErr.message : logErr);
  } finally {
    db?.close();
  }
}

function findIntentResults(query: string): SearchResultItem[] {
  const db = openWritableDb();
  try {
    ensureIntentTables(db);
    const rows = db.prepare(`
      SELECT id, name, description, similar_sentences_json, status, confidence, created_at
      FROM intents
      WHERE status = 'active'
        AND (
          LOWER(name) LIKE ? OR LOWER(description) LIKE ?
          OR LOWER(similar_sentences_json) LIKE ?
        )
      ORDER BY datetime(updated_at) DESC
      LIMIT 50
    `).all(likeQuery(query), likeQuery(query), likeQuery(query)) as IntentSearchRow[];

    return rows.map((row) => {
      const similar = safeParseStringArray(row.similar_sentences_json);
      const content = [row.description, ...similar].filter(Boolean).join('\n');
      return {
        id: row.id,
        type: 'intent',
        title: row.name,
        summary: row.description,
        content,
        status: row.status,
        score: row.confidence ?? KEYWORD_SCORE,
        highlights: [generateHighlight(content, query)],
        source: { type: 'intent', reference: row.id },
        createdAt: row.created_at,
      };
    });
  } finally {
    db.close();
  }
}

function findMaterialResults(query: string): SearchResultItem[] {
  const db = openWritableDb();
  try {
    ensureMaterialsTable(db);
    const rows = db.prepare(`
      SELECT m.id, m.file_name, m.mime_type, m.status, m.classification_status,
             m.created_at, m.content_override, m.source_ref, m.subject_node_id,
             sn.name AS subject_name
      FROM materials m
      LEFT JOIN subject_nodes sn ON sn.id = m.subject_node_id
      WHERE LOWER(m.file_name) LIKE ?
         OR LOWER(COALESCE(m.content_override, '')) LIKE ?
         OR LOWER(COALESCE(m.source_ref, '')) LIKE ?
         OR LOWER(COALESCE(m.classification_status, '')) LIKE ?
         OR LOWER(COALESCE(sn.name, '')) LIKE ?
      ORDER BY datetime(m.created_at) DESC
      LIMIT 50
    `).all(likeQuery(query), likeQuery(query), likeQuery(query), likeQuery(query), likeQuery(query)) as MaterialSearchRow[];

    return rows.map((row) => {
      const materialStatus = row.status === 'done' ? 'active' : row.status;
      const content = [row.content_override, row.file_name, row.subject_name, row.source_ref].filter(Boolean).join('\n');
      return {
        id: row.id,
        type: 'material',
        title: row.file_name,
        summary: row.subject_name ? `材料已关联知识域：${row.subject_name}` : `材料类型：${row.mime_type}`,
        content,
        status: materialStatus,
        score: MATERIAL_SCORE,
        highlights: [generateHighlight(content, query)],
        source: { type: 'document', reference: row.source_ref ?? `material:${row.id}` },
        metadata: row.subject_name ? { knowledgeDomain: row.subject_name } : undefined,
        createdAt: row.created_at,
      };
    });
  } finally {
    db.close();
  }
}

function findSearchSuggestions(query: string, limit: number): SuggestionItem[] {
  const db = openWritableDb();
  try {
    ensureIntentTables(db);
    ensureMaterialsTable(db);
    const suggestions: SuggestionItem[] = [];
    const seen = new Set<string>();
    const push = (item: SuggestionItem) => {
      if (suggestions.length >= limit || seen.has(item.id)) return;
      suggestions.push(item);
      seen.add(item.id);
    };

    const entries = db.prepare(`
      SELECT id, title, type
      FROM entries
      WHERE status = 'active' AND type != 'intent' AND LOWER(title) LIKE ?
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
    `).all(prefixQuery(query), limit) as EntrySuggestionRow[];
    for (const row of entries) push({ id: row.id, title: row.title, type: row.type });

    const intents = db.prepare(`
      SELECT id, name
      FROM intents
      WHERE status = 'active' AND LOWER(name) LIKE ?
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
    `).all(prefixQuery(query), limit) as IntentSuggestionRow[];
    for (const row of intents) push({ id: row.id, title: row.name, type: 'intent' });

    const materials = db.prepare(`
      SELECT id, file_name
      FROM materials
      WHERE LOWER(file_name) LIKE ?
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `).all(prefixQuery(query), limit) as MaterialSuggestionRow[];
    for (const row of materials) push({ id: row.id, title: row.file_name, type: 'material' });

    return suggestions;
  } finally {
    db.close();
  }
}

function dedupeResults(results: SearchResultItem[]): SearchResultItem[] {
  const byId = new Map<string, SearchResultItem>();
  for (const result of results) {
    const existing = byId.get(result.id);
    if (!existing || result.score > existing.score) {
      byId.set(result.id, result);
    }
  }
  return [...byId.values()];
}

function generateHighlight(content: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sentences = content.split(/[.。!！?？\n]+/).filter(Boolean);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (words.some(w => lower.includes(w))) {
      return sentence.trim().slice(0, 200);
    }
  }

  return content.slice(0, 200);
}
