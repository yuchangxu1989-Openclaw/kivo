import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const adoptResearchTaskMock = vi.fn();
const confirmResearchReportReferenceMock = vi.fn();

vi.mock('@/lib/research-db', () => ({
  adoptResearchTask: (...args: unknown[]) => adoptResearchTaskMock(...args),
  confirmResearchReportReference: (...args: unknown[]) => confirmResearchReportReferenceMock(...args),
}));

function makeRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), { method: 'POST' });
}

describe('POST /api/v1/research/reports/[reportId]/reference', () => {
  it('marks a legacy task report through the real route module', async () => {
    confirmResearchReportReferenceMock.mockResolvedValue(null);
    adoptResearchTaskMock.mockReturnValue({ autoResearchPaused: false, tasks: [] });
    const route = await import('../../app/api/v1/research/reports/[reportId]/reference/route');

    const res = await route.POST(makeRequest('/api/v1/research/reports/task-1-report/reference'), {
      params: Promise.resolve({ reportId: 'task-1-report' }),
    });

    expect(res.status).toBe(200);
    expect(adoptResearchTaskMock).toHaveBeenCalledWith('task-1');
  });

  it('returns 404 when the report cannot be confirmed', async () => {
    confirmResearchReportReferenceMock.mockResolvedValue(null);
    adoptResearchTaskMock.mockReturnValue(null);
    const route = await import('../../app/api/v1/research/reports/[reportId]/reference/route');

    const res = await route.POST(makeRequest('/api/v1/research/reports/missing-report/reference'), {
      params: Promise.resolve({ reportId: 'missing-report' }),
    });

    expect(res.status).toBe(404);
  });
});
