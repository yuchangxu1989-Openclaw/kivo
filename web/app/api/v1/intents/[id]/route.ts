import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { getIntentApiById, upsertIntent, deleteIntent } from '@/lib/intent-store';
import { normalizeIntentLines } from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const item = getIntentApiById(id);
    if (!item) {
      return notFound(`Intent not found: ${id}`);
    }
    return NextResponse.json({ data: item } satisfies ApiResponse<typeof item>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const why = typeof body?.why === 'string' ? body.why.trim() : undefined;
    const similarSentences = normalizeIntentLines(body?.similarSentences);

    if (!name || !description) {
      return badRequest('name and description are required');
    }
    if (!getIntentApiById(id)) {
      return notFound(`Intent not found: ${id}`);
    }

    const data = await upsertIntent({ id, name, description, why, similarSentences });
    if (!data) {
      return notFound(`Intent not found: ${id}`);
    }

    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const data = deleteIntent(id);
    if (!data) {
      return notFound(`Intent not found: ${id}`);
    }
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
