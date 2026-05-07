import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import {
  createDictionaryEntry,
  deleteDictionaryEntry,
  getDictionaryData,
  updateDictionaryEntry,
} from '@/lib/domain-stores';
import type { DictionaryData } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

function normalizeAliases(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export async function GET() {
  try {
    const response: ApiResponse<DictionaryData> = {
      data: getDictionaryData(),
    };

    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const term = typeof body?.term === 'string' ? body.term.trim() : '';
    const definition = typeof body?.definition === 'string' ? body.definition.trim() : '';
    const scope = typeof body?.scope === 'string' && body.scope.trim() ? body.scope.trim() : '全局';
    const aliases = normalizeAliases(body?.aliases);

    if (!term || !definition) {
      return badRequest('term and definition are required');
    }

    const response: ApiResponse<DictionaryData> = {
      data: createDictionaryEntry({ term, definition, scope, aliases }),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const term = typeof body?.term === 'string' ? body.term.trim() : '';
    const definition = typeof body?.definition === 'string' ? body.definition.trim() : '';
    const scope = typeof body?.scope === 'string' && body.scope.trim() ? body.scope.trim() : '全局';
    const aliases = normalizeAliases(body?.aliases);

    if (!id || !term || !definition) {
      return badRequest('id, term, definition are required');
    }

    const updated = updateDictionaryEntry(id, { term, definition, scope, aliases });
    if (!updated) {
      return notFound(`Dictionary entry not found: ${id}`);
    }

    const response: ApiResponse<DictionaryData> = { data: updated };
    return NextResponse.json(response);
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

    const updated = deleteDictionaryEntry(id);
    if (!updated) {
      return notFound(`Dictionary entry not found: ${id}`);
    }

    const response: ApiResponse<DictionaryData> = { data: updated };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
