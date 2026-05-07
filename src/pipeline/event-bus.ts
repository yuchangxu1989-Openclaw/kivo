/**
 * EventBus — Simple typed EventEmitter wrapper for pipeline events.
 * Provides loose coupling between pipeline filters (ADR-001).
 */

import { EventEmitter } from 'node:events';
import type { PipelineEvent, PipelineEventType } from '../types/index.js';

export type EventHandler = (event: PipelineEvent) => void | Promise<void>;

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many listeners for pipeline stages
    this.emitter.setMaxListeners(50);
  }

  on(eventType: PipelineEventType, handler: EventHandler): void {
    this.emitter.on(eventType, handler);
  }

  once(eventType: PipelineEventType, handler: EventHandler): void {
    this.emitter.once(eventType, handler);
  }

  off(eventType: PipelineEventType, handler: EventHandler): void {
    this.emitter.off(eventType, handler);
  }

  emit(event: PipelineEvent): void {
    this.emitter.emit(event.type, event);
  }

  /** Subscribe to all pipeline events */
  onAny(handler: EventHandler): void {
    const types: PipelineEventType[] = [
      'task:created', 'task:started', 'stage:entered', 'stage:completed', 'stage:skipped',
      'entry:extracted', 'conflict:detected', 'conflict:resolved',
      'task:completed', 'task:failed', 'pipeline:error', 'pipeline:warning',
    ];
    for (const type of types) {
      this.emitter.on(type, handler);
    }
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
