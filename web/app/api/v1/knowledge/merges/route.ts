import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface MergeSnapshotRow {
  merge_id: string;
  merged_entry_json: string;
  original_entries_json: string;
  created_at: string;
}

export async function GET() {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    try {
      // Ensure table exists before querying
      db.exec(`
        CREATE TABLE IF NOT EXISTS merge_snapshots (
          merge_id TEXT PRIMARY KEY,
          merged_entry_json TEXT NOT NULL,
          original_entries_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      const rows = db.prepare(`
        SELECT merge_id, merged_entry_json, original_entries_json, created_at
        FROM merge_snapshots
        ORDER BY created_at DESC
        LIMIT 50
      `).all() as MergeSnapshotRow[];

      const response: ApiResponse<{ snapshots: MergeSnapshotRow[] }> = {
        data: { snapshots: rows },
      };
      return NextResponse.json(response);
    } finally {
      db.close();
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
