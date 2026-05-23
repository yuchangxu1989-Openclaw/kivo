import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
const OLLAMA_BASE_URL = (process.env.KIVO_EMBEDDING_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.KIVO_EMBEDDING_MODEL || 'bge-m3:latest';
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
      "SELECT id, embedding FROM entries WHERE embedding IS NOT NULL AND status = 'active'",
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

export async function embedQuery(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
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

    return embedding;
  } finally {
    clearTimeout(timeout);
  }
}
