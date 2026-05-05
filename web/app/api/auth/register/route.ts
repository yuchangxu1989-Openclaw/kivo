export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createUser, findUserByUsername, hasUsers } from '@/lib/auth-users';
import { randomUUID } from 'crypto';
import { addSession } from '@/lib/session-store';

const COOKIE_NAME = 'kivo_session';
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();
    const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const normalizedPassword = typeof password === 'string' ? password : '';

    if (hasUsers()) {
      return NextResponse.json({ error: '管理员账户已创建，请直接登录' }, { status: 409 });
    }

    if (!normalizedUsername) {
      return NextResponse.json({ error: '请输入用户名' }, { status: 400 });
    }

    if (normalizedPassword.length < 8) {
      return NextResponse.json({ error: '密码至少需要 8 位' }, { status: 400 });
    }

    if (findUserByUsername(normalizedUsername)) {
      return NextResponse.json({ error: '用户名已存在' }, { status: 409 });
    }

    const user = createUser(normalizedUsername, normalizedPassword, 'admin');

    const response = NextResponse.json({ ok: true, user: { username: user.username, role: user.role } });
    const sessionToken = randomUUID();
    addSession(sessionToken, user.username);
    response.cookies.set(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: MAX_AGE,
      path: '/kivo',
    });

    return response;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
}
