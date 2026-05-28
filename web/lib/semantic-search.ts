import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
const ARK_BASE_URL = (process.env.KIVO_EMBEDDING_BASE_URL || 'http://localhost:9876').replace(/\/$/, '');
const ARK_MODEL = process.env.KIVO_EMBEDDING_MODEL || 'doubao-embedding-vision-251215';
const MIN_SCORE = 0.3;

export interface EmbeddingResult {
  id: string;
  score: number;
}

interface EntryEmbeddingRow {
  id: string;
  embedding: Buffer | string;
}

function cosineSimilarity(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function decodeEmbedding(raw: Buffer | string): ArrayLike<number> | null {
  if (Buffer.isBuffer(raw)) {
    if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) return null;
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'number')) {
      return parsed as number[];
    }
  } catch {
    return null;
  }

  return null;
}

export async function semanticSearchDb(
  queryEmbedding: number[],
  limit: number = 20,
): Promise<EmbeddingResult[]> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT id, embedding FROM entries WHERE embedding IS NOT NULL AND status = 'active' AND type != 'intent'",
    ).all() as EntryEmbeddingRow[];

    const scored: EmbeddingResult[] = [];
    for (const row of rows) {
      const stored = decodeEmbedding(row.embedding);
      if (!stored) continue;

      const score = cosineSimilarity(queryEmbedding, stored);
      if (score > MIN_SCORE) {
        scored.push({ id: row.id, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } finally {
    db.close();
  }
}

export async function semanticSearchIntents(
  queryEmbedding: number[],
  limit: number = 20,
  minScore: number = MIN_SCORE,
): Promise<EmbeddingResult[]> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT id, embedding FROM intents WHERE embedding IS NOT NULL AND status = 'active'",
    ).all() as EntryEmbeddingRow[];

    const scored: EmbeddingResult[] = [];
    for (const row of rows) {
      const stored = decodeEmbedding(row.embedding);
      if (!stored) continue;

      const score = cosineSimilarity(queryEmbedding, stored);
      if (score > minScore) {
        scored.push({ id: row.id, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } finally {
    db.close();
  }
}

// Query-embedding LRU cache. The proxy at localhost:9876 has 2–10s tail latency
// even on warm calls, so repeated queries (typical user behavior: type → tweak →
// retry) would each block multi-second. Caching by exact normalized text turns
// repeats into <1ms lookups while leaving novel queries untouched.
const QUERY_EMBED_CACHE_MAX = Number(process.env.KIVO_QUERY_EMBED_CACHE_MAX) > 0
  ? Number(process.env.KIVO_QUERY_EMBED_CACHE_MAX)
  : 256;
const QUERY_EMBED_CACHE_TTL_MS = Number(process.env.KIVO_QUERY_EMBED_CACHE_TTL_MS) > 0
  ? Number(process.env.KIVO_QUERY_EMBED_CACHE_TTL_MS)
  : 30 * 60 * 1000;

interface CachedEmbedding {
  vec: number[];
  storedAt: number;
}

const queryEmbedCache = new Map<string, CachedEmbedding>();
const inflightQueryEmbed = new Map<string, Promise<number[]>>();

function cacheNormalizeQuery(text: string): string {
  return text.trim().toLowerCase();
}

function readQueryCache(key: string): number[] | null {
  const hit = queryEmbedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > QUERY_EMBED_CACHE_TTL_MS) {
    queryEmbedCache.delete(key);
    return null;
  }
  // refresh LRU position
  queryEmbedCache.delete(key);
  queryEmbedCache.set(key, hit);
  return hit.vec;
}

function writeQueryCache(key: string, vec: number[]): void {
  queryEmbedCache.set(key, { vec, storedAt: Date.now() });
  while (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
    const oldest = queryEmbedCache.keys().next().value;
    if (oldest === undefined) break;
    queryEmbedCache.delete(oldest);
  }
}

export function _resetQueryEmbedCache(): void {
  queryEmbedCache.clear();
  inflightQueryEmbed.clear();
}

export async function embedQuery(text: string): Promise<number[]> {
  const cacheKey = cacheNormalizeQuery(text);
  if (cacheKey) {
    const cached = readQueryCache(cacheKey);
    if (cached) return cached;
    const inflight = inflightQueryEmbed.get(cacheKey);
    if (inflight) return inflight;
  }

  const exec = (async (): Promise<number[]> => {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.KIVO_EMBEDDING_TIMEOUT_MS) > 0
      ? Number(process.env.KIVO_EMBEDDING_TIMEOUT_MS)
      : 30000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${ARK_BASE_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ARK_MODEL, input: text }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Embedding API error ${resp.status}: ${body}`);
      }

      const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Embedding API response missing embedding');
      }

      if (cacheKey) writeQueryCache(cacheKey, embedding);
      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  })();

  if (cacheKey) {
    inflightQueryEmbed.set(cacheKey, exec);
    try {
      return await exec;
    } finally {
      inflightQueryEmbed.delete(cacheKey);
    }
  }
  return exec;
}
