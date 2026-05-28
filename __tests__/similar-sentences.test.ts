/**
 * Tests for similar_sentences feature:
 * - SQLiteProvider stores and retrieves similarSentences
 * - Migration adds the column
 * - enrich-intents CLI logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

describe('similar_sentences', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kivo-ss-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('SQLiteProvider', () => {
    it('stores and retrieves similarSentences for intent entries', async () => {
      const { SQLiteProvider } = await import('../src/repository/sqlite-provider.js');
      const dbPath = join(tempDir, 'test.db');
      const provider = new SQLiteProvider({ dbPath });

      const now = new Date();
      const entry = {
        id: 'test-intent-1',
        type: 'intent' as const,
        title: '用户偏好中文回复',
        content: '当用户说"用中文"时，应切换到中文回复',
        summary: '中文偏好意图',
        source: { type: 'manual' as const, reference: 'test', timestamp: now },
        confidence: 0.9,
        status: 'active' as const,
        tags: ['language', 'preference'],
        similarSentences: ['用中文回答我', '请说中文', '我想要中文的回复', '能不能用中文', 'switch to Chinese'],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      await provider.save(entry);
      const retrieved = await provider.findById('test-intent-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.similarSentences).toEqual([
        '用中文回答我', '请说中文', '我想要中文的回复', '能不能用中文', 'switch to Chinese',
      ]);
      expect(retrieved!.type).toBe('intent');

      await provider.close();
    });

    it('returns undefined similarSentences for non-intent entries', async () => {
      const { SQLiteProvider } = await import('../src/repository/sqlite-provider.js');
      const dbPath = join(tempDir, 'test.db');
      const provider = new SQLiteProvider({ dbPath });

      const now = new Date();
      const entry = {
        id: 'test-fact-1',
        type: 'fact' as const,
        title: 'Node.js version',
        content: 'Node.js 20 is required',
        summary: 'Node version requirement',
        source: { type: 'manual' as const, reference: 'test', timestamp: now },
        confidence: 0.9,
        status: 'active' as const,
        tags: ['tech'],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      await provider.save(entry);
      const retrieved = await provider.findById('test-fact-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.similarSentences).toBeUndefined();

      await provider.close();
    });

    it('updates similarSentences on save', async () => {
      const { SQLiteProvider } = await import('../src/repository/sqlite-provider.js');
      const dbPath = join(tempDir, 'test.db');
      const provider = new SQLiteProvider({ dbPath });

      const now = new Date();
      const entry = {
        id: 'test-intent-2',
        type: 'intent' as const,
        title: 'Test intent',
        content: 'Test content',
        summary: 'Test',
        source: { type: 'manual' as const, reference: 'test', timestamp: now },
        confidence: 0.8,
        status: 'active' as const,
        tags: [],
        similarSentences: ['sentence 1'],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      await provider.save(entry);

      // Update with more sentences
      entry.similarSentences = ['sentence 1', 'sentence 2', 'sentence 3'];
      await provider.save(entry);

      const retrieved = await provider.findById('test-intent-2');
      expect(retrieved!.similarSentences).toEqual(['sentence 1', 'sentence 2', 'sentence 3']);

      await provider.close();
    });

    it('handles NULL similar_sentences in legacy DB gracefully', async () => {
      const dbPath = join(tempDir, 'legacy.db');
      // Create a legacy DB without similar_sentences column
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          source_json TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'active',
          tags_json TEXT NOT NULL DEFAULT '[]',
          domain TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          supersedes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('legacy-1', 'intent', 'Legacy intent', 'Some content', 'Summary', '{"type":"manual","reference":"test","timestamp":"2024-01-01"}', 0.8, 'active', '[]', now, now);
      db.close();

      // Open with SQLiteProvider — should auto-migrate
      const { SQLiteProvider } = await import('../src/repository/sqlite-provider.js');
      const provider = new SQLiteProvider({ dbPath });

      const retrieved = await provider.findById('legacy-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.similarSentences).toBeUndefined(); // empty array → undefined

      await provider.close();
    });
  });

  describe('Migration 0.4.0', () => {
    it('adds similar_sentences column via migration runner', async () => {
      const dbPath = join(tempDir, 'migrate.db');
      const db = new Database(dbPath);
      // Create base schema
      db.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          source_json TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'active',
          tags_json TEXT NOT NULL DEFAULT '[]',
          domain TEXT DEFAULT 'default',
          version INTEGER NOT NULL DEFAULT 1,
          supersedes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE kivo_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE kivo_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          success INTEGER NOT NULL DEFAULT 1
        );
      `);
      // Mark previous migrations as applied
      db.prepare('INSERT INTO kivo_migrations (version) VALUES (?)').run('0.2.0');
      db.prepare('INSERT INTO kivo_migrations (version) VALUES (?)').run('0.3.0');
      db.prepare('INSERT INTO kivo_migrations (version) VALUES (?)').run('0.3.1');

      const { MigrationRunner } = await import('../src/migration/migration-runner.js');
      const runner = new MigrationRunner(db);

      const pending = runner.getPendingMigrations();
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending.some(m => m.version === '0.4.0')).toBe(true);

      const result = runner.migrate();
      expect(result.success).toBe(true);
      expect(result.appliedMigrations).toContain('0.4.0');

      // Verify column exists
      const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
      expect(columns.some(c => c.name === 'similar_sentences')).toBe(true);

      db.close();
    });
  });

  describe('MemoryKnowledgeStore', () => {
    it('preserves similarSentences through save/get cycle', async () => {
      const { MemoryKnowledgeStore } = await import('../src/storage/knowledge-store.js');
      const store = new MemoryKnowledgeStore();

      const now = new Date();
      const entry = {
        id: 'mem-intent-1',
        type: 'intent' as const,
        title: 'Test intent',
        content: 'Test content',
        summary: 'Test',
        source: { type: 'manual' as const, reference: 'test', timestamp: now },
        confidence: 0.9,
        status: 'active' as const,
        tags: [],
        similarSentences: ['a', 'b', 'c'],
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      const saved = await store.save(entry);
      expect(saved.similarSentences).toEqual(['a', 'b', 'c']);

      const retrieved = await store.get('mem-intent-1');
      expect(retrieved!.similarSentences).toEqual(['a', 'b', 'c']);

      // Mutating original should not affect stored
      entry.similarSentences!.push('d');
      const retrieved2 = await store.get('mem-intent-1');
      expect(retrieved2!.similarSentences).toEqual(['a', 'b', 'c']);
    });
  });
});
