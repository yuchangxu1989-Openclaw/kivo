import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { prepareStagingMaterialRows, writeStagingMaterialsToDb } from '../staging-materials.js';

describe('staging material dedup write', () => {
  it('filters duplicateMarker fragments before inserting into staging_materials', () => {
    const db = new Database(':memory:');
    try {
      const inserted = writeStagingMaterialsToDb(
        db,
        {
          id: 'material-1',
          fileName: 'lesson.mp4',
          mimeType: 'video/mp4',
          storagePath: 'uploads/lesson.mp4',
        },
        {
          category: 'video',
          extractedText: '音轨正文\n板书补充',
          metadata: { sourceMediaPath: 'uploads/lesson.mp4' },
          warnings: [],
          fragments: [
            { text: '音轨正文', startSeconds: 0, endSeconds: 5, sourceMediaPath: 'uploads/lesson.mp4', channel: 'audio' },
            { text: '音轨正文', timestampSeconds: 3, frameIndex: 1, sourceMediaPath: 'uploads/frame-1.jpg', channel: 'keyframe', duplicateMarker: 'audio-overlap-100pct' },
            { text: '板书补充', timestampSeconds: 12, frameIndex: 2, sourceMediaPath: 'uploads/frame-2.jpg', channel: 'keyframe' },
          ],
        },
        '2026-05-25T00:00:00.000Z',
      );

      expect(inserted).toBe(2);
      const rows = db.prepare('SELECT id, content, cluster_size, source_refs_json FROM staging_materials ORDER BY id').all() as Array<{
        id: string;
        content: string;
        cluster_size: number;
        source_refs_json: string;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.content)).toEqual(['音轨正文', '板书补充']);
      expect(rows.every((row) => row.cluster_size === 2)).toBe(true);
      const parsedRefs = rows.map((row) => JSON.parse(row.source_refs_json) as Array<Record<string, unknown>>);
      expect(parsedRefs[0][0].channel).toBe('audio');
      expect(parsedRefs[1][0].channel).toBe('keyframe');
      expect(parsedRefs[1][0].timestampSeconds).toBe(12);
    } finally {
      db.close();
    }
  });

  it('falls back to extractedText when no unique fragments remain', () => {
    const rows = prepareStagingMaterialRows(
      {
        id: 'material-2',
        fileName: 'lesson.mp4',
        mimeType: 'video/mp4',
        storagePath: 'uploads/lesson.mp4',
      },
      {
        category: 'video',
        extractedText: '仅保留主稿文本',
        metadata: {},
        warnings: [],
        fragments: [
          { text: '重复板书', timestampSeconds: 10, channel: 'keyframe', duplicateMarker: 'audio-overlap-90pct' },
        ],
      },
      '2026-05-25T00:00:00.000Z',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('仅保留主稿文本');
  });
});
