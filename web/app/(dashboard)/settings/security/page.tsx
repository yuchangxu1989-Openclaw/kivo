'use client';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, LogOut, Monitor, Shield, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/client-api';

interface SessionItem {
  id: string;
  displayId?: string;
  identity: string;
  createdAt: string;
  isCurrent: boolean;
}

export default function SecuritySettingsPage() {
  // Password change state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Sessions state
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeSessionId, setRevokeSessionId] = useState<string | null>(null);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await apiFetch<{ data: SessionItem[] }>('/api/auth/sessions');
      setSessions(res.data ?? []);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleChangePassword = useCallback(async () => {
    setPwMessage(null);
    if (!oldPassword || !newPassword) {
      setPwMessage({ type: 'error', text: '请填写当前密码和新密码' });
      return;
    }
    if (newPassword.length < 6) {
      setPwMessage({ type: 'error', text: '新密码至少 6 个字符' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMessage({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    setPwLoading(true);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      setPwMessage({ type: 'success', text: '密码修改成功，其他会话已被强制登出' });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      loadSessions();
    } catch (err) {
      setPwMessage({ type: 'error', text: err instanceof Error ? err.message : '修改失败' });
    } finally {
      setPwLoading(false);
    }
  }, [oldPassword, newPassword, confirmPassword, loadSessions]);

  const handleRevokeAll = useCallback(async () => {
    setRevokeLoading(true);
    setRevokeMessage(null);
    try {
      const res = await apiFetch<{ revokedCount: number }>('/api/auth/sessions', {
        method: 'POST',
      });
      setRevokeMessage(`已强制登出 ${res.revokedCount} 个其他会话`);
      loadSessions();
    } catch (err) {
      setRevokeMessage(err instanceof Error ? err.message : '操作失败');
    } finally {
      setRevokeLoading(false);
    }
  }, [loadSessions]);

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    setRevokeSessionId(sessionId);
    setRevokeMessage(null);
    try {
      await apiFetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      setRevokeMessage('指定会话已踢出');
      await loadSessions();
    } catch (err) {
      setRevokeMessage(err instanceof Error ? err.message : '操作失败');
    } finally {
      setRevokeSessionId(null);
    }
  }, [loadSessions]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">安全设置</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          管理登录密码和活跃会话。修改密码后其他设备会被自动登出。
        </p>
      </div>

      {/* Password Change */}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 text-indigo-600">
            <KeyRound className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">密码管理</span>
          </div>
          <CardTitle className="text-xl">修改密码</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pwMessage && (
            <div className={`rounded-md px-3 py-2 text-sm ${
              pwMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-red-50 text-red-800'
            }`}>
              {pwMessage.text}
            </div>
          )}
          <div className="grid gap-4 sm:max-w-md">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">当前密码</label>
              <Input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="输入当前密码"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">新密码</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 6 个字符"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">确认新密码</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
              />
            </div>
            <Button onClick={handleChangePassword} disabled={pwLoading} className="w-fit gap-2">
              {pwLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              修改密码
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Session Management */}
      <Card className="border-slate-200/80 bg-white/95 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 text-indigo-600">
            <Monitor className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-[0.2em]">会话管理</span>
          </div>
          <CardTitle className="text-xl">活跃会话</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {revokeMessage && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {revokeMessage}
            </div>
          )}

          {sessionsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无活跃会话数据</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <Monitor className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="text-sm font-medium text-slate-700">
                        {session.identity || '匿名用户'}
                        {session.isCurrent && (
                          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                            当前
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        会话 {session.displayId ?? session.id} · 创建于 {new Date(session.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                  </div>
                  {!session.isCurrent && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRevokeSession(session.id)}
                      disabled={revokeSessionId === session.id}
                      className="gap-1.5"
                    >
                      {revokeSessionId === session.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      踢出
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            onClick={handleRevokeAll}
            disabled={revokeLoading || sessions.filter(s => !s.isCurrent).length === 0}
            className="gap-2"
          >
            {revokeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            强制登出所有其他会话
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
