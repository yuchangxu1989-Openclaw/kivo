import { NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import Database from 'better-sqlite3';
import path from 'path';
import type { ApiResponse } from '@/types';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface MaterialRow {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  status: string;
  pipeline_status: string | null;
  subject_node_id: string | null;
  wiki_page_ids_json: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  asset_kind: string | null;
  slice_count: number;
  extract_count: number;
  inject_count: number;
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
  type: string;
  summary: string;
  created_at: string;
}

interface SubjectRow {
  id: string;
  name: string;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    try {
      const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow | undefined;
      if (!material) return notFound('Material not found');

      let subjectName: string | null = null;
      if (material.subject_node_id) {
        const subject = db.prepare('SELECT name FROM subject_nodes WHERE id = ?').get(material.subject_node_id) as SubjectRow | undefined;
        subjectName = subject?.name ?? null;
      }

      const wikiPageIds: string[] = JSON.parse(material.wiki_page_ids_json || '[]');
      const wikiPages = wikiPageIds.map((pageId) => {
        const page = db.prepare(`
          SELECT id, title, summary, content FROM wiki_page_versions WHERE id = ?
        `).get(pageId) as { id: string; title: string; summary: string; content: string } | undefined;
        return page;
      }).filter(Boolean);

      const entries = db.prepare(`
        SELECT id, title, content, type, summary, created_at
        FROM entries
        WHERE parent_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 200
      `).all(id) as EntryRow[];

      return NextResponse.json({
        data: {
          id: material.id,
          fileName: material.file_name,
          mimeType: material.mime_type,
          fileSize: material.file_size,
          status: material.status,
          pipelineStatus: material.pipeline_status,
          assetKind: material.asset_kind,
          subjectNodeId: material.subject_node_id,
          subjectName,
          wikiPageCount: wikiPageIds.length,
          wikiPages,
          entries,
          sliceCount: material.slice_count,
          extractCount: material.extract_count,
          injectCount: material.inject_count,
          errorMessage: material.error_message,
          createdAt: material.created_at,
          updatedAt: material.updated_at,
        },
      } satisfies ApiResponse<unknown>);
    } finally {
      db.close();
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
