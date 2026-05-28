import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteProvider } from '../sqlite-provider.js';
import type { KnowledgeEntry } from '../../types/index.js';

describe('SQLiteProvider entries.subject_id persistence', () => {
  it('writes and reads back KnowledgeEntry.subjectId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivo-subject-id-'));
    const dbPath = join(dir, 'kivo.db');
    const provider = new SQLiteProvider({ dbPath });

    const now = new Date('2026-05-24T00:00:00.000Z');
    const entry: KnowledgeEntry = {
      id: 'entry-subject-001',
      type: 'intent',
      title: 'subject id 写入验证',
      content: 'entries.subject_id 必须从 KnowledgeEntry.subjectId 写入。',
      summary: 'subject id 写入验证',
      source: {
        type: 'manual',
        reference: 'material:mat-subject-001',
        timestamp: now,
        materialId: 'mat-subject-001',
        subjectId: 'subject-node-001',
      },
      confidence: 0.95,
      status: 'active',
      tags: ['subject'],
      subjectId: 'subject-node-001',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    await provider.save(entry);
    const saved = await provider.findById(entry.id);
    await provider.close();
    rmSync(dir, { recursive: true, force: true });

    expect(saved?.subjectId).toBe('subject-node-001');
    expect(saved?.source.subjectId).toBe('subject-node-001');
    expect(saved?.source.materialId).toBe('mat-subject-001');
  });
});
