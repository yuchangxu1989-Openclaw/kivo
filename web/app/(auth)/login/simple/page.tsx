'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

export default function SimpleLoginPage() {
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ password }),
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
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-[380px] space-y-8">
        {/* Logo */}
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 mb-2">
            KIVO
          </h1>
          <p className="text-sm text-slate-500">Agent 知识平台</p>
        </div>

        {/* Login form */}
        <div className="rounded-2xl border border-slate-200 bg-white p-7 space-y-5 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="simple-password" className="text-xs text-slate-600 mb-1 block">
                密码
              </label>
              <input
                id="simple-password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'simple-login-error' : undefined}
                className="w-full border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            {error && (
              <div id="simple-login-error" aria-live="polite" className="text-sm text-red-600">
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

        {/* Footer */}
        <p className="text-center text-xs text-slate-400">
          Powered by <span className="text-slate-500">Self-Evolving Harness</span>
        </p>
      </div>
    </div>
  );
}
