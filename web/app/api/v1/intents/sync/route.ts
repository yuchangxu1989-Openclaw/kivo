import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import { embedQuery } from '@/lib/semantic-search';
import Database from 'better-sqlite3';
import path from 'path';
import type { ApiResponse } from '@/types';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

/**
 * POST /api/v1/intents/sync
 * Triggers intent embedding backfill for intents missing embeddings.
 */
export async function POST() {
  try {
    const db = new Database(DB_PATH);
    const rows = db.prepare(
      "SELECT id, name, description FROM intents WHERE embedding IS NULL AND status = 'active'"
    ).all() as Array<{ id: string; name: string; description: string }>;

    let updated = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const text = `${row.name}: ${row.description}`;
        const embedding = await embedQuery(text);
        const buf = Buffer.from(new Float32Array(embedding).buffer);
        db.prepare('UPDATE intents SET embedding = ?, updated_at = datetime(?) WHERE id = ?')
          .run(buf, new Date().toISOString(), row.id);
        updated++;
      } catch {
        failed++;
      }
    }

    db.close();

    const data = {
      status: 'completed' as const,
      message: `意图向量同步完成: ${updated} 条已更新, ${failed} 条失败`,
      updated,
      failed,
    };
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
