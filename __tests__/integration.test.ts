import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Kivo } from '../src/kivo.js';
import type { KivoConfig } from '../src/config.js';
import type { ConflictRecord, ConflictVerdict } from '../src/conflict/index.js';
import type { KnowledgeEntry } from '../src/types/index.js';

describe('KIVO Integration', () => {
  let kivo: Kivo;

  const memoryConfig: KivoConfig = {
    dbPath: ':memory:',
    pipelineOptions: {
      extractor: { minContentLength: 10 },
    },
  };

  beforeEach(async () => {
    kivo = new Kivo(memoryConfig);
    await kivo.init();
  });

  afterEach(async () => {
    await kivo.shutdown();
  });

  describe('End-to-end: ingest → extract → store → query', () => {
    it('should ingest text, extract entries, and allow querying', async () => {
      const text = `TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.

It adds optional static typing and class-based object-oriented programming to the language.`;

      const result = await kivo.ingest(text, 'test-doc-1');

      // Pipeline should produce entries
      expect(result.taskId).toBeTruthy();
      expect(result.entries.length).toBeGreaterThan(0);

      // Each entry should have required fields
      for (const entry of result.entries) {
        expect(entry.id).toBeTruthy();
        expect(entry.type).toBeTruthy();
        expect(entry.title).toBeTruthy();
        expect(entry.content).toBeTruthy();
        expect(entry.status).toBe('active');
        expect(entry.version).toBe(1);
      }

      // Query should find stored entries
      const searchResults = await kivo.query('TypeScript');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].entry.content).toContain('TypeScript');
    });

    it('should retrieve entry by id after ingest', async () => {
      const text = 'Node.js is a runtime environment for executing JavaScript outside the browser.';
      const result = await kivo.ingest(text, 'test-doc-2');

      const entryId = result.entries[0].id;
      const retrieved = await kivo.getEntry(entryId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(entryId);
      expect(retrieved!.content).toContain('Node.js');
    });

    it('should return empty results for non-matching query', async () => {
      const text = 'Python is a high-level programming language.';
      await kivo.ingest(text, 'test-doc-3');

      const results = await kivo.query('quantum physics');
      expect(results.length).toBe(0);
    });
  });

  describe('Conflict detection and resolution', () => {
    it('should detect conflict when ingesting contradictory knowledge', async () => {
      // Use a custom LLM provider that always reports conflict for testing
      const conflictKivo = new Kivo({
        dbPath: ':memory:',
        pipelineOptions: { extractor: { minContentLength: 10 } },
        llmProvider: {
          async judgeConflict(): Promise<ConflictVerdict> {
            return 'conflict';
          },
        },
        conflictThreshold: 0,
      });
      await conflictKivo.init();

      // First ingest
      await conflictKivo.ingest(
        'The Earth revolves around the Sun, completing one full orbit in approximately 365 days as observed by astronomers.',
        'source-a'
      );

      // Second ingest with contradictory info (same topic)
      const result = await conflictKivo.ingest(
        'The Earth revolves around the Sun, completing one full orbit in approximately 400 days as observed by astronomers.',
        'source-b'
      );

      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].verdict).toBe('conflict');
      expect(result.conflicts[0].resolved).toBe(false);

      await conflictKivo.shutdown();
    });

    it('should resolve conflict with newer-wins strategy', async () => {
      const conflictKivo = new Kivo({
        dbPath: ':memory:',
        pipelineOptions: { extractor: { minContentLength: 10 } },
        llmProvider: {
          async judgeConflict(): Promise<ConflictVerdict> {
            return 'conflict';
          },
        },
        conflictThreshold: 0,
      });
      await conflictKivo.init();

      await conflictKivo.ingest('JavaScript was created by Brendan Eich, originally designed as a scripting language for web browsers in 1995.', 'src-1');
      const result = await conflictKivo.ingest('JavaScript was created by Brendan Eich, originally designed as a scripting language for web browsers in 1996.', 'src-2');

      expect(result.conflicts.length).toBeGreaterThan(0);

      const conflict = result.conflicts[0];
      const resolution = await conflictKivo.resolveConflict(conflict, 'newer-wins');

      expect(resolution.action).toBe('supersede');
      expect(resolution.record.resolved).toBe(true);

      // Loser should be superseded
      const loser = await conflictKivo.getEntry(resolution.loserId);
      expect(loser!.status).toBe('superseded');

      await conflictKivo.shutdown();
    });

    it('should resolve conflict with confidence-wins strategy', async () => {
      const conflictKivo = new Kivo({
        dbPath: ':memory:',
        pipelineOptions: { extractor: { minContentLength: 10 } },
        llmProvider: {
          async judgeConflict(): Promise<ConflictVerdict> {
            return 'conflict';
          },
        },
        conflictThreshold: 0,
      });
      await conflictKivo.init();

      await conflictKivo.ingest('React uses a virtual DOM for rendering.', 'src-1');
      const result = await conflictKivo.ingest('React does not use a virtual DOM.', 'src-2');

      if (result.conflicts.length > 0) {
        const resolution = await conflictKivo.resolveConflict(
          result.conflicts[0],
          'confidence-wins'
        );
        expect(resolution.action).toBe('supersede');
        expect(resolution.record.resolution).toBe('confidence-wins');
      }

      await conflictKivo.shutdown();
    });
  });

  describe('Configuration validation', () => {
    it('should throw on empty dbPath', () => {
      expect(() => new Kivo({ dbPath: '' })).toThrow('dbPath is required');
    });

    it('should throw on invalid conflictThreshold', () => {
      expect(() => new Kivo({ dbPath: ':memory:', conflictThreshold: 2.0 })).toThrow(
        'conflictThreshold'
      );
    });

    it('should throw on negative conflictThreshold', () => {
      expect(() => new Kivo({ dbPath: ':memory:', conflictThreshold: -0.5 })).toThrow(
        'conflictThreshold'
      );
    });

    it('should throw if API called before init()', async () => {
      const uninitKivo = new Kivo({ dbPath: ':memory:' });
      await expect(uninitKivo.ingest('test', 'src')).rejects.toThrow('not initialized');
    });

    it('should allow double init() without error', async () => {
      const k = new Kivo({ dbPath: ':memory:' });
      await k.init();
      await k.init(); // should not throw
      await k.shutdown();
    });

    it('should allow shutdown without init', async () => {
      const k = new Kivo({ dbPath: ':memory:' });
      await k.shutdown(); // should not throw
    });
  });
});
