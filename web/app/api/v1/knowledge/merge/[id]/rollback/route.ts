import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeMerger } from '@self-evolving-harness/kivo';
import { badRequest, serverError } from '@/lib/errors';
import { RepositoryKnowledgeStore } from '@/lib/knowledge-store-adapter';

export async function POST(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    if (!id) return badRequest('merge id is required');

    const merger = new KnowledgeMerger({
      store: new RepositoryKnowledgeStore(),
      dbPath: process.env.KIVO_DB_PATH,
      cwd: process.cwd(),
    });

    const reversal = await merger.rollbackMerge(id);
    return NextResponse.json({ data: reversal });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
