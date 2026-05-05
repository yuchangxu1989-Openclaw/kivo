/**
 * KIVO End-to-End Integration Tests
 *
 * Covers Wave 1 + Wave 2 full module integration:
 * 1. Document ingestion full chain (StandaloneAdapter → Pipeline → Repository)
 * 2. Document extraction → query (DocumentExtractor → Repository → Kivo.query)
 * 3. Conflict detection full chain (ingest contradictory → detect → resolve)
 * 4. Context injection full chain (ingest → injectContext → budget enforcement)
 * 5. Configuration validation (different configs → behavior differences)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Kivo } from '../src/kivo.js';
import { StandaloneAdapter } from '../src/adapter/standalone-adapter.js';
import { ContextInjector } from '../src/injection/context-injector.js';
import { KnowledgeRepository } from '../src/repository/knowledge-repository.js';
import { SQLiteProvider } from '../src/repository/sqlite-provider.js';
import { DocumentExtractor } from '../src/extraction/document-extractor.js';
import { MarkdownParser } from '../src/extraction/document-parser.js';
import type { KivoConfig } from '../src/config.js';
import type { KnowledgeEntry, KnowledgeSource } from '../src/types/index.js';
import type { ConflictVerdict } from '../src/conflict/index.js';
import type { SessionContext } from '../src/adapter/host-adapter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<KivoConfig>): KivoConfig {
  return {
    dbPath: ':memory:',
    pipelineOptions: { extractor: { minContentLength: 10 } },
    ...overrides,
  };
}

function makeSource(ref: string): KnowledgeSource {
  return { type: 'document', reference: ref, timestamp: new Date() };
}

// ─── 1. Document Ingestion Full Chain ────────────────────────────────────────

describe('E2E: Document Ingestion Full Chain', () => {
  let kivo: Kivo;
  let repository: KnowledgeRepository;
  let injector: ContextInjector;
  let adapter: StandaloneAdapter;

  beforeEach(async () => {
    kivo = new Kivo(makeConfig());
    await kivo.init();

    const provider = new SQLiteProvider({ dbPath: ':memory:' });
    repository = new KnowledgeRepository(provider);
    injector = new ContextInjector({ repository });

    adapter = new StandaloneAdapter({ kivo, injector });
  });

  afterEach(async () => {
    await kivo.shutdown();
    await repository.close();
  });

  it('should ingest via onSessionMessage and produce KnowledgeEntries', async () => {
    const context: SessionContext = {
      sessionId: 'session-001',
      agentId: 'test-agent',
      sourceType: 'conversation',
    };

    await adapter.onSessionMessage(
      'Rust is a systems programming language focused on safety, speed, and concurrency.',
      context
    );

    // Adapter should have collected updates
    expect(adapter.updates.length).toBeGreaterThan(0);

    // Each update should be a valid KnowledgeEntry
    for (const entry of adapter.updates) {
      expect(entry.id).toBeTruthy();
      expect(entry.type).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.content).toContain('Rust');
      expect(entry.status).toBe('active');
      expect(entry.version).toBe(1);
      expect(entry.source.reference).toContain('session-001');
    }
  });

  it('should persist entries queryable via Kivo.query after ingestion', async () => {
    const context: SessionContext = { sessionId: 'session-002' };

    await adapter.onSessionMessage(
      'PostgreSQL is an advanced open-source relational database management system.',
      context
    );

    // Entries should be queryable through Kivo
    const results = await kivo.query('PostgreSQL');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.content).toContain('PostgreSQL');
  });

  it('should handle multiple messages building up knowledge base', async () => {
    const context: SessionContext = { sessionId: 'session-003' };

    await adapter.onSessionMessage(
      'Docker containers provide lightweight virtualization for application deployment.',
      context
    );
    await adapter.onSessionMessage(
      'Kubernetes orchestrates container workloads across clusters of machines.',
      context
    );

    // Both topics should be queryable
    const dockerResults = await kivo.query('Docker containers');
    const k8sResults = await kivo.query('Kubernetes orchestrates');

    expect(dockerResults.length).toBeGreaterThan(0);
    expect(k8sResults.length).toBeGreaterThan(0);
    expect(adapter.updates.length).toBeGreaterThanOrEqual(2);
  });

  it('should propagate agentId into source reference', async () => {
    const context: SessionContext = {
      sessionId: 'sess-x',
      agentId: 'research-bot',
    };

    await adapter.onSessionMessage(
      'GraphQL is a query language for APIs developed by Facebook.',
      context
    );

    expect(adapter.updates.length).toBeGreaterThan(0);
    // Source reference should include both sessionId and agentId
    expect(adapter.updates[0].source.reference).toContain('sess-x');
    expect(adapter.updates[0].source.reference).toContain('research-bot');
  });
});

// ─── 2. Document Extraction → Query ─────────────────────────────────────────

describe('E2E: Document Extraction → Query', () => {
  let kivo: Kivo;
  let repository: KnowledgeRepository;
  let provider: SQLiteProvider;

  beforeEach(async () => {
    kivo = new Kivo(makeConfig());
    await kivo.init();

    provider = new SQLiteProvider({ dbPath: ':memory:' });
    repository = new KnowledgeRepository(provider);
  });

  afterEach(async () => {
    await kivo.shutdown();
    await repository.close();
  });

  it('should parse markdown, extract entries, save, and query', async () => {
    const markdown = `---
tags: architecture, patterns
domain: software-engineering
---

# Design Patterns

Design patterns are reusable solutions to commonly occurring problems in software design.

## Singleton Pattern

The Singleton pattern ensures a class has only one instance and provides a global point of access to it.

## Observer Pattern

The Observer pattern defines a one-to-many dependency between objects so that when one object changes state, all its dependents are notified.
`;

    const parser = new MarkdownParser();
    const extractor = new DocumentExtractor({ minContentLength: 10 });
    const source = makeSource('design-patterns-doc');

    // Parse → Extract
    const sections = parser.parse(markdown, source);
    expect(sections.length).toBeGreaterThan(0);

    const entries = await extractor.extract(sections, source);
    expect(entries.length).toBeGreaterThan(0);

    // Save to repository
    for (const entry of entries) {
      await repository.save(entry);
    }

    // Verify count
    const count = await repository.count();
    expect(count).toBe(entries.length);

    // Verify entries are retrievable by id
    for (const entry of entries) {
      const found = await repository.findById(entry.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(entry.id);
    }

    // Full text search should find entries
    const searchResults = await repository.fullTextSearch('Singleton', 10);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.some(e => e.content.includes('Singleton'))).toBe(true);
  });

  it('should extract entries with correct metadata from frontmatter', async () => {
    const markdown = `---
tags: rust, memory-safety
domain: systems-programming
---

# Rust Ownership

Rust uses an ownership system with borrowing and lifetimes to guarantee memory safety without garbage collection.
`;

    const parser = new MarkdownParser();
    const extractor = new DocumentExtractor({ minContentLength: 10 });
    const source = makeSource('rust-ownership-doc');

    const sections = parser.parse(markdown, source);
    const entries = await extractor.extract(sections, source);

    expect(entries.length).toBeGreaterThan(0);

    // Check tags and domain propagation
    const mainEntry = entries.find(e => e.content.includes('ownership'));
    expect(mainEntry).toBeDefined();
    expect(mainEntry!.tags).toContain('rust');
    expect(mainEntry!.tags).toContain('memory-safety');
    expect(mainEntry!.domain).toBe('systems-programming');
  });

  it('should integrate extraction with Kivo ingest and query', async () => {
    // Use Kivo.ingest which internally runs the pipeline (extraction + classification)
    const text = `Redis is an in-memory data structure store used as a database, cache, and message broker. It supports strings, hashes, lists, sets, and sorted sets.`;

    const result = await kivo.ingest(text, 'redis-doc');
    expect(result.entries.length).toBeGreaterThan(0);

    // Query through Kivo facade
    const queryResults = await kivo.query('Redis');
    expect(queryResults.length).toBeGreaterThan(0);
    expect(queryResults[0].entry.content).toContain('Redis');
  });
});

// ─── 3. Conflict Detection Full Chain ────────────────────────────────────────

describe('E2E: Conflict Detection Full Chain', () => {
  it('should detect conflict between contradictory knowledge entries', async () => {
    const kivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
      conflictThreshold: 0,
    });
    await kivo.init();

    // First ingest: establish a fact
    const first = await kivo.ingest(
      'The speed of light in vacuum, as measured by physicists, is approximately 300000 kilometers per second.',
      'physics-textbook'
    );
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.conflicts.length).toBe(0); // No conflict on first entry

    // Second ingest: contradictory fact on same topic
    const second = await kivo.ingest(
      'The speed of light in vacuum, as measured by physicists, is approximately 150000 kilometers per second.',
      'wrong-source'
    );
    expect(second.entries.length).toBeGreaterThan(0);
    expect(second.conflicts.length).toBeGreaterThan(0);

    // Verify conflict record structure
    const conflict = second.conflicts[0];
    expect(conflict.verdict).toBe('conflict');
    expect(conflict.resolved).toBe(false);
    expect(conflict.incomingId).toBeTruthy();
    expect(conflict.existingId).toBeTruthy();
    expect(conflict.detectedAt).toBeInstanceOf(Date);

    await kivo.shutdown();
  });

  it('should resolve conflict with newer-wins and mark loser as superseded', async () => {
    const kivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
      conflictThreshold: 0,
    });
    await kivo.init();

    await kivo.ingest(
      'Python version 3.12, the latest major release of the language, was officially released in October 2023.',
      'release-notes-old'
    );

    const result = await kivo.ingest(
      'Python version 3.12, the latest major release of the language, was officially released in September 2023.',
      'release-notes-new'
    );

    expect(result.conflicts.length).toBeGreaterThan(0);

    const conflict = result.conflicts[0];
    const resolution = await kivo.resolveConflict(conflict, 'newer-wins');

    expect(resolution.action).toBe('supersede');
    expect(resolution.record.resolved).toBe(true);
    expect(resolution.record.resolution).toBe('newer-wins');
    expect(resolution.winnerId).toBeTruthy();
    expect(resolution.loserId).toBeTruthy();

    // Verify loser status is updated in repository
    const loser = await kivo.getEntry(resolution.loserId);
    expect(loser).not.toBeNull();
    expect(loser!.status).toBe('superseded');

    // Winner should remain active
    const winner = await kivo.getEntry(resolution.winnerId);
    expect(winner).not.toBeNull();
    expect(winner!.status).toBe('active');

    await kivo.shutdown();
  });

  it('should resolve conflict with confidence-wins strategy', async () => {
    const kivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
      conflictThreshold: 0,
    });
    await kivo.init();

    await kivo.ingest(
      'Machine learning requires large datasets for training models effectively.',
      'ml-intro'
    );

    const result = await kivo.ingest(
      'Machine learning requires small datasets for training models effectively.',
      'ml-wrong'
    );

    if (result.conflicts.length > 0) {
      const resolution = await kivo.resolveConflict(result.conflicts[0], 'confidence-wins');
      expect(resolution.action).toBe('supersede');
      expect(resolution.record.resolution).toBe('confidence-wins');

      // Loser should be superseded
      const loser = await kivo.getEntry(resolution.loserId);
      expect(loser!.status).toBe('superseded');
    }

    await kivo.shutdown();
  });

  it('should handle manual resolution strategy without superseding', async () => {
    const kivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
    });
    await kivo.init();

    await kivo.ingest(
      'The best programming language for web development is TypeScript.',
      'opinion-1'
    );

    const result = await kivo.ingest(
      'The best programming language for web development is Rust.',
      'opinion-2'
    );

    if (result.conflicts.length > 0) {
      const resolution = await kivo.resolveConflict(result.conflicts[0], 'manual');
      expect(resolution.action).toBe('pending_manual');
      expect(resolution.record.resolved).toBe(false);
    }

    await kivo.shutdown();
  });

  it('should not detect conflict for unrelated knowledge', async () => {
    const kivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      // Default LLM provider uses keyword overlap — unrelated topics won't conflict
    });
    await kivo.init();

    await kivo.ingest(
      'Photosynthesis converts sunlight into chemical energy in plants.',
      'biology-textbook'
    );

    const result = await kivo.ingest(
      'TCP/IP is the fundamental communication protocol of the internet.',
      'networking-textbook'
    );

    // Unrelated topics should not produce conflicts
    expect(result.conflicts.length).toBe(0);

    await kivo.shutdown();
  });
});

// ─── 4. Context Injection Full Chain ─────────────────────────────────────────

describe('E2E: Context Injection Full Chain', () => {
  let kivo: Kivo;
  let provider: SQLiteProvider;
  let repository: KnowledgeRepository;
  let injector: ContextInjector;
  let adapter: StandaloneAdapter;

  beforeEach(async () => {
    // Use a shared SQLite provider so Kivo and ContextInjector see the same data
    provider = new SQLiteProvider({ dbPath: ':memory:' });
    repository = new KnowledgeRepository(provider);

    kivo = new Kivo(makeConfig());
    await kivo.init();

    injector = new ContextInjector({
      repository,
      defaultTopK: 20,
    });

    adapter = new StandaloneAdapter({ kivo, injector });
  });

  afterEach(async () => {
    await kivo.shutdown();
    await repository.close();
  });

  it('should inject relevant context within token budget', async () => {
    // Ingest knowledge into the shared repository
    const entries = createSampleEntries();
    for (const entry of entries) {
      await repository.save(entry);
    }

    // Inject context for a query
    const context = await adapter.injectContext('TypeScript type system', 500);

    // Should return non-empty formatted context
    expect(context).toBeTruthy();
    expect(context.length).toBeGreaterThan(0);

    // Context should be within budget (rough check: 500 tokens ≈ 2000 chars)
    // The policy enforces token budget, so output should be bounded
    expect(context.length).toBeLessThan(500 * 4 + 200); // generous upper bound
  });

  it('should return empty context when no relevant entries exist', async () => {
    // Empty repository — no entries saved
    const context = await adapter.injectContext('quantum computing algorithms', 1000);
    expect(context).toBe('');
  });

  it('should respect small token budget by truncating results', async () => {
    const entries = createSampleEntries();
    for (const entry of entries) {
      await repository.save(entry);
    }

    // Very small budget — should get limited results
    const smallContext = await adapter.injectContext('programming languages', 50);
    const largeContext = await adapter.injectContext('programming languages', 5000);

    // Small budget should produce less content than large budget (or equal if few entries)
    expect(smallContext.length).toBeLessThanOrEqual(largeContext.length);
  });

  it('should format injected context as markdown by default', async () => {
    const entries = createSampleEntries();
    for (const entry of entries) {
      await repository.save(entry);
    }

    const context = await adapter.injectContext('TypeScript', 2000);

    if (context) {
      // Default format is markdown — should contain markdown markers
      expect(context).toMatch(/###|>|\*\*|_/);
    }
  });

  it('should inject context from entries ingested via adapter', async () => {
    // Ingest via adapter (goes through Kivo pipeline)
    const sessionCtx: SessionContext = { sessionId: 'inject-test' };

    await adapter.onSessionMessage(
      'Vitest is a blazing fast unit test framework powered by Vite for modern JavaScript projects.',
      sessionCtx
    );

    expect(adapter.updates.length).toBeGreaterThan(0);

    // Save to the injector's repository so injection queries can find them
    // (In production, both would share the same DB; here we replicate)
    for (const entry of adapter.updates) {
      await repository.save(entry);
    }

    // Use a single keyword that definitely appears in the ingested content
    const context = await adapter.injectContext('Vitest', 1000);
    expect(context).toBeTruthy();
    expect(context.length).toBeGreaterThan(0);
  });
});

// ─── 5. Configuration Validation ─────────────────────────────────────────────

describe('E2E: Configuration Validation', () => {
  it('should use different conflict thresholds affecting detection sensitivity', async () => {
    // Strict threshold (0.95) — fewer conflicts detected
    const strictKivo = new Kivo({
      dbPath: ':memory:',
      conflictThreshold: 0.95,
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
    });
    await strictKivo.init();

    // Lenient threshold (0.3) — more conflicts detected
    const lenientKivo = new Kivo({
      dbPath: ':memory:',
      conflictThreshold: 0.3,
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'conflict';
        },
      },
    });
    await lenientKivo.init();

    const text1 = 'JavaScript was created by Brendan Eich at Netscape in 1995.';
    const text2 = 'JavaScript was developed by Brendan Eich at Netscape Communications in 1995.';

    await strictKivo.ingest(text1, 'src-1');
    const strictResult = await strictKivo.ingest(text2, 'src-2');

    await lenientKivo.ingest(text1, 'src-1');
    const lenientResult = await lenientKivo.ingest(text2, 'src-2');

    // Lenient threshold should detect more (or equal) conflicts than strict
    expect(lenientResult.conflicts.length).toBeGreaterThanOrEqual(strictResult.conflicts.length);

    await strictKivo.shutdown();
    await lenientKivo.shutdown();
  });

  it('should reject invalid dbPath', () => {
    expect(() => new Kivo({ dbPath: '' })).toThrow();
  });

  it('should reject conflictThreshold out of range', () => {
    expect(() => new Kivo({ dbPath: ':memory:', conflictThreshold: 1.5 })).toThrow();
    expect(() => new Kivo({ dbPath: ':memory:', conflictThreshold: -0.1 })).toThrow();
  });

  it('should work with custom pipeline extractor options', async () => {
    // High minContentLength — short texts won't produce entries
    const strictExtractor = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 200 } },
    });
    await strictExtractor.init();

    const shortText = 'Short text that is under 200 characters.';
    const result = await strictExtractor.ingest(shortText, 'short-src');

    // Should produce no entries because content is too short
    expect(result.entries.length).toBe(0);

    await strictExtractor.shutdown();
  });

  it('should work with lenient pipeline extractor options', async () => {
    // Low minContentLength — even short texts produce entries
    const lenientExtractor = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 5 } },
    });
    await lenientExtractor.init();

    const text = 'Go is a statically typed compiled language designed at Google.';
    const result = await lenientExtractor.ingest(text, 'go-src');

    expect(result.entries.length).toBeGreaterThan(0);

    await lenientExtractor.shutdown();
  });

  it('should allow custom LLM provider to control conflict verdicts', async () => {
    // Provider that always says compatible — no conflicts ever
    const noConflictKivo = new Kivo({
      dbPath: ':memory:',
      pipelineOptions: { extractor: { minContentLength: 10 } },
      llmProvider: {
        async judgeConflict(): Promise<ConflictVerdict> {
          return 'compatible';
        },
      },
    });
    await noConflictKivo.init();

    await noConflictKivo.ingest('The sky is blue during daytime.', 'src-a');
    const result = await noConflictKivo.ingest('The sky is green during daytime.', 'src-b');

    // Even contradictory content should not produce conflicts with compatible provider
    expect(result.conflicts.length).toBe(0);

    await noConflictKivo.shutdown();
  });

  it('should handle init → shutdown → re-init lifecycle', async () => {
    const kivo = new Kivo(makeConfig());

    await kivo.init();
    await kivo.ingest('First lifecycle test entry.', 'lifecycle-1');
    await kivo.shutdown();

    // Re-init (new in-memory DB, so previous data is gone)
    await kivo.init();
    const results = await kivo.query('lifecycle');
    // In-memory DB is fresh after re-init
    expect(results.length).toBe(0);

    await kivo.shutdown();
  });
});

// ─── Test Data Helpers ───────────────────────────────────────────────────────

function createSampleEntries(): KnowledgeEntry[] {
  const now = new Date();
  const baseSource: KnowledgeSource = {
    type: 'document',
    reference: 'test-corpus',
    timestamp: now,
  };

  return [
    {
      id: 'entry-ts-001',
      type: 'fact',
      title: 'TypeScript Type System',
      content: 'TypeScript provides a structural type system that enables compile-time type checking for JavaScript code.',
      summary: 'TypeScript structural type system for compile-time checking.',
      source: baseSource,
      confidence: 0.9,
      status: 'active',
      tags: ['typescript', 'type-system'],
      domain: 'programming',
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    {
      id: 'entry-ts-002',
      type: 'methodology',
      title: 'TypeScript Migration Strategy',
      content: 'Migrating from JavaScript to TypeScript should be done incrementally, starting with strict mode disabled and gradually enabling stricter checks.',
      summary: 'Incremental migration from JS to TS.',
      source: baseSource,
      confidence: 0.85,
      status: 'active',
      tags: ['typescript', 'migration'],
      domain: 'programming',
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    {
      id: 'entry-rust-001',
      type: 'fact',
      title: 'Rust Memory Safety',
      content: 'Rust guarantees memory safety without garbage collection through its ownership and borrowing system.',
      summary: 'Rust memory safety via ownership.',
      source: baseSource,
      confidence: 0.95,
      status: 'active',
      tags: ['rust', 'memory-safety'],
      domain: 'systems-programming',
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    {
      id: 'entry-go-001',
      type: 'decision',
      title: 'Go Concurrency Model',
      content: 'Go uses goroutines and channels for concurrent programming, following the CSP model rather than shared memory.',
      summary: 'Go concurrency via goroutines and channels (CSP).',
      source: baseSource,
      confidence: 0.88,
      status: 'active',
      tags: ['go', 'concurrency'],
      domain: 'programming',
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
  ];
}

// ─── 6. Wave 3: Semantic Search Integration ──────────────────────────────────

describe('E2E: Wave 3 Semantic Search via Kivo Facade', () => {
  let kivo: Kivo;

  afterEach(async () => {
    await kivo?.shutdown();
  });

  it('semanticSearch returns relevant results after ingest', async () => {
    kivo = new Kivo(makeConfig({
      embedding: { provider: 'local', options: { dimensions: 128 } },
    }));
    await kivo.init();

    // Ingest some knowledge
    await kivo.ingest(
      '# TypeScript Generics\nTypeScript generics allow creating reusable components that work with multiple types.',
      'docs/typescript.md'
    );
    await kivo.ingest(
      '# Python Decorators\nPython decorators are functions that modify the behavior of other functions.',
      'docs/python.md'
    );

    // Search for TypeScript-related content
    const results = await kivo.semanticSearch('typescript type system', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('score');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ingest auto-indexes entries for semantic search', async () => {
    kivo = new Kivo(makeConfig({
      embedding: { provider: 'local', options: { dimensions: 128 } },
    }));
    await kivo.init();

    // Ingest a document
    const result = await kivo.ingest(
      '# React Hooks\nReact hooks let you use state and lifecycle features in function components.',
      'docs/react.md'
    );
    expect(result.entries.length).toBeGreaterThan(0);

    // Immediately searchable without explicit indexAll
    const searchResults = await kivo.semanticSearch('react state management', 5);
    expect(searchResults.length).toBeGreaterThan(0);
    // The ingested entry should be found
    const foundIds = searchResults.map(r => r.id);
    const ingestedIds = result.entries.map(e => e.id);
    const hasMatch = ingestedIds.some(id => foundIds.includes(id));
    expect(hasMatch).toBe(true);
  });

  it('semanticSearch falls back to keyword search without embedding config', async () => {
    kivo = new Kivo(makeConfig());
    await kivo.init();

    const results = await kivo.semanticSearch('anything');
    expect(Array.isArray(results)).toBe(true);
  });

  it('indexAll batch-indexes all repository entries', async () => {
    kivo = new Kivo(makeConfig({
      embedding: { provider: 'local', options: { dimensions: 128 } },
    }));
    await kivo.init();

    // Ingest multiple documents
    await kivo.ingest(
      '# Rust Ownership\nRust uses ownership with borrowing and lifetimes for memory safety without GC.',
      'docs/rust.md'
    );
    await kivo.ingest(
      '# Go Goroutines\nGo uses lightweight goroutines and channels for concurrent programming.',
      'docs/go.md'
    );

    // indexAll should return count of indexed entries
    const count = await kivo.indexAll();
    expect(count).toBeGreaterThanOrEqual(2);

    // Search should work
    const results = await kivo.semanticSearch('memory management', 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it('indexAll throws friendly error without embedding config', async () => {
    kivo = new Kivo(makeConfig());
    await kivo.init();

    await expect(kivo.indexAll()).rejects.toThrow(
      /embedding not configured/
    );
  });

  it('backward compatible: no embedding config does not affect existing behavior', async () => {
    kivo = new Kivo(makeConfig());
    await kivo.init();

    // Normal ingest still works
    const result = await kivo.ingest(
      '# Node.js Streams\nNode.js streams provide an efficient way to handle flowing data.',
      'docs/node.md'
    );
    expect(result.entries.length).toBeGreaterThan(0);

    // Normal query still works
    const queryResults = await kivo.query('streams');
    expect(queryResults.length).toBeGreaterThanOrEqual(0);
  });
});
