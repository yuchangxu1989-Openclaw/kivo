/**
 * FR-A02 FR-D upload router entrypoints shared by Feishu, Web, and URL imports.
 */

import Database from 'better-sqlite3';
import { MultimodalRouter } from './multimodal-router.js';
import type { CollectorContext, MaterialRouteMetadata, MultimodalCollectInput, UploadRouteDecision } from '../types.js';

export type UploadRouterSourceChannel = 'feishu' | 'web' | 'url';

export interface UploadRouterInput extends MultimodalCollectInput {
  sourceChannel: UploadRouterSourceChannel;
}

export interface UploadRouterResult {
  route: UploadRouteDecision;
  material: MaterialRouteMetadata;
}

/**
 * MIME-first route decision plus material metadata persistence.
 * It does not invoke OCR, Whisper, ffmpeg, or downstream parser code.
 */
export class UploadRouter {
  private readonly router = new MultimodalRouter();

  constructor(private readonly db?: Database.Database) {}

  route(input: UploadRouterInput, context: CollectorContext): UploadRouterResult {
    const route = this.router.decideRoute(input);
    const material = this.router.persistMaterialRoute(input, route, context);
    if (this.db) persistMaterial(this.db, material);
    return { route, material };
  }

  routeFromFeishu(input: Omit<MultimodalCollectInput, 'sourceChannel'>, context: CollectorContext): UploadRouterResult {
    return this.route({ ...input, sourceChannel: 'feishu' }, context);
  }

  routeFromWeb(input: Omit<MultimodalCollectInput, 'sourceChannel'>, context: CollectorContext): UploadRouterResult {
    return this.route({ ...input, sourceChannel: 'web' }, context);
  }

  routeFromUrl(input: Omit<MultimodalCollectInput, 'sourceChannel'>, context: CollectorContext): UploadRouterResult {
    return this.route({ ...input, sourceChannel: 'url' }, context);
  }
}

export function persistMaterial(db: Database.Database, material: MaterialRouteMetadata): void {
  ensureRouteColumns(db);
  db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status,
      space_id, wiki_page_count, created_at, updated_at,
      storage_path, wiki_page_ids_json, error_message,
      asset_kind, source_channel, source_ref, pipeline_status,
      route_category, route_params_json
    ) VALUES (
      @id, @fileName, @mimeType, @fileSize, @status,
      @spaceId, 0, @createdAt, @updatedAt,
      @storagePath, '[]', @errorMessage,
      @assetKind, @sourceChannel, @sourceRef, @pipelineStatus,
      @routeCategory, @routeParamsJson
    )
    ON CONFLICT(id) DO UPDATE SET
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      file_size = excluded.file_size,
      status = excluded.status,
      space_id = excluded.space_id,
      updated_at = excluded.updated_at,
      storage_path = excluded.storage_path,
      error_message = excluded.error_message,
      asset_kind = excluded.asset_kind,
      source_channel = excluded.source_channel,
      source_ref = excluded.source_ref,
      pipeline_status = excluded.pipeline_status,
      route_category = excluded.route_category,
      route_params_json = excluded.route_params_json
  `).run({
    id: material.materialId,
    fileName: material.fileName,
    mimeType: material.mimeType,
    fileSize: material.fileSize,
    status: material.status,
    spaceId: material.spaceId,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    storagePath: material.storagePath,
    errorMessage: material.errorMessage ?? null,
    assetKind: material.route.channel,
    sourceChannel: material.sourceChannel,
    sourceRef: material.sourceRef ?? null,
    pipelineStatus: material.route.status === 'unsupported' ? 'unsupported' : 'pending',
    routeCategory: material.route.channel,
    routeParamsJson: JSON.stringify(material.route.parseParams),
  });
}

function ensureRouteColumns(db: Database.Database): void {
  const columns = new Set((db.prepare('PRAGMA table_info(materials)').all() as Array<{ name: string }>).map((column) => column.name));
  const addColumn = (name: string, sql: string) => {
    if (!columns.has(name)) db.exec(sql);
  };
  addColumn('asset_kind', 'ALTER TABLE materials ADD COLUMN asset_kind TEXT');
  addColumn('source_channel', 'ALTER TABLE materials ADD COLUMN source_channel TEXT');
  addColumn('source_ref', 'ALTER TABLE materials ADD COLUMN source_ref TEXT');
  addColumn('pipeline_status', 'ALTER TABLE materials ADD COLUMN pipeline_status TEXT');
  addColumn('route_category', 'ALTER TABLE materials ADD COLUMN route_category TEXT');
  addColumn('route_params_json', 'ALTER TABLE materials ADD COLUMN route_params_json TEXT');
}
