import { describe, expect, it } from 'vitest';
import { DomainAccessChecker, DEFAULT_ACCESS_CONFIG } from '../src/access-control/index.js';
import type { DomainAccessConfig } from '../src/access-control/index.js';
import type { KnowledgeEntry } from '../src/types/index.js';

function makeEntry(domain?: string): KnowledgeEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    title: 'test',
    content: 'test content',
    summary: 'test',
    source: { type: 'manual', reference: 'test', timestamp: new Date() },
    confidence: 0.9,
    status: 'active',
    tags: [],
    domain,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
}

describe('DomainAccessChecker', () => {
  const config: DomainAccessConfig = {
    rules: [
      { domainId: 'engineering', allowedRoles: ['admin', 'editor'] },
      { domainId: 'finance', allowedRoles: ['admin'] },
      { domainId: 'public', allowedRoles: ['admin', 'editor', 'viewer'] },
    ],
    defaultPolicy: 'deny',
  };

  // ── AC1: 检索按 callerRole 过滤 ──

  it('admin can access all configured domains', () => {
    const checker = new DomainAccessChecker(config);
    expect(checker.canAccess('admin', 'engineering')).toBe(true);
    expect(checker.canAccess('admin', 'finance')).toBe(true);
    expect(checker.canAccess('admin', 'public')).toBe(true);
  });

  it('editor can access engineering and public but not finance', () => {
    const checker = new DomainAccessChecker(config);
    expect(checker.canAccess('editor', 'engineering')).toBe(true);
    expect(checker.canAccess('editor', 'finance')).toBe(false);
    expect(checker.canAccess('editor', 'public')).toBe(true);
  });

  it('viewer can only access public', () => {
    const checker = new DomainAccessChecker(config);
    expect(checker.canAccess('viewer', 'engineering')).toBe(false);
    expect(checker.canAccess('viewer', 'finance')).toBe(false);
    expect(checker.canAccess('viewer', 'public')).toBe(true);
  });

  it('deny policy blocks unconfigured domains', () => {
    const checker = new DomainAccessChecker(config);
    expect(checker.canAccess('admin', 'unknown-domain')).toBe(false);
  });

  // ── AC2: 默认策略 allow-all ──

  it('allow-all policy permits unconfigured domains', () => {
    const checker = new DomainAccessChecker({
      rules: [{ domainId: 'restricted', allowedRoles: ['admin'] }],
      defaultPolicy: 'allow-all',
    });
    expect(checker.canAccess('viewer', 'any-domain')).toBe(true);
    expect(checker.canAccess('viewer', 'restricted')).toBe(false);
  });

  // ── AC1: filterEntries ──

  it('filters entries by caller role', () => {
    const checker = new DomainAccessChecker(config);
    const entries = [
      makeEntry('engineering'),
      makeEntry('finance'),
      makeEntry('public'),
    ];
    const editorView = checker.filterEntries(entries, 'editor');
    expect(editorView).toHaveLength(2);
    expect(editorView.map(e => e.domain)).toEqual(['engineering', 'public']);
  });

  it('entries without domain use "default"', () => {
    const checker = new DomainAccessChecker(config);
    const entries = [makeEntry(undefined)];
    // default domain not in rules, deny policy → filtered out
    expect(checker.filterEntries(entries, 'viewer')).toHaveLength(0);
  });

  // ── AC3: getAccessibleDomains ──

  it('returns accessible domains for role', () => {
    const checker = new DomainAccessChecker(config);
    const adminDomains = checker.getAccessibleDomains('admin');
    expect(adminDomains).toContain('engineering');
    expect(adminDomains).toContain('finance');
    expect(adminDomains).toContain('public');
  });

  it('includes wildcard for allow-all policy', () => {
    const checker = new DomainAccessChecker({ ...config, defaultPolicy: 'allow-all' });
    const domains = checker.getAccessibleDomains('viewer');
    expect(domains).toContain('*');
  });

  // ── AC4: canResearch ──

  it('canResearch delegates to canAccess', () => {
    const checker = new DomainAccessChecker(config);
    expect(checker.canResearch('editor', 'engineering')).toBe(true);
    expect(checker.canResearch('viewer', 'finance')).toBe(false);
  });

  // ── Config management ──

  it('updateConfig replaces rules', () => {
    const checker = new DomainAccessChecker(config);
    checker.updateConfig({ rules: [], defaultPolicy: 'allow-all' });
    expect(checker.canAccess('viewer', 'finance')).toBe(true);
  });

  it('getConfig returns copy', () => {
    const checker = new DomainAccessChecker(config);
    const cfg = checker.getConfig();
    expect(cfg.rules).toHaveLength(3);
    cfg.rules.push({ domainId: 'hacked', allowedRoles: ['viewer'] });
    expect(checker.listRules()).toHaveLength(3); // original unchanged
  });

  it('default config allows all', () => {
    const checker = new DomainAccessChecker();
    expect(checker.canAccess('viewer', 'anything')).toBe(true);
  });
});
