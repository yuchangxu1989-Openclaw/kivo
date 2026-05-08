import { randomUUID } from 'node:crypto';
import type { ConversationMessage } from '../extraction/conversation-extractor.js';
import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';
import type { SignalDetector } from '../intent-signal/signal-detector.js';
import type { IntentSignal } from '../intent-signal/signal-types.js';

export interface ConversationCollectorDeps {
  signalDetector: SignalDetector;
  onEntries: (entries: KnowledgeEntry[]) => Promise<void>;
}

export class ConversationCollector {
  private readonly deps: ConversationCollectorDeps;

  constructor(deps: ConversationCollectorDeps) {
    this.deps = deps;
  }

  async handleSubagentEnded(evt: {
    taskPrompt?: string;
    output?: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<void> {
    const messages = this.assembleFromSubagent(evt);
    if (messages.length === 0) return;
    await this.processMessages(messages, evt.agentId ?? 'subagent', evt.sessionId);
  }

  async handleSessionEnded(evt: {
    messages?: Array<{ role: string; content: string }>;
    sessionId?: string;
  }): Promise<void> {
    const messages: ConversationMessage[] = (evt.messages ?? []).map(m => ({
      role: m.role,
      content: m.content,
    }));
    if (messages.length === 0) return;
    await this.processMessages(messages, 'main-session', evt.sessionId);
  }

  private assembleFromSubagent(evt: {
    taskPrompt?: string;
    output?: string;
  }): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    if (evt.taskPrompt) {
      messages.push({ role: 'user', content: evt.taskPrompt });
    }
    if (evt.output) {
      messages.push({ role: 'assistant', content: evt.output });
    }
    return messages;
  }

  private async processMessages(
    messages: ConversationMessage[],
    agent: string,
    sessionId?: string,
  ): Promise<void> {
    const signals = await this.deps.signalDetector.detect(messages);
    if (signals.length === 0) return;

    const source: KnowledgeSource = {
      type: 'conversation',
      reference: sessionId ?? `session-${Date.now()}`,
      timestamp: new Date(),
      agent,
    };

    const entries = signals.map(signal => this.signalToEntry(signal, source));
    await this.deps.onEntries(entries);
  }

  private signalToEntry(signal: IntentSignal, source: KnowledgeSource): KnowledgeEntry {
    const now = new Date();
    const positiveBlock = signal.positives.length > 0
      ? `\nDo: ${signal.positives.join('; ')}` : '';
    const negativeBlock = signal.negatives.length > 0
      ? `\nDon't: ${signal.negatives.join('; ')}` : '';
    const content = `${signal.content}${positiveBlock}${negativeBlock}`;

    return {
      id: randomUUID(),
      type: 'intent',
      title: signal.title,
      content,
      summary: signal.content,
      source: {
        ...source,
        context: signal.sourceFragment,
      },
      confidence: signal.confidence,
      status: 'active',
      tags: [...signal.tags, `signal:${signal.type}`],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  }
}
