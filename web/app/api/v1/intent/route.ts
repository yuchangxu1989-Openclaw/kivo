import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { deleteIntent, getIntentApiById, getIntentData, normalizeIntentLines, upsertIntent } from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

function normalizePayload(body: Record<string, unknown>) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  return {
    id: typeof body?.id === 'string' ? body.id.trim() : undefined,
    name,
    description,
    why: typeof body?.why === 'string' ? body.why.trim() : undefined,
    similarSentences: normalizeIntentLines(body?.similarSentences),
    confidence: typeof body?.confidence === 'number' ? Math.max(0, Math.min(1, body.confidence)) : undefined,
    sourceSessionId: typeof body?.sourceSessionId === 'string' ? body.sourceSessionId.trim() : undefined,
    sourceMessageId: typeof body?.sourceMessageId === 'string' ? body.sourceMessageId.trim() : undefined,
  };
}

export async function GET() {
  try {
    return NextResponse.json({ data: getIntentData() } satisfies ApiResponse<ReturnType<typeof getIntentData>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = normalizePayload(body);
    if (!input.name || !input.description) return badRequest('name and description are required');
    const data = await upsertIntent(input);
    return NextResponse.json({ data } satisfies ApiResponse<ReturnType<typeof getIntentData>>, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = normalizePayload(body);
    if (!input.id || !input.name || !input.description) return badRequest('id, name and description are required');
    if (!getIntentApiById(input.id)) return notFound(`Intent not found: ${input.id}`);
    const data = await upsertIntent(input);
    return NextResponse.json({ data } satisfies ApiResponse<ReturnType<typeof getIntentData>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return badRequest('id is required');
    const data = deleteIntent(id);
    if (!data) return notFound(`Intent not found: ${id}`);
    return NextResponse.json({ data } satisfies ApiResponse<ReturnType<typeof getIntentData>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
