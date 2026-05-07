import { NextResponse } from 'next/server';
import { removeSession } from '@/lib/session-store';

const COOKIE_NAME = 'kivo_session';

export async function POST(request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/kivo_session=([^;]+)/);
  const token = match?.[1];
  if (token) {
    removeSession(token);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 0,
    path: '/kivo',
  });
  return response;
}
