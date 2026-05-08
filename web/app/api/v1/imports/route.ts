import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { appendActivityEvent } from '@/lib/domain-stores';
import { getImportStore } from '@/lib/import-store';
import { extractCandidates } from '@/lib/extract-candidates';
import type { ApiResponse } from '@/types';

export interface ImportCandidate {
  id: string;
  type: 'fact' | 'decision' | 'methodology' | 'experience' | 'intent' | 'meta';
  title: string;
  content: string;
  sourceAnchor: string;
  status: 'pending' | 'confirmed' | 'rejected';
}

export interface ImportJob {
  id: string;
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  processedSegments: number;
  totalSegments: number;
  summary: string;
  createdAt: string;
  candidates: ImportCandidate[];
}

const jobs = getImportStore();

function nowLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const job = jobs.get(id);
      if (!job) {
        return notFound(`Import job not found: ${id}`);
      }
      return NextResponse.json({ data: job } satisfies ApiResponse<ImportJob>);
    }

    return NextResponse.json({ data: Array.from(jobs.values()) } satisfies ApiResponse<ImportJob[]>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const fileType = typeof body?.fileType === 'string' ? body.fileType.trim().toLowerCase() : '';
    const fileSizeMb = Number(body?.fileSizeMb ?? 0);

    if (!fileName || !fileType) {
      return badRequest('fileName and fileType are required');
    }

    if (!['md', 'markdown', 'txt', 'text', 'json'].includes(fileType)) {
      return badRequest('Unsupported file type');
    }

    if (!Number.isFinite(fileSizeMb) || fileSizeMb <= 0 || fileSizeMb > 50) {
      return badRequest('fileSizeMb must be between 0 and 50');
    }

    const content = typeof body?.content === 'string' ? body.content : '';
    if (!content.trim()) {
      return badRequest('content is required — upload document text to extract knowledge candidates');
    }
    const candidates = extractCandidates(content, fileName, fileType);

    const id = `imp-${String(jobs.size + 1).padStart(3, '0')}`;
    const totalSegments = Math.max(candidates.length, Math.ceil(fileSizeMb / 4));
    const job: ImportJob = {
      id,
      fileName,
      fileType,
      fileSizeMb,
      processedSegments: totalSegments,
      totalSegments,
      summary: `已完成 ${totalSegments} / ${totalSegments} 个分段提取，共识别 ${candidates.length} 条候选知识。`,
      createdAt: nowLabel(),
      candidates,
    };

    jobs.set(id, job);
    appendActivityEvent({
      type: 'knowledge_imported',
      label: '文档导入完成',
      summary: `文档「${fileName}」已完成提取，识别 ${job.candidates.length} 条候选知识。`,
      href: `/imports/${id}`,
      tags: ['knowledge', 'import'],
    });

    return NextResponse.json({ data: job } satisfies ApiResponse<ImportJob>, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const id = typeof body?.id === 'string' ? body.id : '';
    const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : '';
    const action = typeof body?.action === 'string' ? body.action : '';
    const bulk = body?.bulk === true;

    const job = jobs.get(id);
    if (!job) {
      return notFound(`Import job not found: ${id}`);
    }

    if (bulk && action === 'confirm-all') {
      job.candidates = job.candidates.map((item) => ({ ...item, status: 'confirmed' }));
      return NextResponse.json({ data: job } satisfies ApiResponse<ImportJob>);
    }

    if (!candidateId || !['confirm', 'reject', 'edit'].includes(action)) {
      return badRequest('candidateId and valid action are required');
    }

    const candidate = job.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      return notFound(`Candidate not found: ${candidateId}`);
    }

    if (action === 'confirm') candidate.status = 'confirmed';
    if (action === 'reject') candidate.status = 'rejected';
    if (action === 'edit') {
      if (typeof body?.content === 'string' && body.content.trim()) {
        candidate.content = body.content.trim();
      }
      candidate.status = 'confirmed';
    }

    jobs.set(id, job);
    return NextResponse.json({ data: job } satisfies ApiResponse<ImportJob>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
