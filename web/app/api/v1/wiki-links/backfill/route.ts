/**
 * POST /api/v1/wiki-links/backfill — Backfill wiki_links from subject_nodes hierarchy.
 *
 * For each wiki_page entry with a subject_id, generates links to parent/child/sibling
 * subject wiki pages, mirroring what wiki-page-compiler does during compilation.
 */

import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface BackfillResult {
  pagesProcessed: number;
  linksInserted: number;
}

export async function POST() {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Ensure wiki_links table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_links (
        source_page_id TEXT NOT NULL,
        target_page_id TEXT,
        target_title TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'missing',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_page_id, target_title)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_links_target_page ON wiki_links(target_page_id);
      CREATE INDEX IF NOT EXISTS idx_wiki_links_status ON wiki_links(status);
    `);

    // Get all wiki_page entries with subject_id
    const wikiPages = db.prepare(`
      SELECT e.id AS page_id, e.subject_id, s.name AS subject_name, s.parent_id
      FROM entries e
      JOIN subject_nodes s ON e.subject_id = s.id
      WHERE e.type = 'wiki_page'
        AND e.subject_id IS NOT NULL
        AND COALESCE(e.status, 'active') = 'active'
    `).all() as Array<{ page_id: string; subject_id: string; subject_name: string; parent_id: string | null }>;

    if (wikiPages.length === 0) {
      const response: ApiResponse<BackfillResult> = {
        data: { pagesProcessed: 0, linksInserted: 0 },
      };
      return NextResponse.json(response);
    }

    // Build a map: subject_id -> page_id for resolving links
    const subjectToPage = new Map<string, string>();
    for (const wp of wikiPages) {
      subjectToPage.set(wp.subject_id, wp.page_id);
    }

    const now = new Date().toISOString();
    let totalLinks = 0;

    const insertLink = db.prepare(`
      INSERT OR REPLACE INTO wiki_links (source_page_id, target_page_id, target_title, label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const wp of wikiPages) {
        // Clear existing links for this page
        db!.prepare('DELETE FROM wiki_links WHERE source_page_id = ?').run(wp.page_id);

        const links: Array<{ targetId: string | null; title: string; label: string }> = [];

        // Parent link
        if (wp.parent_id) {
          const parent = db!.prepare('SELECT id, name FROM subject_nodes WHERE id = ?').get(wp.parent_id) as { id: string; name: string } | undefined;
          if (parent) {
            links.push({ targetId: subjectToPage.get(parent.id) ?? null, title: parent.name, label: '上级主题' });
          }
        }

        // Child links
        const children = db!.prepare(`
          SELECT id, name FROM subject_nodes
          WHERE parent_id = ? AND COALESCE(status, 'active') = 'active' AND merged_into IS NULL
          ORDER BY name ASC
        `).all(wp.subject_id) as Array<{ id: string; name: string }>;
        for (const child of children) {
          links.push({ targetId: subjectToPage.get(child.id) ?? null, title: child.name, label: '下级主题' });
        }

        // Sibling links
        if (wp.parent_id) {
          const siblings = db!.prepare(`
            SELECT id, name FROM subject_nodes
            WHERE parent_id = ? AND id != ? AND COALESCE(status, 'active') = 'active' AND merged_into IS NULL
            ORDER BY name ASC LIMIT 6
          `).all(wp.parent_id, wp.subject_id) as Array<{ id: string; name: string }>;
          for (const sibling of siblings) {
            links.push({ targetId: subjectToPage.get(sibling.id) ?? null, title: sibling.name, label: '同层主题' });
          }
        }

        // Also add links from graph_edges where this page's entries are involved
        const entryIds = db!.prepare(`
          SELECT id FROM entries
          WHERE subject_id = ? AND type != 'wiki_page' AND COALESCE(status, 'active') = 'active'
        `).all(wp.subject_id) as Array<{ id: string }>;

        if (entryIds.length > 0) {
          // Find other subjects connected via graph_edges
          const placeholders = entryIds.map(() => '?').join(',');
          const connectedSubjects = db!.prepare(`
            SELECT DISTINCT s.id, s.name
            FROM graph_edges ge
            JOIN entries e ON ge.target_id = e.id
            JOIN subject_nodes s ON e.subject_id = s.id
            WHERE ge.source_id IN (${placeholders})
              AND e.subject_id IS NOT NULL
              AND e.subject_id != ?
            LIMIT 10
          `).all(...entryIds.map(e => e.id), wp.subject_id) as Array<{ id: string; name: string }>;

          for (const cs of connectedSubjects) {
            const targetPageId = subjectToPage.get(cs.id) ?? null;
            // Avoid duplicates
            if (!links.some(l => l.title === cs.name)) {
              links.push({ targetId: targetPageId, title: cs.name, label: '关联主题' });
            }
          }
        }

        // Insert all links
        for (const link of links) {
          insertLink.run(
            wp.page_id,
            link.targetId ?? null,
            link.title,
            link.label,
            link.targetId ? 'resolved' : 'missing',
            now,
            now,
          );
          totalLinks++;
        }
      }
    });

    tx();

    const response: ApiResponse<BackfillResult> = {
      data: { pagesProcessed: wikiPages.length, linksInserted: totalLinks },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db?.close();
  }
}
