/**
 * FR-1 AC-1.3, AC-1.4, NFR-5
 * Research collection: turn agent-produced research artifacts into wiki drafts.
 */

import { buildDraft } from './url-collector.js';
import type { CollectorContext, ResearchCollectInput, WikiCollectionResult } from '../types.js';

export class ResearchCollector {
  async collect(input: ResearchCollectInput, context: CollectorContext): Promise<WikiCollectionResult> {
    const startedAt = Date.now();
    const normalized = normalizeResearchReport(input);
    const draft = await buildDraft(
      {
        title: input.title,
        content: normalized,
        spaceId: input.spaceId,
        source: {
          type: 'research',
          uri: input.sourceUri,
          collectedAt: (context.now ?? new Date()).toISOString(),
        },
      },
      context,
    );
    return {
      draft,
      durationMs: Date.now() - startedAt,
    };
  }
}

function normalizeResearchReport(input: ResearchCollectInput): string {
  const headingBlock = input.sectionHints && input.sectionHints.length > 0
    ? input.sectionHints.map((section) => `## ${section}`).join('\n')
    : '';
  return [`# ${input.title}`, headingBlock, input.report].filter(Boolean).join('\n\n');
}
