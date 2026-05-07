import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentImportService } from '../document-import-service.js';
import type { ImportEvent, ImportEventHandler, SourceLocation } from '../document-import-service.js';
import type { ExtractedCandidate } from '../workbench-types.js';

describe('DocumentImportService — AC2 progress events + AC4 source locations', () => {
  let service: DocumentImportService;
  let events: ImportEvent[];
  let handler: ImportEventHandler;

  beforeEach(() => {
    service = new DocumentImportService();
    events = [];
    handler = (evt) => events.push(evt);
    service.on(handler);
  });

  // ── AC2: Progress events ──

  it('emits status-changed on task creation', () => {
    service.createTask('test.md', 'markdown', 1024);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('status-changed');
    expect(events[0].payload.status).toBe('uploading');
  });

  it('emits progress events on updateProgress', () => {
    const task = service.createTask('test.pdf', 'pdf', 2048);
    events = []; // clear creation event

    service.updateProgress(task.id, 3, 10);
    const progressEvt = events.find((e) => e.type === 'progress');
    expect(progressEvt).toBeDefined();
    expect(progressEvt!.payload.processedSegments).toBe(3);
    expect(progressEvt!.payload.totalSegments).toBe(10);
    expect(progressEvt!.payload.percentComplete).toBe(30);
  });

  it('emits status-changed when transitioning to reviewing', () => {
    const task = service.createTask('test.md', 'markdown', 512);
    events = [];

    service.updateProgress(task.id, 5, 5);
    const statusEvt = events.find((e) => e.type === 'status-changed');
    expect(statusEvt).toBeDefined();
    expect(statusEvt!.payload.status).toBe('reviewing');
  });

  it('does not emit duplicate status-changed if status unchanged', () => {
    const task = service.createTask('test.md', 'markdown', 512);
    events = [];

    service.updateProgress(task.id, 2, 10); // extracting
    service.updateProgress(task.id, 3, 10); // still extracting
    const statusEvents = events.filter((e) => e.type === 'status-changed');
    // First call transitions from uploading→extracting, second stays extracting
    expect(statusEvents).toHaveLength(1);
  });

  it('emits candidate-extracted for each candidate added', () => {
    const task = service.createTask('test.md', 'markdown', 512);
    events = [];

    const candidates: ExtractedCandidate[] = [
      { id: 'c1', type: 'fact', title: 'Fact 1', content: 'content', sourceLocation: 'p1' },
      { id: 'c2', type: 'intent', title: 'Intent 1', content: 'content', sourceLocation: 'p2' },
    ];
    service.addCandidates(task.id, candidates);

    const extractEvents = events.filter((e) => e.type === 'candidate-extracted');
    expect(extractEvents).toHaveLength(2);
    expect(extractEvents[0].payload.candidateId).toBe('c1');
    expect(extractEvents[1].payload.candidateId).toBe('c2');
  });

  it('emits completed event on finalize', () => {
    const task = service.createTask('test.md', 'markdown', 512);
    const candidates: ExtractedCandidate[] = [
      { id: 'c1', type: 'fact', title: 'F1', content: 'c', sourceLocation: 'p1', accepted: true },
    ];
    service.addCandidates(task.id, candidates);
    events = [];

    service.finalize(task.id);
    const completedEvt = events.find((e) => e.type === 'completed');
    expect(completedEvt).toBeDefined();
    expect(completedEvt!.payload.totalExtracted).toBe(1);
  });

  it('off() unsubscribes handler', () => {
    service.off(handler);
    service.createTask('test.md', 'markdown', 512);
    expect(events).toHaveLength(0);
  });

  // ── AC4: Source location index ──

  it('stores and retrieves source locations for candidates', () => {
    const task = service.createTask('doc.pdf', 'pdf', 4096);
    const candidates: ExtractedCandidate[] = [
      { id: 'c1', type: 'fact', title: 'F1', content: 'content', sourceLocation: 'page 3' },
    ];
    const locations: SourceLocation[] = [
      {
        candidateId: 'c1',
        fileName: 'doc.pdf',
        pageOrLine: 'page 3',
        charRange: [1200, 1450],
        contextSnippet: '...the key finding is that...',
      },
    ];
    service.addCandidates(task.id, candidates, locations);

    const loc = service.getSourceLocation(task.id, 'c1');
    expect(loc).toBeDefined();
    expect(loc!.pageOrLine).toBe('page 3');
    expect(loc!.charRange).toEqual([1200, 1450]);
    expect(loc!.contextSnippet).toContain('key finding');
  });

  it('returns undefined for unknown candidate', () => {
    const task = service.createTask('doc.md', 'markdown', 512);
    expect(service.getSourceLocation(task.id, 'nonexistent')).toBeUndefined();
  });

  it('getSourceLocations returns all locations for a task', () => {
    const task = service.createTask('doc.md', 'markdown', 512);
    const candidates: ExtractedCandidate[] = [
      { id: 'c1', type: 'fact', title: 'F1', content: 'c', sourceLocation: 'line 10' },
      { id: 'c2', type: 'intent', title: 'I1', content: 'c', sourceLocation: 'line 25' },
    ];
    const locations: SourceLocation[] = [
      { candidateId: 'c1', fileName: 'doc.md', pageOrLine: 'lines 10-15', charRange: [100, 200], contextSnippet: 'snippet 1' },
      { candidateId: 'c2', fileName: 'doc.md', pageOrLine: 'lines 25-30', charRange: [400, 500], contextSnippet: 'snippet 2' },
    ];
    service.addCandidates(task.id, candidates, locations);

    const allLocs = service.getSourceLocations(task.id);
    expect(allLocs).toHaveLength(2);
  });

  it('returns empty array for unknown task', () => {
    expect(service.getSourceLocations('nonexistent')).toEqual([]);
  });

  it('works without source locations (backward compatible)', () => {
    const task = service.createTask('doc.md', 'markdown', 512);
    const candidates: ExtractedCandidate[] = [
      { id: 'c1', type: 'fact', title: 'F1', content: 'c', sourceLocation: 'p1' },
    ];
    // No source locations passed
    service.addCandidates(task.id, candidates);
    expect(service.getSourceLocation(task.id, 'c1')).toBeUndefined();
    expect(service.getSourceLocations(task.id)).toEqual([]);
  });
});
