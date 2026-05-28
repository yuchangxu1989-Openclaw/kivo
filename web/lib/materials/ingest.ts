/**
 * lib/materials/ingest.ts — Wave 1 / A1 接收侧业务逻辑
 *
 * 边界（重要）：
 *  - 只负责把素材一行写进 materials 表，并把 classification_status 设为 'pending'
 *  - 不调用任何分类 / 切片 / 抽取逻辑（这些归 A2）
 *  - 不修改 schema；所有需要的列已由现有迁移补齐（见 sqlite3 PRAGMA table_info）
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openWebDb } from '@/lib/db';
import {
  buildStoredMaterialPath,
  ensureMaterialSpaceExists,
} from '@/lib/wiki-materials';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import type {
  AssetKind,
  IngestMetadata,
  IngestResponse,
  SourceChannel,
} from '@/lib/types/material';

/** 文件扩展名 → AssetKind */
const EXT_TO_KIND: Record<string, AssetKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'docx',
  txt: 'text',
  md: 'text',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
};

/** mimeType prefix → AssetKind */
function inferAssetKindFromMime(mimeType: string): AssetKind | null {
  if (!mimeType) return null;
  const lower = mimeType.toLowerCase();
  if (lower === 'application/pdf') return 'pdf';
  if (lower === 'application/msword') return 'doc';
  if (lower.includes('officedocument.wordprocessingml')) return 'docx';
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('text/')) return 'text';
  return null;
}

function inferAssetKindFromName(fileName: string): AssetKind | null {
  const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return ext ? EXT_TO_KIND[ext] ?? null : null;
}

export function resolveAssetKind(input: {
  hint?: AssetKind;
  fileName?: string | null;
  mimeType?: string | null;
}): AssetKind {
  if (input.hint) return input.hint;
  const byMime = input.mimeType ? inferAssetKindFromMime(input.mimeType) : null;
  if (byMime) return byMime;
  const byName = input.fileName ? inferAssetKindFromName(input.fileName) : null;
  if (byName) return byName;
  return 'other';
}

export function resolveSourceChannel(hint: SourceChannel | undefined, hadFile: boolean): SourceChannel {
  if (hint) return hint;
  return hadFile ? 'web_upload' : 'api';
}

export function resolveTitle(metadata: IngestMetadata, fileName?: string | null): string {
  const fromMeta = metadata.title?.trim();
  if (fromMeta) return fromMeta;
  if (fileName) return fileName.replace(/\.[^.]+$/, '').trim() || fileName;
  if (metadata.sourceRef) return metadata.sourceRef;
  return 'untitled-material';
}

/**
 * 把 metadata.extra 序列化进 source_ref 字段是不合适的（语义混乱）。
 * 这里的策略：只在 source_ref 中写一个简短可定位的字符串；extra 暂时合并
 * 进 error_message 也不合适，统一序列化成 metadata 字段在 source_ref 里
 * 用 JSON 包装会破坏 A2 查重。
 *
 * 选择：把 extra 拼到 source_ref 之后用 #meta=<base64> 形式不利于查询。
 * MVP 阶段直接丢弃 extra，但保留 sourceRef 作为唯一查重键；如未来需要可
 * 再加列。这是 spec 边界：A1 不扩 schema。
 */
export interface IngestPersistInput {
  fileBuffer?: Buffer;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number;
  metadata: IngestMetadata;
  hadFile: boolean;
}

export interface IngestPersistResult {
  materialId: string;
  acceptedAt: string;
  assetKind: AssetKind;
  sourceChannel: SourceChannel;
  sourceRef: string;
  storagePath: string | null;
}

/**
 * 把素材写进 DB，并在有文件时落盘。整个写入用一个事务，避免文件落盘成功
 * 但 DB 写失败留下孤儿文件的尴尬：先写 DB 占位，再落盘，失败就回滚。
 */
export async function persistIngest(input: IngestPersistInput): Promise<IngestPersistResult> {
  const db: Database.Database = openWebDb(false);
  ensureMaterialsTable(db);

  const materialId = randomUUID();
  const acceptedAt = new Date().toISOString();
  const assetKind = resolveAssetKind({
    hint: input.metadata.assetKind,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  const sourceChannel = resolveSourceChannel(input.metadata.sourceChannel, input.hadFile);
  const title = resolveTitle(input.metadata, input.fileName);
  const spaceId = ensureMaterialSpaceExists(input.metadata.spaceId?.trim() || 'default');

  const sourceRef =
    input.metadata.sourceRef?.trim() ||
    (input.hadFile ? `upload://material/${materialId}` : `api://material/${materialId}`);

  let storagePath: string | null = null;
  if (input.hadFile && input.fileBuffer) {
    const safeName = input.fileName || `${materialId}.bin`;
    storagePath = buildStoredMaterialPath(materialId, safeName);
  }

  const insert = db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status,
      space_id, wiki_page_count, created_at, updated_at,
      storage_path, wiki_page_ids_json, error_message,
      classification_status, asset_kind, source_channel, source_ref
    ) VALUES (
      @id, @fileName, @mimeType, @fileSize, 'processing',
      @spaceId, 0, @createdAt, @updatedAt,
      @storagePath, '[]', NULL,
      'pending', @assetKind, @sourceChannel, @sourceRef
    )
  `);

  // SQLite 写完成；若文件落盘失败，回滚 DB 行避免 dangling 记录。
  const txn = db.transaction(() => {
    insert.run({
      id: materialId,
      fileName: input.fileName || title,
      mimeType: input.mimeType || 'application/octet-stream',
      fileSize: input.fileSize,
      spaceId,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      storagePath: storagePath || '',
      assetKind,
      sourceChannel,
      sourceRef,
    });
  });

  try {
    txn();

    if (input.hadFile && input.fileBuffer && storagePath) {
      try {
        await fs.writeFile(storagePath, input.fileBuffer);
      } catch (err) {
        // 文件落盘失败 → 回滚 DB 行
        db.prepare('DELETE FROM materials WHERE id = ?').run(materialId);
        throw err;
      }
    }
  } finally {
    db.close();
  }

  return {
    materialId,
    acceptedAt,
    assetKind,
    sourceChannel,
    sourceRef,
    storagePath,
  };
}

export function buildIngestResponse(
  result: IngestPersistResult,
  basePath: string,
): IngestResponse {
  const trimmed = basePath.replace(/\/$/, '');
  return {
    materialId: result.materialId,
    status: 'processing',
    classificationStatus: 'pending',
    statusEndpoint: `${trimmed}/api/materials/${result.materialId}/status`,
    assetKind: result.assetKind,
    sourceChannel: result.sourceChannel,
    acceptedAt: result.acceptedAt,
  };
}
