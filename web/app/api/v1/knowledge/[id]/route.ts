/**
 * GET /api/v1/knowledge/:id
 * Knowledge entry detail with relations and version history (FR-G04)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getKivo, getRepository } from '@/lib/kivo-engine';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { getKnowledgeHistory } from '@/lib/knowledge-history';
import { getKnowledgeEntryFields, setEntrySimilarSentences, setEntryWhy } from '@/lib/paginated-queries';
import type { ApiResponse } from '@/types';

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}


function normalizeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasField(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

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
    const entryAny = entry as unknown as Record<string, unknown>;
    const entryMeta = entryAny.metadata as Record<string, unknown> | undefined;
    const domainData = entryMeta?.domainData as Record<string, unknown> | undefined;
    const dbEntry = getKnowledgeEntryFields(id);

    const response: ApiResponse<Record<string, unknown>> = {
      data: {
        ...entry,
        why: dbEntry?.why ?? entryAny.why,
        similarSentences: dbEntry?.similarSentences ?? entry.similarSentences,
        sourceLabel: `${entry.source.type} · ${entry.source.reference}`,
        sourceDocument: domainData?.sourceDocument ?? (entry.source.type === 'document' ? entry.source.reference : undefined),
        sourceLocation: domainData?.sourceLocation ?? undefined,
        relations,
        versions,
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const kivo = await getKivo();
    const entry = await kivo.getEntry(id);
    if (!entry) return notFound(`Knowledge entry not found: ${id}`);

    const body = await request.json() as Record<string, unknown>;
    const metadata = hasField(body, 'metadata') && body.metadata && typeof body.metadata === 'object'
      ? body.metadata as Record<string, unknown>
      : undefined;
    if (metadata && hasField(metadata, 'tags')) {
      const tags = normalizeTags(metadata.tags);
      await getRepository().then((repo) => repo.save({ ...entry, tags, metadata: { ...entry.metadata, ...metadata }, updatedAt: new Date() }, { skipQualityGate: true, skipDedup: true }));
    }
    if (hasField(body, 'why')) {
      if (typeof body.why !== 'string') return badRequest('why must be a string');
      setEntryWhy(id, body.why);
    }
    if (hasField(body, 'similarSentences')) {
      if (!Array.isArray(body.similarSentences)) return badRequest('similarSentences must be an array');
      setEntrySimilarSentences(id, normalizeLines(body.similarSentences));
    }
    const updated = await kivo.getEntry(id);
    const updatedFields = getKnowledgeEntryFields(id);
    return NextResponse.json({ data: { ...(updated ?? entry), ...updatedFields } } satisfies ApiResponse<Record<string, unknown>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
