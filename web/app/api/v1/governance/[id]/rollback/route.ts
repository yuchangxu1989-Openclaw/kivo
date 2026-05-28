import { NextRequest, NextResponse } from 'next/server';
import { IntentGovernanceEngine } from '@self-evolving-harness/kivo';
import { badRequest, serverError } from '@/lib/errors';
import { WebGovernanceStore } from '@/lib/governance-store';

export async function POST(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const store = new WebGovernanceStore();
  try {
    const { id } = await props.params;
    if (!id) return badRequest('operation id is required');

    const engine = new IntentGovernanceEngine(store, {
      dbPath: process.env.KIVO_DB_PATH,
      cwd: process.cwd(),
    });

    const rolledBack = await engine.rollbackGovernance(id);
    if (!rolledBack) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: `Governance snapshot ${id} not found` } },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: { operationId: id, rolledBack } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    store.close();
  }
}
