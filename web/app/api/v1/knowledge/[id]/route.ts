/**
 * GET /api/v1/knowledge/:id
 * Knowledge entry detail with relations and version history (FR-G04)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { notFound, serverError } from '@/lib/errors';
import { getKnowledgeHistory } from '@/lib/knowledge-history';
import type { ApiResponse } from '@/types';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const kivo = await getKivo();
    const repo = await getRepository();

    const entry = await kivo.getEntry(id);
    if (!entry) {
      return notFound(`Knowledge entry not found: ${id}`);
    }

    const allEntries = await repo.findAll();
    const relations = allEntries
      .filter((candidate) => candidate.id !== id)
      .filter((candidate) => {
        const titleOverlap = candidate.title === entry.title;
        const domainOverlap = candidate.domain && entry.domain && candidate.domain === entry.domain;
        const tagOverlap = candidate.tags.some((tag) => entry.tags.includes(tag));
        return titleOverlap || domainOverlap || tagOverlap;
      })
      .slice(0, 10)
      .map((candidate) => ({
        type: candidate.domain === entry.domain ? 'same-domain' : 'related',
        targetId: candidate.id,
        targetContent: candidate.summary || candidate.content.slice(0, 100),
      }));

    const versions = getKnowledgeHistory(entry);

    // Flatten response: spread entry fields + relations + versions
    const response: ApiResponse<Record<string, unknown>> = {
      data: {
        ...entry,
        sourceLabel: `${entry.source.type} · ${entry.source.reference}`,
        relations,
        versions,
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
