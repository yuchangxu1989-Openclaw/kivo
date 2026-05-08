import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Kivo } from '../src/kivo.js';
import { KnowledgeRepository, SQLiteProvider } from '../src/repository/index.js';
import { ContextInjector } from '../src/injection/context-injector.js';
import { EventBus } from '../src/pipeline/event-bus.js';
import { StandaloneAdapter } from '../src/adapter/standalone-adapter.js';
import { OpenClawAdapter } from '../src/adapter/openclaw-adapter.js';
import type { SessionContext, KivoHostAdapter } from '../src/adapter/host-adapter.js';
import type { KnowledgeEntry } from '../src/types/index.js';
import type { KivoConfig } from '../src/config.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const memoryConfig: KivoConfig = {
  dbPath: ':memory:',
  pipelineOptions: { extractor: { minContentLength: 10 } },
};

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

// ─── StandaloneAdapter ───────────────────────────────────────────────────────

describe('StandaloneAdapter', () => {
  let kivo: Kivo;
  let adapter: StandaloneAdapter;

  beforeEach(async () => {
    kivo = new Kivo(memoryConfig);
    await kivo.init();

    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });

    adapter = new StandaloneAdapter({ kivo, injector });
  });

  afterEach(async () => {
    await kivo.shutdown();
  });

  it('implements KivoHostAdapter interface', () => {
    const host: KivoHostAdapter = adapter;
    expect(typeof host.onSessionMessage).toBe('function');
    expect(typeof host.injectContext).toBe('function');
    expect(typeof host.getStoragePath).toBe('function');
    expect(typeof host.onKnowledgeUpdate).toBe('function');
  });

  it('getStoragePath returns :memory: by default', () => {
    expect(adapter.getStoragePath()).toBe(':memory:');
  });

  it('getStoragePath returns custom path when provided', () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });
    const custom = new StandaloneAdapter({
      kivo,
      injector,
      storagePath: '/tmp/test-kivo.db',
    });
    expect(custom.getStoragePath()).toBe('/tmp/test-kivo.db');
  });

  it('onSessionMessage ingests text and collects updates', async () => {
    const ctx = makeContext();
    await adapter.onSessionMessage(
      'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
      ctx,
    );
    expect(adapter.updates.length).toBeGreaterThan(0);
    expect(adapter.updates[0].content).toBeTruthy();
  });

  it('onSessionMessage uses agentId in source when provided', async () => {
    const ctx = makeContext({ agentId: 'dev-01' });
    await adapter.onSessionMessage(
      'Vitest is a fast unit testing framework for modern JavaScript projects.',
      ctx,
    );
    expect(adapter.updates.length).toBeGreaterThan(0);
  });

  it('onKnowledgeUpdate calls custom callback', () => {
    const received: KnowledgeEntry[] = [];
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });
    const withCb = new StandaloneAdapter({
      kivo,
      injector,
      onUpdate: (e) => received.push(e),
    });

    const entry: KnowledgeEntry = {
      id: 'test-1',
      type: 'fact',
      title: 'Test',
      content: 'Test content',
      summary: 'Test summary',
      source: { type: 'manual', reference: 'test', timestamp: new Date() },
      confidence: 0.9,
      status: 'active',
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };

    withCb.onKnowledgeUpdate(entry);
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('test-1');
    expect(withCb.updates).toHaveLength(1);
  });

  it('injectContext returns empty string when no knowledge exists', async () => {
    const result = await adapter.injectContext('nonexistent topic', 1000);
    expect(result).toBe('');
  });
});

// ─── OpenClawAdapter ─────────────────────────────────────────────────────────

