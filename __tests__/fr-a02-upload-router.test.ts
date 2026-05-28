import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { UploadRouter } from '../src/wiki/collection/upload-router.js';
import type { CollectorContext, MultimodalCollectInput } from '../src/wiki/types.js';

const context: CollectorContext = {
  model: 'test-model',
  llm: { complete: async () => '{}' },
  now: new Date('2026-05-24T12:00:00.000Z'),
};

function input(overrides: Partial<MultimodalCollectInput>): MultimodalCollectInput {
  return {
    fileName: 'material.txt',
    mimeType: 'text/plain',
    content: 'hello',
    sourceRef: 'fixture://material',
    ...overrides,
  };
}

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      space_id TEXT NOT NULL DEFAULT 'default',
      wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      wiki_page_ids_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT
    );
  `);
  return db;
}

describe('FR-A02 FR-D upload router', () => {
  it('AC1: Feishu/Web/URL entries share one router and persist route metadata', () => {
    const db = memoryDb();
    const router = new UploadRouter(db);

    const feishu = router.routeFromFeishu(input({ fileName: 'diagram.png', mimeType: 'image/png', sourceRef: 'same://diagram' }), context);
    const web = router.routeFromWeb(input({ fileName: 'diagram.png', mimeType: 'image/png', sourceRef: 'same://diagram' }), context);
    const url = router.routeFromUrl(input({ fileName: 'diagram.png', mimeType: 'image/png', sourceRef: 'same://diagram' }), context);

    expect(feishu.route.channel).toBe('image');
    expect(web.route.channel).toBe('image');
    expect(url.route.channel).toBe('image');
    expect(feishu.material.materialId).toBe(web.material.materialId);
    expect(web.material.materialId).toBe(url.material.materialId);

    const row = db.prepare('SELECT route_category, route_params_json, source_channel FROM materials WHERE id = ?').get(feishu.material.materialId) as { route_category: string; route_params_json: string; source_channel: string };
    expect(row.route_category).toBe('image');
    expect(JSON.parse(row.route_params_json)).toMatchObject({ ocrLanguage: 'zh', preserveCoordinates: true });
    expect(row.source_channel).toBe('url');
  });

  it('routes audio files with parser parameters', () => {
    const router = new UploadRouter();
    const result = router.routeFromWeb(input({ fileName: 'voice.mp3', mimeType: 'audio/mpeg', content: new Uint8Array([1, 2, 3]) }), context);

    expect(result.route.channel).toBe('audio');
    expect(result.route.parseParams).toMatchObject({ model: 'tiny', language: 'zh', includeSegments: true });
    expect(result.material.status).toBe('ready');
  });

  it('routes video files with frame extraction parameters', () => {
    const router = new UploadRouter();
    const result = router.routeFromUrl(input({ fileName: 'lecture.mp4', mimeType: 'video/mp4', content: new Uint8Array([1, 2, 3]) }), context);

    expect(result.route.channel).toBe('video');
    expect(result.route.parseParams).toMatchObject({ audioModel: 'tiny', audioLanguage: 'zh', frameIntervalSeconds: 30 });
    expect(result.material.sourceChannel).toBe('url');
  });

  it('AC3: unsupported material stays unsupported and never enters processing', () => {
    const db = memoryDb();
    const router = new UploadRouter(db);
    const result = router.routeFromWeb(input({ fileName: 'archive.zip', mimeType: 'application/zip', content: new Uint8Array([1, 2, 3]) }), context);

    expect(result.route.channel).toBe('unsupported');
    expect(result.material.status).toBe('unsupported');
    expect(result.material.errorMessage).toContain('不支持的素材类型');

    const row = db.prepare('SELECT status, pipeline_status, error_message FROM materials WHERE id = ?').get(result.material.materialId) as { status: string; pipeline_status: string; error_message: string };
    expect(row.status).toBe('unsupported');
    expect(row.pipeline_status).toBe('unsupported');
    expect(row.error_message).toContain('不支持的素材类型');
  });

  it('AC2/AC4: MIME wins over extension conflicts and logs the conflict', () => {
    const router = new UploadRouter();
    const result = router.routeFromFeishu(input({ fileName: 'renamed.mp4', mimeType: 'image/png', content: new Uint8Array([1, 2, 3]) }), context);

    expect(result.route.channel).toBe('image');
    expect(result.route.conflict).toBe(true);
    expect(result.route.conflictLog).toContain('mime/extension conflict');
    expect(result.route.parseParams).toMatchObject({ ocrLanguage: 'zh', preserveCoordinates: true });
  });

  it('AC5: repeated upload keeps stable routing and material identity', () => {
    const router = new UploadRouter();
    const first = router.routeFromWeb(input({ fileName: 'note.md', mimeType: 'text/markdown', sourceRef: 'upload://note-1' }), context);
    const second = router.routeFromWeb(input({ fileName: 'note.md', mimeType: 'text/markdown', sourceRef: 'upload://note-1' }), context);

    expect(first.route).toEqual(second.route);
    expect(first.material.materialId).toBe(second.material.materialId);
    expect(first.material.storagePath).toBe(second.material.storagePath);
  });
});
