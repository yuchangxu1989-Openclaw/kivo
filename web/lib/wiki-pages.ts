import { WikiAggregationEngine, WikiAdmissionPipeline, slugify } from '@kivo/wiki/index';
import type { WikiEntryRecord, WikiLinkRecord, WikiPageVersionRecord } from '@kivo/wiki/index';
import { getWikiRepository } from '@/lib/wiki-engine';

export interface WikiPageDetailView {
  page: WikiEntryRecord;
  slug: string;
  versions: WikiPageVersionRecord[];
  outgoingLinks: WikiLinkRecord[];
  backlinks: WikiLinkRecord[];
  sourcePages: WikiEntryRecord[];
}

export function resolveSpaceId(spaceToken?: string | null): string | undefined {
  if (!spaceToken) return undefined;
  const repo = getWikiRepository();
  const normalized = slugify(spaceToken);
  const matched = repo.listSpaces().find((space) => space.id === spaceToken || slugify(space.title) === normalized);
  return matched?.id;
}

export function runWikiAdmission(input: {
  taskId: string;
  title: string;
  report: string;
  reportPath?: string;
  sourceUri?: string;
  requestedBy?: string;
  expectedTypes?: string[];
  spaceId?: string;
}) {
  const repo = getWikiRepository();
  const pipeline = new WikiAdmissionPipeline({ repository: repo });
  return pipeline.admitResearchReport(input);
}

export function aggregateWikiPage(input: { slug: string; title?: string; space?: string | null }) {
  const repo = getWikiRepository();
  const engine = new WikiAggregationEngine({ repository: repo });
  return engine.aggregate({
    slug: input.slug,
    title: input.title,
    spaceId: resolveSpaceId(input.space),
  });
}

export function getWikiPageDetailBySlug(slug: string, space?: string | null): WikiPageDetailView | null {
  const repo = getWikiRepository();
  const normalizedSlug = slugify(slug);
  const spaceId = resolveSpaceId(space);
  const page = repo.listAllPages().find((candidate) => {
    if (spaceId && repo.getSpaceIdForNode(candidate.id) !== spaceId) return false;
    const candidateSlug = String(candidate.metadata.extra?.slug ?? candidate.metadata.extra?.aggregateSlug ?? '');
    return candidateSlug === normalizedSlug;
  });
  if (!page) return null;

  const versions = repo.listPageVersions(page.id);
  const outgoingLinks = listOutgoingLinks(page.id);
  const backlinks = repo.listBacklinks(page.id);
  const sourceIds = Array.isArray(page.metadata.extra?.sourcePageIds)
    ? page.metadata.extra?.sourcePageIds.filter((item): item is string => typeof item === 'string')
    : [];
  const sourcePages = sourceIds
    .map((id) => repo.findById(id))
    .filter((item): item is WikiEntryRecord => Boolean(item));

  return {
    page,
    slug: normalizedSlug,
    versions,
    outgoingLinks,
    backlinks,
    sourcePages,
  };
}

function listOutgoingLinks(pageId: string): WikiLinkRecord[] {
  const repo = getWikiRepository();
  const rows = repo.db.prepare(`
    SELECT source_page_id, target_page_id, target_title, label, status, created_at, updated_at
    FROM wiki_links
    WHERE source_page_id = ?
    ORDER BY updated_at DESC
  `).all(pageId) as Array<{
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
