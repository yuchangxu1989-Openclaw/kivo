/**
 * Hook API — 供 OpenClaw hook (kivo-intent-injection) 调用的高层 API。
 * 封装向量搜索、bootstrap 条目加载、注入格式化，hook 只需调用这些函数。
 */

import Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { cosineSimilarity } from '../utils/math.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  content: string;
  confidence: number;
  domain: string | null;
  similarity: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  dbPath?: string;
}

export interface BootstrapOptions {
  limit?: number;
  agentId?: string;
  dbPath?: string;
}

export interface FormatOptions {
  maxChars?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ARK_DIMS = 2048;
const ARK_BLOB_SIZE = ARK_DIMS * 4; // float32 = 4 bytes per dim
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_LIMIT = 10;
const DEFAULT_BOOTSTRAP_LIMIT = 20;

// Agent role → knowledge domain mapping for bootstrap filtering
const AGENT_ROLE_DOMAIN_MAP: Record<string, string[]> = {
  'cc': ['coding', 'architecture', 'tooling', 'general'],
  'free-code': ['coding', 'architecture', 'tooling', 'general'],
  'dev-01': ['coding', 'architecture', 'tooling', 'general'],
  'dev-02': ['coding', 'architecture', 'tooling', 'general'],
  'sa-01': ['architecture', 'design', 'methodology', 'general'],
  'audit-01': ['coding', 'architecture', 'quality', 'general'],
  'audit-02': ['coding', 'architecture', 'quality', 'general'],
  'ux-01': ['design', 'ux', 'product', 'general'],
  'pm-01': ['product', 'methodology', 'strategy', 'general'],
};

// ─── Embedding singleton ─────────────────────────────────────────────────────

let _embedder: EmbeddingProvider | null = null;

function getEmbedder(): EmbeddingProvider {
  if (!_embedder) {
    _embedder = createEmbeddingProvider();
  }
  return _embedder;
}

export async function embedQueryForHook(query: string): Promise<number[]> {
  const sanitized = query.replace(/\s+/g, ' ').trim();
  if (!sanitized) return [];
  const embedder = getEmbedder();
  try {
    return await embedder.embed(sanitized);
  } catch {
    return [];
  }
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Vector search: embed query via Ark 2048-dim vectors, compute cosine similarity
 * against entries with compatible embeddings.
 * Returns top entries above similarity threshold.
 */
export async function searchRelevantKnowledge(
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const dbPath = options?.dbPath;

  if (!dbPath) throw new Error('dbPath is required');

  const sanitized = query.replace(/\s+/g, ' ').trim();
  if (!sanitized || sanitized.length < 2) return [];

  // Get query embedding from Ark-compatible provider
  const embedder = getEmbedder();
  let queryVector: number[];
  try {
    queryVector = await embedder.embed(sanitized);
  } catch {
    // Embedding unavailable — skip injection silently
    return [];
  }

  // Open DB readonly
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT id, type, title, summary, content, confidence, domain, embedding
      FROM entries
      WHERE status = 'active'
        AND type != 'intent'
        AND embedding IS NOT NULL
        AND length(embedding) = ?
    `).all(ARK_BLOB_SIZE) as Array<{
      id: string; type: string; title: string; summary: string | null;
      content: string; confidence: number; domain: string | null;
      embedding: Buffer;
    }>;

    if (rows.length === 0) return [];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const float32 = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const entryVec = Array.from(float32);
      const similarity = cosineSimilarity(queryVector, entryVec);
      if (similarity >= threshold) {
        scored.push({
          id: row.id,
          type: row.type,
          title: row.title,
          summary: row.summary,
          content: row.content,
          confidence: row.confidence,
          domain: row.domain,
          similarity,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } finally {
    db.close();
  }
}

/**
 * Get high-value knowledge entries for bootstrap injection.
 * Filters by agent role/domain when possible.
 */
export function getBootstrapEntries(options?: BootstrapOptions): SearchResult[] {
  const limit = options?.limit ?? DEFAULT_BOOTSTRAP_LIMIT;
  const dbPath = options?.dbPath;
  const agentId = options?.agentId;

  if (!dbPath) throw new Error('dbPath is required');

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const domains = agentId ? AGENT_ROLE_DOMAIN_MAP[agentId] ?? null : null;

    let rows: Array<{
      id: string; type: string; title: string; summary: string | null;
      content: string; confidence: number; domain: string | null;
    }>;

    if (domains && domains.length > 0) {
      const placeholders = domains.map(() => '?').join(', ');
      rows = db.prepare(`
        SELECT id, type, title, summary, content, confidence, domain
        FROM entries
        WHERE status = 'active'
          AND type IN ('decision', 'methodology', 'experience')
          AND confidence >= 0.7
          AND (domain IN (${placeholders}) OR domain IS NULL)
        ORDER BY
          CASE type
            WHEN 'decision' THEN 1
            WHEN 'methodology' THEN 2
            WHEN 'experience' THEN 3
            ELSE 4
          END,
          confidence DESC,
          updated_at DESC
        LIMIT ?
      `).all(...domains, limit) as typeof rows;
    } else {
      rows = db.prepare(`
        SELECT id, type, title, summary, content, confidence, domain
        FROM entries
        WHERE status = 'active'
          AND type IN ('decision', 'methodology', 'experience')
          AND confidence >= 0.7
        ORDER BY
          CASE type
            WHEN 'decision' THEN 1
            WHEN 'methodology' THEN 2
            WHEN 'experience' THEN 3
            ELSE 4
          END,
          confidence DESC,
          updated_at DESC
        LIMIT ?
      `).all(limit) as typeof rows;
    }

    return rows.map(r => ({ ...r, similarity: 1.0 }));
  } finally {
    db.close();
  }
}

/**
 * Format search results into a markdown context block, respecting token budget.
 */
export function formatInjectionContext(
  entries: SearchResult[],
  options?: FormatOptions,
): string {
  if (entries.length === 0) return '';

  const maxChars = options?.maxChars ?? 8000;
  const lines: string[] = ['<!-- KIVO Domain Knowledge -->'];
  let totalChars = lines[0].length;
  let count = 0;

  for (const entry of entries) {
    const block = `### [${entry.type}] ${entry.title}\n${entry.summary || entry.content?.substring(0, 200) || ''}`;
    if (totalChars + block.length + 4 > maxChars) break;
    lines.push(block);
    totalChars += block.length + 1;
    count++;
  }

  if (count === 0) return '';
  lines.push('<!-- /KIVO Domain Knowledge -->');
  return lines.join('\n');
}
