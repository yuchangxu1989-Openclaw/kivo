import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { render, screen, fireEvent } from '@testing-library/react';

let dbPath = '';
let tmpDir = '';

vi.mock('@/lib/db', () => ({
  openWebDb: () => {
    const Database = require('better-sqlite3');
    return new Database(process.env.KIVO_DB_PATH);
  },
  getWebDbPath: () => process.env.KIVO_DB_PATH,
}));


vi.mock('@kivo/wiki/collection/pipeline.js', () => ({
  WikiCollectionPipeline: class {
    ensureDefaultSpace() { return { id: 'space-1' }; }
    async collectFromMultimodal() {
      return { draft: { title: '草稿', summary: '摘要', sections: [], links: [] }, warnings: [] };
    }
    async confirmDraft() { return { id: 'page-created' }; }
  },
}));

vi.mock('@/lib/wiki-engine', () => ({
  getWikiRepository: () => ({
    listSpaces: () => [{ id: 'space-1', type: 'wiki_space' }],
    findById: (id: string) => (id === 'page-1' ? { id: 'page-1', type: 'wiki_page', title: '自动 Wiki 页', metadata: { extra: {} } } : { id, type: 'wiki_space', title: '默认空间', metadata: { extra: {} } }),
    findPageBySourceUri: () => null,
    createPage: () => ({ id: 'page-created', title: '创建页面' }),
  }),
}));

vi.mock('@/lib/document-parsers', () => ({
  parsePlainTextFile: () => ([{
    id: 'cand-001',
    type: 'fact',
    title: '测试条目',
    content: '这是一条用于 UI 状态机测试的知识内容，长度足够形成候选。',
    sourceAnchor: '第 1 段',
    sourceContext: '测试上下文',
    status: 'pending',
  }]),
}));

vi.mock('swr', () => ({
  default: (url: string | null) => ({
    data: url ? {
      data: {
        materialId: 'mat-ui-1',
        fileName: 'ui.txt',
        status: 'done',
        pipelineStatus: 'done',
        classificationStatus: 'classified',
        knowledgeEntryCount: 3,
        wikiPageCount: 1,
        outputPages: [{ id: 'page-1', title: '自动 Wiki 页', href: '/wiki/pages/page-1' }],
        lastError: null,
        updatedAt: '2026-05-24T00:00:00.000Z',
      },
    } : undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

function initDb(file: string) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      source_json TEXT,
      status TEXT,
      tags_json TEXT,
      version INTEGER,
      metadata_json TEXT,
      subject_id TEXT,
      entry_type TEXT,
      created_at TEXT,
      updated_at TEXT,
      confidence REAL
    );
  `);
  db.close();
}

function request(pathname: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(new URL(pathname, 'http://localhost:3000'), init);
}

describe('FR-W08 import auto pipeline', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-w08-'));
    dbPath = path.join(tmpDir, 'kivo.db');
    process.env.KIVO_DB_PATH = dbPath;
    process.env.KIVO_MATERIALS_DIR = path.join(tmpDir, 'uploads');
    initDb(dbPath);
  });

  afterEach(() => {
    delete process.env.KIVO_DB_PATH;
    delete process.env.KIVO_MATERIALS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('upload route persists material and enqueues dispatcher task', async () => {
    const { POST } = await import('../../app/api/v1/wiki/upload/route');
    const form = new FormData();
    form.append('file', new File(['%PDF-1.4 plain text'], 'lesson.pdf', { type: 'application/pdf' }));

    const res = await POST({ formData: async () => form } as NextRequest);
    if (res.status !== 201) {
      throw new Error(`upload failed: ${res.status} ${JSON.stringify(await res.json())}`);
    }
    const body = await res.json() as { fileId: string };

    const db = new Database(dbPath);
    const task = db.prepare(`SELECT type, status, payload FROM task_queue`).get() as { type: string; status: string; payload: string };
    const mat = db.prepare(`SELECT pipeline_status FROM materials WHERE id = ?`).get(body.fileId) as { pipeline_status: string };
    db.close();

    expect(task.type).toBe('classify_pending');
    expect(task.status).toBe('waiting');
    expect(JSON.parse(task.payload).materialId).toBe(body.fileId);
    expect(mat.pipeline_status).toBe('pending');
  });

  it('materials status API returns progress counts and last error', async () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL,
      status TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT 'default', wiki_page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, storage_path TEXT NOT NULL,
      wiki_page_ids_json TEXT NOT NULL DEFAULT '[]', error_message TEXT,
      classification_status TEXT, pipeline_status TEXT, slice_count INTEGER DEFAULT 0, extract_count INTEGER DEFAULT 0
    )`);
    db.prepare(`INSERT INTO materials (id, file_name, mime_type, file_size, status, wiki_page_count, created_at, updated_at, storage_path, wiki_page_ids_json, classification_status, pipeline_status, slice_count, extract_count)
      VALUES ('mat-1', 'lesson.pdf', 'application/pdf', 10, 'done', 1, 'now', 'now', '/tmp/x', '["page-1"]', 'classified', 'done', 2, 3)`).run();
    db.close();

    const { GET } = await import('../../app/api/v1/wiki/materials/[id]/status/route');
    const res = await GET(request('/api/v1/wiki/materials/mat-1'), { params: Promise.resolve({ id: 'mat-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string; knowledgeEntryCount: number; wikiPageCount: number } };
    expect(body.data.status).toBe('done');
    expect(body.data.knowledgeEntryCount).toBe(3);
    expect(body.data.wikiPageCount).toBe(1);
  });

  it('import UI uploads file and shows done pipeline summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ fileId: 'mat-ui-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { default: DocumentImportPage } = await import('../../app/(dashboard)/knowledge/import/page');

    render(<DocumentImportPage />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['hello world'], 'ui.txt', { type: 'text/plain' })] } });

    expect(await screen.findByText(/已生成 3 个知识条目 \/ 1 个 wiki 页面/)).toBeInTheDocument();
    expect(screen.getByText('自动 Wiki 页')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/kivo/api/v1/wiki/upload', expect.objectContaining({ method: 'POST' }));
  });
});
