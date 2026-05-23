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

/** FR-FIX-14 AC4: List all active sessions for the sessions management UI. */
export function getAllSessions(): Array<{ token: string; identity: string; createdAt: number }> {
  const result: Array<{ token: string; identity: string; createdAt: number }> = [];
  for (const [token, data] of sessions) {
    result.push({ token, identity: data.identity, createdAt: data.createdAt });
  }
  return result;
}
