import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import {
  detectMaterialMimeType,
  ensureMaterialSpaceExists,
  MAX_MATERIAL_FILE_SIZE_BYTES,
  persistUploadedMaterial,
  scheduleMaterialProcessing,
} from '@/lib/wiki-materials';

export const runtime = 'nodejs';

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
    const { mimeType, supported } = detectMaterialMimeType(fileName, file.type);
    if (!supported) {
      return badRequest('仅支持 PDF、JPG/PNG 图片、MP4 视频、MP3/WAV 音频');
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

    const response = {
      success: true,
      fileId: record.id,
      status: 'processing' as const,
    };
    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return serverError(message);
  }
}