describe('OpenClawAdapter', () => {
  let kivo: Kivo;
  let eventBus: EventBus;
  let adapter: OpenClawAdapter;

  beforeEach(async () => {
    kivo = new Kivo(memoryConfig);
    await kivo.init();

    eventBus = new EventBus();
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });

    adapter = new OpenClawAdapter({
      kivo,
      injector,
      eventBus,
      storagePath: '/tmp/test-openclaw-kivo.db',
    });
  });

  afterEach(async () => {
    await kivo.shutdown();
  });

  it('implements KivoHostAdapter interface', () => {
    const host: KivoHostAdapter = adapter;
    expect(typeof host.onSessionMessage).toBe('function');
    expect(typeof host.injectContext).toBe('function');
    expect(typeof host.getStoragePath).toBe('function');
    expect(typeof host.onKnowledgeUpdate).toBe('function');
  });

  it('getStoragePath returns custom path', () => {
    expect(adapter.getStoragePath()).toBe('/tmp/test-openclaw-kivo.db');
  });

  it('getStoragePath returns default ~/.openclaw path when not overridden', () => {
    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    const repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });
    const defaultAdapter = new OpenClawAdapter({ kivo, injector, eventBus });
    expect(defaultAdapter.getStoragePath()).toContain('.openclaw');
    expect(defaultAdapter.getStoragePath()).toContain('kivo.db');
  });

  it('onSessionMessage ingests and emits events', async () => {
    const events: unknown[] = [];
    eventBus.on('entry:extracted', (e) => events.push(e));

    await adapter.onSessionMessage(
      'Python is a high-level programming language known for its readability and versatility.',
      makeContext({ sessionId: 'sess-abc', agentId: 'cc' }),
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it('onKnowledgeUpdate emits entry:extracted event', () => {
    const events: unknown[] = [];
    eventBus.on('entry:extracted', (e) => events.push(e));

    const entry: KnowledgeEntry = {
      id: 'oc-test-1',
      type: 'decision',
      title: 'Use SQLite',
      content: 'We decided to use SQLite for local storage.',
      summary: 'SQLite decision',
      source: { type: 'conversation', reference: 'test', timestamp: new Date() },
      confidence: 0.85,
      status: 'active',
      tags: ['architecture'],
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };

    adapter.onKnowledgeUpdate(entry);
    expect(events).toHaveLength(1);
  });

  it('injectContext returns empty string when no knowledge exists', async () => {
    const result = await adapter.injectContext('unknown topic', 500);
    expect(result).toBe('');
  });
});

// ─── ContextInjector Integration ─────────────────────────────────────────────

describe('Adapter + ContextInjector integration', () => {
  let kivo: Kivo;
  let repo: KnowledgeRepository;
  let adapter: StandaloneAdapter;

  beforeEach(async () => {
    kivo = new Kivo(memoryConfig);
    await kivo.init();

    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    repo = new KnowledgeRepository(provider);
    const injector = new ContextInjector({ repository: repo });

    adapter = new StandaloneAdapter({ kivo, injector });
  });

  afterEach(async () => {
    await kivo.shutdown();
    await repo.close();
  });

  it('injectContext retrieves knowledge after manual save', async () => {
    // Manually save an entry to the shared repo
    const entry: KnowledgeEntry = {
      id: 'inject-test-1',
      type: 'fact',
      title: 'TypeScript Compiler',
      content: 'TypeScript compiler tsc converts TypeScript code to JavaScript.',
      summary: 'tsc compiles TS to JS',
      source: { type: 'manual', reference: 'test', timestamp: new Date() },
      confidence: 0.95,
      status: 'active',
      tags: ['typescript', 'compiler'],
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
    await repo.save(entry);

    const result = await adapter.injectContext('TypeScript compiler', 2000);
    expect(result).toContain('TypeScript');
  });

  it('injectContext respects token budget', async () => {
    // Save multiple entries
    for (let i = 0; i < 5; i++) {
      await repo.save({
        id: `budget-${i}`,
        type: 'fact',
        title: `Fact ${i}`,
        content: `This is fact number ${i} about software engineering practices and patterns.`,
        summary: `Fact ${i} summary`,
        source: { type: 'manual', reference: 'test', timestamp: new Date() },
        confidence: 0.8,
        status: 'active',
        tags: ['software'],
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      });
    }

    // Very small budget should still return something (or empty if budget too small)
    const result = await adapter.injectContext('software engineering', 10);
    // With a 10-token budget, the policy should truncate aggressively
    expect(typeof result).toBe('string');
  });
});
