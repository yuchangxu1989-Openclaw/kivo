'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

export default function SimpleLoginPage() {
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
    <div className="relative min-h-screen bg-[#0a0e1a] flex items-center justify-center px-4">
      <style jsx>{`
        .input-cyber:focus {
          border-color: rgba(103, 232, 249, 0.5);
          box-shadow: 0 0 12px rgba(103, 232, 249, 0.1);
        }
      `}</style>

      <div className="w-full max-w-[380px] space-y-8">
        {/* Logo */}
        <div className="text-center">
          <h1
            className="text-4xl font-bold tracking-tight text-[#f0fdfa] mb-2"
            style={{ textShadow: '0 0 20px rgba(103,232,249,0.15), 0 0 40px rgba(103,232,249,0.05)' }}
          >
            KIVO
          </h1>
          <p className="text-sm text-slate-500">Agent 知识平台</p>
        </div>

        {/* Login form */}
        <div
          className="rounded-2xl p-7 space-y-5"
          style={{
            background: 'rgba(255,255,255,0.04)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="simple-identity" className="text-xs text-slate-400 mb-1 block">
                用户名
              </label>
              <input
                id="simple-identity"
                type="text"
                placeholder="请输入用户名"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                autoComplete="username"
                className="input-cyber w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition"
              />
            </div>

            <div>
              <label htmlFor="simple-password" className="text-xs text-slate-400 mb-1 block">
                密码
              </label>
              <input
                id="simple-password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'simple-login-error' : undefined}
                className="input-cyber w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition"
              />
            </div>

            {error && (
              <div id="simple-login-error" aria-live="polite" className="text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-500 hover:to-purple-500 active:scale-[0.98] text-white font-medium text-sm transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '登录中...' : '登 录'}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-slate-600">
          Powered by <span className="text-slate-500">Self-Evolving Harness</span>
        </p>
      </div>
    </div>
  );
}
