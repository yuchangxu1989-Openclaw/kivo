'use client';

import { useState, useCallback } from 'react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/client-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ShieldCheck, UserPlus, Trash2, Users } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

type Role = 'admin' | 'editor' | 'viewer';

interface RoleAssignment {
  identity: string;
  role: Role;
  assignedAt: number;
}

interface RolesResponse {
  roles: RoleAssignment[];
}

const ROLE_META: Record<Role, { label: string; description: string; color: string }> = {
  admin: {
    label: '管理员',
    description: '可管理用户角色、编辑和删除所有知识条目',
    color: 'bg-red-50 text-red-700 border-red-200',
  },
  editor: {
    label: '编辑者',
    description: '可创建和编辑知识条目',
    color: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  viewer: {
    label: '只读',
    description: '仅可查看知识条目，不可编辑',
    color: 'bg-slate-50 text-slate-700 border-slate-200',
  },
};

// ─── Page Component ─────────────────────────────────────────────────────────

export default function RolesPage() {
  const { data, mutate } = useApi<RolesResponse>('/api/auth/roles');
  const [newIdentity, setNewIdentity] = useState('');
  const [newRole, setNewRole] = useState<Role>('viewer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAssign = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIdentity.trim()) return;

    setError('');
    setLoading(true);
    try {
      await apiFetch('/api/auth/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: newIdentity.trim(), role: newRole }),
      });
      setNewIdentity('');
      mutate();
    } catch {
      setError('分配角色失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [newIdentity, newRole, mutate]);

  const handleRemove = useCallback(async (identity: string) => {
    try {
      await apiFetch('/api/auth/roles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity }),
      });
      mutate();
    } catch {
      setError('移除角色失败，请重试');
    }
  }, [mutate]);

  const roles = data?.roles ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">角色管理</h1>
          <p className="text-sm text-muted-foreground">
            为团队成员分配访问角色，控制知识库的读写权限。
          </p>
        </div>
      </div>

      {/* Permission overview */}
      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.entries(ROLE_META) as [Role, typeof ROLE_META[Role]][]).map(([key, meta]) => (
          <Card key={key} className="border">
            <CardContent className="p-4">
              <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${meta.color}`}>
                {meta.label}
              </span>
              <p className="mt-2 text-sm text-muted-foreground">{meta.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Assign form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4" />
            分配角色
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAssign} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="role-identity" className="text-sm font-medium text-slate-700">
                用户标识
              </label>
              <Input
                id="role-identity"
                type="text"
                placeholder="昵称或邮箱，如：张三 或 zhangsan@example.com"
                value={newIdentity}
                onChange={(e) => setNewIdentity(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="w-full space-y-1.5 sm:w-40">
              <label htmlFor="role-select" className="text-sm font-medium text-slate-700">
                角色
              </label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as Role)}>
                <SelectTrigger id="role-select" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">管理员</SelectItem>
                  <SelectItem value="editor">编辑者</SelectItem>
                  <SelectItem value="viewer">只读</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={loading || !newIdentity.trim()} className="h-10">
              {loading ? '分配中...' : '分配'}
            </Button>
          </form>
          {error && (
            <p className="mt-2 text-sm font-medium text-destructive" role="alert">{error}</p>
          )}
        </CardContent>
      </Card>

      {/* Role list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            已分配角色（{roles.length}）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {roles.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              暂无角色分配记录。使用上方表单为团队成员分配角色。
            </p>
          ) : (
            <ul className="divide-y divide-slate-100" role="list" aria-label="角色分配列表">
              {roles.map((item) => {
                const meta = ROLE_META[item.role];
                return (
                  <li key={item.identity} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm font-medium text-slate-600">
                        {item.identity.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-900">{item.identity}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.assignedAt).toLocaleDateString('zh-CN')} 分配
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(item.identity)}
                        aria-label={`移除 ${item.identity} 的角色`}
                        className="h-8 w-8 p-0 text-slate-400 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
