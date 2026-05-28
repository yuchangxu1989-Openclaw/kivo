import { describe, expect, it } from 'vitest';
import { InjectionFormatter, estimateTokens } from '../injection-formatter.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';

function makeSource(): KnowledgeSource {
  return { type: 'document', reference: 'doc://test', timestamp: new Date('2026-05-01T00:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'e-1',
    type: 'fact',
    title: 'Test Entry',
    content: 'This is the full content of the knowledge entry.',
    summary: 'A brief summary',
    source: makeSource(),
    confidence: 0.9,
    status: 'active',
    tags: ['test'],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe('InjectionFormatter — summary mode', () => {
  it('markdown summary produces single-line with id tag', () => {
    const formatter = new InjectionFormatter('markdown', 'summary');
    const entry = makeEntry({ id: 'k-42', category: 'domain' });
    const block = formatter.formatEntry(entry);

    expect(block.disclosureMode).toBe('summary');
    expect(block.entryId).toBe('k-42');
    // Should contain title, category tag, type, confidence, and id reference
    expect(block.text).toContain('**Test Entry**');
    expect(block.text).toContain('[domain]');
    expect(block.text).toContain('fact');
    expect(block.text).toContain('×0.9');
    expect(block.text).toContain('`id:k-42`');
    // Summary mode should NOT contain full content markers like ### heading
    expect(block.text).not.toContain('### ');
  });

  it('plain summary produces compact single line', () => {
    const formatter = new InjectionFormatter('plain', 'summary');
    const entry = makeEntry({ id: 'k-99', category: 'tool' });
    const block = formatter.formatEntry(entry);

    expect(block.disclosureMode).toBe('summary');
    expect(block.text).toContain('[FACT]');
    expect(block.text).toContain('[tool]');
    expect(block.text).toContain('Test Entry');
    expect(block.text).toContain('(id:k-99)');
  });

  it('summary without category omits category tag', () => {
    const formatter = new InjectionFormatter('markdown', 'summary');
    const entry = makeEntry({ id: 'k-10' }); // no category
    const block = formatter.formatEntry(entry);

    expect(block.text).not.toMatch(/\[domain\]|\[process\]|\[reference\]/);
    expect(block.text).toContain('`id:k-10`');
  });
});

describe('InjectionFormatter — full mode', () => {
  it('markdown full produces multi-line block with heading and source', () => {
    const formatter = new InjectionFormatter('markdown', 'full');
    const entry = makeEntry();
    const block = formatter.formatEntry(entry);

    expect(block.disclosureMode).toBe('full');
    expect(block.text).toContain('### Test Entry');
    expect(block.text).toContain('fact');
    expect(block.text).toContain('0.9');
    expect(block.text).toContain('doc://test');
  });

  it('plain full produces structured text block', () => {
    const formatter = new InjectionFormatter('plain', 'full');
    const entry = makeEntry();
    const block = formatter.formatEntry(entry);

    expect(block.disclosureMode).toBe('full');
    expect(block.text).toContain('[FACT] Test Entry');
    expect(block.text).toContain('doc://test');
  });

  it('modeOverride takes precedence over constructor mode', () => {
    const formatter = new InjectionFormatter('markdown', 'full');
    const entry = makeEntry({ id: 'k-override' });
    const block = formatter.formatEntry(entry, 'summary');

    expect(block.disclosureMode).toBe('summary');
    expect(block.text).toContain('`id:k-override`');
    expect(block.text).not.toContain('### ');
  });
});

describe('InjectionFormatter — estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a')).toBe(1); // ceil
  });
});
