import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import {
  deleteIntent,
  getIntentApiById,
  getIntentData,
  upsertIntent,
} from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

function normalizeLines(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const item = getIntentApiById(id);
      if (!item) {
        return notFound(`Intent not found: ${id}`);
      }
      return NextResponse.json({ data: item } satisfies ApiResponse<typeof item>);
    }

    const data = getIntentData();
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const why = typeof body?.why === 'string' ? body.why.trim() : undefined;
    const similarSentences = normalizeLines(body?.similarSentences);

    if (!name || !description) {
      return badRequest('name and description are required');
    }

    const data = await upsertIntent({ name, description, why, similarSentences });
    if (!data) {
      return serverError('Failed to create intent');
    }
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const why = typeof body?.why === 'string' ? body.why.trim() : undefined;
    const similarSentences = normalizeLines(body?.similarSentences);

    if (!id || !name || !description) {
      return badRequest('id, name and description are required');
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

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return badRequest('id is required');
    }

    const data = deleteIntent(id);
    if (!data) {
      return notFound(`Intent not found: ${id}`);
    }

    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
