/**
 * Subject Repository — KIVO Wave 1 B1
 *
 * Owns the SQL access for `subject_nodes`. Pure SQL helpers — no
 * HTTP / Next.js coupling, so the same code can later be reused by
 * B2-B5 (rename / merge / split / alias) which will add their own
 * mutations on top of this CRUD baseline.
 *
 * Schema reference (migrations/2026-05-24-wave0-schema.sql):
 *   id, parent_id, name, tree_kind, origin, created_by_material_id,
 *   created_at, confidence, aliases, merged_into, level
 *
 * Wave 1 B1 only writes: id, parent_id, name, tree_kind, origin,
 * created_at, level. Other columns stay at SQL defaults / NULL so
 * downstream pipelines can fill them later.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { openWebDb } from '@/lib/db';
import { ensureSubjectMutationSchema } from '@/lib/subjects/mutation-schema';
import {
  SUBJECT_LEVEL_DOMAIN,
  SUBJECT_MAX_LEVEL,
  type CreateSubjectInput,
  type MergeSubjectInput,
  type MergeSubjectResult,
  type RenameSubjectInput,
  type SplitSubjectInput,
  type SplitSubjectResult,
  type SubjectLevel,
  type SubjectNode,
  type SubjectNodeRow,
  type SubjectTreeNode,
  type UpdateSubjectInput,
} from '@/lib/types/subject';

export type RepoErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST';

export class SubjectRepoError extends Error {
  constructor(
    public readonly code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubjectRepoError';
  }
}

const TREE_KIND = 'subject';
const ORIGIN_MANUAL = 'manual';

function rowToNode(row: SubjectNodeRow, materialCount: number): SubjectNode {
  const lvl = (row.level ?? SUBJECT_LEVEL_DOMAIN) as SubjectLevel;
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    level: lvl,
    treeKind: row.tree_kind,
    origin: row.origin,
    createdAt: row.created_at,
    materialCount,
    isSystemRoot: row.deletable === 0,
  };
}

export interface SubjectRepoDeps {
  /** Optional existing handle for tests. Production code passes nothing. */
  db?: Database.Database;
}

export class SubjectRepository {
  private readonly db: Database.Database;

  constructor(deps: SubjectRepoDeps = {}) {
    this.db = deps.db ?? openWebDb(false);
    // foreign_keys default off in better-sqlite3; we enforce parent
    // existence manually so this isn't strictly required, but flipping
    // it on keeps later migrations honest.
    this.db.pragma('foreign_keys = ON');
    ensureSubjectMutationSchema(this.db);
  }

  /**
   * List all subject_nodes that have not been merged away, attach
   * direct material counts, and return them as a nested tree.
   *
   * Nodes whose parent has been deleted (orphans) are surfaced as
   * additional roots so they remain reachable for cleanup.
   */
  listTree(): SubjectTreeNode[] {
    const subjectRows = this.db
      .prepare<[]>(
        `SELECT id, parent_id, name, tree_kind, origin,
                created_by_material_id, created_at, confidence,
                aliases, merged_into, level, status, deletable
           FROM subject_nodes
          WHERE merged_into IS NULL
            AND COALESCE(status, 'active') = 'active'
          ORDER BY level ASC, name ASC`,
      )
      .all() as SubjectNodeRow[];

    const rows = subjectRows.length > 0 ? subjectRows : this.fallbackRowsFromEntries();
    const counts = this.directMaterialCounts();
    const fallbackCounts = subjectRows.length > 0 ? new Map<string, number>() : this.directEntryCountsByDomain();
    const nodes: SubjectTreeNode[] = rows.map((r) => ({
      ...rowToNode(r, counts.get(r.id) ?? fallbackCounts.get(r.id) ?? 0),
      children: [],
    }));

    const byId = new Map<string, SubjectTreeNode>();
    for (const n of nodes) byId.set(n.id, n);

    const roots: SubjectTreeNode[] = [];
    for (const n of nodes) {
      if (n.parentId && byId.has(n.parentId)) {
        byId.get(n.parentId)!.children.push(n);
      } else {
        roots.push(n);
      }
    }
    return roots;
  }

