import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  EXTRACTION_CHECKPOINT_KEY,
  hasCandidateWork,
  latestCandidateTimestamp,
  readExtractionCheckpoint,
  shouldPersistExtractionCheckpoint,
  writeExtractionCheckpoint,
} from '../extract-sessions.js';

describe('extract-sessions incremental checkpoint', () => {
  it('persists the extraction checkpoint in kivo_meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivo-extract-checkpoint-'));
    const dbPath = join(dir, 'kivo.db');

    try {
      writeExtractionCheckpoint(dbPath, { lastExtractedAt: '2026-06-11T08:30:00.000Z' });

      expect(readExtractionCheckpoint(dbPath)).toEqual({ lastExtractedAt: '2026-06-11T08:30:00.000Z' });

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare('SELECT value FROM kivo_meta WHERE key = ?').get(EXTRACTION_CHECKPOINT_KEY) as { value: string };
        expect(JSON.parse(row.value)).toEqual({ lastExtractedAt: '2026-06-11T08:30:00.000Z' });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects empty incremental candidate files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivo-empty-candidates-'));
    const candidatesPath = join(dir, 'candidates.json');

    try {
      writeFileSync(candidatesPath, JSON.stringify({
        metadata: {
          total_messages: 0,
          total_segments: 0,
          after_filter: 0,
          generated_at: '2026-06-11T08:31:00Z',
          total_clusters: 0,
        },
        clusters: [],
      }));

      expect(hasCandidateWork(candidatesPath)).toBe(false);
      expect(latestCandidateTimestamp(candidatesPath)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts the newest segment timestamp from candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivo-candidate-timestamp-'));
    const candidatesPath = join(dir, 'candidates.json');

    try {
      writeFileSync(candidatesPath, JSON.stringify({
        metadata: { total_clusters: 2 },
        clusters: [
          {
            cluster_id: 1,
            cluster_size: 1,
            representative_segments: [
              { session_id: 's1', timestamp: '2026-06-11T07:00:00.000Z', text: 'old' },
            ],
          },
          {
            cluster_id: 2,
            cluster_size: 1,
            representative_segments: [
              { session_id: 's2', timestamp: '2026-06-11T09:00:00.000Z', text: 'new' },
              { session_id: 's3', timestamp: '2026-06-11T08:00:00.000Z', text: 'middle' },
            ],
          },
        ],
      }));

      expect(hasCandidateWork(candidatesPath)).toBe(true);
      expect(latestCandidateTimestamp(candidatesPath)).toBe('2026-06-11T09:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advance checkpoint for partial or manual runs', () => {
    const okResult = {
      clustersProcessed: 1,
      clustersSkipped: 0,
      materialsCollected: 1,
      knowledgeExtracted: 1,
      knowledgeWritten: 1,
      tokenEstimate: 10,
      errors: [],
    };

    expect(shouldPersistExtractionCheckpoint({ limit: 1 }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({ limit: 0 }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({ limit: Number.NaN }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({ since: '2026-06-11' }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({ candidates: './candidates.json' }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({ dryRun: true }, okResult)).toBe(false);
    expect(shouldPersistExtractionCheckpoint({}, { ...okResult, errors: ['boom'] })).toBe(false);
    expect(shouldPersistExtractionCheckpoint({}, okResult)).toBe(true);
  });
});
