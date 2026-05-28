import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

interface ErrorLogRecord {
  id: string;
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message = typeof body?.message === 'string' ? body.message.trim() : '';

    if (!message) {
      return badRequest('message is required');
    }

    const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const d = getDb();
    d.exec(`
      CREATE TABLE IF NOT EXISTS graph_error_logs (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      )
    `);

    d.prepare(`
      INSERT INTO graph_error_logs (id, message, created_at, metadata_json)
      VALUES (?, ?, ?, ?)
    `).run(id, message, createdAt, metadata ? JSON.stringify(metadata) : null);

    const record: ErrorLogRecord = { id, message, createdAt, metadata };
    const response: ApiResponse<ErrorLogRecord> = { data: record };
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
