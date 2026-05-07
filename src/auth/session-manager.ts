import type { Session, SessionOptions } from './auth-types.js';
import { DEFAULT_SESSION_TIMEOUT_MS } from './auth-types.js';

export interface SessionManagerOptions {
  timeoutMs?: number;
  idFactory?: () => string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timeoutMs: number;
  private readonly idFactory: () => string;

  constructor(options: SessionManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  create(userId: string, options?: SessionOptions): Session {
    const now = new Date();
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    const session: Session = {
      id: this.idFactory(),
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + timeout),
      active: true,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  validate(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return null;
    if (new Date() > session.expiresAt) {
      session.active = false;
      return null;
    }
    return session;
  }

  invalidate(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return false;
    session.active = false;
    return true;
  }

  invalidateAllForUser(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.active) {
        session.active = false;
        count++;
      }
    }
    return count;
  }

  getActiveSessions(userId?: string): Session[] {
    const now = new Date();
    const result: Session[] = [];
    for (const session of this.sessions.values()) {
      if (!session.active || now > session.expiresAt) continue;
      if (userId && session.userId !== userId) continue;
      result.push(session);
    }
    return result;
  }
}