  /** Returns one node, with material count attached, or null. */
  getById(id: string): SubjectNode | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT id, parent_id, name, tree_kind, origin,
                created_by_material_id, created_at, confidence,
                aliases, merged_into, level, status, deletable
           FROM subject_nodes
          WHERE id = ?`,
      )
      .get(id) as SubjectNodeRow | undefined;
    if (!row) return null;
    const count = this.materialCountFor(id);
    return rowToNode(row, count);
  }

  create(input: CreateSubjectInput): SubjectNode {
    // A1: Prevent creating new L0 (domain) nodes — only system roots exist at L0
    if (input.level === SUBJECT_LEVEL_DOMAIN) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        'cannot create new top-level domain nodes; use existing system roots as parents',
      );
    }

    this.assertParentMatchesLevel(input.parentId, input.level);
    this.assertSiblingNameFree(input.parentId, input.name, /* excludeId */ null);

    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO subject_nodes
           (id, parent_id, name, tree_kind, origin, created_at, level, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, input.parentId, input.name, TREE_KIND, ORIGIN_MANUAL, now, input.level);

    const created = this.getById(id);
    if (!created) {
      // Should never happen — INSERT just succeeded.
      throw new SubjectRepoError('NOT_FOUND', 'failed to read back created subject');
    }
    return created;
  }

  update(id: string, input: UpdateSubjectInput): SubjectNode {
    const existing = this.getRowOrThrow(id);

    let nextName = existing.name;
    let nextParentId = existing.parent_id;

    if (input.name !== undefined && input.name !== existing.name) {
      nextName = input.name;
    }

    if (input.parentId !== undefined && input.parentId !== existing.parent_id) {
      const lvl = (existing.level ?? SUBJECT_LEVEL_DOMAIN) as SubjectLevel;
      if (lvl === SUBJECT_LEVEL_DOMAIN && input.parentId !== null) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          'L0 (domain) nodes cannot be moved under a parent',
        );
      }
      if (lvl !== SUBJECT_LEVEL_DOMAIN && input.parentId === null) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          'L1/L2 nodes must have a parent_id',
        );
      }
      if (input.parentId === id) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          'a node cannot be its own parent',
        );
      }
      this.assertParentMatchesLevel(input.parentId, lvl);
      if (input.parentId !== null) {
        this.assertNotDescendant(id, input.parentId);
      }
      nextParentId = input.parentId;
    }

    if (nextName !== existing.name || nextParentId !== existing.parent_id) {
      this.assertSiblingNameFree(nextParentId, nextName, /* excludeId */ id);
    }

    this.db
      .prepare(
        `UPDATE subject_nodes
            SET name = ?, parent_id = ?
          WHERE id = ?`,
      )
      .run(nextName, nextParentId, id);

    const updated = this.getById(id);
    if (!updated) {
      throw new SubjectRepoError('NOT_FOUND', `subject ${id} disappeared mid-update`);
    }
    return updated;
  }

  /**
   * Hard-delete a subject node. Refuses if it has children or
   * materials attached. (Soft-delete / merge is owned by B3.)
   * A1: Refuses deletion of system root nodes (deletable=0).
   */
  delete(id: string): void {
    const row = this.getRowOrThrow(id);

    // A1: System root nodes cannot be deleted
    const deletableRow = this.db
      .prepare<[string]>('SELECT deletable FROM subject_nodes WHERE id = ?')
      .get(id) as { deletable: number } | undefined;
    if (deletableRow && deletableRow.deletable === 0) {
      throw new SubjectRepoError(
        'CONFLICT',
        'system root nodes cannot be deleted',
      );
    }

    const childCount = (
      this.db
        .prepare<[string]>(
        `SELECT COUNT(*) AS c FROM subject_nodes
            WHERE parent_id = ? AND merged_into IS NULL
              AND COALESCE(status, 'active') = 'active'`,
        )
        .get(id) as { c: number }
    ).c;
    if (childCount > 0) {
      throw new SubjectRepoError(
        'CONFLICT',
        `subject has ${childCount} child node(s); remove them first`,
      );
    }

    // B1/FR-P09 AC5: Cascade-clean relationship tables, then delete node.
    // Materials/entries themselves are NOT deleted — they become unclassified.
    this.db.prepare(`DELETE FROM material_subjects WHERE subject_id = ?`).run(id);
    this.db.prepare(`DELETE FROM entry_subjects WHERE subject_id = ?`).run(id);
    this.db.prepare(`DELETE FROM subject_nodes WHERE id = ?`).run(id);
  }

  rename(input: RenameSubjectInput): SubjectNode {
    const name = input.newName.trim();
    if (!name) {
      throw new SubjectRepoError('BAD_REQUEST', 'new_name cannot be empty');
    }

    const tx = this.db.transaction((subjectId: string, nextName: string) => {
      const existing = this.getRowOrThrow(subjectId);
      if (existing.name === nextName) {
        return this.readNodeOrThrow(subjectId);
      }

      this.assertSiblingNameFree(existing.parent_id, nextName, subjectId);
      const now = Date.now();

      this.db
        .prepare(
          `UPDATE subject_nodes
              SET name = ?, aliases = ?
            WHERE id = ?`,
        )
        .run(nextName, mergePriorName(existing.aliases, existing.name), subjectId);

      this.db
        .prepare(
          `INSERT INTO subject_aliases
             (id, subject_id, alias_name, alias_kind, created_at)
           VALUES (?, ?, ?, 'rename', ?)`,
        )
        .run(randomUUID(), subjectId, existing.name, now);

      this.db
        .prepare(
          `INSERT INTO subject_history
             (id, subject_id, event_type, payload_json, created_at)
           VALUES (?, ?, 'rename', ?, ?)`,
        )
        .run(
          randomUUID(),
          subjectId,
          JSON.stringify({
            old_name: existing.name,
            new_name: nextName,
          }),
          now,
        );

      return this.readNodeOrThrow(subjectId);
    });

    try {
      return tx(input.subjectId, name) as SubjectNode;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /**
   * B2 — Merge `sourceId` into `targetId`.
   *
   * Constraints (all enforced before any write):
   *   - source != target (cannot self-merge)
   *   - both nodes exist and are not already merged away
   *   - both nodes share the same `level` (cross-level merge is rejected
   *     because it would create an invalid tree shape — e.g. attaching
   *     a topic's children directly under a domain)
   *   - target must not be a descendant of source (would create a cycle
   *     once we re-parent source's children onto target)
   *
   * Side effects (executed atomically inside a single SQLite transaction):
   *   - All `subject_nodes` whose `parent_id = source` are re-parented to
   *     `target` (the merged-into node hosts source's children).
   *   - All `materials` whose `subject_node_id = source` are re-pointed
   *     to `target`.
   *   - source.merged_into is set to target.id and source.aliases is
   *     amended with `merged_from_name` so the historical name remains
   *     searchable / auditable.
   *
   * After this returns, the source node will be invisible to listTree()
   * because the existing `merged_into IS NULL` filter (B1) hides it.
   */
  merge(input: MergeSubjectInput): MergeSubjectResult {
    if (input.sourceSubjectIds.length === 0) {
      throw new SubjectRepoError('BAD_REQUEST', 'source_subject_ids must not be empty');
    }

    const sourceIds = Array.from(new Set(input.sourceSubjectIds));
    if (sourceIds.includes(input.targetSubjectId)) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        'target_subject_id cannot also appear in source_subject_ids',
      );
    }

    const tx = this.db.transaction((sources: string[], targetId: string) => {
      const now = Date.now();
      const targetRow = this.getRowOrThrow(targetId);
      const targetLevel = (targetRow.level ?? SUBJECT_LEVEL_DOMAIN) as SubjectLevel;

      let movedChildren = 0;
      let movedEntries = 0;
      let movedAliases = 0;
      let movedMaterials = 0;

      for (const sourceId of sources) {
        const source = this.getRowOrThrow(sourceId);
        const sourceLevel = (source.level ?? SUBJECT_LEVEL_DOMAIN) as SubjectLevel;
        if (sourceLevel !== targetLevel) {
          throw new SubjectRepoError(
            'BAD_REQUEST',
            `source level (${sourceLevel}) and target level (${targetLevel}) must match`,
          );
        }
        if (this.isDescendant(targetId, sourceId)) {
          throw new SubjectRepoError(
            'BAD_REQUEST',
            `target ${targetId} is a descendant of source ${sourceId}`,
          );
        }

        movedChildren += this.db
          .prepare(
            `UPDATE subject_nodes
                SET parent_id = ?
              WHERE parent_id = ?
                AND merged_into IS NULL
                AND COALESCE(status, 'active') = 'active'`,
          )
          .run(targetId, sourceId).changes;

        movedEntries += this.db
          .prepare(`UPDATE entries SET subject_id = ? WHERE subject_id = ?`)
          .run(targetId, sourceId).changes;

        movedMaterials += this.db
          .prepare(`UPDATE materials SET subject_node_id = ? WHERE subject_node_id = ?`)
          .run(targetId, sourceId).changes;

        movedAliases += this.db
          .prepare(`UPDATE subject_aliases SET subject_id = ? WHERE subject_id = ?`)
          .run(targetId, sourceId).changes;

        this.db
          .prepare(
            `INSERT INTO subject_aliases
               (id, subject_id, alias_name, alias_kind, created_at)
             VALUES (?, ?, ?, 'merge', ?)`,
          )
          .run(randomUUID(), targetId, source.name, now);
        movedAliases += 1;

        this.db
          .prepare(
            `UPDATE subject_nodes
                SET merged_into = ?, status = 'merged', aliases = ?
              WHERE id = ?`,
          )
          .run(targetId, mergeMergedFrom(source.aliases, source.name, targetId), sourceId);

        this.db
          .prepare(
            `INSERT INTO subject_history
               (id, subject_id, event_type, payload_json, created_at)
             VALUES (?, ?, 'merge', ?, ?)`,
          )
          .run(
            randomUUID(),
            sourceId,
            JSON.stringify({
              target_subject_id: targetId,
              source_subject_id: sourceId,
            }),
            now,
          );
      }

      const target = this.readNodeOrThrow(targetId);
      return {
        target,
        sourceSubjectIds: sources,
        movedChildren,
        movedEntries,
        movedAliases,
        movedMaterials,
      };
    });

    try {
      return tx(sourceIds, input.targetSubjectId) as MergeSubjectResult;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  split(input: SplitSubjectInput): SplitSubjectResult {
    if (input.splits.length === 0) {
      throw new SubjectRepoError('BAD_REQUEST', 'splits must not be empty');
    }

    const tx = this.db.transaction((payload: SplitSubjectInput) => {
      const source = this.getRowOrThrow(payload.sourceSubjectId);
      const now = Date.now();
      const sourceEntries = this.db
        .prepare<[string]>(`SELECT id FROM entries WHERE subject_id = ?`)
        .all(payload.sourceSubjectId) as Array<{ id: string }>;
      const sourceEntryIds = new Set(sourceEntries.map((row) => row.id));
      const assigned = new Set<string>();
      const createdSubjects: SubjectNode[] = [];
      const splitOrder = new Map<string, number>();
      const entryTargetById = new Map<string, string>();
      let movedEntries = 0;
      let movedMaterials = 0;

      for (const [index, split] of payload.splits.entries()) {
        this.assertSiblingNameFree(source.parent_id, split.name, null);

        const subjectId = randomUUID();
        splitOrder.set(subjectId, index);
        this.db
          .prepare(
            `INSERT INTO subject_nodes
               (id, parent_id, name, tree_kind, origin, created_at, level, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
          )
          .run(
            subjectId,
            source.parent_id,
            split.name,
            source.tree_kind,
            source.origin,
            now,
            source.level ?? SUBJECT_LEVEL_DOMAIN,
          );

