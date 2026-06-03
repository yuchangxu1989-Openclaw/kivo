import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/governance-store';

export type MaterialStatus = 'processing' | 'done' | 'failed';
export type MaterialPipelineStatus = 'pending' | 'in_progress' | 'processing' | 'done' | 'failed' | 'classified' | null;

export interface MaterialRecord {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: MaterialStatus;
  spaceId: string;
  wikiPageCount: number;
  createdAt: string;
  updatedAt: string;
  storagePath: string;
  wikiPageIds: string[];
  errorMessage: string | null;
  pipelineStatus: MaterialPipelineStatus;
  classificationStatus: string | null;
  sliceCount: number;
  extractCount: number;
  assetKind: string | null;
  subjectNodeId: string | null;
  routeCategory: string | null;
  routeParams: Record<string, unknown> | null;
  totalChunks: number | null;
  processedChunks: number;
  contentOverride: string | null;
}

type MaterialRow = {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  status: MaterialStatus;
  space_id: string;
  wiki_page_count: number;
  created_at: string;
  updated_at: string;
  storage_path: string;
  wiki_page_ids_json: string | null;
  error_message: string | null;
  pipeline_status: MaterialPipelineStatus;
  classification_status: string | null;
  slice_count: number | null;
  extract_count: number | null;
  asset_kind: string | null;
  subject_node_id: string | null;
  route_category: string | null;
  route_params_json: string | null;
  total_chunks: number | null;
  processed_chunks: number | null;
  content_override: string | null;
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapRow(row: MaterialRow): MaterialRecord {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    spaceId: row.space_id,
    wikiPageCount: row.wiki_page_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storagePath: row.storage_path,
    wikiPageIds: parseJsonArray(row.wiki_page_ids_json),
    errorMessage: row.error_message,
    pipelineStatus: row.pipeline_status,
    classificationStatus: row.classification_status,
    sliceCount: row.slice_count ?? 0,
    extractCount: row.extract_count ?? 0,
    assetKind: row.asset_kind,
    subjectNodeId: row.subject_node_id,
    routeCategory: row.route_category,
    routeParams: parseJsonObject(row.route_params_json),
    totalChunks: row.total_chunks ?? null,
    processedChunks: row.processed_chunks ?? 0,
    contentOverride: row.content_override,
  };
}

function ensureColumn(db: Database.Database, columnName: string, ddl: string) {
  const rows = db.prepare('PRAGMA table_info(materials)').all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === columnName)) {
    db.exec(`ALTER TABLE materials ADD COLUMN ${ddl}`);
  }
}

export function ensureMaterialsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      space_id TEXT NOT NULL DEFAULT 'default',
      wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_materials_created_at ON materials(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status);
  `);

  ensureColumn(db, 'storage_path', "storage_path TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'wiki_page_ids_json', "wiki_page_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'error_message', 'error_message TEXT');
  ensureColumn(db, 'classification_status', "classification_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, 'classification_confidence', 'classification_confidence REAL');
  ensureColumn(db, 'suggested_subject_name', 'suggested_subject_name TEXT');
  ensureColumn(db, 'subject_node_id', 'subject_node_id TEXT');
  ensureColumn(db, 'pipeline_status', 'pipeline_status TEXT');
  ensureColumn(db, 'slice_count', 'slice_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'extract_count', 'extract_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'asset_kind', 'asset_kind TEXT');
  ensureColumn(db, 'source_channel', 'source_channel TEXT');
  ensureColumn(db, 'source_ref', 'source_ref TEXT');
  ensureColumn(db, 'route_category', 'route_category TEXT');
  ensureColumn(db, 'route_params_json', 'route_params_json TEXT');
  ensureColumn(db, 'total_chunks', 'total_chunks INTEGER');
  ensureColumn(db, 'processed_chunks', 'processed_chunks INTEGER DEFAULT 0');
  ensureColumn(db, 'batch_cursor', 'batch_cursor INTEGER DEFAULT 0');
  ensureColumn(db, 'content_override', 'content_override TEXT');
}

export class WikiMaterialsStore {
  private readonly db: Database.Database;
  private readonly closeWhenDone: boolean;

  constructor(db?: Database.Database) {
    this.db = db ?? openWebDb(false);
    this.closeWhenDone = !db;
    ensureMaterialsTable(this.db);
  }

  close() {
    if (this.closeWhenDone) this.db.close();
  }

  list(): MaterialRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM materials
      ORDER BY datetime(created_at) DESC
    `).all() as MaterialRow[];
    return rows.map(mapRow);
  }

  get(id: string): MaterialRecord | null {
    const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: {
    id?: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    spaceId: string;
    storagePath: string;
    routeCategory?: string;
    routeParams?: Record<string, unknown>;
  }): MaterialRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO materials (
        id, file_name, mime_type, file_size, status, space_id, wiki_page_count,
        created_at, updated_at, storage_path, wiki_page_ids_json, error_message,
        asset_kind, route_category, route_params_json, pipeline_status
      ) VALUES (?, ?, ?, ?, 'processing', ?, 0, ?, ?, ?, '[]', NULL, ?, ?, ?, 'pending')
    `).run(
      id,
      input.fileName,
      input.mimeType,
      input.fileSize,
      input.spaceId,
      now,
      now,
      input.storagePath,
      input.routeCategory ?? null,
      input.routeCategory ?? null,
      input.routeParams ? JSON.stringify(input.routeParams) : null,
    );
    return this.get(id)!;
  }

  markProcessing(id: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE materials
      SET status = 'processing',
          wiki_page_count = 0,
          wiki_page_ids_json = '[]',
          content_override = NULL,
          error_message = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  setContentOverride(id: string, content: string | null) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE materials
      SET content_override = ?,
          updated_at = ?
      WHERE id = ?
    `).run(content, now, id);
  }

  markDone(id: string, wikiPageIds: string[]) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE materials
      SET status = 'done',
          wiki_page_count = ?,
          wiki_page_ids_json = ?,
          error_message = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(wikiPageIds.length, JSON.stringify(wikiPageIds), now, id);
  }

  markFailed(id: string, errorMessage: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE materials
      SET status = 'failed',
          wiki_page_count = 0,
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(errorMessage, now, id);
  }

  markUnsupported(id: string, errorMessage: string) {
    this.markFailed(id, errorMessage);
  }

  /**
   * Mark a material as 'skipped' when its processing channel is intentionally
   * unavailable (e.g. OCR engine not configured). Distinct from 'failed' so the
   * UI can show "empty by design" instead of an error to retry.
   */
  markSkipped(id: string, reason: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE materials
      SET status = 'skipped',
          wiki_page_count = 0,
          wiki_page_ids_json = '[]',
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(reason, now, id);
  }

  /** FR-A02 FR-C AC5 - merge additional data into route_params_json (e.g. channelFailures). */
  updateRouteParams(id: string, patch: Record<string, unknown>) {
    const now = new Date().toISOString();
    const existing = this.get(id);
    const merged = { ...(existing?.routeParams ?? {}), ...patch };
    this.db.prepare(`
      UPDATE materials
      SET route_params_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(merged), now, id);
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  }
}

export function getMaterialsStorageRoot() {
  const root = process.env.KIVO_MATERIALS_DIR || path.resolve(process.cwd(), '../uploads/wiki-materials');
  fs.mkdirSync(root, { recursive: true });
  return root;
}
