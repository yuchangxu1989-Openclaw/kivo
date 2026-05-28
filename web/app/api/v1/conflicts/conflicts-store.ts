type ConflictStatus = 'unresolved' | 'resolved';

export interface ConflictRecord {
  id: string;
  status: ConflictStatus;
  version: number;
  summaryA: string;
  summaryB: string;
  conflictType: string;
  detectedAt: string;
}

const CONFLICTS: ConflictRecord[] = [
  {
    id: 'conflict-001',
    status: 'unresolved',
    version: 1,
    summaryA: '旧规则说明',
    summaryB: '新规则说明',
    conflictType: 'policy_overlap',
    detectedAt: '2026-05-24T00:00:00.000Z',
  },
  {
    id: 'conflict-002',
    status: 'unresolved',
    version: 1,
    summaryA: '分类口径 A',
    summaryB: '分类口径 B',
    conflictType: 'taxonomy_overlap',
    detectedAt: '2026-05-24T00:00:00.000Z',
  },
  {
    id: 'conflict-003',
    status: 'resolved',
    version: 2,
    summaryA: '历史口径',
    summaryB: '收敛口径',
    conflictType: 'resolved_policy',
    detectedAt: '2026-05-23T00:00:00.000Z',
  },
];

export function listConflicts(status: string | null): ConflictRecord[] {
  if (!status || status === 'unresolved') return CONFLICTS.filter((item) => item.status === 'unresolved');
  if (status === 'resolved') return CONFLICTS.filter((item) => item.status === 'resolved');
  if (status === 'all') return [...CONFLICTS];
  return [];
}

export function findConflict(id: string): ConflictRecord | undefined {
  return CONFLICTS.find((item) => item.id === id);
}

export function resolveConflict(id: string): ConflictRecord | undefined {
  const conflict = findConflict(id);
  if (!conflict || conflict.status === 'resolved') return undefined;
  conflict.status = 'resolved';
  conflict.version += 1;
  return conflict;
}
