/**
 * POST /api/v1/intents/backfill-similar — Backfill similar_sentences for intent entries.
 *
 * Wraps the existing enrich-intents CLI logic as an API endpoint.
 * Calls LLM to generate 5-10 paraphrases per intent entry that lacks them.
 *
 * Query params:
 *   ?dryRun=true — preview without writing
 *   ?batchSize=3 — number of entries per batch (default 3)
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface IntentRow {
  id: string;
  title: string;
  content: string;
  similar_sentences: string | null;
}

interface BackfillResult {
  enriched: number;
  failed: number;
  total: number;
  dryRun: boolean;
  results: Array<{ id: string; title: string; sentenceCount: number }>;
}

function buildEnrichPrompt(title: string, content: string): string {
  return `你是一个意图理解专家。给定以下意图知识条目，请生成 5~10 条用户可能说出的、表达同一意图的自然语言句子。

意图标题: ${title}
意图内容: ${content}

要求：
- 生成的句子应该多样化，覆盖不同的表达方式（口语/书面、中文/英文混合、简短/详细）
- 每条句子是独立的用户输入，不是对意图的解释
- 返回纯 JSON 数组，如 ["句子1", "句子2", ...]
- 不要包含 markdown 代码块标记`;
}

function parseSentences(raw: string): string[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s: unknown) => typeof s === 'string' && s.trim().length > 0)
        .map((s: string) => s.length > 200 ? s.slice(0, 200) : s)
        .slice(0, 15);
    }
    return [];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  let db: Database.Database | null = null;
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dryRun') === 'true';
    const batchSize = Math.min(10, Math.max(1, Number(url.searchParams.get('batchSize')) || 3));

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Check if intents table exists
    const intentsTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='intents'"
    ).get();

    let rows: IntentRow[];

    if (intentsTableExists) {
      const columns = db.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'similar_sentences_json')) {
        db.exec(`ALTER TABLE intents ADD COLUMN similar_sentences_json TEXT DEFAULT '[]'`);
      }
      rows = db.prepare(`
        SELECT id, name as title, description as content, similar_sentences_json as similar_sentences
        FROM intents
        WHERE status = 'active'
          AND (similar_sentences_json IS NULL OR similar_sentences_json = '[]' OR similar_sentences_json = '')
      `).all() as IntentRow[];
    } else {
      const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'similar_sentences')) {
        db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
      }
      rows = db.prepare(`
        SELECT id, title, content, similar_sentences
        FROM entries
        WHERE type = 'intent'
          AND (similar_sentences IS NULL OR similar_sentences = '[]' OR similar_sentences = '')
      `).all() as IntentRow[];
    }

    if (rows.length === 0) {
      const response: ApiResponse<BackfillResult> = {
        data: { enriched: 0, failed: 0, total: 0, dryRun, results: [] },
      };
      db.close();
      return NextResponse.json(response);
    }

    // Resolve LLM config from environment
    const apiKey = process.env.KIVO_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseUrl = process.env.KIVO_LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.KIVO_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
      db.close();
      return serverError('No LLM API key configured. Set KIVO_LLM_API_KEY or OPENAI_API_KEY.');
    }

    const results: Array<{ id: string; title: string; sentenceCount: number }> = [];
    let enriched = 0;
    let failed = 0;

    // Process in batches
    const toProcess = rows.slice(0, batchSize * 5); // Cap at 5 batches per request to avoid timeout

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);

      for (const row of batch) {
        try {
          const prompt = buildEnrichPrompt(row.title, row.content);

          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.8,
              max_tokens: 1024,
            }),
          });

          if (!resp.ok) {
            failed++;
            continue;
          }

          const data = await resp.json();
          const rawContent = data.choices?.[0]?.message?.content ?? '';
          const sentences = parseSentences(rawContent);

          if (sentences.length === 0) {
            failed++;
            continue;
          }

          results.push({ id: row.id, title: row.title, sentenceCount: sentences.length });

          if (!dryRun) {
            const now = new Date().toISOString();
            if (intentsTableExists) {
              db.prepare('UPDATE intents SET similar_sentences_json = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(sentences), now, row.id);
            } else {
              db.prepare('UPDATE entries SET similar_sentences = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(sentences), now, row.id);
            }
          }

          enriched++;
        } catch {
          failed++;
        }
      }

      // Inter-batch delay
      if (i + batchSize < toProcess.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    db.close();
    db = null;

    const response: ApiResponse<BackfillResult> = {
      data: { enriched, failed, total: rows.length, dryRun, results },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}
