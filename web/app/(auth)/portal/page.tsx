'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

export default function PortalLoginPage() {
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, identity: identity.trim() }),
      });

      if (data.ok) {
        router.push('/dashboard');
        router.refresh();
        return;
      }
      setError('密码错误，请检查后重试');
    } catch {
      setError('密码错误或网络异常，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-[#0a0e1a] text-slate-300 overflow-hidden flex items-center justify-center">
      {/* Background effects */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-[30%] left-1/2 h-[60vh] w-[60vh] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(99,60,255,0.12),transparent_70%)]" />
        <div className="absolute top-[70%] -right-[10%] h-[40vh] w-[40vh] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(56,100,220,0.08),transparent_70%)]" />
      </div>

      <div className="relative z-10 w-full max-w-md px-6">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
            KIVO
          </h1>
          <p className="mt-2 text-sm text-slate-500">Knowledge Intelligence Platform</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-xl p-8">
          <h2 className="text-lg font-medium text-white mb-6">登录工作台</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="portal-identity" className="text-xs text-slate-400 mb-1.5 block">
                用户名（可选）
              </label>
              <input
                id="portal-identity"
                type="text"
                placeholder="输入用户名"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                autoComplete="username"
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20"
              />
            </div>

            <div>
              <label htmlFor="portal-password" className="text-xs text-slate-400 mb-1.5 block">
                密码
              </label>
              <input
                id="portal-password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'portal-login-error' : undefined}
                className="w-full bg-white/[0.05] border border-white/[0.1] rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20"
              />
            </div>

            {error && (
              <div id="portal-login-error" aria-live="polite" className="text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 active:scale-[0.98] text-white font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '登录中...' : '登 录'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">
          Powered by Self-Evolving Harness
        </p>
      </div>
    </div>
  );
}
