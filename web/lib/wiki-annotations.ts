import { randomUUID } from 'node:crypto';
import { openWebDb } from '@/lib/db';

export interface WikiAnnotationRecord {
  id: string;
  wikiPageId: string;
  content: string;
  position: number | null;
  createdAt: string;
  updatedAt: string;
}

type WikiAnnotationRow = {
  id: string;
  wiki_page_id: string;
  content: string;
  position: number | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: WikiAnnotationRow): WikiAnnotationRecord {
  return {
    id: row.id,
    wikiPageId: row.wiki_page_id,
    content: row.content,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasWikiAnnotationsForeignKey(db: ReturnType<typeof openWebDb>): boolean {
  const rows = db.prepare('PRAGMA foreign_key_list(wiki_annotations)').all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  return rows.some((row) =>
    row.table === 'entries' &&
    row.from === 'wiki_page_id' &&
    row.to === 'id' &&
    row.on_delete.toUpperCase() === 'CASCADE',
  );
}

function migrateWikiAnnotationsTable(db: ReturnType<typeof openWebDb>) {
  db.exec(`
    BEGIN;
    CREATE TABLE wiki_annotations_v2 (
      id TEXT PRIMARY KEY,
      wiki_page_id TEXT NOT NULL,
      content TEXT NOT NULL,
      position INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (wiki_page_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    INSERT INTO wiki_annotations_v2 (id, wiki_page_id, content, position, created_at, updated_at)
    SELECT wa.id, wa.wiki_page_id, wa.content, wa.position, wa.created_at, wa.updated_at
    FROM wiki_annotations wa
    INNER JOIN entries e ON e.id = wa.wiki_page_id;

    DROP TABLE wiki_annotations;
    ALTER TABLE wiki_annotations_v2 RENAME TO wiki_annotations;
    CREATE INDEX idx_wiki_annotations_page ON wiki_annotations(wiki_page_id, updated_at DESC);
    COMMIT;
  `);
}

export function ensureWikiAnnotationsTable() {
  const db = openWebDb(false);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_annotations (
        id TEXT PRIMARY KEY,
        wiki_page_id TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (wiki_page_id) REFERENCES entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_wiki_annotations_page ON wiki_annotations(wiki_page_id, updated_at DESC);
    `);

    if (!hasWikiAnnotationsForeignKey(db)) {
      migrateWikiAnnotationsTable(db);
    }
  } finally {
    db.close();
  }
}

export function listWikiAnnotations(wikiPageId: string): WikiAnnotationRecord[] {
  const db = openWebDb(false);
  try {
    const rows = db.prepare(`
      SELECT id, wiki_page_id, content, position, created_at, updated_at
      FROM wiki_annotations
      WHERE wiki_page_id = ?
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
    `).all(wikiPageId) as WikiAnnotationRow[];
    return rows.map(mapRow);
  } finally {
    db.close();
  }
}

export function createWikiAnnotation(input: {
  wikiPageId: string;
  content: string;
  position?: number | null;
}): WikiAnnotationRecord {
  const db = openWebDb(false);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO wiki_annotations (id, wiki_page_id, content, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.wikiPageId, input.content, input.position ?? null, now, now);
    return mapRow({
      id,
      wiki_page_id: input.wikiPageId,
      content: input.content,
      position: input.position ?? null,
      created_at: now,
      updated_at: now,
    });
  } finally {
    db.close();
  }
}

export function updateWikiAnnotation(input: {
  id: string;
  wikiPageId: string;
  content: string;
  position?: number | null;
}): WikiAnnotationRecord | null {
  const db = openWebDb(false);
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      UPDATE wiki_annotations
      SET content = ?, position = ?, updated_at = ?
      WHERE id = ? AND wiki_page_id = ?
    `).run(input.content, input.position ?? null, now, input.id, input.wikiPageId);
    if (result.changes === 0) return null;

    const row = db.prepare(`
      SELECT id, wiki_page_id, content, position, created_at, updated_at
      FROM wiki_annotations
      WHERE id = ? AND wiki_page_id = ?
    `).get(input.id, input.wikiPageId) as WikiAnnotationRow | undefined;
    return row ? mapRow(row) : null;
  } finally {
    db.close();
  }
}

export function deleteWikiAnnotation(wikiPageId: string, id: string): boolean {
  const db = openWebDb(false);
  try {
    const result = db.prepare(`
      DELETE FROM wiki_annotations
      WHERE id = ? AND wiki_page_id = ?
    `).run(id, wikiPageId);
    return result.changes > 0;
  } finally {
    db.close();
  }
}
