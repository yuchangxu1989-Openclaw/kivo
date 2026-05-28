import { randomUUID } from 'node:crypto';
import { AnalysisArtifactStore, type AnalysisArtifact, type AnalysisArtifactInput } from '../pipeline/analysis-artifact-store.js';
import { SQLiteAnalysisArtifactStore } from '../pipeline/sqlite-analysis-artifact-store.js';
import { WikiRepository } from './db/wiki-repository.js';
import { SpaceManager } from './organization/space-manager.js';
import type { WikiEntryRecord, WikiLinkRef, WikiPageSection } from './types.js';

export interface ResearchAdmissionInput {
  taskId: string;
  title: string;
  report: string;
  reportPath?: string;
  sourceUri?: string;
  requestedBy?: string;
  expectedTypes?: string[];
  spaceId?: string;
}

export interface ResearchAdmissionResult {
  page: WikiEntryRecord;
  artifactId: string;
  confidence: number;
  slug: string;
  admissionState: 'admitted' | 'pending_confirm';
}

type ArtifactStoreLike = Pick<AnalysisArtifactStore, 'saveArtifact'>;

interface DraftPayload {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sections: WikiPageSection[];
  links: WikiLinkRef[];
  sourceRefs: Array<{ label: string; uri?: string }>;
  slug: string;
}

export interface WikiAdmissionPipelineOptions {
  repository: WikiRepository;
  artifactStore?: ArtifactStoreLike;
  confidenceThreshold?: number;
}

export class WikiAdmissionPipeline {
  private readonly repository: WikiRepository;
  private readonly artifactStore: ArtifactStoreLike;
  private readonly confidenceThreshold: number;
  private readonly spaceManager: SpaceManager;

  constructor(options: WikiAdmissionPipelineOptions) {
    this.repository = options.repository;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
    this.spaceManager = new SpaceManager(this.repository);
    this.artifactStore = options.artifactStore ?? createArtifactStore(this.repository);
  }

  async admitResearchReport(input: ResearchAdmissionInput): Promise<ResearchAdmissionResult> {
    const space = input.spaceId
      ? this.repository.findById(input.spaceId)
      : this.spaceManager.ensureDefaultSpace();
    if (!space || space.type !== 'wiki_space') {
      throw new Error(`Wiki space not found: ${input.spaceId ?? 'default'}`);
    }

    const draft = buildDraft(input);
    const confidence = scoreDraft(input.report, draft);
    const admissionState = confidence >= this.confidenceThreshold ? 'admitted' : 'pending_confirm';
    const pageStatus = admissionState === 'admitted' ? 'active' : 'draft';

    const page = this.repository.createPage({
      title: draft.title,
      content: draft.content,
      parentId: space.id,
      summary: draft.summary,
      tags: draft.tags,
      metadata: {
        source: {
          type: 'research',
          uri: input.sourceUri ?? input.reportPath ?? `research:${input.taskId}`,
          collectedAt: new Date().toISOString(),
        },
        summary: draft.summary,
        sections: draft.sections,
        links: draft.links,
        extra: {
          slug: draft.slug,
          aggregateSlug: draft.slug,
          admissionState,
          confidence,
          researchTaskId: input.taskId,
          requestedBy: input.requestedBy ?? 'unknown',
          knowledgeType: 'research_report',
          sourceRefs: draft.sourceRefs,
        },
      },
    });

    const storedPage = this.repository.updatePage(page.id, {
      status: pageStatus,
      metadata: {
        ...page.metadata,
        source: {
          type: 'research',
          uri: input.sourceUri ?? input.reportPath ?? `research:${input.taskId}`,
          collectedAt: new Date().toISOString(),
        },
        summary: draft.summary,
        sections: draft.sections,
        links: draft.links,
        extra: {
          ...(page.metadata.extra ?? {}),
          slug: draft.slug,
          aggregateSlug: draft.slug,
          admissionState,
          confidence,
          researchTaskId: input.taskId,
          requestedBy: input.requestedBy ?? 'unknown',
          knowledgeType: 'research_report',
          sourceRefs: draft.sourceRefs,
        },
      },
    });

    this.repository.replaceLinks(storedPage.id, draft.links.map((link) => ({
      targetPageId: link.targetPageId ?? null,
      targetTitle: link.targetTitle,
      label: link.label,
      status: link.status,
    })));

    const artifact = await this.artifactStore.saveArtifact(buildArtifactInput(input, draft, confidence, storedPage.id));
    return {
      page: storedPage,
      artifactId: artifact.id,
      confidence,
      slug: draft.slug,
      admissionState,
    };
  }
}

