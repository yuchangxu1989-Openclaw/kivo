/**
 * GET /api/wiki/pages/[id]/links — related-knowledge listing for a wiki_page.
 *
 * Fan-out:
 *   1. wiki_links table (markdown-style forward + backlinks written by
 *      src/wiki/compiler/wiki-page-compiler.ts at L786).
 *   2. graph_edges table (association_type produced by CLI graph-build), filtered
 *      to edges where this entry sits on either end.
 *
 * Returns groups keyed by relation label/type so the wiki detail panel can render
 * "按关系类型分组展示" (FR-B AC2).
 *
 * Empty path: 200 with empty groups so the UI distinguishes "未查询" from "0 条".
 */
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import Database from 'better-sqlite3';
import { getWikiRepository } from '@/lib/wiki-engine';
import {
  getGraphEdges,
  getGraphNodes,
  graphTablesExist,
} from '@/lib/graph-db';
import { notFound, serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';

interface RelatedItem {
  id: string;
  title: string;
  summary: string;
  knowledgeType: string;
  /** Direction relative to the queried page: outgoing | incoming. */
  direction: 'outgoing' | 'incoming';
  /** Where the relation came from. */
  origin: 'wiki_links' | 'graph_edges';
  /** Marker for unresolved wiki_links (target page does not yet exist). */
  placeholder?: { reason: string };
  weight?: number;
}

interface RelatedGroup {
  type: string;
  label: string;
  items: RelatedItem[];
}

interface RelatedResponse {
  pageId: string;
  total: number;
  groups: RelatedGroup[];
}

/**
 * Read-only wiki_links access lives in the web layer to avoid touching src/.
 * The same kivo.db file backs WikiRepository + graph-db; better-sqlite3 supports
 * multiple connections, so a separate readonly handle is safe.
 */
let wikiLinksDb: Database.Database | null = null;
function getWikiLinksDb(): Database.Database {
  if (!wikiLinksDb) {
    const dbPath = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
    wikiLinksDb = new Database(dbPath, { readonly: true });
    wikiLinksDb.pragma('journal_mode = WAL');
  }
  return wikiLinksDb;
}

interface WikiLinkRow {
  source_page_id: string;
  target_page_id: string | null;
  target_title: string;
  label: string;
  status: string;
}

function listOutgoingLinks(pageId: string): WikiLinkRow[] {
  try {
    return getWikiLinksDb()
      .prepare(
        `SELECT source_page_id, target_page_id, target_title, label, status
         FROM wiki_links
         WHERE source_page_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(pageId) as WikiLinkRow[];
  } catch {
    return [];
  }
}

function listIncomingLinks(pageId: string): WikiLinkRow[] {
  try {
    return getWikiLinksDb()
      .prepare(
        `SELECT source_page_id, target_page_id, target_title, label, status
         FROM wiki_links
         WHERE target_page_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(pageId) as WikiLinkRow[];
  } catch {
    return [];
  }
}

function summariseEntry(repo: ReturnType<typeof getWikiRepository>, id: string) {
  const node = repo.findById(id);
  if (!node) return null;
  return {
    id,
    title: node.title,
    summary: node.summary,
    knowledgeType: (node.metadata?.extra?.knowledgeType as string) || node.type,
  };
}

function relationLabel(type: string): string {
  switch (type) {
    case 'concept':
      return '概念';
    case 'example':
      return '案例';
    case 'method':
      return '方法';
    case 'question':
      return '问题';
    case 'mistake':
      return '易错点';
    case 'annotation':
      return '注解';
    case 'reference':
      return '引用';
    case 'supplements':
      return '补充';
    case 'extends':
      return '扩展';
    case 'contradicts':
      return '冲突';
    case 'cites':
      return '引文';
    case 'depends_on':
      return '依赖';
    default:
      return type;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWikiRepository();
    const page = repo.findById(id);
    if (!page || page.type !== 'wiki_page') {
      return notFound(`Page ${id} not found`);
    }

    const groupsMap = new Map<string, RelatedGroup>();
    const ensureGroup = (type: string) => {
      const key = type || 'reference';
      let group = groupsMap.get(key);
      if (!group) {
        group = { type: key, label: relationLabel(key), items: [] };
        groupsMap.set(key, group);
      }
      return group;
    };

    // 1) wiki_links — outgoing (this page → others)
    for (const link of listOutgoingLinks(id)) {
      const targetSummary = link.target_page_id
        ? summariseEntry(repo, link.target_page_id)
        : null;
      const item: RelatedItem = targetSummary
        ? {
            ...targetSummary,
            direction: 'outgoing',
            origin: 'wiki_links',
          }
        : {
            id: link.target_page_id || link.target_title,
            title: link.target_title,
            summary: '',
            knowledgeType: 'unknown',
            direction: 'outgoing',
            origin: 'wiki_links',
            placeholder: { reason: link.status || 'missing' },
          };
      ensureGroup(link.label).items.push(item);
    }

    // 2) wiki_links — incoming (others → this page)
    for (const link of listIncomingLinks(id)) {
      const sourceSummary = summariseEntry(repo, link.source_page_id);
      if (!sourceSummary) continue;
      ensureGroup(link.label).items.push({
        ...sourceSummary,
        direction: 'incoming',
        origin: 'wiki_links',
      });
    }

    // 3) graph_edges — both directions, filtered by this entry id
    if (graphTablesExist()) {
      const edges = getGraphEdges();
      const matched = edges.filter(
        (edge) => edge.source_id === id || edge.target_id === id,
      );

      if (matched.length > 0) {
        const nodeIndex = new Map(
          getGraphNodes().map((n) => [n.entry_id, n] as const),
        );

        for (const edge of matched) {
          const peerId = edge.source_id === id ? edge.target_id : edge.source_id;
          const direction: 'outgoing' | 'incoming' =
            edge.source_id === id ? 'outgoing' : 'incoming';
          const repoSummary = summariseEntry(repo, peerId);
          const graphNode = nodeIndex.get(peerId);
          const summary = repoSummary
            ? repoSummary
            : graphNode
              ? {
                  id: peerId,
                  title: graphNode.title,
                  summary: '',
                  knowledgeType: graphNode.type,
                }
              : null;
          if (!summary) continue;
          ensureGroup(edge.association_type || 'reference').items.push({
            ...summary,
            direction,
            origin: 'graph_edges',
            weight: edge.weight,
          });
        }
      }
    }

    // De-duplicate inside each group (same peer id + direction = one item).
    const groups: RelatedGroup[] = [];
    let total = 0;
    for (const group of groupsMap.values()) {
      const seen = new Set<string>();
      const deduped: RelatedItem[] = [];
      for (const item of group.items) {
        const key = `${item.id}|${item.direction}|${item.origin}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      deduped.sort((a, b) => {
        if (a.direction !== b.direction) {
          return a.direction === 'outgoing' ? -1 : 1;
        }
        return a.title.localeCompare(b.title, 'zh-Hans-CN');
      });
      total += deduped.length;
      groups.push({ ...group, items: deduped });
    }

    groups.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));

    const response: ApiResponse<RelatedResponse> = {
      data: { pageId: id, total, groups },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