        for (const entryId of split.entryIds) {
          if (assigned.has(entryId)) {
            throw new SubjectRepoError(
              'BAD_REQUEST',
              `entry ${entryId} appears in more than one split target`,
            );
          }
          if (!sourceEntryIds.has(entryId)) {
            throw new SubjectRepoError(
              'BAD_REQUEST',
              `entry ${entryId} is not assigned to source subject ${payload.sourceSubjectId}`,
            );
          }
          assigned.add(entryId);
          entryTargetById.set(entryId, subjectId);
        }

        if (split.entryIds.length > 0) {
          const placeholders = split.entryIds.map(() => '?').join(', ');
          movedEntries += this.db
            .prepare(
              `UPDATE entries
                  SET subject_id = ?
                WHERE id IN (${placeholders})
                  AND subject_id = ?`,
            )
            .run(subjectId, ...split.entryIds, payload.sourceSubjectId).changes;
        }

        createdSubjects.push(this.readNodeOrThrow(subjectId));
      }

      if (assigned.size !== sourceEntryIds.size) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          `split entry_ids must cover all ${sourceEntryIds.size} source entries exactly once`,
        );
      }

      movedMaterials = this.redistributeSplitMaterials(
        payload.sourceSubjectId,
        entryTargetById,
        splitOrder,
      );

      this.db
        .prepare(
          `UPDATE subject_nodes
              SET status = 'split'
            WHERE id = ?`,
        )
        .run(payload.sourceSubjectId);

      this.db
        .prepare(
          `INSERT INTO subject_history
             (id, subject_id, event_type, payload_json, created_at)
           VALUES (?, ?, 'split', ?, ?)`,
        )
        .run(
          randomUUID(),
          payload.sourceSubjectId,
          JSON.stringify({
            created_subject_ids: createdSubjects.map((subject) => subject.id),
            moved_materials: movedMaterials,
            splits: payload.splits.map((split) => ({
              name: split.name,
              entry_ids: split.entryIds,
            })),
          }),
          now,
        );

      return {
        sourceSubjectId: payload.sourceSubjectId,
        createdSubjects,
        movedEntries,
        movedMaterials,
      };
    });

    try {
      return tx(input) as SplitSubjectResult;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** True if `candidateId` lives anywhere under `ancestorId`'s subtree. */
  private redistributeSplitMaterials(
    sourceSubjectId: string,
    entryTargetById: Map<string, string>,
    splitOrder: Map<string, number>,
  ): number {
    const sourceMaterials = this.db
      .prepare<[string]>(`SELECT id FROM materials WHERE subject_node_id = ?`)
      .all(sourceSubjectId) as Array<{ id: string }>;
    if (sourceMaterials.length === 0 || entryTargetById.size === 0) return 0;

    const materialIdsByEntryId = this.readEntryMaterialIds(Array.from(entryTargetById.keys()));
    let moved = 0;

    for (const material of sourceMaterials) {
      const votes = new Map<string, number>();
      for (const [entryId, targetSubjectId] of entryTargetById.entries()) {
        const materialIds = materialIdsByEntryId.get(entryId);
        if (!materialIds?.has(material.id)) continue;
        votes.set(targetSubjectId, (votes.get(targetSubjectId) ?? 0) + 1);
      }

      const winner = this.pickSplitMaterialWinner(votes, splitOrder);
      if (!winner || winner === sourceSubjectId) continue;

      moved += this.db
        .prepare(`UPDATE materials SET subject_node_id = ? WHERE id = ? AND subject_node_id = ?`)
        .run(winner, material.id, sourceSubjectId).changes;
    }

    return moved;
  }

  private readEntryMaterialIds(entryIds: string[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    if (entryIds.length === 0) return result;

    const placeholders = entryIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id, source_json, metadata_json FROM entries WHERE id IN (${placeholders})`)
      .all(...entryIds) as Array<{
        id: string;
        source_json: string | null;
        metadata_json?: string | null;
      }>;

    for (const row of rows) {
      result.set(row.id, extractMaterialIdsFromEntry(row));
    }
    return result;
  }

  private pickSplitMaterialWinner(
    votes: Map<string, number>,
    splitOrder: Map<string, number>,
  ): string | null {
    let winner: string | null = null;
    let bestCount = 0;
    let bestOrder = Number.POSITIVE_INFINITY;

    for (const [subjectId, count] of votes.entries()) {
      const order = splitOrder.get(subjectId) ?? Number.POSITIVE_INFINITY;
      if (count > bestCount || (count === bestCount && order < bestOrder)) {
        winner = subjectId;
        bestCount = count;
        bestOrder = order;
      }
    }

    return winner;
  }

  /** True if `candidateId` lives anywhere under `ancestorId`'s subtree. */
  private isDescendant(candidateId: string, ancestorId: string): boolean {
    const seen = new Set<string>();
    let cursor: string | null = candidateId;
    while (cursor !== null) {
      if (seen.has(cursor)) return false; // pre-existing cycle, abort
      seen.add(cursor);
      if (cursor === ancestorId && candidateId !== ancestorId) {
        return true;
      }
      const row = this.db
        .prepare<[string]>(`SELECT parent_id FROM subject_nodes WHERE id = ?`)
        .get(cursor) as { parent_id: string | null } | undefined;
      cursor = row?.parent_id ?? null;
      if (cursor === ancestorId) return true;
    }
    return false;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private getRowOrThrow(id: string): SubjectNodeRow {
    const row = this.db
      .prepare<[string]>(
        `SELECT id, parent_id, name, tree_kind, origin,
                created_by_material_id, created_at, confidence,
                aliases, merged_into, level, status, deletable
           FROM subject_nodes
          WHERE id = ?`,
      )
      .get(id) as SubjectNodeRow | undefined;
    if (!row) {
      throw new SubjectRepoError('NOT_FOUND', `subject ${id} not found`);
    }
    if (row.merged_into) {
      throw new SubjectRepoError(
        'CONFLICT',
        `subject ${id} has been merged into ${row.merged_into}`,
      );
    }
    if ((row.status ?? 'active') !== 'active') {
      throw new SubjectRepoError(
        'CONFLICT',
        `subject ${id} is not active (status=${row.status})`,
      );
    }
    return row;
  }

  private assertParentMatchesLevel(
    parentId: string | null,
    level: SubjectLevel,
  ): void {
    if (level < SUBJECT_LEVEL_DOMAIN || level > SUBJECT_MAX_LEVEL) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        `level ${level} out of range (0..${SUBJECT_MAX_LEVEL})`,
      );
    }
    if (level === SUBJECT_LEVEL_DOMAIN) {
      if (parentId !== null) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          'L0 (domain) nodes must have parent_id = null',
        );
      }
      return;
    }
    if (!parentId) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        `level ${level} requires a parent_id`,
      );
    }
    const parent = this.db
      .prepare<[string]>(
        `SELECT id, level, merged_into FROM subject_nodes WHERE id = ?`,
      )
      .get(parentId) as { id: string; level: number | null; merged_into: string | null } | undefined;
    if (!parent) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        `parent ${parentId} does not exist`,
      );
    }
    if (parent.merged_into) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        `parent ${parentId} has been merged away`,
      );
    }
    const parentLevel = parent.level ?? SUBJECT_LEVEL_DOMAIN;
    if (parentLevel !== level - 1) {
      throw new SubjectRepoError(
        'BAD_REQUEST',
        `parent level (${parentLevel}) must be ${level - 1} for a level ${level} node`,
      );
    }
  }

  private assertSiblingNameFree(
    parentId: string | null,
    name: string,
    excludeId: string | null,
  ): void {
    const row = this.db
      .prepare(
        `SELECT id FROM subject_nodes
          WHERE name = ?
            AND merged_into IS NULL
            AND COALESCE(status, 'active') = 'active'
            AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
            AND (? IS NULL OR id != ?)
          LIMIT 1`,
      )
      .get(name, parentId, parentId, excludeId, excludeId) as { id: string } | undefined;
    if (row) {
      throw new SubjectRepoError(
        'CONFLICT',
        `another subject named "${name}" already exists under the same parent`,
      );
    }
  }

  /** Prevents moving a node under one of its own descendants. */
  private assertNotDescendant(nodeId: string, candidateParent: string): void {
    const seen = new Set<string>();
    let next: string | null = candidateParent;
    while (next !== null) {
      const cursor: string = next;
      if (seen.has(cursor)) {
        // Existing data already has a cycle — bail loudly rather than loop.
        throw new SubjectRepoError(
          'CONFLICT',
          `detected pre-existing cycle while validating move of ${nodeId}`,
        );
      }
      seen.add(cursor);
      if (cursor === nodeId) {
        throw new SubjectRepoError(
          'BAD_REQUEST',
          `cannot move ${nodeId} under its own descendant ${candidateParent}`,
        );
      }
      const row = this.db
        .prepare<[string]>(`SELECT parent_id FROM subject_nodes WHERE id = ?`)
        .get(cursor) as { parent_id: string | null } | undefined;
      next = row?.parent_id ?? null;
    }
  }

  /** Map of subject_id -> direct material count for whole tree. */
  private directMaterialCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT subject_node_id AS id, COUNT(*) AS c
           FROM materials
          WHERE subject_node_id IS NOT NULL
          GROUP BY subject_node_id`,
      )
      .all() as Array<{ id: string; c: number }>;
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.id, r.c);
    return out;
  }

  /**
   * Fallback for legacy wiki data: if subject_nodes has not been seeded yet,
   * expose active wiki domains from entries.domain so the sidebar reflects
   * the same data source as the LLM Wiki. The fallback is read-only and only
   * used for the empty subject_nodes state.
   */
  private fallbackRowsFromEntries(): SubjectNodeRow[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT domain AS name, MIN(created_at) AS first_created_at
           FROM entries
          WHERE status = 'active'
            AND deleted_at IS NULL
            AND type IN ('wiki_page', 'wiki_directory')
            AND domain IS NOT NULL
            AND TRIM(domain) <> ''
          GROUP BY domain
          ORDER BY domain ASC`,
      )
      .all() as Array<{ name: string; first_created_at: string | number | null }>;

    return rows.map((row) => ({
      id: domainFallbackId(row.name),
      parent_id: null,
      name: row.name,
      tree_kind: TREE_KIND,
      origin: 'entries-domain',
      created_by_material_id: null,
      created_at: readCreatedAtMillis(row.first_created_at) ?? now,
      confidence: null,
      aliases: null,
      merged_into: null,
      level: SUBJECT_LEVEL_DOMAIN,
      status: 'active',
      deletable: 1,
    }));
  }

  private directEntryCountsByDomain(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT domain AS name, COUNT(*) AS c
           FROM entries
          WHERE status = 'active'
            AND deleted_at IS NULL
            AND type = 'wiki_page'
            AND domain IS NOT NULL
            AND TRIM(domain) <> ''
          GROUP BY domain`,
      )
      .all() as Array<{ name: string; c: number }>;
    const out = new Map<string, number>();
    for (const row of rows) out.set(domainFallbackId(row.name), row.c);
    return out;
  }

  private materialCountFor(id: string): number {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) AS c FROM materials WHERE subject_node_id = ?`,
      )
      .get(id) as { c: number };
    return row.c;
  }

  private readNodeOrThrow(id: string): SubjectNode {
    const node = this.getById(id);
    if (!node) {
      throw new SubjectRepoError('NOT_FOUND', `subject ${id} not found`);
    }
    return node;
  }
}

/**
 * Merge a previous name into the existing aliases JSON without
 * destroying any other keys (e.g. `domain` / `seed` left by seeds).
 *
 * Storage shape:
 *   {
 *     "prior_names": ["旧名1", "旧名2"],
 *     ...untouched original fields...
 *   }
 *
 * If the existing column is null/empty/non-object JSON we fall back to
 * a fresh `{ prior_names: [...] }` object so we never lose information.
 */
function mergePriorName(
  rawAliases: string | null,
  oldName: string,
): string {
  const base = parseAliasesObject(rawAliases);
  const priorRaw = base.prior_names;
  const prior: string[] = Array.isArray(priorRaw)
    ? priorRaw.filter((v): v is string => typeof v === 'string')
    : [];
  if (!prior.includes(oldName)) prior.push(oldName);
  base.prior_names = prior;
  return JSON.stringify(base);
}

/**
 * Stamp the source aliases JSON with a `merged_from_name` so the
 * historical name remains discoverable after merge.
 */
function mergeMergedFrom(
  rawAliases: string | null,
  sourceName: string,
  targetId: string,
): string {
  const base = parseAliasesObject(rawAliases);
  base.merged_from_name = sourceName;
  base.merged_into_id = targetId;
  return JSON.stringify(base);
}

function parseAliasesObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function domainFallbackId(domain: string): string {
  return `entries-domain:${encodeURIComponent(domain)}`;
}

function readCreatedAtMillis(value: string | number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractMaterialIdsFromEntry(row: {
  source_json: string | null;
  metadata_json?: string | null;
}): Set<string> {
  const ids = new Set<string>();
  collectMaterialIds(parseJsonObject(row.metadata_json), ids);
  collectMaterialIds(parseJsonObject(row.source_json), ids);
  return ids;
}

function parseJsonObject(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectMaterialIds(value: unknown, ids: Set<string>, key?: string): void {
  if (typeof value === 'string') {
    if (key && isMaterialIdKey(key)) ids.add(value);
    for (const id of extractMaterialIdsFromString(value)) ids.add(id);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMaterialIds(item, ids, key);
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectMaterialIds(childValue, ids, childKey);
  }
}

function isMaterialIdKey(key: string): boolean {
  return key === 'materialId' || key === 'material_id' || key === 'materialIds' || key === 'material_ids';
}

function extractMaterialIdsFromString(value: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /(?:material:|material\/)([A-Za-z0-9][A-Za-z0-9._:-]{1,127})/g,
    /upload:\/\/material\/([A-Za-z0-9][A-Za-z0-9._:-]{1,127})/g,
    /api:\/\/material\/([A-Za-z0-9][A-Za-z0-9._:-]{1,127})/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      ids.push(match[1]);
    }
  }

  return ids;
}

function mapSqliteError(error: unknown): SubjectRepoError {
  if (error instanceof SubjectRepoError) {
    return error;
  }
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return new SubjectRepoError('CONFLICT', error.message);
  }
  if (error instanceof Error) {
    return new SubjectRepoError('BAD_REQUEST', error.message);
  }
  return new SubjectRepoError('BAD_REQUEST', 'unknown sqlite error');
}

let cachedRepo: SubjectRepository | null = null;
export function getSubjectRepository(): SubjectRepository {
  if (!cachedRepo) cachedRepo = new SubjectRepository();
  return cachedRepo;
}