function createArtifactStore(repository: WikiRepository): ArtifactStoreLike {
  const candidateDb = repository.db as { prepare?: unknown } | undefined;
  if (candidateDb?.prepare) {
    return new SQLiteAnalysisArtifactStore({ db: repository.db });
  }
  return new AnalysisArtifactStore();
}

function buildDraft(input: ResearchAdmissionInput): DraftPayload {
  const raw = input.report.trim();
  const title = input.title.trim() || '未命名调研报告';
  const slug = slugify(title);
  const lines = raw.split('\n').map((line) => line.trimEnd());
  const sections = parseSections(lines);
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((item) => item.replace(/^#+\s*/gm, '').trim())
    .filter(Boolean);
  const summary = paragraphs.find((item) => item.length >= 24)?.slice(0, 180) ?? `${title} 调研报告`;
  const expectedTags = (input.expectedTypes ?? []).map((item) => item.trim()).filter(Boolean);
  const tags = dedupe([
    slug,
    ...expectedTags,
    ...sections.slice(0, 4).map((section) => slugify(section.title)),
  ]).filter(Boolean);
  const content = [
    `# ${title}`,
    '',
    raw.startsWith('#') ? raw : raw,
  ].join('\n');
  const links = extractLinks(content);
  const sourceRefs = [{
    label: input.reportPath ?? `research:${input.taskId}`,
    uri: input.sourceUri ?? input.reportPath,
  }];

  return { title, summary, content, tags, sections, links, sourceRefs, slug };
}

function scoreDraft(report: string, draft: DraftPayload): number {
  let score = 0.52;
  if (report.length >= 600) score += 0.14;
  if (report.length >= 1200) score += 0.08;
  if (draft.sections.length >= 2) score += 0.08;
  if (/##\s*(结论|摘要|关键发现|来源)/.test(report)) score += 0.08;
  if (draft.links.length > 0) score += 0.04;
  if (draft.summary.length >= 48) score += 0.04;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function buildArtifactInput(
  input: ResearchAdmissionInput,
  draft: DraftPayload,
  confidence: number,
  pageId: string,
): AnalysisArtifactInput {
  const extractedClaims = draft.sections.slice(0, 6).map((section, index) => ({
    id: `claim-${index + 1}`,
    text: section.content.slice(0, 280) || section.title,
    confidence,
    type: 'fact' as const,
  }));
  const conceptCandidates = draft.tags.map((tag, index) => ({
    id: `concept-${index + 1}`,
    label: tag,
    confidence,
    payload: { pageId },
  }));
  const reviewCandidates = confidence >= 0.7
    ? []
    : [{
        id: randomUUID(),
        field: 'conceptCandidates' as const,
        candidateId: conceptCandidates[0]?.id ?? 'concept-1',
        reason: 'Low-confidence research admission should be manually confirmed before full aggregation.',
        confidence,
      }];
  return {
    sourceId: pageId,
    pipelineId: `wiki-admission:${input.taskId}`,
    extractedClaims,
    entityCandidates: [],
    conceptCandidates,
    linkCandidates: draft.links.map((link, index) => ({
      id: `link-${index + 1}`,
      label: link.targetTitle,
      confidence: link.status === 'resolved' ? confidence : Math.max(0.4, confidence - 0.2),
      payload: { label: link.label, targetPageId: link.targetPageId ?? null },
    })),
    conflictCandidates: [],
    gapCandidates: [],
    reviewCandidates,
    recommendedResearchQueries: [],
    confidence,
  };
}

function parseSections(lines: string[]): WikiPageSection[] {
  const sections: WikiPageSection[] = [];
  let current: WikiPageSection | null = null;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      if (current) sections.push(current);
      current = {
        title: heading[2].trim(),
        level: heading[1].length,
        content: '',
      };
      continue;
    }
    if (!current) continue;
    current.content = [current.content, line].filter(Boolean).join('\n').trim();
  }

  if (current) sections.push(current);
  if (sections.length > 0) return sections;

  return [{
    title: '正文',
    level: 1,
    content: lines.join('\n').trim(),
  }];
}

function extractLinks(content: string): WikiLinkRef[] {
  const links: WikiLinkRef[] = [];
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const match of matches) {
    const targetTitle = match[1].trim();
    if (!targetTitle) continue;
    links.push({
      label: 'reference',
      targetTitle,
      status: 'missing',
    });
  }
  return links;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'wiki-page';
}
