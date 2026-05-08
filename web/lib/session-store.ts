/**
 * In-memory session token store (single-process).
 * Tokens are random UUIDs — no deterministic hash from password.
 */

interface SessionData {
  createdAt: number;
  identity: string;
}

const sessions = new Map<string, SessionData>();

export function addSession(token: string, identity: string = ''): void {
  sessions.set(token, { createdAt: Date.now(), identity });
}

export function hasSession(token: string): boolean {
  return sessions.has(token);
}

export function getSessionIdentity(token: string): string {
  return sessions.get(token)?.identity ?? '';
}

export function removeSession(token: string): void {
  sessions.delete(token);
}

export function clearAllSessions(): void {
  sessions.clear();
}
