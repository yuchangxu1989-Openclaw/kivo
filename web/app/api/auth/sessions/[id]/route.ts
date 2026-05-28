import { NextResponse } from 'next/server';
import { getAllSessions, removeSession } from '@/lib/session-store';

const COOKIE_NAME = 'kivo_session';

function getCurrentToken(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] || null;
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const sessionId = decodeURIComponent(id);
    const currentToken = getCurrentToken(request);

    if (!sessionId) {
      return NextResponse.json({ error: 'Session id is required' }, { status: 400 });
    }

    if (currentToken === sessionId) {
      return NextResponse.json({ error: 'Cannot revoke current session' }, { status: 400 });
    }

    const exists = getAllSessions().some((session) => session.token === sessionId);
    if (!exists) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    removeSession(sessionId);
    return NextResponse.json({ ok: true, revokedId: sessionId });
  } catch {
    return NextResponse.json({ error: 'Failed to revoke session' }, { status: 500 });
  }
}
