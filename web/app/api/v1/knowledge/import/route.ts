/**
 * POST /api/v1/knowledge/import — Server-side document import with PDF/EPUB parsing.
 *
 * Accepts multipart/form-data with a file field. Parses the document server-side
 * using document-parser utilities and returns extracted candidates.
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { parsePlainTextFile } from '@/lib/document-parsers';
import type { ImportCandidate as SharedImportCandidate } from '@/lib/import-types';
import type { ApiResponse } from '@/types';

interface ImportCandidate extends SharedImportCandidate {
  status: 'pending';
}

interface ImportResult {
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  candidates: ImportCandidate[];
  stage: 'done';
}

const MAX_FILE_SIZE_MB = 50;
const SUPPORTED_TYPES = new Set(['md', 'markdown', 'txt', 'text', 'json', 'csv']);

function inferFileType(fileName: string): string | null {
  const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!ext) return null;
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'text') return 'txt';
  if (ext === 'json') return 'json';
  if (ext === 'csv') return 'csv';
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof Blob)) {
      return badRequest('file field is required (multipart/form-data)');
    }

    const fileName = (file as File).name || 'unknown';
    const fileType = inferFileType(fileName);

    if (!fileType || !SUPPORTED_TYPES.has(fileType)) {
      return badRequest(`Unsupported file type: ${fileName}. Accepted: md, txt, json, csv`);
    }

    const fileSizeMb = file.size / (1024 * 1024);
    if (fileSizeMb > MAX_FILE_SIZE_MB) {
      return badRequest(`File too large: ${fileSizeMb.toFixed(1)} MB exceeds ${MAX_FILE_SIZE_MB} MB limit`);
    }

    const text = await file.text();
    if (!text.trim()) {
      return badRequest('File content is empty');
    }

    const candidates = parsePlainTextFile(file as File, text.trim()) as ImportCandidate[];

    const result: ImportResult = {
      fileName,
      fileType,
      fileSizeMb: Math.round(fileSizeMb * 100) / 100 || 0.01,
      candidates,
      stage: 'done',
    };

    const response: ApiResponse<ImportResult> = { data: result };
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
