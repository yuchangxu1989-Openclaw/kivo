import { WikiRepository } from './db/wiki-repository.js';
import { SpaceManager } from './organization/space-manager.js';
import type { WikiEntryRecord, WikiLinkRecord } from './types.js';
import { slugify } from './admission-pipeline.js';

export interface WikiAggregationRequest {
  slug: string;
  title?: string;
  spaceId?: string;
}

export interface WikiAggregateSource {
  id: string;
  title: string;
  type: 'research' | 'material';
  excerpt: string;
}

export interface WikiAggregationResult {
  page: WikiEntryRecord;
  slug: string;
  sources: WikiAggregateSource[];
  links: WikiLinkRecord[];
}

export interface WikiAggregationEngineOptions {
  repository: WikiRepository;
}

export class WikiAggregationEngine {
  private readonly repository: WikiRepository;
  private readonly spaceManager: SpaceManager;

  constructor(options: WikiAggregationEngineOptions) {
    this.repository = options.repository;
    this.spaceManager = new SpaceManager(this.repository);
  }

  aggregate(request: WikiAggregationRequest): WikiAggregationResult {
    const normalizedSlug = slugify(request.slug || request.title || 'wiki-page');
    const space = request.spaceId
      ? this.repository.findById(request.spaceId)
      : this.spaceManager.ensureDefaultSpace();
    if (!space || space.type !== 'wiki_space') {
      throw new Error(`Wiki space not found: ${request.spaceId ?? 'default'}`);
    }

    const candidates = this.collectSourcePages(space.id, normalizedSlug);
    if (candidates.length === 0) {
      throw new Error(`No wiki sources found for slug: ${normalizedSlug}`);
    }

    const aggregateTitle = request.title?.trim() || candidates[0].title;
    const compiled = compileAggregate(candidates, aggregateTitle, normalizedSlug);
    const existing = this.findAggregatePage(space.id, normalizedSlug);

    const page = existing
      ? this.repository.updatePage(existing.id, {
          title: compiled.title,
          content: compiled.content,
          summary: compiled.summary,
          tags: compiled.tags,
          status: 'active',
          metadata: compiled.metadata,
        })
      : this.createAggregatePage(space.id, compiled);

    const links = Array.from(new Map(candidates.map((candidate) => [
      `${candidate.title}:${candidate.id}`,
      {
        targetPageId: candidate.id,
        targetTitle: candidate.title === compiled.title ? `${candidate.title} (${candidate.id.slice(0, 8)})` : candidate.title,
        label: 'source',
        status: 'resolved' as const,
      },
    ])).values());
    this.repository.replaceLinks(page.id, links);

    return {
      page: this.repository.findById(page.id)!,
      slug: normalizedSlug,
      sources: candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        type: sourceKind(candidate),
        excerpt: buildExcerpt(candidate.content),
      })),
      links: links.map((link) => ({
        sourcePageId: page.id,
        targetPageId: link.targetPageId,
        targetTitle: link.targetTitle,
        label: link.label,
        status: link.status,
        createdAt: page.updatedAt,
        updatedAt: page.updatedAt,
      })),
    };
  }

  private collectSourcePages(spaceId: string, slug: string): WikiEntryRecord[] {
    return this.repository
      .listAllPages()
      .filter((page) => this.repository.getSpaceIdForNode(page.id) === spaceId)
      .filter((page) => page.metadata.extra?.aggregateRole !== 'aggregate')
      .filter((page) => matchesSlug(page, slug))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  private findAggregatePage(spaceId: string, slug: string): WikiEntryRecord | null {
    return this.repository
      .listAllPages()
      .find((page) =>
        this.repository.getSpaceIdForNode(page.id) === spaceId &&
        page.metadata.extra?.aggregateRole === 'aggregate' &&
        page.metadata.extra?.slug === slug,
      ) ?? null;
  }

  private createAggregatePage(spaceId: string, compiled: ReturnType<typeof compileAggregate>): WikiEntryRecord {
    const placeholder = this.repository.createPage({
      title: compiled.title,
      content: '聚合初始化中',
      parentId: spaceId,
      summary: compiled.summary,
      tags: compiled.tags,
      metadata: compiled.metadata,
    });
    return this.repository.updatePage(placeholder.id, {
      title: compiled.title,
      content: compiled.content,
      summary: compiled.summary,
      tags: compiled.tags,
      metadata: compiled.metadata,
      status: 'active',
    });
  }
}

function compileAggregate(pages: WikiEntryRecord[], title: string, slug: string) {
  const researchPages = pages.filter((page) => sourceKind(page) === 'research');
  const materialPages = pages.filter((page) => sourceKind(page) === 'material');
  const summary = buildAggregateSummary(pages, title);
  const sourceRefs = pages.map((page) => ({
    label: page.title,
    uri: page.metadata.source?.uri,
    pageId: page.id,
  }));

  const content = [
    `# ${title}`,
    '',
    '## 聚合摘要',
    summary,
    '',
    '## 调研结论',
    ...(researchPages.length > 0
      ? researchPages.map((page) => `### ${page.title}\n${buildExcerpt(page.content)}`)
      : ['暂无 adopted 调研报告来源。']),
    '',
    '## 材料知识',
    ...(materialPages.length > 0
      ? materialPages.map((page) => `### ${page.title}\n${buildExcerpt(page.content)}`)
      : ['暂无同主题材料页面。']),
    '',
    '## 来源溯源',
    ...pages.map((page, index) => `${index + 1}. ${page.title} (${page.id})`),
  ].join('\n');

  return {
    title,
    content,
    summary,
    tags: Array.from(new Set([slug, ...pages.flatMap((page) => page.tags).slice(0, 12)])).filter(Boolean),
    metadata: {
      source: {
        type: 'research' as const,
        uri: `aggregate:${slug}`,
        collectedAt: new Date().toISOString(),
      },
      summary,
      extra: {
        slug,
        aggregateSlug: slug,
        aggregateRole: 'aggregate',
        knowledgeType: 'aggregated_wiki_page',
        sourcePageIds: pages.map((page) => page.id),
        sourceRefs,
      },
    },
  };
}

function buildAggregateSummary(pages: WikiEntryRecord[], title: string): string {
  const sourceKinds = Array.from(new Set(pages.map((page) => sourceKind(page))));
  return `${title} 聚合了 ${pages.length} 份来源（${sourceKinds.join(' + ')}），保留调研结论、材料片段和版本历史。`;
}

function sourceKind(page: WikiEntryRecord): 'research' | 'material' {
  return page.metadata.source?.type === 'research' ? 'research' : 'material';
}

function matchesSlug(page: WikiEntryRecord, slug: string): boolean {
  const metadataSlug = String(page.metadata.extra?.aggregateSlug ?? page.metadata.extra?.slug ?? '').trim();
  if (metadataSlug === slug) return true;
  const titleSlug = slugify(page.title);
  if (titleSlug === slug) return true;
  return page.tags.some((tag) => slugify(tag) === slug);
}

function buildExcerpt(content: string): string {
  const compact = content
    .replace(/^#+\s*/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
  return compact.slice(0, 260);
}
