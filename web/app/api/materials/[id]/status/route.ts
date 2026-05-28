/**
 * GET /api/materials/[id]/status — Wave 1 / A1
 *
 * Spec: FR-B03 ingest 后的状态轮询入口。
 * Arc42: §5.3.1 / §6.1。
 *
 * 行为：从 materials 表读出当前状态。A1 仅展示分类待消费态（pending）；
 * A2 上线后会更新 classification_status / pipeline_status 等列。
 */

import { NextRequest, NextResponse } from 'next/server';
import { badRequest, notFound, serverError } from '@/lib/errors';
import { openWebDb } from '@/lib/db';
import { ensureMaterialsTable } from '@/lib/wiki-materials-store';
import type {
  AssetKind,
  ClassificationStatus,
  MaterialStatusResponse,
  SourceChannel,
} from '@/lib/types/material';

export const runtime = 'nodejs';

interface MaterialStatusRow {
  id: string;
  file_name: string;
  asset_kind: string | null;
  source_channel: string | null;
  source_ref: string | null;
  status: string | null;
  pipeline_status: string | null;
  classification_status: string | null;
  classification_confidence: number | null;
  suggested_subject_name: string | null;
  subject_node_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ResetMaterialStatusBody {
  status?: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = openWebDb(true);
  try {
    ensureMaterialsTable(db);
    const { id } = await params;
    const row = db
      .prepare(
        `SELECT id, file_name, asset_kind, source_channel, source_ref,
                status, pipeline_status, classification_status, classification_confidence,
                suggested_subject_name, subject_node_id, created_at, updated_at
         FROM materials WHERE id = ?`,
      )
      .get(id) as MaterialStatusRow | undefined;

    if (!row) return notFound(`Material ${id} 不存在`);

    const response: MaterialStatusResponse = {
      materialId: row.id,
      title: row.file_name,
      assetKind: (row.asset_kind as AssetKind | null) ?? null,
      sourceChannel: (row.source_channel as SourceChannel | null) ?? null,
      sourceRef: row.source_ref,
      pipelineStatus: row.pipeline_status ?? row.status,
      classificationStatus: (row.classification_status as ClassificationStatus | null) ?? null,
      classificationConfidence: row.classification_confidence,
      suggestedSubjectName: row.suggested_subject_name,
      subjectNodeId: row.subject_node_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    return NextResponse.json({ data: response });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db.close();
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = openWebDb(true);
  try {
    ensureMaterialsTable(db);
    const { id } = await params;

    let body: ResetMaterialStatusBody = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const nextStatus = (body.status ?? 'pending').trim();
    if (nextStatus !== 'pending') {
      return badRequest('Only status="pending" is supported');
    }

    const existing = db
      .prepare(
        `SELECT id, file_name, asset_kind, source_channel, source_ref,
                status, pipeline_status, classification_status, classification_confidence,
                suggested_subject_name, subject_node_id, created_at, updated_at
         FROM materials WHERE id = ?`,
      )
      .get(id) as MaterialStatusRow | undefined;

    if (!existing) return notFound(`Material ${id} 不存在`);

    db.prepare(
      `UPDATE materials
          SET status = 'processing',
              pipeline_status = 'pending',
              classification_status = CASE
                WHEN classification_status IS NULL OR classification_status = 'failed' THEN 'pending'
                ELSE classification_status
              END,
              classification_confidence = CASE
                WHEN classification_status IS NULL OR classification_status = 'failed' THEN NULL
                ELSE classification_confidence
              END,
              suggested_subject_name = CASE
                WHEN classification_status IS NULL OR classification_status = 'failed' THEN NULL
                ELSE suggested_subject_name
              END,
              subject_node_id = CASE
                WHEN classification_status = 'failed' THEN NULL
                ELSE subject_node_id
              END,
              wiki_page_count = 0,
              wiki_page_ids_json = '[]',
              error_message = NULL,
              slice_count = 0,
              extract_count = 0,
              total_chunks = NULL,
              processed_chunks = 0,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(id);

    const row = db
      .prepare(
        `SELECT id, file_name, asset_kind, source_channel, source_ref,
                status, pipeline_status, classification_status, classification_confidence,
                suggested_subject_name, subject_node_id, created_at, updated_at
         FROM materials WHERE id = ?`,
      )
      .get(id) as MaterialStatusRow;

    const response: MaterialStatusResponse = {
      materialId: row.id,
      title: row.file_name,
      assetKind: (row.asset_kind as AssetKind | null) ?? null,
      sourceChannel: (row.source_channel as SourceChannel | null) ?? null,
      sourceRef: row.source_ref,
      pipelineStatus: row.pipeline_status ?? row.status,
      classificationStatus: (row.classification_status as ClassificationStatus | null) ?? null,
      classificationConfidence: row.classification_confidence,
      suggestedSubjectName: row.suggested_subject_name,
      subjectNodeId: row.subject_node_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    return NextResponse.json({ data: response });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  } finally {
    db.close();
  }
}
