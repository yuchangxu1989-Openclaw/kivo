'use client';

import { useState, useEffect } from 'react';
import { apiFetch, withBasePath } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

export default function PortalLoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<{ valid: boolean }>('/api/auth/verify').then((res) => {
      if (res.valid) window.location.href = withBasePath('/dashboard');
    }).catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (data.ok) {
        window.location.href = withBasePath('/dashboard');
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
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="w-full max-w-sm px-6">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            KIVO
          </h1>
          <p className="mt-2 text-sm text-slate-500">Knowledge Intelligence Platform</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-medium text-slate-900 mb-6">登录</h2>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="portal-password" className="text-xs font-medium text-slate-600 mb-1.5 block">
                密码
              </label>
              <input
                id="portal-password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'portal-login-error' : undefined}
                className="w-full border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            {error && (
              <div id="portal-login-error" aria-live="polite" className="text-sm text-red-600">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '登录中...' : '登 录'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Powered by Self-Evolving Harness
        </p>
      </div>
    </div>
  );
}
