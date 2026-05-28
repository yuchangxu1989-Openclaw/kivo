import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { badRequest, serverError } from '@/lib/errors';
import {
  detectMaterialMimeType,
  ensureMaterialSpaceExists,
  MAX_MATERIAL_FILE_SIZE_BYTES,
  persistUploadedMaterial,
  scheduleMaterialProcessing,
} from '@/lib/wiki-materials';
import { triggerMaterialDispatch } from '@/lib/queue/material-dispatch';
import { triggerInProcessDispatch } from '@/lib/queue/in-process-dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const spaceId = (formData.get('spaceId') as string | null)?.trim() || 'default';

    if (!file || !(file instanceof Blob)) {
      return badRequest('file field is required (multipart/form-data)');
    }

    if (file.size > MAX_MATERIAL_FILE_SIZE_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      return badRequest(`File too large: ${sizeMb} MB exceeds 400 MB limit`);
    }

    const fileName = (file as File).name || 'unknown';
    const { mimeType, supported, category } = detectMaterialMimeType(fileName, file.type);
    if (!supported || category === 'unsupported') {
      return badRequest(`不支持的素材类型：${file.type || fileName || 'unknown'}。当前支持 PDF、文本、JPG/PNG 图片、MP4 视频、MP3/WAV 音频。`);
    }

    ensureMaterialSpaceExists(spaceId);

    const arrayBuffer = await file.arrayBuffer();
    const record = await persistUploadedMaterial({
      fileName,
      mimeType,
      fileSize: file.size,
      spaceId,
      arrayBuffer,
    });
    scheduleMaterialProcessing(record.id);
    triggerMaterialDispatch(record.id);
    triggerInProcessDispatch();
    revalidatePath('/wiki/materials');
    revalidatePath('/api/v1/wiki/materials');

    const response = {
      success: true,
      fileId: record.id,
      fileName: record.fileName,
      fileSize: record.fileSize,
      status: 'processing' as const,
      createdAt: record.createdAt,
    };
    return NextResponse.json(response, {
      status: 201,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return serverError(message);
  }
}
