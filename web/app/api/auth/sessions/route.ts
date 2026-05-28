/**
 * POST /api/auth/sessions/revoke-all
 * FR-FIX-14 AC3: Force logout all other sessions.
 * GET /api/auth/sessions
 * FR-FIX-14 AC4: List active sessions.
 */

import { NextResponse } from 'next/server';
import {
  clearAllSessions,
  addSession,
  getAllSessions,
} from '@/lib/session-store';

const COOKIE_NAME = 'kivo_session';

function getCurrentToken(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] || null;
}

export async function GET(request: Request) {
  try {
    const currentToken = getCurrentToken(request);
    const sessions = getAllSessions();

    const list = sessions.map((s) => ({
      id: s.token,
      displayId: s.token.slice(0, 8) + '...',
      identity: s.identity || '匿名',
      createdAt: new Date(s.createdAt).toISOString(),
      isCurrent: s.token === currentToken,
    }));

    return NextResponse.json({ data: list });
  } catch {
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const currentToken = getCurrentToken(request);

    if (!currentToken) {
      return NextResponse.json({ error: 'No active session' }, { status: 401 });
    }

    // Clear all sessions, then re-add current
    const sessions = getAllSessions();
    const currentSession = sessions.find((s) => s.token === currentToken);
    clearAllSessions();

    if (currentSession) {
      addSession(currentToken, currentSession.identity);
    }

    const revokedCount = sessions.length - (currentSession ? 1 : 0);
    return NextResponse.json({
      ok: true,
      message: `Revoked ${revokedCount} other session(s)`,
      revokedCount,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
  }
}
