import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { deleteIntent, getIntentApiById, normalizeIntentLines, upsertIntent } from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

export async function GET(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    const item = getIntentApiById(id);
    if (!item) return notFound(`Intent not found: ${id}`);
    return NextResponse.json({ data: item } satisfies ApiResponse<typeof item>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    if (!getIntentApiById(id)) return notFound(`Intent not found: ${id}`);
    const body = await request.json() as Record<string, unknown>;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (!name || !description) return badRequest('name and description are required');
    await upsertIntent({
      id,
      name,
      description,
      why: typeof body?.why === 'string' ? body.why.trim() : undefined,
      similarSentences: normalizeIntentLines(body?.similarSentences),
      confidence: typeof body?.confidence === 'number' ? body.confidence : undefined,
      sourceSessionId: typeof body?.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      sourceMessageId: typeof body?.sourceMessageId === 'string' ? body.sourceMessageId : undefined,
    });
    return NextResponse.json({ data: getIntentApiById(id) } satisfies ApiResponse<ReturnType<typeof getIntentApiById>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    const deleted = deleteIntent(id);
    if (!deleted) return notFound(`Intent not found: ${id}`);
    return NextResponse.json({ data: { id, deleted: true } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
