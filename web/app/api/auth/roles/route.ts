import { NextResponse } from 'next/server';
import { listRoles, assignRole, removeRole, isValidRole } from '@/lib/role-store';

export async function GET() {
  return NextResponse.json({ roles: listRoles() });
}

export async function POST(request: Request) {
  try {
    const { identity, role } = await request.json();

    if (!identity || typeof identity !== 'string' || !identity.trim()) {
      return NextResponse.json(
        { error: '请输入用户标识（昵称或邮箱）' },
        { status: 400 },
      );
    }

    if (!role || !isValidRole(role)) {
      return NextResponse.json(
        { error: '请选择有效的角色' },
        { status: 400 },
      );
    }

    const assignment = assignRole(identity.trim(), role);
    return NextResponse.json({ ok: true, assignment });
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { identity } = await request.json();

    if (!identity || typeof identity !== 'string') {
      return NextResponse.json(
        { error: '请输入要移除的用户标识' },
        { status: 400 },
      );
    }

    const removed = removeRole(identity.trim());
    if (!removed) {
      return NextResponse.json(
        { error: '未找到该用户的角色分配' },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
}
