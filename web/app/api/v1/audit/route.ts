/**
 * GET /api/v1/audit
 * Basic read-only audit entry projection for FR-Z08 AC3.
 */

import { queryOperationLogs, type OperationEventType } from '@/lib/operation-log-db';
import type { ApiResponse } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AuditAction =
  | 'knowledge:lifecycle'
  | 'document:import'
  | 'research:complete'
  | 'governance:run'
  | 'vectorization:batch';

interface AuditEntryDTO {
  id: string;
  action: AuditAction;
  title: string;
  detail: string;
  actor: string;
  targetType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const ACTION_BY_EVENT: Record<OperationEventType, AuditAction> = {
  knowledge_change: 'knowledge:lifecycle',
  document_import: 'document:import',
  research_complete: 'research:complete',
  governance_run: 'governance:run',
  vectorization_batch: 'vectorization:batch',
};

const TARGET_BY_EVENT: Record<OperationEventType, string> = {
  knowledge_change: 'knowledge',
  document_import: 'material',
  research_complete: 'research',
  governance_run: 'governance',
  vectorization_batch: 'embedding',
};

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') || '100'), 200);
  const offset = Math.max(Number(searchParams.get('offset') || '0'), 0);
  const eventType = searchParams.get('eventType') as OperationEventType | 'all' | null;
  const result = queryOperationLogs({ event_type: eventType ?? 'all', limit, offset });

  const entries: AuditEntryDTO[] = result.items.map((item) => {
    const metadata = parseMetadata(item.metadata_json);
    const actor = typeof metadata.actor === 'string' ? metadata.actor : 'system';
    const targetType = typeof metadata.targetType === 'string'
      ? metadata.targetType
      : TARGET_BY_EVENT[item.event_type];

    return {
      id: String(item.id),
      action: ACTION_BY_EVENT[item.event_type],
      title: item.title,
      detail: item.detail,
      actor,
      targetType,
      metadata,
      createdAt: item.created_at,
    };
  });

  const response: ApiResponse<AuditEntryDTO[]> = {
    data: entries,
    meta: {
      total: result.total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages: Math.max(1, Math.ceil(result.total / limit)),
    },
  };

  return Response.json(response);
}
