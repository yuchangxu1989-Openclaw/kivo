import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MultimodalRouteResult, MultimodalTextFragment } from '../types.js';

export interface StagingMaterialRecord {
  id: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
}

export interface PreparedStagingMaterialRow {
  id: string;
  clusterId: number;
  clusterSize: number;
  title: string;
  content: string;
  nature: string;
  functionTag: string;
  knowledgeDomain: string;
  source: string;
  confidence: number;
  tagsJson: string;
  similarSentencesJson: string;
  sourceRefsJson: string;
  contentHash: string;
  createdAt: string;
}

export function resolveStagingFragments(
  material: StagingMaterialRecord,
  result: Pick<MultimodalRouteResult, 'fragments' | 'extractedText'>,
): MultimodalTextFragment[] {
  const uniqueFragments = (result.fragments ?? [])
    .filter((fragment) => !fragment.duplicateMarker)
    .filter((fragment) => fragment.text.trim().length > 0);
  if (uniqueFragments.length > 0) {
    return uniqueFragments;
  }
  if (result.extractedText.trim()) {
    return [{ text: result.extractedText, sourceMediaPath: material.storagePath }];
  }
  return [];
}

export function prepareStagingMaterialRows(
  material: StagingMaterialRecord,
  result: Pick<MultimodalRouteResult, 'category' | 'fragments' | 'extractedText' | 'metadata' | 'warnings'>,
  now = new Date().toISOString(),
): PreparedStagingMaterialRow[] {
  const fragments = resolveStagingFragments(material, result);

  return fragments.flatMap((fragment, index) => {
    const content = fragment.text.trim();
    if (!content) return [];

    const sourceRefs = [{
      materialId: material.id,
      fileName: material.fileName,
      mimeType: material.mimeType,
      routeCategory: result.category,
      sourceMediaPath: fragment.sourceMediaPath ?? material.storagePath,
      startSeconds: fragment.startSeconds,
      endSeconds: fragment.endSeconds,
      frameIndex: fragment.frameIndex,
      timestampSeconds: fragment.timestampSeconds,
      coordinates: fragment.coordinates,
      channel: fragment.channel,
      metadata: result.metadata,
      warnings: result.warnings,
    }];
    const contentHash = createHash('sha256')
      .update(`${material.id}:${index}:${content}:${JSON.stringify(sourceRefs)}`)
      .digest('hex');

    return [{
      id: `${material.id}-${index + 1}`,
      clusterId: 0,
      clusterSize: fragments.length,
      title: fragmentTitle(material, index),
      content,
      nature: 'fact',
      functionTag: 'source_material',
      knowledgeDomain: result.category,
      source: `upload://material/${material.id}`,
      confidence: 0.7,
      tagsJson: JSON.stringify([result.category, 'multimodal']),
      similarSentencesJson: '[]',
      sourceRefsJson: JSON.stringify(sourceRefs),
      contentHash,
      createdAt: now,
    }];
  });
}

export function ensureStagingMaterialsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staging_materials (
      id TEXT PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      cluster_size INTEGER NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      nature TEXT,
      function_tag TEXT,
      knowledge_domain TEXT,
      source TEXT,
      confidence REAL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      similar_sentences_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_staging_materials_status ON staging_materials(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_materials_content_hash_unique ON staging_materials(content_hash);
  `);
}

export function writeStagingMaterialsToDb(
  db: Database.Database,
  material: StagingMaterialRecord,
  result: Pick<MultimodalRouteResult, 'category' | 'fragments' | 'extractedText' | 'metadata' | 'warnings'>,
  now = new Date().toISOString(),
) {
  ensureStagingMaterialsTable(db);
  const rows = prepareStagingMaterialRows(material, result, now);
  if (rows.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO staging_materials (
      id, cluster_id, cluster_size, title, content, nature, function_tag, knowledge_domain,
      source, confidence, tags_json, similar_sentences_json, source_refs_json, content_hash,
      status, created_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
  `);

  const tx = db.transaction((items: PreparedStagingMaterialRow[]) => {
    items.forEach((row) => {
      insert.run(
        row.id,
        row.clusterId,
        row.clusterSize,
        row.title,
        row.content,
        row.nature,
        row.functionTag,
        row.knowledgeDomain,
        row.source,
        row.confidence,
        row.tagsJson,
        row.similarSentencesJson,
        row.sourceRefsJson,
        row.contentHash,
        row.createdAt,
      );
    });
  });

  tx(rows);
  return rows.length;
}

function fragmentTitle(material: StagingMaterialRecord, index: number) {
  const base = material.fileName.replace(/\.[^.]+$/, '');
  return `${base} #${index + 1}`;
}
