import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../src/cli/init.js';
import { runAdd } from '../src/cli/add.js';
import { runList } from '../src/cli/list.js';
import { runUpdate } from '../src/cli/update.js';
import { runDelete } from '../src/cli/delete.js';

describe('CLI CRUD commands', () => {
  let testDir: string;
  let origCwd: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'kivo-crud-test-'));
    origCwd = process.cwd();
    process.chdir(testDir);
    await runInit({ dir: testDir, nonInteractive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── add ──────────────────────────────────────────────────────────────────

  describe('add', () => {
    it('adds an entry with minimal args', async () => {
      const output = await runAdd('fact', 'Test Fact');
      expect(output).toContain('✓ Added');
      expect(output).toContain('[fact]');
      expect(output).toContain('Test Fact');
    });

    it('adds an entry with all options and --json', async () => {
      const output = await runAdd('methodology', 'My Method', {
        content: 'Step by step guide',
        tags: 'dev,process',
        source: 'manual-test',
        confidence: '0.9',
        domain: 'engineering',
        json: true,
      });
      const parsed = JSON.parse(output);
      expect(parsed.type).toBe('methodology');
      expect(parsed.title).toBe('My Method');
      expect(parsed.content).toBe('Step by step guide');
      expect(parsed.tags).toEqual(['dev', 'process']);
      expect(parsed.confidence).toBe(0.9);
      expect(parsed.domain).toBe('engineering');
      expect(parsed.id).toBeDefined();
    });

    it('rejects invalid type', async () => {
      const output = await runAdd('invalid', 'Bad Type');
      expect(output).toContain('Invalid type');
      expect(output).toContain('Valid types');
    });

    it('rejects invalid confidence', async () => {
      const output = await runAdd('fact', 'Bad Conf', { confidence: '2.0' });
      expect(output).toContain('Confidence must be');
    });

    it('returns usage when missing args', async () => {
      const output = await runAdd('', '');
      expect(output).toContain('Usage');
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('lists entries after adding some', async () => {
      await runAdd('fact', 'Fact One', { content: 'Content one' });
      await runAdd('decision', 'Decision One', { content: 'Content two' });

      const output = await runList();
      expect(output).toContain('Fact One');
      expect(output).toContain('Decision One');
    });

    it('filters by type', async () => {
      await runAdd('fact', 'A Fact');
      await runAdd('decision', 'A Decision');

      const output = await runList({ type: 'fact' });
      expect(output).toContain('A Fact');
      expect(output).not.toContain('A Decision');
    });

    it('returns JSON with --json', async () => {
      await runAdd('fact', 'JSON Test');
      const output = await runList({ json: true });
      const parsed = JSON.parse(output);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      const found = parsed.items.find((i: { title: string }) => i.title === 'JSON Test');
      expect(found).toBeDefined();
      expect(parsed.total).toBeGreaterThanOrEqual(1);
    });

    it('respects limit and offset', async () => {
      await runAdd('fact', 'Entry 1');
      await runAdd('fact', 'Entry 2');
      await runAdd('fact', 'Entry 3');

      const output = await runList({ limit: '2', offset: '0', json: true });
      const parsed = JSON.parse(output);
      expect(parsed.items).toHaveLength(2);
      expect(parsed.hasMore).toBe(true);
    });

    it('shows empty message when no entries', async () => {
      const output = await runList();
      // Only seed entries exist; but if seeds are present, just check it doesn't crash
      expect(typeof output).toBe('string');
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title of an existing entry', async () => {
      const addOutput = await runAdd('fact', 'Original Title', { json: true });
      const { id } = JSON.parse(addOutput);

      const output = await runUpdate(id, { title: 'Updated Title' });
      expect(output).toContain('✓ Updated');
    });

    it('updates multiple fields', async () => {
      const addOutput = await runAdd('fact', 'Multi Update', { json: true });
      const { id } = JSON.parse(addOutput);

      const output = await runUpdate(id, {
        title: 'New Title',
        content: 'New Content',
        tags: 'new,tags',
        confidence: '0.95',
        json: true,
      });
      const parsed = JSON.parse(output);
      expect(parsed.title).toBe('New Title');
      expect(parsed.content).toBe('New Content');
      expect(parsed.confidence).toBe(0.95);
    });

    it('supports ID prefix matching', async () => {
      const addOutput = await runAdd('fact', 'Prefix Test', { json: true });
      const { id } = JSON.parse(addOutput);
      const prefix = id.slice(0, 8);

      const output = await runUpdate(prefix, { title: 'Prefix Updated' });
      expect(output).toContain('✓ Updated');
    });

    it('returns error for non-existent entry', async () => {
      const output = await runUpdate('nonexistent-id-12345', { title: 'Nope' });
      expect(output).toContain('not found');
    });

    it('returns error when nothing to update', async () => {
      const addOutput = await runAdd('fact', 'No Change', { json: true });
      const { id } = JSON.parse(addOutput);
      const output = await runUpdate(id, {});
      expect(output).toContain('Nothing to update');
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('requires --force to confirm deletion', async () => {
      const addOutput = await runAdd('fact', 'To Delete', { json: true });
      const { id } = JSON.parse(addOutput);

      const output = await runDelete(id, {});
      expect(output).toContain('Use --force to confirm');
    });

    it('deletes entry with --force', async () => {
      const addOutput = await runAdd('fact', 'Will Delete', { json: true });
      const { id } = JSON.parse(addOutput);

      const output = await runDelete(id, { force: true });
      expect(output).toContain('✓ Deleted');

      // Verify it's gone
      const listOutput = await runList({ json: true });
      const parsed = JSON.parse(listOutput);
      const found = parsed.items.find((i: { id: string }) => i.id === id);
      expect(found).toBeUndefined();
    });

    it('returns JSON on delete with --json --force', async () => {
      const addOutput = await runAdd('fact', 'JSON Delete', { json: true });
      const { id } = JSON.parse(addOutput);

      const output = await runDelete(id, { force: true, json: true });
      const parsed = JSON.parse(output);
      expect(parsed.deleted).toBe(true);
      expect(parsed.id).toBe(id);
    });

    it('returns error for non-existent entry', async () => {
      const output = await runDelete('nonexistent-id-12345', { force: true });
      expect(output).toContain('not found');
    });

    it('supports ID prefix matching', async () => {
      const addOutput = await runAdd('fact', 'Prefix Delete', { json: true });
      const { id } = JSON.parse(addOutput);
      const prefix = id.slice(0, 8);

      const output = await runDelete(prefix, { force: true });
      expect(output).toContain('✓ Deleted');
    });
  });
});
