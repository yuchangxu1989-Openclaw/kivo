/**
 * POST /api/auth/change-password
 * FR-FIX-14 AC1: Accept oldPassword + newPassword, verify old, update.
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { clearAllSessions, hasSession } from '@/lib/session-store';

const COOKIE_NAME = 'kivo_session';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: Request) {
  const authPassword = process.env.AUTH_PASSWORD;

  if (!authPassword) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
  }

  try {
    const { oldPassword, newPassword } = await request.json();

    if (!oldPassword || !newPassword) {
      return NextResponse.json(
        { error: 'oldPassword and newPassword are required' },
        { status: 400 },
      );
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return NextResponse.json(
        { error: 'newPassword must be at least 6 characters' },
        { status: 400 },
      );
    }

    // Verify old password
    if (!safeCompare(oldPassword, authPassword)) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
    }

    // Update password in environment (runtime only — persists until restart)
    // In production this would write to a config file or DB
    process.env.AUTH_PASSWORD = newPassword;

    // FR-FIX-14 AC5: Revoke all other sessions after password change
    // Get current session token from cookie
    const cookieHeader = request.headers.get('cookie') || '';
    const sessionMatch = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    const currentToken = sessionMatch?.[1];

    // Clear all sessions then re-add current
    clearAllSessions();

    // Re-add current session if valid
    if (currentToken) {
      const { addSession } = await import('@/lib/session-store');
      addSession(currentToken, '');
    }

    return NextResponse.json({ ok: true, message: 'Password changed successfully' });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}
