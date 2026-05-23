'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

interface LoginResponse {
  ok: boolean;
}

const FEATURES = [
  { icon: '⟳', title: '自主进化', desc: '知识自动迭代更新，Agent 持续学习成长' },
  { icon: '🧠', title: '意图增强', desc: '深度理解用户意图，精准匹配知识上下文' },
  { icon: '🔍', title: '语义搜索', desc: '基于 BGE 向量模型的高精度语义检索' },
  { icon: '⑆', title: '知识图谱', desc: '结构化知识网络，实现关联推理与发现' },
];

export default function LoginPage() {
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
    <div className="min-h-screen bg-white flex flex-col">
      <main className="flex-1 flex flex-col lg:flex-row items-center lg:items-start gap-10 lg:gap-16 px-4 sm:px-6 md:px-12 lg:px-20 py-8 lg:py-16 max-w-7xl mx-auto w-full">
        {/* Left: Product intro */}
        <div className="hidden lg:flex flex-1 flex-col justify-center space-y-8 max-w-lg">
          <div>
            <h1 className="text-5xl font-bold tracking-tight text-slate-900 mb-3">KIVO</h1>
            <p className="text-lg text-slate-500">Agent 知识智能平台</p>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              为 AI Agent 提供持续进化的知识底座。覆盖知识提取、语义检索、意图理解、图谱关联的完整生命周期管理。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl border border-slate-200 bg-slate-50 p-4 transition-all hover:-translate-y-1 hover:shadow-md">
                <span className="text-2xl">{f.icon}</span>
                <h3 className="mt-2 text-sm font-semibold text-slate-900">{f.title}</h3>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Login form */}
        <div className="w-full max-w-[400px] lg:mt-16">
          <div className="lg:hidden text-center mb-8">
            <h1 className="text-4xl font-bold tracking-tight text-slate-900 mb-2">KIVO</h1>
            <p className="text-sm text-slate-500">Agent 知识平台</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-7 space-y-5 shadow-sm">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-slate-900">登录</h2>
              <p className="text-sm text-slate-500">输入密码访问知识管理平台</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="access-password" className="text-xs font-medium text-slate-600 mb-1 block">
                  密码
                </label>
                <input
                  id="access-password"
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete="current-password"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'login-error' : undefined}
                  className="w-full border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>

              {error && (
                <div id="login-error" aria-live="polite" className="text-sm text-red-600">
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
        </div>
      </main>

      <footer className="px-6 py-4 text-center text-xs text-slate-400 border-t border-slate-100">
        Powered by <span className="text-slate-500">Self-Evolving Harness</span>
      </footer>
    </div>
  );
}
