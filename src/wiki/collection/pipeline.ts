/**
 * FR-1 AC-1.1~1.7, FR-2 AC-2.1~2.4, NFR-1, NFR-5
 * Unified collection entrypoint with draft generation, confirmation, embedding, and link sync.
 */

import { DEFAULT_TIMEOUT_MS, UrlCollector, withTimeout } from './url-collector.js';
import { DocCollector } from './doc-collector.js';
import { ResearchCollector } from './research-collector.js';
import { MultimodalRouter } from './multimodal-router.js';
import { SpaceManager } from '../organization/space-manager.js';
import { LinkResolver } from '../organization/link-resolver.js';
import { WikiRepository } from '../db/wiki-repository.js';
import type { MultimodalRouterConfig } from './multimodal-router.js';
import type {
  CollectorContext,
  ConfirmDraftInput,
  DocumentCollectInput,
  MultimodalCollectInput,
  MultimodalRouteResult,
  ResearchCollectInput,
  UrlCollectInput,
  WikiCollectionResult,
  WikiDraft,
  WikiEntryRecord,
  WikiNodeMetadata,
} from '../types.js';

export class WikiCollectionPipeline {
  private readonly urlCollector = new UrlCollector();
  private readonly docCollector = new DocCollector();
  private readonly researchCollector = new ResearchCollector();
  private readonly multimodalRouter: MultimodalRouter;
  private readonly spaceManager: SpaceManager;
  private readonly linkResolver: LinkResolver;

  constructor(
    private readonly repository: WikiRepository,
    private readonly context: CollectorContext,
    multimodalConfig?: MultimodalRouterConfig,
  ) {
    this.spaceManager = new SpaceManager(repository);
    this.linkResolver = new LinkResolver(repository);
    this.multimodalRouter = new MultimodalRouter(multimodalConfig);
  }

  collectFromUrl(input: UrlCollectInput): Promise<WikiCollectionResult> {
    return withTimeout(
      () => this.collectUrlWithExistingDiff(input),
      input.timeoutMs ?? this.context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Wiki URL collection pipeline',
    );
  }

  collectFromDocument(input: DocumentCollectInput): Promise<WikiCollectionResult> {
    return withTimeout(
      () => this.docCollector.collect(input, this.context),
      this.context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Wiki document collection pipeline',
    );
  }

  collectFromResearch(input: ResearchCollectInput): Promise<WikiCollectionResult> {
    return withTimeout(
      () => this.researchCollector.collect(input, this.context),
      this.context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Wiki research collection pipeline',
    );
  }

  collectFromMultimodal(input: MultimodalCollectInput): Promise<MultimodalRouteResult> {
    return withTimeout(
      () => this.multimodalRouter.route(input, this.context),
      input.timeoutMs ?? this.context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Wiki multimodal collection pipeline',
    );
  }

  async confirmDraft(input: ConfirmDraftInput): Promise<WikiEntryRecord> {
    const draft = applyDraftEdits(input.draft, input);
    const warnings = [...draft.warnings];
    let embedding: number[] | null = null;
    if (this.context.embedder) {
      try {
        embedding = await withTimeout(
          (signal) => this.context.embedder!.embed(`${draft.title}\n${draft.summary}\n${draft.content}`, { signal }),
          this.context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          'Wiki embedding generation',
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`Embedding unavailable; page saved without semantic vector: ${reason}`);
      }
    }
    const metadata: WikiNodeMetadata = {
      source: draft.source,
      tags: draft.tags,
      summary: draft.summary,
      links: draft.links,
      sections: draft.sections,
      embeddingStatus: embedding ? 'ready' : this.context.embedder ? 'failed' : 'pending',
      syncStatus: 'ok' as const,
      warnings,
      extra: {
        draftId: draft.id,
        llmOutput: draft.llmOutput,
      },
    };
    const page = input.replacePageId
      ? this.repository.updatePage(input.replacePageId, {
          title: draft.title,
          content: draft.content,
          parentId: input.parentId,
          summary: draft.summary,
          tags: draft.tags,
          embedding,
          metadata,
          status: 'active',
        })
      : this.repository.createPage({
          title: draft.title,
          content: draft.content,
          parentId: input.parentId,
          summary: draft.summary,
          tags: draft.tags,
          embedding,
          metadata,
        });
    this.linkResolver.syncPageLinks(page.id);
    return page;
  }

  ensureDefaultSpace(): WikiEntryRecord {
    return this.spaceManager.ensureDefaultSpace();
  }

  private async collectUrlWithExistingDiff(input: UrlCollectInput): Promise<WikiCollectionResult> {
    const result = await this.urlCollector.collect(input, this.context);
    const existing = this.repository.findPageBySourceUri(input.url, input.spaceId);
    if (!existing) {
      return result;
    }
    const diff = summarizeContentDiff(existing.content, result.draft.content);
    result.draft.warnings.push(`Existing page found for URL ${input.url}. Review diff before overwrite.`);
    result.draft.llmOutput.previousPage = {
      id: existing.id,
      title: existing.title,
      updatedAt: existing.updatedAt,
    };
    result.draft.llmOutput.diffSummary = diff;
    return result;
  }
}

function applyDraftEdits(draft: WikiDraft, input: ConfirmDraftInput): WikiDraft {
  return {
    ...draft,
    title: input.title ?? draft.title,
    summary: input.summary ?? draft.summary,
    content: input.content ?? draft.content,
    tags: input.tags ?? draft.tags,
    status: 'confirmed',
  };
}

function summarizeContentDiff(previousContent: string, nextContent: string): { added: string[]; removed: string[] } {
  const previousLines = new Set(previousContent.split('\n').map((line) => line.trim()).filter(Boolean));
  const nextLines = new Set(nextContent.split('\n').map((line) => line.trim()).filter(Boolean));
  const added = Array.from(nextLines).filter((line) => !previousLines.has(line)).slice(0, 20);
  const removed = Array.from(previousLines).filter((line) => !nextLines.has(line)).slice(0, 20);
  return { added, removed };
}
