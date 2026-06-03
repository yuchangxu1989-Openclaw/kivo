/**
 * FR-2 AC-2.1, AC-2.2, AC-2.7, NFR-5, NFR-6
 * CRUD and tree queries for wiki Space/Directory/Page objects.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { initializeWikiSchema, type WikiSchemaOptions } from './schema.js';
import type {
  CreateDirectoryInput,
  CreatePageInput,
  CreateSpaceInput,
  UpdatePageInput,
  UpdateSpaceInput,
  WikiCommunitySuggestion,
  WikiEntryRecord,
  WikiEntryType,
  WikiLinkRecord,
  WikiNodeMetadata,
  WikiPageVersionRecord,
  WikiTagRecord,
  WikiTreeNode,
} from '../types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function encodeEmbedding(embedding?: number[] | null): Buffer | null {
  if (!embedding || embedding.length === 0) return null;
  return Buffer.from(new Float64Array(embedding).buffer);
}

function decodeEmbedding(blob: unknown): number[] | null {
  if (!Buffer.isBuffer(blob)) return null;
  const buffer = blob as Buffer;
  const view = new Float64Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / Float64Array.BYTES_PER_ELEMENT));
  return Array.from(view);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mergeMetadata(current: WikiNodeMetadata, incoming?: WikiNodeMetadata): WikiNodeMetadata {
  if (!incoming) return current;
  return {
    ...current,
    ...incoming,
    extra: {
      ...(current.extra ?? {}),
      ...(incoming.extra ?? {}),
    },
  };
}

export interface WikiRepositoryOptions extends WikiSchemaOptions {
  dbPath?: string;
  db?: any;
}


type VersionRow = {
  id: string;
  page_id: string;
  version: number;
  title: string;
  content: string;
  summary: string;
  tags_json: string;
  metadata_json: string;
  created_at: string;
};

type TagRow = {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  created_at: string;
};

type EntryRow = {
  id: string;
  type: WikiEntryType;
  title: string;
  content: string;
  summary: string;
  parent_id: string | null;
  sort_order: number;
  status: string;
  tags_json: string;
  metadata_json: string;
  embedding: Buffer | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export class WikiRepository {
  readonly db: any;

  constructor(options: WikiRepositoryOptions) {
    this.db = options.db ?? new Database(options.dbPath ?? 'kivo.db');
    initializeWikiSchema(this.db, options);
  }

  close(): void {
    this.db.close();
  }

  createSpace(input: CreateSpaceInput): WikiEntryRecord {
    const id = randomUUID();
    const ts = nowIso();
    const metadata: WikiNodeMetadata = mergeMetadata(
      {
        summary: input.summary ?? '',
        extra: input.description ? { description: input.description } : {},
      },
      input.metadata,
    );

    this.db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, status, tags_json,
        version, metadata_json, parent_id, sort_order, deleted_at, embedding, created_at, updated_at
      ) VALUES (?, 'wiki_space', ?, ?, ?, '{}', 'active', '[]', 1, ?, NULL, 0, NULL, NULL, ?, ?)
    `).run(id, input.title, input.description ?? '', input.summary ?? '', JSON.stringify(metadata), ts, ts);

    return this.getRequiredById(id);
  }

  updateSpace(id: string, input: UpdateSpaceInput): WikiEntryRecord {
    const current = this.getRequiredById(id, 'wiki_space');
    const ts = nowIso();
    const metadata = mergeMetadata(current.metadata, input.metadata);
    this.db.prepare(`
      UPDATE entries
      SET title = ?, content = ?, summary = ?, metadata_json = ?, status = ?, updated_at = ?
      WHERE id = ? AND type = 'wiki_space'
    `).run(
      input.title ?? current.title,
      input.content ?? current.content,
      input.summary ?? current.summary,
      JSON.stringify(metadata),
      input.status ?? current.status,
      ts,
      id,
    );
    return this.getRequiredById(id, 'wiki_space');
  }

  listSpaces(includeDeleted = false): WikiEntryRecord[] {
    const clause = includeDeleted ? '' : `AND deleted_at IS NULL AND status != 'deleted'`;
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE type = 'wiki_space' ${clause}
      ORDER BY sort_order ASC, created_at ASC
    `).all() as EntryRow[];
    return rows.map((row) => this.mapRow(row));
  }

  getSpaceTree(spaceId: string, includeDeleted = false): WikiTreeNode {
    const root = this.getRequiredById(spaceId, 'wiki_space');
    const clause = includeDeleted ? '' : `AND deleted_at IS NULL AND status != 'deleted'`;
    const subtreeRows = this.db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN subtree s ON e.parent_id = s.id
      )
      SELECT id FROM subtree
    `).all(spaceId) as Array<{ id: string }>;
    const subtreeIds = subtreeRows.map((row) => row.id);
    const placeholders = subtreeIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE id IN (${placeholders})
      AND type IN ('wiki_space', 'wiki_directory', 'wiki_page')
      ${clause}
      ORDER BY sort_order ASC, created_at ASC
    `).all(...subtreeIds) as EntryRow[];
    return this.buildTree(rows, root.id);
  }

  createDirectory(input: CreateDirectoryInput): WikiEntryRecord {
    this.assertParentType(input.parentId, ['wiki_space', 'wiki_directory']);
    const id = randomUUID();
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, status, tags_json,
        version, metadata_json, parent_id, sort_order, deleted_at, embedding, created_at, updated_at
      ) VALUES (?, 'wiki_directory', ?, '', ?, '{}', 'active', '[]', 1, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      input.title,
      input.summary ?? '',
      JSON.stringify(input.metadata ?? {}),
      input.parentId,
      input.sortOrder ?? this.nextSortOrder(input.parentId),
      ts,
      ts,
    );
    return this.getRequiredById(id, 'wiki_directory');
  }

  createPage(input: CreatePageInput): WikiEntryRecord {
    this.assertParentType(input.parentId, ['wiki_space', 'wiki_directory']);
    const id = randomUUID();
    const ts = nowIso();
    const hierarchicalTags = this.ensureTags(input.tags ?? []);
    const metadata = mergeMetadata({ tags: hierarchicalTags.map((tag) => tag.path) }, input.metadata);
    this.db.prepare(`
      INSERT INTO entries (
        id, type, title, content, summary, source_json, status, tags_json,
        version, metadata_json, parent_id, sort_order, deleted_at, embedding, created_at, updated_at
      ) VALUES (?, 'wiki_page', ?, ?, ?, '{}', 'active', ?, 1, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.content,
      input.summary ?? '',
      JSON.stringify(hierarchicalTags.map((tag) => tag.path)),
      JSON.stringify(metadata),
      input.parentId,
      input.sortOrder ?? this.nextSortOrder(input.parentId),
      encodeEmbedding(input.embedding),
      ts,
      ts,
    );
    const page = this.getRequiredById(id, 'wiki_page');
    this.savePageVersionSnapshot(page, ts);
    return page;
  }

  updatePage(id: string, input: UpdatePageInput): WikiEntryRecord {
    const current = this.getRequiredById(id, 'wiki_page');
    if (input.parentId) {
      this.assertParentType(input.parentId, ['wiki_space', 'wiki_directory']);
    }
    const ts = nowIso();
    this.savePageVersionSnapshot(current, ts);
    const tags = input.tags === undefined ? current.tags : this.ensureTags(input.tags).map((tag) => tag.path);
    const metadata = mergeMetadata({ ...current.metadata, tags }, input.metadata);
    this.db.prepare(`
      UPDATE entries
      SET title = ?, content = ?, summary = ?, parent_id = ?, sort_order = ?, tags_json = ?,
          metadata_json = ?, embedding = ?, status = ?, version = ?, updated_at = ?
      WHERE id = ? AND type = 'wiki_page'
    `).run(
      input.title ?? current.title,
      input.content ?? current.content,
      input.summary ?? current.summary,
      input.parentId ?? current.parentId,
      input.sortOrder ?? current.sortOrder,
      JSON.stringify(tags),
      JSON.stringify(metadata),
      input.embedding === undefined ? encodeEmbedding(current.embedding) : encodeEmbedding(input.embedding),
      input.status ?? current.status,
      current.version + 1,
      ts,
      id,
    );
    return this.getRequiredById(id, 'wiki_page');
  }

  moveNode(id: string, newParentId: string, sortOrder?: number): WikiEntryRecord {
    const current = this.getRequiredById(id);
    const allowedParents: WikiEntryType[] =
      current.type === 'wiki_page' ? ['wiki_space', 'wiki_directory'] : ['wiki_space', 'wiki_directory'];
    this.assertParentType(newParentId, allowedParents);
    const ts = nowIso();
    this.db.prepare(`
      UPDATE entries SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?
    `).run(newParentId, sortOrder ?? this.nextSortOrder(newParentId), ts, id);
    return this.getRequiredById(id);
  }

  softDeleteNode(id: string): WikiEntryRecord {
    const current = this.getRequiredById(id);
    const ts = nowIso();
    this.db.prepare(`
      UPDATE entries SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?
    `).run(ts, ts, id);
    if (current.type === 'wiki_page') {
      this.db.prepare(`DELETE FROM wiki_links WHERE source_page_id = ? OR target_page_id = ?`).run(id, id);
      this.db.prepare(`DELETE FROM wiki_annotations WHERE wiki_page_id = ?`).run(id);
    }
    return this.getRequiredById(id, current.type, true);
  }

  restoreNode(id: string): WikiEntryRecord {
    const current = this.getRequiredById(id, undefined, true);
    const ts = nowIso();
    this.db.prepare(`
      UPDATE entries SET status = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?
    `).run(ts, id);
    return this.getRequiredById(id);
  }

  findById(id: string, includeDeleted = false): WikiEntryRecord | null {
    const clause = includeDeleted ? '' : `AND deleted_at IS NULL AND status != 'deleted'`;
    const row = this.db.prepare(`
      SELECT * FROM entries WHERE id = ? AND type IN ('wiki_space', 'wiki_directory', 'wiki_page') ${clause}
    `).get(id) as EntryRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  findPageByTitle(title: string, spaceId?: string): WikiEntryRecord | null {
    const rows = this.db.prepare(`
      SELECT e.*
      FROM entries e
      WHERE e.type = 'wiki_page'
        AND e.title = ?
        AND e.deleted_at IS NULL
        AND e.status != 'deleted'
      ORDER BY e.updated_at DESC
    `).all(title) as EntryRow[];
    if (!spaceId) {
      return rows[0] ? this.mapRow(rows[0]) : null;
    }
    return rows.map((row) => this.mapRow(row)).find((row) => this.getSpaceIdForNode(row.id) === spaceId) ?? null;
  }

  findPageBySourceUri(uri: string, spaceId?: string): WikiEntryRecord | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM entries
      WHERE type = 'wiki_page'
        AND deleted_at IS NULL
        AND status != 'deleted'
        AND json_extract(metadata_json, '$.source.uri') = ?
      ORDER BY updated_at DESC
    `).all(uri) as EntryRow[];
    if (!spaceId) {
      return rows[0] ? this.mapRow(rows[0]) : null;
    }
    return rows.map((row) => this.mapRow(row)).find((row) => this.getSpaceIdForNode(row.id) === spaceId) ?? null;
  }

  listChildren(parentId: string): WikiEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ? AND type IN ('wiki_directory', 'wiki_page') AND deleted_at IS NULL AND status != 'deleted'
      ORDER BY sort_order ASC, created_at ASC
    `).all(parentId) as EntryRow[];
    return rows.map((row) => this.mapRow(row));
  }


  listTags(parentId?: string | null): WikiTagRecord[] {
    const rows = parentId === undefined
      ? this.db.prepare(`SELECT * FROM wiki_tags ORDER BY path ASC`).all() as TagRow[]
      : this.db.prepare(`SELECT * FROM wiki_tags WHERE parent_id IS ? ORDER BY name ASC`).all(parentId) as TagRow[];
    return rows.map((row) => this.mapTagRow(row));
  }

  ensureTags(paths: string[]): WikiTagRecord[] {
    return paths.map((path) => this.ensureTag(path));
  }

  ensureTag(path: string): WikiTagRecord {
    const parts = path.split('/').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('Tag path cannot be empty');
    }
    let parentId: string | null = null;
    let current: WikiTagRecord | null = null;
    const built: string[] = [];
    for (const part of parts) {
      built.push(part);
      const currentPath = built.join('/');
      const existing = this.db.prepare(`SELECT * FROM wiki_tags WHERE path = ?`).get(currentPath) as TagRow | undefined;
      if (existing) {
        current = this.mapTagRow(existing);
        parentId = current.id;
        continue;
      }
      const id = randomUUID();
      const ts = nowIso();
      this.db.prepare(`
        INSERT INTO wiki_tags (id, name, parent_id, path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, part, parentId, currentPath, ts);
      current = { id, name: part, parentId, path: currentPath, createdAt: ts };
      parentId = id;
    }
    return current!;
  }

  listPageVersions(pageId: string): WikiPageVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM wiki_page_versions WHERE page_id = ? ORDER BY version DESC
    `).all(pageId) as VersionRow[];
    return rows.map((row) => this.mapVersionRow(row));
  }

  getPageVersion(pageId: string, version: number): WikiPageVersionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM wiki_page_versions WHERE page_id = ? AND version = ?
    `).get(pageId, version) as VersionRow | undefined;
    return row ? this.mapVersionRow(row) : null;
  }

  rollbackPage(pageId: string, version: number): WikiEntryRecord {
    const snapshot = this.getPageVersion(pageId, version);
    if (!snapshot) {
      throw new Error(`Wiki page ${pageId} version ${version} not found`);
    }
    return this.updatePage(pageId, {
      title: snapshot.title,
      content: snapshot.content,
      summary: snapshot.summary,
      tags: snapshot.tags,
      metadata: snapshot.metadata,
    });
  }

  getSpaceIdForNode(nodeId: string): string | null {
    const row = this.db.prepare(`
      WITH RECURSIVE lineage(id, parent_id, type) AS (
        SELECT id, parent_id, type FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id, e.parent_id, e.type
        FROM entries e
        JOIN lineage l ON e.id = l.parent_id
      )
      SELECT id FROM lineage WHERE type = 'wiki_space' LIMIT 1
    `).get(nodeId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  replaceLinks(sourcePageId: string, links: Array<Omit<WikiLinkRecord, 'sourcePageId' | 'createdAt' | 'updatedAt'>>): void {
    const ts = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM wiki_links WHERE source_page_id = ?`).run(sourcePageId);
      const insert = this.db.prepare(`
        INSERT INTO wiki_links (source_page_id, target_page_id, target_title, label, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const link of links) {
        insert.run(sourcePageId, link.targetPageId, link.targetTitle, link.label, link.status, ts, ts);
      }
    });
    tx();
  }

  listBacklinks(targetPageId: string): WikiLinkRecord[] {
    const rows = this.db.prepare(`
      SELECT source_page_id, target_page_id, target_title, label, status, created_at, updated_at
      FROM wiki_links
      WHERE target_page_id = ?
      ORDER BY updated_at DESC
    `).all(targetPageId) as Array<{
      source_page_id: string;
      target_page_id: string | null;
      target_title: string;
      label: string;
      status: 'resolved' | 'missing';
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      sourcePageId: row.source_page_id,
      targetPageId: row.target_page_id,
      targetTitle: row.target_title,
      label: row.label,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listAllPages(): WikiEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE type = 'wiki_page' AND deleted_at IS NULL AND status != 'deleted'
      ORDER BY updated_at DESC
    `).all() as EntryRow[];
    return rows.map((row) => this.mapRow(row));
  }

  saveCommunitySuggestions(suggestions: WikiCommunitySuggestion[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM wiki_community_suggestions`).run();
      const insert = this.db.prepare(`
        INSERT INTO wiki_community_suggestions (id, community_key, page_ids_json, score, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const suggestion of suggestions) {
        insert.run(
          suggestion.id,
          suggestion.communityKey,
          JSON.stringify(suggestion.pageIds),
          suggestion.score,
          suggestion.createdAt,
        );
      }
    });
    tx();
  }

  listCommunitySuggestions(): WikiCommunitySuggestion[] {
    const rows = this.db.prepare(`
      SELECT id, community_key, page_ids_json, score, created_at
      FROM wiki_community_suggestions
      ORDER BY score DESC, created_at DESC
    `).all() as Array<{
      id: string;
      community_key: string;
      page_ids_json: string;
      score: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      communityKey: row.community_key,
      pageIds: parseJson<string[]>(row.page_ids_json, []),
      score: row.score,
      createdAt: row.created_at,
    }));
  }

  private savePageVersionSnapshot(page: WikiEntryRecord, createdAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO wiki_page_versions (
        id, page_id, version, title, content, summary, tags_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      page.id,
      page.version,
      page.title,
      page.content,
      page.summary,
      JSON.stringify(page.tags),
      JSON.stringify(page.metadata),
      createdAt,
    );
  }

  private mapVersionRow(row: VersionRow): WikiPageVersionRecord {
    return {
      id: row.id,
      pageId: row.page_id,
      version: row.version,
      title: row.title,
      content: row.content,
      summary: row.summary,
      tags: parseJson<string[]>(row.tags_json, []),
      metadata: parseJson<WikiNodeMetadata>(row.metadata_json, {}),
      createdAt: row.created_at,
    };
  }

  private mapTagRow(row: TagRow): WikiTagRecord {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      path: row.path,
      createdAt: row.created_at,
    };
  }

  private buildTree(rows: EntryRow[], rootId: string): WikiTreeNode {
    const map = new Map<string, WikiTreeNode>();
    for (const row of rows) {
      const record = this.mapRow(row);
      map.set(record.id, {
        ...record,
        nodeType: record.type === 'wiki_space' ? 'space' : record.type === 'wiki_directory' ? 'directory' : 'page',
        children: [],
      });
    }
    for (const node of map.values()) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      }
    }
    const root = map.get(rootId);
    if (!root) {
      throw new Error(`Space ${rootId} not found in tree build result`);
    }
    return root;
  }

  private nextSortOrder(parentId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM entries WHERE parent_id = ?
    `).get(parentId) as { max_order: number };
    return row.max_order + 1;
  }

  private assertParentType(parentId: string, expected: WikiEntryType[]): void {
    const row = this.db.prepare(`SELECT type FROM entries WHERE id = ?`).get(parentId) as { type: WikiEntryType } | undefined;
    if (!row || !expected.includes(row.type)) {
      throw new Error(`Invalid parent ${parentId}; expected one of ${expected.join(', ')}`);
    }
  }

  private getRequiredById(id: string, type?: WikiEntryType, includeDeleted = false): WikiEntryRecord {
    const record = this.findById(id, includeDeleted);
    if (!record) {
      throw new Error(`Wiki entry ${id} not found`);
    }
    if (type && record.type !== type) {
      throw new Error(`Wiki entry ${id} is ${record.type}, expected ${type}`);
    }
    return record;
  }

  /**
   * FR-4, FR-5: Vector similarity search. Retrieves entries with embeddings
   * and returns them sorted by cosine similarity (computed in application layer).
   */
  findByVector(embedding: number[], limit: number): WikiEntryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE embedding IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'active'
    `).all() as EntryRow[];

    // Compute cosine similarity in application layer
    const withSimilarity = rows
      .map((row) => {
        const decoded = decodeEmbedding(row.embedding);
        if (!decoded || decoded.length !== embedding.length) return null;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < embedding.length; i++) {
          dot += embedding[i] * decoded[i];
          normA += embedding[i] * embedding[i];
          normB += decoded[i] * decoded[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        const similarity = denom === 0 ? 0 : dot / denom;
        return { row, similarity };
      })
      .filter((x): x is { row: EntryRow; similarity: number } => x !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return withSimilarity.map(({ row }) => this.mapRow(row));
  }

  /**
   * FR-5: Full-text search with optional scope filtering.
   * Uses LIKE matching (FTS5 virtual table can be added as optimization).
   */
  search(query: string, scope?: { spaceId?: string; directoryId?: string }): WikiEntryRecord[] {
    let sql = `
      SELECT * FROM entries
      WHERE deleted_at IS NULL
        AND status = 'active'
        AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
    `;
    const escaped = query.replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const params: unknown[] = [pattern, pattern, pattern];

    if (scope?.directoryId) {
      sql += ` AND parent_id = ?`;
      params.push(scope.directoryId);
    } else if (scope?.spaceId) {
      sql += ` AND (parent_id = ? OR parent_id IN (
        SELECT id FROM entries WHERE parent_id = ? AND type = 'wiki_directory'
      ))`;
      params.push(scope.spaceId, scope.spaceId);
    }

    sql += ` ORDER BY updated_at DESC LIMIT 50`;

    const rows = this.db.prepare(sql).all(...params) as EntryRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: EntryRow): WikiEntryRecord {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      summary: row.summary,
      parentId: row.parent_id,
      sortOrder: row.sort_order,
      status: row.status as WikiEntryRecord['status'],
      tags: parseJson<string[]>(row.tags_json, []),
      metadata: parseJson<WikiNodeMetadata>(row.metadata_json, {}),
      embedding: decodeEmbedding(row.embedding),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }
}
